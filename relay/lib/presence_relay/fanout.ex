defmodule PresenceRelay.Fanout do
  @moduledoc """
  The PubSub dispatcher frames go out with (`PresenceRelay.Rooms.frame/5`):
  Phoenix's own fastlane, for our internal room topics.

  A room channel subscribes to its room's topic with its socket's
  transport, serializer, join ref and topic (`Rooms.fanout_meta/1`). A
  frame is then encoded as the socket's push once per serializer and join
  ref (nearly always one encoding for the whole room) and sent straight to
  each socket's transport process, as Phoenix's `push/3` would have sent
  it from the channel. Skipping the channel's process halves the messages
  a frame costs, which is most of the relay's work (#318's P12 load
  probe: 7 sends for every frame in, in a room of 8).

  Anything else on the topic, and any subscriber without that metadata,
  gets the message itself, as Phoenix's default dispatcher sends it. Each
  node dispatches to its own subscribers, so a frame from another node is
  encoded there once too.
  """

  alias Phoenix.Socket.Message

  @doc false
  def dispatch(entries, from, {:relay_frame, frame} = msg) do
    Enum.reduce(entries, %{}, fn
      {pid, _}, cache when pid == from ->
        cache

      {_pid, {:fanout, transport, serializer, join_ref, topic}}, cache ->
        key = {serializer, join_ref, topic}

        case cache do
          %{^key => encoded} ->
            send(transport, encoded)
            cache

          %{} ->
            encoded =
              serializer.encode!(%Message{
                join_ref: join_ref,
                topic: topic,
                event: "frame",
                payload: {:binary, frame}
              })

            send(transport, encoded)
            Map.put(cache, key, encoded)
        end

      {pid, _}, cache ->
        send(pid, msg)
        cache
    end)

    :ok
  end

  def dispatch(entries, from, msg) do
    for {pid, _} <- entries, pid != from, do: send(pid, msg)
    :ok
  end
end
