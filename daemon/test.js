"use strict";
// No hardware needed: framing bytes, state transitions, slot eviction, zone conversion, keymap rewrite.
const assert = require("assert");
const { frame, Engine, zone, agentKeymap, readPid, alive, padExtras, sectorOf, Ptt, EFFECT, DEFAULTS } = require("./cm2d.js");
const STICKY = { ...DEFAULTS, agentSource: "sticky" };

// framing: 64-byte reports, [6][2][len][payload], long lines split at 61, non-ASCII escaped
{
  const r = frame('{"method":"device.status","params":null,"id":1}');
  assert.equal(r.length, 1); assert.equal(r[0].length, 64);
  assert.deepEqual([r[0][0], r[0][1], r[0][2]], [6, 2, 47]);
  assert.equal(r[0].subarray(3, 50).toString(), '{"method":"device.status","params":null,"id":1}');
  const line = JSON.stringify({ method: "fs.write", params: { file: "k", data: "x".repeat(200) }, id: 2 }), long = frame(line);
  assert.equal(long.length, Math.ceil(line.length / 61)); assert.equal(long.at(-1)[2], line.length - 61 * (long.length - 1));
  assert.equal(Buffer.concat(long.map((r) => r.subarray(3, 3 + r[2]))).toString(), line);
  assert.ok(frame('{"a":"é"}')[0].subarray(3, 20).toString().includes("\\u00e9"));
}

// engine: Codex-style derivation + selection + eviction
{
  let t = 0; const e = new Engine(STICKY, () => t);
  const ev = (session_id, hook_event_name, extra = {}) => e.handle({ session_id, hook_event_name, cwd: "/p/" + session_id, ...extra });
  assert.equal(ev("a", "SessionStart"), true); assert.equal(e.sessions.get("a").slot, 0);
  assert.equal(ev("z", "Notification", { notification_type: "idle_prompt" }), true); // ignored type, but it just got a key: re-render
  assert.equal(ev("z", "Notification", { notification_type: "idle_prompt" }), false); ev("z", "SessionEnd");
  assert.equal(ev("a", "UserPromptSubmit"), true); assert.equal(e.sessions.get("a").state, "working");
  assert.equal(ev("a", "PreToolUse", { tool_name: "Bash" }), false);          // still working: nothing to re-render
  assert.equal(ev("a", "PreToolUse", { tool_name: "AskUserQuestion" }), true); assert.equal(e.sessions.get("a").state, "awaiting");
  ev("a", "PostToolUse"); assert.equal(e.sessions.get("a").state, "working");
  ev("a", "Notification", { notification_type: "permission_prompt" }); assert.equal(e.sessions.get("a").state, "awaiting");
  ev("a", "Notification", { notification_type: "idle_prompt" }); assert.equal(e.sessions.get("a").state, "awaiting"); // ignored
  ev("a", "Stop"); assert.equal(e.sessions.get("a").state, "unread");
  ev("a", "StopFailure"); assert.equal(e.sessions.get("a").state, "error");
  ev("a", "SessionStart", { how_session_started: "compact" }); assert.equal(e.sessions.get("a").state, "error"); // compaction keeps state
  // render: slot 0 red solid, others off, body = error
  let r = e.render();
  assert.equal(r.top, "error"); assert.equal(r.threads[0].c, DEFAULTS.colors.error); assert.equal(r.threads[0].e, EFFECT.solid);
  assert.deepEqual(r.threads[1], { id: 1, c: 0, b: 0, e: 0, s: 0, sk: 0, sa: 0 });
  // agent key press: selects (breath) and acknowledges error -> idle
  e.press(0); assert.equal(e.selected, "a"); r = e.render();
  assert.equal(e.sessions.get("a").state, "idle"); assert.equal(r.threads[0].e, EFFECT.breath); assert.equal(r.threads[0].s, 0.4);
  e.press(0); assert.equal(e.selected, null);
  e.press(5); assert.equal(e.selected, null);                                  // empty slot: no-op
  // body ring priority: awaiting beats everything
  ev("b", "UserPromptSubmit"); ev("c", "PermissionRequest"); assert.equal(e.render().top, "awaiting");
  ev("c", "SessionEnd"); assert.equal(e.render().top, "working"); assert.equal(e.sessions.has("c"), false);
  // eviction: fill six, a seventh takes the stalest idle slot; busy sessions only give way when nothing idle is left
  for (const id of ["d", "e", "f", "g"]) { t++; ev(id, "SessionStart"); }
  assert.equal([...e.sessions.values()].filter((s) => s.slot !== null).length, 6);
  t++; ev("h", "UserPromptSubmit");
  assert.equal(e.sessions.get("h").slot, 0); assert.equal(e.sessions.get("a").slot, null);   // "a" was idle and oldest
  for (const id of ["d", "e", "f", "g"]) ev(id, "UserPromptSubmit");                            // everyone busy now
  t++; ev("i", "UserPromptSubmit"); assert.notEqual(e.sessions.get("i").slot, null);            // still gets a key: stalest busy one gives way
  assert.equal([...e.sessions.values()].filter((s) => s.slot !== null).length, 6);
  // round-trips through JSON (restart persistence), then the ttl sweep
  const e2 = new Engine(STICKY, () => t); e2.load(JSON.parse(JSON.stringify(e)));
  assert.equal(e2.sessions.size, e.sessions.size); assert.equal(e2.selected, e.selected); assert.deepEqual(e2.render(), e.render());
  e2.load(null); e2.load({ sessions: "junk" }); assert.equal(e2.sessions.size, e.sessions.size);   // bad files are ignored
  t += DEFAULTS.ttlMs + 1; assert.equal(e.sweep(), true); assert.equal(e.sessions.size, 0);
}

