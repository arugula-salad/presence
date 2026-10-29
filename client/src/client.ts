// Who's around, for every view of them on the page (Arugula S43, S44): the
// frames of the people in the room, heard through a transport (./transport:
// arugula.video's relay, or Arugula control's), and your own camera, if
// you turned it on. Framework-free: a view subscribes and reads.
//
// Hearing runs while a view that shows people is open (`watch`), and the
// camera runs until you turn it off or close the page; nothing turns it
// on but you.
//
// A camera sends outlines or, in avatar mode, rigs (presence-core's
// avatar): your pose as numbers, which every page draws as the character
// you picked. A rig comes a dozen times a second and avatars read it every
// animation frame, so a rig only tells listeners when someone starts or
// stops.
//
// In a call (PROTOCOL.md "Calls"), your video is off until you turn it on
// (setVideo), and it's real video, for the people in the call alone. It
// comes from the same camera as your character or outline (one device,
// opened once; ./call publishes a clone of the camera's track), so
// presence carries on for everyone in the room while it's on.
//
// Every room also has a voice channel (PROTOCOL.md "Voice"): join it and
// leave it as you like, muted on joining (unmute to talk), with video as
// in a call. A page has one audio session: joining voice leaves your call,
// and taking a call leaves voice, each saying so in `notice`.
//
// Your microphone's noise filter (./noise): Krisp, Standard or Off, the
// same for calls and voice, kept in this browser, and switched in a call
// or voice without leaving it (setNoiseFilter). `noise` says what you
// picked, what's on your microphone now, and why Krisp isn't, if it isn't.
//
// Speaker view (Arugula #332): whichever you're in, a call or voice has one
// current speaker (`activeSpeaker`, held steady by ./speaker), and a page
// can pin someone in its place (`pin`, this page alone). `featured` is who
// a spotlight shows big, and `roster` who's in it with you.

import { startCamera, type Camera, type FrameStats } from "@arugula/presence-core/outline/camera";
import { decodeFrame, type Frame } from "@arugula/presence-core/outline/frame";
import { RIG, WAVE_MS, unpackRig, type Look, type Rig } from "@arugula/presence-core/avatar/rig";
import type { AvatarCamera } from "@arugula/presence-core/avatar/cam";
import type { CallJoin, Member, Message, Mode, Transport, TransportEvents, VoiceJoin } from "./transport.ts";
import { joinLiveKit, type CallPerson, type JoinCall, type LiveCall } from "./call.ts";
import { isNoiseFilter, noiseAfter, type Noise, type NoiseFilter, type NoiseReport } from "./noise.ts";

/** The most messages a page keeps (older ones are a loadEarlier() away). */
export const MESSAGES_KEPT = 500;
/** A history page from the relay (PROTOCOL.md). */
const PAGE = 50;

/** `into` with `more` merged in: by id, oldest first, the newest
 * MESSAGES_KEPT. */
export function mergeMessages(into: Message[], more: Message[]): Message[] {
  const byId = new Map(into.map((m) => [m.id, m]));
  for (const m of more) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.id - b.id).slice(-MESSAGES_KEPT);
}

/** How long a reaction floats over its sender's tile. */
export const REACT_MS = 2400;

/** The reactions a page offers (any single emoji goes on the wire). */
export const REACTIONS = ["👍", "👏", "😂", "🎉", "❤️", "👋", "☕"] as const;

/** A call you're in, or ringing someone into (PROTOCOL.md "Calls"). */
export interface Call {
  id: string;
  /** Ringing someone (nobody's said yes yet), joining LiveKit, in it, or
   * LiveKit reconnecting by itself. */
  state: "ringing" | "joining" | "on" | "reconnecting";
  /** Who you're ringing now (into this call). */
  ringing: string[];
  /** Who's in it, you included, as LiveKit says (once joined). */
  people: CallPerson[];
  muted: boolean;
  /** Your camera's video is on in the call (setVideo). */
  video: boolean;
  /** The browser blocked the call's audio until a click (`startAudio`). */
  blocked: boolean;
  /** Who's talking, held steady (./speaker): a newcomer takes over after
   * 0.7 s of talking, a cough doesn't, and nobody talking keeps
   * the last. Never you unless you're alone; null until someone speaks. */
  activeSpeaker: string | null;
  error: string;
}

/** You in the room's voice channel (PROTOCOL.md "Voice"). */
export interface Voice {
  /** Joining (the relay, then LiveKit), in it, or LiveKit reconnecting. */
  state: "joining" | "on" | "reconnecting";
  /** Who's in it, you included, as LiveKit says (once joined): who's
   * speaking, muted, on video. Everyone in the room sees who's in voice
   * from presence (`voiceMembers`). */
  people: CallPerson[];
  /** You join muted. */
  muted: boolean;
  video: boolean;
  blocked: boolean;
  /** Who's talking, held steady, as in a call. */
  activeSpeaker: string | null;
  error: string;
}

