defmodule PresenceRelay.Load do
  @moduledoc """
  How far behind this node's schedulers are, and how much to stretch the
  frame rate for it (PROTOCOL.md's "Limits": a relay short of CPU sends
  fewer frames a second rather than late ones).

  Frames are nearly all of the relay's work, and each one in costs a send
  to every other member of its room. When a node can't keep up (a Fly
  `shared-cpu` machine past its burst balance gets 5 ms of CPU in each
  80 ms), frames queue in every socket's mailbox: fan-out goes from
  milliseconds to seconds, joins time out behind them, and memory grows.
  A frame that late is worth nothing (the next one replaces it), so this
  node lets fewer in instead.

  This process wakes every `:load_tick_ms` (50 ms) and measures how late
  it woke: a process waiting its turn behind the queue, or a machine held
  back by its CPU quota, wakes late. It keeps a moving average of that
  (a quarter of each new tick), so one late tick (a GC, a deploy) moves
  little. While the average is over `:load_late_ms` (20 ms), the stretch
  grows by a tenth a tick (1× to 8× in about a second); once it's under
  half that, it shrinks by 2% a tick (8× back to 1× in about five
  seconds: a queue takes a while to drain, and shrinking as fast as it
  grew swung between the two). `PresenceRelay.Rooms.frame/5` holds each
  member to one frame per 70 ms × the stretch, so a node at its limit
  settles near the rate it can carry. The stretch is an `:atomics`
  counter (in hundredths), read without a message on every frame.
  """
  use GenServer

  @max 800

  def start_link(_), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  @doc "The frame gap's stretch, in hundredths: 100 is none."
  def stretch do
    case :persistent_term.get(__MODULE__, nil) do
      nil -> 100
      ref -> :atomics.get(ref, 1)
    end
  end

  @doc false
  # Tests: set the stretch (100: none).
  def put_stretch(n), do: :atomics.put(:persistent_term.get(__MODULE__), 1, n)

  @impl true
  def init(_) do
    ref =
      case :persistent_term.get(__MODULE__, nil) do
        nil ->
          ref = :atomics.new(1, signed: false)
          :persistent_term.put(__MODULE__, ref)
          ref

        ref ->
          ref
      end

    :atomics.put(ref, 1, 100)
    {:ok, schedule(ref, 0.0)}
  end

  # State: {stretch's ref, when the tick is due, average lateness in ms}.
  @impl true
  def handle_info(:tick, {ref, due, avg}) do
    late = max(0, System.monotonic_time(:millisecond) - due)
    avg = avg + (late - avg) / 4
    now = :atomics.get(ref, 1)
    limit = late_ms()

    next =
      cond do
        avg > limit -> min(@max, div(now * 11, 10) + 1)
        avg < limit / 2 and now > 100 -> max(100, div(now * 49, 50))
        true -> now
      end

    if next != now, do: :atomics.put(ref, 1, next)
    {:noreply, schedule(ref, avg)}
  end

  defp schedule(ref, avg) do
    case tick_ms() do
      ms when is_integer(ms) ->
        Process.send_after(self(), :tick, ms)
        {ref, System.monotonic_time(:millisecond) + ms, avg}

      # `:manual` (tests): the stretch stays where put_stretch/1 puts it.
      _ ->
        {ref, nil, avg}
    end
  end

  defp tick_ms, do: Application.get_env(:presence_relay, :load_tick_ms, 50)
  defp late_ms, do: Application.get_env(:presence_relay, :load_late_ms, 20)
end
