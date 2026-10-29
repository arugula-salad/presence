defmodule PresenceRelay.MCPTest do
  @moduledoc "API tokens, and /mcp: an agent setting up and managing apps with one."
  use PresenceRelay.DataCase, async: false
  import Plug.Conn
  import Phoenix.ConnTest

  @endpoint PresenceRelayWeb.Endpoint

  alias PresenceRelay.Accounts
  alias PresenceRelay.Accounts.Account

  defp account(email \\ "maya@example.com") do
    Repo.insert!(%Account{id: "acc_m#{System.unique_integer([:positive])}", email: email})
  end

  defp as(%Account{id: id}), do: build_conn() |> init_test_session(account_id: id)

  defp bearer(conn \\ build_conn(), raw),
    do: put_req_header(conn, "authorization", "Bearer " <> raw)

  defp json(conn, method, path, body) do
    conn
    |> put_req_header("content-type", "application/json")
    |> dispatch(@endpoint, method, path, Jason.encode!(body))
  end

  defp token(account) do
    {:ok, _, raw} = Accounts.make_token(account, "an agent")
    raw
  end

  defp rpc(raw, method, params \\ %{}, id \\ 1) do
    bearer(raw) |> json(:post, "/mcp", %{jsonrpc: "2.0", id: id, method: method, params: params})
  end

  # A tool's answer: {:ok, structured} or {:error, text}.
  defp tool(raw, name, args \\ %{}) do
    %{"result" => r} =
      rpc(raw, "tools/call", %{name: name, arguments: args}) |> json_response(200)

    case r do
      %{
        "isError" => false,
        "structuredContent" => out,
        "content" => [%{"type" => "text", "text" => text}]
      } ->
        assert Jason.decode!(text) == out
        {:ok, out}

      %{"isError" => true, "content" => [%{"text" => msg}]} ->
        {:error, msg}
    end
  end

  describe "API tokens" do
    test "made in the dashboard, shown once, listed by name, revoked" do
      maya = account()

      %{
        "token" => %{"id" => id, "name" => "Claude", "prefix" => prefix},
        "secret" => "ak_" <> _ = raw
      } =
        as(maya) |> json(:post, "/api/v1/tokens", %{name: " Claude "}) |> json_response(201)

      assert String.starts_with?(raw, prefix)

      assert %{"tokens" => [%{"id" => ^id, "name" => "Claude", "last_used" => nil} = t]} =
               as(maya) |> get("/api/v1/tokens") |> json_response(200)

      refute Map.has_key?(t, "secret")
      refute inspect(Repo.all(Accounts.ApiToken)) =~ raw

      assert %{"error" => "a token's name is 1–80 characters"} =
               as(maya) |> json(:post, "/api/v1/tokens", %{name: "  "}) |> json_response(400)

      # The token acts as Maya on the API.
      assert %{"apps" => []} = bearer(raw) |> get("/api/v1/apps") |> json_response(200)

      assert %{"tokens" => [%{"last_used" => used}]} =
               as(maya) |> get("/api/v1/tokens") |> json_response(200)

      assert used

      # Someone else can't revoke it; Maya can, and then it's refused.
      assert as(account("ada@example.com"))
             |> delete("/api/v1/tokens/#{id}")
             |> json_response(404)

      assert %{"revoked" => ^id} =
               as(maya) |> delete("/api/v1/tokens/#{id}") |> json_response(200)

      assert %{"tokens" => []} = as(maya) |> get("/api/v1/tokens") |> json_response(200)

      assert %{"error" => "that API token isn't known, or was revoked"} =
               bearer(raw) |> get("/api/v1/apps") |> json_response(401)
    end

    test "a token can't make or see tokens, and a bad token doesn't fall back to the cookie" do
      maya = account()
      raw = token(maya)

      assert bearer(raw) |> get("/api/v1/tokens") |> json_response(403)

      assert bearer(raw)
             |> json(:post, "/api/v1/tokens", %{name: "another"})
             |> json_response(403)

      assert as(maya) |> bearer("ak_made-up") |> get("/api/v1/apps") |> json_response(401)
    end
  end

  describe "/mcp, the transport" do
    test "an API token is the only way in: not none, not a made-up one, not the cookie" do
      maya = account()
      body = %{jsonrpc: "2.0", id: 1, method: "tools/list"}

      conn = build_conn() |> json(:post, "/mcp", body)
      assert %{"error" => %{"message" => "send an API token" <> _}} = json_response(conn, 401)
      assert get_resp_header(conn, "www-authenticate") == ["Bearer"]

      conn = bearer("ak_nope") |> json(:post, "/mcp", body)
      assert json_response(conn, 401)
      assert [~s(Bearer error="invalid_token")] = get_resp_header(conn, "www-authenticate")

      assert as(maya) |> json(:post, "/mcp", body) |> json_response(401)
    end

    test "a page on another site is refused; this site's own origin is fine" do
      raw = token(account())
      body = %{jsonrpc: "2.0", id: 1, method: "ping"}

      assert bearer(raw)
             |> put_req_header("origin", "https://evil.example")
             |> json(:post, "/mcp", body)
             |> json_response(403)

      assert %{"result" => %{}} =
               bearer(raw)
               |> put_req_header("origin", "http://www.example.com")
               |> json(:post, "/mcp", body)
               |> json_response(200)
    end

    test "initialize: the client's version if we have it, else ours; tools; instructions" do
      raw = token(account())

      assert %{
               "id" => 1,
               "result" => %{
                 "protocolVersion" => "2025-06-18",
                 "capabilities" => %{"tools" => %{}},
                 "serverInfo" => %{"name" => "arugula.stream"},
                 "instructions" => "arugula.stream" <> _
               }
             } =
               rpc(raw, "initialize", %{
                 protocolVersion: "2025-06-18",
                 capabilities: %{},
                 clientInfo: %{name: "t", version: "0"}
               })
               |> json_response(200)

      assert %{"result" => %{"protocolVersion" => "2025-11-25"}} =
               rpc(raw, "initialize", %{protocolVersion: "1999-01-01"}) |> json_response(200)
    end

    test "notifications get a 202; a batch, its answers; GET and DELETE are 405s; unknowns are errors" do
      raw = token(account())

      assert bearer(raw)
             |> json(:post, "/mcp", %{jsonrpc: "2.0", method: "notifications/initialized"})
             |> response(202) == ""

      assert [%{"id" => "a", "result" => %{}}, %{"id" => "b", "result" => %{"tools" => [_ | _]}}] =
               bearer(raw)
               |> json(:post, "/mcp", [
                 %{jsonrpc: "2.0", id: "a", method: "ping"},
                 %{jsonrpc: "2.0", method: "notifications/initialized"},
                 %{jsonrpc: "2.0", id: "b", method: "tools/list"}
               ])
               |> json_response(200)

      conn = bearer(raw) |> get("/mcp")
      assert json_response(conn, 405)
      assert get_resp_header(conn, "allow") == ["POST"]
      assert bearer(raw) |> delete("/mcp") |> json_response(405)

      assert %{"error" => %{"code" => -32601}} = rpc(raw, "resources/list") |> json_response(200)

      assert %{"error" => %{"code" => -32602}} =
               rpc(raw, "tools/call", %{name: "drop_tables"}) |> json_response(200)

      assert %{"error" => %{"code" => -32600}} =
               bearer(raw) |> json(:post, "/mcp", %{id: 1, method: "ping"}) |> json_response(200)
    end

    test "every tool is listed with an object schema" do
      raw = token(account())
      %{"result" => %{"tools" => tools}} = rpc(raw, "tools/list") |> json_response(200)
      names = Enum.map(tools, & &1["name"])

      for n <-
            ~w(list_apps get_app create_app update_app add_origin remove_origin create_key revoke_key
                  set_sign_in remove_sign_in set_room_rule remove_room_rule get_usage set_cap get_billing rotate_secret),
          do: assert(n in names, n)

      for t <- tools do
        assert %{"type" => "object", "properties" => %{}} = t["inputSchema"], t["name"]
        assert is_binary(t["description"]) and t["description"] != ""
      end
    end
  end

  describe "/mcp, the tools" do
    test "an agent sets up an app end to end" do
      maya = account()
      raw = token(maya)

      assert {:ok, %{"apps" => []}} = tool(raw, "list_apps")

      {:ok,
       %{"app" => %{"id" => id, "keys" => [%{"mode" => "live"}]}, "server_secret" => secret} =
         made} =
        tool(raw, "create_app", %{name: "Sketchpad"})

      assert is_binary(secret) and byte_size(secret) > 20
      assert made["setup"]["ready"] == false
      assert Enum.any?(made["setup"]["left"], &(&1 =~ "add_origin"))
      assert made["dashboard"] == "http://www.example.com/dashboard/apps/#{id}"

      # It's Maya's: the dashboard shows it.
      assert %{"apps" => [%{"id" => ^id}]} = as(maya) |> get("/api/v1/apps") |> json_response(200)

      assert {:error, "an origin has no path"} =
               tool(raw, "add_origin", %{app_id: id, origin: "https://sketchpad.app/rooms"})

      assert {:ok, %{"app" => %{"origins" => ["https://sketchpad.app"]}}} =
               tool(raw, "add_origin", %{app_id: id, origin: "HTTPS://Sketchpad.app"})

      assert {:ok, %{"key" => %{"key" => "pk_test_" <> _ = test_key, "mode" => "test"}}} =
               tool(raw, "create_key", %{app_id: id, mode: "test"})

      assert {:error, "a key is live or test"} =
               tool(raw, "create_key", %{app_id: id, mode: "staging"})

      assert {:error, msg} =
               tool(raw, "set_room_rule", %{app_id: id, claim: "org_id", match: "prefix"})

      assert msg =~ "set_sign_in"

      assert {:error, "oidc needs an audience" <> _} =
               tool(raw, "set_sign_in", %{
                 app_id: id,
                 provider: "oidc",
                 issuer: "https://id.sketchpad.app"
               })

      assert {:ok, %{"sign_in" => %{"provider" => "oidc", "iss" => "https://id.sketchpad.app"}}} =
               tool(raw, "set_sign_in", %{
                 app_id: id,
                 provider: "oidc",
                 issuer: "https://id.sketchpad.app",
                 audience: "sketchpad-web"
               })

      assert {:ok,
              %{
                "sign_in" => %{
                  "room_rule" => %{"claim" => "org_id", "match" => "prefix"},
                  "audience" => "sketchpad-web"
                }
              }} =
               tool(raw, "set_room_rule", %{app_id: id, claim: "org_id", match: "prefix"})

      # Changing the provider keeps the rule.
      assert {:ok,
              %{
                "sign_in" => %{
                  "audience" => "sketchpad-app",
                  "room_rule" => %{"claim" => "org_id"}
                }
              }} =
               tool(raw, "set_sign_in", %{
                 app_id: id,
                 provider: "oidc",
                 issuer: "https://id.sketchpad.app",
                 audience: "sketchpad-app"
               })

      assert {:ok, %{"app" => %{"guests" => true, "name" => "Sketchpad 2"}}} =
               tool(raw, "update_app", %{app_id: id, guests: true, name: "Sketchpad 2"})

      assert {:error, "a name is 1–80 characters"} =
               tool(raw, "update_app", %{app_id: id, name: ""})

      {:ok, app} = tool(raw, "get_app", %{app_id: id})
      assert app["setup"] == %{"ready" => true, "left" => []}
      assert app["connect"]["key"] == test_key
      assert app["connect"]["relay"] == "ws://www.example.com/socket"
      assert app["connect"]["javascript"] =~ ~s(key: "#{test_key}")
      assert app["connect"]["javascript"] =~ "userManager.getUser()"

      assert {:ok, %{"cap" => %{"active_users" => 40}}} =
               tool(raw, "set_cap", %{app_id: id, active_users: 40})

      assert {:error, _} = tool(raw, "set_cap", %{app_id: id, active_users: "lots"})

      assert {:ok, %{"cap" => %{"active_users" => 40}, "this_month" => _}} =
               tool(raw, "get_usage", %{app_id: id})

      assert {:error, "months is 1–24"} = tool(raw, "get_usage", %{app_id: id, months: 99})

      assert {:ok, %{"plan" => "starter", "dashboard" => _}} =
               tool(raw, "get_billing", %{app_id: id})

      assert {:ok, %{"server_secret" => new}} = tool(raw, "rotate_secret", %{app_id: id})
      assert new != secret

      assert {:ok, %{"sign_in" => %{"room_rule" => nil}}} =
               tool(raw, "remove_room_rule", %{app_id: id})

      assert {:ok, %{"sign_in" => nil}} = tool(raw, "remove_sign_in", %{app_id: id})

      assert {:ok, %{"revoked" => ^test_key}} =
               tool(raw, "revoke_key", %{app_id: id, key: test_key})

      assert {:error, "no such key" <> _} = tool(raw, "revoke_key", %{app_id: id, key: test_key})

      assert {:ok, %{"app" => %{"origins" => []}}} =
               tool(raw, "remove_origin", %{app_id: id, origin: "https://sketchpad.app"})

      assert {:ok,
              %{
                "apps" => [
                  %{"id" => ^id, "keys" => [%{"mode" => "live"}], "setup" => %{"ready" => false}}
                ]
              }} =
               tool(raw, "list_apps")
    end

    test "another account's app isn't there, whatever the tool" do
      {:ok, app, _} = PresenceRelay.Apps.create(account("ada@example.com"), %{"name" => "Ada's"})
      raw = token(account())

      for {name, args} <- [
            {"get_app", %{}},
            {"add_origin", %{origin: "https://x.example"}},
            {"create_key", %{}},
            {"rotate_secret", %{}},
            {"set_cap", %{active_users: 1}}
          ] do
        assert {:error, "no such app" <> _} = tool(raw, name, Map.put(args, :app_id, app.id)),
               name
      end

      assert {:error, "send app_id" <> _} = tool(raw, "get_app")
    end
  end
end