/** How long a notice ("You left voice to take the call") shows. */
export const NOTICE_MS = 5_000;

/** In a call that's on, alone this long (everyone else left, or nobody
 * came), and it ends. */
const ALONE_MS = 30_000;

/** A frame older than this is someone whose camera went away. */
const STALE = 12_000;

export interface Seen {
  /** An outline frame, or (avatar mode) a rig and the look to draw it in. */
  frame?: Frame;
  rig?: Rig;
  look?: Look;
  at: number;
  bytes: number;
}

function kept<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function keep(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // Not kept: this page still has it.
  }
}

export interface Mine {
  frame: Frame | null;
  stats: FrameStats | null;
  /** Avatar mode: your newest rig, and how long tracking took. */
  rig: Rig | null;
  trackMs: number;
  /** Bytes sent in the last few seconds, for kbps. */
  sent: { at: number; bytes: number }[];
  error: string;
}

export interface PresenceClientOptions {
  transport: Transport;
  /** Where this browser keeps your mode, look and noise filter
   * (localStorage keys `<storage>mode`, `<storage>look`, `<storage>noise`). */
  storage?: string;
  /** Tests: how a call's LiveKit room is joined. */
  joinCall?: JoinCall;
}

export class PresenceClient {
  private seen = new Map<string, Seen>();
  private listeners = new Set<() => void>();
  private transport: Transport;
  private storage: string;
  private watchers = 0;
  private sweep: number | undefined;
  private camera: Camera | null = null;
  private avatarCam: AvatarCamera | null = null;
  private starting = false;
  /** The look each person last sent, so their avatar idles in it after
   * their camera goes off. */
  private looks = new Map<string, Look>();
  /** Outline lines or an avatar (S44); yours, kept in this browser. */
  mode: "outline" | "avatar";
  /** Your character and colour (S44). */
  look: Look;
  /** Rig frames a second. */
  rigFps = 12;
  fps = 4;
  detail = 0.7;
  /** Colour lines by what they trace (presence-core's outline/labels). */
  label = true;
  /** Labelling's state, and why it stopped if it did. */
  labelState: "loading" | "on" | "off" = "off";
  labelError = "";
  /** Estimate depth (presence-core's outline/depth): far lines fainter, labels checked. */
  depth = true;
  depthState: "loading" | "on" | "off" = "off";
  depthError = "";
  mine: Mine | null = null;
  /** Hearing others, for a view to say. */
  live: "off" | "connecting" | "on" | "refused" = "off";
  /** Who's in the room, where the transport knows (the relay's presence). */
  members: Member[] = [];
  /** Who waved, newest last, until answered. */
  waves: { from: string; at: number }[] = [];
  private wavedAt = 0;
  /** The room's text messages, oldest first (PROTOCOL.md `say`). */
  messages: Message[] = [];
  /** Whether there may be messages before the first one here. */
  hasEarlier = true;
  /** Reactions in the last REACT_MS, yours included, oldest first: an
   * emoji floating over someone's tile. */
  reactions: { from: string; emoji: string; at: number }[] = [];
  /** Answers to your waves and calls, newest last, until dismissed. */
  answers: { from: string; yes: boolean; at: number }[] = [];
  /** Whether the relay has calls (PROTOCOL.md "Calls"): hide call
   * buttons where it hasn't. */
  callsOn = false;
  /** Who's ringing you, newest last, until answered or over. */
  rings: { from: string; id: string; at: number }[] = [];
  /** The call you're in or ringing someone into. */
  inCall: Call | null = null;
  private live_: LiveCall | null = null;
  private joinCall: JoinCall;
  private alone: number | undefined;
  private rejoined = false;
  /** The camera track your call's video is a clone of now, if any. */
  private videoFrom: MediaStreamTrack | null = null;
  /** setVideo turned the camera on: off again with the video. */
  private cameraForVideo = false;
  /** Whether the relay has a voice channel in every room. */
  voiceOn = false;
  /** You in the room's voice, or null. */
  inVoice: Voice | null = null;
  private voiceLive: LiveCall | null = null;
  private voiceVideoFrom: MediaStreamTrack | null = null;
  private voiceRejoined = false;
  /** Something the page should say for a moment (NOTICE_MS): you left
   * voice for a call, or a call for voice. */
  notice: { text: string; at: number } | null = null;
  /** Your microphone's noise filter in calls and voice (./noise). */
  noise: Noise;
  /** The noise filter you picked (kept in this browser), or null for the
   * default. */
  private noiseChosen: NoiseFilter | null;

