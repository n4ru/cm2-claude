#!/bin/sh
# SessionStart hook. On the Windows machine the pad is paired to, make sure cm2d is running, from this plugin's own
# copy of the daemon. Elsewhere (Linux, WSL, macOS) it does nothing: those sessions just report to the daemon.
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) ;; *) exit 0 ;; esac
[ -z "$CM2_NO_DAEMON" ] || exit 0                                            # opt out
curl -s -m 1 -o /dev/null http://127.0.0.1:7777/state && exit 0             # already running
root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$root/daemon" || exit 0
[ -d node_modules/node-hid ] || npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || exit 0
# the .vbs launcher starts node fully detached (no inherited console or pipes); it logs to the state folder
node -e "const m=require('./cm2d.js');m.writeLauncher(m.homeDir())" >/dev/null 2>&1 || exit 0
wscript.exe "$(cygpath -w "$root/daemon/cm2d.vbs")"
exit 0
