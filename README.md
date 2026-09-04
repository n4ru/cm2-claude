# cm2-claude

Claude Code agent status on a **Work Louder Creator Micro 2**: the Codex Micro's
Agent Keys, body-ring notification and approve/reject keys, driven by Claude Code
hooks instead of the ChatGPT app. Works over Bluetooth or USB, alongside the
Work Louder Input app, with the sessions running on a different machine than
the pad.

```
row 1   [dial] [AG00] [AG01] [joystick]      agent keys: one Claude Code session each
row 2   [AG02] [AG03] [AG04] [AG05]          white idle · blue working · amber needs input
row 3   [ .. ] [APPR] [REJ ] [ .. ]          green done (unread) · red error · selected key breathes
row 4   [ .. ] [ .. ] [ .. ]                 body ring = most urgent state across all sessions
```

## How it works

* **cm2d** (`daemon/cm2d.js`, Node, runs on the Windows box the pad is paired to)
  opens the pad's vendor HID collection (usage page `0xFF00`) and speaks the
  firmware's JSON-RPC: `v.oai.thstatus` lights the six agent keys,
  `v.oai.rgbcfg` drives the body ring, `v.oai.hid` reports key presses. It
  also listens on HTTP (`:7777`) for Claude Code hook events.
* **hooks** (`hooks/cm2-hook.sh`, on every machine that runs Claude Code) POST
  each hook event to cm2d. All hooks are async and swallow failures, so a
  dead daemon never shows up in a session. `PermissionRequest` is the one
  synchronous hook: cm2d holds it open for `holdMs` so APPR/REJ on the pad can
  answer it; otherwise the normal on-screen prompt appears.

State per session, in the Codex Micro's own derivation and palette:

| Claude Code event | state | key |
|---|---|---|
| `SessionStart` | idle | white |
| `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | working | blue |
| `PermissionRequest`, `Notification/permission_prompt`, `AskUserQuestion`, elicitations | awaiting | amber |
| `Stop` | unread (done, not looked at yet) | green |
| `StopFailure` | error | red |
| `SessionEnd` | slot freed | off |

Pressing an agent key selects that session (breathing) and acknowledges green/red
back to white. The next prompt you type clears them too. With more than six
sessions, the stalest one gives up its key, idle ones first.

Requires pad firmware **0.6.0 or newer** (`node cm2d.js status` prints it; the
Input app updates firmware). Firmware 0.6 is what put the `v.oai.*` methods on
every Creator Micro 2.

## Setup

On the machine with the pad (Windows, Node 18+):

```bash
scp -r daemon desktop:C:/Users/user/cm2-claude/
ssh desktop "cd C:\Users\user\cm2-claude\daemon && npm install --omit=dev"
ssh desktop "cd C:\Users\user\cm2-claude\daemon && node cm2d.js status"        # round trip over BLE/USB
ssh desktop "cd C:\Users\user\cm2-claude\daemon && node cm2d.js setup-keys"    # rows 1-2 -> agent keys, row 3 -> APPR/REJ (backs up first)
ssh desktop "cd C:\Users\user\cm2-claude\daemon && node cm2d.js install"       # logon task, starts now; `uninstall` reverts
ssh desktop "cd C:\Users\user\cm2-claude\daemon && node cm2d.js restart"       # after editing config.json or copying a new cm2d.js
```

The daemon keeps a pidfile, so starting a new instance (the task, or `restart`)
retires the old one instead of racing it for the port.

On every machine that runs Claude Code (rpc and the desktop's WSL are done):

```bash
CM2_URL=http://100.124.22.74:7777 hooks/install-hooks.sh     # merges into ~/.claude/settings.json; --remove takes it out
```

From WSL on the desktop use the same Tailscale address; the WSL gateway address
does not reach the daemon.

Check: `node cm2d.js state` (or `curl http://desktop:7777/state`), `node cm2d.js demo`
walks six fake sessions through every colour, `node cm2d.js press AG00` simulates
a pad key, `type cm2d.log` on the desktop. The pad commands (`status`, `backup`,
`restore`, `setup-keys`) pause the daemon while they own the HID channel and
resume it afterwards.

## Keycaps (WRK MX Icon set + clear caps)

Clear caps on all six agent keys so the status colour shows through; icon caps
for the rest. Suggested default, mirroring the Codex Micro's positions:

