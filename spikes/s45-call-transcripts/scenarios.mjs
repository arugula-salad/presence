// S45 spike: what the fake people do. Each is a function of the speakers'
// controller (speakers.mjs): join, say (returns when the utterance has
// played; don't await it to talk over someone), mute, unmute, leave, wait.

const GAP = 1500; // between turns

export const scenarios = {
  // One person, three utterances: does it work at all?
  async smoke(c) {
    await c.join("Ada");
    await c.wait(4000); // the agent joins
    for (const i of [0, 1, 2]) {
      await c.say("Ada", i);
      await c.wait(GAP);
    }
  },

  // Three people taking turns, five utterances each (about 2 minutes of
  // speech): accuracy, latency and attribution.
  async turns(c) {
    for (const n of ["Ada", "Bo", "Cy"]) await c.join(n);
    await c.wait(5000);
    for (let i = 0; i < 5; i++)
      for (const n of ["Ada", "Bo", "Cy"]) {
        await c.say(n, i);
        await c.wait(GAP);
      }
  },

  // The same three, two utterances each: about a minute (for the ungated
  // cost run).
  async short(c) {
    for (const n of ["Ada", "Bo", "Cy"]) await c.join(n);
    await c.wait(5000);
    for (let i = 0; i < 2; i++)
      for (const n of ["Ada", "Bo", "Cy"]) {
        await c.say(n, i);
        await c.wait(GAP);
      }
  },

  // Utterances with rare names and jargon (Timaeus, Neoplatonists,
  // pre-Socratic, Fitzooth, harangue, angor, mummeries), for keyterms.
  async jargon(c) {
    for (const n of ["Ada", "Cy", "Di"]) await c.join(n);
    await c.wait(5000);
    for (const [n, i] of [["Ada", 1], ["Cy", 0], ["Di", 1], ["Ada", 2], ["Cy", 1], ["Di", 9], ["Cy", 5]]) {
      await c.say(n, i);
      await c.wait(GAP);
    }
  },

  // The awkward parts: talking over each other, a muted person talking,
  // a late joiner, and someone who leaves and rejoins.
  async edges(c) {
    for (const n of ["Ada", "Bo", "Cy"]) await c.join(n);
    await c.wait(5000);
    // Overlap: Bo starts 2 s into Ada's longest utterance.
    const a = c.say("Ada", 9);
    await c.wait(2000);
    await Promise.all([a, c.say("Bo", 5)]);
    await c.wait(GAP);
    // Cy mutes and talks (nobody should hear it, STT shouldn't get it).
    await c.mute("Cy");
    c.log({ t: Date.now(), page: "Cy", ev: "note", note: "talking while muted" });
    await c.say("Cy", 5);
    await c.wait(GAP);
    await c.unmute("Cy");
    await c.wait(500);
    await c.say("Cy", 6);
    await c.wait(GAP);
    // Di joins late and talks.
    await c.join("Di");
    await c.wait(1500);
    await c.say("Di", 2);
    await c.wait(GAP);
    // Bo leaves and comes back.
    await c.leave("Bo");
    await c.wait(4000);
    await c.say("Ada", 8);
    await c.wait(GAP);
    await c.join("Bo");
    await c.wait(1500);
    await c.say("Bo", 6);
    await c.wait(GAP);
    await c.say("Di", 3);
    await c.wait(GAP);
  },

  // One person who stays muted for 40 s with sound on their microphone,
  // then talks (gate "none": is a muted track sent to STT and billed?).
  async muted(c) {
    await c.join("Ada");
    await c.wait(4000);
    await c.say("Ada", 0);
    await c.wait(GAP);
    await c.mute("Ada");
    c.log({ t: Date.now(), page: "Ada", ev: "note", note: "muted for 40 s, talking" });
    const until = Date.now() + 40_000;
    for (let i = 1; Date.now() < until; i++) await c.say("Ada", i % 10);
    await c.unmute("Ada");
    await c.wait(500);
    await c.say("Ada", 3);
    await c.wait(GAP);
  },
};

export const extra = {
  // Nobody talks: two people sit in the room for 10 s (is the agent in
  // their participant list? does dispatch work?). No STT.
  async presence(c) {
    await c.join("Ada");
    await c.join("Bo");
    await c.wait(10_000);
  },
};
Object.assign(scenarios, extra);
