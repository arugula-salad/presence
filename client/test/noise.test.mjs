// The microphone's noise filter (../src/noise.ts) over a fake LiveKit
// track and a fake Krisp: the constraints each mode opens the microphone
// with, Krisp on where it runs and Standard (saying why) where it doesn't
// load, isn't supported, LiveKit refuses it or stops it mid-call; switching
// in place, one change at a time; and the client's side: the default,
// what's kept in this browser, and what calls and voice are told. Run with
// `node --experimental-strip-types`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MicFilter, micConstraints, isNoiseFilter, noiseAfter } from "../src/noise.ts";
import { PresenceClient } from "../src/index.ts";

/** A LiveKit microphone track: its restarts (constraints) and processor. */
function fakeMic() {
  const m = { restarts: [], processor: null, stops: 0, log: [] };
  m.track = {
    restartTrack: async (c) => {
      m.restarts.push(c);
      m.log.push(`restart:${c.noiseSuppression ? "ns" : "raw"}`);
    },
    setProcessor: async (p) => {
      m.processor = p;
      m.log.push("processor");
    },
    stopProcessor: async () => {
      m.processor = null;
      m.stops++;
      m.log.push("stop");
    },
    getProcessor: () => m.processor,
  };
  return m;
}

/** Krisp's package: supported or not, and LiveKit enabling it or not. */
function fakeKrisp({ supported = true, enables = true, throws = null } = {}) {
  const k = { made: 0 };
  k.module = {
    isKrispNoiseFilterSupported: () => supported,
    KrispNoiseFilter: () => {
      k.made++;
      let on = false;
      return {
        setEnabled: async (want) => {
          if (throws) throw new Error(throws);
          on = want && enables;
          return on;
        },
        isEnabled: () => on,
      };
    },
  };
  return k;
}

function filter({ mic = fakeMic(), krisp = fakeKrisp(), load, running = () => true, want = "krisp", opened = "standard" } = {}) {
  const reports = [];
  const f = new MicFilter({ mic: () => mic?.track ?? null, load: load ?? (async () => krisp.module), running, report: (r) => reports.push(r), opened }, want);
  return { f, mic, krisp, reports, last: () => reports.at(-1) };
}

test("each mode's constraints: echo cancellation and gain control always; the browser's suppression for Standard alone", () => {
  assert.deepEqual(micConstraints("krisp"), { echoCancellation: true, autoGainControl: true, noiseSuppression: false, voiceIsolation: false });
  assert.deepEqual(micConstraints("standard"), { echoCancellation: true, autoGainControl: true, noiseSuppression: true, voiceIsolation: true });
  assert.deepEqual(micConstraints("off"), { echoCancellation: true, autoGainControl: true, noiseSuppression: false, voiceIsolation: false });
  assert.equal(isNoiseFilter("krisp"), true);
  assert.equal(isNoiseFilter("loud"), false);
  assert.equal(isNoiseFilter(null), false);
});

test("Krisp: the microphone reopens without the browser's suppression, then Krisp's processor goes on it and LiveKit enables it", async () => {
  const { f, mic, last } = filter();
  await f.refresh();
  assert.deepEqual(mic.log, ["restart:raw", "processor"]);
  assert.deepEqual(last(), { active: "krisp", krisp: true, error: "" });
  // Again (a reconnect, audio starting): nothing to do.
  await f.refresh();
  assert.deepEqual(mic.log, ["restart:raw", "processor"]);
});

test("opened for Krisp already: no reopening, just the processor", async () => {
  const { f, mic, last } = filter({ opened: "krisp" });
  await f.refresh();
  assert.deepEqual(mic.log, ["processor"]);
  assert.equal(last().active, "krisp");
});

test("switching krisp → standard → off → krisp, in place", async () => {
  const { f, mic, krisp, last } = filter();
  await f.refresh();
  await f.set("standard");
  assert.deepEqual(mic.log.slice(2), ["stop", "restart:ns"], "the processor off, then the browser's suppression on");
  assert.deepEqual(last(), { active: "standard", krisp: true, error: "" });
  await f.set("off");
  assert.deepEqual(mic.log.slice(4), ["restart:raw"]);
  assert.equal(mic.processor, null);
  assert.equal(last().active, "off");
  await f.set("krisp");
  assert.deepEqual(mic.log.slice(5), ["processor"], "already open without suppression: just the processor");
  assert.equal(last().active, "krisp");
  assert.equal(krisp.made, 2, "a fresh processor (a stopped one is disposed)");
  assert.ok(mic.restarts.every((c) => c.echoCancellation === true && c.autoGainControl === true), "echo cancellation on in every mode");
});

test("changes go one at a time, and the newest wins (no churn through the ones between)", async () => {
  const { f, mic, last } = filter({ want: "standard" });
  await Promise.all([f.set("off"), f.set("standard"), f.set("off")]);
  assert.deepEqual(mic.log, ["restart:raw"]);
  await Promise.all([f.set("standard"), f.set("krisp")]);
  assert.deepEqual(mic.log, ["restart:raw", "processor"], "Off to Krisp: the same microphone, just the processor");
  assert.equal(last().active, "krisp");
});

