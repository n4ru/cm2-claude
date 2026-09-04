#!/bin/sh
# SessionStart hook: make sure cm2d is running. It must run in the pad machine's INTERACTIVE Windows session (it injects
# keystrokes), which is why everything goes through the "cm2d" logon task: a process started from an ssh session can't.
#  - On the pad's machine (Git Bash): create the task on first use (`node cm2d.js install`, user-level, no admin; set
#    CM2_NO_AUTOSTART=1 to skip that and just start the daemon detached instead), otherwise run the task.
#  - Elsewhere: if ~/.config/cm2-claude/ssh names the pad's machine, run the task there over ssh. Otherwise nothing to do.
cfg="${XDG_CONFIG_HOME:-$HOME/.config}/cm2-claude"
[ -z "$CM2_NO_DAEMON" ] || exit 0                                            # opt out
u="${CM2_URL:-$(cat "$cfg/url" 2>/dev/null)}"; u="${u:-http://127.0.0.1:7777}"
curl -s -m 1 -o /dev/null "$u/state" && exit 0                              # already running
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
    cd "$root/daemon" || exit 0
    [ -d node_modules/node-hid ] || npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || exit 0
    if schtasks //Query //TN cm2d >/dev/null 2>&1; then schtasks //Run //TN cm2d >/dev/null 2>&1
    elif [ -z "$CM2_NO_AUTOSTART" ]; then node cm2d.js install >/dev/null 2>&1
    else  # detached start from this session (no console or pipes inherited); logs to the state folder
      node -e "const m=require('./cm2d.js');m.writeLauncher(m.homeDir())" >/dev/null 2>&1 || exit 0
      wscript.exe "$(cygpath -w "$root/daemon/cm2d.vbs")"
    fi ;;
  *)
    host="$(cat "$cfg/ssh" 2>/dev/null)"; [ -n "$host" ] || exit 0
    ssh -o BatchMode=yes -o ConnectTimeout=5 "$host" schtasks /Run /TN cm2d >/dev/null 2>&1 &
    ;;
esac
exit 0
