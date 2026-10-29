defmodule PresenceRelay.ChatTest do
  use PresenceRelay.RelayCase, async: false

  alias PresenceRelay.Chat

  describe "check/1" do
    test "trims, and refuses empty, too long and control characters (a newline is fine)" do
      assert Chat.check("  hi  ") == {:ok, "hi"}
      assert Chat.check("line one\nline two") == {:ok, "line one\nline two"}
      assert Chat.check("   ") == {:error, :empty}
      assert Chat.check(String.duplicate("é", 2001)) == {:error, :too_long}
      assert {:ok, _} = Chat.check(String.duplicate("é", 2000))
      assert Chat.check("bell\a") == {:error, :control}
      assert Chat.check("tab\there") == {:error, :control}
      assert Chat.check(7) == {:error, :empty}
    end
  end

  for store <- [:postgres, :memory] do
    describe "kept in #{store}" do
      setup do
        prev = Application.get_env(:presence_relay, :database)
        Application.put_env(:presence_relay, :database, unquote(store) == :postgres)
        on_exit(fn -> Application.put_env(:presence_relay, :database, prev) end)
        :ok
      end

      test "messages come back oldest first, per app and room, with ids that go up" do
        r = room()
        {:ok, a} = Chat.say("acme", r, "alice", "Alice", "one")
        {:ok, b} = Chat.say("acme", r, "bob", "Bob", "two")
        {:ok, _} = Chat.say("other", r, "zed", "Zed", "elsewhere")
        assert b.id > a.id

        assert [%{text: "one", sub: "alice", name: "Alice"}, %{text: "two"}] =
                 Chat.history("acme", r)

        assert is_integer(a.at)
      end

      test "history is the last page, and before: pages back" do
        r = room()
        msgs = for i <- 1..55, do: elem(Chat.say("acme", r, "a", "A", "m#{i}"), 1)
        last = Chat.history("acme", r)
        assert length(last) == 50
        assert hd(last).text == "m6" and List.last(last).text == "m55"
        earlier = Chat.history("acme", r, hd(last).id)

        # Postgres keeps everything; memory keeps a room's last 50.
        if unquote(store) == :postgres,
          do: assert(Enum.map(earlier, & &1.text) == ["m1", "m2", "m3", "m4", "m5"]),
          else: assert(earlier == [])

        assert Chat.history("acme", r, hd(msgs).id) == []
      end
    end
  end

  describe "in a room" do
    test "say reaches everyone else as said, and the sender as a reply with the id" do
      r = room()
      {:ok, a, _} = client(:a, r, "alice", %{"name" => "Alice"})
      {:ok, _b, _} = client(:b, r, "bob")
      send_as(a, "say", %{"text" => " hello room "})

      assert_receive {:replied, :a, :ok,
                      %{id: id, text: "hello room", sub: "alice", name: "Alice"}}

      assert_receive {:pushed, :b, "said", %{id: ^id, text: "hello room"}}
      refute_receive {:pushed, :a, "said", _}, 100
    end

    test "a joiner gets the history, and history before: an id pages back" do
      r = room()
      {:ok, a, _} = client(:a, r, "alice")
      for t <- ~w(first second), do: send_as(a, "say", %{"text" => t})
      assert_receive {:replied, :a, :ok, %{text: "second", id: second}}
      {:ok, late, _} = client(:late, r, "zed")

      assert_receive {:pushed, :late, "history",
                      %{messages: [%{text: "first"}, %{text: "second"}]}}

      send_as(late, "history", %{"before" => second})
      assert_receive {:replied, :late, :ok, %{messages: [%{text: "first"}]}}
    end

    test "bad text and floods get an error reply and reach nobody" do
      r = room()
      {:ok, a, _} = client(:a, r, "alice")
      {:ok, _b, _} = client(:b, r, "bob")
      send_as(a, "say", %{"text" => "  "})
      assert_receive {:replied, :a, :error, %{reason: "empty"}}
      send_as(a, "say", %{"text" => String.duplicate("x", 2001)})
      assert_receive {:replied, :a, :error, %{reason: "too long"}}

      for i <- 1..6, do: send_as(a, "say", %{"text" => "msg #{i}"})
      for _ <- 1..5, do: assert_receive({:replied, :a, :ok, _})
      assert_receive {:replied, :a, :error, %{reason: "too fast"}}
      refute_receive {:pushed, :b, "said", %{text: "msg 6"}}, 100
    end

    test "a busy database holds up text, never a join, presence or frames" do
      r = room()
      {:ok, a, _} = client(:a, r, "alice")
      send_as(a, "say", %{"text" => "before"})
      assert_receive {:replied, :a, :ok, %{id: kept}}

      # Another process holds the test's one connection: every query waits.
      release = hold_database()

      {:ok, b, _} = client(:b, r, "bob")
      assert_receive {:pushed, :b, "presence_state", %{"alice" => _}}
      send_as(a, "frame", {:binary, <<1>>})
      assert_receive {:pushed, :b, "frame", {:binary, <<5, "alice", 1>>}}
      refute_received {:pushed, :b, "history", _}

      # Said meanwhile (say, on another node): held until the history's
      # out, and one the history already has isn't sent twice.
      for id <- [kept, kept + 1_000] do
        Phoenix.PubSub.broadcast(
          PresenceRelay.PubSub,
          PresenceRelay.Rooms.room_topic("acme", r),
          {:relay_said, %{id: id, sub: "carol", name: "Carol", text: "t#{id}", at: 0}}
        )
      end

      # This connection's own say waits for the database too; its frames don't.
      send_as(b, "say", %{"text" => "while busy"})
      Process.sleep(80)
      send_as(b, "frame", {:binary, <<2>>})
      assert_receive {:pushed, :a, "frame", {:binary, <<3, "bob", 2>>}}
      refute_received {:pushed, :b, "said", _}
      refute_received {:replied, :b, _, _}

      release.()
      assert_receive {:pushed, :b, "history", %{messages: [%{id: ^kept, text: "before"}]}}
      later = kept + 1_000
      assert_receive {:pushed, :b, "said", %{id: ^later}}
      refute_received {:pushed, :b, "said", %{id: ^kept}}
      assert_receive {:replied, :b, :ok, %{text: "while busy"}}
      assert_receive {:pushed, :a, "said", %{text: "while busy"}}
    end
  end

  test "messages said while a write is out go together in one batch, each back to its sender" do
    r = room()
    test = self()
    ref = make_ref()

    :telemetry.attach(
      ref,
      [:presence_relay, :repo, :query],
      fn _, _, %{source: "messages", query: q}, _ ->
        if q =~ "INSERT", do: send(test, {:insert, ref})
      end,
      nil
    )

    on_exit(fn -> :telemetry.detach(ref) end)

    # The database busy: the first message's write waits, and the rest
    # wait behind it.
    release = hold_database()
    tasks = for i <- 1..20, do: Task.async(fn -> Chat.say("acme", r, "s#{i}", "S", "m#{i}") end)
    Process.sleep(100)
    release.()

    results = Task.await_many(tasks)
    assert Enum.all?(results, &match?({:ok, _}, &1))
    # Each sender has its own message back.
    for {{:ok, m}, i} <- Enum.with_index(results, 1),
        do: assert(m.text == "m#{i}" and m.sub == "s#{i}")

    assert results |> Enum.map(fn {:ok, m} -> m.id end) |> Enum.uniq() |> length() == 20
    assert length(Chat.history("acme", r)) == 20

    # The first alone, then everything that came while it waited.
    inserts = Stream.repeatedly(fn -> receive(do: ({:insert, ^ref} -> 1), after: (0 -> nil)) end)
    assert inserts |> Enum.take_while(& &1) |> length() == 2
  end
end
