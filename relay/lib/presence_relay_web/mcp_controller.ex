defmodule PresenceRelayWeb.MCPController do
  @moduledoc """
  `/mcp`: arugula.stream as an MCP server, for agents setting up and
  managing apps (the tools are `PresenceRelay.MCP`'s).

  MCP's Streamable HTTP transport, stateless: each `POST` is a JSON-RPC
  message (or a batch) answered with JSON, never a stream, and there's no
  session to keep. `GET` (a stream of the server's own messages) and
  `DELETE` (ending a session) are 405s.

  An API token is the only way in (`Authorization: Bearer ak_…`, made in
  the dashboard); a session cookie isn't, so a page elsewhere can't drive
  it in a signed-in person's browser. A request carrying another site's
  `Origin` is refused too (the transport's guard against DNS rebinding).
  Limited per client IP like the API's writes (#318's P12).
  """
  use Phoenix.Controller, formats: [:json]
  require Logger

  alias PresenceRelay.{Accounts, Apps, MCP}
  alias PresenceRelayWeb.Auth

  # Newest first; an older client gets its own if it's here.
  @versions ~w(2025-11-25 2025-06-18 2025-03-26 2024-11-05)

  def post(conn, params) do
    with :ok <- same_origin(conn),
         {:ok, account} <- account(conn) do
      ctx = %{account: account, base_url: Auth.base_url(conn)}

      case params do
        %{"_json" => batch} when is_list(batch) and batch != [] ->
          answer(conn, batch |> Enum.map(&handle(&1, ctx)) |> Enum.reject(&is_nil/1))

        %{"_json" => _} ->
          conn |> put_status(400) |> json(error(nil, -32600, "send a JSON-RPC message"))

        message ->
          answer(conn, handle(message, ctx))
      end
    else
      {:halt, conn} -> conn
      {:refuse, status, body, headers} -> refuse(conn, status, body, headers)
    end
  end

  def other(conn, _) do
    conn
    |> put_resp_header("allow", "POST")
    |> put_status(405)
    |> json(error(nil, -32000, "this server answers POSTs: it keeps no stream and no session"))
  end

  # Notifications and responses alone get a 202 and no body.
  defp answer(conn, nil), do: send_resp(conn, 202, "")
  defp answer(conn, []), do: send_resp(conn, 202, "")
  defp answer(conn, reply), do: json(conn, reply)

  defp refuse(conn, status, body, headers) do
    Enum.reduce(headers, conn, fn {k, v}, c -> put_resp_header(c, k, v) end)
    |> put_status(status)
    |> json(body)
  end

  defp same_origin(conn) do
    case get_req_header(conn, "origin") do
      [] ->
        :ok

      [origin | _] ->
        if URI.parse(origin).host == conn.host,
          do: :ok,
          else:
            {:refuse, 403, error(nil, -32000, "requests from other sites' pages aren't taken"),
             []}
    end
  end

  defp account(conn) do
    token = Auth.bearer(conn)
    account = Apps.database?() && token && Accounts.by_token(token)

    cond do
      account ->
        Logger.metadata(account: account.id)
        {:ok, account}

      token ->
        {:refuse, 401,
         error(
           nil,
           -32001,
           "that API token isn't known, or was revoked: make one in the dashboard"
         ), [{"www-authenticate", ~s(Bearer error="invalid_token")}]}

      true ->
        {:refuse, 401,
         error(
           nil,
           -32001,
           "send an API token (Authorization: Bearer ak_…): make one at #{Auth.base_url(conn)}/dashboard/agents"
         ), [{"www-authenticate", "Bearer"}]}
    end
  end

  ## JSON-RPC

  # A request (it has an id) gets a response; a notification, or a
  # client's response to us (we never ask), gets nothing.
  defp handle(%{"jsonrpc" => "2.0", "method" => method, "id" => id} = m, ctx)
       when is_binary(id) or is_integer(id),
       do: reply(id, method, m["params"] || %{}, ctx)

  defp handle(%{"jsonrpc" => "2.0", "method" => m} = msg, _)
       when is_binary(m) and not is_map_key(msg, "id"),
       do: nil

  defp handle(%{"jsonrpc" => "2.0", "id" => _} = msg, _)
       when is_map_key(msg, "result") or is_map_key(msg, "error"),
       do: nil

  defp handle(m, _), do: error(if(is_map(m), do: m["id"]), -32600, "not a JSON-RPC 2.0 request")

  defp reply(id, "initialize", params, _) do
    asked = params["protocolVersion"]

    result(id, %{
      protocolVersion: if(asked in @versions, do: asked, else: hd(@versions)),
      capabilities: %{tools: %{listChanged: false}},
      serverInfo: %{
        name: "arugula.stream",
        title: "arugula.stream",
        version: to_string(Application.spec(:presence_relay, :vsn))
      },
      instructions: MCP.instructions()
    })
  end

  defp reply(id, "ping", _, _), do: result(id, %{})

  defp reply(id, "tools/list", _, _), do: result(id, %{tools: MCP.tools()})

  defp reply(id, "tools/call", %{"name" => name} = params, ctx) when is_binary(name) do
    if MCP.tool?(name) do
      case MCP.call(name, params["arguments"], ctx) do
        {:ok, out} ->
          result(id, %{
            content: [%{type: "text", text: Jason.encode!(out, pretty: true)}],
            structuredContent: out,
            isError: false
          })

        {:error, msg} ->
          result(id, %{content: [%{type: "text", text: msg}], isError: true})
      end
    else
      error(id, -32602, "no tool called #{name}: tools/list has them")
    end
  end

  defp reply(id, "tools/call", _, _), do: error(id, -32602, "send the tool's name")

  defp reply(id, method, _, _), do: error(id, -32601, "no method #{method} here")

  defp result(id, r), do: %{jsonrpc: "2.0", id: id, result: r}
  defp error(id, code, msg), do: %{jsonrpc: "2.0", id: id, error: %{code: code, message: msg}}
end
