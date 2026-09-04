"use strict";
// No hardware needed: framing bytes, state transitions, slot eviction, zone conversion, keymap rewrite.
const assert = require("assert");
const { frame, Engine, zone, agentKeymap, readPid, alive, EFFECT, DEFAULTS } = require("./cm2d.js");

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
  let t = 0; const e = new Engine(DEFAULTS, () => t);
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
  const e2 = new Engine(DEFAULTS, () => t); e2.load(JSON.parse(JSON.stringify(e)));
  assert.equal(e2.sessions.size, e.sessions.size); assert.equal(e2.selected, e.selected); assert.deepEqual(e2.render(), e.render());
  e2.load(null); e2.load({ sessions: "junk" }); assert.equal(e2.sessions.size, e.sessions.size);   // bad files are ignored
  t += DEFAULTS.ttlMs + 1; assert.equal(e.sweep(), true); assert.equal(e.sessions.size, 0);
}

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
// launcher: the command handed to cmd /c must be wrapped in one outer pair of quotes (cmd strips the first and last)
{
  const { writeLauncher } = require("./cm2d.js"), os = require("os");
  const vbs = require("fs").readFileSync(writeLauncher(os.tmpdir()), "utf8");
  const cmd = /Run "(.*)", 0, False/.exec(vbs)[1].replace(/""/g, '"');
  assert.ok(cmd.startsWith('cmd /c ""') && cmd.endsWith('2>&1"'), cmd);
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
console.log("ok");
