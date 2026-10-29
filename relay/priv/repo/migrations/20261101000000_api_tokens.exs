defmodule PresenceRelay.Repo.Migrations.ApiTokens do
  use Ecto.Migration

  def change do
    # An account's API tokens, for agents and scripts (the MCP endpoint,
    # /api/v1 by Authorization: Bearer). Only the token's hash is kept; it's
    # shown once, when made.
    create table(:api_tokens) do
      add :account_id, references(:accounts, type: :string, on_delete: :delete_all), null: false
      add :name, :string, null: false
      add :token_hash, :binary, null: false
      # The token's first characters, to tell tokens apart in a list.
      add :prefix, :string, null: false
      add :last_used_at, :utc_datetime
      add :revoked_at, :utc_datetime
      timestamps(type: :utc_datetime, updated_at: false)
    end

    create unique_index(:api_tokens, [:token_hash])
    create index(:api_tokens, [:account_id])
  end
end
