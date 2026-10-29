// Every room's voice channel (Arugula #331), in headless Chromiums with
// fake microphones against a relay and a LiveKit of your own (or
// staging). Five people in one room: Ada joins voice and is muted (Bea and
// Cy see her in voice, muted, and nobody hears her); Bea joins; Ada
// unmutes and Bea hears her; Cy, outside voice, sees both in the strip;
// Cy joins, everyone unmutes, and all three hear each other. Meanwhile Dee
// waves at Eli, Eli says Talk, and their private call goes on beside voice
// without the voice people hearing it. Ada leaves; Bea and Cy carry on.
// Then one audio session a page: Eli joins voice (out of the call), and
// takes Dee's next call (out of voice), each saying so. Voice minutes
// show up as call minutes: in the relay's /metrics, and (meet, whose app
// is metered) in the app's usage rollup, after a flush.
//
// The same in a meet room (guests, by link) with `--meet`, or both with
// `--both`:
//
//   docker run -d --name presence-livekit-voice -p 127.0.0.1:4220:4220 \
//     -p 127.0.0.1:4221:4221 -p 127.0.0.1:4222:4222/udp \
//     livekit/livekit-server:latest --dev --bind 0.0.0.0 --config-body \
//     "$(printf 'port: 4220\nrtc:\n  tcp_port: 4221\n  udp_port: 4222\n  use_external_ip: false\n  node_ip: 127.0.0.1\nkeys:\n  devkey: secret\n')"
//   (cd ../relay && PORT=4223 DEMO=1 MEET_ORIGINS=http://127.0.0.1:4223 \
//     LIVEKIT_URL=ws://127.0.0.1:4220 LIVEKIT_API_KEY=devkey \
//     LIVEKIT_API_SECRET=secret METRICS_PORT=4224 \
//     DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/presence_dev_voice \
//     mix phx.server)
//   pnpm build && (cd ../meet && pnpm build) && node e2e/voice.mjs [http://127.0.0.1:4223] [--meet|--both] \
//     [--metrics http://127.0.0.1:4224/metrics] [--usage-db postgres://…/presence_dev_voice]
//
// (LiveKit's ICE candidates name its rtc ports, so the host's ports match
// the container's.) Against a local relay on 4223 the metrics and usage
// checks default to the ports above; against any other relay they run
// only when given. Screenshots go to e2e/out/ (not kept in git).

import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const valued = new Set(["--metrics", "--usage-db"].flatMap((n) => [n, opt(n)]));
const relay = (args.find((a) => !a.startsWith("--") && !valued.has(a)) ?? process.env.RELAY ?? "http://127.0.0.1:4223").replace(/\/$/, "");
const where = args.includes("--both") ? ["demo", "meet"] : args.includes("--meet") ? ["meet"] : ["demo"];
const local = relay === "http://127.0.0.1:4223";
const metricsUrl = opt("--metrics") ?? (local ? "http://127.0.0.1:4224/metrics" : undefined);
const usageDb = opt("--usage-db") ?? (local ? "postgres://postgres:postgres@127.0.0.1:55432/presence_dev_voice" : undefined);
const out = fileURLToPath(new URL("./out/", import.meta.url));
mkdirSync(out, { recursive: true });

const step = (what) => console.log(`· ${what}`);
let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? "  ok" : "  FAIL"} ${what}`);
  if (!ok) failed = true;
};

const browser = await chromium.launch({
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});

// Before any page script: count microphone opens (voice asks once, on
// joining; unmuting asks nothing).
const watch = () => {
  window.__mics = 0;
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (c) => {
    if (c && c.audio) window.__mics++;
    return gum(c);
  };
};

async function context(name) {
  const ctx = await browser.newContext({ permissions: ["microphone", "camera"], viewport: { width: 1280, height: 860 } });
  await ctx.addInitScript(watch);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [${name}] page error: ${e.message}`));
  return page;
}

/** Into a demo room: /r/<room>, a name. */
async function demoPerson(name, room) {
  const page = await context(name);
  await page.goto(`${relay}/r/${room}`);
  await page.getByPlaceholder("your name").fill(name);
  await page.getByRole("button", { name: "Join the room" }).click();
  await page.locator(".room .bar .stats", { hasText: "here" }).waitFor();
  return page;
}

