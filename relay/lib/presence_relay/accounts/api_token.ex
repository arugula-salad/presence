defmodule PresenceRelay.Accounts.ApiToken do
  @moduledoc "An account's API token, by its SHA-256: for agents and scripts, until revoked."
  use Ecto.Schema

  schema "api_tokens" do
    belongs_to(:account, PresenceRelay.Accounts.Account, type: :string)
    field(:name, :string)
    field(:token_hash, :binary)
    field(:prefix, :string)
    field(:last_used_at, :utc_datetime)
    field(:revoked_at, :utc_datetime)
    timestamps(type: :utc_datetime, updated_at: false)
  end
end
