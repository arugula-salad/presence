# Running arugula.stream's relay

How the hosted relay is kept safe and watched (#318's P12): its abuse
limits, its metrics and alerts, its backups, and how much load it holds.
Everything here is relative to the repo root; commands run from there.

## Abuse limits

`PresenceRelay.Limits` (relay/lib/presence_relay/limits.ex) and
PROTOCOL.md's "Abuse limits". The numbers live in
`relay/config/config.exs`:

| limit | per | default | over it |
|---|---|---|---|
| `socket_connect` | client IP | 120 a minute | the WebSocket upgrade is a 429 with `Retry-After` |
| `email_ip` | client IP | 10 an hour | `POST /api/v1/auth/email` is a 429 |
| `email_address` | address | 5 an hour | no mail, and the answer still says `{sent: true}` |
| `meet_room` | client IP | 20 an hour | `POST /api/v1/meet/rooms` is a 429 |
| `api_write` | client IP | 120 a minute | any POST/PUT/PATCH/DELETE under `/api/v1` is a 429 |
| `demo_token` | client IP | 120 an hour | `POST /api/demo/token` is a 429 |
| app connections | app | 2,000 at once | the join is refused: "this app has too many connections" |

Change them without a deploy of code, as Fly secrets or `[env]`:

- `RATE_LIMITS="socket_connect=600/60,demo_token=off"`: any of the
  per-IP limits, `name=hits/seconds` or `name=off`.
- `APP_MAX_CONNECTIONS=5000`: every app's cap; `APP_CONNECTIONS="meet:10000,app_x:off"`:
  one app's.

How they count:

- **Per node.** Each machine counts in its own ETS table (fixed windows,
  one atomic counter a key), so a client spread over N machines could
  get N times a limit. Fly's proxy mostly sends a client to the same
  nearby machine, and even N× is a ceiling an abuser meets at once.
- **The app cap is cluster-wide**, from a `:pg` group per app, so as
  eventually consistent as the room caps: two machines admitting the
  last connection at the same instant could both let it in.
- **The client IP** is `Fly-Client-IP` on Fly (trusted only when
  `FLY_APP_NAME` is set, which Fly sets), otherwise the peer address. The
  socket can't see headers in `connect/3`, so the endpoint notes the IP
  first (`PresenceRelayWeb.ClientIP`).

## Metrics

`GET /metrics` on port 9091 (`METRICS_PORT`), Prometheus' text format,
from a small exporter of our own (`PresenceRelay.Metrics`: no new deps;
what it counts already arrives as telemetry, and the gauges are read at
scrape time). No Fly service exposes 9091; Fly's `[metrics]` section in
`fly.toml` and `fly.staging.toml` has Fly scrape it into its managed
Prometheus, labelled `app`, `instance` and `region`. See it
in Grafana at https://fly-metrics.net (Fly dashboard → Metrics).

| metric | what |
|---|---|
| `presence_connections` | this machine's room connections (sum across instances) |
| `presence_rooms`, `presence_members` | the cluster's (every node sees the same: take the max) |
| `presence_frames_total{result}` | frames in: `relayed`, `too_big`, `too_soon` (`rate()`: frames/s) |
| `presence_frame_bytes_total` | bytes relayed, before fan-out |
| `presence_messages_total{kind,result}` | say, react, wave, answer; kept or dropped |
| `presence_socket_connects_total{result}` | sockets admitted or refused |
| `presence_joins_total`, `presence_joins_refused_total{reason}` | `token`, `origin`, `guest`, `rate`, `cap`, `room_full`, `connections`, `app_connections`, `wrong_room` |
| `presence_calls_active`, `presence_call_participants` | calls now (cluster) |
| `presence_calls_started_total`, `presence_call_seconds_total` | calls begun; person-seconds in calls (÷ 60: call minutes) |
| `presence_rate_limited_total{limit}` | hits over an abuse limit |
| `presence_http_requests_total{status}`, `presence_http_request_seconds` | HTTP by status class; latency histogram |
| `presence_db_query_seconds`, `presence_db_queue_seconds` | Postgres query time; time waiting for a pooled connection |
| `presence_db_pool_size`, `_ready`, `_queue` | the pool now |
| `presence_usage_unflushed_seconds`, `presence_usage_kept`, `presence_usage_flush_seconds` | usage metering's buffer: seconds since a flush left nothing behind (grows while Postgres refuses writes), what it kept, flush time |
| `presence_cluster_nodes` | nodes this one sees |
| `presence_beam_scheduler_utilization` | the share of the schedulers' time spent working (real CPU, without spin) |
| `presence_beam_memory_bytes{kind}`, `_processes`, `_ports`, `_atoms`, `_run_queue`, `_schedulers`, `_reductions_total`, `_uptime_seconds` | the BEAM's basics |

**The dashboard**: `ops/grafana/relay.json`. In fly-metrics.net:
Dashboards → New → Import → upload the file → pick the Prometheus data
source → Import. Its `app` picker switches between `arugula-stream` and
`arugula-stream-staging`.

## Logs

In prod each line is one JSON object (`PresenceRelay.LogFormatter`):
`time`, `level`, `msg`, `source`, and `request_id` and `app` where there
are ones. Messages are scrubbed of email addresses, JWTs, publishable and
secret keys, the magic link's token, credential query parameters, bearer
tokens and database passwords; Phoenix's own lines filter the same
parameters. Search them with `fly logs -a arugula-stream | grep '"level":"error"'`.
`LOG_LEVEL=warning` quiets the request lines.

## Health and alerts

- `GET /healthz`: up (Fly's machine check, every 15 s; a dead machine
  is restarted and taken out of routing).
- `GET /healthz?db=1`: Postgres answers (P1's).
- `GET /healthz?deep=1`: JSON of every deep check (Postgres within 2 s;
  usage flushed clean within 2 minutes), 503 if any fails.

**The watchdog** (`PresenceRelay.Watchdog`) is the alert path: every
minute the cluster's first node asks every node for its deep health, and
after 3 failures in a row mails `hello@arugula.stream` (`ALERT_EMAIL`)
through the relay's own Resend mailer, again every 6 hours while it
lasts, and once when all's well. No new service, nothing to click,
**as long as** the app has `RESEND_API_KEY` (and `MAIL_FROM` on a domain
Resend has verified) and someone reads hello@arugula.stream. Without a
key it only logs `watchdog: …` warnings.

What it can't see is the whole app down. For that, one Grafana alert
(Jake, once, in fly-metrics.net):

1. Alerting → Contact points → New: type Email, address
   hello@arugula.stream. (If Fly's Grafana won't send email, skip this
   alert: Fly restarts dead machines, and an outage of every machine
   shows on Fly's own status emails for the app.)
2. Alerting → Alert rules → New: query
   `count(up{app="arugula-stream"} == 1) or vector(0)`, condition
   "is below 1", evaluate every 1m for 5m, labels `severity=page`,
   contact point the one above. Save.

## Backups

### Managed Postgres's own

The database is the Managed Postgres cluster `arugula-stream-db`
(id `nlkxjo5pdkd0y93v`, iad). Fly backs every MPG cluster up and keeps a
point-in-time-recovery (PITR) window; restores go **into a new cluster**
(the source is never touched), billed as a cluster of its own.

```sh
fly mpg backup list nlkxjo5pdkd0y93v --all     # full / incr / diff backups, with times and sizes
fly mpg backup create nlkxjo5pdkd0y93v         # a full backup now (before a risky migration)
fly mpg restore nlkxjo5pdkd0y93v --backup-id <id> --name arugula-stream-db-restore
fly mpg restore nlkxjo5pdkd0y93v --pitr-time 2026-11-02T14:05:00Z --name arugula-stream-db-pitr
fly mpg status <new cluster id>                # creating → initializing → ready
```

Fly's docs don't state the PITR window or how long backups are kept:
`fly mpg backup list --all` shows the oldest backup, and a `--pitr-time`
outside the window is refused (HTTP 422), which is how to find its edge.

**A real restore** (data lost or corrupted). Our data is small, so the
time is mostly the new cluster provisioning; nobody has timed one yet
(a guess: half an hour end to end), so time the first and write it here:

1. Pick the moment: just before the damage (`fly logs`, the deploy
   time, `presence_db_*` in Grafana).
2. `fly mpg restore … --pitr-time <moment>` (or `--backup-id`); wait for
   `ready` in `fly mpg status`.
3. Check the copy with the drill below, `SOURCE_URL` pointed at the new
   cluster through `fly mpg proxy <new id>`: it proves the dump/restore
   path and shows the row counts to eyeball.
4. Switch the app: `fly mpg detach <old id> -a arugula-stream`, then
   `fly mpg attach <new id> -a arugula-stream` (sets `DATABASE_URL`;
   the machines restart, and `release_command` runs migrations).
5. `curl https://arugula.stream/healthz?deep=1` → `"ok": true`.
6. What's lost: writes after the restore point (sign-ups, apps, keys,
   messages, a few minutes of usage). Usage that's still in a node's
   buffer is written to whichever database the node has at its next
   flush.
7. Keep the old cluster a few days for anything to copy back, then
   `fly mpg destroy <old id>`.

### The drill: `ops/backup-drill.sh`

Proves we can get the data out and back: pg_dump the database, restore
it into a scratch database, compare, drop the scratch database. The
script's header lists its variables. The source is only read, in one
exported snapshot that pg_dump dumps too, so a live database can't make
a false difference. It checks: the same tables; each table's row count
and a checksum of all its rows; the same constraints and indexes; every
sequence at or past its column's maximum; the last migration; no orphan
rows; usage days agreeing with usage members. Exit 0 when all pass.

Locally (done for P12, 2026-10-29: 13 tables, ~31k rows, all checks
passed; ~1 s each way):

```sh
psql postgres://postgres:postgres@127.0.0.1:55432/presence_dev -f ops/drill-seed.sql   # made-up data
SOURCE_URL=postgres://postgres:postgres@127.0.0.1:55432/presence_dev \
SCRATCH_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  ops/backup-drill.sh
```

**Against staging** (nothing is written to staging; the scratch copy is
a throwaway local container):

```sh
# 1. A scratch Postgres on this machine.
docker run -d --rm --name presence-drill-pg -e POSTGRES_PASSWORD=drill -p 127.0.0.1:55499:5432 postgres:17
# 2. Staging's database on localhost:16380 (leave it running).
fly mpg proxy nlkxjo5pdkd0y93v &
# 3. Staging's credentials, from its DATABASE_URL (don't paste it anywhere):
fly ssh console -a arugula-stream-staging -C 'printenv DATABASE_URL'
#    → postgres://USER:PASSWORD@HOST/presence_staging?…: keep USER and PASSWORD.
# 4. The drill (PG_DOCKER: the tools match the server's major version).
SOURCE_URL='postgres://USER:PASSWORD@127.0.0.1:16380/presence_staging?sslmode=disable' \
SCRATCH_ADMIN_URL=postgres://postgres:drill@127.0.0.1:55499/postgres \
PG_DOCKER=postgres:17 \
  ops/backup-drill.sh
# 5. Clean up.
kill %1; docker stop presence-drill-pg
```

If the proxy goes through PgBouncer and the snapshot can't be exported
(the drill stops at "couldn't export a snapshot"), run step 4 against
the cluster's direct address instead; `fly mpg status` lists it. Run the
drill every quarter, and after any change to the schema or to Fly's
Postgres.

## Load

`ops/load/probe.mjs` (Node 24, no packages): N rooms × M members as real
WebSocket clients speaking the protocol. Each sends a rig-sized frame
(32 bytes) every 83 ms (the client's 12 frames a second; the relay allows
one per 70 ms on average, with a burst of 3), a text message about every
20 s, a reaction every 10 s and a wave every 30 s, and measures fan-out
latency (sent → heard by each other member: p50/p95/p99/max), frames
missing (gaps in each sender's sequence numbers), say round trips, and
errors. `--help` lists the options.

Frames missing come in two kinds, which it counts apart: **dropped by
the relay on the way in** (every receiver on the probe's machine missed
that frame: over the member's rate, or shed while the node was short of
CPU) and **lost after fan-out** (only some receivers missed it: a socket
that fell behind or closed). A WebSocket is TCP, so nothing is lost on
the wire; the first kind is the relay's decision, the second is trouble.
`--metrics URL,URL,…` (one per node) reads the relay's own counts before
and after: the first kind should be about `too_soon` + `shed` times
the receivers each frame has on the probe's machine.

Team scale is 10 rooms × 8; 10× is 100 rooms × 8 (800 clients).

### Local results (P12, 2026-10-29)

On a 32-thread workstation, the relay in prod mode, the probe on the
same machine, Postgres shared (pool of 4):

| load | frames in/out per s | fan-out p50 / p95 / p99 | missing | say p99 | relay CPU (busy schedulers) | BEAM memory |
|---|---|---|---|---|---|---|
| 1×: 10 × 8 = 80 | 962 / 6.7k | 0.3 / 0.6 / 1.1 ms | 0 | 7 ms | ~0.2 | ~92 MB |
| 10×: 100 × 8 = 800 | 9.6k / 67k | 0.2 / 0.6 / 0.9 ms | 0.004% (too-soon drops) | 7 ms | ~2.5 | ~340 MB |
| 20×: 200 × 8 = 1,600 | 19k / 135k | 0.3 / 0.8 / 1.4 ms | 0.012% | 6 ms | ~5.3 | ~510 MB |
| 40×: 400 × 8 = 3,200 | 38k / 269k | 0.3 / 1.4 / 8.6 ms | 0.39% (too-soon drops) | 20 ms | ~13 | ~1.07 GB |

With one scheduler (`ERL_FLAGS="+S 1:1"`, roughly one dedicated vCPU):

| load | busy | fan-out p50 / p95 / p99 | missing | BEAM memory |
|---|---|---|---|---|
| 80 | 8% | 0.3 / 0.7 / 1.1 ms | 0 | 92 MB |
| 400 | 40% | 0.9 / 2.9 / 4.0 ms | 0 | 185 MB |
| 800 | 90% (saturated) | 9.9 / 54 / 105 ms | 3.7% (too-soon drops from queueing) | 311 MB |

Every "missing" frame above matches the relay's own too-soon drops (two
frames arriving under 70 ms apart, from jitter or queueing), so fan-out
itself lost nothing.

What that meant for Fly was wrong: those runs had no CPU quota and no
network between the probe and the relay. See the next section.

### Staging-like, locally (2026-10-29)

Staging fell apart at light load while a local run held, because a
local run has neither of staging's two conditions: a CPU quota and a
real network. `ops/load/rig.sh` puts both on this machine:

- relay nodes in Docker from the release image, each on one CPU (a Fly
  machine has one vCPU, so one scheduler) with a quota on it
  (`--cpus=0.25`, or `5000/80000`: Fly's `shared-cpu-1x` baseline, 5 ms
  of every 80 ms) and 512 MB, clustered;
- Toxiproxy in front of each node's WebSocket port, 25 ms ± 15 ms each
  way (jitter is what bunches a client's frames), and in front of each
  node's Postgres, a 2 ms or 75 ms round trip (same region, or lhr to
  iad);
- the probe run against every node at once, each room's members split
  across them, reading every node's /metrics.

```sh
docker build -f relay/Dockerfile -t presence-relay .
ops/load/rig.sh up presence-relay 0.25 2 2          # image, CPU, nodes, Postgres ms ("2,75": node 2 far)
ops/load/rig.sh probe team 10 4                     # 10 rooms × (4 + 4) members
ops/load/rig.sh probe tenx 100 4 60 30              # 10×: 800 clients
ops/load/rig.sh down
```

Before (a579b6a) and after the fixes below, two nodes, the network as
above, Postgres 2 ms unless it says; fan-out p50 / p95 / p99
includes the injected ~50 ms (25 ± 15 each way):

| run | CPU a node | joined | missing (relay drops) | fan-out p50 / p95 / p99 | say p50 / p99 | join p95 |
|---|---|---|---|---|---|---|
| 1× (80) before | 0.25 | 80/80 | 15.1% (all too soon) | 54 / 72 / 76 ms | 62 / 87 ms | 200 ms |
| 1× after | 0.25 | 80/80 | **0%** | 53 / 71 / 76 ms | 63 / 85 ms | 195 ms |
| 1× before | 0.125 | 80/80 | 15.1% (all too soon) | 54 / 72 / 76 ms | 63 / 85 ms | 198 ms |
| 1× after | 0.125 | 80/80 | **0%** | 53 / 71 / 76 ms | 62 / 86 ms | 203 ms |
| 1× before | 5 ms/80 ms | 80/80 | 15.4% | 55 / 74 / 95 ms | 62 / 108 ms | 207 ms |
| 1× after | 5 ms/80 ms | 80/80 | 1.0% (shed) | 54 / 76 / 91 ms | 66 / 113 ms | 219 ms |
| 1×, all on one node, before | 5 ms/80 ms | 80/80 | 32.7% | 315 / 614 / 774 ms | 434 / 945 ms | 6.7 s |
| 1×, all on one node, after | 5 ms/80 ms | 80/80 | 64% (shed) | 64 / 156 / 276 ms | 69 / 512 ms | 251 ms |
| 10× (800) before | 1 | 800/800 | 15.0% (all too soon) | 54 / 72 / 76 ms | 60 / 84 ms | 193 ms |
| 10× after | 1 | 800/800 | **0%** | 54 / 75 / 82 ms | 67 / 106 ms | 192 ms |
| 10× after | 0.75 | 800/800 | **0%** | 54 / 75 / 99 ms | 65 / 325 ms | 189 ms |
| 10× before | 0.25 | 721/800 (79 joins failed) | 61% | 600 ms / 1.5 s / 5.3 s | 915 ms / >10 s | >10 s |
| 10× after | 0.25 | 800/800 | 81% (shed) | 126 / 404 / 516 ms | 124 / 1231 ms | 817 ms |
| 10× before | 5 ms/80 ms | 284/800 (516 failed) | 78% | 962 ms / >10 s / >10 s | >10 s | >10 s |
| 10×, node 2's Postgres 75 ms, before | 1 | 800/800 | 15.3% | 54 / 73 / 116 ms | 207 / 232 ms | 197 ms |
| 10×, node 2's Postgres 75 ms, after | 1 | 800/800 | **0%** | 56 / 77 / 85 ms | 312 / 411 ms | 193 ms |
| 10×, both nodes' Postgres 75 ms, after | 1 | 800/800 | **0%** | 53 / 73 / 78 ms | 291 / 399 ms | 190 ms |
| 10×, node 2's 75 ms, a say every 5 s, before | 1 | 800/800 | 18.4%; 978 says refused | 56 / 283 / 736 ms | 380 / 1479 ms | 194 ms |
| 10×, node 2's 75 ms, a say every 5 s, after | 1 | 800/800 | **0%**; none refused | 53 / 72 / 77 ms | 290 / 377 ms | 194 ms |
| 10×, node 2's 75 ms, before | 0.25 | 707/800 (93 failed) | 59% | 664 ms / 1.5 s / 5.8 s | 894 ms / >10 s | >10 s |
| 10×, node 2's 75 ms, after | 0.25 | 800/800 | 79% (shed) | 105 / 405 / 523 ms | 400 / 1237 ms | 721 ms |

No socket closed early in any "after" run; every "closed early" before was
a failed join (the probe closes its socket). Memory stayed under 260 MB a
node throughout (400 connections each).

What was wrong, each found in those runs:

1. **The 70 ms floor dropped frames the network bunched.** At full CPU
   and no load to speak of, 15% of frames went missing, every one a
   relay `too_soon` (missed by every receiver): a client sending every
   83 ms has its frames delivered 53–113 ms apart through 25 ± 15 ms of
   jitter. Now a token bucket (3 frames, one more every 70 ms): 0%.
2. **CPU.** 10× team scale needs about 60% of a core per node (on this
   machine's Zen 5 at 5 GHz; Fly's EPYC cores are slower). At 5 ms in
   80 ms, even 1× on one node (staging's own 1× numbers: 43% missing,
   p50 291 ms) queues: every socket's mailbox fills, fan-out goes to
   seconds, and at 10× joins time out waiting on `Rooms` (5 s) and fail
   (284 of 800 joined; staging: 248). Frames now go straight from the
   room's topic to each socket (`PresenceRelay.Fanout`, encoded once), and
   a node short of CPU sheds frames instead of queueing them
   (`PresenceRelay.Load`): fewer frames a second, on time, rather than
   every frame late.
3. **Postgres on the channel's clock.** A joiner's history and each
   `say` were queries in the room channel's own process, so while one
   waited on the pool that connection's frames waited too; and one insert
   a message held a pooled connection for a round trip or two. With
   node 2's database 75 ms away and the room talking (a message per
   member every 5 s), node 2 logged "connection not available and request
   was dropped from queue" (DBConnection's default queue target is
   50 ms), refused 978 messages, and fan-out p99 rose to 736 ms. Now
   history and text are tasks off the channel, a node's messages go to
   Postgres in batches (`Chat.Writer`: one connection however many), and
   the pool's queue target is 500 ms (`POOL_QUEUE_TARGET_MS`).

