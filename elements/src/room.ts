// connect(): a room on arugula.stream (or any presence relay) for a page
// to show (../../sdk/API.md). A Room is a PresenceClient over the Phoenix
// transport, its changes as events (members, wave, answer, ring, call,
// voice, live), and mount/avatar/callBar/voiceBar to draw people, a call
// bar and the room's voice channel into an element. Who's in which room is the
// token's business: your server signs it (or, to prototype, the relay's
// demo tokens); or, with no server, the app's publishable key with the
// person's own sign-in token (`auth`) or a guest's name.

import { PresenceClient, phoenixTransport, type Call, type Member, type Transport, type Message, type PhoenixTransportOptions, type Voice } from "@arugula/presence";
import { setAssetBase } from "@arugula/presence-core/assets";
import type { Look } from "@arugula/presence-core/avatar/rig";
import { mountAvatar, mountPeople, type AvatarOptions, type PeopleOptions } from "./view.ts";
import { CSS } from "./styles.ts";
import { mountChat, type ChatOptions } from "./chat.ts";
import { mountCall, mountVoice } from "./controls.ts";
import { mountSpotlight, type SpotlightOptions } from "./spotlight.ts";

export const RELAY = "wss://arugula.stream/socket";

export interface ConnectOptions {
  /** The room's id in your app. */
  room: string;
  /** A room token your server signed, or a function for a fresh one
   * (called on every (re)connect). */
  token?: string | (() => Promise<string>);
  /** Or, with no server of yours: the app's publishable key, with `auth`
   * (a signed-in member) or `guest` (a name, where the app allows guests). */
  key?: string;
  /** The person's token from your auth provider (Clerk, Auth0, Firebase,
   * Supabase, OIDC), or a function for a fresh one: called on every
   * (re)connect. */
  auth?: string | (() => Promise<string>);
  /** A guest's name. */
  guest?: string;
  /** A member's name, if their token has none. */
  name?: string;
  /** The relay's socket. Default: arugula.stream's. */
  relay?: string;
  /** Starting choices where this browser has none kept. */
  mode?: "avatar" | "outline";
  look?: Look;
  /** Where this browser keeps the person's choices (localStorage keys). */
  storage?: string;
  /** Where the trackers' models and Wasm are. Default: the relay's origin,
   * which serves them. */
  assets?: string;
  /** Tests: a transport of their own. */
  transport?: Transport;
}

export interface RoomEvents {
  members: (members: Member[]) => void;
  wave: (from: string) => void;
  answer: (from: string, yes: boolean) => void;
  react: (from: string, emoji: string) => void;
  /** A message, yours included, once (history on joining counts). */
  message: (m: Message) => void;
  /** Someone rings you: `room.answerCall(id, yes)`. */
  ring: (from: string, id: string) => void;
  /** Your call changed: ringing, joining, on, who's in it, muted; null
   * when it's over. */
  call: (call: Call | null) => void;
  /** Who's in the room's voice channel changed (joined, left, muted), or
   * you in it did (`joined`: joining, on, speaking, muted; null when out). */
  voice: (members: Member[], joined: Voice | null) => void;
  /** The current speaker in your call or voice changed, or your pin did
   * (`active`: held steady; `pinned`: this page's, or null). */
  speaker: (active: string | null, pinned: string | null) => void;
  live: (state: "connecting" | "on" | "refused" | "off") => void;
}

/** The relay's HTTP origin, from its socket's URL. */
export function httpOrigin(relay: string): string {
  const u = new URL(relay);
  u.protocol = u.protocol === "wss:" ? "https:" : u.protocol === "ws:" ? "http:" : u.protocol;
  return u.origin;
}

/** The `sub` claim of a room token (unverified: the relay verifies it). */
export function subOf(token: string): string {
  try {
    const part = token.split(".")[1] ?? "";
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4));
    return String((JSON.parse(json) as { sub?: unknown }).sub ?? "");
  } catch {
    return "";
  }
}

