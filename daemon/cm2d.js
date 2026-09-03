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
 *   node cm2d.js stop | restart   stop / relaunch the autostart daemon
 *   node cm2d.js press AG00   simulate a pad key (loopback only)
 *   node cm2d.js state        what the running daemon thinks
 *   node cm2d.js demo         walk fake sessions through every colour
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { execFileSync } = require("child_process");

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
  actions: { approve: "ACT07", reject: "ACT08" }, // Codex Micro factory caps: ACT07 = APPR, ACT08 = REJ
  // what `setup-keys` writes to layer 1 (rows of 2/4/4/3). AGnn = agent keys, KV_OAI_ACTnn = keys reported to cm2d,
  // anything else is a plain keycode, null keeps whatever is on the pad. Spare keys default to Esc (interrupt Claude)
  // and inert; shortcuts with modifiers (Win+H voice typing, Ctrl+N) are Input macros: build them in the Input app,
  // then set those positions to null here so setup-keys never overwrites them.
  layout: [
    ["KV_OAI_AG00", "KV_OAI_AG01"],
    ["KV_OAI_AG02", "KV_OAI_AG03", "KV_OAI_AG04", "KV_OAI_AG05"],
    ["KC_ESC", "KV_OAI_ACT07", "KV_OAI_ACT08", "KC_NONE"],
    ["KC_NONE", "KC_NONE", "KC_NONE"],
  ],
};

