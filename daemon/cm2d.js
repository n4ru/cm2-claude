#!/usr/bin/env node
"use strict";
/*
 * cm2d — Claude Code agent status on a Work Louder Creator Micro 2 (the Codex
 * Micro's "Agent Keys", driven by Claude Code hooks instead of ChatGPT).
 *
 *   agent keys (rows 1-2)   one Claude Code session each, Codex Micro colours:
 *                           white idle, blue working, amber needs input,
 *                           green done-unread, red error. Selected key breathes.
 *   body ring (underglow)   the most urgent state across every session
 *   APPR / REJ (row 3)      answer a pending permission prompt from the pad
 *
 * Wire protocol: JSON-RPC lines in 64-byte HID reports on the vendor collection
 * (usage page 0xFF00, report id 6, channel 2). Needs firmware >= 0.6.0, which
 * registers the v.oai.* "OAI bridge" methods on every Creator Micro 2.
 *
 *   node cm2d.js run          daemon: device + HTTP hook receiver
 *   node cm2d.js status       firmware / battery round trip
 *   node cm2d.js backup F     save keymap.json from the pad
 *   node cm2d.js restore F    write a saved keymap back
 *   node cm2d.js setup-keys   turn rows 1-2 into agent keys, row 3 into APPR/REJ
 *   node cm2d.js install      autostart at logon (Windows scheduled task) + start now
 *   node cm2d.js uninstall
 *   node cm2d.js start | stop | restart   start detached (the logon task on Windows) / stop / relaunch
 * State lives in %APPDATA%\cm2-claude (Windows) or ~/.config/cm2-claude; CM2_HOME overrides.
 * Many machines, one pad: every machine with the plugin runs this daemon. The one whose pad is connected is the host;
 * the others are relays that forward their hooks to it (see "many daemons, one pad" below).
 *   node cm2d.js press AG00 [act]   simulate a pad key press (act 1) or release (act 0); loopback only
 *   node cm2d.js stick 0.75 [d]     simulate a stick push at angle (turns, 0 = right) and distance
 *   node cm2d.js state        what the running daemon thinks
 *   node cm2d.js demo         walk fake sessions through every colour
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { execFileSync, spawn } = require("child_process");

const VID = 0x303a, USAGE_PAGE = 0xff00, USAGE = 1;
const REPORT_ID = 6, CH_DEBUG = 1, CH_RPC = 2, CHUNK = 61;
const EFFECT = { off: 0, solid: 1, snake: 2, rainbow: 3, breath: 4, gradient: 5, shallowBreath: 6 };
const SLOTS = 6;

const DEFAULTS = {
  port: 7777,
  bind: "0.0.0.0",
  brightness: 1,
  holdMs: 20000,        // PermissionRequest waits this long for APPR/REJ, then the normal on-screen prompt appears. 0 = never hold
  resyncMs: 30000,      // vendor lighting is volatile (power-cycle, layer change) — re-send periodically
  ttlMs: 12 * 3600e3,   // forget sessions silent this long
  colors: { idle: 0xffffff, working: 0x304ffe, awaiting: 0xff6d00, unread: 0x00ff4c, error: 0xff0033 }, // Codex Micro factory palette
  // body ring per most-urgent state. color defaults to the state colour above.
  ambient: {
    awaiting: { effect: "breath", speed: 0.5 },
    error: { effect: "breath", speed: 0.5 },
    unread: { effect: "solid", speed: 0 },
    working: { effect: "snake", speed: 0.4 },
    idle: { effect: "off" },
  },
  keys: "off",          // backlight of the non-agent keys. "off" = dark (what Codex does — the status keys pop); "keymap" = the pad's stored backlight; or {effect,color,brightness,speed}
  actions: { approve: "ACT07", reject: "ACT08", talk: "ACT10" }, // Codex caps: ACT07 = APPR, ACT08 = REJ; ACT10 = hold-to-talk
  // hold-to-talk: virtual-key codes sent on the Windows desktop while the talk key is held, and how.
  // "toggle" taps the chord on press and again on release (Windows voice typing, Win+H: opens, then closes).
  // "hold" presses the chord down on press and lifts it on release (a push-to-talk hotkey such as Claude's dictation shortcut).
  talkKeys: [0x5b, 0x48], talkMode: "toggle",
  focusOnPress: true,   // agent key press brings the Claude desktop app to the front (raise), and fires the
                        // claude://code/continue deep link to open that exact session (inert until Anthropic ungates it)
  flashMs: 4000,        // after a selection change the other keys flash the selected session's colour, as Codex does
  // what `setup-keys` writes to layer 1 (rows of 2/4/4/3). AGnn = agent keys, KV_OAI_ACTnn = keys reported to cm2d,
  // a plain keycode types that key, an ARRAY is a chord written as an on-pad macro (modifiers held, last key
  // clicked: ["KC_LGUI","KC_H"] = Win+H), null keeps whatever is on the pad. Spares default to Esc (interrupt
  // Claude), the hold-to-talk action key (Windows voice typing while held: the Codex mic key's job), and inert.
  layout: [
    ["KV_OAI_AG00", "KV_OAI_AG01"],
    ["KV_OAI_AG02", "KV_OAI_AG03", "KV_OAI_AG04", "KV_OAI_AG05"],
    ["KC_ESC", "KV_OAI_ACT07", "KV_OAI_ACT08", "KC_NONE"],
    ["KV_OAI_ACT10", "KC_NONE", "KC_NONE"],
  ],
  // the rest of layer 1, written verbatim by setup-keys when set; null keeps what the pad has.
  encoders: null,   // used when dial = "keymap": [["KC_VOLU", "KC_VOLD", "KC_MPLY"]] = clockwise, counter-clockwise, press
  joystick: null,   // used when stick.mode = "keymap": {"type": "JOYSTICK", "sectors": []} or {"type": "RADIAL", "sectors": [{"k": "KC_UP", "a1": 0.625, "a2": 0.875}, ...]}
  lights: null,     // the pad's own stored lighting when nothing drives it, e.g. {"backlight": {"effect": "solid", "brightness": 1, "speed": 0.5, "magic": 1, "color": 16777215}, "underglow": {...}}
  // ---- the Codex Micro behaviours (from the ChatGPT app's own layout), all on by default
  dial: "navigate",     // "navigate": turn = previous / next option (Arrow Up / Down), click = Enter, hold 500 ms = open the configurator;
                        // using the dial puts the pad in "navigating" for 2 s: blue snake ring, AG00 red and acting as Escape. "keymap" = `encoders`
  // vendor = the daemon reads the stick, fires one shortcut per push past half deflection, re-arms at rest. "keymap" = `joystick`.
  // Defaults are the Claude desktop app's documented Code-tab shortcuts: left/right cycle sessions in the sidebar
  // (Ctrl+Shift+Tab / Ctrl+Tab — this is how you jump between sessions from the pad today), up cycles the transcript
  // view modes (Ctrl+O), down toggles the terminal pane (Ctrl+`). Windows virtual-key codes; edit freely in the GUI.
  stick: { mode: "vendor", up: [0x11, 0x4f], down: [0x11, 0xc0], left: [0x11, 0x10, 0x09], right: [0x11, 0x09] },
  actionKeys: {},       // more vendor keys handled here, e.g. {"ACT09": {"chord": [17, 78]}, "ACT12": {"text": "Not sure, use your judgment", "enter": true}, "ACT11": {"raise": true}, "ACT06": {"open": "config"}}
  autoDimMs: 180000,    // Codex: lights off after 3 min without a key, stick or status change; anything wakes them. 0 = never
  agentSource: "recent",// Codex: the six most recently active sessions, most recent on AG00. "sticky": a session keeps its key until it ends
  doubleTapMs: 350,     // second tap on the same agent key within this raises the Claude window; also the mic latch window
  focusDowngrade: true, // Codex: the selected session's green (done, unread) turns white while the Claude window is focused
  ambientMode: "urgent",// ring = most urgent state of any session. "codex": only the selected session working (blue snake), else off
  peers: [],            // other daemons to announce to / look for besides the tailnet peers, e.g. ["http://100.124.22.74:7777"] (a machine Tailscale can't list, such as WSL)
};
/** Which encoders / joystick / lights setup-keys writes, honouring the dial and stick modes. The encoder order is the
 *  one the Input app's ChatGPT preset uses (CC, CW, click), so the daemon's mapping matches the Codex feel. */
