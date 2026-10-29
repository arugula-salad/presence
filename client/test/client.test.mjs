// The presence client over a fake transport: hearing runs while a view
// watches, rigs and outlines land where views read them (a rig tells
// listeners only when someone starts or changes look), `off` forgets, and
// the Phoenix transport's pieces (a relayed frame's sender, a member from
// their metas) read what the relay sends. Run with `node
// --experimental-strip-types`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PresenceClient, guestId, memberOf, socketParams, unprefix } from "../src/index.ts";
import { neutral, packRig } from "@arugula/presence-core/avatar/rig";
import { encodeFrame } from "@arugula/presence-core/outline/frame";

function fake() {
  const t = { on: null, listening: false, published: [], offs: 0, states: [] };
  t.transport = {
    listen(on) {
      t.on = on;
      t.listening = true;
      on.live("on");
    },
    unlisten() {
      t.listening = false;
    },
    publish(b) {
      t.published.push(b);
    },
    off() {
      t.offs++;
    },
    state(s) {
      t.states.push(s);
    },
  };
  return t;
}

const rigBytes = (look) => {
  const b = packRig(Object.assign(neutral(), { face: true, smile: 0.5 }), look);
  const wire = new Uint8Array(b.length + 1);
  wire.set(b, 1);
  return wire;
};

test("hearing runs while a view watches, and stops with the last", () => {
  const t = fake();
  const c = new PresenceClient({ transport: t.transport, storage: "test." });
  const a = c.watch();
  const b = c.watch();
  assert.equal(t.listening, true);
  assert.equal(c.live, "on");
  a();
  assert.equal(t.listening, true, "one view still watches");
  b();
  assert.equal(t.listening, false);
  assert.equal(c.live, "off");
});

test("a rig lands with its look; listeners hear of someone new or a new look, not every frame", async () => {
  const t = fake();
  const c = new PresenceClient({ transport: t.transport, storage: "test." });
  let told = 0;
  c.subscribe(() => told++);
  const stop = c.watch();
  told = 0;
  t.on.frame("sam", rigBytes({ character: 3, colour: 1 }));
  await Promise.resolve();
  assert.equal(c.of("sam")?.rig?.smile > 0.4, true);
  assert.deepEqual(c.lookOf("sam"), { character: 3, colour: 1 });
  assert.equal(told, 1);
  t.on.frame("sam", rigBytes({ character: 3, colour: 1 }));
  t.on.frame("sam", rigBytes({ character: 3, colour: 1 }));
  assert.equal(told, 1, "the same look again: no news");
  t.on.frame("sam", rigBytes({ character: 1, colour: 1 }));
  assert.equal(told, 2, "a new look: news");
  t.on.off("sam");
  assert.equal(c.of("sam"), null);
  assert.deepEqual(c.lookOf("sam"), { character: 1, colour: 1 }, "the look stays, for idling");
  stop();
});

test("an outline frame lands decoded, and an unreadable frame is skipped", async () => {
  const t = fake();
  const c = new PresenceClient({ transport: t.transport, storage: "test." });
  const stop = c.watch();
  t.on.frame("riley", await encodeFrame({ w: 8, h: 8, lines: [[0, 0, 7, 7]] }));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(c.of("riley")?.frame?.lines, [[0, 0, 7, 7]]);
  t.on.frame("riley", Uint8Array.from([0, 99, 1, 2]));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(c.of("riley")?.frame?.lines, [[0, 0, 7, 7]], "kept the last good one");
  stop();
});

test("waves are kept until answered, and the look goes to the transport", () => {
  const t = fake();
  const c = new PresenceClient({ transport: t.transport, storage: "test." });
  const stop = c.watch();
  t.on.wave("sam");
  assert.deepEqual(c.waves.map((k) => k.from), ["sam"]);
  c.answer("sam", true);
  assert.deepEqual(c.waves, []);
  c.setLook({ character: 1, colour: 4 });
  assert.deepEqual(t.states.at(-1), { look: { character: 1, colour: 4 } });
  stop();
});

