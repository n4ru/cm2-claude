#!/bin/sh
# SessionStart hook: make sure a cm2d is answering for this machine's sessions.
#  - Windows (Git Bash): the daemon must live in the INTERACTIVE session (it injects keystrokes), so it goes through the
#    "cm2d" logon task: created on first use (`node cm2d.js install`, user-level, no admin; CM2_NO_AUTOSTART=1 skips that
#    and starts the daemon detached instead), run whenever the daemon isn't answering.
#  - Elsewhere: start this machine's own daemon, which relays to whichever daemon has the pad (found over the tailnet or
#    cfg.peers); and if ~/.config/cm2-claude/ssh names a Windows pad machine, run its task over ssh as well.
#  - A ~/.config/cm2-claude/url pointing straight at a remote daemon that answers means nothing to do here.
cfg="${XDG_CONFIG_HOME:-$HOME/.config}/cm2-claude"
[ -z "$CM2_NO_DAEMON" ] || exit 0                                            # opt out
u="${CM2_URL:-$(cat "$cfg/url" 2>/dev/null)}"; u="${u:-http://127.0.0.1:7777}"
root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
if curl -s -m 3 "$u/state" 2>/dev/null | grep -q '"connected":true'; then                    # a daemon with the pad is already answering
  # Codex plays its onboarding when the app first detects the pad; we play it once per plugin version, so installing or
  # updating the plugin welcomes you on the pad. The daemon dedupes ?v across machines; the local flag avoids re-POSTing.
  ver="$(sed -n 's/.*"version"[^"]*"\([^"]*\)".*/\1/p' "$root/.claude-plugin/plugin.json" 2>/dev/null | head -1)"
  if [ -n "$ver" ] && [ "$(cat "$cfg/welcomed" 2>/dev/null)" != "$ver" ]; then
    curl -s -m 3 -X POST -o /dev/null "$u/onboard?v=$ver" 2>/dev/null && printf %s "$ver" > "$cfg/welcomed"
  fi
  exit 0
fi
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
    # revive the Windows host over ssh if ~/.config/cm2-claude/ssh names it
    host="$(cat "$cfg/ssh" 2>/dev/null)"; [ -n "$host" ] && ssh -o BatchMode=yes -o ConnectTimeout=5 "$host" schtasks /Run /TN cm2d >/dev/null 2>&1 &
    # DIRECT mode: a remote url means the hooks post straight to that daemon, so run nothing here. RELAY mode (no url, or
    # a localhost url) runs this machine's own daemon, which finds the host and forwards the hooks.
    case "$u" in http://127.0.0.1:*|http://localhost:*|"") ;; *) exit 0 ;; esac
    root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
    cd "$root/daemon" || exit 0
    command -v node >/dev/null 2>&1 || exit 0
    [ -d node_modules/node-hid ] || npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1
    node cm2d.js start >/dev/null 2>&1 ;;
esac
exit 0