const padExtras = (cfg) => ({
  encoders: cfg.dial === "navigate" ? [["KV_OAI_ENC_CC", "KV_OAI_ENC_CW", "KV_OAI_ENC_CLK"]] : cfg.encoders,
  joystick: cfg.stick && cfg.stick.mode === "vendor" ? { type: "VENDOR", sectors: [] } : cfg.joystick,
  lights: cfg.lights,
});

function loadConfig(dir) {
  const f = path.join(dir, "config.json");
  const user = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
  return mergeConfig(user);
}
const mergeConfig = (user) => ({ ...DEFAULTS, ...user, colors: { ...DEFAULTS.colors, ...user.colors }, ambient: { ...DEFAULTS.ambient, ...user.ambient }, actions: { ...DEFAULTS.actions, ...user.actions }, stick: { ...DEFAULTS.stick, ...user.stick } });

const EDITABLE = ["peers", "brightness", "holdMs", "colors", "ambient", "keys", "actions", "talkKeys", "talkMode", "focusOnPress", "flashMs", "layout", "encoders", "joystick", "lights", "dial", "stick", "actionKeys", "autoDimMs", "agentSource", "doubleTapMs", "focusDowngrade", "ambientMode"];
const KEYMAP_KEYS = ["layout", "encoders", "joystick", "lights", "actions", "dial", "stick"];
/** Merge a GUI patch into config.json (deep for the small maps, whole-value otherwise), validate the pad-facing part
 *  against the last keymap seen, and refresh `cfg` in place so every closure sees the new values. Throws on bad input. */
function applyConfigPatch(dir, patch, cfg, lastKeymap) {
  const bad = Object.keys(patch).filter((k) => !EDITABLE.includes(k));
  if (bad.length) throw new Error(`not editable: ${bad.join(", ")} (port and bind need a restart; edit config.json)`);
  const f = path.join(dir, "config.json");
  const user = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
  for (const [k, v] of Object.entries(patch)) user[k] = ["colors", "ambient", "actions", "stick"].includes(k) && v && typeof v === "object" ? { ...(user[k] || {}), ...v } : v;
  const next = mergeConfig(user);
  if (lastKeymap) agentKeymap(JSON.parse(JSON.stringify(lastKeymap)), next.layout, next.actions, padExtras(next)); // dry run: throws on a bad layout
  fs.writeFileSync(f, JSON.stringify(user, null, 2) + "\n");
  Object.assign(cfg, next);
  return KEYMAP_KEYS.some((k) => k in patch);
}
/** State (config.json, sessions.json, pidfile, log, keymap backups) lives in a per-user folder, not next to the code:
 *  the code may be a plugin cache directory that is replaced on every update. CM2_HOME overrides. Files found next to
 *  the code from older installs are migrated once. */
function homeDir() {
  const home = process.env.CM2_HOME || (process.platform === "win32" && process.env.APPDATA ? path.join(process.env.APPDATA, "cm2-claude") : path.join(process.env.HOME || process.env.USERPROFILE || __dirname, ".config", "cm2-claude"));
  fs.mkdirSync(home, { recursive: true });
  for (const f of fs.readdirSync(__dirname)) if ((f === "config.json" || f === "sessions.json" || /^keymap\..*\.json$/.test(f)) && !fs.existsSync(path.join(home, f))) { try { fs.copyFileSync(path.join(__dirname, f), path.join(home, f)); } catch { /* read-only code dir: fine */ } }
  return home;
}
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- single instance
// A stale daemon that lost the pad silently keeps the LEDs frozen; a pidfile lets a
// new instance (or `restart`) reliably retire the old one instead of racing it.
const pidfile = (dir) => path.join(dir, "cm2d.pid");
const readPid = (dir) => { try { return parseInt(fs.readFileSync(pidfile(dir), "utf8"), 10) || 0; } catch { return 0; } };
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
/** True only if `pid` is a node process running this file — a stale pidfile after a crash may point at a reused pid. */
function isCm2d(pid) {
  try {
    const cmd = process.platform === "win32"
      ? execFileSync("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: "utf8" })
      : fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cmd.includes("cm2d.js");
  } catch { return false; }
}
/** Ask the running daemon to quit over loopback (it blanks the pad first); kill it only if it does not go. */
async function stopDaemon(dir, port) {
  const pid = readPid(dir);
  if (!(alive(pid) && pid !== process.pid && isCm2d(pid))) { log("no running cm2d"); try { fs.unlinkSync(pidfile(dir)); } catch { /* none */ } return false; }
  await new Promise((r) => { const q = http.request({ host: "127.0.0.1", port, path: "/quit", method: "POST", timeout: 1500 }, (res) => { res.resume(); res.on("end", r); }); q.on("error", r); q.on("timeout", () => { q.destroy(); r(); }); q.end(); });
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(100);
  if (alive(pid)) { try { process.kill(pid); } catch { /* gone */ } log(`killed cm2d pid ${pid}`); } else log(`stopped cm2d pid ${pid}`);
  try { fs.unlinkSync(pidfile(dir)); } catch { /* none */ }
  return true;
}
/** Hook bodies come off the network: only objects, and a session id that is always a string (it is used as a Map key and sliced for logs). */
function normalizeEvent(ev) {
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) return null;
  if (ev.session_id !== undefined && ev.session_id !== null) ev.session_id = String(ev.session_id);
  return ev;
}
const inputAppRunning = () => { try { return process.platform === "win32" && execFileSync("tasklist", ["/FI", "IMAGENAME eq input.exe", "/NH"], { encoding: "utf8" }).includes("input.exe"); } catch { return false; } };
// Windows keystroke injection for hold-to-talk. One persistent PowerShell child (the Add-Type compile costs ~1 s,
// so it is started with the daemon, not on the first press); each stdin line is a chord of virtual-key codes.
// Lines: "t|d|u <vk...>" tap / press / release a chord; "text <base64 utf8>" type it (SendKeys); "raise" bring the Claude
// window to the front; "open <url>" default handler; "fg" answer "fg <process name>" of the foreground window on stdout.
const KEYS_PS = `Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class K{[DllImport("user32.dll")]public static extern void keybd_event(byte vk,byte sc,uint fl,UIntPtr ex);[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int n);[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);}'
while($l=[Console]::In.ReadLine()){$p=$l.Split(" ",2);$m=$p[0];$a=if($p.Length -gt 1){$p[1]}else{""}
if($m -eq "text"){[System.Windows.Forms.SendKeys]::SendWait([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($a)));continue}
if($m -eq "open"){Start-Process $a;continue}
if($m -eq "raise"){$w=Get-Process claude -ErrorAction SilentlyContinue|Where-Object{$_.MainWindowHandle -ne 0}|Select-Object -First 1;if($w){[K]::keybd_event(0x12,0,0,[UIntPtr]::Zero);[K]::keybd_event(0x12,0,2,[UIntPtr]::Zero);[void][K]::ShowWindow($w.MainWindowHandle,9);[void][K]::SetForegroundWindow($w.MainWindowHandle)};continue}
if($m -eq "fg"){$h=[K]::GetForegroundWindow();$id=[uint32]0;[void][K]::GetWindowThreadProcessId($h,[ref]$id);$n=(Get-Process -Id $id -ErrorAction SilentlyContinue).ProcessName;[Console]::Out.WriteLine("fg "+$n);[Console]::Out.Flush();continue}
if($a -eq ""){continue};$v=@($a.Split(" ")|%{[byte]$_});if($m -ne "u"){foreach($k in $v){[K]::keybd_event($k,0,0,[UIntPtr]::Zero)}};if($m -ne "d"){[array]::Reverse($v);foreach($k in $v){[K]::keybd_event($k,0,2,[UIntPtr]::Zero)}}}`;
let keysProc = null; const fgWaiters = [];
function injector() {
  if (keysProc && keysProc.exitCode === null) return keysProc;
  keysProc = spawn("powershell", ["-NoProfile", "-EncodedCommand", Buffer.from(KEYS_PS, "utf16le").toString("base64")], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  keysProc.on("error", (e) => log("keys:", e.message));
  let buf = "";
  keysProc.stdout.on("data", (d) => { buf += d; const lines = buf.split(/\r?\n/); buf = lines.pop(); for (const l of lines) { const m = /^fg (.*)$/.exec(l.trim()); if (m) { const w = fgWaiters.shift(); if (w) w(m[1]); } } });
  return keysProc;
}
const inject = (line) => { if (process.platform !== "win32") return log("inject (no-op off Windows):", line.slice(0, 60)); injector().stdin.write(line + "\n"); };
/** edge: "t" tap (press then release), "d" press and keep down, "u" release. null just warms the injector up. */
function sendKeys(vks, edge = "t") { if (!vks) { if (process.platform === "win32") injector(); return; } inject(`${edge} ${vks.join(" ")}`); }
const injectText = (text, enter) => { inject("text " + Buffer.from(String(text).replace(/[+^%~(){}[\]]/g, (c) => "{" + c + "}")).toString("base64")); if (enter) sendKeys([0x0d]); };
const raiseClaude = () => inject("raise");
const openUrl = (u) => inject("open " + u);
const foreground = (cb) => { if (process.platform !== "win32") return cb(""); fgWaiters.push(cb); inject("fg"); };
const VK = { up: 0x26, down: 0x28, enter: 0x0d, esc: 0x1b };
/** Codex's stick sectors (angle in turns, 0 = right). */
const sectorOf = (a) => (a >= 0.625 && a < 0.875 ? "up" : a >= 0.125 && a < 0.375 ? "down" : a >= 0.375 && a < 0.625 ? "left" : "right");
/** The Codex mic key, four states, one threshold: hold = record while held; tap, then tap again within t = latched
 *  (keeps recording); any tap then stops it. `start`/`stop` are the only outputs. */
class Ptt {
  constructor(t, start, stop, now = Date.now) { this.t = t; this.start = start; this.stop = stop; this.now = now; this.state = "idle"; this.at = 0; this.timer = null; }
  press() {
    const n = this.now();
    if (this.state === "idle") { this.state = "pressed"; this.at = n; this.start(); }
    else if (this.state === "waiting") { clearTimeout(this.timer); this.state = "latched"; }
    else if (this.state === "latched") { this.state = "suppressing"; this.at = n; this.stop(); }
    else if (this.state === "suppressing" && n - this.at >= this.t) { this.state = "pressed"; this.at = n; this.start(); }
  }
  release() {
    if (this.state !== "pressed") return;
    const held = this.now() - this.at;
    if (held >= this.t) { this.state = "idle"; this.stop(); return; }
    this.state = "waiting";
    this.timer = setTimeout(() => { if (this.state === "waiting") { this.state = "idle"; this.stop(); } }, this.t - held);
  }
}
// The Claude desktop app stores one JSON per session under %APPDATA%\Claude\claude-code-sessions\<account>\<org>\local_*.json
// carrying its own id (sessionId, "local_…"), the Claude Code id the hooks report (cliSessionId) and a title. Its
// claude://code/continue?session=<local id> deep link opens that session, which is how an agent key press "switches thread".
const SESSIONS_DIR = process.env.APPDATA ? path.join(process.env.APPDATA, "Claude", "claude-code-sessions") : null;
function desktopSession(cliId, dir = SESSIONS_DIR) {
  if (!dir || !cliId) return null;
  try {
    for (const acct of fs.readdirSync(dir)) for (const org of fs.readdirSync(path.join(dir, acct))) {
      const d = path.join(dir, acct, org);
      for (const f of fs.readdirSync(d)) {
        if (!f.startsWith("local_") || !f.endsWith(".json")) continue;
        const txt = fs.readFileSync(path.join(d, f), "utf8");
        if (!txt.includes(cliId)) continue;
        const j = JSON.parse(txt);
        if (j.cliSessionId === cliId) return { localId: j.sessionId, title: j.title || "" };
      }
    }
  } catch { /* store missing or unreadable: no focus, no titles */ }
  return null;
}
function openInClaude(localId) {
  if (process.platform !== "win32") return log("openInClaude (no-op off Windows):", localId);
  openUrl(`claude://code/continue?session=${localId}`);   // Start-Process hands the deep link to the already-running app
}
const loopback = (req) => /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || "");