test("a browser Krisp doesn't run in: Standard, and why", async () => {
  const { f, mic, last } = filter({ krisp: fakeKrisp({ supported: false }) });
  await f.refresh();
  assert.deepEqual(mic.log, [], "opened for Standard already");
  assert.deepEqual(last(), { active: "standard", krisp: false, error: "this browser can't run it" });
});

test("Krisp's package not loading (the network): Standard, and why", async () => {
  const { f, last } = filter({ load: async () => Promise.reject(new Error("Failed to fetch dynamically imported module")) });
  await f.refresh();
  assert.deepEqual(last(), { active: "standard", krisp: null, error: "it didn't load (Failed to fetch dynamically imported module)" });
});

test("LiveKit refusing Krisp (its check fails): the processor comes off, the microphone reopens as Standard", async () => {
  const { f, mic, last } = filter({ krisp: fakeKrisp({ throws: "403 Forbidden" }) });
  await f.refresh();
  assert.deepEqual(mic.log, ["restart:raw", "processor", "stop", "restart:ns"]);
  assert.equal(mic.processor, null);
  assert.deepEqual(last(), { active: "standard", krisp: true, error: "LiveKit refused it: 403 Forbidden" });
});

test("LiveKit not enabling Krisp: Standard; it isn't tried again by itself, only when picked again", async () => {
  const krisp = fakeKrisp({ enables: false });
  const { f, mic, last } = filter({ krisp });
  await f.refresh();
  assert.deepEqual(last(), { active: "standard", krisp: true, error: "LiveKit didn't turn it on" });
  await f.refresh();
  assert.equal(krisp.made, 1, "a refresh (a reconnect) doesn't try again");
  await f.set("krisp");
  assert.equal(krisp.made, 2, "picking Krisp does");
  assert.equal(mic.processor, null);
});

test("LiveKit stopping Krisp mid-call: Standard, and why", async () => {
  const { f, mic, last } = filter();
  await f.refresh();
  f.lost("LiveKit stopped it");
  await f.refresh();
  assert.equal(mic.processor, null);
  assert.deepEqual(last(), { active: "standard", krisp: true, error: "LiveKit stopped it" });
});

test("Krisp waits for the page's audio to run (a suspended AudioContext sends silence): Standard until then", async () => {
  let running = false;
  const { f, mic, last } = filter({ running: () => running });
  await f.refresh();
  assert.deepEqual(mic.log, []);
  assert.equal(last().active, "standard");
  running = true;
  await f.refresh();
  assert.equal(last().active, "krisp");
});

test("no microphone (not allowed): nothing on it", async () => {
  const { f, last } = filter({ mic: null });
  await f.set("off");
  assert.deepEqual(last(), { active: null, krisp: null, error: "" });
});

test("the client's noise: Krisp by default, Standard where it doesn't run; a fallback only while Krisp is the mode", () => {
  const start = { mode: "krisp", active: null, krisp: null, fallback: "" };
  assert.deepEqual(noiseAfter(start, null, { active: "krisp", krisp: true, error: "" }), { mode: "krisp", active: "krisp", krisp: true, fallback: "" });
  assert.deepEqual(noiseAfter(start, null, { active: "standard", krisp: false, error: "this browser can't run it" }), { mode: "standard", active: "standard", krisp: false, fallback: "" }, "unsupported, nothing picked: the default is Standard");
  assert.deepEqual(noiseAfter(start, "krisp", { active: "standard", krisp: false, error: "this browser can't run it" }), { mode: "krisp", active: "standard", krisp: false, fallback: "this browser can't run it" }, "picked Krisp: Standard, saying why");
  assert.deepEqual(noiseAfter(start, null, { active: "standard", krisp: true, error: "LiveKit refused it: 403" }).fallback, "LiveKit refused it: 403");
  assert.deepEqual(noiseAfter(start, "off", { active: "off", krisp: null, error: "" }), { mode: "off", active: "off", krisp: null, fallback: "" });
});

/** localStorage, for the client to keep the choice in. */
function fakeStorage() {
  const m = new Map();
  globalThis.localStorage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  return m;
}

function fakeTransport() {
  const t = { on: null };
  t.transport = {
    listen(on) {
      t.on = on;
      on.live("on");
    },
    unlisten() {},
    publish() {},
    off() {},
    state() {},
    voiceJoin: async () => ({ url: "ws://lk", room: "acme:r:voice", token: "vtok" }),
    voiceLeave() {},
    voiceMute() {},
    voiceToken: async () => ({ url: "ws://lk", room: "acme:r:voice", token: "vtok2" }),
    call: async () => ({ id: "c1" }),
    callAnswer: async () => {},
    callLeave() {},
    callToken: async (id) => ({ id, url: "ws://lk", room: `acme:r:${id}`, token: "ctok2" }),
  };
  return t;
}

