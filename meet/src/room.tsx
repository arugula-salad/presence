// A meet room (/r/<slug>): a name to go by, then everyone here as live
// characters or outlines (@arugula/presence-core), the room's chat beside
// them, waves and reactions, over the Phoenix transport (@arugula/presence).
// Where the relay has calls (#318's P7, P8), a wave rings: a yes is a voice
// call on LiveKit, with mute, video and leave in the room's bar, and a
// person's video on their tile while they have it on. Every room also has
// a voice channel (Arugula #331): a strip under the bar of who's in it,
// Join voice (you join muted), Unmute, video and Leave voice. In a call or
// voice, Speaker view (Arugula #332) shows whoever's talking big, the rest
// of the call or voice in a strip, and the rest of the room in a row of
// small tiles; click someone to pin them big. This browser remembers the
// choice, and the microphone's noise filter (Krisp, Standard or Off) in
// the call's or voice's bar.
//
// Into the socket: signed in, with a room token meet's server signs for
// you (api.roomToken, which also puts the room in your list); a guest,
// with meet's publishable key and their name (the relay makes their sub,
// and its join reply says it).

import { useEffect, useRef, useState } from "preact/hooks";
import { PresenceClient, phoenixTransport, NOTICE_MS, REACTIONS, NOISE_FILTERS, KRISP_FALLBACK, type CallPerson, type Member, type NoiseFilter, type Transport } from "@arugula/presence";
import { CHARACTERS, characterOf } from "@arugula/presence-core/avatar/characters/index";
import { animate, COLOURS, type Source } from "@arugula/presence-core/avatar/stage";
import { waving, type Look, type Rig } from "@arugula/presence-core/avatar/rig";
import { draw } from "@arugula/presence-core/outline/render";
import { palette } from "@arugula/presence-core/outline/classes";
import type { Frame } from "@arugula/presence-core/outline/frame";
import * as api from "./api";
import { ApiError, NAME, accountName, keep, kept, path, type RoomInfo, type Session } from "./api";
import { Mark, SignIn } from "./home";

/** Where this browser keeps your mode and look in meet. */
const STORAGE = "meet.";

function useTick(sub: (fn: () => void) => () => void) {
  const [, set] = useState(0);
  useEffect(() => sub(() => set((n) => n + 1)), []);
}

export function RoomPage({ slug, me }: { slug: string; me: Session }) {
  const [info, setInfo] = useState<RoomInfo | null>(null);
  const [missing, setMissing] = useState("");
  const [name, setName] = useState("");
  useEffect(() => {
    api.room(slug).then(
      (r) => {
        setInfo(r);
        document.title = `${r.name} · meet`;
      },
      (e: Error) => setMissing(e instanceof ApiError && e.status === 404 ? "There's no room at that link. Check it with whoever sent it." : e.message),
    );
  }, [slug]);
  if (missing)
    return (
      <main class="lobby">
        <Mark />
        <h2>Hmm.</h2>
        <p class="sub">{missing}</p>
        <a class="btn" href={path("/")}>
          Go home
        </a>
      </main>
    );
  if (!info) return <main class="lobby" aria-busy="true" />;
  if (!name) return <Lobby info={info} me={me} onName={setName} />;
  return <Room info={info} me={me} name={name} />;
}

/** The room's door: what to call you, and for a guest, a way to sign in. */
function Lobby({ info, me, onName }: { info: RoomInfo; me: Session; onName: (n: string) => void }) {
  const [name, setName] = useState(kept(NAME) || (me.account ? accountName(me.account) : ""));
  const [signIn, setSignIn] = useState(false);
  const go = () => {
    const n = name.trim().slice(0, 80);
    if (!n) return;
    keep(NAME, n);
    onName(n);
  };
  const guestsOff = !me.account && !me.key;
  return (
    <main class="lobby">
      <Mark />
      <div class="card panel" style={{ "--c": "var(--k-server)" }}>
        <h2>{info.name}</h2>
        <span class="sub">What should people here call you?</span>
        <form
          class="row"
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <input type="text" autoFocus placeholder="your name" aria-label="Your name" maxLength={80} value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          <button class="btn primary" type="submit" disabled={!name.trim() || guestsOff}>
            Join the room
          </button>
        </form>
        {guestsOff && <span class="error">Guests can't come in here yet. Sign in to join.</span>}
        {!me.account &&
          (signIn ? (
            <SignIn me={me} returnTo={path(`/r/${info.slug}`)} />
          ) : (
            <button class="link" onClick={() => setSignIn(true)}>
              Or sign in, to keep this room in your list
            </button>
          ))}
      </div>
    </main>
  );
}

function OutlineCanvas({ frame, mirror }: { frame: Frame; mirror: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (c) draw(c, frame, { color: palette(c, !!frame.classes?.some((x) => x)), mirror });
  });
  return <canvas ref={ref} />;
}

