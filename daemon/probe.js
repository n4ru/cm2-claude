// Ablation: drive the pad directly (daemon must be stopped first) with an unmistakable bright pattern,
// print every device reply, then hold the frame so it can be seen. No guessing — watch the pad.
const { Pad } = require("./cm2d.js");
(async () => {
  const pad = await Pad.open();
  pad.on("error", (e) => console.log("pad error:", e.message));
  const st = await pad.status();
  console.log("status:", JSON.stringify(st));
  const km = await pad.readKeymap().catch((e) => (console.log("keymap read failed:", e.message), null));
  if (km) {
    const L = km.profiles[km.activeProfileId ?? 0].layers;
    console.log("active layer_index (1-based):", st.layer_index, "-> layers[", st.layer_index - 1, "]");
    console.log("layer1 keymap:", JSON.stringify(L[0].layout.keymap));
    console.log("layer1 lights:", JSON.stringify(L[0].lights));
    const ag = L[st.layer_index - 1].layout.keymap.flat().filter((k) => /KV_OAI_AG/.test(k));
    console.log("agent keys on the ACTIVE layer:", ag.length ? ag.join(",") : "NONE  <-- thstatus will light nothing");
  }
  const C = [0xff0000, 0x00ff00, 0x0000ff, 0xffffff, 0xff8000, 0xff00ff];
  const threads = C.map((c, i) => ({ id: i, c, b: 1, e: 1, s: 0, sk: 0, sa: 0 }));
  console.log("thstatus reply:", JSON.stringify(await pad.setThreads(threads).catch((e) => "ERR " + e.message)));
  console.log("rgbcfg reply:", JSON.stringify(await pad.setZones({ e: 1, b: 1, s: 0, m: 0, c: 0xffffff }, { e: 0, b: 0, s: 0, m: 0, c: 0 }).catch((e) => "ERR " + e.message)));
  console.log("lights.preview reply:", JSON.stringify(await pad.rpc("lights.preview", { backlight: { effect: "solid", brightness: 1, speed: 0, color: 0x00ffff }, underglow: { effect: "solid", brightness: 1, speed: 0, color: 0x00ffff } }).catch((e) => "ERR " + e.message)));
  console.log("HOLDING the pattern for 15s — LOOK NOW: AG00 red, AG01 green, AG02 blue, AG03 white, AG04 amber, AG05 magenta, ring white.");
  await new Promise((r) => setTimeout(r, 15000));
  await pad.close();
})().catch((e) => { console.error("probe failed:", e.message); process.exit(1); });