// ---------------------------------------------------------------- many daemons, one pad
// A HID device is only reachable from the machine it is paired to, so exactly one daemon can drive the pad. Every other
// machine's plugin still runs this daemon, as a relay: its hooks post to localhost and the relay forwards them to the
// host, holds included. Finding the host is two-way: the host announces itself (POST /announce {port, pad}) to every
// online tailnet peer and cfg.peers when the pad connects or drops and once a minute; a relay probes the same peers
// whenever it has no host. A relay adopts a host only after reading /state from it and seeing a connected pad, so an
// announcement can point it nowhere else; it drops a host only when forwarding to it fails. The pad moving to another
// machine (a Bluetooth slot switch) is just the new host announcing.
const tailscaleBin = () => process.env.CM2_TAILSCALE || (process.platform === "win32" && fs.existsSync("C:\\Program Files\\Tailscale\\tailscale.exe") ? "C:\\Program Files\\Tailscale\\tailscale.exe" : "tailscale");
/** IPv4 of every online peer in `tailscale status --json` output. */
const peerIps = (status) => Object.values((status && status.Peer) || {}).filter((p) => p.Online).map((p) => (p.TailscaleIPs || []).find((ip) => ip.includes("."))).filter(Boolean);
function tailscalePeers() {
  return new Promise((resolve) => require("child_process").execFile(tailscaleBin(), ["status", "--json"], { encoding: "utf8", timeout: 3000, windowsHide: true, maxBuffer: 8e6 }, (e, out) => {
    try { resolve(e ? [] : peerIps(JSON.parse(out))); } catch { resolve([]); }
  }));
}
/** The base URL of a daemon that announced itself from `remoteAddress` on `port`. */
const announcedUrl = (remoteAddress, port) => { const ip = String(remoteAddress || "").replace(/^::ffff:/, ""); return `http://${ip.includes(":") ? "[" + ip + "]" : ip}:${port}`; };
/** Small JSON HTTP client: resolves {status, body}, rejects on error or timeout. */
function request(method, url, body, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const r = http.request(url, { method, headers: body ? { "Content-Type": "application/json" } : {}, timeout: timeoutMs }, (res) => { let b = ""; res.on("data", (c) => { b += c; if (b.length > 1e6) res.destroy(); }); res.on("end", () => resolve({ status: res.statusCode, body: b })); res.on("error", reject); });
    r.on("error", reject); r.on("timeout", () => r.destroy(new Error("timeout")));
    r.end(body ? JSON.stringify(body) : undefined);
  });
}