// "recent" agent source (Codex default): most recently active session on AG00, keys re-sort on every event, presses don't shuffle
{
  let t = 0; const e = new Engine(DEFAULTS, () => t);
  const ev = (id, name) => e.handle({ session_id: id, hook_event_name: name });
  for (const id of ["a", "b", "c"]) { t++; ev(id, "SessionStart"); }
  assert.deepEqual(["a", "b", "c"].map((id) => e.sessions.get(id).slot), [2, 1, 0]);      // c is newest
  t++; assert.equal(ev("a", "UserPromptSubmit"), true); assert.equal(e.sessions.get("a").slot, 0); // a moves to the front
  e.press(1); assert.equal(e.selected, "c"); assert.equal(e.sessions.get("c").slot, 1);   // a press selects but does not re-order
  for (const id of ["d", "e", "f", "g"]) { t++; ev(id, "SessionStart"); }
  assert.equal(e.sessions.get("b").slot, null); assert.equal(e.sessions.get("g").slot, 0);  // seventh session: stalest loses its key
  const before = e.render(); e.selected = "a"; e.sessions.get("a").state = "unread";
  assert.equal(e.downgradeSelected(), true); assert.equal(e.sessions.get("a").state, "idle"); assert.equal(e.downgradeSelected(), false);
  void before;
}

// stick sectors: Codex's table, angle in turns with 0 = right
assert.deepEqual([0, 0.2, 0.5, 0.75, 0.9, 0.12, 0.13].map(sectorOf), ["right", "down", "left", "up", "right", "right", "down"]);

// mic key state machine: hold = talk while held; tap + tap = latched; tap = stop; taps inside the window are ignored
{
  let now = 0, out = []; const p = new Ptt(350, () => out.push("start"), () => out.push("stop"), () => now);
  p.press(); now += 600; p.release(); assert.deepEqual(out, ["start", "stop"]); assert.equal(p.state, "idle");   // classic hold
  out = []; p.press(); now += 100; p.release(); assert.deepEqual(out, ["start"]); assert.equal(p.state, "waiting");
  now += 100; p.press(); assert.equal(p.state, "latched"); assert.deepEqual(out, ["start"]);                       // second tap latches
  now += 5000; p.release(); assert.equal(p.state, "latched");
  p.press(); assert.deepEqual(out, ["start", "stop"]); assert.equal(p.state, "suppressing");                        // next tap stops
  now += 100; p.press(); assert.equal(p.state, "suppressing");                                                     // too soon: ignored
  now += 400; p.press(); assert.equal(p.state, "pressed"); assert.deepEqual(out, ["start", "stop", "start"]);
  now += 400; p.release(); assert.equal(p.state, "idle");
}

