// The microphone's noise filter in a call or voice: Krisp, Standard or
// Off. Krisp is LiveKit Cloud's noise cancellation, a processor on the
// microphone's track (@livekit/krisp-noise-filter, loaded only when a call
// or voice wants it: it's megabytes, and its models come from LiveKit at
// run time). Standard is the browser's own suppression (what every call
// had before), and Off is none. Echo cancellation and gain control stay
// on in all three: Off never makes an echo, and speech stays at the level
// the speaker view measures (./call's VOICE_LEVEL).
//
// While Krisp runs, the browser's suppression is off: Krisp's processor
// turns it off itself (its init asks the track for noiseSuppression:
// false), so this opens the microphone that way to begin with rather than
// suppress twice.
//
// Krisp can't always run: a browser it doesn't support (Safari before
// 17.4), its code or models not loading, LiveKit refusing it, or LiveKit
// stopping it mid-call. Then the microphone falls back to Standard and
// says why, so a page can say "Krisp isn't available here, using
// Standard"; nobody is left with a microphone that sends nothing. Once
// it's failed in a call it isn't tried again by itself, only when the
// person picks Krisp again.
//
// A MicFilter is one call's (or voice's) microphone: ./call makes one over
// LiveKit's track, and the tests over a fake.

export type NoiseFilter = "krisp" | "standard" | "off";

export const NOISE_FILTERS = ["krisp", "standard", "off"] as const satisfies readonly NoiseFilter[];

/** Your noise filter (PresenceClient's `noise`): shared by calls and
 * voice, and kept in this browser. */
export interface Noise {
  /** What you picked, or the default: Krisp where this browser runs it,
   * Standard where it doesn't. */
  mode: NoiseFilter;
  /** What's on your microphone now (Standard where Krisp couldn't run);
   * null outside a call or voice, or with no microphone. */
  active: NoiseFilter | null;
  /** Whether this browser runs Krisp: null until a call or voice has
   * loaded it. */
  krisp: boolean | null;
  /** Why Krisp isn't running when it's your mode ("this browser can't run
   * it", "LiveKit refused it: …"), or "". */
  fallback: string;
}

/** What a page says while `noise.fallback` is set. */
export const KRISP_FALLBACK = "Krisp isn't available here, using Standard";

/** The microphone's constraints for `mode`. */
export interface MicConstraints {
  echoCancellation: true;
  autoGainControl: true;
  noiseSuppression: boolean;
  voiceIsolation: boolean;
}

/** How the microphone opens for `mode`: the browser's suppression (and
 * Chrome's voice isolation, which LiveKit asks for by default) for
 * Standard alone; echo cancellation and gain control always. */
export function micConstraints(mode: NoiseFilter): MicConstraints {
  const browser = mode === "standard";
  return { echoCancellation: true, autoGainControl: true, noiseSuppression: browser, voiceIsolation: browser };
}

/** Whether the microphone opens the same way for `a` as for `b` (Krisp's
 * and Off's are the same: no browser suppression). */
function sameMic(a: NoiseFilter, b: NoiseFilter): boolean {
  return micConstraints(a).noiseSuppression === micConstraints(b).noiseSuppression;
}

export function isNoiseFilter(v: unknown): v is NoiseFilter {
  return typeof v === "string" && (NOISE_FILTERS as readonly string[]).includes(v);
}

/** What a call's microphone tells the client. */
export interface NoiseReport {
  active: NoiseFilter | null;
  krisp: boolean | null;
  /** Why Krisp isn't on, while it's wanted and isn't. */
  error: string;
}

/** Your noise state after a call reports, from what you picked (`chosen`:
 * kept in this browser, or null for the default). */
export function noiseAfter(was: Noise, chosen: NoiseFilter | null, r: NoiseReport): Noise {
  const krisp = r.krisp ?? was.krisp;
  // The default is Krisp until this browser turns out not to run it.
  const mode = chosen ?? (krisp === false ? "standard" : "krisp");
  const fallback = mode === "krisp" && r.active === "standard" ? r.error : "";
  return { mode, active: r.active, krisp, fallback };
}

/** The pieces of LiveKit's microphone track a MicFilter uses. */
export interface FilterMic {
  restartTrack(c: MicConstraints): Promise<void>;
  setProcessor(p: KrispProcessor): Promise<void>;
  stopProcessor(): Promise<void>;
  getProcessor(): unknown;
}

