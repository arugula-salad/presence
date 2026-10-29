// The current speaker (../src/speaker.ts) over timelines of who's speaking
// when, sampled every 100 ms as ./call samples: who takes the spot, who
// keeps it, and what doesn't flip it. And the size a camera's video goes
// up at (../src/call.ts). Run with `node --experimental-strip-types`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SpeakerPicker, TAKE_MS, HOLD_MS } from "../src/speaker.ts";
import { videoSize } from "../src/call.ts";

const STEP = 100;
const PEOPLE = ["me", "ada", "bea", "cy"];

/** Feed `p` from `from` to `to` ms, speaking `who(t)` (loudest first) at
 * each sample; returns who had the spot at each, as [t, sub]. */
function run(p, from, to, who, people = PEOPLE, coarse = false) {
  const seen = [];
  for (let t = from; t < to; t += STEP) seen.push([t, p.update(t, { speakers: who(t), people, coarse })]);
  return seen;
}
const holder = (seen) => seen.at(-1)[1];
/** When the spot first went to `sub` (ms), or -1. */
const firstAt = (seen, sub) => seen.find(([, s]) => s === sub)?.[0] ?? -1;
const during = (a, b, ...who) => (t) => (t >= a && t < b ? who : []);

test("nobody's spoken: nobody has it; the first to talk long enough takes the empty spot, and a cough doesn't", () => {
  const p = new SpeakerPicker("me");
  assert.equal(holder(run(p, 0, 500, () => [])), null);
  assert.equal(holder(run(p, 500, 1500, during(600, 800, "cy"))), null, "a cough");
  const seen = run(p, 1500, 3000, during(1700, 3000, "ada"));
  assert.equal(firstAt(seen, "ada"), 1700 + TAKE_MS);
});

test("a page too busy to sample on time doesn't break a run up", () => {
  const p = new SpeakerPicker("me");
  run(p, 0, 2000, during(0, 1000, "ada"));
  // Samples 450 ms apart, Bea talking at every one.
  const seen = [];
  for (let t = 2000; t < 5000; t += 450) seen.push([t, p.update(t, { speakers: t >= 2900 ? ["bea"] : [], people: PEOPLE })]);
  assert.equal(firstAt(seen, "bea"), 2900 + 2 * 450);
});

test("nor does a cough that straddles two samples half a second apart look like half a second of talking", () => {
  const p = new SpeakerPicker("me");
  run(p, 0, 2000, during(0, 1000, "ada"));
  const seen = [];
  // The cough shows in the samples either side of it, 550 ms apart.
  for (let t = 2000; t < 6000; t += 550) seen.push([t, p.update(t, { speakers: t === 3100 || t === 3650 ? ["cy"] : [], people: PEOPLE })]);
  assert.equal(firstAt(seen, "cy"), -1);
});

test("a new speaker takes over after TAKE_MS of talking, not before", () => {
  const p = new SpeakerPicker("me");
  run(p, 0, 3000, during(0, 1000, "ada"));
  const seen = run(p, 3000, 6000, during(4000, 6000, "bea"));
  assert.equal(firstAt(seen, "bea"), 4000 + TAKE_MS);
  assert.equal(seen.find(([t]) => t === 4000 + TAKE_MS - STEP)[1], "ada", "still Ada a sample before");
});

test("the one who has it keeps it through pauses and when nobody's talking", () => {
  const p = new SpeakerPicker("me");
  const seen = run(p, 0, 10_000, (t) => (t < 1000 || (t >= 3000 && t < 3400) ? ["ada"] : []));
  assert.ok(seen.filter(([t]) => t >= TAKE_MS).every(([, s]) => s === "ada"), "Ada all along, once she has it");
});

test("a cough under 300 ms doesn't flip it, nor does one in each of two quiet spells", () => {
  const p = new SpeakerPicker("me");
  run(p, 0, 2000, during(0, 1000, "ada"));
  for (const ms of [100, 200, 300]) {
    const seen = run(p, 2000, 4000, during(2500, 2500 + ms, "cy"));
    assert.equal(holder(seen), "ada", `a ${ms} ms blip`);
    assert.equal(firstAt(seen, "cy"), -1);
  }
  const seen = run(p, 4000, 8000, (t) => ((t >= 4500 && t < 4700) || (t >= 6000 && t < 6200) ? ["cy"] : []));
  assert.equal(firstAt(seen, "cy"), -1, "two blips a second and more apart");
});

