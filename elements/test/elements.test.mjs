// The elements in a DOM (happy-dom): <arugula-room> given a Room from
// connect() (`el.room = r`) draws from it, and so does everything inside,
// without connecting; taking it out of the page leaves the room open (its
// owner leaves it); and an avatar drawn as a character never draws an
// outline. Run with `node --experimental-strip-types`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { encodeFrame } from "@arugula/presence-core/outline/frame";

const window = new Window({ url: "https://app.example/" });
for (const k of ["HTMLElement", "customElements", "document", "CustomEvent", "Event", "Node", "ShadowRoot"]) globalThis[k] = window[k];
// The avatar's animation loop: never run here (no canvas to paint).
globalThis.requestAnimationFrame = () => 1;
// Nothing here may connect by itself.
const fetched = [];
globalThis.fetch = async (url) => {
  fetched.push(String(url));
  throw new Error("no network in tests");
};

const { Room } = await import("../src/room.ts");
const { what } = await import("../src/view.ts");
const { defineElements } = await import("../src/elements.ts");

const token = (claims) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");
const settle = () => new Promise((r) => setTimeout(r, 10));
const member = (sub, o = {}) => ({ sub, name: sub.toUpperCase(), look: null, mode: "none", away: false, watching: true, call: null, voice: false, muted: false, ...o });

function fake() {
  const t = { on: null, listening: 0, unlistened: 0 };
  t.transport = {
    listen(on) {
      t.on = on;
      t.listening++;
      on.live("on");
    },
    unlisten() {
      t.unlistened++;
    },
    publish() {},
    off() {},
    state() {},
  };
  return t;
}

// Every room made here, left at the end even if a test failed first (a
// room's sweep timer would keep the run going).
const made = [];
after(() => {
  for (const r of made) r.leave();
  void window.happyDOM.close();
});

function connected() {
  const t = fake();
  const room = new Room({ room: "team", token: token({ sub: "me" }), relay: "wss://relay.example/socket", transport: t.transport, storage: `t${Math.random()}.` });
  t.on.members([member("me"), member("bea"), member("cy")]);
  made.push(room);
  return { t, room };
}

/** The subs an element's shadow root draws (tiles, or an avatar). */
const drawn = (el) => [...el.shadowRoot.querySelectorAll("[data-sub]")].map((n) => n.dataset.sub);

// An element given its room before the elements were defined (a page whose
// script sets it before the SDK loads): defined below, it upgrades.
const early = document.createElement("arugula-room");
let earlyRoom;

test("defining the elements upgrades one whose room was set first", async () => {
  ({ room: earlyRoom } = connected());
  early.room = earlyRoom;
  early.innerHTML = `<arugula-avatar user="bea"></arugula-avatar>`;
  document.body.append(early);
  defineElements();
  await settle();
  assert.equal(early.room, earlyRoom);
  assert.deepEqual(drawn(early.querySelector("arugula-avatar")), ["bea"]);
  early.remove();
  earlyRoom.leave();
});

test("a Room from connect() set as el.room: it and everything inside draw from it, without connecting again", async () => {
  const { t, room } = connected();
  const el = document.createElement("arugula-room");
  el.room = room;
  el.innerHTML = `<arugula-people self="hide" size="head"></arugula-people><arugula-avatar user="cy" size="head"></arugula-avatar><arugula-call></arugula-call><arugula-voice></arugula-voice><arugula-spotlight></arugula-spotlight><arugula-camera controls="button"></arugula-camera>`;
  const events = [];
  el.addEventListener("arugula:members", (e) => events.push(e.detail.members.map((m) => m.sub)));
  document.body.append(el);
  await settle();
  assert.equal(el.room, room);
  assert.deepEqual(drawn(el.querySelector("arugula-people")), ["bea", "cy"]);
  assert.deepEqual(drawn(el.querySelector("arugula-avatar")), ["cy"]);
  assert.ok(el.querySelector("arugula-camera").shadowRoot.querySelector("button"), "the camera's button");
  // The room's changes reach the elements, and its events the element.
  t.on.members([member("me"), member("bea"), member("cy"), member("dee")]);
  await settle();
  assert.deepEqual(drawn(el.querySelector("arugula-people")), ["bea", "cy", "dee"]);
  assert.deepEqual(events.at(-1), ["me", "bea", "cy", "dee"]);
  assert.equal(t.listening, 1, "the room's one connection, nothing new");
  assert.deepEqual(fetched, [], "no token fetched: nothing connected");
  el.remove();
  room.leave();
});

