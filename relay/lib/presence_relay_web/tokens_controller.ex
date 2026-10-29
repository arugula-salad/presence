defmodule PresenceRelayWeb.TokensController do
  @moduledoc """
  `/api/v1/tokens`: the signed-in account's API tokens, for agents (the
  MCP endpoint, `PresenceRelayWeb.MCPController`) and scripts. Made and
  revoked from the dashboard, by its session: a token can't make another.
  The token itself is shown once, when made.
  """
  use Phoenix.Controller, formats: [:json]

  alias PresenceRelay.Accounts

  def index(conn, _),
    do: json(conn, %{tokens: Enum.map(Accounts.list_tokens(conn.assigns.account), &view/1)})

  def create(conn, params) do
    case Accounts.make_token(conn.assigns.account, params["name"]) do
      {:ok, token, raw} -> conn |> put_status(201) |> json(%{token: view(token), secret: raw})
      {:error, msg} -> conn |> put_status(400) |> json(%{error: msg})
    end
  end

  def delete(conn, %{"id" => id}) do
    case Accounts.revoke_token(conn.assigns.account, id) do
      :ok -> json(conn, %{revoked: id})
      {:error, :not_found} -> conn |> put_status(404) |> json(%{error: "no such token"})
    end
  end

  defp view(t),
    do: %{
      id: to_string(t.id),
      name: t.name,
      prefix: t.prefix,
      made: t.inserted_at,
      last_used: t.last_used_at
    }
end
