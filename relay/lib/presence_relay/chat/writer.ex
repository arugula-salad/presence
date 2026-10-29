defmodule PresenceRelay.Chat.Writer do
  @moduledoc """
  Keeps text messages in Postgres in batches, one batch at a time a node
  (`PresenceRelay.Chat.say/5`, where the relay has a database).

  A message waits while the batch before it is written, then goes with
  every other message that came meanwhile, as one `INSERT … RETURNING`.
  Next door to the database that's a batch of one each time, as before;
  far from it (a node in lhr, the database in iad: each statement a
  ~75 ms round trip or two) one insert a message at a time held a pooled
  connection per message, and a busy room's text took every connection
  the pool had (staging's two-region probe: "connection not available
  and request was dropped from queue"). Batched, a node's text costs one
  connection whatever the rate, and a message waits at most about two
  writes.

  Each caller gets its own message back with its id, in the order sent:
  Postgres returns a multi-row insert's rows in the order of its values.
  A batch that fails fails each message in it (`{:error, :not_kept}`,
  which the sender hears as "not kept").
  """
  use GenServer
  require Logger

  alias PresenceRelay.Chat.Message
  alias PresenceRelay.Repo

  # Messages in one statement, at most.
  @batch 500

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  @doc """
  Keeps one message (`%{app, room, sub, name, text}`): `{:ok, %Message{}}`
  or `{:error, :not_kept}`. Waits for its batch (up to 15 s).
  """
  def insert(row), do: GenServer.call(__MODULE__, {:insert, row}, 15_000)

  # State: the messages waiting (newest first, with who's waiting for
  # each), and the batch being written ({task ref, its callers}).
  @impl true
  def init(_), do: {:ok, %{waiting: [], writing: nil}}

  @impl true
  def handle_call({:insert, row}, from, s),
    do: {:noreply, write_next(%{s | waiting: [{from, row} | s.waiting]})}

  @impl true
  def handle_info({ref, result}, %{writing: {ref, froms}} = s) do
    Process.demonitor(ref, [:flush])

    case result do
      {:ok, messages} when length(messages) == length(froms) ->
        Enum.zip_with(froms, messages, &GenServer.reply(&1, {:ok, &2}))

      _ ->
        for f <- froms, do: GenServer.reply(f, {:error, :not_kept})
    end

    {:noreply, write_next(%{s | writing: nil})}
  end

  def handle_info({:DOWN, ref, :process, _, _}, %{writing: {ref, froms}} = s) do
    for f <- froms, do: GenServer.reply(f, {:error, :not_kept})
    {:noreply, write_next(%{s | writing: nil})}
  end

  def handle_info(_, s), do: {:noreply, s}

  # The oldest waiting messages, as the next batch, unless one's being
  # written.
  defp write_next(%{writing: nil, waiting: [_ | _]} = s) do
    {batch, rest} = s.waiting |> Enum.reverse() |> Enum.split(@batch)
    {froms, rows} = Enum.unzip(batch)
    task = Task.Supervisor.async_nolink(PresenceRelay.Tasks, fn -> write(rows) end)
    %{s | writing: {task.ref, froms}, waiting: Enum.reverse(rest)}
  end

  defp write_next(s), do: s

  defp write(rows) do
    at = DateTime.utc_now()
    rows = Enum.map(rows, &Map.put(&1, :inserted_at, at))

    {_, messages} =
      Repo.insert_all(Message, rows,
        returning: [:id, :app, :room, :sub, :name, :text, :inserted_at]
      )

    {:ok, messages}
  rescue
    # Postgres slow or away (the pool's queue gave up): not kept, and
    # each sender hears so; the rooms stay up.
    e in [DBConnection.ConnectionError, Postgrex.Error] ->
      Logger.warning("chat: #{length(rows)} message(s) weren't kept: #{Exception.message(e)}")
      {:error, :not_kept}
  catch
    :exit, _ -> {:error, :not_kept}
  end
end
