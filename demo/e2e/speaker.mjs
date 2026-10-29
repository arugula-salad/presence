// Speaker view (Arugula #332), in headless Chromiums against a relay and a
// LiveKit of your own (or staging). Ada, Bea and Cy are in a room's voice
// channel with Speaker view on (Ada's camera on, so she's a live
// character); Dee is in the room, not in voice. Who's
// talking is real audio, scripted: every page's fake microphone plays the
// same speech-like sound (a WAV this writes), and a person "talks" while
// they're unmuted. So LiveKit carries real audio and each page measures
// who it hears, as it would anyone's voice. Muting and unmuting on a
// schedule is what makes it controllable (a WAV per browser would need a
// browser each and clocks that agree).
//
//   Ada talks: Bea's and Cy's big tile is Ada within about a second.
//   Cy coughs (200 ms): it stays Ada. Nobody talks: it stays Ada.
//   Bea talks for 2 s: Bea takes it. Ada pins Cy: Cy, whoever talks.
//   Bea starts video: Ada's big tile plays it at 720p (the fake camera
//   gives that much when asked) while Cy, with Bea in his strip, gets a
//   small layer; Bea sends her 720p layer only while someone shows her
//   big; her camera opened once, and Dee still sees her character, live.
//   Video off: the big tile is her character again.
//   And a camera that can't do 720p (a 640×480 file) goes up at 640×360,
//   not scaled up.
//
// The same in a meet room (guests, by link) with `--meet`, or both with
// `--both`:
//
//   docker run -d --name presence-livekit-speaker -p 127.0.0.1:4227:4227 \
//     -p 127.0.0.1:4228:4228 -p 127.0.0.1:4229:4229/udp \
//     livekit/livekit-server:latest --dev --bind 0.0.0.0 --config-body \
//     "$(printf 'port: 4227\nrtc:\n  tcp_port: 4228\n  udp_port: 4229\n  use_external_ip: false\n  node_ip: 127.0.0.1\nkeys:\n  devkey: secret\n')"
//   (cd ../relay && PORT=4225 DEMO=1 MEET_ORIGINS=http://127.0.0.1:4225 \
//     LIVEKIT_URL=ws://127.0.0.1:4227 LIVEKIT_API_KEY=devkey \
//     LIVEKIT_API_SECRET=secret \
//     DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/presence_dev_speaker \
//     mix phx.server)
//   pnpm build && (cd ../meet && pnpm build) && node e2e/speaker.mjs [http://127.0.0.1:4225] [--meet|--both]
//
// (LiveKit's ICE candidates name its rtc ports, so the host's ports match
// the container's.) Screenshots, desktop and phone width, go to e2e/out/
// (not kept in git).

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const relay = (args.find((a) => !a.startsWith("--")) ?? process.env.RELAY ?? "http://127.0.0.1:4225").replace(/\/$/, "");
const where = args.includes("--both") ? ["demo", "meet"] : args.includes("--meet") ? ["meet"] : ["demo"];
const out = fileURLToPath(new URL("./out/", import.meta.url));
mkdirSync(out, { recursive: true });

const step = (what) => console.log(`· ${what}`);
let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? "  ok" : "  FAIL"} ${what}`);
  if (!ok) failed = true;
};

// The fake microphone's sound: 12 s of a voiced "ah" (a 140 Hz voice with
// two formants and a syllable's swell), loud and never silent, so it
// reads as speech the moment someone unmutes.
function speech(path) {
  const rate = 48_000, n = rate * 12;
  const pcm = new Int16Array(n);
  let ph = 0;
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
    pcm[i] = Math.max(-32767, Math.min(32767, Math.round(s * (0.65 + 0.35 * Math.sin(2 * Math.PI * 3.3 * t)) * 6000)));
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

// A 640×480 camera, as a Y4M file Chrome plays as the fake camera: ten
// frames of a moving gradient, looped. It can't be asked for more.
function camera480(path) {
  const w = 640, h = 480;
  const parts = [Buffer.from(`YUV4MPEG2 W${w} H${h} F20:1 Ip A1:1 C420jpeg\n`)];
  for (let f = 0; f < 10; f++) {
    const y = Buffer.alloc(w * h);
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) y[r * w + c] = (c + r + f * 24) & 255;
    parts.push(Buffer.from("FRAME\n"), y, Buffer.alloc((w / 2) * (h / 2), 128), Buffer.alloc((w / 2) * (h / 2), 128));
  }
  writeFileSync(path, Buffer.concat(parts));
}

const wav = `${out}speech.wav`;
speech(wav);
const y4m = `${out}camera-480.y4m`;
camera480(y4m);
const flags = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`, "--autoplay-policy=no-user-gesture-required"];
const browser = await chromium.launch({ args: flags });
// Bea's camera on a browser of her own: a browser's fake camera is one
// device, opened at the first page's size (Ada's 640×480), so hers would
// be held to it.
const browserBea = await chromium.launch({ args: flags });
const browser480 = await chromium.launch({ args: [...flags, `--use-file-for-fake-video-capture=${y4m}`] });