What it means for Fly:

- **10× needs about 60–65% of a core a node** here (two nodes, 400
  connections each, 12 frames a second): at 0.75 CPU it holds with
  nothing missing, at 0.5 it sheds 46%. Fly's cores are slower than this
  machine's, so count on most of a core. A `shared-cpu-1x` gets 6.25% of
  one past its burst balance (which starts at 5 s and refills only
  while it's under that): **it can't hold 10×**, and no change in the
  relay makes it (receiving the frames alone, before any are sent on,
  costs more than its share; locally even maximum shedding left joins
  failing there). It holds 1× team scale split over two machines, just
  (6% of its 6.25%); all 80 on one machine, it sheds most frames. The
  `shared-cpu-2x` that staging and production run now gets twice that
  (10 ms of every 80 ms, 12.5% of a core, shared by its two vCPUs):
  enough for 1× on one machine, still a fifth of what 10× needs.
- For 10× on two machines: **`performance-1x`** (a whole core
  each, ~60–90% busy at 10×) or, for headroom, `performance-2x` (BEAM
  uses both cores). Memory is not the limit (under 260 MB at 400
  connections), but performance machines come with 2 GB anyway.
- `POOL_SIZE=10` is enough now that a node's text is one connection
  (`Chat.Writer`) and nothing on a join's path queries; the queue target
  is 500 ms by default (`POOL_QUEUE_TARGET_MS`).
- Watch `presence_frame_gap_stretch` (above 1: the node is shedding) and
  `presence_frames_total{result="shed"}` beside `too_soon`.

### Staging, from two regions at once

1. Lift staging's per-IP limits for the run (the probe's clients share
   one IP each), and allow enough connections:

   ```sh
   fly secrets set -a arugula-stream-staging RATE_LIMITS="socket_connect=100000/60,demo_token=100000/3600"
   ```

