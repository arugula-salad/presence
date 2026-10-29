# S45 spike: what the relay would do to put the transcriber in a room, in
# plain Elixir (OTP's crypto and httpc, Elixir's own JSON; nothing the
# relay doesn't already have). Mirrors PresenceRelay.Calls.token/5.
#
#   ./with-livekit.sh mise exec -C ../../relay -- elixir dispatch.exs create <lk-room> [agent] [metadata]
#   ... elixir dispatch.exs list <lk-room>
#   ... elixir dispatch.exs delete <lk-room> <dispatch-id>
#   ... elixir dispatch.exs token <lk-room> <identity> <name> <agent> <out-file> [metadata]
#
# create/list/delete call LiveKit's AgentDispatchService (Twirp, JSON) with
# a JWT signed by our API key: roomAdmin on that room. `token` writes a
# participant token (the relay's call grant) whose roomConfig dispatches
# the agent when that participant connects, to <out-file> (never stdout).

defmodule S45.Dispatch do
  def env(k), do: System.fetch_env!(k)

  def jwt(claims) do
    enc = fn m -> Base.url_encode64(JSON.encode!(m), padding: false) end
    h = enc.(%{"alg" => "HS256", "typ" => "JWT"})
    p = enc.(claims)
    sig = :crypto.mac(:hmac, :sha256, env("LIVEKIT_API_SECRET"), h <> "." <> p)
    h <> "." <> p <> "." <> Base.url_encode64(sig, padding: false)
  end

  def admin_token(room) do
    now = System.system_time(:second)

    jwt(%{
      "iss" => env("LIVEKIT_API_KEY"),
      "sub" => "relay",
      "nbf" => now,
      "exp" => now + 60,
      "video" => %{"room" => room, "roomAdmin" => true}
    })
  end

  def twirp(method, room, body) do
    :ok = Application.ensure_all_started([:inets, :ssl]) |> elem(0)
    base = env("LIVEKIT_URL") |> String.replace_prefix("wss://", "https://") |> String.replace_prefix("ws://", "http://")
    url = ~c"#{base}/twirp/livekit.AgentDispatchService/#{method}"
    headers = [{~c"authorization", ~c"Bearer #{admin_token(room)}"}]
    ssl = [verify: :verify_peer, cacerts: :public_key.cacerts_get(), customize_hostname_check: [match_fun: :public_key.pkix_verify_hostname_match_fun(:https)]]
    t0 = System.monotonic_time(:millisecond)
    {:ok, {{_, status, _}, _, resp}} = :httpc.request(:post, {url, headers, ~c"application/json", JSON.encode!(body)}, [ssl: ssl, timeout: 10_000], body_format: :binary)
    {status, resp, System.monotonic_time(:millisecond) - t0}
  end

  # The relay's call grant (PresenceRelay.Calls.token/5), plus roomConfig.
  def room_token(room, identity, name, agent, meta) do
    now = System.system_time(:second)

    jwt(%{
      "iss" => env("LIVEKIT_API_KEY"),
      "sub" => identity,
      "name" => name,
      "nbf" => now,
      "exp" => now + 600,
      "video" => %{
        "room" => room,
        "roomJoin" => true,
        "canPublish" => true,
        "canPublishSources" => ["microphone", "camera"],
        "canPublishData" => false,
        "canSubscribe" => true
      },
      "roomConfig" => %{"agents" => [%{"agentName" => agent, "metadata" => meta}]}
    })
  end
end

case System.argv() do
  ["create", room | rest] ->
    agent = Enum.at(rest, 0, "s45-transcriber")
    meta = Enum.at(rest, 1, JSON.encode!(%{"by" => "relay"}))
    {s, r, ms} = S45.Dispatch.twirp("CreateDispatch", room, %{"room" => room, "agent_name" => agent, "metadata" => meta})
    IO.puts(JSON.encode!(%{status: s, ms: ms, body: JSON.decode!(r)}))

  ["list", room] ->
    {s, r, ms} = S45.Dispatch.twirp("ListDispatch", room, %{"room" => room})
    IO.puts(JSON.encode!(%{status: s, ms: ms, body: JSON.decode!(r)}))

  ["delete", room, id] ->
    {s, r, ms} = S45.Dispatch.twirp("DeleteDispatch", room, %{"room" => room, "dispatch_id" => id})
    IO.puts(JSON.encode!(%{status: s, ms: ms, body: JSON.decode!(r)}))

  ["token", room, identity, name, agent, out | rest] ->
    meta = Enum.at(rest, 0, JSON.encode!(%{"by" => "token"}))
    File.write!(out, S45.Dispatch.room_token(room, identity, name, agent, meta))
    File.chmod!(out, 0o600)
    IO.puts("wrote a room token with roomConfig.agents=[#{agent}]")

  _ ->
    IO.puts("usage: see the top of dispatch.exs")
end