  constructor(o: PresenceClientOptions) {
    this.transport = o.transport;
    this.storage = o.storage ?? "arugula.presence.";
    this.mode = kept(`${this.storage}mode`, "outline");
    this.look = kept(`${this.storage}look`, { character: 2, colour: 0 });
    const noise = kept<unknown>(`${this.storage}noise`, null);
    this.noiseChosen = isNoiseFilter(noise) ? noise : null;
    this.noise = { mode: this.noiseChosen ?? "krisp", active: null, krisp: null, fallback: "" };
    this.joinCall = o.joinCall ?? joinLiveKit;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  of(account: string): Seen | null {
    const s = this.seen.get(account);
    return s && Date.now() - s.at < STALE ? s : null;
  }

  /** The look `account` last sent a rig in, this session. */
  lookOf(account: string): Look | null {
    return this.looks.get(account) ?? null;
  }

  setMode(mode: "outline" | "avatar") {
    if (mode === this.mode) return;
    const was = this.cameraOn;
    if (was) this.closeCamera();
    this.mode = mode;
    keep(`${this.storage}mode`, mode);
    this.emit();
    // A call's video carries on, from the restarted camera's stream.
    if (was) void this.startCamera();
  }

  setLook(look: Look) {
    this.look = look;
    keep(`${this.storage}look`, look);
    this.avatarCam?.setLook(look);
    this.transport.state?.({ look });
    this.emit();
  }

  /** Say whether you're away (the relay's presence carries it). */
  setAway(away: boolean) {
    this.transport.state?.({ away });
  }

  /** Ask `to` to talk, or answer someone who asked. */
  wave(to: string) {
    this.wavedAt = Date.now();
    this.transport.wave?.(to);
  }

  /** Send a text message to the room; resolves with it as kept, rejects
   * with the relay's reason (too long, too fast…). */
  async say(text: string): Promise<Message> {
    if (!this.transport.say) throw new Error("this room has no text");
    const m = await this.transport.say(text);
    this.messages = mergeMessages(this.messages, [m]);
    this.emit();
    return m;
  }

  /** The page of messages before the first one here. */
  async loadEarlier(): Promise<void> {
    const first = this.messages[0];
    if (!first || !this.transport.history || !this.hasEarlier) return;
    const earlier = await this.transport.history(first.id);
    this.hasEarlier = earlier.length >= PAGE;
    this.messages = mergeMessages(earlier, this.messages);
    this.emit();
  }

  /** Send an emoji to the room (`me` is your sub, for your own tile). A
   * 👋 waves on your avatar too. */
  react(emoji: string, me = "") {
    this.transport.react?.(emoji);
    this.reacted(me, emoji);
    if (emoji === "👋") this.wavedAt = Date.now();
  }

  /** The reactions over `sub`'s tile now. */
  reactionsOf(sub: string): { emoji: string; at: number }[] {
    return this.reactions.filter((r) => r.from === sub && Date.now() - r.at < REACT_MS);
  }

  private reacted(from: string, emoji: string) {
    const now = Date.now();
    this.reactions = [...this.reactions.filter((r) => now - r.at < REACT_MS), { from, emoji, at: now }];
    this.emit();
    // Gone from view once it's floated away.
    setTimeout(() => this.emit(), REACT_MS + 50);
  }

  /** Whether `sub`'s avatar is waving now: their wave (or wave back) came
   * in the last WAVE_MS, or it's you and you just waved. */
  waving(sub: string, me = false): boolean {
    const fresh = (at: number) => Date.now() - at < WAVE_MS;
    if (me) return fresh(this.wavedAt);
    return (
      this.waves.some((w) => w.from === sub && fresh(w.at)) ||
      this.answers.some((a) => a.from === sub && a.yes && fresh(a.at)) ||
      this.rings.some((r) => r.from === sub && fresh(r.at)) ||
      this.reactions.some((r) => r.from === sub && r.emoji === "👋" && fresh(r.at))
    );
  }

  answer(from: string, yes: boolean) {
    if (yes) this.wavedAt = Date.now();
    this.waves = this.waves.filter((k) => k.from !== from);
    this.transport.answer?.(from, yes);
    this.emit();
  }

  /** Ring `to` to talk (into your call, if you're in one): your avatar
   * waves, theirs rings. Resolves with the call's id; rejects with the
   * relay's reason ("calls aren't set up here", "not in the room"…). */
  async call(to: string): Promise<string> {
    if (!this.transport.call) throw new Error("calls aren't set up here");
    this.wavedAt = Date.now();
    this.emit();
    const { id } = await this.transport.call(to);
    const c = this.inCall;
    this.inCall = c && c.id === id ? { ...c, ringing: [...c.ringing.filter((s) => s !== to), to] } : { id, state: "ringing", ringing: [to], people: [], muted: false, video: false, blocked: false, activeSpeaker: null, error: "" };
    this.emit();
    return id;
  }

  /** Answer a ring: yes joins the call (leaving any other). */
  async answerCall(id: string, yes: boolean): Promise<void> {
    this.rings = this.rings.filter((r) => r.id !== id);
    if (yes) this.wavedAt = Date.now();
    // One audio session: out of voice for the call.
    if (yes && this.inVoice) {
      this.leaveVoice();
      this.tell("You left voice to take the call.");
    }
    this.emit();
    await this.transport.callAnswer?.(id, yes);
  }

  /** Leave the call (or stop ringing). */
  leaveCall() {
    const c = this.inCall;
    if (!c) return;
    this.transport.callLeave?.(c.id);
    this.endCall();
  }

  async setMuted(muted: boolean) {
    if (!this.inCall) return;
    this.inCall = { ...this.inCall, muted };
    this.emit();
    await this.live_?.setMuted(muted);
  }

  /** Your microphone's noise filter, for calls and voice: Krisp (LiveKit
   * Cloud's noise cancellation), Standard (the browser's) or Off. Kept in
   * this browser; in a call or voice it switches now, muted or not.
   * Where Krisp can't run, Standard, and `noise.fallback` says why. */
  async setNoiseFilter(mode: NoiseFilter) {
    if (!isNoiseFilter(mode)) throw new Error(`no noise filter "${String(mode)}"`);
    this.noiseChosen = mode;
    keep(`${this.storage}noise`, mode);
    this.noise = { ...this.noise, mode, fallback: mode === "krisp" ? this.noise.fallback : "" };
    this.emit();
    await Promise.all([this.live_?.setNoise(mode), this.voiceLive?.setNoise(mode)]);
  }

  /** A call's or voice's microphone said what's on it. */
  private noiseReport(r: NoiseReport) {
    this.noise = noiseAfter(this.noise, this.noiseChosen, r);
    this.emit();
  }

  /** Out of a call or voice: no microphone, nothing on it. */
  private noiseOff() {
    if (this.noise.active === null && !this.noise.fallback) return;
    this.noise = { ...this.noise, active: null, fallback: "" };
  }

  /** Turn your video on or off in the call you're in. It's your camera's
   * real picture, for the people in the call alone (presence never sends
   * one); your character or outline carries on for everyone in the room.
   * A camera that's off turns on for it, and off again with it. */
  async setVideo(on: boolean) {
    const c = this.inCall;
    if (!c || c.state === "ringing" || c.video === on) return;
    this.inCall = { ...c, video: on, error: "" };
    this.emit();
    await this.turnVideo(on, (change) => this.patchCall(c.id, change));
  }

  /** The camera for a call's or voice's video, once its `video` is set: on
   * for it if it was off (and off again with it), or published now. */
  private async turnVideo(on: boolean, patch: (change: { video: boolean; error: string }) => void) {
    if (on && !this.cameraOn) {
      this.cameraForVideo = true;
      // Once it's on, startCamera publishes it (syncVideo).
      await this.startCamera();
      if (!this.cameraOn) {
        this.cameraForVideo = false;
        patch({ video: false, error: this.mine?.error ?? "" });
      }
      return;
    }
    if (!on && this.cameraForVideo) {
      this.cameraForVideo = false;
      return this.stopCamera();
    }
    await this.syncVideo();
  }

  /** Whether `sub`'s tile shows their video now: they're in your call or
   * your voice channel with their camera on (you too, while yours is). */
  videoOf(sub: string): boolean {
    return !!this.inCall?.people.find((p) => p.sub === sub)?.video || !!this.inVoice?.people.find((p) => p.sub === sub)?.video;
  }

  /** Show `sub`'s call (or voice) video in `el` (a muted, playsinline
   * <video>): only while it's visible does LiveKit send it, at the size
   * it's shown. Returns a function to stop. */
  attachVideo(sub: string, el: HTMLVideoElement): () => void {
    const live = this.inVoice?.people.some((p) => p.sub === sub) ? this.voiceLive : this.live_;
    return live?.attach(sub, el) ?? (() => {});
  }

  /** Your call's and voice's video, from the camera's stream now:
   * published, swapped for a restarted camera's, or taken down. */
  private async syncVideo() {
    const c = this.inCall;
    const live = this.live_;
    if (c && live) {
      const track = c.video ? this.cameraTrack() : null;
      if (track !== this.videoFrom) {
        this.videoFrom = track;
        try {
          await live.setVideo(track);
        } catch (e) {
          this.videoFrom = null;
          this.patchCall(c.id, { video: false, error: `Your video didn't start: ${(e as Error).message}` });
        }
      }
    }
    const v = this.inVoice;
    const vlive = this.voiceLive;
    if (v && vlive) {
      const track = v.video ? this.cameraTrack() : null;
      if (track === this.voiceVideoFrom) return;
      this.voiceVideoFrom = track;
      try {
        await vlive.setVideo(track);
      } catch (e) {
        this.voiceVideoFrom = null;
        this.patchVoice({ video: false, error: `Your video didn't start: ${(e as Error).message}` });
      }
    }
  }

  private cameraTrack(): MediaStreamTrack | null {
    const s = this.camera?.stream ?? this.avatarCam?.stream;
    return s?.getVideoTracks().find((t) => t.readyState === "live") ?? null;
  }

  /** From a click: play a call (or voice) the browser wouldn't play by
   * itself. */
  async startAudio() {
    await this.live_?.startAudio();
    await this.voiceLive?.startAudio();
    if (this.inCall) this.inCall = { ...this.inCall, blocked: false };
    if (this.inVoice) this.inVoice = { ...this.inVoice, blocked: false };
    this.emit();
  }

  /** Whether `sub` is in a call (presence says), and in yours. */
  inACall(sub: string): boolean {
    return !!this.members.find((m) => m.sub === sub)?.call;
  }

  inMyCall(sub: string): boolean {
    const c = this.inCall;
    return !!c && c.state !== "ringing" && this.members.find((m) => m.sub === sub)?.call === c.id;
  }

  private endCall() {
    const live = this.live_;
    this.live_ = null;
    this.videoFrom = null;
    this.inCall = null;
    this.pinned = null;
    if (!this.inVoice) this.noiseOff();
    clearTimeout(this.alone);
    void live?.leave();
    // A camera turned on for the call's video goes off with the call.
    if (this.cameraForVideo) {
      this.cameraForVideo = false;
      this.stopCamera();
    }
    this.emit();
  }

  private patchCall(id: string, change: Partial<Call>) {
    if (this.inCall?.id !== id) return;
    this.inCall = { ...this.inCall, ...change };
    this.emit();
  }

  /** Into call `j.id`'s LiveKit room (out of any other first). */
  private async joined(j: CallJoin) {
    if (this.inCall?.id !== j.id) {
      void this.live_?.leave();
      this.live_ = null;
    }
    this.videoFrom = null;
    const was = this.inCall?.id === j.id ? this.inCall : null;
    this.inCall = { id: j.id, state: "joining", ringing: was?.ringing ?? [], people: [], muted: was?.muted ?? false, video: was?.video ?? false, blocked: false, activeSpeaker: null, error: "" };
    this.emit();
    // Nobody else turns up: it ends.
    const lonely = (people: CallPerson[]) => {
      clearTimeout(this.alone);
      if (people.length <= 1) this.alone = setTimeout(() => this.inCall?.id === j.id && this.leaveCall(), ALONE_MS) as unknown as number;
    };
    let had = 0;
    try {
      const live = await this.joinCall(j, {
        people: (people) => {
          // Everyone else left: so does this page.
          if (had > 1 && people.length <= 1) return this.inCall?.id === j.id && this.leaveCall();
          had = Math.max(had, people.length);
          lonely(people);
          this.unpinGone(people);
          this.patchCall(j.id, { people });
        },
        speaker: (activeSpeaker) => this.patchCall(j.id, { activeSpeaker }),
        state: (state, byUs) => {
          if (state !== "ended") return this.patchCall(j.id, { state });
          if (byUs || this.inCall?.id !== j.id) return;
          void this.rejoin(j.id);
        },
        blocked: (blocked) => this.patchCall(j.id, { blocked }),
        noise: (r) => this.inCall?.id === j.id && this.noiseReport(r),
      }, { noise: this.noise.mode });
      if (this.inCall?.id !== j.id) return void live.leave();
      this.live_ = live;
      this.rejoined = false;
      if (this.inCall.muted) await live.setMuted(true);
      lonely(this.inCall.people);
      // Back in after a drop with your video on: it goes up again.
      await this.syncVideo();
    } catch (e) {
      this.patchCall(j.id, { error: `The call didn't connect: ${(e as Error).message}` });
    }
  }

  /** LiveKit dropped this page: once, back in with a fresh token. */
  private async rejoin(id: string) {
    this.live_ = null;
    if (this.rejoined || !this.transport.callToken) return this.leaveCall();
    this.rejoined = true;
    try {
      await this.joined(await this.transport.callToken(id));
    } catch {
      this.leaveCall();
    }
  }

  /** Into the room's voice channel, muted (unmute to talk): out of your
   * call first, if you're in one. Rejects with the relay's reason ("voice
   * is full", "voice isn't set up here"). */
  async joinVoice(): Promise<void> {
    if (!this.transport.voiceJoin) throw new Error("voice isn't set up here");
    if (this.inVoice) return;
    if (this.inCall) {
      this.leaveCall();
      this.tell("You left the call to join voice.");
    }
    this.inVoice = { state: "joining", people: [], muted: true, video: false, blocked: false, activeSpeaker: null, error: "" };
    this.voiceRejoined = false;
    this.emit();
    let j: VoiceJoin;
    try {
      j = await this.transport.voiceJoin();
    } catch (e) {
      this.inVoice = null;
      this.emit();
      throw e;
    }
    await this.voiceJoined(j);
  }

  /** Out of the room's voice channel. */
  leaveVoice() {
    if (!this.inVoice) return;
    this.transport.voiceLeave?.();
    this.endVoice();
  }

  /** Mute or unmute yourself in voice (everyone in the room sees it). */
  async setVoiceMuted(muted: boolean) {
    if (!this.inVoice) return;
    this.patchVoice({ muted });
    this.transport.voiceMute?.(muted);
    await this.voiceLive?.setMuted(muted);
  }

  /** Your video in voice, as in a call: your camera's real picture, for
   * the people in voice alone. */
  async setVoiceVideo(on: boolean) {
    const v = this.inVoice;
    if (!v || v.video === on) return;
    this.patchVoice({ video: on, error: "" });
    await this.turnVideo(on, (change) => this.patchVoice(change));
  }

  /** Who's in the room's voice (presence says, so everyone sees). */
  get voiceMembers(): Member[] {
    return this.members.filter((m) => m.voice);
  }

  /** Whether `sub` is speaking in voice now (LiveKit says, so only a page
   * in voice knows). */
  speakingInVoice(sub: string): boolean {
    return !!this.inVoice?.people.find((p) => p.sub === sub)?.speaking;
  }

  /** Who's in the call or voice you're in, you included (LiveKit says). */
  get roster(): CallPerson[] {
    return this.inCall?.people ?? this.inVoice?.people ?? [];
  }

  /** The current speaker in your call or voice (held steady), or null. */
  get activeSpeaker(): string | null {
    return this.inCall?.activeSpeaker ?? this.inVoice?.activeSpeaker ?? null;
  }

  /** Who you pinned big in your call or voice (this page alone), or null. */
  pinned: string | null = null;

  /** Pin `sub` big in place of the current speaker, or null to go back to
   * following whoever's talking. Only this page sees it. */
  pin(sub: string | null) {
    const next = sub && this.roster.some((p) => p.sub === sub) ? sub : null;
    if (next === this.pinned) return;
    this.pinned = next;
    this.emit();
  }

  /** Who a spotlight shows big: whoever you pinned, else the current
   * speaker, else the first other person in it (you, if you're alone);
   * null outside a call or voice. `me` is your sub, where the client
   * hasn't seen it (LiveKit lists you first). */
  featured(me = this.roster[0]?.sub ?? ""): string | null {
    const people = this.roster;
    if (!people.length) return null;
    const here = (s: string | null) => !!s && people.some((p) => p.sub === s);
    if (here(this.pinned)) return this.pinned;
    if (here(this.activeSpeaker)) return this.activeSpeaker;
    return people.find((p) => p.sub !== me)?.sub ?? people[0].sub;
  }

  /** A pin on someone who's left goes. */
  private unpinGone(people: CallPerson[]) {
    if (this.pinned && !people.some((p) => p.sub === this.pinned)) this.pinned = null;
  }

  /** Forget the notice (it's been seen). */
  dismissNotice() {
    this.notice = null;
    this.emit();
  }

  private tell(text: string) {
    const at = Date.now();
    this.notice = { text, at };
    this.emit();
    setTimeout(() => {
      if (this.notice?.at === at) this.dismissNotice();
    }, NOTICE_MS);
  }

  private patchVoice(change: Partial<Voice>) {
    if (!this.inVoice) return;
    this.inVoice = { ...this.inVoice, ...change };
    this.emit();
  }

  private endVoice() {
    const live = this.voiceLive;
    this.voiceLive = null;
    this.voiceVideoFrom = null;
    this.inVoice = null;
    this.pinned = null;
    if (!this.inCall) this.noiseOff();
    void live?.leave();
    if (this.cameraForVideo && !this.inCall?.video) {
      this.cameraForVideo = false;
      this.stopCamera();
    }
    this.emit();
  }

  /** Into the voice channel's LiveKit room, muted. */
  private async voiceJoined(j: VoiceJoin) {
    const was = this.voiceLive;
    this.voiceLive = null;
    void was?.leave();
    this.voiceVideoFrom = null;
    try {
      const live = await this.joinCall(
        { id: "voice", ...j },
        {
          people: (people) => {
            this.unpinGone(people);
            this.patchVoice({ people });
          },
          speaker: (activeSpeaker) => this.patchVoice({ activeSpeaker }),
          state: (state, byUs) => {
            if (state !== "ended") return this.patchVoice({ state });
            if (byUs || !this.inVoice) return;
            void this.voiceRejoin();
          },
          blocked: (blocked) => this.patchVoice({ blocked }),
          noise: (r) => this.inVoice && this.noiseReport(r),
        },
        { muted: true, noise: this.noise.mode },
      );
      if (!this.inVoice) return void live.leave();
      this.voiceLive = live;
      // Unmuted while it was joining.
      if (!this.inVoice.muted) await live.setMuted(false);
      await this.syncVideo();
    } catch (e) {
      this.patchVoice({ error: `Voice didn't connect: ${(e as Error).message}` });
    }
  }

  /** LiveKit dropped this page from voice: once, back in with a fresh token. */
  private async voiceRejoin() {
    this.voiceLive = null;
    if (this.voiceRejoined || !this.transport.voiceToken) return this.leaveVoice();
    this.voiceRejoined = true;
    try {
      await this.voiceJoined(await this.transport.voiceToken());
      if (this.inVoice) this.transport.voiceMute?.(this.inVoice.muted);
    } catch {
      this.leaveVoice();
    }
  }

  /** Forget an answer to your wave (it's been seen). */
  dismiss(from: string) {
    this.answers = this.answers.filter((a) => a.from !== from);
    this.emit();
  }

  /** A view shows people: hearing runs while one does. */
  watch(): () => void {
    if (this.watchers++ === 0) this.open();
    return () => {
      if (--this.watchers === 0) this.close();
    };
  }

  get cameraOn(): boolean {
    return !!this.camera || !!this.avatarCam || this.starting;
  }

  async startCamera() {
    if (this.cameraOn) return;
    this.starting = true;
    this.mine = { frame: null, stats: null, rig: null, trackMs: 0, sent: [], error: "" };
    this.emit();
    this.transport.state?.({ mode: this.mode as Mode, look: this.look });
    if (this.mode === "avatar") return this.startAvatar();
    try {
      this.camera = await startCamera({
        fps: this.fps,
        detail: this.detail,
        label: this.label,
        onLabelState: (state, error) => {
          this.labelState = state;
          this.labelError = error ?? "";
          this.emit();
        },
        depth: this.depth,
        onDepthState: (state, error) => {
          this.depthState = state;
          this.depthError = error ?? "";
          this.emit();
        },
        onFrame: (frame, stats) => {
          if (!this.mine) return;
          this.mine.frame = frame;
          this.mine.stats = stats;
          if (stats.sent) {
            const now = Date.now();
            this.mine.sent = [...this.mine.sent.filter((s) => now - s.at < 5_000), { at: now, bytes: stats.bytes }];
          }
          this.emit();
        },
        send: (bytes) => void this.post(bytes),
        onError: (e) => {
          if (this.mine) this.mine.error = e.message;
          this.emit();
        },
      });
      addEventListener("pagehide", this.leave);
      void this.syncVideo();
    } catch (e) {
      this.mine = { frame: null, stats: null, rig: null, trackMs: 0, sent: [], error: cameraRefusal(e as Error) };
      this.transport.state?.({ mode: "none" });
      this.videoGone();
    } finally {
      this.starting = false;
      this.emit();
    }
  }

  private async startAvatar() {
    let told = 0;
    try {
      const { startAvatarCamera } = await import("@arugula/presence-core/avatar/cam");
      this.avatarCam = await startAvatarCamera({
        fps: this.rigFps,
        look: this.look,
        onRig: (rig, ms) => {
          if (!this.mine) return;
          this.mine.rig = rig;
          this.mine.trackMs = ms;
        },
        send: (bytes) => {
          if (!this.mine) return;
          const now = Date.now();
          this.mine.sent = [...this.mine.sent.filter((s) => now - s.at < 5_000), { at: now, bytes: bytes.length }];
          void this.post(bytes);
          // The stats line, about once a second.
          if (now - told > 1000) {
            told = now;
            this.emit();
          }
        },
        onError: (e) => {
          if (this.mine) this.mine.error = e.message;
          this.emit();
        },
      });
      addEventListener("pagehide", this.leave);
      void this.syncVideo();
    } catch (e) {
      this.mine = { frame: null, stats: null, rig: null, trackMs: 0, sent: [], error: cameraRefusal(e as Error) };
      this.transport.state?.({ mode: "none" });
      this.videoGone();
    } finally {
      this.starting = false;
      this.emit();
    }
  }

  stopCamera() {
    if (!this.camera && !this.avatarCam) return;
    this.closeCamera();
    this.cameraForVideo = false;
    this.videoGone();
    this.emit();
  }

  /** No camera (off, or it didn't start), no video: a call's (and
   * voice's) goes down. */
  private videoGone() {
    if (this.inCall?.video) this.inCall = { ...this.inCall, video: false };
    if (this.inVoice?.video) this.inVoice = { ...this.inVoice, video: false };
    void this.syncVideo();
  }

  private closeCamera() {
    this.camera?.stop();
    this.camera = null;
    this.avatarCam?.stop();
    this.avatarCam = null;
    this.mine = null;
    removeEventListener("pagehide", this.leave);
    this.transport.off();
    this.emit();
  }

  setRate(fps: number) {
    this.fps = fps;
    this.camera?.setRate(fps);
    this.emit();
  }

  setLabel(on: boolean) {
    this.label = on;
    this.camera?.setLabel(on);
    this.emit();
  }

  setDepth(on: boolean) {
    this.depth = on;
    this.camera?.setDepth(on);
    this.emit();
  }

  setDetail(d: number) {
    this.detail = d;
    this.camera?.setDetail(d);
    this.emit();
  }

  /** Kilobits a second sent, over the last few seconds. */
  kbps(): number {
    const s = this.mine?.sent ?? [];
    if (s.length < 2) return 0;
    const span = Math.max(1, (s[s.length - 1].at - s[0].at) / 1000);
    return (s.slice(1).reduce((n, x) => n + x.bytes, 0) * 8) / 1000 / span;
  }

  private emit() {
    for (const fn of [...this.listeners]) fn();
  }

  private leave = () => {
    this.transport.leaving?.();
  };

  private post(bytes: Uint8Array) {
    this.transport.publish(bytes);
  }

  private events: TransportEvents = {
    frame: (sub, bytes) => void this.frame(sub, bytes),
    off: (sub) => {
      this.seen.delete(sub);
      this.emit();
    },
    live: (state) => {
      this.live = state;
      this.emit();
    },
    members: (members) => {
      this.members = members;
      this.emit();
    },
    wave: (from) => {
      this.waves = [...this.waves.filter((k) => k.from !== from), { from, at: Date.now() }];
      this.emit();
    },
    react: (from, emoji) => this.reacted(from, emoji),
    said: (m) => {
      this.messages = mergeMessages(this.messages, [m]);
      this.emit();
    },
    history: (messages) => {
      if (!this.messages.length) this.hasEarlier = messages.length >= PAGE;
      this.messages = mergeMessages(this.messages, messages);
      this.emit();
    },
    answer: (from, yes) => {
      this.answers = [...this.answers.filter((a) => a.from !== from), { from, yes, at: Date.now() }];
      this.emit();
    },
    calls: (on) => {
      this.callsOn = on;
      this.emit();
    },
    call: (from, id) => {
      this.rings = [...this.rings.filter((r) => r.id !== id && r.from !== from), { from, id, at: Date.now() }];
      this.emit();
    },
    callCancel: (id) => {
      this.rings = this.rings.filter((r) => r.id !== id);
      this.emit();
    },
    callAnswer: (id, from, yes) => {
      // A call's answer reads like a wave's (waved back, not now).
      this.answers = [...this.answers.filter((a) => a.from !== from), { from, yes, at: Date.now() }];
      const c = this.inCall;
      if (c?.id === id) {
        const ringing = c.ringing.filter((s) => s !== from);
        // Nobody said yes to a call that hadn't started: it's over.
        if (!yes && c.state === "ringing" && !ringing.length) this.inCall = null;
        else this.inCall = { ...c, ringing };
      }
      this.emit();
    },
    callJoin: (j) => {
      // The relay took this page out of voice for the call (voice_left).
      if (this.inVoice) this.endVoice();
      void this.joined(j);
    },
    voice: (on) => {
      this.voiceOn = on;
      this.emit();
      // Back on the relay after a drop, still in LiveKit's voice room: take
      // your seat (and say muted or not) again.
      const v = this.inVoice;
      if (on && v && v.state !== "joining" && this.transport.voiceJoin) {
        this.transport.voiceJoin().then(
          () => this.inVoice && this.transport.voiceMute?.(this.inVoice.muted),
          () => this.leaveVoice(),
        );
      }
    },
    voiceLeft: (reason) => {
      if (!this.inVoice) return;
      this.endVoice();
      this.tell(reason === "call" ? "You left voice for the call." : "You're in voice on another page now.");
    },
  };

  private open() {
    this.transport.listen(this.events);
    // Someone whose frames stopped without an `off` (a closed laptop).
    this.sweep = setInterval(() => this.emit(), 3_000) as unknown as number;
    this.emit();
  }

  private close() {
    this.leaveCall();
    this.leaveVoice();
    this.transport.unlisten();
    clearInterval(this.sweep);
    this.seen.clear();
    this.live = "off";
    this.emit();
  }

  /** `sub`'s frame off the transport: a rig (an avatar) or an outline. */
  private async frame(sub: string, bytes: Uint8Array) {
    try {
      if (bytes[0] === 0 && bytes[1] === RIG) {
        const { rig, look } = unpackRig(bytes.subarray(1));
        const was = this.of(sub);
        const lookWas = this.looks.get(sub);
        this.looks.set(sub, look);
        this.seen.set(sub, { rig, look, at: Date.now(), bytes: bytes.length });
        // Avatars read the rig every frame: tell listeners only of a change
        // they'd draw differently (someone new, a new look).
        if (!was?.rig || lookWas?.character !== look.character || lookWas?.colour !== look.colour) this.emit();
        return;
      }
      const frame = await decodeFrame(bytes);
      this.seen.set(sub, { frame, at: Date.now(), bytes: bytes.length });
      this.emit();
    } catch {
      // A frame this page can't read (a newer version): skipped.
    }
  }
}

function cameraRefusal(e: Error): string {
  if (e.name === "NotAllowedError") return "The camera wasn't allowed: allow it for this site in the browser, then try again.";
  if (e.name === "NotFoundError") return "No camera here.";
  if (!navigator.mediaDevices?.getUserMedia) return "This window can't use a camera (the app's webview may not offer one).";
  return `The camera didn't start: ${e.message}`;
}

