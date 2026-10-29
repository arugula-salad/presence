#!/bin/bash
# A staging-like relay on this machine, for the load probe (README.md,
# "Staging-like, locally"): relay nodes in Docker held to part of a CPU
# and 512 MB as a Fly machine is, clustered, with Toxiproxy putting a
# real network's latency and jitter on the WebSocket path and a
# database's distance on Postgres.
#
#   ops/load/rig.sh up IMAGE CPUS NODES PG_LATENCY_MS [POOL_SIZE]
#   ops/load/rig.sh probe NAME ROOMS MEMBERS_PER_NODE [DURATION] [RAMP] [probe options…]
#   ops/load/rig.sh down
#
# IMAGE: the relay's image (docker build -f relay/Dockerfile -t presence-relay .).
# CPUS: a share of one core (0.25), or quota/period in µs: 5000/80000 is a
#   Fly shared-cpu-1x past its burst balance (5 ms of every 80 ms).
# PG_LATENCY_MS: a round trip added to each node's Postgres, one for all
#   ("2": same region) or one a node ("2,75": node 2 across the Atlantic).
# probe: runs ops/load/probe.mjs against every node at once, the members
#   of each room split across them (as Fly's proxy spreads clients), with
#   every node's /metrics.
#
# Postgres is RIG_PG (a container on Docker's default bridge, default
# presence-pg) and its database RIG_DB (default presence_rig, which must
# exist and be migrated: `up` migrates it). Ports from RIG_PORT (default
# 4300): node n's WebSocket at RIG_PORT+n-1, its /metrics at
# RIG_PORT+NODES+n-1, Toxiproxy's API at RIG_PORT+2×NODES. Containers are
# named with RIG_NAME (default rig).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
NAME=${RIG_NAME:-rig}
PORT=${RIG_PORT:-4300}
PG=${RIG_PG:-presence-pg}
DB=${RIG_DB:-presence_rig}
NET=presence-$NAME
TOXI=toxiproxy-$NAME
STATE=${TMPDIR:-/tmp}/presence-$NAME.nodes

relays() { docker ps -a --format '{{.Names}}' | grep -E "^relay-$NAME-[0-9]+$" || true; }

down() {
  for c in $(relays) $TOXI; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  docker network rm "$NET" >/dev/null 2>&1 || true
}

toxic() { # proxy, name, stream, latency, jitter
  curl -sf -X POST "$API/proxies/$1/toxics" -H 'content-type: application/json' \
    -d "{\"name\":\"$2\",\"type\":\"latency\",\"stream\":\"$3\",\"attributes\":{\"latency\":$4,\"jitter\":$5}}" >/dev/null
}

