#!/usr/bin/env bash
# Runs a command with LiveKit's credentials (and nothing else) in its
# environment, read from Infisical. Never prints them.
#   ./with-livekit.sh node agent.mjs
set -euo pipefail
P=16bb0f03-4f52-4d75-aaa3-089323b66601
eval "$(infisical secrets --projectId "$P" --env prod --path /arugula-stream -o json --silent 2>/dev/null |
  python3 -I -c 'import json,sys,shlex
for x in json.load(sys.stdin):
    if x["secretKey"].startswith("LIVEKIT_"):
        print("export %s=%s" % (x["secretKey"], shlex.quote(x["secretValue"])))')"
exec "$@"