test("the relay's frames say who sent them; a member is on camera if any page is", () => {
  const sub = new TextEncoder().encode("jake@x");
  const b = new Uint8Array(1 + sub.length + 3);
  b[0] = sub.length;
  b.set(sub, 1);
  b.set([0, 0x40, 1], 1 + sub.length);
  const { sub: who, frame } = unprefix(b);
  assert.equal(who, "jake@x");
  assert.deepEqual([...frame], [0, 0x40, 1]);
  assert.throws(() => unprefix(Uint8Array.from([9, 1])), /cut short/);
  const m = memberOf("jake", [
    { name: "Jake", mode: "none", away: true, watching: false },
    { name: "Jake", mode: "avatar", look: { character: 2, colour: 0 }, away: false, watching: true },
  ]);
  assert.deepEqual(m, { sub: "jake", name: "Jake", look: { character: 2, colour: 0 }, mode: "avatar", away: false, watching: true, call: null, voice: false, muted: false });
});

test("the socket's params: a room token, or a publishable key with the room and a guest's name", () => {
  const url = "wss://arugula.stream/socket";
  assert.deepEqual(socketParams({ url, room: "lobby", token: () => Promise.resolve("t") }, "t1"), { token: "t1" });
  assert.deepEqual(socketParams({ url, room: "lobby", key: "pk_live_abc", guest: "Ada" }, ""), { key: "pk_live_abc", room: "lobby", name: "Ada" });
  assert.deepEqual(socketParams({ url, room: "lobby", key: "pk_test_abc", guest: "Ada", look: { character: 2, colour: 3 } }, ""), {
    key: "pk_test_abc",
    room: "lobby",
    name: "Ada",
    look: "2:3",
  });
});

test("a guest's gid goes in the socket's params, a member's never; guestId is kept", () => {
  const url = "wss://arugula.stream/socket";
  assert.deepEqual(socketParams({ url, room: "lobby", key: "pk_live_abc", guest: "Ada", gid: "abcdefgh1234" }, ""), {
    key: "pk_live_abc",
    room: "lobby",
    name: "Ada",
    gid: "abcdefgh1234",
  });
  assert.equal(socketParams({ url, room: "lobby", key: "pk_live_abc", auth: "t", gid: "abcdefgh1234" }, "t").gid, undefined);
  // In localStorage where there is one; for the page where there isn't.
  const id = guestId();
  assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(guestId(), id);
});

test("the socket's params for a member: the key, the room and their provider token (and a fallback name)", () => {
  const url = "wss://x/socket";
  assert.deepEqual(socketParams({ url, room: "acme:standup", key: "pk_live_abc", auth: "eyJ.a.b" }, "eyJ.a.b"), { key: "pk_live_abc", room: "acme:standup", auth: "eyJ.a.b" });
  assert.deepEqual(socketParams({ url, room: "lobby", key: "pk_live_abc", auth: () => Promise.resolve("t"), name: "Ada", look: { character: 1, colour: 0 } }, "t2"), {
    key: "pk_live_abc",
    room: "lobby",
    auth: "t2",
    name: "Ada",
    look: "1:0",
  });
});

