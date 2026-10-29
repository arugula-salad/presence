#!/usr/bin/env bash
# Runs a command with an Anthropic API key in ANTHROPIC_API_KEY (and
# nothing else), read from Infisical. Never prints it.
set -euo pipefail
P=16bb0f03-4f52-4d75-aaa3-089323b66601
eval "$(infisical secrets --projectId "$P" --env prod --path /illogical/control -o json --silent 2>/dev/null |
  python3 -I -c 'import json,sys,shlex
for x in json.load(sys.stdin):
    if x["secretKey"] == "ARUGULA_HOSTED_ANTHROPIC_KEY":
        print("export ANTHROPIC_API_KEY=%s" % shlex.quote(x["secretValue"]))')"
exec "$@"