/** Krisp's processor (@livekit/krisp-noise-filter's KrispNoiseFilter()). */
export interface KrispProcessor {
  setEnabled(on: boolean): Promise<boolean | undefined>;
  isEnabled(): boolean;
}

export interface KrispModule {
  isKrispNoiseFilterSupported(): boolean;
  KrispNoiseFilter(): KrispProcessor;
}

export interface MicFilterOptions {
  /** The microphone's track now, or null (none, or not allowed). */
  mic(): FilterMic | null;
  /** Krisp's package (a dynamic import). */
  load(): Promise<KrispModule>;
  /** Whether the page's audio runs: Krisp's processor works in its
   * AudioContext, which sends silence while the browser holds it (no click
   * yet). Until it runs, Standard. */
  running(): boolean;
  report(r: NoiseReport): void;
  /** What the microphone was opened for (micConstraints), if it's open
   * yet (or `opened()` once it is). */
  opened?: NoiseFilter;
}

/** One microphone's noise filter: set() switches it (muted or not), one
 * change at a time. */
export class MicFilter {
  private want: NoiseFilter;
  private opened: NoiseFilter;
  private krisp: KrispProcessor | null = null;
  private supported: boolean | null = null;
  private active: NoiseFilter | null = null;
  /** Why Krisp didn't run, this call: it waits for set("krisp") to be tried again. */
  private refused = "";
  private busy = false;
  private queue: Promise<void> = Promise.resolve();

  private o: MicFilterOptions;

  constructor(o: MicFilterOptions, want: NoiseFilter) {
    this.o = o;
    this.want = want;
    this.opened = o.opened ?? "standard";
  }

  /** The microphone opened for `mode`'s constraints. */
  openedFor(mode: NoiseFilter) {
    this.opened = mode;
  }

  /** Switch to `mode` (picking Krisp tries it again after a failure). */
  set(mode: NoiseFilter): Promise<void> {
    this.want = mode;
    if (mode === "krisp") this.refused = "";
    return this.run();
  }

  /** What's wanted, again: the microphone opened, audio started running,
   * LiveKit reconnected. */
  refresh(): Promise<void> {
    return this.run();
  }

  /** Krisp stopped by itself (LiveKit turned it off): Standard, saying why. */
  lost(why: string) {
    if (this.busy || this.active !== "krisp") return;
    this.refused = why;
    void this.run();
  }

  private run(): Promise<void> {
    this.queue = this.queue.then(() => this.apply());
    return this.queue;
  }

  private async apply() {
    this.busy = true;
    try {
      const mic = this.o.mic();
      if (!mic) {
        this.active = null;
        return;
      }
      let mode = this.want;
      if (mode === "krisp") {
        if (this.refused || !this.o.running()) mode = "standard";
        else {
          try {
            await this.startKrisp(mic);
            this.active = "krisp";
            return;
          } catch (e) {
            this.refused = (e as Error).message || "it didn't start";
            mode = "standard";
          }
        }
      }
      try {
        if (mic.getProcessor()) await mic.stopProcessor();
        this.krisp = null;
        if (!sameMic(this.opened, mode)) {
          await mic.restartTrack(micConstraints(mode));
          this.opened = mode;
        }
        this.active = mode;
      } catch {
        // The microphone wouldn't reopen: it carries on as it was.
      }
    } finally {
      this.busy = false;
      const missing = this.want === "krisp" && this.active === "standard";
      this.o.report({ active: this.active, krisp: this.supported, error: missing ? this.refused : "" });
    }
  }

  private async startKrisp(mic: FilterMic) {
    if (this.krisp && mic.getProcessor() === this.krisp && this.krisp.isEnabled()) return;
    let k: KrispModule;
    try {
      k = await this.o.load();
    } catch (e) {
      throw new Error(`it didn't load (${(e as Error).message})`);
    }
    this.supported = k.isKrispNoiseFilterSupported();
    if (!this.supported) throw new Error("this browser can't run it");
    if (!sameMic(this.opened, "krisp")) {
      await mic.restartTrack(micConstraints("krisp"));
      this.opened = "krisp";
    }
    // A fresh processor each time: a stopped one is disposed.
    const p = k.KrispNoiseFilter();
    this.krisp = p;
    await mic.setProcessor(p);
    try {
      await p.setEnabled(true);
    } catch (e) {
      throw new Error(`LiveKit refused it: ${(e as Error).message}`);
    }
    if (!p.isEnabled()) throw new Error("LiveKit didn't turn it on");
  }
}