test("messages: history and said merge by id in order, say adds yours, loadEarlier pages back", async () => {
  const t = fake();
  const kept = [];
  let next = 100;
  t.transport.say = async (text) => {
    if (text.length > 5) throw new Error("too long");
    const m = { id: next++, sub: "me", name: "Me", text, at: 1 };
    kept.push(m);
    return m;
  };
  t.transport.history = async (before) => Array.from({ length: 3 }, (_, i) => ({ id: before - 3 + i, sub: "x", name: "X", text: `old${i}`, at: 0 }));
  const c = new PresenceClient({ transport: t.transport, storage: "t5." });
  const stop = c.watch();
  const page = Array.from({ length: 50 }, (_, i) => ({ id: 40 + i, sub: "x", name: "X", text: `m${i}`, at: 0 }));
  t.on.history(page);
  t.on.said({ id: 95, sub: "y", name: "Y", text: "hey", at: 0 });
  t.on.history(page); // a reconnect: no duplicates
  assert.equal(c.messages.length, 51);
  assert.deepEqual(c.messages.at(-1).text, "hey");
  const mine = await c.say("hi");
  assert.equal(c.messages.at(-1).id, mine.id);
  await assert.rejects(c.say("way too long"), /too long/);
  assert.equal(c.hasEarlier, true);
  await c.loadEarlier();
  assert.deepEqual(c.messages.slice(0, 3).map((m) => m.text), ["old0", "old1", "old2"]);
  assert.equal(c.hasEarlier, false, "a short page means that's all");
  stop();
});

test("calls: a ring, its answer, the LiveKit room joined, muting, and leaving", async () => {
  const t = fake();
  const sent = [];
  t.transport.call = async (to) => (sent.push(["call", to]), { id: "c1" });
  t.transport.callAnswer = async (id, yes) => void sent.push(["answer", id, yes]);
  t.transport.callLeave = (id) => sent.push(["leave", id]);
  const lk = { joins: [], muted: [], left: 0 };
  const joinCall = async (j, on) => {
    lk.joins.push(j);
    lk.on = on;
    return { setMuted: async (m) => void lk.muted.push(m), startAudio: async () => {}, leave: async () => void lk.left++ };
  };
  const c = new PresenceClient({ transport: t.transport, storage: "t6.", joinCall });
  const stop = c.watch();
  assert.equal(c.callsOn, false, "off until the relay says");
  t.on.calls(true);
  assert.equal(c.callsOn, true);

  // Ringing someone: your avatar waves, the call is ringing them.
  assert.equal(await c.call("bob"), "c1");
  assert.equal(c.waving("me", true), true);
  assert.deepEqual([c.inCall.state, c.inCall.ringing], ["ringing", ["bob"]]);
  t.on.callAnswer("c1", "bob", true);
  assert.deepEqual(c.inCall.ringing, []);
  assert.deepEqual(c.answers.map((a) => [a.from, a.yes]), [["bob", true]]);
  t.on.callJoin({ id: "c1", url: "ws://lk", room: "acme:r:c1", token: "tok" });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(lk.joins[0].token, "tok");
  lk.on.state("on");
  lk.on.people([{ sub: "me", name: "Me", muted: false, speaking: false, audio: true }, { sub: "bob", name: "Bob", muted: false, speaking: true, audio: true }]);
  assert.equal(c.inCall.state, "on");
  assert.deepEqual(c.inCall.people.map((p) => p.sub), ["me", "bob"]);
  t.on.members([{ sub: "bob", name: "Bob", look: null, mode: "none", away: false, watching: true, call: "c1" }]);
  assert.equal(c.inMyCall("bob"), true);
  await c.setMuted(true);
  assert.deepEqual([c.inCall.muted, lk.muted], [true, [true]]);
  // Bob leaves LiveKit: alone, this page leaves too.
  lk.on.people([{ sub: "me", name: "Me", muted: true, speaking: false, audio: true }]);
  assert.equal(c.inCall, null);
  assert.deepEqual(sent.at(-1), ["leave", "c1"]);
  assert.equal(lk.left, 1);
  stop();
});

test("calls: being rung waves their avatar; a ring that's over goes; a no ends a ringing call", async () => {
  const t = fake();
  t.transport.call = async () => ({ id: "c2" });
  t.transport.callAnswer = async () => {};
  t.transport.callLeave = () => {};
  const c = new PresenceClient({ transport: t.transport, storage: "t7.", joinCall: async () => ({}) });
  const stop = c.watch();
  t.on.call("sam", "c9");
  assert.deepEqual(c.rings.map((r) => [r.from, r.id]), [["sam", "c9"]]);
  assert.equal(c.waving("sam"), true);
  t.on.callCancel("c9");
  assert.deepEqual(c.rings, []);
  t.on.call("sam", "c10");
  await c.answerCall("c10", false);
  assert.deepEqual(c.rings, []);
  await c.call("sam");
  t.on.callAnswer("c2", "sam", false, "no answer");
  assert.equal(c.inCall, null);
  assert.deepEqual(c.answers.at(-1).yes, false);
  stop();
});

