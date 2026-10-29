// One current speaker for a call or voice (Arugula #332): who a spotlight
// shows big. Fed who's speaking now, loudest first, every sample, it
// holds one person steady: a new speaker takes over only after talking a
// while, the one who has it keeps it through pauses (and when nobody's
// talking), a cough doesn't flip it, and you're never it on your own
// screen unless you're alone.
//
// The numbers, and why:
//
// - TAKE_MS, 700: a challenger has to talk this long (and still be
//   talking) to take over. A cough or an "mm" is under 300 ms; what a
//   receiver hears of it fades out over about 200 ms more (measured, at
//   ./call's VOICE_LEVEL), and the samples (every SAMPLE_MS) can stretch
//   it by one: 600 ms at worst, so it never gets there. A real turn does,
//   and the switch lands about 0.8 s after they start, a few words in.
// - MIN_SAMPLES, 3: and over at least this many samples in a row, so one
//   of them lies wholly inside the talking. A page too busy to sample on
//   time (half a second apart) would otherwise see a cough that straddles
//   two samples as half a second of talking.
// - GAP_MS, 300: a run carries on through silences shorter than this, the
//   pauses between words; a longer one starts it over. (Counted from the
//   first sample that finds them quiet, so a page too busy to sample on
//   time doesn't break a run up.)
// - HOLD_MS, 1500: whoever takes over keeps it at least this long, so two
//   people talking over each other can't flip it faster than you can take
//   in a face.
// - COARSE_TAKE_MS, 1000: when this page can't measure levels itself (the
//   browser hasn't let the call's audio play yet), LiveKit's own active
//   speakers stand in. LiveKit updates them on a 400 ms tick and lets each
//   one tail off: measured on its server, a 200–400 ms sound reads as 400–
//   800 ms of speaking and a 600 ms one as 1200 ms, so 1000 sits between.
//
// A challenger's run counts only while they're louder than whoever has it
// (or that person is quiet): someone saying "right" under the speaker
// doesn't take over. An empty spot (nobody's spoken yet) is taken the same
// way, so a cough doesn't take that either; it just has no hold to wait
// out.

export const TAKE_MS = 700;
export const MIN_SAMPLES = 3;
export const GAP_MS = 300;
export const HOLD_MS = 1500;
export const COARSE_TAKE_MS = 1000;

export interface SpeakerSample {
  /** Who's speaking now, loudest first. */
  speakers: string[];
  /** Who's in the call or voice now, you included. */
  people: string[];
  /** `speakers` is LiveKit's coarse list, not levels this page measured. */
  coarse?: boolean;
}

export class SpeakerPicker {
  /** Who has the spot, or null (nobody's spoken yet). */
  current: string | null = null;
  private me: string;
  /** Since when each challenger has been talking ahead of `current`, when
   * they last were, and since when they've been quiet (null: talking). */
  private runs = new Map<string, { since: number; last: number; quiet: number | null; n: number }>();
  /** When `current` took over. */
  private took = -Infinity;
  /** Who had it before, most recent first: if `current` leaves, the spot
   * goes back to the last of them still here. */
  private before: string[] = [];

  constructor(me: string) {
    this.me = me;
  }

  /** Who's speaking at `now` (ms): returns who has the spot. */
  update(now: number, s: SpeakerSample): string | null {
    const here = new Set(s.people);
    const others = s.people.filter((p) => p !== this.me);
    // Alone: it's you (there's nobody else to show).
    if (!others.length) {
      this.runs.clear();
      return this.take(here.has(this.me) ? this.me : null, now);
    }
    if (this.current === this.me) this.current = null;
    // Gone: back to whoever had it before and is still here (they're
    // remembered, in case they come back).
    if (this.current !== null && !here.has(this.current)) {
      this.take(null, now, true);
    }
    if (this.current === null) {
      const back = this.before.find((p) => p !== this.me && here.has(p));
      if (back) this.take(back, now, true);
    }
    const speaking = s.speakers.filter((p) => p !== this.me && here.has(p));
    const rank = this.current === null ? -1 : speaking.indexOf(this.current);
    const counted = new Set<string>();
    for (const p of speaking) {
      if (p === this.current) continue;
      const ahead = rank < 0 || speaking.indexOf(p) < rank;
      if (!ahead) continue;
      const r = this.runs.get(p);
      if (r && (r.quiet === null || now - r.quiet <= GAP_MS)) {
        r.last = now;
        r.quiet = null;
        r.n++;
      } else this.runs.set(p, { since: now, last: now, quiet: null, n: 1 });
      counted.add(p);
    }
    // Runs quiet too long, or whose person left, are over.
    for (const [p, r] of this.runs) {
      if (!here.has(p) || p === this.current) this.runs.delete(p);
      else if (!counted.has(p)) {
        r.quiet ??= now;
        if (now - r.quiet > GAP_MS) this.runs.delete(p);
      }
    }
    if (now - this.took < HOLD_MS) return this.current;
    const take = s.coarse ? COARSE_TAKE_MS : TAKE_MS;
    // The longest run that's long enough and still talking now.
    let best: string | null = null;
    let since = Infinity;
    for (const p of speaking) {
      const r = this.runs.get(p);
      if (r && r.last === now && r.n >= MIN_SAMPLES && now - r.since >= take && r.since < since) {
        best = p;
        since = r.since;
      }
    }
    if (best) {
      this.runs.clear();
      return this.take(best, now);
    }
    return this.current;
  }

  /** Forget everything (out of the call). */
  reset() {
    this.current = null;
    this.took = -Infinity;
    this.runs.clear();
    this.before = [];
  }

  private take(p: string | null, now: number, quiet = false): string | null {
    if (p === this.current) return p;
    if (this.current !== null && this.current !== this.me) this.before = [this.current, ...this.before.filter((x) => x !== this.current)].slice(0, 8);
    this.current = p;
    // Falling back to someone who had it isn't a turn: the next speaker
    // takes it without waiting out a hold.
    this.took = quiet ? -Infinity : now;
    return p;
  }
}