// Before any page script: count camera opens, and keep each peer
// connection (for its stats: the layers sent, the size received).
const watch = () => {
  window.__cams = 0;
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (c) => {
    if (c && c.video) window.__cams++;
    return gum(c);
  };
  window.__pcs = [];
  const PC = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...a) {
    const pc = new PC(...a);
    window.__pcs.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = PC.prototype;
};

async function context(name, b = browser) {
  const ctx = await b.newContext({ permissions: ["microphone", "camera"], viewport: { width: 1280, height: 860 } });
  await ctx.addInitScript(watch);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [${name}] page error: ${e.message}`));
  return page;
}

/** Into a demo room: /r/<room>, a name. */
async function demoPerson(name, room, b) {
  const page = await context(name, b);
  await page.goto(`${relay}/r/${room}`);
  await page.getByPlaceholder("your name").fill(name);
  await page.getByRole("button", { name: "Join the room" }).click();
  await page.locator(".room .bar .stats", { hasText: "here" }).waitFor();
  return page;
}

/** Into a meet room as a guest: the first starts it, the rest open its link. */
async function meetPerson(name, link, b) {
  const page = await context(name, b);
  if (!link) {
    await page.goto(`${relay}/meet/`);
    await page.getByLabel("Your name").fill(name);
    await page.getByRole("button", { name: "Continue as a guest" }).click();
    await page.getByLabel("The room's name").fill("Speaker check");
    await page.getByRole("button", { name: "Start a room" }).click();
    await page.waitForURL(/\/r\/[0-9a-z-]+$/);
  } else await page.goto(link);
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Join the room" }).click();
  await page.locator('[data-live="on"]').waitFor();
  return page;
}

/** What `page`'s big tile shows: whose (name), why (speaker, pinned,
 * first), and a playing video's size and frames over half a second, or a
 * canvas (their character). */
const bigOf = (page, frames = false) =>
  page.evaluate(async (frames) => {
    const fig = document.querySelector("figure.tile.spot-big");
    if (!fig) return null;
    const v = fig.querySelector(".view video");
    const r = { name: fig.querySelector(".who")?.textContent ?? "", why: fig.dataset.why, canvas: !!fig.querySelector(".view canvas"), video: !!v, w: fig.querySelector(".view").clientWidth };
    if (v && frames) {
      const q0 = v.getVideoPlaybackQuality().totalVideoFrames;
      await new Promise((ok) => setTimeout(ok, 500));
      Object.assign(r, { width: v.videoWidth, height: v.videoHeight, paused: v.paused, frames: v.getVideoPlaybackQuality().totalVideoFrames - q0 });
    }
    return r;
  }, frames);

/** Whose `page`'s big tile is now. */
const bigName = async (page) => (await bigOf(page))?.name ?? "";

/** Video RTP on `page`'s peer connections: what goes out (each simulcast
 * layer's rid, size and frames so far) and what comes in (its size). */
const rtp = (page) =>
  page.evaluate(async () => {
    const sent = [];
    const got = [];
    let track = null;
    for (const pc of window.__pcs) {
      if (pc.connectionState === "closed") continue;
      for (const s of pc.getSenders()) if (s.track?.kind === "video") track = s.track.getSettings();
      (await pc.getStats()).forEach((s) => {
        if (s.kind !== "video") return;
        if (s.type === "outbound-rtp") sent.push({ rid: s.rid ?? "", w: s.frameWidth ?? 0, h: s.frameHeight ?? 0, fps: Math.round(s.framesPerSecond ?? 0), frames: s.framesEncoded ?? 0, active: s.active !== false });
        if (s.type === "inbound-rtp") got.push({ w: s.frameWidth ?? 0, h: s.frameHeight ?? 0, frames: s.framesDecoded ?? 0 });
      });
    }
    return { sent, got, track: track && { w: track.width, h: track.height, fps: track.frameRate } };
  });

/** Frames of `page`'s top layer (rid f) encoded over `ms`. */
async function topFrames(page, ms = 2000) {
  const f = async () => (await rtp(page)).sent.filter((s) => s.rid === "f").reduce((n, s) => n + s.frames, 0);
  const a = await f();
  await page.waitForTimeout(ms);
  return (await f()) - a;
}

async function until(fn, ok, tries = 40, every = 500) {
  let v;
  for (let i = 0; i < tries; i++) {
    v = await fn();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, every));
  }
  return v;
}

/** `page`'s person talks for `ms`: unmuted, then muted again, timed in the
 * page so a blip is a blip. */
const talk = (page, ms) =>
  page.evaluate(async (ms) => {
    const bar = document.querySelector(".voicebar");
    const button = (n) => [...bar.querySelectorAll("button")].find((b) => b.textContent === n);
    button("Unmute").click();
    await new Promise((ok) => setTimeout(ok, ms));
    button("Mute").click();
  }, ms);

/** Start talking (unmute) now, without waiting. */
const startTalking = (page) => page.locator(".voicebar").getByRole("button", { name: "Unmute" }).click();

/** Watch whose big tile it is on each page every 50 ms for `ms`: the
 * names seen (and why: speaker, pinned, first), in order, and when each
 * first showed. */
async function watchBig(pages, ms) {
  return Promise.all(
    pages.map((p) =>
      p.evaluate(async (ms) => {
        const seen = [];
        const t0 = performance.now();
        while (performance.now() - t0 < ms) {
          const fig = document.querySelector("figure.tile.spot-big");
          const name = fig?.querySelector(".who")?.textContent ?? "";
          const why = fig?.dataset.why ?? "";
          if (seen.at(-1)?.[0] !== name || seen.at(-1)?.[2] !== why) seen.push([name, Math.round(performance.now() - t0), why]);
          await new Promise((ok) => setTimeout(ok, 50));
        }
        return seen;
      }, ms),
    ),
  );
}

async function run(kind) {
  const tag = kind === "meet" ? "meet-" : "";
  const room = `speaker-proof-${Date.now().toString(36)}`;
  step(`${kind}: on ${relay}`);
  let a, b, c, d;
  if (kind === "meet") {
    a = await meetPerson("Ada");
    b = await meetPerson("Bea", a.url(), browserBea);
    c = await meetPerson("Cy", a.url());
    d = await meetPerson("Dee", a.url());
  } else {
    a = await demoPerson("Ada", room);
    b = await demoPerson("Bea", room, browserBea);
    c = await demoPerson("Cy", room);
    d = await demoPerson("Dee", room);
  }
  const voice = [a, b, c];
  const bar = (page) => page.locator(".voicebar");
  for (const p of [a, b, c, d]) await p.locator("figure.tile").nth(3).waitFor();
  step("all four in the room; Ada turns her camera on; Ada, Bea and Cy join voice (muted) and pick Speaker view");
  check((await a.getByRole("radio", { name: "Speaker" }).count()) === 0, "no layout toggle outside a call or voice");
  await a.getByRole("button", { name: "Turn on my camera" }).click();
  await b.locator("figure.tile.live", { has: b.locator(".who", { hasText: "Ada" }) }).waitFor({ timeout: 30_000 });
  for (const p of voice) {
    await bar(p).getByRole("button", { name: "Join voice" }).click();
    await bar(p).getByRole("button", { name: "Unmute" }).waitFor({ timeout: 20_000 });
  }
  for (const p of voice) await p.getByRole("radio", { name: "Speaker" }).click();
  for (const p of voice) await p.locator(".speaker-strip figure.tile").nth(1).waitFor({ timeout: 15_000 });
  const first = await bigOf(b);
  check(first?.why === "first" && !first.video, `before anyone talks, Bea's big tile is the first other person in voice (${JSON.stringify(first)})`);
  check((await b.locator('.speaker-rest figure.tile', { hasText: "Dee" }).count()) === 1, "Dee, not in voice, is in the row under the strip");
  check((await d.getByRole("radio", { name: "Speaker" }).count()) === 0, "Dee, not in voice, has no layout toggle");
  await b.waitForTimeout(1500);

  step("Ada talks");
  const adaTalks = talk(a, 2500);
  const [onB, onC] = await watchBig([b, c], 2000);
  await adaTalks;
  // When `name` first showed big as the speaker.
  const at = (seen, name) => seen.find(([n, , why]) => n.startsWith(name) && why === "speaker")?.[1] ?? -1;
  console.log(`  Bea's big tile: ${JSON.stringify(onB)}; Cy's: ${JSON.stringify(onC)}`);
  check(at(onB, "Ada") >= 0 && at(onB, "Ada") <= 1500 && (await bigOf(b)).why === "speaker", `Bea's big tile is Ada, the speaker, ${at(onB, "Ada")} ms after she started`);
  check(at(onC, "Ada") >= 0 && at(onC, "Ada") <= 1500 && (await bigOf(c)).why === "speaker", `Cy's too, after ${at(onC, "Ada")} ms`);
  const adaBig = await bigOf(b);
  check(adaBig.canvas && !adaBig.video, "with video off, the big tile shows her live character, drawn big");
  check(!(await bigName(a)).startsWith("Ada"), `Ada isn't big on her own page (it's ${await bigName(a)})`);
  await b.screenshot({ path: `${out}${tag}speaker-1-ada-talks-bea.png` });

  step("Ada stops; Cy coughs (200 ms); nobody else talks");
  const quiet = watchBig([b], 5000);
  await b.waitForTimeout(1500);
  await talk(c, 200);
  const [seenB] = await quiet;
  console.log(`  Bea's big tile over 5 s: ${JSON.stringify(seenB)}`);
  check(seenB.length === 1 && seenB[0][0].startsWith("Ada") && seenB[0][2] === "speaker", "a 200 ms blip from Cy doesn't take it, and with nobody talking it stays Ada");
  check((await bigName(c)).startsWith("Ada"), "Cy's page: still Ada (you're never big on your own)");

  step("Bea talks for 2 s");
  const beaTalks = talk(b, 2000);
  const [onA, onC2] = await watchBig([a, c], 2600);
  await beaTalks;
  console.log(`  Ada's big tile: ${JSON.stringify(onA)}; Cy's: ${JSON.stringify(onC2)}`);
  check(at(onA, "Bea") >= 0 && at(onA, "Bea") <= 1500 && (await bigName(a)).startsWith("Bea"), `Ada's big tile is Bea after ${at(onA, "Bea")} ms`);
  check(at(onC2, "Bea") >= 0 && at(onC2, "Bea") <= 1500 && (await bigName(c)).startsWith("Bea"), `Cy's goes from Ada to Bea ${at(onC2, "Bea")} ms after she started (she had to talk 0.7 s)`);
  await a.screenshot({ path: `${out}${tag}speaker-2-bea-took-it-ada.png` });

  step("Ada pins Cy");
  await a.locator(".speaker-strip figure.tile", { hasText: "Cy" }).click();
  const pinned = await until(() => bigOf(a), (v) => v?.name.startsWith("Cy"), 20, 100);
  check(pinned?.name.startsWith("Cy") && pinned.why === "pinned", `Ada's big tile is Cy, pinned (${JSON.stringify(pinned)})`);
  const pinTalk = talk(b, 1500);
  const [pinSeen] = await watchBig([a], 2200);
  await pinTalk;
  check(pinSeen.every(([n]) => n.startsWith("Cy")), `Bea talking doesn't move it: ${JSON.stringify(pinSeen)}`);
  check((await bigOf(c)).why === "speaker", "the pin is Ada's page alone: Cy's follows the speaker");
  await a.locator("figure.tile.spot-big").click();
  const unpinned = await until(() => bigOf(a), (v) => v?.why !== "pinned", 20, 100);
  check(unpinned?.why === "speaker" && unpinned.name.startsWith("Bea"), `clicked again, Ada's page follows the speaker again (${unpinned?.name})`);

  step("Bea starts video; Cy pins Ada, so Bea's in his strip");
  await c.locator(".speaker-strip figure.tile", { hasText: "Ada" }).click();
  const camsBefore = await b.evaluate(() => window.__cams);
  await bar(b).getByRole("button", { name: "Start video" }).click();
  await bar(b).getByRole("button", { name: "Stop video" }).waitFor();
  const big = await until(
    () => bigOf(a, true),
    (v) => v?.video && v.width >= 1280 && v.frames > 3,
  );
  console.log(`  Ada's big tile: ${JSON.stringify(big)}`);
  check(big?.name.startsWith("Bea") && big.video && !big.paused && big.frames > 3 && big.width === 1280, "Ada's big tile plays Bea's video at 1280×720, frames coming");
  const recv = async (page) => (await rtp(page)).got.filter((g) => g.w > 0).sort((x, y) => y.w - x.w)[0] ?? { w: 0, h: 0 };
  const gotA = await until(() => recv(a), (g) => g.w >= 1280, 30);
  const stripC = await until(
    () => c.locator(".speaker-strip figure.tile", { hasText: "Bea" }).evaluate((f) => !!f.querySelector("video")?.videoWidth),
    (v) => v,
  );
  const gotC = await until(() => recv(c), (g) => g.w > 0 && g.w <= 640, 20);
  console.log(`  Ada receives Bea at ${gotA.w}×${gotA.h} (big tile ${big?.w} px wide); Cy, with her in his strip, at ${gotC.w}×${gotC.h}`);
  check(stripC && gotA.w > gotC.w, "the big tile gets a larger layer than the strip tile does elsewhere");
  check(gotA.w === 1280 && gotA.h === 720, "Ada gets Bea's 720p layer");
  const lay = await rtp(b);
  console.log(`  Bea's published track ${JSON.stringify(lay.track)}; she sends ${JSON.stringify(lay.sent)}`);
  check(lay.track?.w === 1280 && lay.track?.h === 720, "the fake camera, asked, gives 720p: Bea publishes 1280×720");
  check(lay.sent.length === 3, "three layers: 1280×720, 640×360 and 320×180");
  const cams = (await b.evaluate(() => window.__cams)) - camsBefore;
  check(cams === 1, `Bea's page opened the camera once, for her character and video together (${cams} getUserMedia)`);
  const dee = await until(
    () => d.locator("figure.tile", { has: d.locator(".who", { hasText: "Bea" }) }).evaluate((f) => ({ canvas: !!f.querySelector(".view canvas"), video: !!f.querySelector(".view video"), live: f.classList.contains("live") })),
    (v) => v.canvas && v.live,
  );
  check(dee.canvas && dee.live && !dee.video, `Dee, outside voice, sees Bea's character, live: the rig reads the same camera (${JSON.stringify(dee)})`);
  const shown = await topFrames(b);
  await a.screenshot({ path: `${out}${tag}speaker-3-bea-video-big-ada.png` });
  await c.screenshot({ path: `${out}${tag}speaker-4-bea-in-strip-cy.png` });
  await c.setViewportSize({ width: 390, height: 844 });
  await c.waitForTimeout(800);
  await c.screenshot({ path: `${out}${tag}speaker-5-phone-cy.png`, fullPage: true });
  await a.setViewportSize({ width: 390, height: 844 });
  await a.waitForTimeout(800);
  await a.screenshot({ path: `${out}${tag}speaker-6-phone-ada.png`, fullPage: true });
  await a.setViewportSize({ width: 1280, height: 860 });
  await c.setViewportSize({ width: 1280, height: 860 });

  step("Ada pins Cy: nobody shows Bea big");
  await a.locator(".speaker-strip figure.tile", { hasText: "Cy" }).click();
  // LiveKit waits a few seconds before telling a publisher to drop a
  // layer (so a tile flickering small doesn't thrash the encoder).
  const t0 = Date.now();
  const hidden = await until(() => topFrames(b, 1000), (n) => n <= 1, 20, 0);
  const stopped = Math.round((Date.now() - t0) / 1000);
  await a.locator("figure.tile.spot-big").click();
  const t1 = Date.now();
  const back = await until(() => topFrames(b, 2000), (n) => n > 10, 10, 0);
  const resumed = Math.round((Date.now() - t1) / 1000);
  console.log(`  Bea's 720p layer: ${shown} frames in 2 s while Ada showed her big; ${hidden} a second within ${stopped} s of nobody doing so; ${back} in 2 s within ${resumed} s of Ada showing her big again`);
  check(shown > 10 && hidden <= 1 && back > 10, "dynacast: Bea sends 720p only while some page shows her big");

  step("Bea stops video");
  await bar(b).getByRole("button", { name: "Stop video" }).click();
  const off = await until(
    () => bigOf(a),
    (v) => v && !v.video && v.canvas,
  );
  check(off?.name.startsWith("Bea") && off.canvas && !off.video, `Ada's big tile: Bea's character again (${JSON.stringify(off)})`);
  await a.screenshot({ path: `${out}${tag}speaker-7-video-off-ada.png` });

  step("Grid again, and the choice is kept");
  await a.getByRole("radio", { name: "Grid" }).click();
  check((await a.locator("figure.tile.spot-big").count()) === 0 && (await a.locator(".grid figure.tile").count()) === 4, "Grid: the four tiles");
  await a.getByRole("radio", { name: "Speaker" }).click();
  await a.reload();
  if (kind === "meet") {
    await a.getByLabel("Your name").fill("Ada");
    await a.getByRole("button", { name: "Join the room" }).click();
  } else {
    await a.getByPlaceholder("your name").fill("Ada");
    await a.getByRole("button", { name: "Join the room" }).click();
  }
  await bar(a).getByRole("button", { name: "Join voice" }).click();
  await a.locator("figure.tile.spot-big").waitFor({ timeout: 20_000 });
  check(true, "back in voice after a reload, it's Speaker view: this browser kept it");

  for (const p of [a, b, c, d]) await p.context().close();
}

