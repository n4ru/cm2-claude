#!/bin/sh
# Merge the cm2d hooks into ~/.claude/settings.json (idempotent; other hooks are kept).
#   CM2_URL=http://host:7777 hooks/install-hooks.sh        install / update
#   hooks/install-hooks.sh --remove                          take them out again
set -e
HOOK="$(cd "$(dirname "$0")" && pwd)/cm2-hook.sh"
SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
python3 - "$SETTINGS" "$HOOK" "${1:-}" <<'EOF'
import json, sys, os
settings, hook, mode = sys.argv[1], sys.argv[2], sys.argv[3]
cfg = json.load(open(settings)) if os.path.exists(settings) else {}
hooks = cfg.setdefault("hooks", {})
mine = lambda h: any(hook in str(x.get("command", "")) for x in h.get("hooks", []))
for ev in list(hooks):
    hooks[ev] = [h for h in hooks[ev] if not mine(h)]
    if not hooks[ev]: del hooks[ev]
if mode != "--remove":
    fire = {"type": "command", "command": hook, "async": True, "timeout": 5}
    for ev in ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Notification", "Stop", "StopFailure"]:
        hooks.setdefault(ev, []).append({"hooks": [fire]})
    hooks.setdefault("SessionEnd", []).append({"hooks": [{**fire, "timeout": 1}]})
    # synchronous: the daemon may hold this one open until APPR/REJ is pressed (holdMs), so give curl room
    hooks.setdefault("PermissionRequest", []).append({"hooks": [{"type": "command", "command": hook + " 25", "timeout": 30,
        "statusMessage": "Creator Micro: press APPR / REJ, or wait for the prompt"}]})
if not hooks: del cfg["hooks"]
json.dump(cfg, open(settings, "w"), indent=2); open(settings, "a").write("\n")
print(("removed cm2d hooks from " if mode == "--remove" else "installed cm2d hooks in ") + settings)
EOF
