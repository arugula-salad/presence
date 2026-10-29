defmodule PresenceRelay.MCP do
  @moduledoc """
  The tools an agent drives arugula.stream with, over MCP
  (`PresenceRelayWeb.MCPController` speaks the protocol): what the
  dashboard does, as the account an API token acts for. Make and list
  apps, their keys and origins, how their people sign in and the room
  rule, guests, usage and the cap, the plan, and the server secret.

  Each tool is the dashboard's API call (`PresenceRelayWeb.AppsController`)
  over the same functions, with the same checks and the same words when
  something's wrong. Paying (Checkout, Stripe's portal) stays in the
  dashboard, for a person.
  """

  alias PresenceRelay.{Apps, Billing, Issuers, Usage}

  @app_id %{type: "string", description: "The app's id: app_ and 16 hex digits."}

  @tools [
    %{
      name: "list_apps",
      title: "List apps",
      description:
        "The account's apps, each with its keys, origins, whether guests may join, and what's left to set up.",
      inputSchema: %{type: "object", properties: %{}},
      annotations: %{readOnlyHint: true}
    },
    %{
      name: "get_app",
      title: "Get an app",
      description:
        "One app: its keys, origins, guests, sign-in provider and room rule, what's left to set up, and how a page connects (the SDK, a snippet with its key).",
      inputSchema: %{type: "object", properties: %{app_id: @app_id}, required: ["app_id"]},
      annotations: %{readOnlyHint: true}
    },
    %{
      name: "create_app",
      title: "Make an app",
      description:
        "Makes an app (one for each product; a second for staging), with a live publishable key. Its server secret is in the answer this once: only an app whose own server signs room tokens needs it, so keep it there, or leave it.",
      inputSchema: %{
        type: "object",
        properties: %{
          name: %{type: "string", description: "1–80 characters."},
          guests: %{
            type: "boolean",
            description: "Whether people may join with just a name, no sign-in. Off unless set."
          }
        },
        required: ["name"]
      },
      annotations: %{readOnlyHint: false, destructiveHint: false, idempotentHint: false}
    },
    %{
      name: "update_app",
      title: "Rename an app, or turn guests on or off",
      description:
        "Changes an app's name, or whether guests (a name, no sign-in) may join its rooms. Guests can join any room and aren't held to the room rule.",
      inputSchema: %{
        type: "object",
        properties: %{app_id: @app_id, name: %{type: "string"}, guests: %{type: "boolean"}},
        required: ["app_id"]
      },
      annotations: %{readOnlyHint: false, destructiveHint: false, idempotentHint: true}
    },
    %{
      name: "add_origin",
      title: "Allow an origin",
      description:
        "Lets the app's publishable keys connect from a site: https://app.example.com (scheme, host, a port if it isn't the usual one, no path). https://*.example.com covers every subdomain but not example.com. Test keys also work from localhost and 127.0.0.1 without one.",
      inputSchema: %{
        type: "object",
        properties: %{app_id: @app_id, origin: %{type: "string"}},
        required: ["app_id", "origin"]
      },
      annotations: %{readOnlyHint: false, destructiveHint: false, idempotentHint: true}
    },
    %{
      name: "remove_origin",
      title: "Remove an origin",
      description: "Stops the app's keys connecting from a site. Pages there stop connecting.",
      inputSchema: %{
        type: "object",
        properties: %{app_id: @app_id, origin: %{type: "string"}},
        required: ["app_id", "origin"]
      },
      annotations: %{readOnlyHint: false, destructiveHint: true, idempotentHint: true}
    },
    %{
      name: "create_key",
      title: "Make a publishable key",
      description:
        "A new publishable key (safe in a page: it only works from the app's origins). A test key also works from localhost, for building.",
      inputSchema: %{
        type: "object",
        properties: %{
          app_id: @app_id,
          mode: %{type: "string", enum: ["live", "test"], description: "live unless set."}
        },
        required: ["app_id"]
      },
      annotations: %{readOnlyHint: false, destructiveHint: false, idempotentHint: false}
    },
    %{
      name: "revoke_key",
      title: "Revoke a publishable key",
      description: "Revokes a key for good: pages using it stop connecting.",
      inputSchema: %{
        type: "object",
        properties: %{
          app_id: @app_id,
          key: %{type: "string", description: "The key: pk_live_… or pk_test_…"}
        },
        required: ["app_id", "key"]
      },
      annotations: %{readOnlyHint: false, destructiveHint: true, idempotentHint: true}
    },
    %{
      name: "set_sign_in",
      title: "Set how people sign in",
      description: """
      Names the sign-in provider the app's people already use, so a page joins rooms with the person's own token (checked against the provider's published keys; no server needed). Replaces any provider set before; keeps the room rule.
      - clerk: issuer is the Frontend API URL (https://….clerk.accounts.dev in development). No audience unless you added one.
      - auth0: issuer is the tenant's domain (acme.us.auth0.com); audience is the API identifier (or the client id for ID tokens), required.
      - firebase: project is the Firebase project id. No audience.
      - supabase: issuer is the project URL (https://<ref>.supabase.co); the project needs asymmetric JWT signing keys. Audience defaults to authenticated.
      - oidc: issuer is exactly the tokens' iss (its /.well-known/openid-configuration is read); audience required.
      name_claim is where the person's name is in the token (name by default; Supabase's user_metadata.full_name); a dotted name looks inside an object.
      """,
      inputSchema: %{
        type: "object",
        properties: %{
          app_id: @app_id,
          provider: %{type: "string", enum: Issuers.providers()},
          issuer: %{type: "string"},
          project: %{type: "string"},
          audience: %{type: "string"},
          name_claim: %{type: "string"}
        },
        required: ["app_id", "provider"]
      },
      annotations: %{readOnlyHint: false, destructiveHint: false, idempotentHint: true}
    },
    %{
      name: "remove_sign_in",
      title: "Stop using the sign-in provider",
      description:
        "Takes the app's sign-in provider (and its room rule) away: signed-in people stop getting in. Guests, if on, still can.",
      inputSchema: %{type: "object", properties: %{app_id: @app_id}, required: ["app_id"]},
      annotations: %{readOnlyHint: false, destructiveHint: true, idempotentHint: true}
    },
    %{
      name: "set_room_rule",
      title: "Set the room rule",
      description:
        "Keeps each signed-in person to their rooms by a claim in their token (the app needs a sign-in provider first). prefix: someone whose claim is acme may join acme:standup and any acme: room, no other. contains: the claim is a list of the rooms they may join. Without a rule anyone signed in can join any room. Guests aren't held to it.",
      inputSchema: %{
        type: "object",
        properties: %{
          app_id: @app_id,
          claim: %{
            type: "string",
            description: "The claim, e.g. org_id (prefix) or rooms (contains)."
          },
          match: %{type: "string", enum: ["prefix", "contains"]}
        },
        required: ["app_id", "claim", "match"]
      },
      annotations: %{readOnlyHint: false, destructiveHint: false, idempotentHint: true}
    },
    %{
      name: "remove_room_rule",
      title: "Remove the room rule",
      description: "Lets anyone signed in join any of the app's rooms.",
      inputSchema: %{type: "object", properties: %{app_id: @app_id}, required: ["app_id"]},
      annotations: %{readOnlyHint: false, destructiveHint: true, idempotentHint: true}
    },
    %{
      name: "get_usage",
      title: "Get an app's usage",
      description:
        "Monthly active users (each person in any of the app's rooms in a month counts once) and call minutes: this month, the last 31 days, the last months, and the cap.",
      inputSchema: %{
        type: "object",
        properties: %{
          app_id: @app_id,
          months: %{
            type: "integer",
            minimum: 1,
            maximum: 24,
            description: "How many months, 3 unless set."
          }
        },
        required: ["app_id"]
      },
      annotations: %{readOnlyHint: true}
    },
    %{
      name: "set_cap",
      title: "Cap monthly active users",
      description:
        "The most people the app may have in a month: past it, people who haven't been in this month can't join until the next. null takes the cap off (the plan's own cap still holds).",
      inputSchema: %{
        type: "object",
        properties: %{app_id: @app_id, active_users: %{type: ["integer", "null"], minimum: 1}},
        required: ["app_id", "active_users"]
      },
      annotations: %{readOnlyHint: false, destructiveHint: false, idempotentHint: true}
    },
    %{
      name: "get_billing",
      title: "Get an app's plan",
      description:
        "The app's plan (Starter or Team), its subscription, the cap that's enforced, the plans' prices, and what this month costs so far. Upgrading and paying happen in the dashboard.",
      inputSchema: %{type: "object", properties: %{app_id: @app_id}, required: ["app_id"]},
      annotations: %{readOnlyHint: true}
    },
    %{
      name: "rotate_secret",
      title: "Make a new server secret",
      description:
        "Replaces the app's server secret (for apps whose own server signs room tokens); the new one is in the answer this once. The old one stops working within a minute, so only do this when asked, with the server ready for the new one.",
      inputSchema: %{type: "object", properties: %{app_id: @app_id}, required: ["app_id"]},
      annotations: %{readOnlyHint: false, destructiveHint: true, idempotentHint: false}
    }
  ]

  @names Enum.map(@tools, & &1.name)

  @doc "What the server tells an agent when it connects."
  def instructions do
    """
    arugula.stream puts people in a web app's rooms as live characters, with text, waves, reactions and calls. Each product is an app: publishable keys (safe in a page, live or test) work only from the app's origins; people get in as themselves through the app's sign-in provider (set_sign_in), or as guests by name. To set an app up: create_app, add_origin for each site its pages are on, set_sign_in (or guests), then paste the snippet get_app gives into the page. Docs: https://arugula.stream/docs
    """
    |> String.trim()
  end

  def tools, do: @tools

  def tool?(name), do: name in @names

  @doc """
  Calls tool `name` for `ctx` (`%{account, base_url}`): `{:ok, result}` (a
  map) or `{:error, message}`, which the agent reads as the tool failing.
  """
  def call(name, args, ctx) when is_map(args), do: run(name, args, ctx)
  def call(name, nil, ctx), do: run(name, %{}, ctx)
  def call(_, _, _), do: {:error, "arguments are an object"}

  defp run("list_apps", _, ctx) do
    {:ok,
     %{
       apps:
         Enum.map(Apps.list(ctx.account), fn app ->
           Map.put(Apps.view(app), :setup, setup(app, issuer_of(app)))
         end)
     }}
  end

  defp run("get_app", args, ctx), do: with_app(args, ctx, &{:ok, full(&1, ctx)})

  defp run("create_app", args, ctx) do
    case Apps.create(ctx.account, Map.take(args, ["name", "guests"])) do
      {:ok, app, secret} ->
        {:ok,
         full(app, ctx)
         |> Map.put(:server_secret, secret)
         |> Map.put(
           :note,
           "The server secret is shown this once. Most apps never need it: keep it on a server that signs room tokens, never in a page."
         )}

      {:error, msg} when is_binary(msg) ->
        {:error, msg}

      {:error, _} ->
        {:error, "couldn't make the app"}
    end
  end

  defp run("update_app", args, ctx) do
    with_app(args, ctx, fn app ->
      cond do
        Map.has_key?(args, "name") and
            not (is_binary(args["name"]) and String.trim(args["name"]) != "" and
                     String.length(args["name"]) <= 80) ->
          {:error, "a name is 1–80 characters"}

        Map.has_key?(args, "guests") and not is_boolean(args["guests"]) ->
          {:error, "guests is true or false"}

        true ->
          {:ok, _} = Apps.update(app, args)
          {:ok, %{app: Apps.view(Apps.get(ctx.account, app.id))}}
      end
    end)
  end

  defp run("add_origin", args, ctx) do
    with_app(args, ctx, fn app ->
      with {:ok, _} <- Apps.add_origin(app, args["origin"]),
           do: {:ok, %{app: Apps.view(Apps.get(ctx.account, app.id))}}
    end)
  end

  defp run("remove_origin", args, ctx) do
    with_app(args, ctx, fn app ->
      with {:ok, _} <- Apps.remove_origin(app, args["origin"]),
           do: {:ok, %{app: Apps.view(Apps.get(ctx.account, app.id))}}
    end)
  end

  defp run("create_key", args, ctx) do
    with_app(args, ctx, fn app ->
      with {:ok, key} <- Apps.make_key(app, args["mode"] || "live"),
           do: {:ok, %{key: Apps.key_view(key)}}
    end)
  end

  defp run("revoke_key", args, ctx) do
    with_app(args, ctx, fn app ->
      case Apps.revoke_key(app, args["key"]) do
        :ok -> {:ok, %{revoked: args["key"]}}
        {:error, :not_found} -> {:error, "no such key (or it's revoked already)"}
      end
    end)
  end

  defp run("set_sign_in", args, ctx) do
    with_app(args, ctx, fn app ->
      rule = with %{} = i <- Issuers.view(issuer_of(app)), do: i.room_rule

      params =
        args
        |> Map.take(~w(provider issuer project audience name_claim))
        |> Map.put("room_rule", stringify(rule))

      with {:ok, i} <- Issuers.put(app, params), do: {:ok, %{sign_in: Issuers.view(i)}}
    end)
  end

  defp run("remove_sign_in", args, ctx) do
    with_app(args, ctx, fn app ->
      :ok = Issuers.delete(app)
      {:ok, %{sign_in: nil}}
    end)
  end

  defp run("set_room_rule", args, ctx),
    do: put_rule(args, ctx, %{"claim" => args["claim"], "match" => args["match"]})

  defp run("remove_room_rule", args, ctx), do: put_rule(args, ctx, nil)

  defp run("get_usage", args, ctx) do
    with_app(args, ctx, fn app ->
      case args["months"] || 3 do
        n when is_integer(n) and n in 1..24 -> {:ok, Usage.report(app, n)}
        _ -> {:error, "months is 1–24"}
      end
    end)
  end

  defp run("set_cap", args, ctx) do
    with_app(args, ctx, fn app ->
      case Map.fetch(args, "active_users") do
        :error ->
          {:error, "send active_users: a whole number, or null"}

        {:ok, cap} ->
          case Usage.put_cap(app, cap) do
            {:ok, app} -> {:ok, %{cap: %{active_users: Usage.cap(app)}}}
            {:error, msg} when is_binary(msg) -> {:error, msg}
            {:error, _} -> {:error, "couldn't set the cap"}
          end
      end
    end)
  end

  defp run("get_billing", args, ctx) do
    with_app(args, ctx, fn app ->
      {:ok, Billing.view(app) |> Map.put(:dashboard, dashboard(app, ctx) <> "/billing")}
    end)
  end

  defp run("rotate_secret", args, ctx) do
    with_app(args, ctx, fn app ->
      {:ok, secret} = Apps.rotate_secret(app)

      {:ok,
       %{
         server_secret: secret,
         note: "Shown this once. The old secret stops working within a minute."
       }}
    end)
  end

  defp put_rule(args, ctx, rule) do
    with_app(args, ctx, fn app ->
      case Issuers.view(issuer_of(app)) do
        nil ->
          {:error,
           "set the app's sign-in provider first (set_sign_in): a room rule reads its tokens"}

        i ->
          params =
            %{
              "provider" => i.provider,
              "issuer" => i.issuer,
              "project" => i.project,
              "name_claim" => i.name_claim
            }
            |> then(
              &if(i.provider != "firebase", do: Map.put(&1, "audience", i.audience), else: &1)
            )
            |> Map.reject(fn {_, v} -> is_nil(v) end)
            |> Map.put("room_rule", rule)

          with {:ok, i} <- Issuers.put(app, params), do: {:ok, %{sign_in: Issuers.view(i)}}
      end
    end)
  end

  defp stringify(nil), do: nil
  defp stringify(%{claim: c, match: m}), do: %{"claim" => c, "match" => m}

  defp with_app(%{"app_id" => id}, ctx, fun) when is_binary(id) do
    case Apps.get(ctx.account, id) do
      nil -> {:error, "no such app (or it isn't this account's): list_apps has them"}
      app -> fun.(app)
    end
  end

  defp with_app(_, _, _), do: {:error, "send app_id: list_apps has them"}

  defp issuer_of(app), do: Issuers.get(app)

  # The app with everything get_app shows.
  defp full(app, ctx) do
    issuer = issuer_of(app)

    %{
      app: Apps.view(app),
      sign_in: Issuers.view(issuer),
      setup: setup(app, issuer),
      connect: connect(app, issuer, ctx),
      dashboard: dashboard(app, ctx)
    }
  end

  # What's done and what's left, in the order the dashboard's overview has it.
  defp setup(app, issuer) do
    keys = Enum.reject(app.keys, & &1.revoked_at)
    live = Enum.any?(keys, &(&1.mode == "live"))

    left =
      [
        keys == [] && "make a key (create_key)",
        app.origins == [] && live &&
          "allow the site its pages are on (add_origin): live keys only connect from the app's origins",
        (is_nil(issuer) and not app.guests) &&
          "set how people sign in (set_sign_in), or turn guests on (update_app)"
      ]
      |> Enum.filter(& &1)

    %{ready: left == [], left: left}
  end

  # Where a page's token comes from, as the docs have it
  # (demo/src/snippets.ts's providers).
  @auth %{
    "clerk" => "() => window.Clerk.session.getToken()",
    "auth0" => "() => auth0.getTokenSilently()",
    "firebase" => "() => getAuth().currentUser.getIdToken()",
    "supabase" => "async () => (await supabase.auth.getSession()).data.session.access_token",
    "oidc" => "async () => (await userManager.getUser()).id_token"
  }

  # How a page connects: the SDK, this relay's socket off arugula.stream,
  # and the docs' snippets with a key of the app's (a test key first: it
  # works from localhost too), signed in or as a guest.
  defp connect(app, issuer, ctx) do
    keys = Enum.reject(app.keys, & &1.revoked_at)
    key = Enum.find(keys, &(&1.mode == "test")) || List.first(keys)
    k = if key, do: key.key, else: "pk_…"
    sdk = ctx.base_url <> "/sdk/v0/presence.js"

    socket =
      if URI.parse(ctx.base_url).host != "arugula.stream",
        do: String.replace(ctx.base_url, ~r/^http/, "ws") <> "/socket"

    who =
      if issuer,
        do: ~s|  auth: #{@auth[issuer.provider]},   // fresh on every reconnect|,
        else: ~s|  guest: "<their name>",|

    %{
      sdk: sdk,
      relay: socket,
      key: key && key.key,
      javascript:
        Enum.join(
          [
            ~s|import { connect } from "#{sdk}";\n|,
            "const room = await connect({",
            ~s|  room: "design-team",|,
            ~s|  key: "#{k}",|,
            socket && ~s|  relay: "#{socket}",|,
            who,
            "});",
            ~s|room.mount(document.querySelector("#people"));|
          ]
          |> Enum.filter(& &1),
          "\n"
        ),
      docs: "https://arugula.stream/docs#sign-in",
      note:
        if(issuer,
          do:
            "auth hands over the signed-in person's #{issuer.provider} token. The docs have the script-tag and React forms.",
          else:
            "Without a sign-in provider, people join as guests by name, which needs guests on (update_app)."
        )
    }
  end

  defp dashboard(app, ctx), do: ctx.base_url <> "/dashboard/apps/" <> app.id
end
