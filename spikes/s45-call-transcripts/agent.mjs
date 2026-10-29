// S45 spike: the transcriber. A LiveKit Agents (Node) worker that, once
// dispatched to a room, subscribes to every remote microphone separately
// and streams each to LiveKit Inference STT, so every line is credited to
// the track's participant (no diarization). It publishes no audio and, by
// default, is hidden from the room's participant list.
//
// Throwaway: it logs everything as JSON lines (runs/<run>/agent.jsonl) so
// the spike's scripts can measure latency, accuracy, attribution and
// billed seconds.
//
//   ./with-livekit.sh node agent.mjs dev        # registers as "s45-transcriber"
//
// Settings: the dispatch's metadata (JSON: run, model, gate, keyterms,
// text, post, idle_s), over these environment defaults:
//   S45_RUN       run directory name (runs/<run>/), default "scratch"
//   S45_MODEL     inference model, default deepgram/nova-3
//   S45_GATE      none | mute | vad   (what reaches STT; default vad)
//   S45_KEYTERMS  comma-separated names and jargon to boost
//   S45_TEXT      1: publish lk.transcription text streams (default 1)
//   S45_POST      URL: POST each final segment there, HMAC-signed
//   S45_IDLE_S    leave this many seconds after the last person (default 15)
// and, for the whole worker:
//   S45_POST_KEY  the HMAC key for the POSTs (a local test value by default)
//   S45_HIDDEN    0: join visible (to show what a visible agent does)

import { fileURLToPath } from "node:url";
import { appendFileSync, mkdirSync } from "node:fs";
import { createHmac, randomUUID } from "node:crypto";
import { cli, defineAgent, inference, stt as sttNs, WorkerOptions, WorkerPermissions, AutoSubscribe } from "@livekit/agents";
import { AudioStream, RoomEvent, TrackKind, TrackSource } from "@livekit/rtc-node";

// Each job's settings: these defaults, overridden by the dispatch's
// metadata (JSON with the same names in lower case: run, model, gate,
// keyterms, text, post, idle_s), which is how the relay would pass a
// room's choices.
const DEFAULTS = {
  run: process.env.S45_RUN ?? "scratch",
  model: process.env.S45_MODEL ?? "deepgram/nova-3",
  gate: process.env.S45_GATE ?? "vad",
  keyterms: (process.env.S45_KEYTERMS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  text: (process.env.S45_TEXT ?? "1") === "1",
  post: process.env.S45_POST,
  idle_s: Number(process.env.S45_IDLE_S ?? 15),
};
const POST_KEY = process.env.S45_POST_KEY ?? "local-spike-key";
const HIDDEN = (process.env.S45_HIDDEN ?? "1") === "1";
let MODEL, GATE, KEYTERMS, TEXT, POST, IDLE_S, LOG;
const log = (o) => appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...o }) + "\n");
function configure(metadata) {
  let m = {};
  try {
    m = metadata ? JSON.parse(metadata) : {};
  } catch {}
  const c = { ...DEFAULTS, ...m };
  ({ model: MODEL, gate: GATE, keyterms: KEYTERMS, text: TEXT, post: POST, idle_s: IDLE_S } = c);
  const dir = fileURLToPath(new URL(`./runs/${c.run}/`, import.meta.url));
  mkdirSync(dir, { recursive: true });
  LOG = `${dir}agent.jsonl`;
  return c;
}

// The VAD gate: a frame's level (dBFS) over which it's speech. Browser
// microphones with noise suppression sit around -60 in silence; speech
// is -30 to -15. Audio goes to STT from PREROLL_MS before speech until
// HANGOVER_MS after it, and the STT session closes (and finalizes) then.
const SPEECH_DBFS = -45;
const PREROLL_MS = 400;
const HANGOVER_MS = 800;
// The agent's own guess at where an utterance ended (for latency: end of
// speech reaching the agent → final text): this much silence after speech.
const END_MS = 300;

function dbfs(frame) {
  const d = frame.data;
  let s = 0;
  for (let i = 0; i < d.length; i++) s += d[i] * d[i];
  const rms = Math.sqrt(s / Math.max(1, d.length)) / 32768;
  return rms > 0 ? 20 * Math.log10(rms) : -120;
}

