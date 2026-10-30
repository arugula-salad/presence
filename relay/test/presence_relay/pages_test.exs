defmodule PresenceRelay.PagesTest do
  use PresenceRelay.RelayCase, async: false

  # One person on several pages (PROTOCOL.md, "One person, several
  # pages"; Arugula #345): the same sub on two sockets, each with its own
  # token, is one member of the room. Frames come from the page that's
  # sending, `off` only when no page has a camera on, leaving one page
  # keeps the member, and a call rings every page and the one that
  # answers takes it.

  @rig <<0, 0x40, 1, 2, 3>>

  defp frame(n), do: <<0, 0x40, n>>

  # A member's metas, one a connection, as presence has them.
  defp metas(r, sub) do
    case PresenceRelay.Presence.get_by_key(PresenceRelay.Rooms.presence_topic("acme", r), sub) do
      %{metas: metas} -> metas
      [] -> []
    end
  end

  # Test config holds a member's frames to the sending page for this long
  # after its last one (config :sender_hold_ms; 2 s in production).
  setup do
    Application.put_env(:presence_relay, :sender_hold_ms, 200)
    on_exit(fn -> Application.delete_env(:presence_relay, :sender_hold_ms) end)
  end

  test "two pages are one member: one presence key with a meta each, counted once" do
    r = room()
    Application.put_env(:presence_relay, :max_members, 2)

    try do
      {:ok, _a1, %{you: "alice"}} = client(:a1, r, "alice", %{"name" => "Alice"})
      {:ok, _a2, %{you: "alice"}} = client(:a2, r, "alice", %{"name" => "Alice"})
      {:ok, _b, _} = client(:b, r, "bob")
      assert_receive {:pushed, :b, "presence_state", %{"alice" => %{metas: metas}} = state}
      assert length(metas) == 2
      assert Map.keys(state) |> Enum.sort() == ["alice", "bob"]
      # Alice's two pages count as one of the room's two members.
      assert {:error, %{reason: "room full"}} = client(:c, r, "carol")
    after
      Application.delete_env(:presence_relay, :max_members)
    end
  end

  test "frames come from the page that's sending; another takes over once it stops" do
    r = room()
    {:ok, a1, _} = client(:a1, r, "alice")
    {:ok, a2, _} = client(:a2, r, "alice")
    {:ok, _b, _} = client(:b, r, "bob")

    send_as(a1, "frame", {:binary, frame(1)})
    expected = framed("alice", frame(1))
    assert_receive {:pushed, :b, "frame", ^expected}
    # Alice's other page sees her too (it's another connection).
    assert_receive {:pushed, :a2, "frame", ^expected}
    refute_receive {:pushed, :a1, "frame", _}, 20

    # The second page's frames while the first is sending: dropped, so
    # nobody sees two cameras' frames interleaved.
    Process.sleep(80)
    send_as(a2, "frame", {:binary, frame(2)})
    refute_receive {:pushed, :b, "frame", {:binary, <<5, "alice", 0, 0x40, 2>>}}, 100

    # The first page stops sending (a hidden tab): after the hold, the
    # second page's frames go.
    Process.sleep(200)
    send_as(a2, "frame", {:binary, frame(3)})
    expected = framed("alice", frame(3))
    assert_receive {:pushed, :b, "frame", ^expected}
    # And now the first is the one held off.
    Process.sleep(80)
    send_as(a1, "frame", {:binary, frame(4)})
    refute_receive {:pushed, :b, "frame", {:binary, <<5, "alice", 0, 0x40, 4>>}}, 100
  end

  test "a page turning its camera off hands over at once, and says off only when no page has one on" do
    r = room()
    {:ok, a1, _} = client(:a1, r, "alice")
    {:ok, a2, _} = client(:a2, r, "alice")
    {:ok, _b, _} = client(:b, r, "bob")
    send_as(a1, "state", %{"mode" => "avatar"})
    send_as(a2, "state", %{"mode" => "avatar"})
    send_as(a1, "frame", {:binary, @rig})
    assert_receive {:pushed, :b, "frame", _}

    # The sending page's camera goes off; the other's is on: no off, and
    # its next frame goes straight away (no hold).
    send_as(a1, "state", %{"mode" => "none"})
    refute_receive {:pushed, :b, "off", %{sub: "alice"}}, 100
    send_as(a2, "frame", {:binary, frame(9)})
    expected = framed("alice", frame(9))
    assert_receive {:pushed, :b, "frame", ^expected}

    # The last camera goes off: now it's off.
    send_as(a2, "state", %{"mode" => "none"})
    assert_receive {:pushed, :b, "off", %{sub: "alice"}}
  end

  test "away only when every page is away: the relay keeps each page's say" do
    r = room()
    {:ok, a1, _} = client(:a1, r, "alice")
    {:ok, _a2, _} = client(:a2, r, "alice")
    {:ok, _b, _} = client(:b, r, "bob")
    assert_receive {:pushed, :b, "presence_state", _}
    send_as(a1, "state", %{"away" => true})

    assert_receive {:pushed, :b, "presence_diff",
                    %{joins: %{"alice" => %{metas: [%{away: true}]}}}}

    # Phoenix sends the changed meta; the member's metas are one away and
    # one not (a client's memberOf makes that "not away").
    metas = metas(r, "alice")
    assert metas |> Enum.map(& &1.away) |> Enum.sort() == [false, true]
  end

  test "leaving one page keeps the member; the page that was sending hands over" do
    r = room()
    {:ok, a1, _} = client(:a1, r, "alice")
    {:ok, a2, _} = client(:a2, r, "alice")
    {:ok, _b, _} = client(:b, r, "bob")
    send_as(a1, "state", %{"mode" => "avatar"})
    send_as(a2, "state", %{"mode" => "avatar"})
    send_as(a1, "frame", {:binary, @rig})
    assert_receive {:pushed, :b, "frame", _}

    leave(a1, :a1)
    refute_receive {:pushed, :b, "off", %{sub: "alice"}}, 100
    assert PresenceRelay.Rooms.here?("acme", r, "alice")
    assert [_] = metas(r, "alice")
    # The page left is no longer holding Alice's frames: the other's go now.
    send_as(a2, "frame", {:binary, frame(7)})
    expected = framed("alice", frame(7))
    assert_receive {:pushed, :b, "frame", ^expected}
  end

  test "the sending page leaving, with no other camera on, says off at once (not after the stale sweep)" do
    r = room()
    {:ok, a1, _} = client(:a1, r, "alice")
    {:ok, _a2, _} = client(:a2, r, "alice")
    {:ok, _b, _} = client(:b, r, "bob")
    send_as(a1, "state", %{"mode" => "avatar"})
    send_as(a1, "frame", {:binary, @rig})
    assert_receive {:pushed, :b, "frame", _}
    leave(a1, :a1)
    # Well inside the stale age (300 ms in test config).
    assert_receive {:pushed, :b, "off", %{sub: "alice"}}, 150
  end

  test "a call rings every page; the one that answers takes it, the others stop ringing" do
    r = room()
    {:ok, a, _} = client(:a, r, "alice")
    {:ok, b1, _} = client(:b1, r, "bob")
    {:ok, b2, _} = client(:b2, r, "bob")
    send_as(a, "call", %{"to" => "bob"})
    assert_receive {:replied, :a, :ok, %{id: id}}
    assert_receive {:pushed, :b1, "call", %{from: "alice", id: ^id}}
    assert_receive {:pushed, :b2, "call", %{from: "alice", id: ^id}}

    # Bob's first page answers.
    send_as(b1, "call_answer", %{"id" => id, "yes" => true})
    assert_receive {:pushed, :b2, "call_cancel", %{id: ^id}}
    assert_receive {:pushed, :b1, "call_join", %{id: ^id}}
    assert_receive {:pushed, :a, "call_join", %{id: ^id}}
    refute_receive {:pushed, :b2, "call_join", _}, 100

    # Presence: the answering page's meta is in the call; Bob (one member)
    # shows in it, and ringing him again says he's already there.
    metas = metas(r, "bob")
    assert metas |> Enum.map(& &1.call) |> Enum.sort() == [nil, id]
    send_as(a, "call", %{"to" => "bob"})
    assert_receive {:replied, :a, :error, %{reason: "already in the call"}}

    # Bob's other page leaving doesn't take him out of the call, or the room.
    leave(b2, :b2)
    assert PresenceRelay.Calls.size("acme", r, id) == 2
    assert PresenceRelay.Rooms.here?("acme", r, "bob")
  end
end
