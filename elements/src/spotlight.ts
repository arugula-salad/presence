// Speaker view (Arugula #332): in a call or the room's voice, whoever's
// talking big (their video while it's on, otherwise their live character
// or outline, drawn big), with their name and whether they're muted or
// speaking, and a strip of everyone else in it. The big one is the
// current speaker, held steady by the client (a newcomer takes over after
// 0.7 s of talking; a cough doesn't), or whoever you pinned:
// click someone to pin them big, click them again to go back to following
// whoever's talking. A pin is this page's alone. Empty outside a call or
// voice.
//
// The big tile's <video> is big, so adaptive stream asks for the speaker's
// 720p layer; the strip's are small and get 180p. Nobody else's big tile,
// nobody's 720p.

import type { CallPerson, Member } from "@arugula/presence";
import type { Room } from "./room.ts";
import { Face, float } from "./view.ts";

export interface SpotlightOptions {
  /** You in the strip (default), or not. */
  self?: "show" | "hide";
  /** Click someone to pin them big, and again to unpin (default true). */
  pin?: boolean;
}

/** A member to draw for someone in the call (presence's, where it has them). */
function memberOf(room: Room, p: CallPerson): Member {
  return room.client.members.find((m) => m.sub === p.sub) ?? { sub: p.sub, name: p.name, look: null, mode: "none", away: false, watching: true, call: null, voice: false, muted: p.muted };
}

interface Spot {
  fig: HTMLElement;
  face: Face;
  name: HTMLElement;
  tag: HTMLElement;
  reacts: HTMLElement;
  shown: Set<number>;
  /** Whose face it has now (the big one changes hands). */
  sub: string;
}

function spot(cls: string, size: "bust" | "head", part: string): Spot {
  const fig = document.createElement("figure");
  fig.className = `tile ${cls}`;
  fig.setAttribute("part", part);
  const view = document.createElement("div");
  view.className = "view";
  const reacts = document.createElement("div");
  reacts.className = "reacts";
  view.append(reacts);
  const cap = document.createElement("figcaption");
  const name = document.createElement("span");
  name.className = "name";
  const tag = document.createElement("span");
  tag.className = "tag";
  cap.append(name, tag);
  fig.append(view, cap);
  return { fig, face: new Face(view, size), name, tag, reacts, shown: new Set(), sub: "" };
}

export function mountSpotlight(room: Room, el: Element | ShadowRoot, o: SpotlightOptions = {}): () => void {
  const pinning = o.pin !== false;
  const wrap = document.createElement("div");
  wrap.className = "arugula-spotlight";
  wrap.setAttribute("part", "spotlight");
  const big = spot("spot-big", "bust", "featured");
  const strip = document.createElement("div");
  strip.className = "spot-strip";
  strip.setAttribute("part", "strip");
  strip.setAttribute("role", "list");
  strip.setAttribute("aria-label", "Everyone else in it");
  wrap.append(big.fig, strip);
  el.append(wrap);
  const tiles = new Map<string, Spot>();
  const toggle = (sub: string) => {
    if (!pinning || !sub) return;
    room.client.pin(room.client.pinned === sub ? null : sub);
  };
  const clickable = (s: Spot) => {
    if (!pinning) return;
    s.fig.tabIndex = 0;
    s.fig.setAttribute("role", "button");
    s.fig.addEventListener("click", () => toggle(s.sub));
    s.fig.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle(s.sub);
      }
    });
  };
  clickable(big);
  // Name, muted, speaking and pinned onto a tile, and its face.
  const fill = (s: Spot, p: CallPerson, m: Member) => {
    const me = p.sub === room.me;
    const pinned = room.client.pinned === p.sub;
    s.name.textContent = me ? `${p.name} (you)` : p.name;
    s.tag.textContent = p.muted ? "muted" : p.speaking ? "speaking" : "";
    s.fig.dataset.sub = p.sub;
    s.fig.classList.toggle("speaking", p.speaking);
    s.fig.classList.toggle("muted", p.muted);
    s.fig.classList.toggle("pinned", pinned);
    if (pinning) {
      s.fig.setAttribute("aria-pressed", String(pinned));
      s.fig.title = pinned ? `Unpin ${p.name}: back to whoever's talking` : `Pin ${p.name} big`;
    }
    s.face.update(room, m);
    s.fig.classList.toggle("video", s.face.video);
    float(room, p.sub, s.reacts, s.shown);
  };
  const render = () => {
    const c = room.client;
    const people = c.roster;
    const featured = c.featured(room.me);
    wrap.hidden = !featured;
    if (!featured) {
      big.face.clear();
      big.sub = "";
      for (const t of tiles.values()) {
        t.face.clear();
        t.fig.remove();
      }
      tiles.clear();
      return;
    }
    const top = people.find((p) => p.sub === featured)!;
    if (big.sub !== featured) {
      // Someone else's face now: their video (attached afresh) or character.
      big.face.clear();
      big.shown.clear();
      big.sub = featured;
    }
    big.fig.dataset.why = c.pinned === featured ? "pinned" : c.activeSpeaker === featured ? "speaker" : "first";
    fill(big, top, memberOf(room, top));
    if (c.pinned === featured) big.tag.textContent = top.muted ? "pinned · muted" : top.speaking ? "pinned · speaking" : "pinned";
    const rest = people.filter((p) => p.sub !== featured && (o.self !== "hide" || p.sub !== room.me));
    const keep = new Set(rest.map((p) => p.sub));
    for (const [sub, t] of tiles) {
      if (!keep.has(sub)) {
        t.face.clear();
        t.fig.remove();
        tiles.delete(sub);
      }
    }
    rest.forEach((p, i) => {
      let t = tiles.get(p.sub);
      if (!t) {
        t = spot("spot-small", "head", "tile");
        t.sub = p.sub;
        t.fig.setAttribute("role", pinning ? "button" : "listitem");
        clickable(t);
        tiles.set(p.sub, t);
      }
      if (strip.children[i] !== t.fig) strip.insertBefore(t.fig, strip.children[i] ?? null);
      fill(t, p, memberOf(room, p));
    });
    strip.hidden = !rest.length;
  };
  const unsub = room.client.subscribe(render);
  render();
  return () => {
    unsub();
    big.face.clear();
    for (const t of tiles.values()) t.face.clear();
    wrap.remove();
  };
}