export class Room {
  readonly client: PresenceClient;
  readonly room: string;
  /** Your own sub, once a token has been read. */
  me = "";
  private handlers: { [K in keyof RoomEvents]: Set<RoomEvents[K]> } = { members: new Set(), wave: new Set(), answer: new Set(), react: new Set(), message: new Set(), ring: new Set(), call: new Set(), voice: new Set(), speaker: new Set(), live: new Set() };
  private stop: () => void;
  private unsub: () => void;
  private seen = { members: [] as Member[], waves: 0, answers: 0, live: "off" as string, reactedAt: 0, messageId: 0, rings: new Set<string>(), call: null as Call | null, voice: "", joined: null as Voice | null, speaker: "" };

  constructor(o: ConnectOptions) {
    this.room = o.room;
    const relay = o.relay ?? RELAY;
    setAssetBase(o.assets ?? `${httpOrigin(relay)}/`);
    const storage = o.storage ?? "arugula.stream.";
    const auth = this.auth(o, relay);
    this.client = new PresenceClient({ transport: o.transport ?? phoenixTransport(auth), storage });
    const kept = (k: string) => {
      try {
        return localStorage.getItem(`${storage}${k}`) !== null;
      } catch {
        return false;
      }
    };
    if (!kept("mode")) this.client.setMode(o.mode ?? "avatar");
    if (o.look && !kept("look")) this.client.setLook(o.look);
    const client = this.client;
    this.camera = {
      async start(c = {}) {
        if (c.mode && c.mode !== client.mode) client.setMode(c.mode);
        await client.startCamera();
      },
      stop: () => client.stopCamera(),
      get on() {
        return client.cameraOn;
      },
    };
    this.voice = {
      join: () => client.joinVoice(),
      leave: () => client.leaveVoice(),
      setMuted: (muted) => client.setVoiceMuted(muted),
      setVideo: (on) => client.setVoiceVideo(on),
      speaking: (sub) => client.speakingInVoice(sub),
      get available() {
        return client.voiceOn;
      },
      get members() {
        return client.voiceMembers;
      },
      get joined() {
        return client.inVoice;
      },
    };
    this.unsub = this.client.subscribe(() => this.changed());
    this.stop = this.client.watch();
  }

  // How the socket gets in: a room token (your sub is in it), or a key
  // with a member's token or a guest's name (your sub comes on joining).
  private auth(o: ConnectOptions, url: string): PhoenixTransportOptions {
    const base = { url, room: o.room, onJoin: (you: string) => void (this.me = you) };
    if (o.key !== undefined)
      return o.auth !== undefined
        ? { ...base, key: o.key, auth: o.auth, name: o.name, look: o.look }
        : { ...base, key: o.key, guest: o.guest ?? "Guest", look: o.look };
    const tok = o.token;
    if (tok === undefined) throw new Error("connect() needs a token, or a key");
    if (typeof tok === "string") {
      this.me = subOf(tok);
      return { ...base, token: tok };
    }
    return {
      ...base,
      token: async () => {
        const t = await tok();
        this.me = subOf(t);
        return t;
      },
    };
  }

  get members(): Member[] {
    return this.client.members;
  }

  on<K extends keyof RoomEvents>(event: K, fn: RoomEvents[K]): () => void {
    this.handlers[event].add(fn);
    return () => void this.handlers[event].delete(fn);
  }

  /** Your camera: avatar (a rig, a few dozen bytes a frame) or outline. */
  readonly camera: { start(o?: { mode?: "avatar" | "outline" }): Promise<void>; stop(): void; readonly on: boolean };

  setLook(look: Look) {
    this.client.setLook(look);
  }

  wave(sub: string) {
    this.client.wave(sub);
  }

  /** The room's text messages, oldest first. */
  get messages(): Message[] {
    return this.client.messages;
  }

  /** Send a text message; resolves with it as kept, rejects with why. */
  say(text: string): Promise<Message> {
    return this.client.say(text);
  }

  /** The page of messages before the first one here. */
  loadEarlier(): Promise<void> {
    return this.client.loadEarlier();
  }