function modelOptions(model) {
  if (!KEYTERMS.length) return {};
  if (model.startsWith("deepgram/")) return { keyterm: KEYTERMS };
  if (model.startsWith("assemblyai/")) return { keyterms_prompt: KEYTERMS };
  if (model.startsWith("cartesia/")) return { keyterm: KEYTERMS };
  return {};
}

async function deliver(room, seg) {
  if (TEXT) {
    const t0 = Date.now();
    try {
      await room.localParticipant.sendText(seg.text, {
        topic: "lk.transcription",
        attributes: {
          "lk.segment_id": seg.id,
          "lk.transcribed_track_id": seg.track,
          "lk.transcription_final": String(seg.final),
          "s45.identity": seg.identity,
        },
      });
      log({ ev: "text_sent", seg: seg.id, final: seg.final, ms: Date.now() - t0 });
    } catch (e) {
      log({ ev: "text_error", error: String(e) });
    }
  }
  if (POST && seg.final) {
    const body = JSON.stringify({ room: room.name, ...seg, sent_at: Date.now() });
    const sig = createHmac("sha256", POST_KEY).update(body).digest("hex");
    const t0 = Date.now();
    fetch(POST, { method: "POST", headers: { "content-type": "application/json", "x-s45-signature": sig }, body })
      .then((r) => log({ ev: "post_done", seg: seg.id, status: r.status, ms: Date.now() - t0 }))
      .catch((e) => log({ ev: "post_error", seg: seg.id, error: String(e) }));
  }
}

// One remote microphone, to STT, for as long as it's subscribed.
async function transcribe(room, track, pub, participant) {
  const who = participant.identity;
  const name = participant.name || who;
  const trackSid = track.sid ?? pub.sid;
  const stt = new inference.STT({ model: MODEL, language: "en", modelOptions: modelOptions(MODEL) });
  log({ ev: "track", who, name, track: trackSid, model: MODEL, gate: GATE, keyterms: KEYTERMS });
  const audio = new AudioStream(track, { sampleRate: 16000, numChannels: 1 });

  let stream = null; // the open STT session, if any
  let sessions = 0;
  let pushedMs = 0; // our own count of audio sent to STT
  let framesIn = 0;
  let framesMuted = 0;
  let lastVoiced = 0;
  let inSpeech = false;
  let lastVoicedEnd = 0;
  const preroll = [];
  let prerollMs = 0;
  let segment = randomUUID().slice(0, 8);

  const open = () => {
    const s = stt.stream();
    sessions++;
    const n = sessions;
    log({ ev: "stt_open", who, session: n });
    (async () => {
      try {
        for await (const ev of s) {
          if (ev.type === sttNs.SpeechEventType.INTERIM_TRANSCRIPT || ev.type === sttNs.SpeechEventType.FINAL_TRANSCRIPT) {
            const alt = ev.alternatives?.[0];
            if (!alt?.text?.trim()) continue;
            const final = ev.type === sttNs.SpeechEventType.FINAL_TRANSCRIPT;
            log({ ev: final ? "final" : "interim", who, name, text: alt.text, conf: alt.confidence, start: alt.startTime, end: alt.endTime, session: n });
            const seg = { id: segment, identity: who, name, track: trackSid, final, text: alt.text, start: alt.startTime, end: alt.endTime };
            if (final) segment = randomUUID().slice(0, 8);
            void deliver(room, seg);
          } else if (ev.type === sttNs.SpeechEventType.RECOGNITION_USAGE) {
            log({ ev: "usage", who, audio_s: ev.recognitionUsage?.audioDuration, session: n });
          }
        }
        log({ ev: "stt_closed", who, session: n });
      } catch (e) {
        log({ ev: "stt_error", who, session: n, error: String(e?.message ?? e) });
      }
    })();
    return s;
  };
  const close = () => {
    if (!stream) return;
    stream.endInput();
    log({ ev: "stt_end_input", who });
    stream = null;
  };
  const push = (f) => {
    stream ??= open();
    stream.pushFrame(f);
    pushedMs += (f.samplesPerChannel / f.sampleRate) * 1000;
  };

  for await (const frame of audio) {
    const now = Date.now();
    const ms = (frame.samplesPerChannel / frame.sampleRate) * 1000;
    framesIn++;
    const muted = pub.isMuted ?? pub.muted ?? false;
    if (muted) framesMuted++;
    const voiced = dbfs(frame) > SPEECH_DBFS;
    if (voiced) {
      if (!inSpeech) log({ ev: "rx_start", who });
      inSpeech = true;
      lastVoiced = now;
      lastVoicedEnd = now;
    } else if (inSpeech && now - lastVoiced >= END_MS) {
      inSpeech = false;
      log({ ev: "rx_end", who, at: lastVoicedEnd });
    }
    if (GATE === "none") push(frame);
    else if (GATE === "mute") {
      if (!muted) push(frame);
    } else {
      // vad
      if (voiced) {
        if (!stream) for (const p of preroll.splice(0)) push(p);
        prerollMs = 0;
        push(frame);
      } else if (stream && now - lastVoiced < HANGOVER_MS) push(frame);
      else {
        if (stream) close();
        preroll.push(frame);
        prerollMs += ms;
        while (prerollMs > PREROLL_MS && preroll.length) {
          const f = preroll.shift();
          prerollMs -= (f.samplesPerChannel / f.sampleRate) * 1000;
        }
      }
    }
    if (framesIn % 500 === 0) log({ ev: "frames", who, framesIn, framesMuted, pushed_s: +(pushedMs / 1000).toFixed(2) });
  }
  close();
  log({ ev: "track_done", who, framesIn, framesMuted, pushed_s: +(pushedMs / 1000).toFixed(2), sessions });
}

