defmodule PresenceRelay.DataCase do
  @moduledoc "Tests that touch Postgres: each in a sandboxed transaction."
  use ExUnit.CaseTemplate

  using do
    quote do
      alias PresenceRelay.Repo
      import Ecto.Query
      import PresenceRelay.DataCase
    end
  end

  setup tags do
    pid = Ecto.Adapters.SQL.Sandbox.start_owner!(PresenceRelay.Repo, shared: not tags[:async])

    on_exit(fn ->
      settle()
      Ecto.Adapters.SQL.Sandbox.stop_owner(pid)
    end)

    :ok
  end

  @doc """
  Waits for rooms' database tasks (`PresenceRelay.Tasks`: a joiner's
  history, text) to finish before the sandbox goes, up to a second: a
  moment first (a channel that joined as the test ended starts its
  history task just after), then until none is left. A query cut off by
  its owner's exit only makes noise.
  """
  def settle(deadline \\ System.monotonic_time(:millisecond) + 1_000) do
    Process.sleep(20)

    if Task.Supervisor.children(PresenceRelay.Tasks) != [] and
         System.monotonic_time(:millisecond) < deadline,
       do: settle(deadline)
  end
end