// ---------------------------------------------------------------- framing
/** Split one JSON-RPC line into 64-byte output reports: [id 6][channel][len][payload…]. */
function frame(line, channel = CH_RPC) {
  const bytes = Buffer.from(line.replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")), "utf8");
  const out = [];
  for (let off = 0; off < bytes.length; off += CHUNK) {
    const chunk = bytes.subarray(off, off + CHUNK);
    const r = Buffer.alloc(64);
    r[0] = REPORT_ID; r[1] = channel; r[2] = chunk.length;
    chunk.copy(r, 3);
    out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------- device
class Pad extends EventEmitter {
  static list() {
    const HID = require("node-hid");
    return HID.devices().filter((d) => d.vendorId === VID && d.usagePage === USAGE_PAGE && d.usage === USAGE);
  }
  static async open(info = Pad.list()[0]) {
    if (!info) throw new Error("no Creator Micro 2 vendor interface found (USB or Bluetooth)");
    const HID = require("node-hid");
    const hid = process.platform === "darwin" ? await HID.HIDAsync.open(info.path, { nonExclusive: true }) : await HID.HIDAsync.open(info.path);
    return new Pad(hid, info);
  }
  constructor(hid, info) {
    super();
    this.hid = hid; this.info = info;
    this.bufs = { [CH_DEBUG]: "", [CH_RPC]: "" };
    this.pending = new Map();
    this.nextId = 1 + Math.floor(Math.random() * 998); // random seed: a CLI and the daemon must never shadow each other's ids
    this.queue = Promise.resolve();
    this.on("error", (e) => { this.lastError = e; }); // an 'error' with no listener would throw out of node-hid's read callback
    hid.on("data", (b) => this.onReport(b));
    hid.on("error", (e) => this.emit("error", e));
    hid.on("close", () => this.emit("close"));
  }
  onReport(buf) {
    const ch = buf[1], len = buf[2];
    if (!(ch in this.bufs)) return;
    this.bufs[ch] += buf.subarray(3, 3 + len).toString("utf8");
    const lines = this.bufs[ch].split(/\r?\n/);
    this.bufs[ch] = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      if (ch === CH_DEBUG) { this.emit("debug", line); continue; }
      let msg; try { msg = JSON.parse(line.slice(line.indexOf("{"))); } catch { continue; }
      this.dispatch(msg);
    }
  }
  dispatch(msg) {
    const id = msg.id ?? msg.i;
    if (id !== undefined && this.pending.has(id)) {
      const p = this.pending.get(id); this.pending.delete(id); clearTimeout(p.timer);
      return msg.error ? p.reject(new Error(msg.error.message || JSON.stringify(msg.error))) : p.resolve(msg.result);
    }
    // device-initiated notifications use abbreviated keys: {"m":"v.oai.hid","p":{"k":"AG00","act":1}}
    const m = msg.method || msg.m, p = msg.params || msg.p || {};
    if (m === "v.oai.hid") this.emit("key", { key: p.k ?? p.key, act: p.act });
    else if (m === "v.oai.rad") this.emit("joystick", p);
    else this.emit("notification", msg);
  }
  /** One request in flight at a time (the device keeps one buffer per channel; interleaved chunks = shredded JSON). */
  rpc(method, params = null, timeoutMs = 4000) {
    const run = () => new Promise((resolve, reject) => {
      const id = this.nextId; this.nextId = (this.nextId % 998) + 1; // firmware rejects ids > 998
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      (async () => { for (const r of frame(JSON.stringify({ method, params, id }))) await this.hid.write(r); })()
        .catch((e) => { clearTimeout(timer); this.pending.delete(id); reject(e); });
    });
    const p = this.queue.then(run, run);
    this.queue = p.then(() => sleep(30), () => sleep(30));
    return p;
  }
  async close() {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("closed")); }
    this.pending.clear();
    try { await this.hid.close(); } catch { /* already gone */ }
  }
  status() { return this.rpc("device.status"); }
  async readKeymap() { const r = await this.rpc("fs.read", { file: "keymap.json" }); return JSON.parse(typeof r === "string" ? r : r.data); }
  writeKeymap(km) { return this.rpc("fs.write", { file: "keymap.json", data: JSON.stringify(km) }, 15000); }
  setThreads(threads) { return this.rpc("v.oai.thstatus", threads); }
  setZones(ambient, keys) { return this.rpc("v.oai.rgbcfg", { ambient, keys }); }
}

// ---------------------------------------------------------------- state engine
const PRIO = { idle: 0, working: 1, unread: 2, error: 3, awaiting: 4 };
const AWAIT_NOTIFS = new Set(["permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"]);

/** Claude Code hook events -> per-session state -> lighting. Pure; no device, no clock of its own. */
class Engine {
  constructor(cfg, now = Date.now) {
    this.cfg = cfg; this.now = now;
    this.sessions = new Map(); // id -> {id, slot, state, seen, cwd}
    this.selected = null;
  }
  session(id, ev) {
    let s = this.sessions.get(id);
    if (!s) { s = { id, slot: null, state: "idle", seen: 0, cwd: "" }; this.sessions.set(id, s); }
    s.seen = this.now();
    if (ev && ev.cwd) s.cwd = ev.cwd;
    if (s.slot === null) s.slot = this.freeSlot();
    return s;
  }
  /** Codex's "recent" agent source: the six most recently active sessions, most recent on AG00; the rest have no key. */
  reslot() {
    if (this.cfg.agentSource !== "recent") return;
    [...this.sessions.values()].sort((a, b) => b.seen - a.seen).forEach((s, i) => { s.slot = i < SLOTS ? i : null; });
  }
  slots() { return [...this.sessions.values()].map((s) => s.id + ":" + s.slot).sort().join(","); }
  /** Codex: while the window is focused, the selected session's "done, unread" green is already seen. */
  downgradeSelected() { const s = this.selected && this.sessions.get(this.selected); if (s && s.state === "unread") { s.state = "idle"; return true; } return false; }
  freeSlot() {
    const used = new Map([...this.sessions.values()].filter((s) => s.slot !== null).map((s) => [s.slot, s]));
    for (let i = 0; i < SLOTS; i++) if (!used.has(i)) return i;
    // all six taken: evict the stalest session, preferring ones that aren't doing anything
    // (a session whose terminal died never sends SessionEnd, so busy-looking slots must be evictable too)
    const rank = { idle: 0, unread: 0, error: 1, working: 2, awaiting: 3 };
    const victim = [...used.values()].sort((a, b) => rank[a.state] - rank[b.state] || a.seen - b.seen)[0];
    const slot = victim.slot; victim.slot = null;
    return slot;
  }
  /** Apply one hook event. Returns true when the lights need re-rendering. */
  handle(ev) {
    const id = ev.session_id, name = ev.hook_event_name;
    if (!id || !name) return false;
    if (name === "SessionEnd") {
      if (this.selected === id) this.selected = null;
      return this.sessions.delete(id);
    }
    const before = this.slots(); // slots may move: allocation, eviction, or "recent" re-ordering
    const s = this.session(id, ev), was = s.state;
    switch (name) {
      case "SessionStart": if (ev.how_session_started !== "compact") s.state = "idle"; break;
      case "UserPromptSubmit": case "PostToolUse": case "PostToolUseFailure": s.state = "working"; break;
      case "PreToolUse": s.state = ev.tool_name === "AskUserQuestion" ? "awaiting" : "working"; break;
      case "PermissionRequest": s.state = "awaiting"; break;
      case "Notification":
        if (AWAIT_NOTIFS.has(ev.notification_type)) s.state = "awaiting";
        else if (/^elicitation_(complete|response)$/.test(ev.notification_type || "")) s.state = "working";
        break;
      case "Stop": s.state = "unread"; break;
      case "StopFailure": s.state = "error"; break;
      default: this.reslot(); return before !== this.slots();
    }
    this.reslot();
    return was !== s.state || before !== this.slots() || name === "SessionStart";
  }
  bySlot(slot) { return [...this.sessions.values()].find((s) => s.slot === slot); }
  /** Agent key pressed: select that session (breathing key) and acknowledge its done/error state. */
  press(slot) {
    const s = this.bySlot(slot);
    if (!s) { this.selected = null; return true; }
    this.selected = this.selected === s.id ? null : s.id;
    if (s.state === "unread" || s.state === "error") s.state = "idle";
    if (this.cfg.agentSource !== "recent") s.seen = this.now();   // in "recent" mode a press must not shuffle the keys
    return true;
  }
  sweep() {
    const cutoff = this.now() - this.cfg.ttlMs;
    let changed = false;
    for (const s of [...this.sessions.values()]) if (s.seen < cutoff) { this.sessions.delete(s.id); if (this.selected === s.id) this.selected = null; changed = true; }
    return changed;
  }
  toJSON() { return { selected: this.selected, sessions: [...this.sessions.values()] }; }
  load(j) { if (!j || !Array.isArray(j.sessions)) return; this.sessions = new Map(j.sessions.map((s) => [s.id, s])); this.selected = j.selected ?? null; this.sweep(); this.reslot(); }
  render() {
    const { colors, brightness } = this.cfg;
    const threads = Array.from({ length: SLOTS }, (_, i) => ({ id: i, c: 0, b: 0, e: 0, s: 0, sk: 0, sa: 0 }));
    let top = "idle";
    for (const s of this.sessions.values()) {
      if (PRIO[s.state] > PRIO[top]) top = s.state;
      if (s.slot === null) continue;
      const sel = s.id === this.selected;
      threads[s.slot] = { id: s.slot, c: colors[s.state], b: brightness, e: sel ? EFFECT.breath : EFFECT.solid, s: sel ? 0.4 : 0, sk: 0, sa: 0 };
    }
    return { threads, top };
  }
}

/** One v.oai.rgbcfg side from a friendly {effect,color,brightness,speed,magic} object (or a keymap `lights` entry). */
function zone(z, fallbackColor, fallbackBrightness) {
  if (!z || z.effect === "off" || z.effect === 0) return { e: 0, b: 0, s: 0, m: 0, c: 0 };
  return {
    e: typeof z.effect === "string" ? (EFFECT[z.effect] ?? 1) : z.effect,
    b: z.brightness ?? fallbackBrightness,
    s: z.speed ?? 0,
    m: z.magic ?? 0,
    c: z.color ?? fallbackColor,
  };
}