  /** An emoji for the room; it floats over your tile for everyone. */
  react(emoji: string) {
    this.client.react(emoji, this.me);
  }

  answer(sub: string, yes: boolean) {
    this.client.answer(sub, yes);
  }

  /** Whether this relay has calls (it hides call buttons where not). */
  get calls(): boolean {
    return this.client.callsOn;
  }

  /** Your call, if you're in one or ringing someone. */
  get inCall(): Call | null {
    return this.client.inCall;
  }

  /** Who's ringing you, until answered or over. */
  get rings(): { from: string; id: string; at: number }[] {
    return this.client.rings;
  }

  /** Ask `sub` to talk (into your call, if you're in one): a voice call
   * once they say yes. Resolves with the call's id. */
  call(sub: string): Promise<string> {
    return this.client.call(sub);
  }

  answerCall(id: string, yes: boolean): Promise<void> {
    return this.client.answerCall(id, yes);
  }

  leaveCall() {
    this.client.leaveCall();
  }

  setMuted(muted: boolean): Promise<void> {
    return this.client.setMuted(muted);
  }

  /** Your video in the call: your camera's real picture, for the people in
   * it alone (presence never sends one). Tiles in the call show it in place
   * of your character; your camera turns on for it if it's off. */
  setVideo(on: boolean): Promise<void> {
    return this.client.setVideo(on);
  }

  /** The room's voice channel (PROTOCOL.md "Voice"): every room has one.
   * Join it muted (unmute to talk), leave it when you like; everyone in the
   * room sees who's in it. Separate from calls, which stay private 1:1
   * (and growing); a page is in one or the other, never both. */
  readonly voice: {
    /** In, muted; out of your call first. Rejects with why ("voice is full"). */
    join(): Promise<void>;
    leave(): void;
    setMuted(muted: boolean): Promise<void>;
    /** Your camera's real video, to the people in voice. */
    setVideo(on: boolean): Promise<void>;
    /** Whether `sub` is speaking (known while you're in voice). */
    speaking(sub: string): boolean;
    /** Whether this relay has voice (it hides the voice bar where not). */
    readonly available: boolean;
    /** Who's in voice, as presence says: everyone in the room sees it. */
    readonly members: Member[];
    /** You in voice (joining, on; who's speaking, muted), or null. */
    readonly joined: Voice | null;
  };

  /** The current speaker in your call or voice, held steady: a newcomer
   * takes over after 0.7 s of talking, a cough doesn't, and nobody
   * talking keeps the last. Never you unless you're alone. */
  get activeSpeaker(): string | null {
    return this.client.activeSpeaker;
  }

  /** Who you pinned big (this page alone), or null. */
  get pinned(): string | null {
    return this.client.pinned;
  }

  /** Pin `sub` big in your call or voice in place of whoever's talking, or
   * null to follow the speaker again. */
  pin(sub: string | null) {
    this.client.pin(sub);
  }

  /** Who a spotlight shows big now: pinned, else the speaker, else the
   * first other person in it; null outside a call or voice. */
  get featured(): string | null {
    return this.client.featured(this.me);
  }

  /** Speaker view into `el`, likewise: whoever's talking big (or whoever
   * you pinned), everyone else in the call or voice in a strip. Empty
   * outside a call or voice. */
  spotlight(el: Element, o: SpotlightOptions = {}): () => void {
    return styled(el, (root) => mountSpotlight(this, root, o));
  }

  /** The voice bar (who's in voice, with speaking rings; join, mute,
   * video, leave) into `el`, likewise. Empty where the relay has no voice. */
  voiceBar(el: Element): () => void {
    return styled(el, (root) => mountVoice(this, root));
  }

  /** The call bar (a ring to answer, who you're calling, mute, video and
   * leave)
   * into `el`, likewise. Empty while there's no call, or no calls here. */
  callBar(el: Element): () => void {
    return styled(el, (root) => mountCall(this, root));
  }

  /** Draw everyone in the room into `el` (in a shadow root of its own,
   * with the elements' styles); returns a function to stop. */
  mount(el: Element, o: PeopleOptions = {}): () => void {
    return styled(el, (root) => mountPeople(this, root, o));
  }