test("taking the element out of the page leaves the room open; back in, it draws again", async () => {
  const { t, room } = connected();
  const el = document.createElement("arugula-room");
  el.innerHTML = `<arugula-people self="hide"></arugula-people>`;
  document.body.append(el);
  // Set after it's in the page (it had no attributes: nothing to connect).
  const quiet = console.error;
  console.error = () => {};
  await settle();
  console.error = quiet;
  el.room = room;
  await settle();
  assert.deepEqual(drawn(el.querySelector("arugula-people")), ["bea", "cy"]);
  const events = [];
  el.addEventListener("arugula:members", () => events.push("members"));

  el.remove();
  await settle();
  assert.equal(t.unlistened, 0, "the room still hears the relay");
  assert.equal(room.client.live, "on");
  assert.deepEqual(drawn(el.querySelector("arugula-people")), [], "the tiles go with the element");
  t.on.members([member("me"), member("bea")]);
  assert.deepEqual(events, [], "and so do its events");

  document.body.append(el);
  await settle();
  assert.deepEqual(drawn(el.querySelector("arugula-people")), ["bea"]);
  el.remove();
  // Its owner leaves it.
  room.leave();
  assert.equal(t.unlistened, 1);
});

test("a different room swaps everything inside to it; null goes back to the attributes", async () => {
  const a = connected();
  const b = connected();
  b.t.on.members([member("me"), member("zed")]);
  const el = document.createElement("arugula-room");
  el.room = a.room;
  el.innerHTML = `<arugula-people self="hide"></arugula-people>`;
  document.body.append(el);
  await settle();
  assert.deepEqual(drawn(el.querySelector("arugula-people")), ["bea", "cy"]);
  el.room = b.room;
  await settle();
  assert.deepEqual(drawn(el.querySelector("arugula-people")), ["zed"]);
  assert.equal(a.t.unlistened, 0, "the first room wasn't left either");
  const quiet = console.error;
  const said = [];
  console.error = (m) => said.push(m);
  el.room = null;
  console.error = quiet;
  assert.equal(el.room, null);
  assert.deepEqual(drawn(el.querySelector("arugula-people")), []);
  assert.match(said.join(" "), /needs a room attribute/, "no attributes: nothing to connect to");
  el.remove();
  a.room.leave();
  b.room.leave();
});

test("draw: character: never an outline or video, the character in their look; their initial with no look", async () => {
  const { t, room } = connected();
  const outline = await encodeFrame({ w: 8, h: 8, lines: [[0, 0, 7, 7]] });
  t.on.frame("bea", outline);
  t.on.frame("cy", outline);
  await settle();
  // Bea's in outline mode with a look in presence; Cy has no look at all.
  t.on.members([member("me"), member("bea", { mode: "outline", look: { character: 3, colour: 1 } }), member("cy", { mode: "outline" })]);
  const bea = room.members.find((m) => m.sub === "bea");
  const cy = room.members.find((m) => m.sub === "cy");
  assert.equal(what(room, bea).kind, "outline", "live: what they send");
  const w = what(room, bea, true);
  assert.equal(w.kind, "avatar");
  assert.equal(w.frame, null);
  assert.deepEqual(w.source().look, { character: 3, colour: 1 });
  assert.equal(w.source().rig, null, "idling: an outline carries no pose");
  assert.equal(what(room, cy, true).kind, "initial", "no look to draw: their initial");
  // You, in outline mode: your own character all the same.
  room.client.setMode("outline");
  assert.equal(what(room, member("me")).kind, "initial");
  assert.equal(what(room, member("me"), true).kind, "avatar");

  // And as drawn: an <arugula-avatar draw="character"> and room.avatar.
  const el = document.createElement("arugula-room");
  el.room = room;
  el.innerHTML = `<arugula-avatar user="cy" draw="character"></arugula-avatar>`;
  document.body.append(el);
  await settle();
  const face = el.querySelector("arugula-avatar").shadowRoot;
  assert.equal(face.querySelector(".initial")?.textContent, "C");
  const div = document.createElement("div");
  document.body.append(div);
  const stop = room.avatar(div, "bea", { size: "head", draw: "character" });
  const shown = div.firstElementChild.shadowRoot.querySelector(".arugula-avatar");
  assert.equal(shown.dataset.sub, "bea");
  assert.ok(shown.querySelector("canvas"), "a character's canvas");
  stop();
  el.remove();
  room.leave();
});

test("your own tile: this page's camera, else what another of your pages sends", async () => {
  const { t, room } = connected();
  room.client.setMode("outline");
  const me = member("me");
  assert.equal(what(room, me).kind, "initial", "camera off here, nothing from elsewhere");
  // Your phone sends an outline: the relay passes it to your other pages.
  t.on.frame("me", await encodeFrame({ w: 8, h: 8, lines: [[1, 1, 6, 6]] }));
  await settle();
  const w = what(room, me);
  assert.equal(w.kind, "outline");
  assert.deepEqual(w.frame.lines, [[1, 1, 6, 6]]);
  room.leave();
});