test("a member's call comes from their metas", () => {
  assert.equal(memberOf("a", [{ name: "A", call: null }, { name: "A", call: "c1" }]).call, "c1");
  assert.equal(memberOf("a", [{ name: "A" }]).call, null);
});

test("video in a call: off until turned on, from the camera's own track; a tile shows it while they're on; the camera off takes it down", async () => {
  const t = fake();
  t.transport.call = async () => ({ id: "v1" });
  t.transport.callAnswer = async () => {};
  t.transport.callLeave = () => {};
  const lk = { video: [], attached: [] };
  const joinCall = async (j, on) => {
    lk.on = on;
    return {
      setMuted: async () => {},
      setVideo: async (track) => void lk.video.push(track),
      attach: (sub, el) => (lk.attached.push([sub, el]), () => lk.attached.push(["gone", sub])),
      startAudio: async () => {},
      leave: async () => {},
    };
  };
  const c = new PresenceClient({ transport: t.transport, storage: "t8.", joinCall });
  const stop = c.watch();
  t.on.calls(true);
  await c.call("bob");
  await c.setVideo(true);
  assert.equal(c.inCall.video, false, "not while it's only ringing");
  t.on.callAnswer("v1", "bob", true);
  t.on.callJoin({ id: "v1", url: "ws://lk", room: "acme:r:v1", token: "tok" });
  await new Promise((r) => setTimeout(r, 0));
  lk.on.state("on");
  assert.equal(c.inCall.video, false, "off until you turn it on");
  assert.deepEqual(lk.video, []);

  // The presence camera's on: the call's video is its track (one device).
  const track = { readyState: "live", id: "cam" };
  let stopped = 0;
  // stopCamera forgets its pagehide listener: Node has no window.
  globalThis.removeEventListener ??= () => {};
  c.camera = { stream: { getVideoTracks: () => [track] }, stop: () => stopped++ };
  await c.setVideo(true);
  assert.equal(c.inCall.video, true);
  assert.deepEqual(lk.video, [track]);
  await c.setVideo(true);
  assert.equal(lk.video.length, 1, "already on: nothing new");

  // Bob's video reaches this page: his tile shows it, and a view attaches.
  lk.on.people([
    { sub: "me", name: "Me", muted: false, speaking: false, audio: true, video: true },
    { sub: "bob", name: "Bob", muted: false, speaking: false, audio: true, video: true },
  ]);
  assert.equal(c.videoOf("bob"), true);
  assert.equal(c.videoOf("sam"), false, "not in the call");
  const el = {};
  const detach = c.attachVideo("bob", el);
  assert.deepEqual(lk.attached, [["bob", el]]);
  detach();
  assert.deepEqual(lk.attached.at(-1), ["gone", "bob"]);
  lk.on.people([
    { sub: "me", name: "Me", muted: false, speaking: false, audio: true, video: true },
    { sub: "bob", name: "Bob", muted: false, speaking: false, audio: true, video: false },
  ]);
  assert.equal(c.videoOf("bob"), false, "his video off: his character again");

  // Video off, then back on, then the camera off takes it down.
  await c.setVideo(false);
  assert.deepEqual([c.inCall.video, lk.video.at(-1), stopped], [false, null, 0], "the camera stays on: you turned it on");
  await c.setVideo(true);
  assert.equal(lk.video.at(-1), track);
  c.stopCamera();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([c.inCall.video, lk.video.at(-1), stopped], [false, null, 1]);

  // No camera to be had (no browser here): the video says why, and stays off.
  await c.setVideo(true);
  assert.equal(c.inCall.video, false);
  assert.match(c.inCall.error, /camera/i);
  stop();
});

