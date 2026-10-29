// S45 spike: Build's LiveKit Inference STT concurrency (documented as 5
// connections). Opens N streams at once, each fed one ~8 s utterance in
// real time, and logs which ones transcribe and which fail.
//   ./with-livekit.sh node concurrency.mjs [n=6]
import { inference, stt as sttNs, initializeLogger } from "@livekit/agents";
import { AudioFrame } from "@livekit/rtc-node";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

initializeLogger({ pretty: false, level: "fatal" });
const here = fileURLToPath(new URL(".", import.meta.url));
const n = Number(process.argv[2] ?? 6);
const refs = JSON.parse(readFileSync(join(here, "fixtures/refs.json"), "utf8"));
const utts = Object.values(refs).flatMap((r) => r.utterances).filter((u) => u.seconds > 7 && u.seconds < 9.5);
function pcm(wav) {
  const b = readFileSync(join(here, "fixtures", wav));
  let o = 12;
  while (b.toString("ascii", o, o + 4) !== "data") o += 8 + b.readUInt32LE(o + 4);
  return new Int16Array(b.buffer.slice(b.byteOffset + o + 8, b.byteOffset + o + 8 + b.readUInt32LE(o + 4)));
}
const out = [];
const t0 = Date.now();
await Promise.all(
  Array.from({ length: n }, async (_, i) => {
    const u = utts[i % utts.length];
    const s = new inference.STT({ model: "deepgram/nova-3", language: "en" }).stream();
    const r = { i, utt: u.id, finals: [], error: null, audio_s: 0 };
    const reader = (async () => {
      try {
        for await (const ev of s) {
          if (ev.type === sttNs.SpeechEventType.FINAL_TRANSCRIPT) r.finals.push({ ms: Date.now() - t0, text: ev.alternatives?.[0]?.text });
          if (ev.type === sttNs.SpeechEventType.RECOGNITION_USAGE) r.audio_s += ev.recognitionUsage.audioDuration;
        }
      } catch (e) {
        r.error = String(e?.message ?? e);
      }
    })();
    const d = pcm(u.wav);
    for (let p = 0; p < d.length; p += 480) {
      s.pushFrame(new AudioFrame(d.slice(p, p + 480), 48000, 1, Math.min(480, d.length - p)));
      await new Promise((res) => setTimeout(res, 10));
    }
    s.endInput();
    await Promise.race([reader, new Promise((res) => setTimeout(res, 15000))]);
    if (!r.finals.length && !r.error) r.error = "no transcript within 15 s";
    out.push(r);
  }),
);
out.sort((a, b) => a.i - b.i);
for (const r of out) console.log(`stream ${r.i}: ${r.error ? "FAILED " + r.error.slice(0, 160) : `${r.finals.length} finals, ${r.audio_s.toFixed(1)} s audio: ${r.finals.map((f) => f.text).join(" ").slice(0, 70)}`}`);
mkdirSync(join(here, "runs/concurrency"), { recursive: true });
writeFileSync(join(here, `runs/concurrency/n${n}.json`), JSON.stringify(out, null, 1));
process.exit(0);