/** A camera that can't do 720p: Eve's goes up at 640×360, two layers. */
async function run480() {
  const room = `speaker-480-${Date.now().toString(36)}`;
  step("a 640×480 camera");
  const e = await demoPerson("Eve", room, browser480);
  const f = await demoPerson("Fay", room);
  for (const p of [e, f]) {
    await p.locator(".voicebar").getByRole("button", { name: "Join voice" }).click();
    await p.locator(".voicebar").getByRole("button", { name: "Unmute" }).waitFor({ timeout: 20_000 });
  }
  await f.getByRole("radio", { name: "Speaker" }).click();
  await e.locator(".voicebar").getByRole("button", { name: "Start video" }).click();
  const lay = await until(
    () => rtp(e),
    (r) => r.sent.filter((s) => s.w > 0).length >= 2,
  );
  console.log(`  Eve's published track ${JSON.stringify(lay.track)}; she sends ${JSON.stringify(lay.sent)}`);
  check(lay.track?.w === 640 && lay.track?.h === 360, "her video goes up at 640×360, not scaled up to 720p");
  check(lay.sent.length === 2 && Math.max(...lay.sent.map((s) => s.w)) <= 640, "two layers, the top at most 640 wide");
  const big = await until(
    () => bigOf(f, true),
    (v) => v?.video && v.width >= 640 && v.frames > 3,
  );
  check(big?.video && big.width === 640, `Fay's big tile plays it (${big?.width}×${big?.height})`);
  for (const p of [e, f]) await p.context().close();
}

try {
  for (const kind of where) await run(kind);
  await run480();
} catch (e) {
  failed = true;
  console.log(`  FAIL ${e.message}`);
} finally {
  await browser.close();
  await browserBea.close();
  await browser480.close();
}
console.log(failed ? "the speaker proof FAILED" : "the speaker proof passed");
console.log(`screenshots in ${out}`);
process.exit(failed ? 1 : 0);
