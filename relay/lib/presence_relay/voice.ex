defmodule PresenceRelay.Voice do
  @moduledoc """
  Each room's voice channel (PROTOCOL.md, "Voice"; Arugula #331): one
  drop-in LiveKit room per room, like a Discord voice channel, beside the
  private 1:1 calls (`PresenceRelay.Calls`), which stay as they are.
  Anyone in the room may join it and leave it as they like; everyone in
  the room sees who's in it.

  The relay hands a joining connection a LiveKit token for the room
  `<app>:<room>:voice` (a call's id is 16 url-safe characters, so it
  never names a call's room), with the same grant as a call's: the
  microphone and the camera, subscribe, this room only, ten minutes.
  People join muted (the page publishes its microphone muted); presence
  says who's in voice (`voice: true`) and whether they're muted, which
  the page tells the relay (`voice_mute`).

  Voice is on wherever calls are (LiveKit's keys are set). At most
  `:voice_cap` (25) connections are in one room's voice; past that,
  `voice_join` is refused with "voice is full". (`:pg` is eventually
  consistent: two nodes admitting the last place at the same instant
  could both succeed. A soft cap, as the rooms' are.)

  **One audio session per connection, and one voice seat per person.**
  A connection joining voice leaves its call first, and one that joins a
  call leaves voice (`voice_left {reason: "call"}`). A person in voice
  from one page who joins from another leaves it on the first
  (`voice_left {reason: "elsewhere"}`): LiveKit knows a person by their
  `sub`, and would drop the first page anyway.

  Who's in a room's voice is an OTP `:pg` group, `{:voice, app, room,
  :in}`, in the rooms' scope (four elements, so `PresenceRelay.Rooms`'
  member groups never count it, and not `{:call, …}`, so it isn't counted
  as a call in progress either).

  ## Metering

  Voice minutes are call minutes. Joining, leaving, a room's voice
  starting (its first person) and stopping (its last) are told as the
  calls' own telemetry, `[:presence_relay, :call, :start | :join | :leave
  | :stop]`, with `call: "voice"` and `kind: :voice` in the metadata, so
  `PresenceRelay.Usage` sums each person's time in voice from the
  `:leave`s into the app's call seconds (and so P11's billing, which reads
  those rollups, bills them), and /metrics counts them in call seconds.
  """

  alias PresenceRelay.{Calls, Presence, Rooms}
  alias Phoenix.PubSub

  @scope :presence_relay

  @doc "Whether this relay has voice: wherever it has calls."
  def on?, do: Calls.on?()

  @doc "The most connections in one room's voice (config `:voice_cap`, 25)."
  def cap, do: Application.get_env(:presence_relay, :voice_cap, 25)

  @doc "The LiveKit room a room's voice happens in."
  def livekit_room(app, room), do: "#{app}:#{room}:voice"

  @doc """
  What a page needs to join the room's voice as `sub`: LiveKit's URL, the
  LiveKit room's name and a token (a call's grant, for the voice room).
  """
  def join_info(app, room, sub, name, now \\ System.system_time(:second)) do
    %{url: url} = c = Calls.config()
    lk_room = livekit_room(app, room)
    %{url: url, room: lk_room, token: Calls.token(c, lk_room, sub, name, now)}
  end

  @doc "How many connections are in the room's voice, across the cluster."
  def size(app, room), do: length(:pg.get_members(@scope, group(app, room)))

  @doc "`pid` (a connection) is in the room's voice until it leaves or exits."
  def join(app, room, sub, pid \\ self()) do
    g = group(app, room)
    if :pg.get_members(@scope, g) -- [pid] == [], do: event(:start, %{}, meta(app, room))
    :ok = :pg.join(@scope, g, pid)
    event(:join, %{}, Map.put(meta(app, room), :sub, sub))
  end

  @doc "`pid` left the room's voice after `ms`; its `:stop` too if nobody's left."
  def leave(app, room, sub, ms, pid \\ self()) do
    g = group(app, room)
    :pg.leave(@scope, g, pid)
    event(:leave, %{duration_ms: ms}, Map.put(meta(app, room), :sub, sub))
    if :pg.get_members(@scope, g) -- [pid] == [], do: event(:stop, %{}, meta(app, room))
    :ok
  end

  ## The room channel's side (PresenceRelayWeb.RoomChannel's voice clauses)

  @doc """
  `voice_join` from this connection: `{:ok, join_info, socket}` (in voice,
  muted; any other page of this person's in voice leaves it), or `{:error,
  reason}`. Already in: a fresh token, nothing else changes. `first`
  takes the connection out of its call (the channel's), once it's
  certain to get in.
  """
  def join_socket(%{assigns: a} = socket, first \\ & &1) do
    cond do
      not on?() ->
        {:error, "voice isn't set up here"}

      in?(socket) ->
        {:ok, join_info(a.app, a.room, a.sub, a.name), socket}

      size(a.app, a.room) >= cap() ->
        {:error, "voice is full"}

      true ->
        # This person's other pages in voice leave it.
        PubSub.broadcast_from(
          PresenceRelay.PubSub,
          self(),
          Rooms.member_topic(a.app, a.room, a.sub),
          :relay_voice_elsewhere
        )

        socket = first.(socket)
        join(a.app, a.room, a.sub)
        update(socket, &Map.merge(&1, %{voice: true, muted: true}))
        socket = Phoenix.Socket.assign(socket, :in_voice, System.monotonic_time(:millisecond))
        {:ok, join_info(a.app, a.room, a.sub, a.name), socket}
    end
  end

  @doc """
  Out of voice, if this connection is in it. `why` (a string) also pushes
  `voice_left {reason: why}`: the relay took it out (a call, another
  page). `tell` false: the connection is going, so presence needn't hear.
  """
  def leave_socket(%{assigns: a} = socket, why \\ nil, tell \\ true) do
    case Map.get(a, :in_voice) do
      nil ->
        socket

      at ->
        leave(a.app, a.room, a.sub, System.monotonic_time(:millisecond) - at)
        if tell, do: update(socket, &(&1 |> Map.put(:voice, false) |> Map.delete(:muted)))
        if why, do: Phoenix.Channel.push(socket, "voice_left", %{reason: why})
        Phoenix.Socket.assign(socket, :in_voice, nil)
    end
  end

  @doc "`voice_mute`: presence says whether this connection is muted in voice."
  def mute_socket(socket, muted) do
    if in?(socket) do
      update(socket, &Map.put(&1, :muted, muted))
      :ok
    else
      {:error, "not in voice"}
    end
  end

  @doc "Whether this connection is in its room's voice."
  def in?(%{assigns: a}), do: Map.get(a, :in_voice) != nil

  defp update(%{assigns: a}, fun),
    do: Presence.update(self(), Rooms.presence_topic(a.app, a.room), a.sub, fun)

  defp group(app, room), do: {:voice, app, room, :in}

  defp meta(app, room), do: %{app: app, room: room, call: "voice", kind: :voice}

  # The calls' telemetry, so voice minutes are metered and billed as call
  # minutes (see "Metering" above).
  defp event(kind, measurements, meta) do
    :telemetry.execute(
      [:presence_relay, :call, kind],
      Map.put(measurements, :system_time, System.system_time(:millisecond)),
      meta
    )
  end
end
