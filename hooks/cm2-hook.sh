#!/bin/sh
# Claude Code hook -> cm2d. Reads the hook JSON on stdin, POSTs it to the daemon,
# prints the daemon's reply (only PermissionRequest ever gets a non-empty one).
# Never fails: a dead daemon must not turn into hook errors in the session.
# usage: cm2-hook.sh [curl-timeout-seconds]   env: CM2_URL (default below)
curl -sS -m "${1:-2}" -H 'Content-Type: application/json' --data-binary @- \
  "${CM2_URL:-http://100.124.22.74:7777}/hook" 2>/dev/null
exit 0