function loadConfig(dir) {
  const f = path.join(dir, "config.json");
  const user = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
  return { ...DEFAULTS, ...user, colors: { ...DEFAULTS.colors, ...user.colors }, ambient: { ...DEFAULTS.ambient, ...user.ambient }, actions: { ...DEFAULTS.actions, ...user.actions } };
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
const loopback = (req) => /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || "");

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
    const before = this.sessions.get(id)?.slot ?? null; // read before session() may allocate (or steal) a slot
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
      default: return before !== s.slot;
    }
    return was !== s.state || before !== s.slot || name === "SessionStart";
  }
  bySlot(slot) { return [...this.sessions.values()].find((s) => s.slot === slot); }
  /** Agent key pressed: select that session (breathing key) and acknowledge its done/error state. */
  press(slot) {
    const s = this.bySlot(slot);
    if (!s) { this.selected = null; return true; }
    this.selected = this.selected === s.id ? null : s.id;
    if (s.state === "unread" || s.state === "error") s.state = "idle";
    s.seen = this.now();
    return true;
  }
  sweep() {
    const cutoff = this.now() - this.cfg.ttlMs;
    let changed = false;
    for (const s of [...this.sessions.values()]) if (s.seen < cutoff) { this.sessions.delete(s.id); if (this.selected === s.id) this.selected = null; changed = true; }
    return changed;
  }
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
  process.on("uncaughtException", (e) => log("crash guard:", e.stack || e)); // one bad request or odd key event must not end a weeks-long run
  const engine = new Engine(cfg);
  const holds = new Map(); // session id -> respond(decision|null)
  let pad = null, keysZone = { e: 0, b: 0, s: 0, m: 0, c: 0 }, lastSent = "", device = { connected: false }, pushTimer = null;
  let dropPad = null, pushFails = 0; // a handle that stays "open" through BLE sleep answers nothing: after 3 failed pushes, reconnect

  const respond = (res, obj) => { res.writeHead(obj ? 200 : 204, { "Content-Type": "application/json" }); res.end(obj ? JSON.stringify(obj) : undefined); };
  const decision = (d) => (d ? { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: d, ...(d === "deny" ? { message: "Rejected on the Creator Micro" } : {}) } } : null);

  async function push(force) {
    if (!pad) return;
    const { threads, top } = engine.render();
    const ambient = zone(cfg.ambient[top], cfg.colors[top], cfg.brightness);
    const payload = JSON.stringify([threads, ambient, keysZone]);
    if (!force && payload === lastSent) return;
    try {
      await pad.setThreads(threads);
      await pad.setZones(ambient, keysZone);
      lastSent = payload; pushFails = 0;
    } catch (e) {
      log("push failed:", e.message);
      if (++pushFails >= 3 && dropPad) { log("pad unresponsive, reconnecting"); dropPad(); }
    }
  }
  const schedule = (force) => { clearTimeout(pushTimer); pushTimer = setTimeout(() => push(force), 80); };

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
  function onKey({ key, act } = {}) {
    try {
      if (act !== 1) return;
      const m = /^AG0([0-5])$/.exec(key || "");
      if (m) { engine.press(+m[1]); log(`key ${key} -> select ${engine.selected ? engine.selected.slice(0, 8) : "none"}`); return schedule(); }
      if (key === cfg.actions.approve) return answer("approve");
      if (key === cfg.actions.reject) return answer("reject");
    } catch (e) { log("key handler:", e.message); }
  }

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/state") {
        return respond(res, { device, selected: engine.selected, pending: [...holds.keys()], sessions: [...engine.sessions.values()].map((s) => ({ ...s, cwd: path.basename(s.cwd || "") })) });
      }
      let ev; try { ev = normalizeEvent(JSON.parse(body || "{}")); } catch { ev = null; }
      if (!ev) return respond(res, { error: "bad json" });
      if (req.method === "POST" && (req.url === "/key" || req.url === "/quit")) {                     // control endpoints: this machine only
        if (!loopback(req)) { res.writeHead(403); return res.end(); }
        if (req.url === "/quit") { respond(res); return stop(); }
        onKey(ev); return respond(res);                                                              // simulate a pad press (`cm2d press`)
      }
      if (req.method !== "POST" || req.url !== "/hook") { res.writeHead(404); return res.end(); }
      const changed = engine.handle(ev);
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
  setInterval(async () => {
    if (engine.sweep()) schedule();
    if (pad && ++tick % 4 === 0) { try { const st = await pad.status(); device.agentKeys = await checkAgentKeys(await pad.readKeymap(), st); Object.assign(device, st); } catch (e) { log("keymap check failed:", e.message); } }
    push(true);
  }, cfg.resyncMs);

  const stop = async () => {
    log("shutting down");
    if (pad) { try { await pad.setThreads(engine.render().threads.map((t) => ({ ...t, c: 0, b: 0, e: 0 }))); await pad.setZones({ e: 0, b: 0, s: 0, m: 0, c: 0 }, keysZone); } catch { /* best effort */ } await pad.close(); }
    try { fs.unlinkSync(pidfile(dir)); } catch { /* none */ }
    process.exit(0);
  };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);

  // connect loop: the pad drops on sleep / range / battery; just keep reopening it
  for (;;) {
    const info = Pad.list()[0];
    if (!info) { if (device.connected) log("pad gone"); device = { connected: false }; await sleep(3000); continue; }
    try {
      pad = await Pad.open(info);
      // listen from the first moment: an 'error' with no listener would throw and kill the process
      const gone = new Promise((r) => { dropPad = r; pad.on("error", (e) => { log("pad error:", e.message); r(); }); pad.on("close", r); });
      const st = await pad.status();
      const km = await pad.readKeymap().catch(() => null);
      const agentKeys = await checkAgentKeys(km, st);
      const bl = km?.profiles?.[km.activeProfileId ?? 0]?.layers?.[0]?.lights?.backlight;
      keysZone = zone(cfg.keys === "keymap" ? bl : cfg.keys === "off" ? null : cfg.keys, 0xffffff, cfg.brightness);
      device = { connected: true, path: info.path, usb: (info.release & 3) === 0, agentKeys, ...st };
      log(`pad connected: fw ${st.version} battery ${st.battery}%${st.is_charging ? " charging" : ""} ${device.usb ? "USB" : "BLE"}`);
      pad.on("key", onKey);
      lastSent = ""; pushFails = 0; await push(true);
      await gone;
    } catch (e) { log("connect failed:", e.message); }
    dropPad = null;
    if (pad) { await pad.close().catch(() => {}); pad = null; }
    device = { connected: false };
    await sleep(2000);
  }
}

