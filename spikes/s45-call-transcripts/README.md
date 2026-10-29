# S45: call transcripts (spike)

Arugula native issue #340. The question: what does it take for arugula.stream to transcribe calls and voice per speaker, Granola-style? The plan was a hidden LiveKit agent that streams each person's microphone to speech-to-text on its own track, so every line is credited without diarization. Text goes to the browser and the relay, and Claude writes notes afterwards.

**Verdict: go, with changes.** Every number below was measured on our LiveKit Cloud project (Build plan) on 2026-10-29. Staging was used read-only: no relay change and no deploy.

All throwaway code is in this directory and none of it is product code. Total speech-to-text used in the spike: **954.5 s ≈ 15.9 minutes** by our counters, against a budget of 30. That is 106 STT sessions: 13.1 min of Nova-3, 2.0 min of AssemblyAI and 0.8 min of Cartesia.

## Recommended architecture

```
 browser (call.ts) ──mic track──▶ LiveKit room <app>:<room>:voice | <app>:<room>:<call>
        ▲    ▲                           │ every remote mic, one track each
        │    │ lk.transcription          ▼
        │    └──────────────── transcriber (Node, @livekit/agents, hidden, no audio out)
        │                      per track: VAD gate → LiveKit Inference STT (Nova-3 + keyterms)
        │                                 │ finals, HMAC-signed POST
        │ room channel push               ▼
        └──────────────────────────── relay (Phoenix): stores segments, tells the room,
                                       dispatches the agent (Twirp or token roomConfig),
                                       asks Claude for notes when the session ends
```

- **Worker:** Node `@livekit/agents` 1.9.5, `agentName` set (explicit dispatch only), `WorkerPermissions(canPublish=false, canSubscribe=true, canPublishData=true, hidden=true)`.
- **Hosting:** a Fly app next to the relay (iad), not LiveKit Cloud agent hosting (see 7).
- **Per track:** a local VAD gate. Audio goes to STT from 400 ms before speech until 800 ms after it, and each utterance gets its own STT session. Muted or silent tracks cost nothing.
- **Delivery, both channels:** `lk.transcription` text streams give live captions (interims and finals) to everyone in the LiveKit room. Finals are also POSTed, HMAC-signed, to the relay, which keeps the durable copy. The relay can push them to room members who are outside the call, and it feeds the notes step.
- **Dispatch:** `roomConfig.agents` in the room token when transcription is on from the start. `AgentDispatchService/CreateDispatch` when someone turns it on mid-call.
- **Notes:** Claude Sonnet 5.5 at low effort, once the room empties, over the stored segments.

## Results by run

`node analyze.mjs <run>` prints these numbers; `python3 -I table.py <runs…>` prints this table. Timing is wall clock on one machine: the fake speakers, the agent and the browsers all ran here, against LiveKit Cloud (Canada B / Montreal).

| run | model | gate | WER | ref words | lines credited right | final after speech end p50/p90 ms | final after speech reached agent p50 | first interim after speech start p50 | caption in others' browsers p50/p90 | STT s | track s | speech s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| turns-nova3 | deepgram/nova-3 | vad | 4.3% | 258 | 39/39 | 377 / 474 | 299 | 1530 | 397 / 493 | 121.9 | 451.3 | 111.7 |
| turns-assembly | assemblyai/universal-streaming | vad | 3.1%¹ | 258 | 17/17 | 627 / 757 | 573 | 1711 | 645 / 776 | 118.9 | 451.5 | 111.7 |
| short-ungated | deepgram/nova-3 | none | 6.7% | 105 | 15/15 | 338 / 621 | 281 | 1501 | 355 / 638 | 197.8 | 198 | 45.3 |
| short-cartesia | cartesia/ink-whisper | vad | 6.7% | 105 | 12/12 | 529 / 889 | 454 | (no interims) | 547 / 906 | 46.8 | 198.3 | 45.3 |
| jargon-plain | deepgram/nova-3 | vad | 6.2% | 96 | 11/11 | 306 / 411 | 256 | 1531 | 324 / 428 | 46.9 | 190.2 | 41.5 |
| jargon-keyterms | deepgram/nova-3 | vad | 4.2% | 96 | 11/11 | 283 / 402 | 240 | 1522 | 300 / 420 | 46.8 | 189.9 | 41.5 |
| edges | deepgram/nova-3 | vad | 2.8% | 109 | 12/12 | 339 / 402 | 298 | 1699 | 357 / 430 | 49.6 | 258.1 | 44.5 |
| muted-none | deepgram/nova-3 | none | 9.7% | 31 | 6/6 | 426 | 354 | 1592 | – | 70.2 | 70.3 | 14.3 |
| muted-mute | deepgram/nova-3 | mute | 6.5% | 31 | 6/6 | 427 | 357 | 1763 | – | 25.8 | 70.3 | 14.3 |

