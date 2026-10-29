// S45 spike: reads a run's logs and prints the numbers: accuracy (WER
// against LibriSpeech's references), attribution, latency (end of speech
// → interim / final text, at the agent, in other people's browsers as
// lk.transcription captions, and at the relay stand-in over HTTP), and
// what went to STT (seconds).
//
//   node analyze.mjs <run> [--json]

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));
const run = process.argv[2];
const dir = join(here, "runs", run);
const lines = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const agent = lines("agent.jsonl");
const sp = lines("speakers.jsonl");
const relay = lines("relay.jsonl");
const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
const refs = JSON.parse(readFileSync(join(here, "fixtures", "refs.json"), "utf8"));
const refText = {};
const owner = {};
for (const [name, r] of Object.entries(refs))
  for (const u of r.utterances) {
    refText[u.id] = u.text;
    owner[u.id] = name;
  }

const norm = (s) =>
  s
    .toLowerCase()
    .replace(/[-–—]/g, " ")
    .replace(/[^a-z0-9' ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

function edits(ref, hyp) {
  const d = Array.from({ length: ref.length + 1 }, (_, i) => [i, ...Array(hyp.length).fill(0)]);
  for (let j = 1; j <= hyp.length; j++) d[0][j] = j;
  for (let i = 1; i <= ref.length; i++)
    for (let j = 1; j <= hyp.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
  return d[ref.length][hyp.length];
}

const idOf = (name) => `sub_${name.toLowerCase()}`;
const nameOf = (id) => Object.keys(refs).find((n) => idOf(n) === id) ?? id;

// Each utterance played: who, when its speech started and ended (speaker
// clock = the machine's clock), and whether they were muted.
const utts = [];
for (const e of sp) {
  if (e.ev === "say_start") utts.push({ who: e.page, utt: e.utt, start: e.at, muted: e.muted });
  if (e.ev === "say_end_planned") Object.assign(utts.findLast((u) => u.utt === e.utt && u.who === e.page), { end: e.at, voiced_s: e.voiced_s });
}

// Window for an utterance's text: from its start until the same person's
// next utterance starts (or 6 s after it ends).
for (const u of utts) {
  const next = utts.find((v) => v.who === u.who && v.start > u.start);
  u.until = Math.min(next ? next.start : Infinity, u.end + 6000);
}
// AssemblyAI (through LiveKit Inference) sometimes sends a turn's final
// twice: formatted, then unformatted after the session's finalize, with
// the same start and end. Keep the first.
const allFinals = agent.filter((e) => e.ev === "final");
const finals = allFinals.filter((f, i) => !allFinals.slice(0, i).some((g) => g.who === f.who && g.session === f.session && g.start === f.start && g.end === f.end));
const duplicateFinals = allFinals.length - finals.length;
const interims = agent.filter((e) => e.ev === "interim");
const rxEnds = agent.filter((e) => e.ev === "rx_end");

const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const stats = (xs) => (xs.length ? { n: xs.length, p50: pct(xs, 50), p90: pct(xs, 90), max: Math.max(...xs), mean: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) } : { n: 0 });

let refWords = 0;
let errs = 0;
const perUtt = [];
const latFinal = [];
const latFinalRx = [];
const latFirstInterim = [];
const latCaption = [];
const latRelay = [];
for (const u of utts) {
  const id = idOf(u.who);
  const mine = finals.filter((f) => f.who === id && f.t >= u.start && f.t < u.until);
  const hyp = mine.map((f) => f.text).join(" ");
  const ref = norm(refText[u.utt]);
  const e = edits(ref, norm(hyp));
  const row = { who: u.who, utt: u.utt, muted: !!u.muted, ref: refText[u.utt].toLowerCase(), hyp, wer: +(e / ref.length).toFixed(3) };
  if (!u.muted) {
    refWords += ref.length;
    errs += e;
  }
  const last = mine.at(-1);
  if (last && !u.muted) {
    row.final_ms = last.t - u.end;
    latFinal.push(last.t - u.end);
    const rx = rxEnds.filter((r) => r.who === id && r.at <= last.t + 50 && r.at >= u.start).at(-1);
    if (rx) {
      row.final_after_rx_ms = last.t - rx.at;
      latFinalRx.push(last.t - rx.at);
    }
    const fi = interims.find((x) => x.who === id && x.t >= u.start && x.t < u.until);
    if (fi) latFirstInterim.push(fi.t - u.start);
    // Captions: the final segment's arrival on everyone else's page.
    const caps = sp.filter((c) => c.ev === "caption" && c.final && c.seg && c.page !== u.who && c.text === last.text);
    for (const c of caps) latCaption.push(c.got - u.end);
    const r = relay.find((x) => x.text === last.text && x.identity === id);
    if (r) latRelay.push(r.t - u.end);
  }
  perUtt.push(row);
}

// Attribution: each final's text against every reference; the reference
// it matches best should belong to the identity it was credited to.
let attrOk = 0;
let attrBad = 0;
const misattributed = [];
for (const f of finals) {
  const w = norm(f.text);
  if (w.length < 2) continue;
  let best = null;
  let bestScore = 0;
  for (const [id, t] of Object.entries(refText)) {
    const r = new Set(norm(t));
    const score = w.filter((x) => r.has(x)).length / w.length;
    if (score > bestScore) [best, bestScore] = [id, score];
  }
  if (bestScore < 0.5) continue;
  if (idOf(owner[best]) === f.who) attrOk++;
  else {
    attrBad++;
    misattributed.push({ credited: nameOf(f.who), text: f.text, best_match: best });
  }
}

// What went to STT: our count of audio pushed, and the stream's own usage.
const usage = {};
for (const e of agent.filter((e) => e.ev === "usage")) usage[e.who] = (usage[e.who] ?? 0) + (e.audio_s ?? 0);
const done = agent.filter((e) => e.ev === "track_done");
const tracks = done.map((d) => ({ who: nameOf(d.who), track_s: +(d.framesIn / 100).toFixed(1), muted_frames_s: +(d.framesMuted / 100).toFixed(1), pushed_s: d.pushed_s, usage_s: +(usage[d.who] ?? 0).toFixed(1), sessions: d.sessions }));
// (usage is per identity: someone who rejoined has two tracks, one total)
const sttS = agent.filter((e) => e.ev === "usage").reduce((a, e) => a + (e.audio_s ?? 0), 0);
const trackS = tracks.reduce((a, t) => a + t.track_s, 0);
const speechS = utts.filter((u) => !u.muted).reduce((a, u) => a + (u.voiced_s ?? 0), 0);

// The agent in anyone's participant list?
const peopleSeen = sp.filter((e) => e.people).flatMap((e) => e.people);
const agentVisible = peopleSeen.some((p) => p.isAgent || p.kind === 4 || String(p.id).startsWith("agent-"));
const captionsFrom = [...new Set(sp.filter((e) => e.ev === "caption").map((e) => e.from))];

const out = {
  run,
  meta,
  wer: refWords ? +(errs / refWords).toFixed(4) : null,
  ref_words: refWords,
  attribution: { ok: attrOk, bad: attrBad, misattributed },
  duplicate_finals_dropped: duplicateFinals,
  latency_ms: {
    final_after_speech_end: stats(latFinal),
    final_after_speech_reached_agent: stats(latFinalRx),
    first_interim_after_speech_start: stats(latFirstInterim),
    caption_in_other_browsers_after_speech_end: stats(latCaption),
    relay_http_after_speech_end: stats(latRelay),
  },
  stt: { tracks, stt_s: +sttS.toFixed(1), track_s: +trackS.toFixed(1), speech_s: +speechS.toFixed(1), gated_fraction: trackS ? +(sttS / trackS).toFixed(3) : null },
  agent_visible_in_participant_list: agentVisible,
  caption_sender_identities: captionsFrom,
  relay_signed_ok: relay.length ? relay.every((r) => r.ok) : null,
  utterances: perUtt,
};
writeFileSync(join(dir, "summary.json"), JSON.stringify(out, null, 1));
if (process.argv.includes("--json")) console.log(JSON.stringify(out, null, 1));
else {
  const { utterances, ...head } = out;
  console.log(JSON.stringify(head, null, 1));
  for (const u of utterances) console.log(`${u.who.padEnd(3)} ${u.muted ? "MUTED " : ""}wer=${u.wer} final=${u.final_ms ?? "-"}ms  ${u.hyp.slice(0, 90)}`);
}
