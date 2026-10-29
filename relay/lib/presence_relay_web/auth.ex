defmodule PresenceRelayWeb.Auth do
  @moduledoc """
  The signed-in account, from an API token (`Authorization: Bearer ak_…`)
  or else the session cookie; and the guard on JSON writes.

  A request with a token is the token's account and never the cookie's,
  and `:by_token` says so: what only a person at the dashboard may do
  (make and revoke tokens) checks it.
  """
  import Plug.Conn
  import Phoenix.Controller, only: [json: 2]

  def fetch_account(conn, _) do
    case bearer(conn) do
      nil ->
        account =
          if PresenceRelay.Apps.database?(),
            do: PresenceRelay.Accounts.get(get_session(conn, :account_id))

        conn |> assign(:account, account) |> assign(:by_token, false)

      token ->
        account = if PresenceRelay.Apps.database?(), do: PresenceRelay.Accounts.by_token(token)
        conn |> assign(:account, account) |> assign(:by_token, true)
    end
  end

  @doc "The bearer token in `Authorization`, or nil."
  def bearer(conn) do
    case get_req_header(conn, "authorization") do
      [<<scheme::binary-size(7), token::binary>> | _] when scheme in ["Bearer ", "bearer "] ->
        String.trim(token)

      _ ->
        nil
    end
  end

  def require_account(%{assigns: %{account: %{}}} = conn, _), do: conn

  def require_account(%{assigns: %{by_token: true}} = conn, _),
    do:
      conn
      |> put_status(401)
      |> json(%{error: "that API token isn't known, or was revoked"})
      |> halt()

  def require_account(conn, _),
    do: conn |> put_status(401) |> json(%{error: "sign in first"}) |> halt()

  @doc "Only a session (a person at the dashboard), not an API token."
  def require_session(%{assigns: %{by_token: true}} = conn, _),
    do:
      conn
      |> put_status(403)
      |> json(%{error: "API tokens are made and revoked in the dashboard"})
      |> halt()

  def require_session(conn, _), do: conn

  @doc "POST, PATCH and PUT must be JSON: a cross-site form can only send form encodings."
  def json_writes(%{method: m} = conn, _) when m in ["POST", "PATCH", "PUT"] do
    case get_req_header(conn, "content-type") do
      ["application/json" <> _] -> conn
      _ -> conn |> put_status(415) |> json(%{error: "send JSON"}) |> halt()
    end
  end

  def json_writes(conn, _), do: conn

  @doc """
  This request's own origin, as the browser sees it: behind Fly's proxy
  (which terminates TLS) the forwarded scheme on the standard port.
  """
  def base_url(conn) do
    case get_req_header(conn, "x-forwarded-proto") do
      [proto | _] ->
        "#{proto}://#{conn.host}"

      [] ->
        default = if conn.scheme == :https, do: 443, else: 80
        port = if conn.port == default, do: "", else: ":#{conn.port}"
        "#{conn.scheme}://#{conn.host}#{port}"
    end
  end

  @doc "A path to go back to after signing in: same site only."
  def return_to(path) when is_binary(path) do
    if String.starts_with?(path, "/") and not String.starts_with?(path, "//"), do: path, else: "/"
  end

  def return_to(_), do: "/"
end