¹ AssemblyAI, through Inference, sends a turn's final a second time, unformatted, after the session's finalize, with the same start and end. Nine of these duplicates were dropped before scoring; the product has to dedupe the same way. Without that, the WER reads 61%.

**How these were measured:**
- **WER:** LibriSpeech test-clean, with one real speaker per fake person: Ada = 121, Bo = 1089, Cy = 2961, Di = 61. Normalization is lower case, punctuation removed, hyphens turned into spaces. "lovemaking" against "love making" counts as an error, so these figures run a little high.
- **Lines credited right:** each final is matched to its best reference by word overlap. The check is that the reference belongs to the identity the line was credited to.
- **Latency:** "speech end" is when the speaker's page played the last voiced 10 ms of the utterance. "Reached agent" is the agent's own energy detector on the received audio. Captions are measured on the other people's pages only.
- **STT seconds:** the Inference stream's own `RECOGNITION_USAGE` events. They match the agent's own count of audio pushed to within 1%.

## Answers

### 1. Runtime: Node, as planned. The agent must be hidden.

**Node `@livekit/agents` 1.9.5, worker run locally against our project.** The Python framework (1.8.10) is the older and larger of the two, but for this job Node has everything needed:
- `inference.STT` covers Deepgram, AssemblyAI, Cartesia, Speechmatics, xAI and Google, with typed options (keyterms, endpointing).
- `AudioStream` per remote track.
- `sendText`/`streamText` for text streams.
- `WorkerPermissions` with `hidden`.

The transcriber doesn't use `AgentSession` (no LLM, no TTS, no turn-taking), which is where the Python lead matters. Node keeps the repo at TypeScript plus Elixir, shares types with `client/`, and builds with the same toolchain.

**Hidden works, and is required.**
- With `hidden: true`, the agent never appears in `room.remoteParticipants` in livekit-client 2.23.0, the product's version (`runs/presence-*`, `runs/turns-*`: the agent was never in anyone's list).
- Visible, it shows up as `kind: 4 (AGENT)`, `isAgent: true` (`runs/presence-visible`). `call.ts` builds `people` straight from `remoteParticipants`, so a visible agent would:
  - become a tile (`meet/src/room.tsx` makes a stand-in member for an unknown sub),
  - be named in "In a call with …",
  - break the call's alone rule (`client.ts`: `had > 1 && people.length <= 1` ends a call, and `lonely()` arms `ALONE_MS`). A person left alone with the bot would never be hung up on.
- The staging run shows only Ada and Bo in the real page with the agent in the room (`runs/staging-mvu6yut5/*.png`).
- **Side effect:** text streams from a hidden participant arrive with an **empty sender identity** (`caption_sender_identities: [""]`). Attribution has to ride the stream's attributes. The spike sends `lk.transcribed_track_id` plus its own `s45.identity`.

**The relay can dispatch it from Elixir.** `dispatch.exs` is about 60 lines: OTP `crypto` for an HS256 JWT with `video.roomAdmin` on that room, `:httpc`, and Elixir's `JSON`, with no new dependencies.
- `AgentDispatchService/CreateDispatch` (Twirp) answers 200 in about 190 ms.
- The job starts about 365 ms after that returns (12 runs, 355–378 ms), the agent is connected about 400 ms later, and the first track is subscribed 225 ms after that. That makes about **1 s from dispatch to transcribing**.
- The job's settings ride the dispatch `metadata` (run, model, gate, keyterms), which is how the relay would pass a room's choices.