function AvatarCanvas({ source, mirror }: { source: () => Source | null; mirror: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const src = useRef(source);
  src.current = source;
  useEffect(() => animate(ref.current!, { size: "bust", mirror, character: characterOf, source: () => src.current() }), [mirror]);
  return <canvas ref={ref} />;
}

/** Someone's call video (yours mirrored): LiveKit sends it only while
 * it's in view, at the size it's shown. */
function VideoView({ client, sub, mirror }: { client: PresenceClient; sub: string; mirror: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => client.attachVideo(sub, ref.current!), [sub]);
  return <video ref={ref} class={mirror ? "mirror" : undefined} autoPlay playsInline muted />;
}

/** Where a tile is: the grid (default), or Speaker view's big one, its
 * strip of the call or voice, or its row of the rest of the room. */
type Spot = "big" | "strip" | "row";

function Tile({ client, m, me, onError, spot, onPin }: { client: PresenceClient; m: Member; me: boolean; onError: (e: string) => void; spot?: Spot; onPin?: () => void }) {
  const seen = client.of(m.sub);
  const frame = (me ? client.mine?.frame : null) ?? seen?.frame ?? null;
  const look = me ? client.look : (seen?.look ?? client.lookOf(m.sub) ?? m.look);
  const avatar = me ? client.mode === "avatar" : !!look && !frame;
  const live = !!frame || !!seen?.rig || (me && !!client.mine?.rig);
  const waved = client.answers.find((a) => a.from === m.sub);
  // Calls: who's in one (presence), and in yours, muted, speaking or on
  // video (LiveKit).
  const person = client.inCall?.people.find((p) => p.sub === m.sub);
  const ringing = !!client.inCall?.ringing.includes(m.sub);
  const inMine = client.inMyCall(m.sub);
  const video = client.videoOf(m.sub);
  const adding = client.callsOn && !!client.inCall && client.inCall.state !== "ringing";
  // A wave rings where the relay has calls; it's a hello where it hasn't.
  const waveAt = () => {
    if (!client.callsOn) return client.wave(m.sub);
    client.call(m.sub).then(
      () => onError(""),
      (e: Error) => onError(callError(e.message)),
    );
  };
  // A fresh wave (theirs at you, yours at someone) waves on their avatar.
  const hand = (rig: Rig | null) => (client.waving(m.sub, me) ? waving(rig, performance.now() / 1000) : rig);
  const source = (): Source | null => {
    if (me) return { rig: hand(client.mine?.rig ?? null), look: client.look, away: false };
    const s = client.of(m.sub);
    const l = s?.look ?? client.lookOf(m.sub) ?? m.look;
    return l ? { rig: hand(s?.rig ?? null), look: l, away: m.away } : null;
  };
  // Speaker view's big tile and strip: a click pins (or unpins) them.
  const pinnable = (spot === "big" || spot === "strip") && !!onPin;
  const pinned = client.pinned === m.sub;
  const talking = person ?? client.inVoice?.people.find((p) => p.sub === m.sub);
  return (
    <figure
      class={["tile", spot && `spot-${spot}`, live && "live", m.call && "in-call", m.voice && "in-voice", video && "video", (person?.speaking || client.speakingInVoice(m.sub)) && "speaking", pinnable && pinned && "pinned"].filter(Boolean).join(" ")}
      data-sub={m.sub}
      data-name={m.name}
      data-spot={spot}
      data-why={spot === "big" ? (pinned ? "pinned" : client.activeSpeaker === m.sub ? "speaker" : "first") : undefined}
      role={pinnable ? "button" : undefined}
      tabIndex={pinnable ? 0 : undefined}
      aria-pressed={pinnable ? pinned : undefined}
      title={pinnable ? (pinned ? `Unpin ${m.name}: back to whoever's talking` : `Pin ${m.name} big`) : undefined}
      onClick={pinnable ? onPin : undefined}
      onKeyDown={
        pinnable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onPin!();
              }
            }
          : undefined
      }
    >
      <div class="view">
        <div class="reacts" aria-live="polite">
          {client.reactionsOf(m.sub).map((r) => (
            <span key={r.at} class="react" style={{ left: `${35 + ((r.at / 7) % 30)}%` }}>
              {r.emoji}
            </span>
          ))}
        </div>
        {video ? (
          <VideoView client={client} sub={m.sub} mirror={me} />
        ) : frame ? (
          <OutlineCanvas frame={frame} mirror={me} />
        ) : avatar ? (
          <AvatarCanvas source={source} mirror={me} />
        ) : (
          <div class="still">{m.name.slice(0, 1).toUpperCase()}</div>
        )}
      </div>
      <figcaption>
        <span class="who">{me ? `${m.name} (you)` : m.name}</span>
        {pinnable ? (
          <span class="tag call">{[pinned && "pinned", talking?.muted ? "muted" : talking?.speaking && "speaking"].filter(Boolean).join(" · ")}</span>
        ) : person?.muted ? (
          <span class="tag call">muted</span>
        ) : m.call ? (
          <span class="tag call">in a call</span>
        ) : m.voice ? (
          <span class="tag voice">{m.muted ? "in voice, muted" : "in voice"}</span>
        ) : (
          live && <span class="tag">live</span>
        )}
        {!live && !m.call && !m.voice && m.away && (
          <span class="tag" style={{ color: "var(--dim)" }}>
            away
          </span>
        )}
        {!me && !inMine && !pinnable && (
          <button class="btn wave" onClick={waveAt} disabled={ringing} title={client.callsOn ? `Wave at ${m.name} to talk` : `Wave at ${m.name}`}>
            {ringing ? "Calling…" : adding ? "Add to call" : waved && !client.callsOn ? (waved.yes ? "waved back" : "not now") : waved && !waved.yes ? "not now" : "Wave"}
          </button>
        )}
      </figcaption>
    </figure>
  );
}