test("voice: in a member's metas, muted as their voice page says", () => {
  const m = memberOf("a", [{ name: "A", voice: false }, { name: "A", voice: true, muted: true }]);
  assert.deepEqual([m.voice, m.muted], [true, true]);
  assert.deepEqual([memberOf("a", [{ name: "A" }]).voice, memberOf("a", [{ name: "A" }]).muted], [false, false]);
});

test("voice: joined muted, LiveKit with the microphone muted, unmuting tells the relay, and leaving", async () => {
  const t = fake();
  const sent = [];
  t.transport.voiceJoin = async () => (sent.push(["join"]), { url: "ws://lk", room: "acme:r:voice", token: "vtok" });
  t.transport.voiceLeave = () => sent.push(["leave"]);
  t.transport.voiceMute = (m) => sent.push(["mute", m]);
  const lk = { joins: [], muted: [], left: 0 };
  const joinCall = async (j, on, o) => {
    lk.joins.push({ j, o });
    lk.on = on;
    return { setMuted: async (m) => void lk.muted.push(m), setVideo: async () => {}, startAudio: async () => {}, leave: async () => void lk.left++ };
  };
  const c = new PresenceClient({ transport: t.transport, storage: "tv1.", joinCall });
  const stop = c.watch();
  assert.equal(c.voiceOn, false, "off until the relay says");
  t.on.voice(true);
  assert.equal(c.voiceOn, true);

  await c.joinVoice();
  assert.deepEqual(lk.joins[0].o, { muted: true, noise: "krisp" }, "the microphone goes up muted, Krisp by default");
  assert.equal(lk.joins[0].j.room, "acme:r:voice");
  assert.equal(c.inVoice.muted, true);
  lk.on.state("on");
  lk.on.people([{ sub: "me", name: "Me", muted: true, speaking: false, audio: true, video: false }, { sub: "bob", name: "Bob", muted: false, speaking: true, audio: true, video: false }]);
  assert.equal(c.inVoice.state, "on");
  assert.equal(c.speakingInVoice("bob"), true);
  assert.equal(c.speakingInVoice("me"), false);

  // Who's in voice is presence's: everyone sees it.
  t.on.members([
    { sub: "me", name: "Me", look: null, mode: "none", away: false, watching: true, call: null, voice: true, muted: true },
    { sub: "bob", name: "Bob", look: null, mode: "none", away: false, watching: true, call: null, voice: true, muted: false },
    { sub: "cy", name: "Cy", look: null, mode: "none", away: false, watching: true, call: null, voice: false, muted: false },
  ]);
  assert.deepEqual(c.voiceMembers.map((m) => m.sub), ["me", "bob"]);

  await c.setVoiceMuted(false);
  assert.deepEqual([c.inVoice.muted, lk.muted, sent.at(-1)], [false, [false], ["mute", false]]);
  // Bob leaving LiveKit doesn't end voice: it's the room's, not a call.
  lk.on.people([{ sub: "me", name: "Me", muted: false, speaking: false, audio: true, video: false }]);
  assert.notEqual(c.inVoice, null);

  c.leaveVoice();
  assert.equal(c.inVoice, null);
  assert.deepEqual(sent.at(-1), ["leave"]);
  assert.equal(lk.left, 1);
  stop();
});

test("voice: a refusal (voice is full) leaves you out", async () => {
  const t = fake();
  t.transport.voiceJoin = async () => {
    throw new Error("voice is full");
  };
  const c = new PresenceClient({ transport: t.transport, storage: "tv2.", joinCall: async () => ({}) });
  const stop = c.watch();
  await assert.rejects(c.joinVoice(), /voice is full/);
  assert.equal(c.inVoice, null);
  stop();
});