// ---------------------------------------------------------------- daemon
async function run(dir) {
  const cfg = loadConfig(dir);
  if (await stopDaemon(dir, cfg.port)) await sleep(500);
  fs.writeFileSync(pidfile(dir), String(process.pid));
  if (process.platform === "win32") { try { writeLauncher(dir); } catch { /* read-only code dir */ } } // keep the launchers pointing at this copy
  process.on("uncaughtException", (e) => log("crash guard:", e.stack || e)); // one bad request or odd key event must not end a weeks-long run
  const engine = new Engine(cfg);
  const stateFile = path.join(dir, "sessions.json");   // survives restarts; the 12 h sweep still applies on load
  try { engine.load(JSON.parse(fs.readFileSync(stateFile, "utf8"))); if (engine.sessions.size) log(`restored ${engine.sessions.size} session(s)`); } catch { /* first run */ }
  let saveTimer = null;
  const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => fs.writeFile(stateFile, JSON.stringify(engine), () => {}), 500); };
  const holds = new Map(); // session id -> respond(decision|null)
  let pad = null, keysZone = { e: 0, b: 0, s: 0, m: 0, c: 0 }, lastSent = "", device = { connected: false }, pushTimer = null;
  let dropPad = null, pushFails = 0; // a handle that stays "open" through BLE sleep answers nothing: after 3 failed pushes, reconnect
  let lastKeymap = null;             // the pad's keymap as last read or written; /config shows it, and the GUI's writes are validated against it
  const keymapSummary = (km) => { const l = km?.profiles?.[km.activeProfileId ?? 0]?.layers?.[0]; return l ? { rows: l.layout.keymap, encoders: l.layout.encoders, joystick: l.layout.joystick, lights: l.lights, macros: km.macros || [] } : null; };
  const computeKeysZone = (km) => zone(cfg.keys === "keymap" ? km?.profiles?.[km.activeProfileId ?? 0]?.layers?.[0]?.lights?.backlight : cfg.keys === "off" ? null : cfg.keys, 0xffffff, cfg.brightness);
  /** Does the pad differ from what the config says layer 1 should be? (config is the source of truth; null cells and null
   *  encoders/joystick/lights mean "whatever the pad has", so they never count as a difference) */
  const needsReprogram = (km) => {
    try { const want = agentKeymap(JSON.parse(JSON.stringify(km)), cfg.layout, cfg.actions, padExtras(cfg)); return JSON.stringify(keymapSummary(want)) !== JSON.stringify(keymapSummary(km)); }
    catch (e) { log("config does not fit this pad:", e.message); return false; }
  };
  /** Reprogram layer 1 from the config over the daemon's own connection (no pause needed: one writer). */
  async function applyLayout() {
    if (!pad) throw new Error("pad not connected");
    const km = await pad.readKeymap();
    await pad.writeKeymap(agentKeymap(km, cfg.layout, cfg.actions, padExtras(cfg)));
    lastKeymap = km; keysZone = computeKeysZone(km); lastSent = "";
    log("keymap reprogrammed from config"); await push(true);
  }
  let talkHeld = false;              // while recording the non-agent keys glow red and the ring runs Codex's green "recording" snake
  let flash = null;                  // {until, color}: the other keys show the newly selected session's colour for flashMs
  const VOICE_AMBIENT = { e: 2, b: cfg.brightness, s: 0.4, m: 0, c: 0x2e8b57 };
  let dialUntil = 0, dialTimer = null, encHold = null, encConsumed = false;   // "navigating": 2 s after the last dial event
  let lastTap = null;                // {slot, at} for the agent-key double tap
  let dimmed = false, lastActivity = Date.now();                              // auto-dim
  let claudeFocused = false, stickArmed = true;
  const dialActive = () => Date.now() < dialUntil;
  const url = () => `http://127.0.0.1:${cfg.port}/`;
  /** Anything a person does on the pad, or any status change, wakes the lights and restarts the auto-dim clock. */
  function activity() {
    lastActivity = Date.now();
    if (dimmed) { dimmed = false; lastSent = ""; log("auto-dim: wake"); schedule(true); }
  }
  const OFF = { e: 0, b: 0, s: 0, m: 0, c: 0 };

  // ---- many daemons, one pad (see the comment above announcedUrl)
  let host = null, finding = false;   // base URL of the daemon that has the pad, when it is not this one
  let tsCache = { at: 0, ips: [] };   // tailnet peer IPs; spawning tailscale is not free, so cache for 20 s
  async function tailnetIps() { if (Date.now() - tsCache.at > 20000) tsCache = { at: Date.now(), ips: await tailscalePeers() }; return tsCache.ips; }
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^\[|\]$/g, ""); } catch { return ""; } };
  const peerUrls = async () => [...new Set([...(await tailnetIps()).map((ip) => `http://${ip}:${cfg.port}`), ...(cfg.peers || [])])];
  /** Only a machine Tailscale (or cfg.peers) vouches for may become this daemon's host: otherwise anything that can reach
   *  the open port could announce itself as the pad and answer this machine's permission prompts. Loopback always allowed. */
  const knownIps = async () => new Set([...(await tailnetIps()), ...(cfg.peers || []).map(hostOf), "127.0.0.1", "::1"]);
  const isPeer = async (u) => (await knownIps()).has(hostOf(u));
  /** A real host answers /state with host:"self"; a relay proxies ITS host's /state, which would otherwise look the same
   *  (device.connected true) — so a relay must never be mistaken for the pad's host. */
  const probe = async (u) => { try { const r = await request("GET", u + "/state", null, 1500); const j = JSON.parse(r.body); return r.status === 200 && j.host === "self" && !!(j.device && j.device.connected); } catch { return false; } };
  async function adopt(u, why) { if (pad || host || !(await isPeer(u)) || !(await probe(u))) return; if (pad || host) return; host = u; log(`pad is on ${u} (${why})`); } // re-check after the awaits: no last-write-wins
  async function findHost() {
    if (pad || host || finding) return;
    finding = true;
    try { for (const u of await peerUrls()) { if (host) break; await adopt(u, "found"); } } finally { finding = false; }  // first real host wins; sequential = no race
  }
  const announce = async (on) => Promise.all((await peerUrls()).map((u) => request("POST", u + "/announce", { port: cfg.port, pad: on }, 2000).catch(() => {})));
  /** Forward a hook to the host and hand its answer back; a hold is proxied for as long as the hook's curl waits. */
  function relay(req, res, body) {
    const to = host; let gaveUp = false;
    const up = http.request(to + "/hook", { method: "POST", headers: { "Content-Type": "application/json", "x-cm2-relayed": "1" }, timeout: (cfg.holdMs || 0) + 10000 }, (r) => { res.writeHead(r.statusCode || 200, { "Content-Type": "application/json" }); r.pipe(res); });
    up.on("error", (e) => { if (gaveUp) return; log(`relay to ${to} failed: ${e.message}`); if (host === to) { host = null; setTimeout(findHost, 1000); } if (!res.headersSent) respond(res); else res.destroy(); });
    up.on("timeout", () => up.destroy(new Error("timeout")));
    res.on("close", () => { gaveUp = true; up.destroy(); });   // the hook gave up (curl timeout): release the host's hold too; not the host's fault
    up.end(body);
  }
  const proxyGet = (u, res) => request("GET", u, null, 3000).then((r) => { let b = r.body; try { b = JSON.stringify({ ...JSON.parse(b), host }); } catch { /* pass it through */ } res.writeHead(r.status || 502, { "Content-Type": "application/json" }); res.end(b); }, (e) => respond(res, { error: `host ${host}: ${e.message}` }, 502));

  const respond = (res, obj, status) => { res.writeHead(status || (obj ? 200 : 204), { "Content-Type": "application/json" }); res.end(obj ? JSON.stringify(obj) : undefined); };
  const decision = (d) => (d ? { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: d, ...(d === "deny" ? { message: "Rejected on the Creator Micro" } : {}) } } : null);

  async function push(force) {
    if (!pad || dimmed) return;
    if (cfg.focusDowngrade && claudeFocused) engine.downgradeSelected();
    const { threads, top } = engine.render();
    if (flash && flash.until <= Date.now()) flash = null;
    const sel = engine.selected && engine.sessions.get(engine.selected);
    let ambient = talkHeld ? VOICE_AMBIENT
      : dialActive() ? { e: 2, b: cfg.brightness, s: 0.4, m: 0, c: cfg.colors.working }
      : cfg.ambientMode === "codex" ? (sel && sel.state === "working" ? { e: 2, b: cfg.brightness, s: 0.4, m: 0, c: cfg.colors.working } : flash ? { e: 1, b: cfg.brightness, s: 0, m: 0, c: flash.color } : OFF)
      : zone(cfg.ambient[top], cfg.colors[top], cfg.brightness);
    if (dialActive()) threads[0] = { id: 0, c: cfg.colors.error, b: cfg.brightness, e: 1, s: 0, sk: 0, sa: 0 };   // AG00 is Escape while navigating
    const keys = talkHeld ? { e: 1, b: cfg.brightness, s: 0, m: 0, c: cfg.colors.error } : flash ? { e: 1, b: cfg.brightness, s: 0, m: 0, c: flash.color } : keysZone;
    const payload = JSON.stringify([threads, ambient, keys]);
    if (!force && payload === lastSent) return;
    try {
      await pad.setThreads(threads);
      await pad.setZones(ambient, keys);
      lastSent = payload; pushFails = 0;
    } catch (e) {
      log("push failed:", e.message);
      if (++pushFails >= 3 && dropPad) { log("pad unresponsive, reconnecting"); dropPad(); }
    }
  }
  const schedule = (force) => { clearTimeout(pushTimer); pushTimer = setTimeout(() => push(force), 80); save(); };

  // thstatus only lights keys the keymap declares as agent keys. The Work Louder Input app syncs its own profile
  // onto the pad and strips them, after which every lighting call still ACKs and renders nothing. So: count them,
  // and put just the KV_OAI_* keys back when they are missing — unless Input is running, in which case a write
  // would only start a war with it. Other keys on the layer are left exactly as they are.
  async function checkAgentKeys(km, st) {
    const active = km?.profiles?.[km.activeProfileId ?? 0]?.layers?.[(st?.layer_index || 1) - 1];
    let n = (active?.layout?.keymap || []).flat().filter((k) => /^KV_OAI_AG/.test(k || "")).length;
    if (!km || n) return n;
    if (inputAppRunning()) { log("WARNING: no agent keys on the active layer and the Input app is running (it rewrites the keymap). Close it; the daemon will restore the keys."); return 0; }
    try {
      await pad.writeKeymap(agentKeymap(km, cfg.layout.map((r) => r.map((k) => (/^KV_OAI_/.test(k || "") ? k : null))), cfg.actions));
      n = cfg.layout.flat().filter((k) => /^KV_OAI_AG/.test(k || "")).length;
      log(`agent keys were missing from the pad keymap (Input app?) - restored ${n}`);
      lastSent = "";
    } catch (e) { log("could not restore agent keys:", e.message); }
    return n;
  }

  function answer(which) {
    // APPR/REJ target: the selected session's pending prompt; else the only pending one; several and none selected = ambiguous
    const ids = [...holds.keys()];
    const id = holds.has(engine.selected) ? engine.selected : ids.length === 1 ? ids[0] : null;
    if (!id) { log(`${which}: ${ids.length ? "ambiguous, press that session's agent key first" : "nothing pending"}`); return; }
    holds.get(id)(which === "approve" ? "allow" : "deny"); holds.delete(id);
    const s = engine.sessions.get(id); if (s) s.state = "working";
    log(`${which} -> ${id.slice(0, 8)}`);
    schedule();
  }
  /** Recording on/off: the shortcut first (the mic matters more than the light), then one RPC for the light. */
  function setTalk(on) {
    if (on === talkHeld) return;
    talkHeld = on;
    sendKeys(cfg.talkKeys, cfg.talkMode === "hold" ? (on ? "d" : "u") : "t");
    log(`talk: ${on ? "listening" : "stop"}`);
    if (pad && !dimmed) {
      const { top } = engine.render();
      pad.setZones(on ? VOICE_AMBIENT : zone(cfg.ambient[top], cfg.colors[top], cfg.brightness), on ? { e: 1, b: cfg.brightness, s: 0, m: 0, c: cfg.colors.error } : keysZone).catch((e) => log("talk light:", e.message));
      lastSent = "";
    }
  }
  const ptt = new Ptt(cfg.doubleTapMs, () => setTalk(true), () => setTalk(false));
  /** Dial as a cursor (Codex "composer-navigation"): clockwise = previous option, counter-clockwise = next, click = Enter,
   *  hold 500 ms = open the configurator. Any use makes the pad "navigating" for 2 s (blue snake, AG00 red = Escape). */
  function dial(key, act) {
    dialUntil = Date.now() + 2000; clearTimeout(dialTimer); dialTimer = setTimeout(() => schedule(), 2050);
    if (key === "ENC_CW") { sendKeys([VK.up]); log("dial: previous (Up)"); }
    else if (key === "ENC_CC") { sendKeys([VK.down]); log("dial: next (Down)"); }
    else if (key === "ENC_CLK") {
      if (act === 1) { encConsumed = false; clearTimeout(encHold); encHold = setTimeout(() => { encConsumed = true; openUrl(url()); log("dial held: configurator"); }, 500); }
      else if (act === 0) { clearTimeout(encHold); if (!encConsumed) sendKeys([VK.enter]); }
    }
    schedule();
  }
  function agentKey(slot) {
    if (dialActive() && slot === 0) { sendKeys([VK.esc]); log("AG00 while navigating -> Escape"); return; }
    const now = Date.now();
    if (lastTap && lastTap.slot === slot && now - lastTap.at <= cfg.doubleTapMs) { lastTap = null; raiseClaude(); log(`key AG0${slot} double tap -> raise Claude`); return; }
    lastTap = { slot, at: now };
    const before = engine.selected;
    engine.press(slot);
    const s = engine.selected && engine.sessions.get(engine.selected);
    log(`key AG0${slot} -> select ${s ? s.id.slice(0, 8) : "none"}`);
    if (s) {
      if (engine.selected !== before && cfg.flashMs) { flash = { until: Date.now() + cfg.flashMs, color: cfg.colors[s.state] }; setTimeout(() => schedule(), cfg.flashMs + 50); }
      if (cfg.focusOnPress) {                                   // bring the Claude window to the front now; the deep link
        const d = desktopSession(s.id);                         // navigates to this exact session once Anthropic ungates it
        if (d) { openInClaude(d.localId); log(`  raising "${d.title}"`); } else log("  no desktop session mapping; raising the window");
        raiseClaude();
      }
    }
    schedule();
  }
  function doAction(key, a) {
    if (a.chord) { sendKeys(a.chord); log(`${key}: chord ${a.chord.join("+")}`); }
    else if (a.text !== undefined) { injectText(a.text, a.enter); log(`${key}: typed "${String(a.text).slice(0, 30)}"${a.enter ? " + Enter" : ""}`); }
    else if (a.raise) { raiseClaude(); log(`${key}: raise Claude`); }
    else if (a.open) { openUrl(url()); log(`${key}: open configurator`); }
  }
  function onKey({ key, act } = {}) {
    try {
      activity();
      if (key === cfg.actions.talk) { if (act === 1) ptt.press(); else if (act === 0) ptt.release(); return; }
      if (/^ENC_/.test(key || "")) return dial(key, act);
      if (act !== 1) return;
      const m = /^AG0([0-5])$/.exec(key || "");
      if (m) return agentKey(+m[1]);
      if (key === cfg.actions.approve) return answer("approve");
      if (key === cfg.actions.reject) return answer("reject");
      const a = cfg.actionKeys && cfg.actionKeys[key];
      if (a) return doAction(key, a);
    } catch (e) { log("key handler:", e.message); }
  }
  /** The stick in vendor mode: one shortcut per push past half deflection, re-armed once it returns to rest. */
  function stick({ a, d } = {}) {
    try {
      if (typeof d !== "number") return;
      if (d > 0.1) activity();
      if (d <= 0.1) { stickArmed = true; return; }
      if (!stickArmed || d < 0.5 || !cfg.stick || cfg.stick.mode !== "vendor") return;
      stickArmed = false;
      const dir = sectorOf(a), vks = cfg.stick[dir];
      if (vks && vks.length) { sendKeys(vks); log(`stick ${dir}`); }
    } catch (e) { log("stick handler:", e.message); }
  }

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => {
      if (req.method === "GET" && (req.url === "/" || req.url === "/ui")) {
        if (!pad && host) { res.writeHead(302, { Location: host + "/" }); return res.end(); }   // the configurator lives where the pad is
        return fs.readFile(path.join(__dirname, "ui.html"), (e, html) => { if (e) { res.writeHead(404); return res.end("ui.html missing"); } res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(html); });
      }
      if (req.method === "GET" && req.url === "/config") return respond(res, { config: cfg, keymap: keymapSummary(lastKeymap) });
      if (req.method === "GET" && req.url === "/state") {
        if (!pad && host) return proxyGet(host + "/state", res);
        return respond(res, { device, host: pad ? "self" : host, selected: engine.selected, pending: [...holds.keys()], sessions: [...engine.sessions.values()].map((s) => ({ ...s, cwd: path.basename(s.cwd || ""), title: desktopSession(s.id)?.title })) });
      }
      let ev; try { ev = normalizeEvent(JSON.parse(body || "{}")); } catch { ev = null; }
      if (!ev) return respond(res, { error: "bad json" });
      if (req.method === "POST" && (req.url === "/key" || req.url === "/quit")) {                     // control endpoints: this machine only
        if (!loopback(req)) { res.writeHead(403); return res.end(); }
        if (req.url === "/quit") { respond(res); return stop(); }
        if (ev.joystick) stick(ev.joystick); else onKey(ev); return respond(res);                    // simulate a pad press / stick push (`cm2d press`, `cm2d stick`)
      }
      if (req.method === "POST" && req.url === "/config") {                                     // the GUI's Apply
        (async () => {
          const warnings = [];
          let reprogram;
          try { reprogram = applyConfigPatch(dir, ev, cfg, lastKeymap); } catch (e) { return respond(res, { error: e.message }, 400); }
          log("config updated:", Object.keys(ev).join(", "));
          if (reprogram) { try { await applyLayout(); } catch (e) { warnings.push(`saved, but the pad was not reprogrammed: ${e.message}`); } }
          else if (pad) { keysZone = computeKeysZone(lastKeymap); lastSent = ""; await push(true); }
          respond(res, { ok: true, warnings });
        })().catch((e) => respond(res, { error: e.message }, 500));
        return;
      }
      if (req.method === "POST" && req.url === "/announce") {                                   // another daemon says where the pad is
        const u = announcedUrl(req.socket.remoteAddress, ev.port || cfg.port);
        if (ev.pad) adopt(u, "announced"); else if (host === u) { log(`pad left ${u}`); host = null; setTimeout(findHost, 1000); }
        return respond(res, { ok: true, relay: !pad });
      }
      if (req.method !== "POST" || req.url !== "/hook") { res.writeHead(404); return res.end(); }
      if (!pad && host && !req.headers["x-cm2-relayed"]) return relay(req, res, body);           // this machine has no pad: the host does the work
      const changed = engine.handle(ev);
      if (changed) activity();
      if (changed) { log(`${ev.hook_event_name}${ev.notification_type ? "/" + ev.notification_type : ""} ${String(ev.session_id).slice(0, 8)} -> ${engine.sessions.get(ev.session_id)?.state ?? "gone"} slot ${engine.sessions.get(ev.session_id)?.slot ?? "-"}`); schedule(); }
      if (ev.hook_event_name !== "PermissionRequest" || !cfg.holdMs || !pad || !ev.session_id) return respond(res);
      // hold the prompt open for the pad; the hook script's curl timeout must exceed holdMs
      const id = ev.session_id;
      const done = (d) => { clearTimeout(t); holds.delete(id); respond(res, decision(d)); };
      const t = setTimeout(() => done(null), cfg.holdMs);
      if (holds.has(id)) holds.get(id)(null);
      holds.set(id, done);
      res.on("close", () => { if (holds.get(id) === done) { clearTimeout(t); holds.delete(id); } }); // client gave up (curl timeout)
    });
  });
  server.on("error", (e) => { log("http:", e.message); process.exit(1); });
  server.listen(cfg.port, cfg.bind, () => log(`listening on ${cfg.bind}:${cfg.port}`));

  let tick = 0;
  if (process.platform === "win32") sendKeys(null); // warm up the injector so the first hold-to-talk is instant
  setInterval(async () => {                                        // auto-dim: Codex sends all-off after autoDimMs without input or change
    if (cfg.autoDimMs && pad && !dimmed && Date.now() - lastActivity >= cfg.autoDimMs) {
      dimmed = true; log("auto-dim: lights off");
      try { await pad.setThreads(Array.from({ length: SLOTS }, (_, i) => ({ id: i, ...OFF, sk: 0, sa: 0 }))); await pad.setZones(OFF, OFF); } catch (e) { log("dim failed:", e.message); }
    }
  }, 5000);
  if (process.platform === "win32") setInterval(() => foreground((name) => {   // Codex: looking at the window counts as reading
    const f = name === "claude"; if (f === claudeFocused) return; claudeFocused = f;
    if (f && cfg.focusDowngrade && engine.downgradeSelected()) { log("Claude focused: selected session read"); schedule(); }
  }), 1000);
  setTimeout(findHost, 1500);
  setInterval(() => { if (pad) announce(true); else findHost(); }, 60000);
  setInterval(async () => {
    if (engine.sweep()) schedule();
    if (pad && ++tick % 4 === 0) { try { const st = await pad.status(); const km = await pad.readKeymap(); device.agentKeys = await checkAgentKeys(km, st); lastKeymap = km; Object.assign(device, st); } catch (e) { log("keymap check failed:", e.message); } }
    push(true);
  }, cfg.resyncMs);

  const stop = async () => {
    log("shutting down");
    if (pad) await Promise.race([announce(false), sleep(1000)]);
    if (pad) { try { await pad.setThreads(engine.render().threads.map((t) => ({ ...t, c: 0, b: 0, e: 0 }))); await pad.setZones({ e: 0, b: 0, s: 0, m: 0, c: 0 }, keysZone); } catch { /* best effort */ } await pad.close(); }
    try { fs.unlinkSync(pidfile(dir)); } catch { /* none */ }
    process.exit(0);
  };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);

  // connect loop: the pad drops on sleep / range / battery; just keep reopening it
  let noHid = false;
  for (;;) {
    let info = null;
    try { info = Pad.list()[0]; } catch (e) { if (!noHid) log(`no usable node-hid on this machine: relay only (${String(e.message).split("\n")[0]})`); noHid = true; }
    if (!info) { if (device.connected) log("pad gone"); device = { connected: false }; await sleep(noHid ? 60000 : 3000); continue; }
    try {
      pad = await Pad.open(info);
      // listen from the first moment: an 'error' with no listener would throw and kill the process
      const gone = new Promise((r) => { dropPad = r; pad.on("error", (e) => { log("pad error:", e.message); r(); }); pad.on("close", r); });
      const st = await pad.status();
      const km = await pad.readKeymap().catch(() => null);
      const agentKeys = await checkAgentKeys(km, st);
      lastKeymap = km; keysZone = computeKeysZone(km);
      device = { connected: true, path: info.path, usb: (info.release & 3) === 0, agentKeys, ...st };
      // a config saved while the pad was away (or changed by Input) lands here: reconcile once per connect
      if (km && needsReprogram(km)) { if (inputAppRunning()) log("pad differs from config but the Input app is running; not reprogramming"); else { log("pad differs from config; reprogramming"); await applyLayout(); } }
      log(`pad connected: fw ${st.version} battery ${st.battery}%${st.is_charging ? " charging" : ""} ${device.usb ? "USB" : "BLE"}`);
      pad.on("key", onKey); pad.on("joystick", stick);
      lastSent = ""; pushFails = 0; await push(true);
      host = null; announce(true);
      await gone;
    } catch (e) { log("connect failed:", e.message); }
    dropPad = null;
    if (device.connected) announce(false);
    if (pad) { await pad.close().catch(() => {}); pad = null; }
    device = { connected: false };
    await sleep(2000);
  }
}