function Controls({ client, me }: { client: PresenceClient; me: string }) {
  const on = client.cameraOn;
  return (
    <div class="controls">
      <button class={on ? "btn on" : "btn primary"} onClick={() => (on ? client.stopCamera() : void client.startCamera())}>
        {on ? "Turn off my camera" : "Turn on my camera"}
      </button>
      <span class="seg" role="radiogroup" aria-label="What your camera sends">
        {(["avatar", "outline"] as const).map((m) => (
          <button role="radio" aria-checked={client.mode === m} class={client.mode === m ? "btn on" : "btn"} onClick={() => client.setMode(m)}>
            {m === "avatar" ? "Character" : "Outline"}
          </button>
        ))}
      </span>
      {client.mode === "avatar" && (
        <>
          <span class="seg" role="radiogroup" aria-label="Your character">
            {CHARACTERS.map((c) => (
              <button role="radio" aria-checked={client.look.character === c.id} class={client.look.character === c.id ? "btn on" : "btn"} onClick={() => client.setLook({ ...client.look, character: c.id })}>
                {c.name}
              </button>
            ))}
          </span>
          <span class="seg" role="radiogroup" aria-label="Your colour">
            {COLOURS.map((v, i) => (
              <button
                role="radio"
                aria-checked={client.look.colour === i}
                aria-label={v.slice(2)}
                class={client.look.colour === i ? "swatch on" : "swatch"}
                style={{ background: `var(${v})` }}
                onClick={() => client.setLook({ ...client.look, colour: i })}
              />
            ))}
          </span>
        </>
      )}
      <span class="seg reacts-bar" aria-label="React">
        {REACTIONS.map((e) => (
          <button class="btn emoji" onClick={() => client.react(e, me)} aria-label={`React ${e}`}>
            {e}
          </button>
        ))}
      </span>
      {on && !client.mine?.sent.length && !client.mine?.error && <span class="stats">starting the camera…</span>}
      {client.mine?.error && <span class="error">{client.mine.error}</span>}
    </div>
  );
}

