// Your camera's controls (<arugula-camera>, and the React CameraControls):
// on/off, then avatar or outline, your character and your colour. And the
// call bar (<arugula-call>, the React CallControls): a ring to answer, who
// you're calling, mute, video and leave. And the room's voice channel
// (<arugula-voice>, the React VoiceBar): who's in it with speaking rings,
// join, unmute, video and leave. Redrawn from the room's state whenever it
// changes; nothing kept here.

import { CHARACTERS } from "@arugula/presence-core/avatar/characters/index";
import { COLOURS } from "@arugula/presence-core/avatar/stage";
import type { Room } from "./room.ts";
import { NOTICE_MS, REACTIONS } from "@arugula/presence/client";

export interface CameraOptions {
  /** Everything (default), or the on/off button alone. */
  controls?: "full" | "button";
}

export function mountCamera(room: Room, el: Element | ShadowRoot, o: CameraOptions = {}): () => void {
  const bar = document.createElement("div");
  bar.className = "arugula-camera";
  bar.setAttribute("part", "camera");
  el.append(bar);
  const button = (label: string, on: boolean, run: () => void, cls = "") => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.className = `${cls}${on ? " on" : ""}`.trim();
    b.setAttribute("aria-pressed", String(on));
    b.addEventListener("click", run);
    return b;
  };
  const render = () => {
    const c = room.client;
    const on = c.cameraOn;
    const parts: HTMLElement[] = [button(on ? "Turn off my camera" : "Turn on my camera", on, () => (on ? c.stopCamera() : void c.startCamera()), on ? "" : "primary")];
    if (o.controls !== "button") {
      const mode = document.createElement("span");
      mode.className = "seg";
      mode.append(...(["avatar", "outline"] as const).map((m) => button(m === "avatar" ? "Avatar" : "Outline", c.mode === m, () => c.setMode(m))));
      parts.push(mode);
      if (c.mode === "avatar") {
        const chars = document.createElement("span");
        chars.className = "seg";
        chars.append(...CHARACTERS.map((ch) => button(ch.name, c.look.character === ch.id, () => c.setLook({ ...c.look, character: ch.id }))));
        const colours = document.createElement("span");
        colours.className = "seg";
        colours.append(
          ...COLOURS.map((v, i) => {
            const b = button("", c.look.colour === i, () => c.setLook({ ...c.look, colour: i }), "swatch");
            // The shadow root's stylesheet defines the theme's variables.
            b.style.background = `var(${v})`;
            b.setAttribute("aria-label", v.slice(2));
            return b;
          }),
        );
        parts.push(chars, colours);
      }
      // Reactions: an emoji over your tile, for the room.
      const reacts = document.createElement("span");
      reacts.className = "seg reacts-bar";
      reacts.append(
        ...REACTIONS.map((e) => {
          const b = button(e, false, () => room.react(e), "emoji");
          b.setAttribute("aria-label", `React ${e}`);
          return b;
        }),
      );
      parts.push(reacts);
      if (c.mine?.error) {
        const err = document.createElement("span");
        err.className = "error";
        err.textContent = c.mine.error;
        parts.push(err);
      }
    }
    bar.replaceChildren(...parts);
  };
  const unsub = room.client.subscribe(render);
  render();
  return () => {
    unsub();
    bar.remove();
  };
}


/** A member's name, by sub (their sub if they've gone). */
export function nameOf(room: Room, sub: string): string {
  return room.client.members.find((m) => m.sub === sub)?.name ?? sub;
}

export function mountCall(room: Room, el: Element | ShadowRoot): () => void {
  const bar = document.createElement("div");
  bar.className = "arugula-call";
  bar.setAttribute("part", "call");
  bar.setAttribute("role", "status");
  el.append(bar);
  const button = (label: string, run: () => void, cls = "") => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener("click", run);
    return b;
  };
  const line = (text: string, ...buttons: HTMLElement[]) => {
    const row = document.createElement("div");
    row.className = "row";
    const t = document.createElement("span");
    t.className = "what";
    t.textContent = text;
    row.append(t, ...buttons);
    return row;
  };
  const render = () => {
    const c = room.client;
    const rows: HTMLElement[] = [];
    if (c.callsOn) {
      for (const r of c.rings) {
        rows.push(line(`${nameOf(room, r.from)} wants to talk`, button("Answer", () => void room.answerCall(r.id, true), "primary"), button("Not now", () => void room.answerCall(r.id, false))));
      }
      const call = c.inCall;
      if (call) {
        const others = call.people.filter((p) => p.sub !== room.me).map((p) => p.name);
        const ringing = call.ringing.map((s) => nameOf(room, s));
        const what =
          call.state === "ringing"
            ? `Calling ${ringing.join(", ")}…`
            : call.state === "joining"
              ? "Joining the call…"
              : call.state === "reconnecting"
                ? "Reconnecting…"
                : others.length
                  ? `In a call with ${others.join(", ")}${ringing.length ? ` · calling ${ringing.join(", ")}…` : ""}`
                  : "Waiting for the others…";
        const buttons = [];
        if (call.state !== "ringing") {
          buttons.push(button(call.muted ? "Unmute" : "Mute", () => void room.setMuted(!call.muted), call.muted ? "on" : ""));
          const video = button(call.video ? "Stop video" : "Start video", () => void room.setVideo(!call.video), call.video ? "on" : "");
          video.title = "Video is your camera's real picture, for the people in this call";
          buttons.push(video);
        }
        if (call.blocked) buttons.push(button("Play the call", () => void c.startAudio(), "primary"));
        buttons.push(button(call.state === "ringing" ? "Cancel" : "Leave", () => room.leaveCall(), "danger"));
        const row = line(what, ...buttons);
        row.classList.add("in-call");
        rows.push(row);
        if (call.error) {
          const err = document.createElement("span");
          err.className = "error";
          err.textContent = call.error;
          rows.push(err);
        }
      }
    }
    bar.hidden = !rows.length;
    bar.replaceChildren(...rows);
  };
  const unsub = room.client.subscribe(render);
  render();
  return () => {
    unsub();
    bar.remove();
  };
}

