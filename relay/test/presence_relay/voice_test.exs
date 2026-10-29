defmodule PresenceRelay.VoiceTest do
  use PresenceRelay.RelayCase, async: false

  # Each room's voice channel (PROTOCOL.md, "Voice"; Arugula #331): a
  # token for the room's own LiveKit room, presence saying who's in voice
  # and muted, the cap, one audio session a connection (voice or a call),
  # one voice seat a person, and voice minutes metered and billed as call
  # minutes. Test config has LiveKit keys, so voice is on.

  alias PresenceRelay.{Apps, Billing, Repo, Usage, Voice}
  alias PresenceRelay.Accounts.Account

  @secret "test-livekit-secret"

  defp claims(token) do
    [h, p, sig] = String.split(token, ".")

    assert Base.url_decode64!(sig, padding: false) ==
             :crypto.mac(:hmac, :sha256, @secret, h <> "." <> p)

    Jason.decode!(Base.url_decode64!(p, padding: false))
  end

  defp join_voice(pid, name) do
    send_as(pid, "voice_join", %{})
    assert_receive {:replied, ^name, :ok, %{url: _, room: _, token: _} = info}
    info
  end

  # The newest meta presence pushed `who` for `sub`.
  defp meta_for(who, sub) do
    assert_receive {:pushed, ^who, "presence_diff", %{joins: %{^sub => %{metas: [meta]}}}}
    meta
  end

  # The first meta presence pushes `who` for `sub` that `ok?` holds for
  # (earlier diffs are passed over).
  defp meta_until(who, sub, ok?) do
    meta = meta_for(who, sub)
    if ok?.(meta), do: meta, else: meta_until(who, sub, ok?)
  end

  defp ring(caller, callee, callee_name, to) do
    send_as(caller, "call", %{"to" => to})
    assert_receive {:replied, _, :ok, %{id: id}}
    assert_receive {:pushed, ^callee_name, "call", %{id: ^id}}
    send_as(callee, "call_answer", %{"id" => id, "yes" => true})
    id
  end

  test "the join reply says voice is on, and voice_join hands a token for the room's voice room" do
    r = room()
    assert {:ok, a, %{voice: true, calls: true}} = client(:a, r, "alice", %{"name" => "Alice"})
    info = join_voice(a, :a)
    lk_room = "acme:#{r}:voice"
    assert %{url: "wss://livekit.test", room: ^lk_room} = info
    c = claims(info.token)
    assert %{"iss" => "test-key", "sub" => "alice", "name" => "Alice"} = c

    assert c["video"] == %{
             "room" => lk_room,
             "roomJoin" => true,
             "canPublish" => true,
             "canPublishSources" => ["microphone", "camera"],
             "canPublishData" => false,
             "canSubscribe" => true
           }

    now = System.system_time(:second)
    assert (c["exp"] - now) in 590..600, "lives ten minutes, like a call's"
    # Two rooms' voice (or two apps') never share a LiveKit room, nor a call's.
    assert Voice.livekit_room("acme", "r") != Voice.livekit_room("other", "r")
    assert Voice.livekit_room("acme", "r") != Voice.livekit_room("acme", "r2")
    assert String.length(PresenceRelay.Calls.new_id()) == 16
  end

  test "everyone in the room sees who's in voice and muted; mute, leave, and a fresh token" do
    r = room()
    {:ok, a, _} = client(:a, r, "alice")
    {:ok, b, _} = client(:b, r, "bob")
    {:ok, _c, _} = client(:c, r, "carol")
    # Before anyone joins, nobody's meta says voice.
    assert_receive {:pushed, :c, "presence_state", state}
    refute Enum.any?(state, fn {_, %{metas: ms}} -> Enum.any?(ms, & &1[:voice]) end)

    # Mute and a token are for people in voice.
    send_as(a, "voice_mute", %{"muted" => false})
    assert_receive {:replied, :a, :error, %{reason: "not in voice"}}
    send_as(a, "voice_token", %{})
    assert_receive {:replied, :a, :error, %{reason: "not in voice"}}

    join_voice(a, :a)
    # Carol, outside voice, sees Alice in it, muted (people join muted).
    assert %{voice: true, muted: true} = meta_for(:c, "alice")
    assert Voice.size("acme", r) == 1

    join_voice(b, :b)
    assert %{voice: true, muted: true} = meta_for(:c, "bob")

    send_as(a, "voice_mute", %{"muted" => false})
    assert_receive {:replied, :a, :ok, _}
    assert %{voice: true, muted: false} = meta_for(:c, "alice")

    send_as(a, "voice_token", %{})
    assert_receive {:replied, :a, :ok, %{room: room_name, token: t}}
    assert room_name == "acme:#{r}:voice" and claims(t)["sub"] == "alice"

    # Joining again is a fresh token, nothing else.
    join_voice(a, :a)
    assert Voice.size("acme", r) == 2

    send_as(a, "voice_leave", %{})
    assert_receive {:replied, :a, :ok, _}
    meta = meta_for(:c, "alice")
    assert meta.voice == false and not Map.has_key?(meta, :muted)
    # Bob stays.
    assert Voice.size("acme", r) == 1
    # Leaving when out is fine.
    send_as(a, "voice_leave", %{})
    assert_receive {:replied, :a, :ok, _}
  end

  test "at most voice_cap in a room's voice: past it, \"voice is full\"" do
    Application.put_env(:presence_relay, :voice_cap, 2)
    on_exit(fn -> Application.delete_env(:presence_relay, :voice_cap) end)
    r = room()
    {:ok, a, _} = client(:a, r, "alice")
    {:ok, b, _} = client(:b, r, "bob")
    {:ok, c, _} = client(:c, r, "carol")
    join_voice(a, :a)
    join_voice(b, :b)
    send_as(c, "voice_join", %{})
    assert_receive {:replied, :c, :error, %{reason: "voice is full"}}
    # Another room's voice is its own.
    {:ok, z, _} = client(:z, room(), "zed")
    join_voice(z, :z)
    # A place opens.
    send_as(a, "voice_leave", %{})
    assert_receive {:replied, :a, :ok, _}
    join_voice(c, :c)
  end

  test "one audio session a connection: voice leaves a call, a call leaves voice" do
    r = room()
    {:ok, a, _} = client(:a, r, "alice")
    {:ok, b, _} = client(:b, r, "bob")
    {:ok, c, _} = client(:c, r, "carol")

    # Alice is in voice; Bob rings her and she says yes: she's out of voice.
    join_voice(a, :a)
    id = ring(b, a, :a, "alice")
    assert_receive {:pushed, :a, "voice_left", %{reason: "call"}}
    assert_receive {:pushed, :a, "call_join", %{id: ^id}}
    assert Voice.size("acme", r) == 0
    assert meta_until(:c, "alice", &(&1.voice == false))

    # Bob, in the call, joins voice: he leaves the call first.
    assert_receive {:pushed, :b, "call_join", %{id: ^id}}
    Process.sleep(50)
    join_voice(b, :b)
    assert PresenceRelay.Calls.size("acme", r, id) == 1
    assert Voice.size("acme", r) == 1

    # Bob, in voice, rings Carol: on her yes, he leaves voice for the call.
    id2 = ring(b, c, :c, "carol")
    assert_receive {:pushed, :b, "voice_left", %{reason: "call"}}
    assert_receive {:pushed, :b, "call_join", %{id: ^id2}}
    assert Voice.size("acme", r) == 0
  end

  test "one voice seat a person: joining from another page leaves it on the first" do
    r = room()
    {:ok, a1, _} = client(:a1, r, "alice")
    {:ok, a2, _} = client(:a2, r, "alice")
    join_voice(a1, :a1)
    join_voice(a2, :a2)
    assert_receive {:pushed, :a1, "voice_left", %{reason: "elsewhere"}}
    refute_receive {:pushed, :a2, "voice_left", _}, 50
    assert Voice.size("acme", r) == 1
  end

  test "start, join, leave and stop are told as the calls' telemetry, kind :voice" do
    r = room()
    test = self()
    handler = "voice-test-#{r}"

    :telemetry.attach_many(
      handler,
      for(k <- [:start, :join, :leave, :stop], do: [:presence_relay, :call, k]),
      fn [_, _, kind], m, meta, _ -> send(test, {:call_event, kind, m, meta}) end,
      nil
    )

    on_exit(fn -> :telemetry.detach(handler) end)
    {:ok, a, _} = client(:a, r, "alice")
    {:ok, b, _} = client(:b, r, "bob")
    join_voice(a, :a)
    assert_receive {:call_event, :start, _, %{app: "acme", room: ^r, call: "voice", kind: :voice}}
    assert_receive {:call_event, :join, _, %{call: "voice", sub: "alice", kind: :voice}}
    join_voice(b, :b)
    assert_receive {:call_event, :join, _, %{sub: "bob"}}
    refute_receive {:call_event, :start, _, _}, 50

    send_as(a, "voice_leave", %{})
    assert_receive {:call_event, :leave, %{duration_ms: ms}, %{sub: "alice", kind: :voice}}
    assert is_integer(ms) and ms >= 0
    refute_receive {:call_event, :stop, _, _}, 50
    # Bob's page closing takes him out, and the room's voice stops.
    leave(b, :b)
    assert_receive {:call_event, :leave, _, %{sub: "bob", kind: :voice}}
    assert_receive {:call_event, :stop, _, %{room: ^r, kind: :voice}}
    assert Voice.size("acme", r) == 0
  end

  test "voice minutes are call minutes: in the app's usage, and in what billing reports" do
    Usage.reset()
    Application.put_env(:presence_relay, :usage_today, ~D[2026-10-29])
    on_exit(fn -> Application.delete_env(:presence_relay, :usage_today) end)
    n = System.unique_integer([:positive])
    owner = Repo.insert!(%Account{id: "acc_v#{n}", email: "v#{n}@example.com"})
    {:ok, app, _} = Apps.create(owner, %{"name" => "Acme"})
    r = room()

    member = fn name, sub ->
      tok = token(%{"room" => r, "sub" => sub, "name" => "M"}, app.id)
      client_with(node(), name, r, %{"token" => tok})
    end

    {:ok, a, _} = member.(:a, "alice")
    {:ok, b, _} = member.(:b, "bob")
    join_voice(a, :a)
    join_voice(b, :b)
    Process.sleep(20)
    send_as(a, "voice_leave", %{})
    assert_receive {:replied, :a, :ok, _}
    leave(b, :b)
    :ok = Usage.flush()
    # Each under a second, rounded up: 2 s, so a minute.
    assert %{this_month: %{call_minutes: 1}} = Usage.report(Repo.reload(app))

    # Known lengths, as Voice tells them: 61 s and 59.5 s (60).
    Voice.leave(app.id, r, "alice", 61_000)
    Voice.leave(app.id, r, "bob", 59_500)
    :ok = Usage.flush()
    # 2 + 61 + 60 = 123 s: 3 minutes, which is what billing's meters read.
    assert %{this_month: %{call_minutes: 3}} = Usage.report(Repo.reload(app))
    assert %{"minutes" => 3} = Billing.quantities(app.id, ~D[2026-10-01])
  end

  test "without LiveKit keys voice is off: the join reply says so and voice_join is refused" do
    was = Application.get_env(:presence_relay, :livekit)
    Application.delete_env(:presence_relay, :livekit)
    on_exit(fn -> Application.put_env(:presence_relay, :livekit, was) end)
    r = room()
    assert {:ok, a, %{voice: false}} = client(:a, r, "alice")
    send_as(a, "voice_join", %{})
    assert_receive {:replied, :a, :error, %{reason: "voice isn't set up here"}}
  end
end
