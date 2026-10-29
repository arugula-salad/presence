defmodule PresenceRelay.LoadTest do
  use PresenceRelay.RelayCase, async: false

  alias PresenceRelay.Load

  setup do
    on_exit(fn -> Load.put_stretch(100) end)
  end

  test "a node that keeps waking late stretches the frame gap, and eases back once it's caught up" do
    assert Load.stretch() == 100

    # A tick that came `ms` late, on an average of `avg` so far.
    tick = fn ms, avg ->
      :sys.replace_state(Load, fn {ref, _, _} ->
        {ref, System.monotonic_time(:millisecond) - ms, avg}
      end)

      send(Load, :tick)
      :sys.get_state(Load)
      Load.stretch()
    end

    # One late tick on a quiet node moves the average, not the stretch.
    assert tick.(60, 0.0) == 100
    # Late on average: a tenth more a tick.
    assert tick.(60, 30.0) == 111
    assert tick.(60, 30.0) == 123
    # Between half the limit and the limit: holds.
    assert tick.(15, 15.0) == 123
    # Caught up: 2% less a tick, down to none.
    assert tick.(0, 0.0) == 120
    for _ <- 1..20, do: tick.(0, 0.0)
    assert Load.stretch() == 100
  end

  test "while stretched, a member's frames are held to the stretched rate and counted shed" do
    r = room()
    {:ok, a, _} = client(:a, r, "alice")
    {:ok, _b, _} = client(:b, r, "bob")
    Load.put_stretch(300)
    # The burst still goes; then one per 210 ms, not 70.
    for n <- 1..3, do: send_as(a, "frame", {:binary, <<n>>})
    for n <- 1..3, do: assert_receive({:pushed, :b, "frame", {:binary, <<5, "alice", ^n>>}})
    Process.sleep(100)
    send_as(a, "frame", {:binary, <<4>>})
    refute_receive {:pushed, :b, "frame", _}, 50
    Process.sleep(150)
    send_as(a, "frame", {:binary, <<5>>})
    assert_receive {:pushed, :b, "frame", {:binary, <<5, "alice", 5>>}}

    assert PresenceRelay.Metrics.render() |> IO.iodata_to_binary() =~
             ~s(presence_frames_total{result="shed"})
  end
end