// pad extras follow the dial and stick modes
assert.deepEqual(padExtras(DEFAULTS).encoders, [["KV_OAI_ENC_CC", "KV_OAI_ENC_CW", "KV_OAI_ENC_CLK"]]);
assert.deepEqual(padExtras(DEFAULTS).joystick, { type: "VENDOR", sectors: [] });
assert.deepEqual(padExtras({ ...DEFAULTS, dial: "keymap", stick: { mode: "keymap" }, encoders: [["KC_A", "KC_B", "KC_C"]], joystick: null }).encoders, [["KC_A", "KC_B", "KC_C"]]);
assert.equal(padExtras({ ...DEFAULTS, dial: "keymap", stick: { mode: "keymap" }, joystick: null }).joystick, null);

// zone conversion mirrors the vendor app's {e,b,s,m,c} sides
assert.deepEqual(zone({ effect: "rainbow", brightness: 1, speed: 0.55, magic: 1, color: 16777215 }), { e: 3, b: 1, s: 0.55, m: 1, c: 16777215 });
assert.deepEqual(zone({ effect: "off" }), { e: 0, b: 0, s: 0, m: 0, c: 0 });
assert.deepEqual(zone(DEFAULTS.ambient.awaiting, 0xff6d00, 1), { e: 4, b: 1, s: 0.5, m: 0, c: 0xff6d00 });
assert.deepEqual(zone(null), { e: 0, b: 0, s: 0, m: 0, c: 0 });
// keys-zone default: "off" -> dark (Codex keeps the key backlight off almost always)
{ const cfg = "off"; const bl = { effect: "solid", color: 0xffffff, brightness: 1 };
  assert.deepEqual(zone(cfg === "keymap" ? bl : cfg === "off" ? null : cfg, 0xffffff, 1), { e: 0, b: 0, s: 0, m: 0, c: 0 }); }