// ---------------------------------------------------------------- keymap helpers
/** Write `layout` over layer 1 of the active profile (everything else in the keymap is left alone).
 *  A chord (array of keycodes) becomes an on-pad macro in the keymap's `macros` list, in the shape the Input app
 *  writes: {id, name, actions:[{kc, delay, act}]} with act 1 = press, 2 = click, 0 = release, bound as KA_A<id>. */
function agentKeymap(km, layout, actions, extras = {}) {
  const profile = km.profiles[km.activeProfileId ?? 0], layer = profile.layers[0], rows = layer.layout.keymap;
  if (extras.encoders) layer.layout.encoders = extras.encoders;
  if (extras.joystick) layer.layout.joystick = extras.joystick;
  if (extras.lights) layer.lights = extras.lights;
  if (rows.length !== layout.length || rows.some((r, i) => r.length !== layout[i].length)) throw new Error("layout shape does not match the pad's keymap");
  km.macros = (km.macros || []).filter((m) => !/^cm2d /.test(m.name)); // ours are regenerated every time; the user's stay
  let nextId = Math.max(0, ...km.macros.map((m) => m.id)) + 1;
  layout.forEach((r, i) => r.forEach((k, j) => {
    if (k === null) return;
    if (!Array.isArray(k)) { rows[i][j] = k; return; }
    const mods = k.slice(0, -1), last = k[k.length - 1], id = nextId++;
    km.macros.push({ id, name: `cm2d ${k.join("+")}`, actions: [...mods.map((kc) => ({ kc, delay: 0, act: 1 })), { kc: last, delay: 0, act: 2 }, ...mods.slice().reverse().map((kc) => ({ kc, delay: 0, act: 0 }))] });
    rows[i][j] = `KA_A${id}`;
  }));
  for (const k of Object.values(actions)) if (!rows.flat().includes("KV_OAI_" + k)) throw new Error(`actions.${k} is not on layer 1 after applying the layout`);
  const used = new Set(profile.layers.flatMap((l) => l.layout.keymap.flat()).map((k) => /^KA_A(\d+)$/.exec(k || "")?.[1]).filter(Boolean).map(Number));
  km.macros = km.macros.filter((m) => used.has(m.id) || !/^cm2d /.test(m.name));
  profile.macrosUsed = [...used].sort((a, b) => a - b);
  return km;
}