2. On each machine (say one in the US east, one in Europe), the same
   rooms, half the members each, starting together:

   ```sh
   START=$(date -u -d '+2 min' +%s)000     # agree on it, then on both:
   node ops/load/probe.mjs --url https://arugula-stream-staging.fly.dev \
     --rooms 100 --members 4 --prefix p12-$START --start-at $START \
     --duration 120 --ramp 30 --id us        # --id eu on the other
   ```

   Each prints its own summary. "Same machine" latency is exact;
   "other machines" is by wall clock (check both clocks: `chronyc
   tracking` or `timedatectl`), and includes the hop between the Fly
   regions the two clients landed in.

3. Watch the Grafana dashboard during the run (scheduler utilization,
   memory, frames too soon, pool wait).
4. Put the limits back: `fly secrets unset -a arugula-stream-staging RATE_LIMITS`.

Done when: 10× (100 rooms × 8) holds: every client connected, no
channel errors or sockets closed early, frames missing near 0 (the
probe's "dropped by the relay" line is `too_soon` and `shed`; "lost after
fan-out" should be 0), fan-out p99 within a frame (83 ms) beyond the
network's own latency, and both machines' memory under their limit. On
a `shared-cpu` machine expect 10× to shed most frames (see above):
that's the machine size, not a fault.
