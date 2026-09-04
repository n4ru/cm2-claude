---
description: Show what the Creator Micro 2 pad is displaying (sessions on keys, pending prompts, device)
---
Daemon address and current state (empty state means the daemon is unreachable):

!`u="${CM2_URL:-$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/cm2-claude/url" 2>/dev/null)}"; u="${u:-http://127.0.0.1:7777}"; echo "daemon: $u"; curl -s -m 3 "$u/state"`

Summarise it for the user in a few lines: which agent key (AG00–AG05) holds which session (title or cwd) in which state, whether a permission prompt is waiting for APPR/REJ, and the device line (connected, battery, agent keys present). If the state is empty, say the daemon at that address is not reachable: on the machine with the pad run `node cm2d.js restart` (or open a new Claude Code session there, which starts it), and on other machines check `~/.config/cm2-claude/url`.
