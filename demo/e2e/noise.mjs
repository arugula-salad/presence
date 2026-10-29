// The microphone's noise filter (Krisp, Standard or Off), in headless
// Chromium with fake microphones against a relay and LiveKit Cloud
// (staging: Krisp needs LiveKit Cloud, so a local LiveKit shows the
// fallback instead). Ada and Bo are in a demo room's voice channel; Ada's
// fake microphone plays speech (a voiced "ah", on and off) over a steady
// hiss, Bo stays muted and measures what he hears of her.
//
//   1. Krisp starts: Ada's noise choice says Krisp is on her microphone
//      (Krisp's processor enabled, after LiveKit's check of the room's
//      token), the track she sends is the processor's, not the raw
//      microphone's, and LiveKit's check and Krisp's models answered. If
//      LiveKit refuses Krisp, the exact reason and that she fell back to
//      Standard, with audio still going out.
//   2. Ada unmutes and switches krisp → standard → off → krisp in voice:
//      each time the same LiveKit connection (no rejoin), audio still
//      going out and reaching Bo, the microphone opened with the expected
//      constraints (echo cancellation always; the browser's suppression
//      for Standard alone) and the processor on it for Krisp alone. Bo's
//      quiet-moment level (the hiss) per mode shows what each takes out.
//   3. Muted, Ada switches to Standard; unmuted, it's still Standard.
//   4. Ada reloads: her choice is kept (localStorage), and voice opens her
//      microphone with it.
//   5. A call: Ada waves at Bo, Bo says Talk; the call opens her
//      microphone with the same choice, and she switches to Krisp in it.
//
//   node e2e/noise.mjs [https://arugula-stream-staging.fly.dev] [--expect-fallback]
//
// --expect-fallback (a local LiveKit, or a browser Krisp doesn't run in):
// Krisp's absence is the expected result, and the run checks the fallback
// instead. Screenshots go to e2e/out/ (not kept in git).

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const relay = (args.find((a) => !a.startsWith("--")) ?? process.env.RELAY ?? "https://arugula-stream-staging.fly.dev").replace(/\/$/, "");
const expectFallback = args.includes("--expect-fallback");
const out = fileURLToPath(new URL("./out/", import.meta.url));
mkdirSync(out, { recursive: true });

const step = (what) => console.log(`· ${what}`);
let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? "  ok" : "  FAIL"} ${what}`);
  if (!ok) failed = true;
};

// Ada's microphone: 12 s of a voiced "ah" for 1.2 s in every 2 s, over a
// steady hiss (white noise about 26 dB under the voice). The quiet 0.8 s
// is the hiss alone: what a noise filter is for.
function speechOverHiss(path) {
  const rate = 48_000, n = rate * 12;
  const pcm = new Int16Array(n);
  let ph = 0;
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const f0 = 140 + 18 * Math.sin(2 * Math.PI * 0.7 * t) + 6 * Math.sin(2 * Math.PI * 5.1 * t);
    ph += (2 * Math.PI * f0) / rate;
    let s = 0;
    for (let k = 1; k <= 25; k++) {
      const fk = k * f0;
      const g = Math.exp(-(((fk - 750) / 220) ** 2)) + 0.6 * Math.exp(-(((fk - 1200) / 260) ** 2)) + 0.25 * Math.exp(-(((fk - 2600) / 400) ** 2)) + 0.08 / k;
      s += g * Math.sin(k * ph);
    }
    const on = t % 2 < 1.2 ? 1 : 0;
    const voice = on * s * (0.65 + 0.35 * Math.sin(2 * Math.PI * 3.3 * t)) * 6000;
    pcm[i] = Math.max(-32767, Math.min(32767, Math.round(voice + rand() * 900)));
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + n * 2, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(n * 2, 40);
  writeFileSync(path, Buffer.concat([head, Buffer.from(pcm.buffer)]));
}

const wav = `${out}speech-over-hiss.wav`;
speechOverHiss(wav);
const browser = await chromium.launch({
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`, "--autoplay-policy=no-user-gesture-required"],
});