// ---------------------------------------------------------------- windows autostart
/** Hidden launcher for the logon task. The whole command is wrapped in one extra pair of quotes:
 *  `cmd /c "..."` strips the first and last quote it sees, which would otherwise break the quoted node path. */
function writeLauncher(dir, vbs = path.join(__dirname, "cm2d.vbs")) {   // next to the code; the log goes to the state folder
  const cmd = `cmd /c ""${process.execPath}" "${__filename}" run >> "${path.join(dir, "cm2d.log")}" 2>&1"`;
  const text = `CreateObject("WScript.Shell").Run "${cmd.replace(/"/g, '""')}", 0, False\r\n`;
  fs.writeFileSync(vbs, text);
  // a second copy at a FIXED path (%APPDATA%\cm2-claude\cm2d.vbs), so another machine can start this daemon over ssh
  // without knowing which copy of the code (plugin cache, checkout) it lives in: ssh desktop 'wscript "%APPDATA%\cm2-claude\cm2d.vbs"'
  const fixed = path.join(dir, "cm2d.vbs"); if (fixed !== vbs) { try { fs.writeFileSync(fixed, text); } catch { /* fine */ } }
  return vbs;
}
/** Start the daemon detached from this process: the logon task on Windows (it must live in the interactive session to
 *  inject keys), a plain detached node elsewhere. No-op if one is already running. */