  /** The room's chat (messages and an input) into `el`, likewise. */
  chat(el: Element, o: ChatOptions = {}): () => void {
    return styled(el, (root) => mountChat(this, root, o), true);
  }

  /** Draw one person into `el`, likewise. */
  avatar(el: Element, sub: string, o: AvatarOptions = {}): () => void {
    return styled(el, (root) => mountAvatar(this, root, sub, o), true);
  }

  leave() {
    this.client.stopCamera();
    this.unsub();
    this.stop();
  }

  private emit<K extends keyof RoomEvents>(event: K, ...args: Parameters<RoomEvents[K]>) {
    for (const fn of [...this.handlers[event]]) (fn as (...a: unknown[]) => void)(...args);
  }

  private changed() {
    const c = this.client;
    if (c.members !== this.seen.members) {
      this.seen.members = c.members;
      this.emit("members", c.members);
    }
    if (c.waves.length > this.seen.waves) for (const k of c.waves.slice(this.seen.waves)) this.emit("wave", k.from);
    this.seen.waves = c.waves.length;
    if (c.answers.length > this.seen.answers) for (const a of c.answers.slice(this.seen.answers)) this.emit("answer", a.from, a.yes);
    this.seen.answers = c.answers.length;
    for (const r of c.reactions) if (r.at > this.seen.reactedAt) this.emit("react", r.from, r.emoji);
    this.seen.reactedAt = Math.max(this.seen.reactedAt, ...c.reactions.map((r) => r.at));
    for (const r of c.rings) if (!this.seen.rings.has(r.id)) this.emit("ring", r.from, r.id);
    this.seen.rings = new Set(c.rings.map((r) => r.id));
    if (c.inCall !== this.seen.call) {
      this.seen.call = c.inCall;
      this.emit("call", c.inCall);
    }
    // Voice: who's in it (and muted), or you in it, changed.
    const voice = c.voiceMembers.map((m) => `${m.sub}${m.muted ? "-" : "+"}`).join(" ");
    if (voice !== this.seen.voice || c.inVoice !== this.seen.joined) {
      this.seen.voice = voice;
      this.seen.joined = c.inVoice;
      this.emit("voice", c.voiceMembers, c.inVoice);
    }
    const speaker = `${c.activeSpeaker ?? ""} ${c.pinned ?? ""}`;
    if (speaker !== this.seen.speaker) {
      this.seen.speaker = speaker;
      this.emit("speaker", c.activeSpeaker, c.pinned);
    }
    for (const m of c.messages) if (m.id > this.seen.messageId) this.emit("message", m);
    this.seen.messageId = Math.max(this.seen.messageId, ...c.messages.map((m) => m.id));
    if (c.live !== this.seen.live) {
      this.seen.live = c.live;
      this.emit("live", c.live);
    }
  }
}

/** A host in `el` with a shadow root carrying the stylesheet, for `draw`
 * to fill; `fill` makes the host take the element's whole box. */
export function styled(el: Element, draw: (root: ShadowRoot) => () => void, fill = false): () => void {
  const host = document.createElement("div");
  if (fill) host.style.cssText = "width:100%;height:100%";
  el.append(host);
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = CSS;
  root.append(style);
  const stop = draw(root);
  return () => {
    stop();
    host.remove();
  };
}

/** Join `o.room`: resolves once the relay has let you in (or after a few
 * seconds of trying, still connecting); rejects if it refuses. */
export function connect(o: ConnectOptions): Promise<Room> {
  const room = new Room(o);
  return new Promise((ok, no) => {
    if (room.client.live === "on") return ok(room);
    const t = setTimeout(() => (off(), ok(room)), 8_000);
    const off = room.on("live", (s) => {
      if (s === "on") {
        clearTimeout(t);
        off();
        ok(room);
      } else if (s === "refused") {
        clearTimeout(t);
        off();
        room.leave();
        no(new Error("the relay refused to let you in"));
      }
    });
  });
}