// keymap rewrite: layer 1 gets the layout (agent keys, APPR/REJ, Esc, inert spares); encoders/joystick untouched
{
  const km = { activeProfileId: 0, profiles: [{ layers: [{ layout: { keymap: [["KC_A", "KC_B"], ["KC_C", "KC_D", "KC_E", "KC_F"], ["KC_G", "KC_H", "KC_I", "KC_J"], ["KC_K", "KC_L", "KC_M"]], encoders: [["KC_VOLU", "KC_VOLD", "KC_MPLY"]] } }] }] };
  const out = agentKeymap(km, DEFAULTS.layout, DEFAULTS.actions).profiles[0].layers[0].layout;
  assert.deepEqual(out.keymap, [["KV_OAI_AG00", "KV_OAI_AG01"], ["KV_OAI_AG02", "KV_OAI_AG03", "KV_OAI_AG04", "KV_OAI_AG05"], ["KC_ESC", "KV_OAI_ACT07", "KV_OAI_ACT08", "KC_NONE"], ["KV_OAI_ACT10", "KC_NONE", "KC_NONE"]]);
  assert.deepEqual(out.encoders, [["KC_VOLU", "KC_VOLD", "KC_MPLY"]]);              // dial untouched
  assert.deepEqual(km.macros || [], []); assert.deepEqual(km.profiles[0].macrosUsed, []);
  // a chord becomes an on-pad macro: Win held, H clicked, Win released; bound as KA_A<id>; profile lists it as used
  const chords = JSON.parse(JSON.stringify(DEFAULTS.layout)); chords[3][1] = ["KC_LGUI", "KC_H"];
  assert.equal(agentKeymap(km, chords, DEFAULTS.actions).profiles[0].layers[0].layout.keymap[3][1], "KA_A1");
  assert.deepEqual(km.macros, [{ id: 1, name: "cm2d KC_LGUI+KC_H", actions: [{ kc: "KC_LGUI", delay: 0, act: 1 }, { kc: "KC_H", delay: 0, act: 2 }, { kc: "KC_LGUI", delay: 0, act: 0 }] }]);
  assert.deepEqual(km.profiles[0].macrosUsed, [1]);
  agentKeymap(km, chords, DEFAULTS.actions); assert.equal(km.macros.length, 1);          // idempotent: re-running does not pile up macros
  agentKeymap(km, DEFAULTS.layout, DEFAULTS.actions); assert.equal(km.macros.length, 0);  // chord removed from the layout: its macro goes too
  // dial / joystick / stored lighting: written only when given, otherwise left alone
  const L = km.profiles[0].layers[0];
  agentKeymap(km, DEFAULTS.layout, DEFAULTS.actions, { encoders: [["KC_UP", "KC_DOWN", "KC_ENT"]], joystick: { type: "JOYSTICK", sectors: [] } });
  assert.deepEqual(L.layout.encoders, [["KC_UP", "KC_DOWN", "KC_ENT"]]); assert.deepEqual(L.layout.joystick, { type: "JOYSTICK", sectors: [] });
  agentKeymap(km, DEFAULTS.layout, DEFAULTS.actions, { encoders: null }); assert.deepEqual(L.layout.encoders, [["KC_UP", "KC_DOWN", "KC_ENT"]]);
  // repair layout = only the KV_OAI_* positions; every other key on the layer is left alone
  const repair = DEFAULTS.layout.map((r) => r.map((k) => (/^KV_OAI_/.test(k) ? k : null)));
  const km2 = { activeProfileId: 0, profiles: [{ layers: [{ layout: { keymap: [["KC_A", "KC_B"], ["KC_C", "KC_D", "KC_E", "KC_F"], ["KM_7", "KC_H", "KC_I", "KC_J"], ["KC_K", "KC_L", "KC_M"]] } }] }] }; // stock pad + a user macro on row 3
  const fixed = agentKeymap(km2, repair, DEFAULTS.actions).profiles[0].layers[0].layout.keymap;
  assert.deepEqual(fixed[0], ["KV_OAI_AG00", "KV_OAI_AG01"]); assert.equal(fixed[2][0], "KM_7"); assert.equal(fixed[3][1], "KC_L");
  const keep = JSON.parse(JSON.stringify(DEFAULTS.layout)); keep[3][0] = null;
  assert.equal(agentKeymap(km, keep, DEFAULTS.actions).profiles[0].layers[0].layout.keymap[3][0], "KV_OAI_ACT10"); // null keeps the pad's key
  assert.throws(() => agentKeymap(km, [["KC_A"]], DEFAULTS.actions), /shape/);       // wrong pad
  assert.throws(() => agentKeymap(km, DEFAULTS.layout, { approve: "ACT06", reject: "ACT08", talk: "ACT10" }), /ACT06/); // action key missing from layout
}
// pidfile guard: missing file -> 0, dead pid -> not alive, our own pid -> alive
{ const os = require("os"), fs = require("fs"), p = require("path");
  const d = fs.mkdtempSync(p.join(os.tmpdir(), "cm2d-")); assert.equal(readPid(d), 0);
  fs.writeFileSync(p.join(d, "cm2d.pid"), "2147480000"); assert.equal(alive(readPid(d)), false); // a pid that will not exist
  fs.writeFileSync(p.join(d, "cm2d.pid"), String(process.pid)); assert.equal(alive(readPid(d)), true); }
// pid guard: our own pid is a cm2d process (test.js requires cm2d.js, so the cmdline says test.js — make the check honest)
{ const { isCm2d, alive } = require("./cm2d.js"); assert.equal(alive(process.pid), true); assert.equal(alive(999999), false); assert.equal(typeof isCm2d(process.pid), "boolean"); }
// hook bodies off the wire: non-objects rejected, session ids coerced to strings (they are Map keys and get sliced for logs)
{ const { normalizeEvent } = require("./cm2d.js");
  assert.equal(normalizeEvent(null), null); assert.equal(normalizeEvent([1]), null); assert.equal(normalizeEvent("x"), null);
  assert.equal(normalizeEvent({ session_id: 1 }).session_id, "1"); assert.equal(normalizeEvent({}).session_id, undefined); }
