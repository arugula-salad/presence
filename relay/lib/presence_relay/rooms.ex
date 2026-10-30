defmodule PresenceRelay.Rooms do
  @moduledoc """
  The rooms' bookkeeping (PROTOCOL.md, "Limits" and the `off` event):
  each member's connections, admitted under the room's caps and watched
  until they go; each member's newest frame, kept in memory (ETS) for a
  joiner and nothing else; and the sweeps that say `off` for a camera whose
  frames stopped.

  `off` goes to the room when a member's camera goes off (`camera_off/4`),
  when their newest frame goes stale, and when their last connection
  leaves.

  ## One person, several pages (Arugula #345)

  A member is a `sub`: the same person on several pages (each its own
  socket and token) is one member, with a connection each. Their frames
  come from one page at a time, the one sending: a frame from another of
  their pages is dropped while the sender's newest is younger than
  `:sender_hold_ms` (2 s), so nobody sees two cameras interleaved, and
  once the sender stops (a hidden tab) the next page to send takes over.
  A page whose camera goes off, or that leaves, hands over at once
  (`page_off/5`), and the room hears `off` only if none of the member's
  other pages has a camera on (presence says). The sender is held per
  node (each keeps the frames sent through it): two pages on two nodes
  could both get frames through, as softly as the caps.

  Internal topics carry the app, so two apps' rooms of one name never meet: `r:<app>:<room>` (frames and `off`), `m:<app>:<room>:<sub>`
  (waves and answers for one member), `p:<app>:<room>` (presence).

  ## In a cluster (#318's P2)

  Members of one room may be connected to different nodes. PubSub and
  Presence already span the cluster, so frames, waves, answers, reactions
  and presence reach everyone wherever they're connected. What this module
  keeps is made cluster-wide like so:

  - **Connections** are an OTP `:pg` group per member, `{app, room, sub}`,
    in the `:presence_relay` scope: every node sees every connection, so
    the caps (64 members a room, 8 connections a member) count the whole
    cluster, and a member's camera is off only when their last connection
    anywhere is gone. (`:pg` is eventually consistent: two nodes admitting
    the 65th member at the same instant could both succeed. A soft cap.)
  - **An app's connections** (#318's P12) are a `:pg` group too,
    `{:app, app}` (two elements, so it never counts as a member), capped
    at config `:max_app_connections` (2,000), or the app's own number in
    `:app_connections`, across the cluster, as softly.
  - **Newest frames** stay in the ETS table of the node the member sent
    them through, and that node alone sweeps them, so a stale frame says
    `off` once. A joiner asks every node for its fresh frames (`fresh/2`);
    forgetting a frame (`camera_off`) forgets it on every node.
  - **Rate limits** stay where they are: per member, on the node their
    frames come through.

  ## The frame rate

  A member's frames are held to one per 70 ms on average, as a token
  bucket of 3 (`:frame_burst`) refilling one per 70 ms (`:frame_gap_ms`):
  kept as the member's "theoretical arrival time" (GCRA), one integer
  beside their newest frame. The network doesn't deliver a client's
  frames as evenly as it sent them (TCP, TLS and a proxy bunch them: two
  frames sent 83 ms apart can arrive 10 ms apart), so a strict floor
  dropped real frames that were never too fast; the bucket lets a short
  bunch through and still holds the rate.

  While this node is short of CPU, the gap is stretched
  (`PresenceRelay.Load`): fewer frames in, rather than every frame late.
  A frame dropped then is counted `shed`, not `too_soon`.

  ## Fan-out

  A frame goes to the room's internal topic with `PresenceRelay.Fanout`
  as the dispatcher: each room channel subscribed with its socket's
  transport (`fanout_meta/1`), so the frame is encoded once (per join ref)
  and sent straight to each socket, without a stop in each channel's
  process. Everything else on the topic (`off`, reactions, text) still
  goes through the channel.
  """
  use GenServer

  alias Phoenix.PubSub

  @table :presence_relay_frames
  @scope :presence_relay
  @doc "The `:pg` scope connections are grouped in (started by the application)."
  def scope, do: @scope
  @max_frame 32 * 1024

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  def room_topic(app, room), do: "r:#{app}:#{room}"
  def member_topic(app, room, sub), do: "m:#{app}:#{room}:#{sub}"
  def presence_topic(app, room), do: "p:#{app}:#{room}"

  @doc """
  Admits `pid` as one of `sub`'s connections to the room, or refuses it:
  a room holds 64 members, a member 8 connections, an app 2,000
  connections (`max_app_connections/1`). The connection counts until its
  process exits.
  """
  def join(app, room, sub, pid), do: GenServer.call(__MODULE__, {:join, {app, room}, sub, pid})

  @doc """
  Keeps `frame` as `sub`'s newest and passes it to the rest of the room,
  prefixed with who sent it; `:drop` for one too big, over the member's
  rate (a burst of 3, then one per 70 ms: "The frame rate"), or from one
  of their pages while another is sending ("One person, several pages").
  """
  def frame(app, room, sub, frame, from \\ self())

  def frame(_app, _room, _sub, frame, _from) when byte_size(frame) > @max_frame or frame == "" do
    framed(:too_big, frame)
    :drop
  end

  def frame(app, room, sub, frame, from) do
    now = System.monotonic_time(:millisecond)
    key = {app, room, sub}
    # Stretched while this node is short of CPU (PresenceRelay.Load).
    stretch = PresenceRelay.Load.stretch()
    gap = div(gap_ms() * stretch, 100)

    # The member's theoretical arrival time: when their next frame would
    # be due if every one so far had come exactly a gap apart. A frame
    # may come early by up to the burst's worth of gaps. And whether
    # another of the member's pages is sending: it holds their frames
    # while its newest is fresh (one sender at a time).
    {tat, held} =
      case :ets.lookup(@table, key) do
        [{^key, at, _, tat, sender}] -> {max(tat, now), held?(sender, from, now - at)}
        _ -> {now, false}
      end

    cond do
      held ->
        framed(:other_page, frame)
        :drop

      tat - now > (burst() - 1) * gap ->
        # Over the rate, or over the rate this node can carry just now.
        framed(if(stretch > 100, do: :shed, else: :too_soon), frame)
        :drop

      true ->
        accept(key, app, room, sub, frame, now, tat + gap, from)
    end
  end

  defp held?(sender, from, _age) when sender == from, do: false

  defp held?(sender, _from, age),
    do: age < sender_hold_ms() and node(sender) == node() and Process.alive?(sender)

  defp accept(key, app, room, sub, frame, now, tat, from) do
    :ets.insert(@table, {key, now, frame, tat, from})
    framed(:relayed, frame)

    PubSub.broadcast_from(
      PresenceRelay.PubSub,
      from,
      room_topic(app, room),
      {:relay_frame, prefixed(sub, frame)},
      PresenceRelay.Fanout
    )

    :ok
  end

  @doc """
  The metadata a room channel subscribes to the room's topic with, so
  `PresenceRelay.Fanout` can send frames straight to its socket.
  """
  def fanout_meta(%Phoenix.Socket{} = s),
    do: {:fanout, s.transport_pid, s.serializer, s.join_ref, s.topic}

  @doc """
  Every member's newest frame younger than the stale age, prefixed, from
  every node in the cluster (each keeps the frames sent through it).
  """
  def fresh(app, room) do
    others =
      Node.list()
      |> :erpc.multicall(__MODULE__, :local_fresh, [app, room], 1_000)
      |> Enum.flat_map(fn
        {:ok, frames} -> frames
        _ -> []
      end)

    local_fresh(app, room) ++ others
  end

  @doc false
  # This node's fresh frames for the room (fresh/2 asks every node).
  def local_fresh(app, room) do
    cutoff = System.monotonic_time(:millisecond) - stale_ms()

    for {{_, _, sub}, at, frame, _, _} <-
          :ets.match_object(@table, {{app, room, :_}, :_, :_, :_, :_}),
        at >= cutoff,
        do: prefixed(sub, frame)
  end

  @doc "`sub`'s camera went off: forget their frame (on every node) and tell the room (but `from`)."
  def camera_off(app, room, sub, from \\ self()) do
    key = {app, room, sub}
    :ets.delete(@table, key)
    :erpc.multicast(Node.list(), __MODULE__, :forget, [key])
    PubSub.broadcast_from(PresenceRelay.PubSub, from, room_topic(app, room), {:relay_off, sub})
  end

  @doc """
  One of `sub`'s pages (`pid`) turned its camera off, or is leaving: if
  another of their pages has a camera on, it only stops holding their
  frames (the next page to send takes over at once, and nobody hears
  `off`); otherwise their camera's off (`camera_off/4`).
  """
  def page_off(app, room, sub, pid, from \\ self()) do
    if camera_elsewhere?(app, room, sub, pid) do
      key = {app, room, sub}
      :ets.select_delete(@table, [{{key, :_, :_, :_, pid}, [], [true]}])
      :ok
    else
      camera_off(app, room, sub, from)
    end
  end

  @doc "Whether one of `sub`'s connections other than `pid` has its camera on (presence says)."
  def camera_elsewhere?(app, room, sub, pid) do
    PresenceRelay.Presence
    |> Phoenix.Tracker.get_by_key(presence_topic(app, room), sub)
    |> Enum.any?(fn {p, meta} -> p != pid and Map.get(meta, :mode, "none") != "none" end)
  end

  @doc false
  # Another node's camera_off: drop this node's copy of the member's frame
  # (none on a node that's stopping, whose table is gone).
  def forget(key) do
    if :ets.whereis(@table) != :undefined, do: :ets.delete(@table, key)
    :ok
  end

  @doc "How many members the room has, and `sub`'s connections, across the cluster."
  def count(app, room, sub) do
    members =
      @scope
      |> :pg.which_groups()
      |> Enum.count(&match?({^app, ^room, _}, &1))

    {members, length(:pg.get_members(@scope, {app, room, sub}))}
  end

  @doc """
  The app's most connections at once, across the cluster: its own number
  in config `:app_connections` (app id => n, or nil for none), else
  `:max_app_connections`.
  """
  def max_app_connections(app) do
    Map.get(
      Application.get_env(:presence_relay, :app_connections, %{}),
      app,
      Application.get_env(:presence_relay, :max_app_connections, 2_000)
    )
  end

  @doc "How many connections the app has, across the cluster."
  def app_connections(app), do: length(:pg.get_members(@scope, {:app, app}))

  @doc """
  For /metrics (PresenceRelay.Metrics): this node's connections, and the
  cluster's rooms, members, calls and people in calls (every node sees
  the same, so a dashboard takes the max of these, and sums `connections`).
  """
  def stats do
    local =
      for {_, _, _} = g <- :pg.which_local_groups(@scope), reduce: 0 do
        n -> n + length(:pg.get_local_members(@scope, g))
      end

    {rooms, members, calls, in_calls} =
      @scope
      |> :pg.which_groups()
      |> Enum.reduce({MapSet.new(), 0, 0, 0}, fn
        {app, room, _}, {rooms, m, c, p} ->
          {MapSet.put(rooms, {app, room}), m + 1, c, p}

        {:call, _, _, _} = g, {rooms, m, c, p} ->
          {rooms, m, c + 1, p + length(:pg.get_members(@scope, g))}

        _, acc ->
          acc
      end)

    %{
      connections: local,
      rooms: MapSet.size(rooms),
      members: members,
      calls: calls,
      in_calls: in_calls
    }
  end

  @doc "Whether `sub` has a connection in the room, anywhere in the cluster."
  def here?(app, room, sub), do: :pg.get_members(@scope, {app, room, sub}) != []

  defp sender?(key, pid), do: match?([{_, _, _, _, ^pid}], :ets.lookup(@table, key))

  defp prefixed(sub, frame), do: <<byte_size(sub)::8, sub::binary, frame::binary>>

  # Every frame in, for /metrics: relayed, or dropped and why.
  defp framed(result, frame),
    do:
      :telemetry.execute(
        [:presence_relay, :frame],
        %{count: 1, bytes: byte_size(frame)},
        %{result: result}
      )

  defp gap_ms, do: Application.get_env(:presence_relay, :frame_gap_ms, 70)
  defp burst, do: Application.get_env(:presence_relay, :frame_burst, 3)
  defp stale_ms, do: Application.get_env(:presence_relay, :stale_ms, 10_000)
  defp sweep_ms, do: Application.get_env(:presence_relay, :sweep_ms, 2_000)
  defp sender_hold_ms, do: Application.get_env(:presence_relay, :sender_hold_ms, 2_000)
  defp max_members, do: Application.get_env(:presence_relay, :max_members, 64)
  defp max_conns, do: Application.get_env(:presence_relay, :max_conns, 8)

  @impl true
  def init(_) do
    :ets.new(@table, [
      :named_table,
      :public,
      :set,
      read_concurrency: true,
      write_concurrency: true
    ])

    Process.send_after(self(), :sweep, sweep_ms())
    # refs: monitor => {app, room, sub, pid}, for this node's connections.
    {:ok, %{refs: %{}}}
  end

  @impl true
  def handle_call({:join, {app, r}, sub, pid}, _from, s) do
    {members, n} = count(app, r, sub)

    cond do
      n == 0 and members >= max_members() ->
        {:reply, {:error, "room full"}, s}

      n >= max_conns() ->
        {:reply, {:error, "too many connections"}, s}

      over_app?(app) ->
        {:reply, {:error, "this app has too many connections"}, s}

      true ->
        :ok = :pg.join(@scope, {app, r, sub}, pid)
        :ok = :pg.join(@scope, {:app, app}, pid)
        ref = Process.monitor(pid)
        {:reply, :ok, %{s | refs: Map.put(s.refs, ref, {app, r, sub, pid})}}
    end
  end

  defp over_app?(app) do
    case max_app_connections(app) do
      max when is_integer(max) -> app_connections(app) >= max
      _ -> false
    end
  end

  @impl true
  def handle_info({:DOWN, ref, :process, _pid, _}, s) do
    case Map.pop(s.refs, ref) do
      {nil, _} ->
        {:noreply, s}

      {{app, r, sub, pid}, refs} ->
        # :pg drops a dead process by itself, but maybe not yet: leave
        # it out here. Their last connection anywhere: camera off. The
        # page that was sending their frames: the next takes over, or
        # their camera's off now (not when the frame goes stale).
        cond do
          :pg.get_members(@scope, {app, r, sub}) -- [pid] == [] ->
            camera_off(app, r, sub, self())

          sender?({app, r, sub}, pid) ->
            page_off(app, r, sub, pid, self())

          true ->
            :ok
        end

        {:noreply, %{s | refs: refs}}
    end
  end

  def handle_info(:sweep, s) do
    cutoff = System.monotonic_time(:millisecond) - stale_ms()
    stale = :ets.select(@table, [{{:"$1", :"$2", :_, :_, :_}, [{:<, :"$2", cutoff}], [:"$1"]}])
    for {app, r, sub} <- stale, do: camera_off(app, r, sub, self())
    Process.send_after(self(), :sweep, sweep_ms())
    {:noreply, s}
  end
end