/** The relay's reasons for not letting you into voice, in words. */
export function voiceError(reason: string): string {
  return (
    {
      "voice is full": "Voice is full right now. Try again when someone leaves.",
      "not in the room yet": "Still getting you in; try again in a moment.",
    }[reason] ?? reason
  );
}

export function mountVoice(room: Room, el: Element | ShadowRoot): () => void {
  const bar = document.createElement("div");
  bar.className = "arugula-voice";
  bar.setAttribute("part", "voice");
  bar.setAttribute("role", "region");
  bar.setAttribute("aria-label", "Voice");
  el.append(bar);
  let error = "";
  const button = (label: string, run: () => void, cls = "") => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener("click", run);
    return b;
  };
  const join = () => {
    error = "";
    room.voice.join().then(render, (e: Error) => {
      error = voiceError(e.message);
      render();
    });
  };
  // Who's in voice, a chip each: their initial, a ring while they speak,
  // and whether they're muted.
  const strip = (): HTMLElement => {
    const list = document.createElement("ul");
    list.className = "voice-strip";
    list.setAttribute("aria-label", "In voice");
    for (const m of room.voice.members) {
      const li = document.createElement("li");
      const speaking = room.voice.speaking(m.sub);
      li.className = ["voice-person", speaking && "speaking", m.muted && "muted"].filter(Boolean).join(" ");
      li.dataset.sub = m.sub;
      const me = m.sub === room.me;
      const name = me ? `${m.name} (you)` : m.name;
      li.title = `${name}${m.muted ? ", muted" : speaking ? ", speaking" : ""}`;
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.textContent = (m.name || "?").slice(0, 1).toUpperCase();
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = name;
      li.append(dot, who);
      if (m.muted) {
        const mic = document.createElement("span");
        mic.className = "mic";
        mic.textContent = "muted";
        li.append(mic);
      }
      list.append(li);
    }
    return list;
  };
  function render() {
    const c = room.client;
    const v = c.inVoice;
    const rows: HTMLElement[] = [];
    if (c.voiceOn) {
      const row = document.createElement("div");
      row.className = v ? "row in-voice" : "row";
      const what = document.createElement("span");
      what.className = "what";
      const n = room.voice.members.length;
      what.textContent = v ? (v.state === "joining" ? "Joining voice…" : v.state === "reconnecting" ? "Reconnecting…" : v.muted ? "Voice · you're muted" : "Voice · you're on") : n ? `Voice · ${n} in it` : "Voice · nobody yet";
      row.append(what, strip());
      if (!v) {
        const b = button("Join voice", join, "primary");
        b.title = "Drop into the room's voice channel. You join muted.";
        row.append(b);
      } else {
        if (v.state !== "joining") {
          const mute = button(v.muted ? "Unmute" : "Mute", () => void room.voice.setMuted(!v.muted), v.muted ? "primary" : "");
          mute.setAttribute("aria-pressed", String(v.muted));
          const video = button(v.video ? "Stop video" : "Start video", () => void room.voice.setVideo(!v.video), v.video ? "on" : "");
          video.title = "Video is your camera's real picture, for the people in voice";
          row.append(mute, video);
        }
        if (v.blocked) row.append(button("Play voice", () => void c.startAudio(), "primary"));
        row.append(button("Leave voice", () => room.voice.leave(), "danger"));
      }
      rows.push(row);
      for (const text of [v?.error || error, c.notice && Date.now() - c.notice.at < NOTICE_MS ? c.notice.text : ""]) {
        if (!text) continue;
        const note = document.createElement("span");
        note.className = text === c.notice?.text ? "notice" : "error";
        note.textContent = text;
        rows.push(note);
      }
    }
    bar.hidden = !rows.length;
    bar.replaceChildren(...rows);
  }
  const unsub = room.client.subscribe(render);
  render();
  return () => {
    unsub();
    bar.remove();
  };
}