**Room token roomConfig also works from an Elixir-built JWT.**
- `roomConfig: {agents: [{agentName, metadata}]}` in the relay's call grant had the agent connected 0.73–0.82 s after the first person joined.
- It only fires **when that join creates the room**:
  - roomConfig in every person's token still made exactly one dispatch (`presence-tokenall`);
  - a roomConfig token for someone joining an existing room made **none** (`presence-tokenlate`).
- So use roomConfig when transcription is on from the start, and the API when it's turned on mid-call.

### 2. STT on Build: works. Nova-3 with keyterms, as planned.

LiveKit Inference STT works on the free Build plan. Deepgram Nova-3, AssemblyAI Universal-Streaming and Cartesia Ink Whisper all transcribed.

| | Nova-3 | AssemblyAI U-S | Cartesia Ink Whisper |
|---|---|---|---|
| WER (same audio) | 4.3% (258 words); 6.7% (105) | 3.1% (258) | 6.7% (105) |
| final after speech end, p50 / p90 | **377 / 474 ms** | 627 / 757 ms | 529 / 889 ms |
| interims | yes, about 1 a second of audio; the first about 1.5 s after speech starts | yes | none |
| finals | per phrase (several per utterance: good for captions) | one per turn, plus a duplicate (see ¹) | per phrase |
| price on Build/Ship (pricing page) | $0.0048/min | $0.0025/min | $0.0030/min |

**Pick Nova-3.** It is about 250 ms faster to a final, it gives interims, and it doesn't duplicate finals. AssemblyAI's slightly better WER and half the price make it the fallback, or the cheap tier. Inference's server-side `fallback` option can chain the two.

**Keyterms help.** We passed participant names and jargon (Timaeus, Neoplatonists, Fitzooth, harangue, angor, mummeries) as Nova-3 `keyterm`:
- Both words Nova-3 had misheard came out right: "Harang" became "Harangue", and "Fitzuth" became "Fitzooth".
- The jargon set's WER went from 6.2% to 4.2%, with no latency cost (283 against 306 ms p50).
- The relay should send each room's people names, plus any terms the room sets, in the dispatch metadata.

### 3. Attribution: as planned, with no diarization needed.

Every line in every run went to the right person: 39/39 in turns, 12/12 in edges, and all 26 lines in the staging room through the real page with Krisp on.

- **Talking over each other** (Bo starts 2 s into Ada's 10 s line): both lines were transcribed in full and credited correctly, with no bleed. The only error was "house cleaning" against "housecleaning". Two people in one physical room on open mics would be a different story (echo cancellation's job, not tested).
- **Muted person:**
  - Nothing a muted person says reaches the text. Cy's muted line produced nothing (`edges`).
  - **But LiveKit keeps delivering frames, as silence, for a muted track to the agent:** 44.4 s of frames during 44 s muted (`muted-none`).
  - A naive transcriber that forwards every frame therefore **bills the muted time**: 70.2 s billed for 70.3 s of track, of which 14.3 s was speech.
  - Gating on the mute state cut that to 25.8 s (`muted-mute`); the VAD gate also gets there.
  - A persistent STT session sat 45 s with no audio without an inactivity timeout.
- **Late joiner** (Di): their track was subscribed and transcribed 425 ms after they joined.
- **Leave and rejoin** (Bo): their new track was picked up 420 ms after rejoining. The identity (the member sub) is the same, so the transcript continues under one person.

### 4. Cost: VAD gating is the change that matters (about 4× cheaper)

**Gating, measured:**
- With the VAD gate, STT was **1.09 × speech time**; the overhead is the 400 ms pre-roll and 800 ms hangover per utterance.
- With three people taking turns, that was **24–27% of track time** (`gated_fraction` 0.236–0.27).
- Ungated, it is 100% of track time (`short-ungated`: 197.8 s billed for 198 s of track and 45.3 s of speech).

**A 30-minute, 4-person call, extrapolated:**