/** A LiveKit join that records what it was asked for and lets the test report. */
function fakeJoin() {
  const lk = { joins: [], set: [] };
  lk.joinCall = async (j, on, o) => {
    const call = { j, on, o, set: [] };
    lk.joins.push(call);
    return {
      setMuted: async () => {},
      setVideo: async () => {},
      setNoise: async (m) => void (call.set.push(m), lk.set.push(m)),
      startAudio: async () => {},
      leave: async () => {},
    };
  };
  return lk;
}

test("the client: the choice is kept in this browser and shared by calls and voice; switching in voice doesn't rejoin", async () => {
  const store = fakeStorage();
  const t = fakeTransport();
  const lk = fakeJoin();
  const c = new PresenceClient({ transport: t.transport, storage: "tn1.", joinCall: lk.joinCall });
  const stop = c.watch();
  t.on.voice(true);
  t.on.calls(true);
  assert.deepEqual(c.noise, { mode: "krisp", active: null, krisp: null, fallback: "" }, "Krisp by default");

  await c.joinVoice();
  assert.equal(lk.joins[0].o.noise, "krisp");
  lk.joins[0].on.noise({ active: "krisp", krisp: true, error: "" });
  assert.equal(c.noise.active, "krisp");

  // Muted (as voice joins), switched in place: the same LiveKit room.
  assert.equal(c.inVoice.muted, true);
  await c.setNoiseFilter("off");
  assert.deepEqual([lk.joins.length, lk.joins[0].set], [1, ["off"]], "switched without rejoining");
  assert.equal(store.get("tn1.noise"), JSON.stringify("off"));
  lk.joins[0].on.noise({ active: "off", krisp: true, error: "" });
  assert.deepEqual(c.noise, { mode: "off", active: "off", krisp: true, fallback: "" });
  await c.setVoiceMuted(false);
  assert.equal(c.noise.active, "off", "unmuting keeps it");

  // LiveKit drops voice: back in with the same filter.
  lk.joins[0].on.state("ended", false);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(lk.joins.length, 2);
  assert.equal(lk.joins[1].o.noise, "off", "the voice rejoin keeps it");

  c.leaveVoice();
  assert.equal(c.noise.active, null, "out of voice: nothing on a microphone");
  assert.equal(c.noise.mode, "off");

  // A call: the same choice, and a rejoin after a drop keeps it too.
  await c.call("bo");
  t.on.callJoin({ id: "c1", url: "ws://lk", room: "acme:r:c1", token: "tok" });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(lk.joins[2].o.noise, "off", "calls share it");
  lk.joins[2].on.state("ended", false);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(lk.joins[3].o.noise, "off", "the call's rejoin keeps it");
  c.leaveCall();

  // A reload: a new client in this browser.
  const again = new PresenceClient({ transport: fakeTransport().transport, storage: "tn1.", joinCall: lk.joinCall });
  assert.equal(again.noise.mode, "off", "kept across a reload");
  await assert.rejects(c.setNoiseFilter("loud"), /no noise filter/);
  stop();
});

test("the client: Krisp failing says so (and the choice stays Krisp); unsupported with nothing picked is Standard", async () => {
  fakeStorage();
  const t = fakeTransport();
  const lk = fakeJoin();
  const c = new PresenceClient({ transport: t.transport, storage: "tn2.", joinCall: lk.joinCall });
  const stop = c.watch();
  t.on.voice(true);
  await c.joinVoice();
  lk.joins[0].on.noise({ active: "standard", krisp: false, error: "this browser can't run it" });
  assert.deepEqual(c.noise, { mode: "standard", active: "standard", krisp: false, fallback: "" }, "nothing picked: the default is Standard here");
  await c.setNoiseFilter("krisp");
  lk.joins[0].on.noise({ active: "standard", krisp: true, error: "LiveKit refused it: 401 Unauthorized" });
  assert.deepEqual(c.noise, { mode: "krisp", active: "standard", krisp: true, fallback: "LiveKit refused it: 401 Unauthorized" });
  await c.setNoiseFilter("standard");
  assert.equal(c.noise.fallback, "", "another choice clears it");
  c.leaveVoice();
  stop();
});

test("the client: nothing kept, or something unreadable kept, is the default; storage that throws doesn't break it", () => {
  const store = fakeStorage();
  store.set("tn3.noise", JSON.stringify("loud"));
  assert.equal(new PresenceClient({ transport: fakeTransport().transport, storage: "tn3." }).noise.mode, "krisp");
  globalThis.localStorage = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
  };
  const c = new PresenceClient({ transport: fakeTransport().transport, storage: "tn4." });
  assert.equal(c.noise.mode, "krisp");
  return c.setNoiseFilter("standard").then(() => assert.equal(c.noise.mode, "standard", "this page still has it"));
});