// Before any page script: every microphone getUserMedia (its audio
// constraints and track), every peer connection, and what Krisp fetched
// from LiveKit (host and path, status, and the answer's true/false fields:
// never a token or a URL's query).
const watch = () => {
  window.__mics = [];
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => {
    const s = await gum(c);
    if (c && c.audio) window.__mics.push({ asked: JSON.parse(JSON.stringify(c.audio)), track: s.getAudioTracks()[0] });
    return s;
  };
  window.__pcs = [];
  const PC = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...a) {
    const pc = new PC(...a);
    window.__pcs.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = PC.prototype;
  window.__lk = [];
  const f = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const r = await f(input, init);
    try {
      const u = new URL(url, location.href);
      if (/livekit/.test(u.hostname)) {
        const rec = { at: Math.round(performance.now()), method: init?.method ?? "GET", where: `${u.hostname}${u.pathname}`, status: r.status };
        if ((r.headers.get("content-type") ?? "").includes("json")) {
          const body = await r.clone().json().catch(() => null);
          if (body && typeof body === "object") rec.flags = Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === "boolean"));
        }
        window.__lk.push(rec);
      }
    } catch {}
    return r;
  };
};

const logs = [];
async function context(name) {
  const ctx = await browser.newContext({ permissions: ["microphone", "camera"], viewport: { width: 1280, height: 860 } });
  await ctx.addInitScript(watch);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [${name}] page error: ${e.message}`));
  // Krisp's and LiveKit's own words about the filter (queries cut off).
  page.on("console", (m) => {
    const t = m.text();
    if (/krisp|noise.?filter|enhancedNoise|processor/i.test(t.replace(/noise-proof-\w+/g, "")) || (m.type() === "error" && !/favicon/.test(t))) logs.push(`[${name}] ${m.type()}: ${t.replace(/\?[^\s"')]*/g, "?…").slice(0, 300)}`);
  });
  return page;
}

async function join(page, name, room) {
  await page.goto(`${relay}/r/${room}`);
  const named = page.getByPlaceholder("your name");
  if (await named.isVisible().catch(() => false)) await named.fill(name);
  await page.getByRole("button", { name: "Join the room" }).click();
  await page.locator(".room .bar .stats", { hasText: "here" }).waitFor();
}

const bar = (page) => page.locator(".voicebar");
const choice = (page, where = ".voicebar") => page.locator(`${where} .seg.noise`);

/** The noise choice as the page shows it, and the fallback note. */
const shown = (page, where = ".voicebar") =>
  page.evaluate((where) => {
    // Into open shadow roots too (the SDK's elements draw in them).
    const deep = (sel, root = document) => {
      const hit = root.querySelector(sel);
      if (hit) return hit;
      for (const el of root.querySelectorAll("*")) if (el.shadowRoot) {
        const h = deep(sel, el.shadowRoot);
        if (h) return h;
      }
      return null;
    };
    const seg = deep(`${where} .seg.noise`);
    const note = deep(`${where} ~ .noise-fallback`) ?? deep(`${where} .noise-fallback`);
    return seg && { mode: seg.dataset.mode, active: seg.dataset.active, pressed: seg.querySelector('[aria-checked="true"]')?.textContent, fallback: note ? { text: note.textContent, why: note.title } : null };
  }, where);

/** Until the page's noise choice says `active` (or gives up), then what it shows. */
async function activeIs(page, want, where, ms = 40_000) {
  const t0 = Date.now();
  let s = null;
  while (Date.now() - t0 < ms) {
    s = await shown(page, where);
    if (s && want.includes(s.active)) return s;
    await page.waitForTimeout(200);
  }
  return s;
}

/** Ada's microphone now: the raw track's settings and how it was asked
 * for, the track her sender sends (the raw one or a processor's), what
 * went out over `ms`, and how many peer connections the page has made. */
const sending = (page, ms = 1500) =>
  page.evaluate(async (ms) => {
    const raw = window.__mics.map((m) => m).reverse().find((m) => m.track.readyState === "live");
    const pcs = window.__pcs.filter((pc) => pc.connectionState !== "closed");
    const sent = async () => {
      let packets = 0, bytes = 0;
      for (const pc of pcs) (await pc.getStats()).forEach((s) => s.type === "outbound-rtp" && s.kind === "audio" && ((packets += s.packetsSent ?? 0), (bytes += s.bytesSent ?? 0)));
      return { packets, bytes };
    };
    const a = await sent();
    await new Promise((ok) => setTimeout(ok, ms));
    const b = await sent();
    const senders = pcs.flatMap((pc) => pc.getSenders()).filter((s) => s.track && s.track.kind === "audio");
    const t = senders[0]?.track;
    const st = raw?.track.getSettings() ?? {};
    return {
      pcs: window.__pcs.length,
      opens: window.__mics.length,
      raw: raw && { noiseSuppression: st.noiseSuppression, echoCancellation: st.echoCancellation, autoGainControl: st.autoGainControl, voiceIsolation: st.voiceIsolation, asked: raw.asked },
      sender: t && { processed: t !== raw?.track, label: t.label, state: t.readyState, enabled: t.enabled },
      packets: b.packets - a.packets,
      bytes: b.bytes - a.bytes,
    };
  }, ms);

/** What Bo hears of Ada over `ms`: each 20 ms frame's level in dBFS, the
 * quiet frames (10th percentile: the hiss between her words) and the loud
 * ones (90th: her voice). */
const heard = (page, ms = 4000) =>
  page.evaluate(async (ms) => {
    const el = [...document.querySelectorAll("audio")].find((a) => a.srcObject?.getAudioTracks()[0]?.readyState === "live");
    if (!el) return null;
    const ctx = new AudioContext();
    await ctx.resume();
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    ctx.createMediaStreamSource(el.srcObject).connect(an);
    const buf = new Float32Array(an.fftSize);
    const frames = [];
    for (let t = 0; t < ms; t += 20) {
      await new Promise((r) => setTimeout(r, 20));
      an.getFloatTimeDomainData(buf);
      let e = 0;
      for (const v of buf) e += v * v;
      frames.push(10 * Math.log10(e / buf.length + 1e-12));
    }
    await ctx.close();
    frames.sort((a, b) => a - b);
    const at = (p) => Math.round(frames[Math.floor((frames.length - 1) * p)]);
    return { quiet: at(0.1), loud: at(0.9) };
  }, ms);

const expected = {
  krisp: { noiseSuppression: false, processed: true },
  standard: { noiseSuppression: true, processed: false },
  off: { noiseSuppression: false, processed: false },
};

/** Whether `s` (sending()) is what `mode` should look like, and why not. */
function looksLike(s, mode, muted = false) {
  const e = expected[mode];
  const why = [];
  if (!s.raw) why.push("no live microphone");
  else {
    if (s.raw.echoCancellation !== true) why.push(`echoCancellation ${s.raw.echoCancellation}`);
    if (s.raw.noiseSuppression !== e.noiseSuppression) why.push(`noiseSuppression ${s.raw.noiseSuppression}`);
  }
  if (!s.sender || s.sender.state !== "live") why.push("no live track sent");
  else if (s.sender.processed !== e.processed) why.push(e.processed ? "the raw microphone is sent, not Krisp's" : "a processed track is sent");
  // Muted, Opus sends a trickle of comfort-noise packets, not a stream.
  if (!muted && s.packets < 20) why.push(`only ${s.packets} audio packets in 1.5 s`);
  return why;
}

async function run() {
  const room = `noise-proof-${Date.now().toString(36)}`;
  step(`on ${relay}, room ${room}`);
  const a = await context("Ada");
  const b = await context("Bo");
  await join(a, "Ada", room);
  await join(b, "Bo", room);
  for (const p of [a, b]) await bar(p).getByRole("button", { name: "Join voice" }).waitFor();
  check((await a.evaluate(() => localStorage.getItem("arugula.video.noise"))) === null, "nothing picked in Ada's browser yet");

  step("1. Ada and Bo join voice (muted); Krisp starts on Ada's microphone");
  await bar(b).getByRole("button", { name: "Join voice" }).click();
  await bar(b).getByRole("button", { name: "Unmute" }).waitFor({ timeout: 20_000 });
  const t0 = Date.now();
  await bar(a).getByRole("button", { name: "Join voice" }).click();
  await bar(a).getByRole("button", { name: "Unmute" }).waitFor({ timeout: 20_000 });
  check((await choice(b).count()) === 1 && (await choice(a).count()) === 1, "in voice, the bar has the noise choice");
  const first = await activeIs(a, expectFallback ? ["standard"] : ["krisp", "standard"]);
  // A fallback can follow a moment after (LiveKit's check is after the processor's on).
  await a.waitForTimeout(2500);
  const settled = await shown(a);
  const krispMs = Date.now() - t0;
  console.log(`  Ada's noise choice: ${JSON.stringify(settled)} (first ${JSON.stringify(first?.active)}, ${krispMs} ms after Join voice)`);
  const lk = await a.evaluate(() => window.__lk);
  console.log(`  LiveKit fetches from Ada's page: ${JSON.stringify(lk)}`);
  const s1 = await sending(a);
  console.log(`  Ada's microphone: ${JSON.stringify(s1)}`);
  await a.screenshot({ path: `${out}noise-1-voice-krisp-ada.png` });
  const krispOn = settled?.active === "krisp";
  if (expectFallback) {
    check(settled?.mode === "krisp" && settled?.active === "standard", "Krisp picked by default, Standard on the microphone");
    check(!!settled?.fallback?.text, `the bar says so: "${settled?.fallback?.text}" (why: ${settled?.fallback?.why})`);
    check(looksLike(s1, "standard", true).length === 0, `and the microphone is Standard (${looksLike(s1, "standard", true).join(", ") || "as expected"})`);
  } else {
    check(settled?.mode === "krisp", "Krisp is the default (nothing picked, and this browser runs it)");
    check(krispOn, krispOn ? "Krisp is ON: Krisp's processor is enabled, after LiveKit's check of the room's token" : `Krisp did NOT start: "${settled?.fallback?.why}"; the microphone fell back to ${settled?.active}`);
    if (krispOn) {
      check(looksLike(s1, "krisp", true).length === 0, `the track Ada's sender has is Krisp's processor's, her microphone opened without the browser's suppression (${looksLike(s1, "krisp", true).join(", ") || "as expected"})`);
      const settings = lk.find((r) => r.flags && "enhancedNoiseCancellation" in r.flags);
      check(settings?.flags.enhancedNoiseCancellation === true && settings.status === 200, `LiveKit Cloud's check said yes: ${settings ? `${settings.where} ${settings.status} ${JSON.stringify(settings.flags)}` : "no check seen"}`);
      check(lk.some((r) => r.where.startsWith("integrations.livekit.io") && r.status === 200), "Krisp's models came from integrations.livekit.io (200)");
    } else {
      check(settled?.active === "standard" && looksLike(s1, "standard", true).length === 0, `the fallback works: Standard on the microphone (${looksLike(s1, "standard", true).join(", ") || "as expected"})`);
      check(settled?.fallback?.text === "Krisp isn't available here, using Standard", `and the bar says so: "${settled?.fallback?.text}"`);
    }
  }

  step("2. Ada unmutes; krisp → standard → off → krisp, in voice");
  await bar(a).getByRole("button", { name: "Unmute" }).click();
  await bar(a).getByRole("button", { name: "Mute", exact: true }).waitFor();
  await b.waitForTimeout(1500);
  const levels = {};
  const pcs0 = s1.pcs;
  const sequence = expectFallback || !krispOn ? ["standard", "off", "standard"] : ["krisp", "standard", "off", "krisp"];
  for (const [i, mode] of sequence.entries()) {
    if (i > 0) {
      await choice(a).getByRole("radio", { name: { krisp: "Krisp", standard: "Standard", off: "Off" }[mode], exact: true }).click();
      const s = await activeIs(a, [mode], ".voicebar", 20_000);
      check(s?.active === mode && s?.mode === mode, `switched to ${mode}: the bar says ${JSON.stringify(s?.active)}`);
    }
    await a.waitForTimeout(800);
    const s = await sending(a);
    const why = looksLike(s, mode);
    check(why.length === 0, `${mode}: ${why.join(", ") || `microphone ${JSON.stringify({ ns: s.raw.noiseSuppression, ec: s.raw.echoCancellation, agc: s.raw.autoGainControl, vi: s.raw.voiceIsolation })}, ${s.sender.processed ? "Krisp's processed track" : "the raw microphone"} sent, ${s.packets} packets in 1.5 s`}`);
    check(s.pcs === pcs0, `${mode}: the same LiveKit connection (${s.pcs} peer connections made, as before): no rejoin`);
    const h = await heard(b);
    levels[`${i}:${mode}`] = h;
    check(!!h && h.loud > -60, `${mode}: Bo hears Ada (${JSON.stringify(h)} dBFS: quiet = the hiss between words, loud = her voice)`);
    if (i === 1) await a.screenshot({ path: `${out}noise-2-voice-${mode}-ada.png` });
  }
  console.log(`  what Bo heard, by mode (dBFS): ${JSON.stringify(levels)}`);
  if (!expectFallback && krispOn) {
    const k = levels["0:krisp"], o = levels["2:off"];
    if (k && o) console.log(`  the hiss between words: ${o.quiet} dBFS with Off, ${k.quiet} with Krisp (${o.quiet - k.quiet} dB less)`);
  }

  step("3. Muted, Ada switches to Standard; unmuted, it's still Standard");
  await bar(a).getByRole("button", { name: "Mute", exact: true }).click();
  await bar(a).getByRole("button", { name: "Unmute" }).waitFor();
  const target = sequence.at(-1) === "standard" ? "off" : "standard";
  await choice(a).getByRole("radio", { name: target === "standard" ? "Standard" : "Off", exact: true }).click();
  const m1 = await activeIs(a, [target], ".voicebar", 20_000);
  const sm = await sending(a, 500);
  check(looksLike(sm, target, true).length === 0, `muted: the microphone as ${target} wants it (${looksLike(sm, target, true).join(", ") || "as expected"})`);
  check(m1?.active === target && sm.raw?.noiseSuppression === expected[target].noiseSuppression && sm.sender?.processed === false, `muted: ${target} on the microphone (noiseSuppression ${sm.raw?.noiseSuppression}) and nothing heard`);
  await bar(a).getByRole("button", { name: "Unmute" }).click();
  await bar(a).getByRole("button", { name: "Mute", exact: true }).waitFor();
  await a.waitForTimeout(800);
  const su = await sending(a);
  check((await shown(a))?.active === target && looksLike(su, target).length === 0, `unmuted: still ${target}, audio going out (${looksLike(su, target).join(", ") || `${su.packets} packets in 1.5 s`})`);
  check(!!(await heard(b, 2000)), "Bo hears her");
  check((await a.evaluate(() => localStorage.getItem("arugula.video.noise"))) === JSON.stringify(target), `kept in her browser: arugula.video.noise = ${JSON.stringify(target)}`);

  step("4. Ada reloads: her choice stays");
  await a.reload();
  await join(a, "Ada", room);
  await bar(a).getByRole("button", { name: "Join voice" }).click();
  await bar(a).getByRole("button", { name: "Unmute" }).waitFor({ timeout: 20_000 });
  const r = await activeIs(a, [target], ".voicebar", 20_000);
  const sr = await sending(a, 500);
  check(r?.mode === target && r?.active === target && r?.pressed === (target === "standard" ? "Standard" : "Off"), `after a reload, voice opens with ${target} (${JSON.stringify(r)})`);
  check(sr.raw?.noiseSuppression === expected[target].noiseSuppression && sr.opens === 1, `her microphone opened once, as ${target} (noiseSuppression ${sr.raw?.noiseSuppression}; asked ${JSON.stringify(sr.raw?.asked)})`);
  await a.screenshot({ path: `${out}noise-3-after-reload-ada.png` });

  step("5. A call: the same choice, and switched in it");
  const tile = b.locator("figure.tile", { has: b.locator(".who", { hasText: "Ada" }) });
  await tile.getByRole("button", { name: "Wave" }).click();
  const toast = a.locator(".toast", { hasText: "waved at you" });
  await toast.waitFor({ timeout: 15_000 });
  await toast.getByRole("button", { name: "Talk" }).click();
  await a.locator(".callbar.on", { hasText: "In a call with Bo" }).waitFor({ timeout: 20_000 });
  const c = await activeIs(a, [target], ".callbar", 20_000);
  check(c?.active === target, `in the call, Ada's microphone opens with ${target} (the call bar: ${JSON.stringify(c)})`);
  const want = expectFallback || !krispOn ? (target === "standard" ? "off" : "standard") : "krisp";
  await choice(a, ".callbar").getByRole("radio", { name: { krisp: "Krisp", standard: "Standard", off: "Off" }[want], exact: true }).click();
  const c2 = await activeIs(a, [want], ".callbar", 30_000);
  await a.waitForTimeout(800);
  const sc = await sending(a);
  check(c2?.active === want && looksLike(sc, want).length === 0, `switched to ${want} in the call (${looksLike(sc, want).join(", ") || `${sc.sender.processed ? "Krisp's track" : "raw microphone"} sent, ${sc.packets} packets in 1.5 s`})`);
  await a.screenshot({ path: `${out}noise-4-call-${want}-ada.png` });

  step("6. Cy's browser can't reach Krisp's models (integrations.livekit.io blocked): Standard, saying so, and she's heard");
  const cy = await context("Cy");
  await cy.context().route(/integrations\.livekit\.io/, (r) => r.abort("blockedbyclient"));
  await join(cy, "Cy", room);
  await bar(cy).getByRole("button", { name: "Join voice" }).click();
  await bar(cy).getByRole("button", { name: "Unmute" }).waitFor({ timeout: 20_000 });
  const fb = await activeIs(cy, ["standard"], ".voicebar", 30_000);
  await cy.waitForTimeout(1500);
  const fb2 = await shown(cy);
  console.log(`  Cy's noise choice: ${JSON.stringify(fb2)}`);
  check(fb?.active === "standard" && fb2?.active === "standard" && fb2?.mode === "krisp", "Krisp is her mode (the default), Standard is on her microphone");
  check(fb2?.fallback?.text === "Krisp isn't available here, using Standard", `the bar says "${fb2?.fallback?.text}" (why: ${fb2?.fallback?.why})`);
  await bar(cy).getByRole("button", { name: "Unmute" }).click();
  await bar(cy).getByRole("button", { name: "Mute", exact: true }).waitFor();
  await cy.waitForTimeout(800);
  const sf = await sending(cy);
  check(looksLike(sf, "standard").length === 0, `her microphone works as Standard (${looksLike(sf, "standard").join(", ") || `noiseSuppression ${sf.raw.noiseSuppression}, raw microphone sent, ${sf.packets} packets in 1.5 s`})`);
  await cy.screenshot({ path: `${out}noise-5-fallback-cy.png` });

  step("7. The script-tag SDK on another site: <arugula-voice>'s noise choice, Krisp's chunk from beside presence.js");
  const dee = await context("Dee");
  const site = "https://sdk-host.example/";
  const chunks = [];
  dee.on("response", (r) => /\/sdk\/v0\/krisp-[\w-]+\.js$/.test(r.url()) && chunks.push({ url: new URL(r.url()).pathname, status: r.status(), cors: r.headers()["access-control-allow-origin"] ?? null }));
  const socket = `${relay.replace(/^http/, "ws")}/socket`;
  await dee.route(site, (r) =>
    r.fulfill({
      contentType: "text/html",
      body: `<!doctype html><meta charset="utf-8"><title>host</title><script type="module" src="${relay}/sdk/v0/presence.js"></script>
<body style="background:#06080d;color:#e6e9ef;font:15px system-ui;padding:24px"><arugula-room room="${room}" demo name="Dee" relay="${socket}"><arugula-voice></arugula-voice><arugula-people size="head"></arugula-people></arugula-room>`,
    }),
  );
  await dee.goto(site);
  await dee.locator(".arugula-voice").getByRole("button", { name: "Join voice" }).click({ timeout: 30_000 });
  await dee.locator(".arugula-voice").getByRole("button", { name: "Unmute" }).waitFor({ timeout: 20_000 });
  const el = await activeIs(dee, ["krisp", "standard"], ".arugula-voice", 30_000);
  await dee.waitForTimeout(1500);
  const el2 = await shown(dee, ".arugula-voice");
  console.log(`  <arugula-voice>'s noise choice: ${JSON.stringify(el2)}; Krisp's chunk: ${JSON.stringify(chunks)}`);
  check(el2?.active === "krisp" && el2?.mode === "krisp", "on another origin, the SDK's voice bar has the choice and Krisp runs");
  check(chunks.length === 1 && chunks[0].status === 200 && chunks[0].cors === "*", "Krisp's chunk came once from the relay's /sdk/v0/, CORS open");
  await dee.screenshot({ path: `${out}noise-6-sdk-element-dee.png` });

  for (const p of [a, b, cy, dee]) await p.context().close();
}

try {
  await run();
} catch (e) {
  failed = true;
  console.log(`  FAIL ${e.message}`);
} finally {
  await browser.close();
}
if (logs.length) {
  console.log("· what Krisp and LiveKit said about it in the pages' consoles:");
  for (const l of logs.slice(0, 40)) console.log(`  ${l}`);
}
console.log(failed ? "the noise filter proof FAILED" : "the noise filter proof passed");
console.log(`screenshots in ${out}`);
process.exit(failed ? 1 : 0);
