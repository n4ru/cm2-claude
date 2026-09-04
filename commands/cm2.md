---
description: Show what the Creator Micro 2 pad is displaying (sessions on keys, pending prompts, device)
---
Current cm2d state (from the daemon; empty means the daemon is unreachable):

!`curl -s -m 3 "${CM2_URL:-http://100.124.22.74:7777}/state"`

Summarise it for the user in a few lines: which agent key (AG00–AG05) holds which session (title or cwd) in which state, whether a permission prompt is waiting for APPR/REJ, and the device line (connected, battery, agent keys present). If the JSON is empty, say the daemon is not reachable and point at `node cm2d.js restart` on the desktop.