```
row 1   [dial]        [clear]      [clear]      [joystick]
row 2   [clear]       [clear]      [clear]      [clear]
row 3   [■ stop]      [run]        [X]          [↶ undo]        stop = Esc (interrupt)   run/X = APPR/REJ (cm2d)   undo = Esc Esc (rewind)
row 4   [mic/globe]   [⊞ or ★]     [smiley]                     voice = Win+H (Windows voice typing)   new = Ctrl+N   smiley = focus Claude
```

Only `run` and `X` talk to cm2d (that is `actions` in the config, ACT07/ACT08).
`setup-keys` writes the whole of layer 1 from `layout` in the config. A cell is a
plain keycode (`"KC_ESC"`), a chord written to the pad as a macro
(`["KC_LGUI","KC_H"]` = Win+H: modifiers held, last key clicked, released), or
`null` to keep whatever is on the pad. Defaults: Esc on row 3 left (interrupts
Claude when the app is focused), Win+H on row 4 left (Windows voice typing, the
Codex mic key's job), the rest inert so the pad never types stray letters. Add
`["KC_LCTL","KC_N"]` or whatever you like and re-run `setup-keys`; macros cm2d
made are regenerated each time, macros you built in Input are left alone.
Icons are cosmetic; the switch positions are what matters.

## Config

Optional `daemon/config.json`, any subset of the defaults at the top of `cm2d.js`:
`port`, `holdMs` (0 disables pad approvals), `brightness`, `colors`, `layout`
(what `setup-keys` writes), `ambient`
(per-state body ring effect; `idle: {effect: "off"}` mirrors Codex, or give it a
colour), `keys` (backlight of the non-agent keys: `"off"` by default so the
status keys pop, like Codex; `"keymap"` for the pad's stored backlight; or an
explicit `{effect,color,brightness}`), `actions` (which ACT keys are approve/reject).

## Caveats

* Agent keys and APPR/REJ stop typing; they only report to cm2d. `setup-keys`
  saves the previous keymap next to the daemon first; `node cm2d.js restore
  <backup>` puts it back.
* **The Work Louder Input app is not needed and will break this while it runs.**
  It syncs its own stored profile onto the pad, which replaces the agent keycodes
  with plain letters; after that every lighting command is still acknowledged
  with `{ok:1}` and renders nothing (the ring and backlight keep working, the
  per-key status dies silently). cm2d checks the active layer on connect and every
  two minutes, reports `agentKeys` in `/state`, and puts the `KV_OAI_*` keys back
  by itself, but only while Input is not running. Keep Input closed; open it for
  firmware updates and close it again. It relaunches at login through the
  `input` value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
  (`"C:\Users\user\AppData\Local\Programs\input\input.exe" --autostart`);
  remove that value to stop it.
* `node cm2d.js stop && node probe.js` drives the pad directly with a bright
  test pattern and prints every firmware reply. An acknowledgement proves the
  command was accepted, not that anything lit; only eyes on the pad settle that.
* Lighting sent over `v.oai.*` is volatile: the pad reverts to its stored
  lighting on power-cycle or layer change, so cm2d re-sends every 30 s.
* The pad has no way to focus a session in the Claude desktop app, so an agent
  key press selects and acknowledges, nothing more.
* One daemon owns the pad. `run` writes `cm2d.pid` and retires any older instance
  on startup (asking it to quit gracefully first, so it blanks the pad); if the
  pad ever freezes, `node cm2d.js restart` is the reset.
* `/hook` and `/state` are open to whatever can reach the port (your tailnet);
  `/key` and `/quit` only answer from the desktop itself. Nothing on the wire is
  authenticated beyond that, so keep the port off untrusted networks.
* APPR/REJ answer the selected session's prompt, or the only pending one. With
  several pending and none selected they do nothing but log; press the amber
  session's agent key first.

Protocol facts come from the community write-ups
([cm2-agent-keys](https://github.com/honest-andy/cm2-agent-keys),
[freemicro](https://github.com/eliBenven/freemicro),
[micro2-configurator](https://github.com/egegungordu/micro2-configurator)) and
the `@worklouder/wl-device-kit` bundle shipped inside the Input app. Not
affiliated with Work Louder or OpenAI.