function startDetached(dir, cfg) {
  const pid = readPid(dir);
  if (alive(pid) && pid !== process.pid && isCm2d(pid)) return log(`cm2d already running (pid ${pid})`);
  if (process.platform === "win32") {
    try { execFileSync("schtasks", ["/Query", "/TN", "cm2d"], { stdio: "ignore" }); return execFileSync("schtasks", ["/Run", "/TN", "cm2d"], { stdio: "inherit" }); } catch { /* no task */ }
    return spawn("wscript.exe", [writeLauncher(dir)], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  }
  const out = fs.openSync(path.join(dir, "cm2d.log"), "a");
  spawn(process.execPath, [__filename, "run"], { detached: true, stdio: ["ignore", out, out], env: process.env }).unref();
  log(`started cm2d (log ${path.join(dir, "cm2d.log")})`);
}
function taskCmd(dir, action) {
  if (action === "install") {
    writeLauncher(dir);   // the task runs the FIXED copy (%APPDATA%\cm2-claude\cm2d.vbs), so a plugin update never strands it
    execFileSync("schtasks", ["/Create", "/F", "/TN", "cm2d", "/SC", "ONLOGON", "/RL", "LIMITED", "/TR", `wscript.exe "${path.join(dir, "cm2d.vbs")}"`], { stdio: "inherit" });
    execFileSync("schtasks", ["/Run", "/TN", "cm2d"], { stdio: "inherit" });
  } else {
    try { execFileSync("schtasks", ["/End", "/TN", "cm2d"], { stdio: "ignore" }); } catch { /* not running */ }
    execFileSync("schtasks", ["/Delete", "/F", "/TN", "cm2d"], { stdio: "inherit" });
  }
}

// ---------------------------------------------------------------- cli
async function main(argv) {
  const dir = homeDir(), cmd = argv[0], cfg = loadConfig(dir);
  const get = (u) => new Promise((ok, no) => http.get(`http://127.0.0.1:${cfg.port}${u}`, (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => ok(b)); }).on("error", no));
  const post = (u, o) => new Promise((ok, no) => { const r = http.request(`http://127.0.0.1:${cfg.port}${u}`, { method: "POST", headers: { "Content-Type": "application/json" } }, (res) => { res.resume(); res.on("end", ok); }); r.on("error", no); r.end(JSON.stringify(o)); });
  switch (cmd) {
    case "run": return run(dir);
    case "stop": return stopDaemon(dir, cfg.port);
    case "start": return startDetached(dir, cfg);
    case "restart": await stopDaemon(dir, cfg.port); return startDetached(dir, cfg);
    case "press": return post("/key", { key: argv[1], act: argv[2] === undefined ? 1 : +argv[2] });
    case "stick": return post("/key", { joystick: { a: +argv[1], d: argv[2] === undefined ? 1 : +argv[2] } });
    case "install": case "uninstall": return taskCmd(dir, cmd);
    case "state": return console.log(JSON.stringify(JSON.parse(await get("/state")), null, 2));
    case "demo": {
      const ids = Array.from({ length: SLOTS }, (_, i) => `demo-${i}-${"x".repeat(30)}`);
      const steps = [["SessionStart"], ["UserPromptSubmit"], ["PermissionRequest"], ["Stop"], ["StopFailure"], ["SessionEnd"]];
      for (const [name] of steps) {
        for (const [i, id] of ids.entries()) { const q = post("/hook", { session_id: id, hook_event_name: name, cwd: `/demo/${i}` }); if (name !== "PermissionRequest") await q; else q.catch(() => {}); await sleep(120); }
        console.log(name); await sleep(2500);
        if (name === "PermissionRequest") { await post("/key", { key: "AG02", act: 1 }); console.log("  (pressed AG02: selected key breathes)"); await sleep(2500); }
      }
      return;
    }
  }
  // the pad commands below own the HID channel: pause the daemon (its pushes would interleave with our chunks), resume after
  const daemonWas = await stopDaemon(dir, cfg.port);
  const pad = await Pad.open();
  try {
    switch (cmd) {
      case "status": console.log(JSON.stringify({ ...(await pad.status()), path: pad.info.path, usb: (pad.info.release & 3) === 0 })); break;
      case "backup": fs.writeFileSync(argv[1], JSON.stringify(await pad.readKeymap(), null, 2)); console.log("saved", argv[1]); break;
      case "restore": await pad.writeKeymap(JSON.parse(fs.readFileSync(argv[1], "utf8"))); console.log("restored", argv[1]); break;
      case "setup-keys": {
        const km = await pad.readKeymap();
        const bak = path.join(dir, `keymap.backup-${Date.now()}.json`);
        fs.writeFileSync(bak, JSON.stringify(km, null, 2));
        await pad.writeKeymap(agentKeymap(km, cfg.layout, cfg.actions, padExtras(cfg)));
        console.log("agent keys written; previous keymap saved to", bak); break;
      }
      default: console.error("usage: cm2d run|status|backup F|restore F|setup-keys|install|uninstall|start|stop|restart|press KEY|state|demo"); process.exitCode = 2;
    }
  } finally {
    await pad.close();
    if (daemonWas) startDetached(dir, cfg);
  }
}

module.exports = { Pad, frame, Engine, zone, agentKeymap, applyConfigPatch, writeLauncher, homeDir, readPid, alive, isCm2d, normalizeEvent, desktopSession, padExtras, sectorOf, Ptt, peerIps, announcedUrl, request, run, EFFECT, DEFAULTS };
if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