test("pauses between words don't start a run over; a longer silence does", () => {
  const p = new SpeakerPicker("me");
  run(p, 0, 2000, during(0, 1000, "ada"));
  // Bea: 200 ms words with 200 ms gaps. Her run carries on, and she takes
  // over once it's TAKE_MS long and she's talking.
  const words = (t) => (t >= 3000 && (t - 3000) % 400 < 200 ? ["bea"] : []);
  const seen = run(p, 2000, 5000, words);
  assert.ok(firstAt(seen, "bea") >= 3000 + TAKE_MS && firstAt(seen, "bea") <= 3000 + TAKE_MS + 200, `took over at ${firstAt(seen, "bea")}`);
  const q = new SpeakerPicker("me");
  run(q, 0, 2000, during(0, 1000, "ada"));
  // Cy: 300 ms, a 500 ms gap, 300 ms: never long enough running.
  const halting = run(q, 2000, 5000, (t) => ((t >= 3000 && t < 3300) || (t >= 3800 && t < 4100) ? ["cy"] : []));
  assert.equal(firstAt(halting, "cy"), -1);
});

test("you're never it on your own screen, unless you're alone", () => {
  const p = new SpeakerPicker("me");
  const seen = run(p, 0, 3000, () => ["me"]);
  assert.ok(seen.every(([, s]) => s === null), "you talking: nobody");
  assert.equal(holder(run(p, 3000, 4000, () => ["me"], ["me"])), "me", "alone: you");
  const back = run(p, 4000, 5000, () => ["me", "bea"], ["me", "bea"]);
  assert.equal(firstAt(back, "bea"), 4000 + TAKE_MS, "someone else here and talking: them, after TAKE_MS");
  assert.equal(holder(run(p, 5000, 8000, () => ["me"], ["me", "bea"])), "bea");
});

test("someone saying 'right' under the speaker, quieter, doesn't take over", () => {
  const p = new SpeakerPicker("me");
  run(p, 0, 2000, during(0, 5000, "ada"));
  const seen = run(p, 2000, 5000, (t) => (t < 5000 ? ["ada", "bea"] : []));
  assert.equal(firstAt(seen, "bea"), -1, "Bea, quieter, all the while");
  const louder = run(p, 5000, 7000, () => ["bea", "ada"]);
  assert.equal(firstAt(louder, "bea"), 5000 + TAKE_MS, "louder than Ada: she takes over");
});

test("whoever takes over holds it a moment: two people over each other don't flip it back and forth", () => {
  const p = new SpeakerPicker("me");
  run(p, 0, 2000, during(0, 1000, "ada"));
  // Bea, then Ada louder again right away, swapping every 600 ms.
  const seen = run(p, 2000, 8000, (t) => (Math.floor((t - 2000) / 600) % 2 ? ["ada", "bea"] : ["bea", "ada"]));
  const changes = seen.filter(([, s], i) => i && s !== seen[i - 1][1]).map(([t]) => t);
  for (let i = 1; i < changes.length; i++) assert.ok(changes[i] - changes[i - 1] >= HOLD_MS, `changes at ${changes}`);
});

test("when the one who has it leaves, it goes back to whoever had it before", () => {
  const p = new SpeakerPicker("me");
  run(p, 0, 2000, during(0, 1000, "ada"));
  run(p, 2000, 5000, during(2000, 3000, "bea"));
  assert.equal(p.current, "bea");
  const seen = run(p, 5000, 6000, () => [], ["me", "ada", "cy"]);
  assert.equal(holder(seen), "ada");
  // Falling back isn't a turn: Cy takes over after TAKE_MS, no hold.
  const next = run(p, 6000, 8000, during(6000, 8000, "cy"), ["me", "ada", "cy"]);
  assert.equal(firstAt(next, "cy"), 6000 + TAKE_MS);
  const gone = run(p, 8000, 9000, () => [], ["me", "bea"]);
  assert.equal(holder(gone), "bea", "Ada and Cy gone: Bea, who had it before them");
});

test("LiveKit's coarse list (no levels here) takes a second, past its tail on a cough", () => {
  const p = new SpeakerPicker("me");
  run(p, 0, 2000, during(0, 1000, "ada"), PEOPLE, true);
  // LiveKit reads a 200 ms cough as 400–800 ms of speaking.
  const cough = run(p, 2000, 4000, during(2400, 3200, "cy"), PEOPLE, true);
  assert.equal(firstAt(cough, "cy"), -1);
  const turn = run(p, 4000, 7000, during(4400, 6800, "bea"), PEOPLE, true);
  assert.equal(firstAt(turn, "bea"), 5400);
});

test("a camera's video goes up at the biggest 16:9 layer inside it, never scaled up", () => {
  assert.deepEqual(videoSize(1280, 720), { width: 1280, height: 720, maxBitrate: 1_500_000 });
  assert.deepEqual(videoSize(1920, 1080), { width: 1280, height: 720, maxBitrate: 1_500_000 });
  assert.deepEqual(videoSize(640, 480), { width: 640, height: 360, maxBitrate: 500_000 }, "Chrome's fake camera, most webcams' 480p");
  assert.deepEqual(videoSize(960, 540), { width: 640, height: 360, maxBitrate: 500_000 });
  assert.deepEqual(videoSize(480, 640), { width: 360, height: 640, maxBitrate: 500_000 }, "a phone held upright");
  assert.deepEqual(videoSize(320, 240), { width: 320, height: 180, maxBitrate: 150_000 });
});