| | STT minutes | Nova-3 | AssemblyAI |
|---|---|---|---|
| no gate (or mute gate only, since in a call everyone's unmuted) | 4 × 30 = 120 | $0.58 | $0.30 |
| VAD gate (someone always talking: speech ≈ 30 min × 1.09) | 33 (30–36) | **$0.16** | $0.08 |

**Other costs per such call:**
- About 30 WebRTC participant minutes for the agent (it counts as a participant).
- No agent session minutes when self-hosted. Agent session minutes are only for agents deployed on LiveKit Cloud.
- About $0.02 for notes (see 6).
- **Total with Nova-3 and the gate: about $0.18 per 30-minute, 4-person call.**

**Plan limits:**
- **The Build plan can't carry the product.** Its $2.50 of Inference credit is a hard cap (requests fail past it), which is about 50 STT minutes a month: about 1.5 such calls.
- Launch needs Ship ($50/mo, $5 credit, then usage). The alternative is the Deepgram plugin with our own Deepgram key, which bypasses Inference's caps and credit.

**LiveKit's usage page: not read.**
- The Chrome extension isn't connected in this session, and LiveKit's Analytics API answers `401 scale plan or higher is required`.
- **Jake or the lead should read cloud.livekit.io/projects/p_393ygiaktwh/settings/billing.**
- We expect about **15.9 Inference STT minutes** (about $0.07).
- One thing to check there: **whether Inference rounds each STT session up** (to a minute, say). The VAD gate opens one session per utterance: 106 sessions in this spike. Per-second billing should read about 16 minutes; per-session rounding would read far more, and the gate would then need to keep one session open per track and stop sending audio, instead of closing sessions.

### 5. Delivery: both. Text streams for captions, HTTP for the durable copy.

| | live captions to browsers | durable copy | who gets it | code |
|---|---|---|---|---|
| `lk.transcription` text streams | **p50 397 / p90 493 ms** after speech end (20 ms over the agent's final) | none | only people in that LiveKit room | agent: one `sendText` per segment; client: a text-stream handler mapping `lk.transcribed_track_id` / identity attribute → person (about 40 lines in `call.ts`); relay: none |
| agent → relay HTTP POST (HMAC-SHA256) | final + relay push: about +30–60 ms over text streams (a warm POST to staging is 32 ms from here; the stand-in relay got finals 1 ms after the agent had them) | yes | everyone in the presence room, including people outside voice; history on rejoin; notes | agent: one fetch; relay: an endpoint, signature check, a segments table, a channel push |

Both arrive about 0.4 s after a person stops talking. Text streams need no relay code and carry interims cheaply, but they reach only the call's own participants and leave nothing behind. HTTP is what makes storage, notes and captions for people outside voice possible.

**Do both.** Send interims and finals by text stream, and POST finals only. Signed POSTs verified in every run (`relay_signed_ok: true`).

### 6. Notes: as planned, with Sonnet 5.5

- **The key:** Infisical has an Anthropic API key, `ARUGULA_HOSTED_ANTHROPIC_KEY` in `/illogical/control` (Arugula control's hosted key; the product should get its own in `/arugula-stream`).
- **The run:** Claude Sonnet 5.5, effort low, with server-side fallbacks on, over the turns-nova3 transcript (3 people, 44 finals merged into speaker lines; `runs/turns-nova3/notes-claude-sonnet-5-5.md`).
- **Tokens and cost:** 931 input tokens, 364 output, **$0.0055**, 3.9 s.
- **Quality:**
  - Each person's material was credited correctly (Ada's definitions, Bo's fiction, Cy's Timaeus commentary).
  - It said plainly that this wasn't a working meeting.
  - It wrote "None stated" for decisions and action items instead of inventing any.
  - That shows faithfulness, not extraction. LibriSpeech has no decisions in it, so extraction quality on a real meeting is for the product milestone's dogfooding.
- **At call scale:** a 30-minute call is about 4,500 words, roughly 6–8k tokens in, so about $0.02 with Sonnet 5.5 or $0.04 with Opus 5.5.

### 7. Hosting: a Fly app next to the relay, not LiveKit Cloud agent hosting

**LiveKit Cloud on Build, from the docs:**
- 1 agent deployment and 5 concurrent agent sessions.
- 1,000 agent session minutes, then a hard cap on Build; on Ship, $0.01 a minute past 5,000.
- **Cold starts:** Build deployments scale to zero after sessions end, adding 10–20 s before the agent joins. The first 10–20 s of a call would go untranscribed.
- **Region:** the nearest by default, with no region pinning on Build.
- **Secrets:** encrypted and injected at runtime.
- **Deploys:** `lk agent deploy` builds our Dockerfile, rolls new instances in, and gives old ones up to an hour to finish their sessions. Instant rollback is on paid plans only.

**A Fly app (say `arugula-stream-transcriber`, iad, like the relay):**
- **Always warm:** no cold start and no agent session minutes. On LiveKit hosting, agent session minutes would cost $0.30 per 30-minute call past the allowance, more than the STT.
- **Next to the relay:** in the same region, for the POST.
- **Same tooling:** secrets and deploys work like the relay's (`fly secrets`, `fly deploy -c`).

**Sizing, measured here:**
- A job (one room) is about **280 MB RSS** and about 12% of a core with two tracks.
- The worker itself is about 145 MB, plus a 340 MB end-of-turn model process that `@livekit/agents` spawns which we don't use (to switch off in the product).
- So a 2 GB machine holds about 5 concurrent rooms, and more machines scale it out. LiveKit load-balances jobs across workers.

**Risk:** a deploy kills in-flight jobs unless Fly's `kill_timeout` covers the worker's drain. The relay should re-dispatch when a room's dispatch disappears (`ListDispatch`).

### 8. What else changes the plan

- **Consent:** a hidden bot means the UI has to say so.
  - Every participant should see a "transcribing" state, from relay presence, not LiveKit, which can't see the agent. They should see it before their audio is used, including late joiners to a drop-in voice room.
  - All-party-consent jurisdictions (California, Illinois, Washington, Pennsylvania, Florida and others) can treat live transcription as recording. Under the GDPR, transcripts are personal data: they need notice, a retention period and deletion.
  - Per-track STT makes a **per-person opt-out** trivial: the agent skips that track.
  - No audio is kept. LiveKit Inference is zero-retention by default.
- **When the room empties:** LiveKit closed the room about 22 s after the last person left, and the job ended with it (`empty-room`, with the agent's own idle rule turned off). A hidden agent never holds a room open, so agent time is about call time plus 20 s. That's the moment to finalize and ask for notes.
- **Reconnects:**
  - A participant reconnecting or rejoining gets a new track, picked up in about 420 ms.
  - Not tested: the agent's own reconnect (rtc-node reconnects by itself; the events are logged) and a worker crash mid-call. The relay should check `ListDispatch` and re-dispatch.
- **The 5-concurrent caps:**
  - The 5 concurrent agent sessions count **only LiveKit Cloud-hosted agents**, so a Fly-hosted worker isn't limited by it.
  - Inference STT is documented at 5 concurrent connections on Build. **We measured 12 concurrent Nova-3 streams all succeeding** (`runs/concurrency/n12.json`), but don't build on that.
  - With the VAD gate, open connections equal people talking right now (plus a session's roughly 3 s close tail), not tracks. So even at 5, that's about 5 rooms with someone speaking at once.
  - The agent also takes one of Build's 100 participants per room.
- **Languages:** only English was tested. Per-track STT means each person can have their own language (one stream each), and Nova-3 has a `multi` mode. Language rides the dispatch metadata.
- **Who turns it on:** the relay needs a rule for this (room owner? anyone, with everyone told?). That rule also decides the dispatch path (token vs API).

## Go / no-go

| question | verdict |
|---|---|
| 1 Runtime | **As planned:** Node `@livekit/agents`; **changes:** must be `hidden`, and attribution rides text-stream attributes, because a hidden sender's identity is empty |
| 1 Dispatch from Elixir | **As planned:** Twirp `CreateDispatch` from the relay; plus token `roomConfig` when transcription is on from the room's creation |
| 2 STT on Build | **As planned:** Inference works on Build; Nova-3 (377 ms p50 to final, 4.3% WER) with keyterms; AssemblyAI as fallback (dedupe its finals) |
| 3 Attribution | **As planned:** per-track, 100% correct incl. overlap, late join and rejoin; **changes:** gate on mute/VAD, since a muted track still delivers frames |
| 4 Cost | **Changes the plan:** VAD gate per track (about 4× cheaper: about $0.16 vs $0.58 STT per 30-min, 4-person call); Build's credit can't carry production, so it needs Ship or our own Deepgram key; billing page still to read (check per-session rounding) |
| 5 Delivery | **Changes the plan:** both, not one: text streams for live captions, signed HTTP finals for the relay's copy |
| 6 Notes | **As planned:** Sonnet 5.5, about $0.02 per 30-min call |
| 7 Hosting | **Changes the plan:** a Fly app next to the relay, not LiveKit Cloud agent hosting |

## Milestones I'd cut

1. **Transcriber worker** (M):
   - What: `transcriber/` Node package, with per-track VAD-gated Inference STT (Nova-3, keyterms, AssemblyAI fallback with dedupe); hidden; text streams with identity attributes; HMAC POST of finals; settings from dispatch metadata; idle and empty handling; tests with a fake STT.
   - Also: a Fly staging app.
   - Depends on nothing; the segment POST contract is agreed with M2.
2. **Relay: turn it on, store and tell** (M):
   - Who may turn transcription on; presence `transcribing: true`.
   - Dispatch: token `roomConfig` at room creation, Twirp `CreateDispatch` mid-call, `ListDispatch` re-dispatch.
   - `POST /internal/transcripts` with HMAC; a `transcript_segments` table (app, room, call/voice id, segment, sub, name, start, end, text); push to the room channel; PROTOCOL.md.
   - Depends on M1's contract (can run in parallel).
3. **Client captions and indicator** (M):
   - `@arugula/presence`: a text-stream handler in `call.ts`, a captions event and state (interims replace, finals append), the transcribing indicator from presence, and a transcript view in meet and demo; elements/react bindings.
   - Depends on M1 (attributes) and M2 (the flag, history).
4. **Notes** (S):
   - When a call or voice session ends (room empty), the relay sends the stored segments to Claude Sonnet 5.5 and stores and shows summary, decisions and action items. Expose transcripts and notes through the relay's MCP server.
   - Its own Anthropic key in `/arugula-stream`.
   - Depends on M2.
5. **Consent, retention and opt-out** (S):
   - Notice before transcribing (late joiners too), per-person opt-out (the agent skips the track), a retention period and deletion, and docs.
   - Depends on M2 and M3. Could fold into them.
6. **Metering, plan and launch** (S):
   - Transcription minutes as a metered unit (from the worker's usage counts) and app or plan limits.
   - The LiveKit plan decision (Ship, or our own Deepgram key) before production; the production Fly app.
   - Depends on M1 and M2.

## Running it

Every script reads keys from Infisical into its own environment and never prints them (`with-livekit.sh`, `with-anthropic.sh`). Audio fixtures are fetched, not kept in git.

```sh
pnpm install
python3 -I fixtures.py /some/empty/download/dir          # LibriSpeech test-clean → fixtures/ (gitignored)
./with-livekit.sh node agent.mjs dev                      # the worker, as "s45-transcriber"
./with-livekit.sh node speakers.mjs turns my-run --post   # fake people + dispatch; scenarios in scenarios.mjs
node analyze.mjs my-run                                   # the numbers
./with-livekit.sh node staging.mjs                        # the agent in a real staging voice room
./with-livekit.sh node concurrency.mjs 6                  # Inference STT concurrency
./with-anthropic.sh node notes.mjs my-run claude-sonnet-5-5
./with-livekit.sh mise exec -C ../../relay -- elixir dispatch.exs list <lk-room>
```

**Files:**
- `agent.mjs`: the worker.
- `page/speaker.html`: a fake person (WebAudio microphone, livekit-client 2.23.0, captions).
- `speakers.mjs`: orchestration, including a stand-in for the relay's endpoint.
- `scenarios.mjs`: the scripts the fake people follow.
- `dispatch.exs`: the relay's side, in Elixir.
- `analyze.mjs`, `table.py`: the numbers.
- `staging.mjs`: the staging check.
- `concurrency.mjs`: Inference STT concurrency.
- `notes.mjs`: notes from Claude.
- `usage.mjs`: the Analytics API probe (Scale plan only).
- `runs/`: the logs behind every number above.
