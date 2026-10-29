// How a presence client reaches the people it shows (arugula.video's
// PROTOCOL.md, ../../PROTOCOL.md): it publishes this page's frames and
// state, and hears everyone else's. Frames are opaque bytes here and on
// the wire; who sees whom is the transport's and its server's business.

import type { Look } from "@arugula/presence-core/avatar/rig";

/** What the camera sends: outline lines, a rig for an avatar, or nothing. */
export type Mode = "outline" | "avatar" | "none";

/** Someone in the room, as the relay's presence says (a transport without
 * presence, Arugula control's, has no members). */
export interface Member {
  sub: string;
  name: string;
  look: Look | null;
  mode: Mode;
  away: boolean;
  watching: boolean;
  /** The call they're in (PROTOCOL.md "Calls"), if any. */
  call: string | null;
  /** In the room's voice channel (PROTOCOL.md "Voice"), and muted there. */
  voice: boolean;
  muted: boolean;
}

/** A LiveKit room to join for a call (PROTOCOL.md `call_join`): its URL,
 * the room's name, and a token for this page alone. */
export interface CallJoin {
  id: string;
  url: string;
  room: string;
  token: string;
}

/** The room's voice channel to join (PROTOCOL.md `voice_join`): LiveKit's
 * URL, the voice room's name, and a token for this page alone. */
export interface VoiceJoin {
  url: string;
  room: string;
  token: string;
}

/** This page's part in its members' meta. */
export interface State {
  mode?: Mode;
  look?: Look;
  away?: boolean;
  watching?: boolean;
}

/** A kept text message (PROTOCOL.md `said`): `id` only goes up in a room,
 * `at` is Unix ms. */
export interface Message {
  id: number;
  sub: string;
  name: string;
  text: string;
  at: number;
}

export interface TransportEvents {
  /** `sub`'s newest frame. */
  frame(sub: string, bytes: Uint8Array): void;
  /** `sub`'s camera went off, or their frame went stale. */
  off(sub: string): void;
  /** Hearing others: connecting, on, or refused (it won't try again). */
  live(state: "connecting" | "on" | "refused"): void;
  /** Everyone in the room, whenever that changes. */
  members?(members: Member[]): void;
  /** Someone asks to talk. */
  wave?(from: string): void;
  /** Someone's reaction: an emoji for the room. */
  react?(from: string, emoji: string): void;
  answer?(from: string, yes: boolean): void;
  /** Someone's message (not this connection's: that's `say`'s answer). */
  said?(m: Message): void;
  /** The room's last messages, on (re)joining. */
  history?(messages: Message[]): void;
  /** Whether the relay has calls (it has LiveKit keys), on joining. */
  calls?(on: boolean): void;
  /** Someone rings you: call `id`. */
  call?(from: string, id: string): void;
  /** A ring you could answer is over (answered elsewhere, given up, unanswered). */
  callCancel?(id: string): void;
  /** The answer to your ring (`reason` "no answer" when nobody did). */
  callAnswer?(id: string, from: string, yes: boolean, reason?: string): void;
  /** Join this LiveKit room: you're in the call. */
  callJoin?(j: CallJoin): void;
  /** Whether the relay has a voice channel in every room, on (re)joining. */
  voice?(on: boolean): void;
  /** The relay took this page out of voice: for a call ("call"), or the
   * same person joined voice from another page ("elsewhere"). */
  voiceLeft?(reason: string): void;
}

export interface Transport {
  /** Start hearing others (a page shows them). */
  listen(on: TransportEvents): void;
  /** Stop hearing others. */
  unlisten(): void;
  /** This page's newest frame. */
  publish(bytes: Uint8Array): void;
  /** This page's camera went off. */
  off(): void;
  /** The page is closing: say so if it can (a beacon). */
  leaving?(): void;
  state?(s: State): void;
  wave?(to: string): void;
  react?(emoji: string): void;
  answer?(to: string, yes: boolean): void;
  /** Send a message; resolves with it as kept, rejects with the reason. */
  say?(text: string): Promise<Message>;
  /** The messages before `before`, oldest first. */
  history?(before: number): Promise<Message[]>;
  /** Ring `to` (into your call, if you're in one); resolves with the
   * call's id, rejects with the reason. */
  call?(to: string): Promise<{ id: string }>;
  callAnswer?(id: string, yes: boolean): Promise<void>;
  /** Leave a call, or give up ringing. */
  callLeave?(id: string): void;
  /** A fresh token for the call you're in (after dropping out of it). */
  callToken?(id: string): Promise<CallJoin>;
  /** Into the room's voice (muted); resolves with its LiveKit room, rejects
   * with the reason ("voice is full"). Already in: a fresh token. */
  voiceJoin?(): Promise<VoiceJoin>;
  voiceLeave?(): void;
  /** Say whether you're muted in voice (presence carries it). */
  voiceMute?(muted: boolean): void;
  /** A fresh token for the room's voice (after dropping out of it). */
  voiceToken?(): Promise<VoiceJoin>;
}