/** Into a meet room as a guest: the first starts it, the rest open its link. */
async function meetPerson(name, link) {
  const page = await context(name);
  if (!link) {
    await page.goto(`${relay}/meet/`);
    await page.getByLabel("Your name").fill(name);
    await page.getByRole("button", { name: "Continue as a guest" }).click();
    await page.getByLabel("The room's name").fill("Voice check");
    await page.getByRole("button", { name: "Start a room" }).click();
    await page.waitForURL(/\/r\/[0-9a-z-]+$/);
  } else await page.goto(link);
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Join the room" }).click();
  await page.locator('[data-live="on"]').waitFor();
  return page;
}

/** What `page` hears: each call or voice audio element's track state and
 * its loudest level over `ms` (WebAudio on the element's stream). */
const hearing = (page, ms = 600) =>
  page.evaluate(async (ms) => {
    const els = [...document.querySelectorAll("audio")];
    return Promise.all(
      els.map(async (el) => {
        const stream = el.srcObject;
        const track = stream?.getAudioTracks()[0];
        if (!track) return { track: false };
        const ctx = new AudioContext();
        await ctx.resume();
        const an = ctx.createAnalyser();
        ctx.createMediaStreamSource(stream).connect(an);
        const buf = new Uint8Array(an.fftSize);
        let peak = 0;
        for (let t = 0; t < ms; t += 20) {
          await new Promise((r) => setTimeout(r, 20));
          an.getByteTimeDomainData(buf);
          for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        }
        await ctx.close();
        return { track: true, state: track.readyState, paused: el.paused, peak };
      }),
    );
  }, ms);

const sounding = (h) => h.filter((x) => x.track && x.state === "live" && !x.paused && x.peak > 2).length;

/** Until `page` hears at least `n` voices with sound (or gives up). */
async function hears(page, n, tries = 40) {
  let h = [];
  for (let i = 0; i < tries; i++) {
    h = await hearing(page);
    if (sounding(h) >= n) return h;
    await page.waitForTimeout(250);
  }
  return h;
}

/** Call seconds so far: the relay's /metrics counter (every app), and the
 * meet app's usage rollup in Postgres (what the usage API and billing read). */
async function metered() {
  let metrics = null;
  let usage = null;
  if (metricsUrl) {
    try {
      const text = await (await fetch(metricsUrl)).text();
      const line = text.split("\n").find((l) => l.startsWith("presence_call_seconds_total"));
      metrics = line ? Number(line.trim().split(/\s+/).pop()) : 0;
    } catch (e) {
      console.log(`  (metrics unreadable: ${e.message})`);
    }
  }
  if (usageDb) {
    try {
      usage = Number(execFileSync("psql", [usageDb, "-tAc", "select coalesce(sum(call_seconds), 0) from usage_days where app_id = 'meet'"]).toString().trim());
    } catch (e) {
      console.log(`  (usage unreadable: ${e.message})`);
    }
  }
  return { metrics, usage };
}

