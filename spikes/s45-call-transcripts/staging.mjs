// S45 spike: the transcriber in a real voice room on staging, through
// the real page. Ada and Bo open a demo room on staging
// (arugula-stream-staging.fly.dev, unchanged main), each in a browser of
// their own whose fake microphone plays a few of their LibriSpeech
// utterances; both join voice and unmute. Then, as the relay would,
// dispatch.exs puts the transcriber in the LiveKit room the relay made
// (demo:<room>:voice). After ~35 s: who the agent heard (identities are
// the relay's member subs), what it wrote, and screenshots of each page's
// voice strip (no transcriber in it).
//
//   ./with-livekit.sh node staging.mjs [relay]

import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));
const relay = (process.argv[2] ?? "https://arugula-stream-staging.fly.dev").replace(/\/$/, "");
const run = `staging-${Date.now().toString(36)}`;
const room = `s45-${Date.now().toString(36)}`;
const lkRoom = `demo:${room}:voice`;
const dir = join(here, "runs", run);
mkdirSync(join(dir, "audio"), { recursive: true });
const refs = JSON.parse(readFileSync(join(here, "fixtures", "refs.json"), "utf8"));

// Each person's microphone file: four utterances with a second between.
function micFile(name) {
  const f = join(dir, "audio", `${name}.wav`);
  if (!existsSync(f)) {
    const inputs = refs[name].utterances.slice(0, 4).flatMap((u) => ["-i", join(here, "fixtures", u.wav)]);
    const n = inputs.length / 2;
    const parts = Array.from({ length: n }, (_, i) => `[${i}]apad=pad_dur=1[a${i}]`).join(";");
    const cat = Array.from({ length: n }, (_, i) => `[a${i}]`).join("") + `concat=n=${n}:v=0:a=1`;
    execFileSync("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", `${parts};${cat}`, "-ar", "48000", "-ac", "1", f]);
  }
  return f;
}

async function person(name) {
  const browser = await chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${micFile(name)}`, "--autoplay-policy=no-user-gesture-required"],
  });
  const ctx = await browser.newContext({ permissions: ["microphone", "camera"], viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  await page.goto(`${relay}/r/${room}`);
  await page.getByPlaceholder("your name").fill(name);
  await page.getByRole("button", { name: "Join the room" }).click();
  await page.locator(".room .bar .stats", { hasText: "here" }).waitFor();
  return { browser, page, bar: page.locator(".voicebar") };
}

const say = (s) => console.log(`· ${s}`);
const ada = await person("Ada");
const bo = await person("Bo");
for (const p of [ada, bo]) {
  await p.bar.getByRole("button", { name: "Join voice" }).click();
  await p.bar.getByRole("button", { name: "Unmute" }).waitFor({ timeout: 20_000 });
}
say(`Ada and Bo are in ${relay}/r/${room}'s voice (LiveKit room ${lkRoom})`);
const meta = { run, model: "deepgram/nova-3", gate: "vad", keyterms: ["Ada", "Bo"], text: true };
const r = execFileSync("mise", ["exec", "-C", join(here, "../../relay"), "--", "elixir", join(here, "dispatch.exs"), "create", lkRoom, "s45-transcriber", JSON.stringify(meta)], { encoding: "utf8" });
say(`dispatched: ${JSON.parse(r).status}`);
await ada.page.waitForTimeout(3000);
for (const p of [ada, bo]) await p.bar.getByRole("button", { name: "Unmute" }).click();
say("both unmuted; listening for 35 s");
await ada.page.waitForTimeout(35_000);
const chips = {};
for (const [n, p] of [["Ada", ada], ["Bo", bo]]) {
  chips[n] = await p.bar.locator(".voice-person").allTextContents();
  await p.page.screenshot({ path: join(dir, `${n}.png`) });
}
say(`voice strips: ${JSON.stringify(chips)}`);
for (const p of [ada, bo]) await p.browser.close();
await new Promise((r) => setTimeout(r, 3000));
const agent = existsSync(join(dir, "agent.jsonl")) ? readFileSync(join(dir, "agent.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
const tracks = agent.filter((e) => e.ev === "track").map((e) => `${e.name} (${e.who})`);
const finals = agent.filter((e) => e.ev === "final");
say(`the agent heard: ${tracks.join(", ") || "nobody"}`);
for (const f of finals) console.log(`  ${f.name}: ${f.text}`);
writeFileSync(join(dir, "result.json"), JSON.stringify({ relay, room, lkRoom, chips, tracks, finals: finals.map((f) => ({ name: f.name, who: f.who, text: f.text })) }, null, 1));
console.log(`logs in runs/${run}/`);