export default defineAgent({
  entry: async (ctx) => {
    // One job per process, so module-level settings are this job's.
    const cfg = configure(ctx.job.metadata);
    log({ ev: "config", ...cfg, post: cfg.post ? "set" : undefined });
    log({ ev: "job", room: ctx.room.name ?? ctx.job.room?.name, metadata: ctx.job.metadata, dispatch: ctx.job.dispatchId });
    await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
    const room = ctx.room;
    log({ ev: "connected", room: room.name, me: room.localParticipant.identity, hidden: HIDDEN });
    const started = new Set();
    const start = (track, pub, p) => {
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      if (started.has(track.sid)) return;
      started.add(track.sid);
      transcribe(room, track, pub, p)
        .catch((e) => log({ ev: "transcribe_error", who: p.identity, error: String(e) }))
        .finally(() => started.delete(track.sid));
    };
    room.on(RoomEvent.TrackSubscribed, start);
    room.on(RoomEvent.TrackMuted, (pub, p) => log({ ev: "muted", who: p.identity }));
    room.on(RoomEvent.TrackUnmuted, (pub, p) => log({ ev: "unmuted", who: p.identity }));
    room.on(RoomEvent.ParticipantConnected, (p) => log({ ev: "joined", who: p.identity, kind: p.kind }));
    room.on(RoomEvent.Reconnecting, () => log({ ev: "reconnecting" }));
    room.on(RoomEvent.Reconnected, () => log({ ev: "reconnected" }));
    for (const p of room.remoteParticipants.values())
      for (const pub of p.trackPublications.values()) if (pub.track && pub.kind === TrackKind.KIND_AUDIO) start(pub.track, pub, p);

    // Leave once nobody's left (LiveKit would close an empty room after its
    // empty timeout anyway; this is the agent's own, shorter, rule).
    let emptySince = null;
    const timer = setInterval(() => {
      const people = [...room.remoteParticipants.values()].filter((p) => p.kind !== 4 /* AGENT */);
      if (people.length) emptySince = null;
      else if (emptySince === null) emptySince = Date.now();
      else if (Date.now() - emptySince > IDLE_S * 1000) {
        clearInterval(timer);
        log({ ev: "leaving_empty", after_s: IDLE_S });
        ctx.shutdown("room empty");
      }
    }, 1000);
    room.on(RoomEvent.Disconnected, (why) => {
      clearInterval(timer);
      log({ ev: "disconnected", why });
    });
    ctx.addShutdownCallback(async () => log({ ev: "shutdown" }));
  },
});

// Hidden: not in anyone's participant list. canPublish false: no audio.
// canPublishData: the lk.transcription text streams.
const permissions = new WorkerPermissions(false, true, true, false, [], HIDDEN);
cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url), agentName: "s45-transcriber", permissions }));