async function run(kind) {
  const tag = kind === "meet" ? "meet-" : "";
  const room = `voice-proof-${Date.now().toString(36)}`;
  step(`${kind}: on ${relay}`);
  const names = ["Ada", "Bea", "Cy", "Dee", "Eli"];
  const pages = {};
  if (kind === "meet") {
    pages.Ada = await meetPerson("Ada");
    for (const n of names.slice(1)) pages[n] = await meetPerson(n, pages.Ada.url());
  } else for (const n of names) pages[n] = await demoPerson(n, room);
  const { Ada: a, Bea: b, Cy: c, Dee: d, Eli: e } = pages;
  const all = Object.values(pages);
  const tile = (page, name) => page.locator("figure.tile", { has: page.locator(".who", { hasText: name }) });
  const bar = (page) => page.locator(".voicebar");
  const chip = (page, name) => bar(page).locator(".voice-person", { hasText: name });
  for (const p of all) await p.locator("figure.tile").nth(4).waitFor();
  step("all five in the room");
  for (const p of all) await bar(p).getByRole("button", { name: "Join voice" }).waitFor();
  check(true, "everyone has a voice strip with Join voice (the relay has voice)");
  const before = await metered();

  step("Ada joins voice");
  const micsBefore = await a.evaluate(() => window.__mics);
  await bar(a).getByRole("button", { name: "Join voice" }).click();
  await bar(a).getByRole("button", { name: "Unmute" }).waitFor({ timeout: 20_000 });
  check((await bar(a).locator(".stats", { hasText: "you're muted" }).count()) === 1, "Ada is in voice, muted, and her strip says so, with Unmute");
  const joinedAt = Date.now();
  check((await a.evaluate(() => window.__mics)) - micsBefore === 1, "her page opened the microphone once, on joining");
  for (const [p, who] of [[b, "Bea"], [c, "Cy"]]) {
    await chip(p, "Ada").and(p.locator(".muted")).waitFor({ timeout: 10_000 });
    const t = await tile(p, "Ada").locator(".tag.voice").textContent();
    check(t === "in voice, muted", `${who} sees Ada in voice, muted (strip and tile: "${t}")`);
  }
  await b.screenshot({ path: `${out}${tag}voice-1-ada-muted-bea.png` });

  step("Bea joins voice");
  await bar(b).getByRole("button", { name: "Join voice" }).click();
  await bar(b).getByRole("button", { name: "Unmute" }).waitFor({ timeout: 20_000 });
  await b.waitForTimeout(1500);
  const quiet = await hearing(b, 2000);
  console.log(`  Bea hears, Ada muted: ${JSON.stringify(quiet)}`);
  check(sounding(quiet) === 0, "nobody hears Ada while she's muted");

  step("Ada unmutes");
  await bar(a).getByRole("button", { name: "Unmute" }).click();
  await bar(a).getByRole("button", { name: "Mute", exact: true }).waitFor();
  check((await a.evaluate(() => window.__mics)) - micsBefore === 1, "unmuting asked for nothing (no new microphone prompt)");
  const hb = await hears(b, 1);
  console.log(`  Bea hears ${JSON.stringify(hb)}`);
  check(sounding(hb) === 1, "Bea has Ada's audio track subscribed, live, and it has sound");
  await chip(c, "Ada").and(c.locator(":not(.muted)")).waitFor({ timeout: 10_000 });

  step("Cy, outside voice, looks at the strip");
  const cyChips = await bar(c).locator(".voice-person").allTextContents();
  check(cyChips.length === 2 && cyChips.some((t) => t.startsWith("A") && !t.includes("muted")) && cyChips.some((t) => t.includes("Bea") && t.includes("muted")), `Cy sees both in voice: ${JSON.stringify(cyChips)}`);
  check((await bar(c).getByRole("button", { name: "Join voice" }).count()) === 1, "and can join");
  await c.screenshot({ path: `${out}${tag}voice-2-cy-outside.png` });

  step("Meanwhile Dee waves at Eli; Eli says Talk");
  await tile(d, "Eli").getByRole("button", { name: "Wave" }).click();
  const toast = e.locator(".toast", { hasText: "waved at you" });
  await toast.waitFor();
  await toast.getByRole("button", { name: "Talk" }).click();
  await d.locator(".callbar.on", { hasText: "In a call with Eli" }).waitFor({ timeout: 20_000 });
  await e.locator(".callbar.on", { hasText: "In a call with Dee" }).waitFor({ timeout: 20_000 });
  check(true, "Dee and Eli are in a private call");

  step("Cy joins voice; Bea and Cy unmute");
  await bar(c).getByRole("button", { name: "Join voice" }).click();
  await bar(c).getByRole("button", { name: "Unmute" }).waitFor({ timeout: 20_000 });
  await bar(c).getByRole("button", { name: "Unmute" }).click();
  await bar(b).getByRole("button", { name: "Unmute" }).click();
  for (const [p, who] of [[a, "Ada"], [b, "Bea"], [c, "Cy"]]) {
    const h = await hears(p, 2);
    console.log(`  ${who} hears ${JSON.stringify(h)}`);
    check(sounding(h) === 2 && h.length === 2, `${who} hears the other two in voice, and nobody else (${h.length} audio tracks)`);
  }
  const hd = await hears(d, 1);
  console.log(`  Dee hears ${JSON.stringify(hd)}`);
  check(sounding(hd) === 1 && hd.length === 1, "Dee hears Eli alone: the call is private, voice isn't in it");
  const strip = await bar(a).locator(".voice-person").allTextContents();
  check(strip.length === 3 && !strip.some((t) => /Dee|Eli/.test(t)), `voice's strip has the three, not the call (${JSON.stringify(strip)})`);
  check((await tile(a, "Dee").locator(".tag.call").textContent()) === "in a call", "Ada's tile for Dee says in a call");
  await a.waitForTimeout(600);
  await a.screenshot({ path: `${out}${tag}voice-3-three-in-voice-ada.png` });
  await d.screenshot({ path: `${out}${tag}voice-4-private-call-dee.png` });

  step("Ada leaves voice");
  await bar(a).getByRole("button", { name: "Leave voice" }).click();
  const adaVoiceMs = Date.now() - joinedAt;
  await bar(a).getByRole("button", { name: "Join voice" }).waitFor();
  for (const [p, who] of [[b, "Bea"], [c, "Cy"]]) {
    await chip(p, "Ada").waitFor({ state: "detached", timeout: 10_000 });
    check((await bar(p).locator(".voice-person").count()) === 2, `${who}'s strip: Bea and Cy, still in voice`);
  }
  const hb2 = await hears(b, 1);
  check(sounding(hb2) === 1 && hb2.length === 1, `Bea still hears Cy (${JSON.stringify(hb2)})`);
  check((await a.locator("audio").count()) === 0, "Ada's page plays no voice now");
  await b.screenshot({ path: `${out}${tag}voice-5-after-ada-left-bea.png` });

  // Ada's time in voice is the only call time that's ended so far: it shows
  // up as call seconds once a flush has written it (every 5 s).
  if (metricsUrl || usageDb) {
    step("Ada's voice minutes, metered");
    await a.waitForTimeout(6_500);
    const after = await metered();
    const secs = Math.ceil(adaVoiceMs / 1000);
    console.log(`  call seconds before ${JSON.stringify(before)}, after ${JSON.stringify(after)}; Ada was in voice about ${secs} s`);
    if (after.metrics !== null && before.metrics !== null) check(after.metrics - before.metrics >= secs - 2, `/metrics: call seconds went up by ${(after.metrics - before.metrics).toFixed(1)} (Ada's voice)`);
    if (kind === "meet" && after.usage !== null && before.usage !== null) {
      const delta = after.usage - before.usage;
      check(delta >= secs - 2 && delta <= secs + 3, `the meet app's usage rollup: call seconds went up by ${delta} (Ada's ~${secs} s in voice), so it's in call minutes and billing`);
    }
  } else console.log("  (metering: no --metrics or --usage-db for this relay; skipped)");

  step("One audio session a page: Eli joins voice from the call");
  await bar(e).getByRole("button", { name: "Join voice" }).click();
  await bar(e).locator(".notice", { hasText: "You left the call to join voice" }).waitFor({ timeout: 10_000 });
  await bar(e).getByRole("button", { name: "Unmute" }).waitFor({ timeout: 20_000 });
  await d.locator(".callbar.on").waitFor({ state: "detached", timeout: 15_000 });
  check(true, "Eli's in voice, out of the call (and says so); Dee, alone, left the call");
  await e.screenshot({ path: `${out}${tag}voice-6-eli-left-call.png` });

  step("Dee waves at Eli again; Eli says Talk, from voice");
  await tile(d, "Eli").getByRole("button", { name: "Wave" }).click();
  const toast2 = e.locator(".toast", { hasText: "waved at you" });
  await toast2.waitFor();
  check((await toast2.textContent()).includes("out of the room's voice"), "the ring says Talk takes him out of voice");
  await toast2.getByRole("button", { name: "Talk" }).click();
  await e.locator(".callbar.on", { hasText: "In a call with Dee" }).waitFor({ timeout: 20_000 });
  await bar(e).locator(".notice", { hasText: "You left voice to take the call" }).waitFor({ timeout: 5_000 });
  await bar(b).locator(".voice-person", { hasText: "Eli" }).waitFor({ state: "detached", timeout: 10_000 });
  check(true, "Eli took the call and left voice (and says so); Bea's strip no longer has him");
  await e.screenshot({ path: `${out}${tag}voice-7-eli-took-call.png` });

  for (const p of all) await p.context().close();
}

try {
  for (const kind of where) await run(kind);
} catch (e) {
  failed = true;
  console.log(`  FAIL ${e.message}`);
} finally {
  await browser.close();
}
console.log(failed ? "the voice proof FAILED" : "the voice proof passed");
console.log(`screenshots in ${out}`);
process.exit(failed ? 1 : 0);
