#!/bin/sh
# Claude Code hook -> cm2d. Reads the hook JSON on stdin, POSTs it to the daemon, prints the daemon's reply
# (only PermissionRequest ever gets a non-empty one). Never fails: a dead daemon must not become hook errors.
# usage: cm2-hook.sh [curl-timeout-seconds]
# daemon address: $CM2_URL, else the one line in ~/.config/cm2-claude/url, else this machine.
u="${CM2_URL:-$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/cm2-claude/url" 2>/dev/null)}"
curl -sS -m "${1:-2}" -H 'Content-Type: application/json' --data-binary @- "${u:-http://127.0.0.1:7777}/hook" 2>/dev/null
exit 0
