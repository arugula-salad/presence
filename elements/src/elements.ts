// The custom elements (../../sdk/API.md): <arugula-room> joins a room (a
// token from your endpoint; or a publishable key with the person's own
// sign-in token, or as a guest; or the relay's demo tokens to prototype),
// or draws from a Room your code connected (`el.room = r`), and
// re-dispatches its events; <arugula-camera>, <arugula-people>,
// <arugula-avatar>, <arugula-chat>, <arugula-call>, <arugula-voice> and
// <arugula-spotlight> inside it draw from it, each in a shadow root styled from --arugula-*
// custom properties.

import { connect, httpOrigin, RELAY, type ConnectOptions, type Room } from "./room.ts";
import { mountPeople, mountAvatar } from "./view.ts";
import { mountCall, mountCamera, mountVoice } from "./controls.ts";
import { mountChat } from "./chat.ts";
import { mountSpotlight } from "./spotlight.ts";
import { CSS } from "./styles.ts";

type Look = { character: number; colour: number };

export class ArugulaRoom extends HTMLElement {
  /** The room it draws from now: its own connection, or the one given. */
  private current: Room | null = null;
  /** A room from connect() handed to it (`el.room = r`): drawn from,
   * never left by this element (its owner leaves it). */
  private given: Room | null = null;
  private waiting: ((r: Room) => void)[] = [];
  private failed: Error | null = null;
  private joining = false;
  /** Each connection it starts; one that lands after another (or after a
   * room was given, or the element left the page) is left at once. */
  private attempt = 0;
  private unwire: (() => void)[] = [];
  /** The elements inside, told whenever the room changes (null: none). */
  private users = new Set<(r: Room | null) => void>();
  private authValue: ConnectOptions["auth"] | null = null;

  /** With `key`: the person's token from your auth provider, or a function
   * for a fresh one (called on every (re)connect). Set it before or after
   * the element is in the page; `<arugula-room key auth>` waits for it. */
  get auth() {
    return this.authValue;
  }
  set auth(v) {
    this.authValue = v;
    if (v && this.isConnected) this.connectedCallback();
  }

  /** The room it and everything inside draw from, once there is one.
   * Set it to a Room from connect() (before or after the element is in
   * the page) to draw from that one instead of connecting: the element
   * then ignores its connecting attributes, and taking it out of the page
   * doesn't leave the room (whoever connected it does). Setting it back
   * to null goes back to the attributes. */
  get room(): Room | null {
    return this.current;
  }
  set room(r: Room | null) {
    r = r ?? null;
    if (r === this.given) return;
    this.drop();
    this.given = r;
    if (this.isConnected) this.connectedCallback();
  }

  /** The room once joined. */
  whenReady(): Promise<Room> {
    if (this.current) return Promise.resolve(this.current);
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((ok) => this.waiting.push(ok));
  }

  /** Call `fn` with the room now (if there is one) and whenever it
   * changes (null: none any more); returns a function to stop. The
   * elements inside draw with it. */
  use(fn: (r: Room | null) => void): () => void {
    this.users.add(fn);
    if (this.current) fn(this.current);
    return () => void this.users.delete(fn);
  }