// desktop session lookup: <store>/<account>/<org>/local_*.json, matched on cliSessionId
{ const { desktopSession } = require("./cm2d.js"), os = require("os"), fs = require("fs"), p = require("path");
  const root = fs.mkdtempSync(p.join(os.tmpdir(), "ccs-")), d = p.join(root, "acct", "org"); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(p.join(d, "local_aaa.json"), JSON.stringify({ sessionId: "local_aaa", cliSessionId: "11111111-1111-1111-1111-111111111111", title: "One" }));
  fs.writeFileSync(p.join(d, "local_bbb.json"), JSON.stringify({ sessionId: "local_bbb", cliSessionId: "22222222-2222-2222-2222-222222222222", title: "Two" }));
  fs.writeFileSync(p.join(d, "deleted_x"), "11111111-1111-1111-1111-111111111111");                    // not a session file
  assert.deepEqual(desktopSession("22222222-2222-2222-2222-222222222222", root), { localId: "local_bbb", title: "Two" });
  assert.equal(desktopSession("33333333-3333-3333-3333-333333333333", root), null);
  assert.equal(desktopSession("11111111-1111-1111-1111-111111111111", p.join(root, "nope")), null); }
// config patches from the GUI: allowlist, deep merge for the small maps, dry-run validation against the pad's keymap
{ const { applyConfigPatch } = require("./cm2d.js"), os = require("os"), fs = require("fs"), p = require("path");
  const dir = fs.mkdtempSync(p.join(os.tmpdir(), "cm2cfg-")), cfg = JSON.parse(JSON.stringify(DEFAULTS));
  const km = { activeProfileId: 0, profiles: [{ layers: [{ layout: { keymap: [["KC_A", "KC_B"], ["KC_C", "KC_D", "KC_E", "KC_F"], ["KC_G", "KC_H", "KC_I", "KC_J"], ["KC_K", "KC_L", "KC_M"]], encoders: [["KC_VOLU", "KC_VOLD", "KC_MPLY"]] } }] }] };
  assert.equal(applyConfigPatch(dir, { brightness: 0.5, colors: { error: 0x123456 } }, cfg, km), false);
  assert.equal(cfg.brightness, 0.5); assert.equal(cfg.colors.error, 0x123456); assert.equal(cfg.colors.idle, DEFAULTS.colors.idle);
  const saved = JSON.parse(fs.readFileSync(p.join(dir, "config.json"), "utf8")); assert.deepEqual(saved, { brightness: 0.5, colors: { error: 0x123456 } });
  assert.equal(applyConfigPatch(dir, { encoders: [["KC_UP", "KC_DOWN", "KC_ENT"]] }, cfg, km), true);       // pad-facing: reprogram
  assert.throws(() => applyConfigPatch(dir, { port: 1 }, cfg, km), /not editable/);
  assert.throws(() => applyConfigPatch(dir, { layout: [["KC_A"]] }, cfg, km), /shape/);                       // rejected before saving
  assert.equal(JSON.parse(fs.readFileSync(p.join(dir, "config.json"), "utf8")).layout, undefined);
  assert.throws(() => applyConfigPatch(dir, { actions: { approve: "ACT06" } }, cfg, km), /ACT06/); }
// state folder: CM2_HOME wins, is created, and old files next to the code are copied in once
{ const os = require("os"), fs = require("fs"), p = require("path"), { homeDir } = require("./cm2d.js");
  const h = p.join(fs.mkdtempSync(p.join(os.tmpdir(), "cm2home-")), "state"); process.env.CM2_HOME = h;
  assert.equal(homeDir(), h); assert.ok(fs.existsSync(h)); delete process.env.CM2_HOME; }
console.log("ok");