/** The room's text: messages, earlier ones a click away, and an input
 * (Enter sends, Shift+Enter is a new line). */
function ChatPanel({ client, me }: { client: PresenceClient; me: string }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const last = client.messages[client.messages.length - 1]?.id;
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [last]);
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    try {
      await client.say(t);
      setText("");
      setErr("");
    } catch (e) {
      setErr(sayError((e as Error).message));
    }
  };
  return (
    <aside class="chat" aria-label="Chat">
      <div class="chat-list" ref={list} role="log" aria-live="polite">
        {client.hasEarlier && client.messages.length > 0 && (
          <button class="btn earlier" onClick={() => void client.loadEarlier()}>
            Earlier messages
          </button>
        )}
        {!client.messages.length && <p class="empty">No messages yet. Say hi.</p>}
        {client.messages.map((m) => (
          <div key={m.id} class={m.sub === me ? "chat-msg mine" : "chat-msg"}>
            <span class="who">
              {m.sub === me ? "You" : m.name} <time>{new Date(m.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
            </span>
            <span class="text">{m.text}</span>
          </div>
        ))}
      </div>
      <form
        class="chat-say"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          rows={1}
          placeholder="Say something"
          aria-label="Message"
          value={text}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {err && <span class="error">{err}</span>}
      </form>
    </aside>
  );
}

const NOISE: Record<NoiseFilter, [label: string, title: string]> = {
  krisp: ["Krisp", "Krisp noise cancellation (LiveKit Cloud): takes out the noise around you"],
  standard: ["Standard", "Your browser's own noise suppression"],
  off: ["Off", "No noise suppression (echo cancellation stays on)"],
};

/** Your microphone's noise filter in a call or voice: Krisp, Standard or
 * Off (kept in this browser), and a note while Krisp is your choice and
 * can't run here. */
function NoiseChoice({ client }: { client: PresenceClient }) {
  const n = client.noise;
  return (
    <>
      <span class="seg noise" role="radiogroup" aria-label="Noise filter" data-mode={n.mode} data-active={n.active ?? ""}>
        <span class="noise-label">Noise</span>
        {NOISE_FILTERS.map((m) => (
          <button
            key={m}
            role="radio"
            aria-checked={n.mode === m}
            class={n.mode === m ? "btn on" : "btn"}
            disabled={m === "krisp" && n.krisp === false}
            title={m === "krisp" && n.krisp === false ? "Krisp doesn't run in this browser" : NOISE[m][1]}
            onClick={() => void client.setNoiseFilter(m)}
          >
            {NOISE[m][0]}
          </button>
        ))}
      </span>
      {n.fallback && (
        <span class="notice noise-fallback" title={n.fallback}>
          {KRISP_FALLBACK}
        </span>
      )}
    </>
  );
}

/** Your call, in the room's bar: who's in it, mute, video and leave (or
 * who you're calling, and cancel). */
function CallBar({ client, me, names, error }: { client: PresenceClient; me: string; names: Map<string, string>; error: string }) {
  const c = client.inCall;
  if (!c) return error ? <div class="callbar"><span class="error">{error}</span></div> : null;
  const others = c.people.filter((p) => p.sub !== me).map((p) => p.name);
  const ringing = c.ringing.map((s) => names.get(s) ?? "someone");
  const what =
    c.state === "ringing"
      ? `Calling ${ringing.join(", ")}…`
      : c.state === "joining"
        ? "Joining the call…"
        : c.state === "reconnecting"
          ? "Reconnecting…"
          : others.length
            ? `In a call with ${others.join(", ")}${ringing.length ? ` · calling ${ringing.join(", ")}…` : ""}`
            : "Waiting for the others…";
  return (
    <div class="callbar on" role="status">
      <span class="what">{what}</span>
      {c.state !== "ringing" && (
        <>
          <button class={c.muted ? "btn on" : "btn"} onClick={() => void client.setMuted(!c.muted)} aria-pressed={c.muted}>
            {c.muted ? "Unmute" : "Mute"}
          </button>
          <button class={c.video ? "btn on" : "btn"} onClick={() => void client.setVideo(!c.video)} aria-pressed={c.video} title="Video is your camera's real picture, for the people in this call">
            {c.video ? "Stop video" : "Start video"}
          </button>
        </>
      )}
      {c.state !== "ringing" && <NoiseChoice client={client} />}
      {c.blocked && (
        <button class="btn primary" onClick={() => void client.startAudio()}>
          Play the call
        </button>
      )}
      <button class="btn danger" onClick={() => client.leaveCall()}>
        {c.state === "ringing" ? "Cancel" : "Leave"}
      </button>
      {(c.error || error) && <span class="error">{c.error || error}</span>}
    </div>
  );
}

/** The room's voice channel (every room has one): who's in it, in their
 * colour with a ring while they speak; Join voice (you join muted),
 * Unmute, video and Leave voice. Joining leaves a call, and taking a call
 * leaves voice; the strip says so for a moment. */
function VoiceStrip({ client, me }: { client: PresenceClient; me: string }) {
  const [err, setErr] = useState("");
  if (!client.voiceOn) return null;
  const v = client.inVoice;
  const people = client.voiceMembers;
  const join = () => {
    setErr("");
    client.joinVoice().catch((e: Error) => setErr(voiceError(e.message)));
  };
  const notice = client.notice && Date.now() - client.notice.at < NOTICE_MS ? client.notice.text : "";
  return (
    <div class={v ? "voicebar in" : "voicebar"} role="region" aria-label="Voice">
      <span class="label">Voice</span>
      <ul class="voice-strip" aria-label="In voice">
        {people.map((m) => {
          const speaking = client.speakingInVoice(m.sub);
          const name = m.sub === me ? "You" : m.name;
          return (
            <li key={m.sub} class={["voice-person", speaking && "speaking", m.muted && "muted"].filter(Boolean).join(" ")} data-sub={m.sub} title={`${name}${m.muted ? ", muted" : speaking ? ", speaking" : ""}`}>
              <span class="dot" style={m.look ? { "--c": `var(${COLOURS[m.look.colour] ?? "--dim"})` } : undefined}>
                {m.name.slice(0, 1).toUpperCase()}
              </span>
              <span class="who">{name}</span>
              {m.muted && <span class="mic">muted</span>}
            </li>
          );
        })}
        {!people.length && <li class="nobody">Nobody's in voice. Drop in; you join muted.</li>}
      </ul>
      {v ? (
        <>
          {v.state === "joining" ? <span class="stats">joining…</span> : v.state === "reconnecting" ? <span class="stats">reconnecting…</span> : v.muted && <span class="stats">you're muted</span>}
          {v.state !== "joining" && (
            <>
              <button class={v.muted ? "btn primary" : "btn"} onClick={() => void client.setVoiceMuted(!v.muted)} aria-pressed={v.muted}>
                {v.muted ? "Unmute" : "Mute"}
              </button>
              <button class={v.video ? "btn on" : "btn"} onClick={() => void client.setVoiceVideo(!v.video)} aria-pressed={v.video} title="Video is your camera's real picture, for the people in voice">
                {v.video ? "Stop video" : "Start video"}
              </button>
            </>
          )}
          <NoiseChoice client={client} />
          {v.blocked && (
            <button class="btn primary" onClick={() => void client.startAudio()}>
              Play voice
            </button>
          )}
          <button class="btn danger" onClick={() => client.leaveVoice()}>
            Leave voice
          </button>
        </>
      ) : (
        <button class="btn primary" onClick={join} title={client.inCall ? "Joining voice leaves your call. You join muted." : "Drop into the room's voice channel. You join muted."}>
          Join voice
        </button>
      )}
      {(v?.error || err) && <span class="error">{v?.error || err}</span>}
      {notice && (
        <span class="notice" role="status">
          {notice}
        </span>
      )}
    </div>
  );
}

/** The relay's reasons for not letting you into voice, in words. */
function voiceError(reason: string): string {
  return (
    {
      "voice is full": "Voice is full right now. Try again when someone leaves.",
      "not in the room yet": "Still getting you in; try again in a moment.",
    }[reason] ?? reason
  );
}

/** The relay's reasons for not ringing someone, in words. */
function callError(reason: string): string {
  return (
    {
      "too fast": "That's a lot of ringing: wait a few seconds and try again.",
      "not in the room": "They've left the room.",
      "already in the call": "They're in the call already.",
    }[reason] ?? reason
  );
}

/** The relay's reasons for not keeping a message, in words. */
function sayError(reason: string): string {
  return (
    {
      "too long": "That's over 2,000 characters.",
      "too fast": "Slow down a little: a few messages every few seconds.",
      "control characters": "That has characters a message can't carry.",
      "not in the room yet": "Still getting you in; try again in a moment.",
    }[reason] ?? reason
  );
}

/** Grid or Speaker view, while you're in a call or voice. */
type Layout = "grid" | "speaker";

function LayoutToggle({ layout, onLayout }: { layout: Layout; onLayout: (l: Layout) => void }) {
  return (
    <span class="seg layout" role="radiogroup" aria-label="Layout">
      {(["grid", "speaker"] as const).map((l) => (
        <button role="radio" aria-checked={layout === l} class={layout === l ? "btn on" : "btn"} onClick={() => onLayout(l)}>
          {l === "grid" ? "Grid" : "Speaker"}
        </button>
      ))}
    </span>
  );
}

/** Speaker view (Arugula #332): whoever's talking big (or whoever you
 * pinned), everyone else in the call or voice in a strip, and the rest of
 * the room in a row of small tiles under them. The big tile's video is big,
 * so LiveKit sends that person's 720p layer; the strip's get 180p. */
function SpeakerView({ client, mine, onError }: { client: PresenceClient; mine: Member; onError: (e: string) => void }) {
  const roster = client.roster;
  const featured = client.featured(mine.sub);
  const memberOf = (p: CallPerson): Member => (p.sub === mine.sub ? mine : (client.members.find((m) => m.sub === p.sub) ?? { sub: p.sub, name: p.name, look: null, mode: "none", away: false, watching: true, call: null, voice: false, muted: p.muted }));
  const pin = (sub: string) => client.pin(client.pinned === sub ? null : sub);
  const top = roster.find((p) => p.sub === featured);
  const strip = roster.filter((p) => p.sub !== featured);
  const inIt = new Set(roster.map((p) => p.sub));
  const rest = [mine, ...client.members.filter((m) => m.sub !== mine.sub)].filter((m) => !inIt.has(m.sub));
  return (
    <div class="speaker-view">
      {top && <Tile key={`big:${top.sub}`} client={client} m={memberOf(top)} me={top.sub === mine.sub} onError={onError} spot="big" onPin={() => pin(top.sub)} />}
      {strip.length > 0 && (
        <div class="speaker-strip" role="list" aria-label="Everyone else in it">
          {strip.map((p) => (
            <Tile key={p.sub} client={client} m={memberOf(p)} me={p.sub === mine.sub} onError={onError} spot="strip" onPin={() => pin(p.sub)} />
          ))}
        </div>
      )}
      {rest.length > 0 && (
        <div class="speaker-rest" aria-label="The rest of the room">
          {rest.map((m) => (
            <Tile key={m.sub} client={client} m={m} me={m.sub === mine.sub} onError={onError} spot="row" />
          ))}
        </div>
      )}
    </div>
  );
}

function Room({ info, me, name }: { info: RoomInfo; me: Session; name: string }) {
  const [state] = useState(() => {
    const you = { sub: "" };
    const start = keptLook();
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/socket`;
    const onJoin = (sub: string) => (you.sub = sub);
    let client: PresenceClient;
    const look = (): Look => client?.look ?? start;
    const transport: Transport = me.account
      ? phoenixTransport({ url, room: info.slug, onJoin, token: async () => (await api.roomToken(info.slug, name, look())).token })
      : phoenixTransport({ url, room: info.slug, onJoin, key: me.key ?? "", guest: name, look: start });
    client = new PresenceClient({ transport, storage: STORAGE });
    if (!kept(`${STORAGE}mode`)) client.setMode("avatar");
    return { client, you };
  });
  const { client, you } = state;
  useTick((fn) => client.subscribe(fn));
  useEffect(() => {
    const stop = client.watch();
    const away = () => client.setAway(document.hidden);
    addEventListener("visibilitychange", away);
    return () => {
      stop();
      client.stopCamera();
      removeEventListener("visibilitychange", away);
    };
  }, []);
  const [copied, setCopied] = useState(false);
  const mine: Member = client.members.find((m) => m.sub === you.sub) ?? { sub: you.sub || "me", name, look: client.look, mode: "none", away: false, watching: true, call: null, voice: false, muted: false };
  const others = client.members.filter((m) => m.sub !== you.sub);
  // Names of everyone seen here, so a wave from someone who's since left
  // still says who.
  const names = useRef(new Map<string, string>()).current;
  for (const m of client.members) names.set(m.sub, m.name);
  const wave = client.waves[client.waves.length - 1];
  const ring = client.rings[client.rings.length - 1];
  const [callErr, setCallErr] = useState("");
  // Grid or Speaker view, kept in this browser; Speaker only means
  // something in a call or voice you've joined.
  const [layout, setLayout] = useState<Layout>(() => (kept(`${STORAGE}layout`) === "speaker" ? "speaker" : "grid"));
  const chooseLayout = (l: Layout) => {
    setLayout(l);
    keep(`${STORAGE}layout`, l);
  };
  const talking = client.roster.length > 0;
  const link = `${location.origin}${path(`/r/${info.slug}`)}`;
  const share = () => {
    void navigator.clipboard?.writeText(link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <main class="room">
      <div class="bar">
        <span class="name">
          <Mark />
          <span class="room-name">{info.name}</span>
          <small>{info.slug}</small>
        </span>
        <span class="stats" data-live={client.live}>
          {client.live === "on" ? `${client.members.length} here` : client.live === "refused" ? "couldn't get in" : "connecting…"}
        </span>
        <button class="btn" onClick={share} title={link}>
          {copied ? "Link copied" : "Copy the link"}
        </button>
        <div class="call-slot" data-slot="call">
          <CallBar client={client} me={mine.sub} names={names} error={callErr} />
        </div>
        <div class="voice-slot" data-slot="voice">
          <VoiceStrip client={client} me={mine.sub} />
        </div>
      </div>
      <Controls client={client} me={mine.sub} />
      <div class="room-body">
        <div>
          {talking && (
            <div class="layout-bar">
              <LayoutToggle layout={layout} onLayout={chooseLayout} />
              {layout === "speaker" && <span class="stats">Click someone to pin them big; again to follow whoever's talking.</span>}
            </div>
          )}
          {talking && layout === "speaker" ? (
            <SpeakerView client={client} mine={mine} onError={setCallErr} />
          ) : (
            <div class="grid">
              <Tile client={client} m={mine} me onError={setCallErr} />
              {others.map((m) => (
                <Tile key={m.sub} client={client} m={m} me={false} onError={setCallErr} />
              ))}
            </div>
          )}
          {!others.length && <p class="empty">Nobody else here yet. Copy the link and send it to someone.</p>}
        </div>
        <ChatPanel client={client} me={mine.sub} />
      </div>
      {ring && (
        <div class="toast" role="alert">
          <span>
            <b>{names.get(ring.from) ?? "Someone"}</b> waved at you: they'd like to talk.
          </span>
          <div class="row">
            <button class="btn primary" onClick={() => void client.answerCall(ring.id, true)}>
              Talk
            </button>
            <button class="btn" onClick={() => void client.answerCall(ring.id, false)}>
              Not now
            </button>
          </div>
          <span class="stats">{client.inVoice ? "A private call: Talk takes you out of the room's voice. " : "A voice call: your microphone. "}Video only if you start it, and then it's your real camera picture.</span>
        </div>
      )}
      {!ring && wave && (
        <div class="toast" role="alert">
          <span>
            <b>{names.get(wave.from) ?? "Someone"}</b> waved at you.
          </span>
          <div class="row">
            <button class="btn primary" onClick={() => client.answer(wave.from, true)}>
              Wave back
            </button>
            <button class="btn" onClick={() => client.answer(wave.from, false)}>
              Not now
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

/** The look kept in this browser (PresenceClient keeps it as JSON); the
 * first time, a character and colour at random, kept, so a room of
 * newcomers isn't everyone in the same one. */
function keptLook(): Look {
  try {
    const l = JSON.parse(kept(`${STORAGE}look`) || "null") as Look | null;
    if (l && Number.isInteger(l.character) && Number.isInteger(l.colour)) return l;
  } catch {
    // A new one, below.
  }
  const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)]!;
  const look = { character: pick(CHARACTERS).id, colour: Math.floor(Math.random() * COLOURS.length) };
  keep(`${STORAGE}look`, JSON.stringify(look));
  return look;
}