up() {
  local image=$1 cpus=$2 nodes=$3 pglat=$4 pool=${5:-10}
  local pgip cookie secret demo n
  API=http://127.0.0.1:$((PORT + 2 * nodes))
  pgip=$(docker inspect "$PG" --format '{{.NetworkSettings.Networks.bridge.IPAddress}}')
  down
  docker network create "$NET" >/dev/null
  local ports=()
  for n in $(seq 1 "$nodes"); do ports+=(-p "127.0.0.1:$((PORT + n - 1)):$((4000 + n))"); done
  docker run -d --name "$TOXI" --network "$NET" "${ports[@]}" -p "127.0.0.1:$((PORT + 2 * nodes)):8474" \
    ghcr.io/shopify/toxiproxy:2.12.0 >/dev/null
  # Toxiproxy reaches Postgres on the default bridge.
  docker network connect bridge "$TOXI"
  for _ in $(seq 1 30); do curl -sf "$API/version" >/dev/null && break; sleep 0.3; done

  # The database, migrated (straight to Postgres, no latency).
  docker exec "$PG" createdb -U postgres "$DB" 2>/dev/null || true
  docker run --rm -e "DATABASE_URL=postgres://postgres:postgres@$pgip:5432/$DB" \
    -e SECRET_KEY_BASE="$(openssl rand -hex 48)" "$image" \
    /app/bin/presence_relay eval 'PresenceRelay.Release.migrate()' >/dev/null

  local cpuflags=(--cpus="$cpus")
  case "$cpus" in */*) cpuflags=(--cpu-quota="${cpus%/*}" --cpu-period="${cpus#*/}") ;; esac
  IFS=, read -ra lats <<< "$pglat"
  cookie=$(openssl rand -hex 16)
  secret=$(openssl rand -hex 48)
  demo=$(openssl rand -hex 32)

  for n in $(seq 1 "$nodes"); do
    local lat=${lats[$((n - 1))]:-${lats[0]}}
    curl -sf -X POST "$API/proxies" -d "{\"name\":\"pg$n\",\"listen\":\"0.0.0.0:$((5432 + n))\",\"upstream\":\"$pgip:5432\"}" >/dev/null
    toxic "pg$n" pg_lat downstream "$lat" 0
    # A US client 20–30 ms from the region, each way, as jittery as a
    # real network (which is what bunches a client's frames).
    curl -sf -X POST "$API/proxies" -d "{\"name\":\"ws$n\",\"listen\":\"0.0.0.0:$((4000 + n))\",\"upstream\":\"relay-$NAME-$n:4000\"}" >/dev/null
    toxic "ws$n" down downstream 25 15
    toxic "ws$n" up upstream 25 15
    # One CPU of the machine's (a Fly machine has one vCPU, so one
    # scheduler), then the quota on it.
    docker run -d --name "relay-$NAME-$n" --network "$NET" --network-alias "relays-$NAME" \
      "${cpuflags[@]}" --cpuset-cpus=$((n * 2 + 2)) --memory=512m \
      -p "127.0.0.1:$((PORT + nodes + n - 1)):9091" \
      -e SECRET_KEY_BASE="$secret" -e DEMO=1 -e DEMO_SECRET="$demo" -e PHX_HOST=localhost \
      -e PORT=4000 -e METRICS_PORT=9091 -e POOL_SIZE="$pool" \
      -e "DATABASE_URL=postgres://postgres:postgres@$TOXI:$((5432 + n))/$DB" \
      -e RATE_LIMITS="socket_connect=100000/60,demo_token=100000/3600" \
      -e RELEASE_DISTRIBUTION=name -e RELEASE_COOKIE="$cookie" \
      "$image" sh -c 'export RELEASE_NODE=presence@$(hostname -i); exec /app/bin/presence_relay start' >/dev/null
  done

  for n in $(seq 1 "$nodes"); do
    for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$((PORT + n - 1))/healthz" >/dev/null && break; sleep 0.5; done
  done
  # Cluster them (Fly's DNS does it there): node 1 connects to the rest.
  if [ "$nodes" -gt 1 ]; then
    local others=""
    for n in $(seq 2 "$nodes"); do
      others="$others :\"presence@$(docker inspect "relay-$NAME-$n" --format "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}")\","
    done
    docker exec "relay-$NAME-1" sh -c "export RELEASE_NODE=presence@\$(hostname -i); /app/bin/presence_relay rpc 'Enum.each([$others], &Node.connect/1)'"
  fi
  echo "$nodes" > "$STATE"
  sleep 2
  for n in $(seq 1 "$nodes"); do
    echo "relay-$NAME-$n: ws 127.0.0.1:$((PORT + n - 1)), $(curl -s "http://127.0.0.1:$((PORT + nodes + n - 1))/metrics" | grep -E '^presence_cluster_nodes' )"
  done
}

probe() {
  local name=$1 rooms=$2 members=$3 dur=${4:-60} ramp=${5:-10}
  shift 3; shift $(( $# < 2 ? $# : 2 ))
  local nodes metrics="" start n pids=()
  nodes=$(cat "$STATE")
  for n in $(seq 1 "$nodes"); do metrics="$metrics,http://127.0.0.1:$((PORT + nodes + n - 1))/metrics"; done
  start=$(( $(date +%s%3N) + 3000 ))
  for n in $(seq 1 "$nodes"); do
    node "$here/probe.mjs" --url "http://127.0.0.1:$((PORT + n - 1))" --rooms "$rooms" --members "$members" \
      --duration "$dur" --ramp "$ramp" --prefix "$name-$start" --start-at "$start" --id "node$n" \
      --metrics "${metrics#,}" "$@" &
    pids+=($!)
  done
  wait "${pids[@]}"
}

case "${1:-}" in
  up) shift; up "$@" ;;
  probe) shift; probe "$@" ;;
  down) down ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 2 ;;
esac