  connectedCallback() {
    // `el.auth = …` or `el.room = …` before this element was defined set a
    // plain property: through the setter instead.
    if (Object.prototype.hasOwnProperty.call(this, "auth")) {
      const v = (this as { auth?: ConnectOptions["auth"] }).auth;
      delete (this as { auth?: unknown }).auth;
      this.authValue = v ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(this, "room")) {
      const v = (this as { room?: Room | null }).room;
      delete (this as { room?: unknown }).room;
      this.given = v ?? null;
    }
    if (this.current || this.joining) return;
    if (this.given) return this.take(this.given);
    const room = this.getAttribute("room");
    if (!room) return console.error("<arugula-room> needs a room attribute (or a Room from connect() as its room property)");
    const relay = this.getAttribute("relay") || RELAY;
    const tokenUrl = this.getAttribute("token-url");
    const demo = this.hasAttribute("demo");
    const key = this.getAttribute("key");
    const auth = this.getAttribute("auth") || this.authValue;
    if (key && !auth && this.hasAttribute("auth")) return; // waits for el.auth
    if (!tokenUrl && !demo && !key) return console.error("<arugula-room> needs token-url, or key, or demo to prototype");
    const token = async () => {
      const r = demo
        ? await fetch(`${httpOrigin(relay)}/api/demo/token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ room, name: (this.getAttribute("name") || "Guest").slice(0, 80) }),
          })
        : await fetch(tokenUrl!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ room }), credentials: "include" });
      if (!r.ok) throw new Error(`the token endpoint said ${r.status}`);
      return ((await r.json()) as { token: string }).token;
    };
    const num = (a: string) => (this.hasAttribute(a) ? Number(this.getAttribute(a)) : undefined);
    const character = num("character"), colour = num("colour");
    const look: Look | undefined = character !== undefined || colour !== undefined ? { character: character ?? 2, colour: colour ?? 0 } : undefined;
    const mode = this.getAttribute("mode") === "outline" ? "outline" : "avatar";
    const name = this.getAttribute("name") || undefined;
    const how: Partial<ConnectOptions> = key ? (auth ? { key, auth, name } : { key, guest: (name || "Guest").slice(0, 80) }) : { token };
    this.joining = true;
    const attempt = ++this.attempt;
    void connect({ room, relay, mode, look, ...how })
      .then((r) => {
        if (attempt !== this.attempt) return r.leave();
        this.joining = false;
        this.take(r);
      })
      .catch((e: Error) => {
        if (attempt !== this.attempt) return;
        this.joining = false;
        this.failed = e;
        console.error(`<arugula-room>: ${e.message}`);
      });
  }

  disconnectedCallback() {
    this.drop();
  }

  /** Draw from `r`: its events as this element's, and the elements inside
   * on it. */
  private take(r: Room) {
    this.current = r;
    this.failed = null;
    const fire = (type: string, detail: unknown) => this.dispatchEvent(new CustomEvent(`arugula:${type}`, { detail, bubbles: true, composed: true }));
    this.unwire = [
      r.on("members", (members) => fire("members", { members })),
      r.on("wave", (from) => fire("wave", { from })),
      r.on("answer", (from, yes) => fire("answer", { from, yes })),
      r.on("react", (from, emoji) => fire("react", { from, emoji })),
      r.on("message", (message) => fire("message", { message })),
      r.on("ring", (from, id) => fire("ring", { from, id })),
      r.on("call", (call) => fire("call", { call })),
      r.on("voice", (members, joined) => fire("voice", { members, joined })),
      r.on("speaker", (active, pinned) => fire("speaker", { active, pinned })),
      r.on("noise", (noise) => fire("noise", { noise })),
      r.on("live", (state) => fire("live", { state })),
    ];
    fire("members", { members: r.members });
    for (const ok of this.waiting.splice(0)) ok(r);
    for (const fn of [...this.users]) fn(r);
  }

  /** Stop drawing from the room it has (leaving it only if it connected
   * it), and stop any connection still joining. */
  private drop() {
    this.attempt++;
    this.joining = false;
    for (const off of this.unwire.splice(0)) off();
    const was = this.current;
    this.current = null;
    if (!was) return;
    for (const fn of [...this.users]) fn(null);
    if (was !== this.given) was.leave();
  }
}

/** An element drawn from the nearest <arugula-room> around it, redrawn
 * whenever that room changes. */
abstract class InRoom extends HTMLElement {
  protected root: ShadowRoot;
  private stop: (() => void) | null = null;
  private detach: (() => void) | null = null;
  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    this.root.append(style);
  }

  protected abstract draw(room: Room): () => void;

  async connectedCallback() {
    await customElements.whenDefined("arugula-room");
    if (!this.isConnected) return;
    const host = this.closest("arugula-room") as ArugulaRoom | null;
    if (!host) return console.error(`<${this.localName}> goes inside an <arugula-room>`);
    this.detach?.();
    this.detach = host.use((room) => this.redraw(room));
  }

  /** Drawn afresh from `room` (an attribute changed, or the room did). */
  protected redraw(room: Room | null) {
    this.stop?.();
    this.stop = room && this.isConnected ? this.draw(room) : null;
  }

  disconnectedCallback() {
    this.detach?.();
    this.detach = null;
    this.stop?.();
    this.stop = null;
  }
}

export class ArugulaPeople extends InRoom {
  protected draw(room: Room) {
    return mountPeople(room, this.root, {
      size: this.getAttribute("size") === "head" ? "head" : "bust",
      self: this.getAttribute("self") === "hide" ? "hide" : "first",
      calls: this.getAttribute("calls") !== "off",
    });
  }
}

export class ArugulaCamera extends InRoom {
  protected draw(room: Room) {
    return mountCamera(room, this.root, { controls: this.getAttribute("controls") === "button" ? "button" : "full" });
  }
}

export class ArugulaAvatar extends InRoom {
  static observedAttributes = ["user", "size", "draw"];
  protected draw(room: Room) {
    return mountAvatar(room, this.root, this.getAttribute("user") ?? "", {
      size: this.getAttribute("size") === "bust" ? "bust" : "head",
      draw: this.getAttribute("draw") === "character" ? "character" : "live",
    });
  }
  attributeChangedCallback() {
    if (this.isConnected) void this.connectedCallback();
  }
}

export class ArugulaChat extends InRoom {
  protected draw(room: Room) {
    return mountChat(room, this.root, { placeholder: this.getAttribute("placeholder") ?? undefined });
  }
}

/** A call's bar: a ring to answer, who you're calling, mute and leave. */
export class ArugulaCall extends InRoom {
  protected draw(room: Room) {
    return mountCall(room, this.root);
  }
}

/** The room's voice channel: who's in it, join, mute, video and leave. */
export class ArugulaVoice extends InRoom {
  protected draw(room: Room) {
    return mountVoice(room, this.root);
  }
}

/** Speaker view: whoever's talking big, everyone else in the call or
 * voice in a strip; click someone to pin them. */
export class ArugulaSpotlight extends InRoom {
  protected draw(room: Room) {
    return mountSpotlight(room, this.root, { self: this.getAttribute("self") === "hide" ? "hide" : "show", pin: this.getAttribute("pin") !== "off" });
  }
}

/** Define the elements (once; safe to call again). */
export function defineElements() {
  if (typeof customElements === "undefined") return;
  const all: [string, CustomElementConstructor][] = [
    ["arugula-room", ArugulaRoom],
    ["arugula-people", ArugulaPeople],
    ["arugula-camera", ArugulaCamera],
    ["arugula-avatar", ArugulaAvatar],
    ["arugula-chat", ArugulaChat],
    ["arugula-call", ArugulaCall],
    ["arugula-voice", ArugulaVoice],
    ["arugula-spotlight", ArugulaSpotlight],
  ];
  for (const [name, el] of all) if (!customElements.get(name)) customElements.define(name, el);
}
