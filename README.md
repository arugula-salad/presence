# arugula.stream

Live presence for your app: people show up as characters that move with
them, or as live line drawings of their faces, drawn from each person's
camera in their own browser. About twenty bytes a frame leave it; no
picture ever does. Text, waves and reactions ride along, and a wave can
turn into a voice or video call.

The hosted service is at [arugula.stream](https://arugula.stream), with a
[setup guide](https://arugula.stream/developers) and
[docs](https://arugula.stream/docs). meet.arugula.stream is our own app on
the protocol. Everything here is open source, so you can also run it
yourself.

## What's here

| | |
|---|---|
| [`PROTOCOL.md`](PROTOCOL.md) | the wire protocol: rooms, frames, waves, reactions, text, calls |
| [`core/`](core) | outline and rig encoding, the characters, the trackers' glue |
| [`client/`](client) | `@arugula/presence`: a room as state, over a transport |
| [`elements/`](elements) | web components and `connect()`, the script-tag SDK |
| [`react/`](react) | `@arugula/presence-react` |
| [`relay/`](relay) | the Phoenix relay: rooms, accounts, apps and keys, calls on LiveKit, metering, billing on Stripe |
| [`demo/`](demo) | the arugula.stream site |
| [`meet/`](meet) | meet.arugula.stream |
| [`dashboard/`](dashboard) | the customer dashboard at /dashboard |
| [`sdk/`](sdk) | room-token SDKs for Node, Python, Go, Elixir and Ruby ([`sdk/API.md`](sdk/API.md)) |
| [`ops/`](ops) | abuse limits, metrics and alerts, the backup drill, the load probe |

## Run it

The relay needs Postgres for accounts, messages and usage (it runs
without one too, as a bare relay):

```sh
docker run -d -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=postgres postgres:17
cd relay && mise exec -- mix deps.get && DEMO=1 mise exec -- mix phx.server
```

Each TypeScript package has its own lockfile; install `core` and `client`
first, since the others link them. [`relay/README.md`](relay/README.md)
covers the environment, the sites and deploying.

## Deploying

Two Fly apps, built from the repo root with `relay/Dockerfile`:
`fly deploy -c fly.staging.toml` for staging
(arugula-stream-staging.fly.dev) and `fly deploy` for production
(arugula.stream).

## License

MIT or Apache-2.0, at your option.
