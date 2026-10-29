defmodule PresenceRelay.Accounts do
  @moduledoc """
  Who signs in (#318 P3): accounts, by email magic link or Google, for
  the dashboard and meet.arugula.stream. Guests aren't accounts: a guest
  is a name on a socket (PresenceRelayWeb.Socket), nothing kept.

  An email identity is the address; a Google identity is Google's subject,
  joined to the account with the same (verified) address if there is one.

  An account can also make API tokens, for agents and scripts: each acts
  as the account (on `/api/v1` and the MCP endpoint, `/mcp`) until it's
  revoked.
  """

  import Ecto.Query
  import Swoosh.Email, except: [from: 2]
  alias PresenceRelay.{Mailer, Repo}
  alias PresenceRelay.Accounts.{Account, ApiToken, Identity, LoginToken}

  @link_life 15 * 60
  @email ~r/\A[^\s@]+@[^\s@]+\.[^\s@]+\z/

  def get(id) when is_binary(id), do: Repo.get(Account, id)
  def get(_), do: nil

  def valid_email?(e), do: is_binary(e) and String.length(e) <= 254 and e =~ @email

  @doc """
  Emails `email` a link (`base_url` + `/auth/email/<token>`) that signs it
  in once, within a quarter of an hour. `{:error, :no_mailer}` where mail
  isn't set up.
  """
  def send_link(email, base_url) do
    cond do
      not valid_email?(email) ->
        {:error, :bad_email}

      not Mailer.ready?() ->
        {:error, :no_mailer}

      true ->
        token = Base.url_encode64(:crypto.strong_rand_bytes(32), padding: false)
        expires = DateTime.utc_now() |> DateTime.add(@link_life) |> DateTime.truncate(:second)

        Repo.insert!(%LoginToken{
          token_hash: hash(token),
          email: String.downcase(email),
          expires_at: expires
        })

        link = base_url <> "/auth/email/" <> token

        new()
        |> to(email)
        |> Swoosh.Email.from(
          Application.get_env(
            :presence_relay,
            :mail_from,
            {"arugula.stream", "hello@arugula.stream"}
          )
        )
        |> subject("Your arugula.stream sign-in link")
        |> text_body("""
        Sign in to arugula.stream:

        #{link}

        The link works once, for 15 minutes. If you didn't ask for it, ignore this email.
        """)
        |> Mailer.deliver()
        |> case do
          {:ok, _} -> :ok
          {:error, reason} -> {:error, {:mail, reason}}
        end
    end
  end

  @doc "The account a magic link's token signs in (made on first use), or why not."
  def use_link(token) when is_binary(token) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    Repo.transaction(fn ->
      case Repo.one(
             from(t in LoginToken, where: t.token_hash == ^hash(token), lock: "FOR UPDATE")
           ) do
        nil ->
          Repo.rollback(:unknown)

        %LoginToken{used_at: used} when not is_nil(used) ->
          Repo.rollback(:used)

        %LoginToken{expires_at: exp} = t ->
          if DateTime.compare(exp, now) == :lt, do: Repo.rollback(:expired)
          t |> Ecto.Changeset.change(used_at: now) |> Repo.update!()
          by_identity("email", t.email, %{email: t.email})
      end
    end)
  end

  def use_link(_), do: {:error, :unknown}

  @doc """
  Whether an emailed link's token would still sign in, spending nothing
  (mail scanners fetch links before people click them): `{:ok, email}`, or
  `{:error, :unknown | :used | :expired}`.
  """
  def check_link(token) when is_binary(token) do
    now = DateTime.utc_now()

    case Repo.get_by(LoginToken, token_hash: hash(token)) do
      nil ->
        {:error, :unknown}

      %LoginToken{used_at: used} when not is_nil(used) ->
        {:error, :used}

      %LoginToken{expires_at: exp, email: email} ->
        if DateTime.compare(exp, now) == :lt, do: {:error, :expired}, else: {:ok, email}
    end
  end

  def check_link(_), do: {:error, :unknown}

  @doc """
  The account for a Google profile (`%{"sub", "email", "email_verified",
  "name"}`): its Google identity's, else the account with that verified
  address, else a new one.
  """
  def from_google(%{"sub" => sub} = p) when is_binary(sub) do
    verified = p["email_verified"] in [true, "true"]
    email = if verified and valid_email?(p["email"]), do: String.downcase(p["email"])

    Repo.transaction(fn ->
      case Repo.get_by(Identity, provider: "google", subject: sub) do
        %Identity{account_id: id} ->
          Repo.get!(Account, id)

        nil ->
          account =
            (email && Repo.get_by(Account, email: email)) ||
              Repo.insert!(%Account{id: new_id(), email: email, name: p["name"]})

          Repo.insert!(%Identity{account_id: account.id, provider: "google", subject: sub})
          account
      end
    end)
  end

  def from_google(_), do: {:error, :bad_profile}

  ## API tokens

  @doc """
  A new API token for `account`, named `name` (what it's for): `{:ok,
  token, raw}`. The raw token (`ak_…`) is shown this once; only its hash
  is kept. It acts as the account on `/api/v1` and `/mcp`, until revoked.
  """
  def make_token(%Account{id: id}, name) do
    name = if is_binary(name), do: String.trim(name), else: ""

    if name != "" and String.length(name) <= 80 do
      raw = "ak_" <> Base.url_encode64(:crypto.strong_rand_bytes(32), padding: false)

      token =
        Repo.insert!(%ApiToken{
          account_id: id,
          name: name,
          token_hash: hash(raw),
          prefix: String.slice(raw, 0, 10)
        })

      {:ok, token, raw}
    else
      {:error, "a token's name is 1–80 characters"}
    end
  end

  @doc "`account`'s tokens that still work, newest first."
  def list_tokens(%Account{id: id}) do
    Repo.all(
      from(t in ApiToken,
        where: t.account_id == ^id and is_nil(t.revoked_at),
        order_by: [desc: t.inserted_at, desc: t.id]
      )
    )
  end

  @doc "Revokes `account`'s token `id`: `:ok`, or `{:error, :not_found}`."
  def revoke_token(%Account{id: account}, id) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    with {id, ""} <- (is_binary(id) && Integer.parse(id)) || :error,
         {1, _} <-
           Repo.update_all(
             from(t in ApiToken,
               where: t.id == ^id and t.account_id == ^account and is_nil(t.revoked_at)
             ),
             set: [revoked_at: now]
           ) do
      :ok
    else
      _ -> {:error, :not_found}
    end
  end

  @doc """
  The account a raw API token acts as, or nil (unknown or revoked). Notes
  when it was last used, at most once a minute.
  """
  def by_token("ak_" <> _ = raw) when byte_size(raw) <= 100 do
    q =
      from(t in ApiToken,
        join: a in assoc(t, :account),
        where: t.token_hash == ^hash(raw) and is_nil(t.revoked_at),
        select: {t, a}
      )

    case Repo.one(q) do
      {t, account} ->
        now = DateTime.utc_now() |> DateTime.truncate(:second)

        if is_nil(t.last_used_at) or DateTime.diff(now, t.last_used_at) >= 60,
          do: Repo.update_all(from(x in ApiToken, where: x.id == ^t.id), set: [last_used_at: now])

        account

      nil ->
        nil
    end
  end

  def by_token(_), do: nil

  defp by_identity(provider, subject, attrs) do
    case Repo.get_by(Identity, provider: provider, subject: subject) do
      %Identity{account_id: id} ->
        Repo.get!(Account, id)

      nil ->
        account =
          (attrs[:email] && Repo.get_by(Account, email: attrs[:email])) ||
            Repo.insert!(%Account{id: new_id(), email: attrs[:email], name: attrs[:name]})

        Repo.insert!(%Identity{account_id: account.id, provider: provider, subject: subject})
        account
    end
  end

  defp hash(token), do: :crypto.hash(:sha256, token)
  defp new_id, do: "acc_" <> Base.encode16(:crypto.strong_rand_bytes(8), case: :lower)
end