// ---------------------------------------------------------------- keymap helpers
/** Write `layout` over layer 1 of the active profile (everything else in the keymap is left alone). */
function agentKeymap(km, layout, actions) {
  const rows = km.profiles[km.activeProfileId ?? 0].layers[0].layout.keymap;
  if (rows.length !== layout.length || rows.some((r, i) => r.length !== layout[i].length)) throw new Error("layout shape does not match the pad's keymap");
  for (const k of Object.values(actions)) if (!layout.flat().includes("KV_OAI_" + k)) throw new Error(`actions.${k} is not in layout`);
  layout.forEach((r, i) => r.forEach((k, j) => { if (k !== null) rows[i][j] = k; })); // null = keep what the pad has (your Input macros survive)
  return km;
}

// ---------------------------------------------------------------- windows autostart
/** Hidden launcher for the logon task. The whole command is wrapped in one extra pair of quotes:
 *  `cmd /c "..."` strips the first and last quote it sees, which would otherwise break the quoted node path. */
function writeLauncher(dir) {
  const vbs = path.join(dir, "cm2d.vbs");
  const cmd = `cmd /c ""${process.execPath}" "${path.join(dir, "cm2d.js")}" run >> "${path.join(dir, "cm2d.log")}" 2>&1"`;
  fs.writeFileSync(vbs, `CreateObject("WScript.Shell").Run "${cmd.replace(/"/g, '""')}", 0, False\r\n`);
  return vbs;
}
function taskCmd(dir, action) {
  if (action === "install") {
    const vbs = writeLauncher(dir);
    execFileSync("schtasks", ["/Create", "/F", "/TN", "cm2d", "/SC", "ONLOGON", "/RL", "LIMITED", "/TR", `wscript.exe "${vbs}"`], { stdio: "inherit" });
    execFileSync("schtasks", ["/Run", "/TN", "cm2d"], { stdio: "inherit" });
  } else {
    try { execFileSync("schtasks", ["/End", "/TN", "cm2d"], { stdio: "ignore" }); } catch { /* not running */ }
    execFileSync("schtasks", ["/Delete", "/F", "/TN", "cm2d"], { stdio: "inherit" });
  }
}

// ---------------------------------------------------------------- cli
async function main(argv) {
  const dir = __dirname, cmd = argv[0], cfg = loadConfig(dir);
  const get = (u) => new Promise((ok, no) => http.get(`http://127.0.0.1:${cfg.port}${u}`, (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => ok(b)); }).on("error", no));
  const post = (u, o) => new Promise((ok, no) => { const r = http.request(`http://127.0.0.1:${cfg.port}${u}`, { method: "POST", headers: { "Content-Type": "application/json" } }, (res) => { res.resume(); res.on("end", ok); }); r.on("error", no); r.end(JSON.stringify(o)); });
  switch (cmd) {
    case "run": return run(dir);
    case "stop": return stopDaemon(dir, cfg.port);
    case "restart": await stopDaemon(dir, cfg.port); return execFileSync("schtasks", ["/Run", "/TN", "cm2d"], { stdio: "inherit" });
    case "press": return post("/key", { key: argv[1], act: 1 });
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
        await pad.writeKeymap(agentKeymap(km, cfg.layout, cfg.actions));
        console.log("agent keys written; previous keymap saved to", bak); break;
      }
      default: console.error("usage: cm2d run|status|backup F|restore F|setup-keys|install|uninstall|stop|restart|press KEY|state|demo"); process.exitCode = 2;
    }
  } finally {
    await pad.close();
    if (daemonWas) { if (process.platform === "win32") execFileSync("schtasks", ["/Run", "/TN", "cm2d"], { stdio: "inherit" }); else console.log("daemon was stopped; start it again"); }
  }
}

module.exports = { Pad, frame, Engine, zone, agentKeymap, writeLauncher, readPid, alive, isCm2d, normalizeEvent, EFFECT, DEFAULTS };
if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