test("voice: one audio session a page; taking a call leaves voice, joining voice leaves the call, each with a notice", async () => {
  const t = fake();
  const sent = [];
  t.transport.voiceJoin = async () => ({ url: "ws://lk", room: "acme:r:voice", token: "vtok" });
  t.transport.voiceLeave = () => sent.push(["voice_leave"]);
  t.transport.voiceMute = () => {};
  t.transport.call = async () => ({ id: "c1" });
  t.transport.callAnswer = async (id, yes) => void sent.push(["answer", id, yes]);
  t.transport.callLeave = (id) => sent.push(["call_leave", id]);
  let left = 0;
  const joinCall = async () => ({ setMuted: async () => {}, setVideo: async () => {}, startAudio: async () => {}, leave: async () => void left++ });
  const c = new PresenceClient({ transport: t.transport, storage: "tv3.", joinCall });
  const stop = c.watch();
  t.on.calls(true);
  t.on.voice(true);

  await c.joinVoice();
  t.on.call("bob", "c9");
  await c.answerCall("c9", true);
  assert.equal(c.inVoice, null, "out of voice for the call");
  assert.deepEqual(sent.slice(-2), [["voice_leave"], ["answer", "c9", true]], "voice left before answering");
  assert.match(c.notice.text, /left voice/);
  t.on.callJoin({ id: "c9", url: "ws://lk", room: "acme:r:c9", token: "tok" });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(c.inCall.id, "c9");

  await c.joinVoice();
  assert.equal(c.inCall, null, "out of the call for voice");
  assert.deepEqual(sent.at(-1), ["call_leave", "c9"]);
  assert.match(c.notice.text, /left the call/);
  assert.equal(c.inVoice.state, "joining");

  // The relay takes this page out (it rang someone who said yes).
  t.on.voiceLeft("call");
  assert.equal(c.inVoice, null);
  assert.match(c.notice.text, /left voice for the call/);
  c.dismissNotice();
  assert.equal(c.notice, null);
  assert.ok(left >= 2);
  stop();
});

test("speaker view: the current speaker from LiveKit's side, a pin on this page, and who's featured", async () => {
  const t = fake();
  t.transport.voiceJoin = async () => ({ url: "ws://lk", room: "acme:r:voice", token: "vtok" });
  t.transport.voiceLeave = () => {};
  t.transport.voiceMute = () => {};
  const lk = {};
  const joinCall = async (j, on) => {
    lk.on = on;
    return { setMuted: async () => {}, setVideo: async () => {}, startAudio: async () => {}, leave: async () => {} };
  };
  const c = new PresenceClient({ transport: t.transport, storage: "tsp.", joinCall });
  const stop = c.watch();
  t.on.voice(true);
  assert.equal(c.featured(), null, "outside voice, nobody");
  await c.joinVoice();
  const p = (sub) => ({ sub, name: sub, muted: false, speaking: false, audio: true, video: false });
  lk.on.people([p("me"), p("ada"), p("bea")]);
  assert.equal(c.inVoice.activeSpeaker, null);
  assert.equal(c.featured("me"), "ada", "nobody's spoken: the first other person");
  lk.on.speaker("bea");
  assert.equal(c.activeSpeaker, "bea");
  assert.equal(c.featured("me"), "bea");
  c.pin("ada");
  assert.equal(c.pinned, "ada");
  assert.equal(c.featured("me"), "ada", "pinned beats the speaker");
  c.pin("nobody-here");
  assert.equal(c.pinned, null, "only someone in it can be pinned");
  c.pin("ada");
  lk.on.people([p("me"), p("bea")]);
  assert.equal(c.pinned, null, "Ada left: her pin goes");
  assert.equal(c.featured("me"), "bea");
  lk.on.people([p("me")]);
  lk.on.speaker("me");
  assert.equal(c.featured("me"), "me", "alone: you");
  c.leaveVoice();
  assert.equal(c.featured(), null);
  stop();
});