// ---- many daemons, one pad: tailscale parsing, announce URL, and a relay in front of a fake host (no pad, no node-hid needed)
{ const { peerIps, announcedUrl } = require("./cm2d.js");
  assert.deepEqual(peerIps({ Peer: { a: { Online: true, TailscaleIPs: ["fd7a::1", "100.1.2.3"] }, b: { Online: false, TailscaleIPs: ["100.9.9.9"] }, c: { Online: true } } }), ["100.1.2.3"]);
  assert.deepEqual(peerIps(null), []);
  assert.equal(announcedUrl("::ffff:100.1.2.3", 7777), "http://100.1.2.3:7777");
  assert.equal(announcedUrl("fd7a::1", 7000), "http://[fd7a::1]:7000");
}
(async () => {
  const { run, request } = require("./cm2d.js"), os = require("os"), fs = require("fs"), p = require("path"), http = require("http");
  process.env.CM2_TAILSCALE = "/nonexistent-cm2-test-tailscale"; // hermetic: never probe the real tailnet
  const fake = (name, hostField = "self") => { // stand-in daemon: /state host:"self" = it holds the pad, else a relay; records /hook; can hold a PermissionRequest
    const f = { name, got: [], closed: 0, hold: null, connected: true, hostField };
    f.server = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      if (req.url === "/state") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ device: { connected: f.connected }, host: f.hostField, sessions: [], name })); }
      if (req.url === "/announce") { res.writeHead(200); return res.end("{}"); }
      const ev = JSON.parse(b); f.got.push({ ev, relayed: req.headers["x-cm2-relayed"] });
      if (ev.hook_event_name === "PermissionRequest") { f.hold = (d) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ hookSpecificOutput: { decision: d } })); }; res.on("close", () => f.closed++); return; }
      res.writeHead(204); res.end();
    }); });
    return new Promise((ok) => f.server.listen(0, "127.0.0.1", () => { f.port = f.server.address().port; f.url = `http://127.0.0.1:${f.port}`; ok(f); }));
  };
  const A = await fake("A"), C = await fake("C"), R = await fake("R", "http://198.51.100.7:7777"); // R is a relay (host != self): must never be adopted
  const dir = fs.mkdtempSync(p.join(os.tmpdir(), "cm2relay-"));
  const port = 17000 + Math.floor(Math.random() * 1000);
  fs.writeFileSync(p.join(dir, "config.json"), JSON.stringify({ port, bind: "127.0.0.1", peers: [R.url, A.url], holdMs: 5000, autoDimMs: 0 })); // R first: a relay must be skipped over
  run(dir).catch((e) => { console.error("relay run failed:", e); process.exit(1); });
  const me = `http://127.0.0.1:${port}`;
  const until = async (f, what) => { for (let i = 0; i < 100; i++) { if (await f()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error("timed out waiting for " + what); };
  const name = async () => { try { return JSON.parse((await request("GET", me + "/state")).body).name; } catch { return null; } };
  await until(async () => (await name()) === "A", "relay to adopt the real host A, not the relay R");
  assert.equal(R.got.length, 0);  // R was probed, found to be a relay, and never forwarded to
  await request("POST", me + "/hook", { session_id: "s1", hook_event_name: "Stop" });
  assert.equal(A.got.length, 1); assert.equal(A.got[0].relayed, "1"); assert.equal(A.got[0].ev.session_id, "s1");
  // a hold is proxied: the host's answer comes back through the relay
  const held = request("POST", me + "/hook", { session_id: "s1", hook_event_name: "PermissionRequest" }, 8000);
  await until(async () => A.hold, "hold to reach A"); A.hold("allow");
  assert.equal(JSON.parse((await held).body).hookSpecificOutput.decision, "allow");
  // the hook giving up (curl timeout) releases the host's hold too
  A.hold = null;
  const q = http.request(me + "/hook", { method: "POST", headers: { "Content-Type": "application/json" } }); q.on("error", () => {}); q.end(JSON.stringify({ session_id: "s2", hook_event_name: "PermissionRequest" }));
  await until(async () => A.hold, "second hold"); q.destroy();
  await until(async () => A.closed >= 1, "host to see the client go");
  // the pad moves A -> C: A loses it (its /state goes disconnected) and announces off; C has it and announces on
  A.connected = false;
  await request("POST", me + "/announce", { port: A.port, pad: false });
  await request("POST", me + "/announce", { port: C.port, pad: true });
  await until(async () => (await name()) === "C", "relay to adopt C after the pad moved");
  await request("POST", me + "/hook", { session_id: "s3", hook_event_name: "Stop" });
  assert.equal(C.got.length, 1); assert.equal(A.got.length, 3);   // A saw s1 Stop, s1 hold, s2 hold; nothing after the switch
  // a relayed request is never forwarded again (no loops): the relay handles it itself
  await request("POST", me + "/hook", { session_id: "s4", hook_event_name: "Stop" }, 2000).then(() => {});
  const r = await new Promise((ok, no) => { const x = http.request(me + "/hook", { method: "POST", headers: { "Content-Type": "application/json", "x-cm2-relayed": "1" } }, (res) => { res.resume(); res.on("end", () => ok(res.statusCode)); }); x.on("error", no); x.end(JSON.stringify({ session_id: "s5", hook_event_name: "Stop" })); });
  assert.equal(r, 204); assert.equal(C.got.length, 2);
  console.log("relay ok");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
