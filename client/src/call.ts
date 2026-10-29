// A call's audio and video, on LiveKit (PROTOCOL.md "Calls"; #318's P7
// voice, P8 video): the relay rings and hands this page a token for one
// LiveKit room, and this joins it with the microphone on, plays everyone
// else, and says who's there, who's muted, who's speaking and whose video
// is on. livekit-client loads only when a call starts, so a page that
// never calls doesn't pay for it.
//
// A room's voice channel (PROTOCOL.md "Voice") joins the same way, but
// muted: the microphone opens on joining (its permission asked then, not
// mid-conversation) and is published muted, so unmuting is instant and
// nobody hears a thing until then.
//
// Video is off until you turn it on, and it comes from the presence
// camera: the client hands setVideo the camera's own track, and this
// publishes a clone of it (one device, opened once; the rig keeps reading
// the original). Others' video goes only to the <video> elements a view
// attaches, and adaptive stream sends each one just the layer its size
// needs, and nothing while it's out of sight.
//
// The microphone's noise filter (./noise): Krisp, Standard or Off, picked
// on joining (JoinOptions' `noise`) and switched in the call (setNoise)
// without rejoining, muted or not. Krisp's package starts loading as the
// call does (alongside LiveKit's connect), and only when it's wanted; the
// microphone opens for Standard until it has.
//
// Speaker view (Arugula #332): video goes up in three layers, 1280×720 at
// the top where the camera gives that much (it's asked for 720p while
// video is on, and back to its own size after), 640×360 and 320×180
// below. With dynacast a publisher encodes a layer only while someone's
// subscribed to it, and with adaptive stream a page subscribes to the
// layer its biggest <video> of that person needs: so the 720p layer goes
// out only while some page shows that person big. And one current speaker
// (./speaker's SpeakerPicker), from what this page hears: each remote
// microphone's level, measured every SAMPLE_MS from its receiver's audio
// energy, because LiveKit's own active speakers come on a 400 ms tick with
// a tail that makes a cough look like a turn.

import type { LocalAudioTrack, LocalVideoTrack, RemoteVideoTrack, TrackProcessor, Track as LKTrack, AudioProcessorOptions } from "livekit-client";
import type { CallJoin } from "./transport.ts";
import { SpeakerPicker } from "./speaker.ts";
import { MicFilter, micConstraints, type FilterMic, type KrispModule, type NoiseFilter, type NoiseReport } from "./noise.ts";

/** Someone in the call, you included. */
export interface CallPerson {
  sub: string;
  name: string;
  muted: boolean;
  speaking: boolean;
  /** Their audio reaches this page (yours: your microphone is published). */
  audio: boolean;
  /** Their camera's video is on in the call and reaches this page (yours:
   * your video is published). */
  video: boolean;
}

export interface LiveCallEvents {
  people(people: CallPerson[]): void;
  /** The current speaker changed (./speaker): who a spotlight shows big. */
  speaker?(sub: string | null): void;
  /** Connected, reconnecting by itself, or gone (`byUs`: we left). */
  state(state: "on" | "reconnecting" | "ended", byUs?: boolean): void;
  /** The browser blocked playing the call (no click yet): `startAudio`
   * from a click plays it. */
  blocked?(blocked: boolean): void;
  /** What's on your microphone now (./noise), and why not Krisp. */
  noise?(r: NoiseReport): void;
}

export interface LiveCall {
  setMuted(muted: boolean): Promise<void>;
  /** Publish a clone of `camera` (the presence camera's track) as your
   * video, in place of any before; null takes your video down. */
  setVideo(camera: MediaStreamTrack | null): Promise<void>;
  /** Show `sub`'s video (yours too) in `el`, now and whenever it comes
   * back; returns a function to stop. */
  attach(sub: string, el: HTMLVideoElement): () => void;
  /** Your microphone's noise filter, switched in place (./noise). */
  setNoise(mode: NoiseFilter): Promise<void>;
  /** From a click, if the browser blocked the call's audio. */
  startAudio(): Promise<void>;
  leave(): Promise<void>;
}

export interface JoinOptions {
  /** Join with the microphone published muted (the room's voice channel). */
  muted?: boolean;
  /** The microphone's noise filter (./noise). Default: standard. */
  noise?: NoiseFilter;
}

/** Joins a call's LiveKit room (a test passes a fake). */
export type JoinCall = (j: CallJoin, on: LiveCallEvents, o?: JoinOptions) => Promise<LiveCall>;

/** A call's video at the top: 1280×720 at 24 fps, a megabit and a half,
 * for a speaker shown big. With simulcast, the layers below go up beside
 * it for everything smaller. */
export const VIDEO = { width: 1280, height: 720, fps: 24, maxBitrate: 1_500_000 };

/** The layers under the top, smallest first: 320×180 at 15 fps for a strip
 * or a grid's small tiles, 640×360 at 24 for a big grid tile. */
export const LAYERS = [
  { width: 320, height: 180, fps: 15, maxBitrate: 150_000 },
  { width: 640, height: 360, fps: 24, maxBitrate: 500_000 },
] as const;

/** The size to publish a `w`×`h` camera at: the biggest of the layers
 * (720p, 360p, 180p, 16:9 the camera's way up) that fits inside it, so a
 * 640×480 camera goes up at 640×360 and is never scaled up to 720p. */
export function videoSize(w: number, h: number): { width: number; height: number; maxBitrate: number } {
  const portrait = h > w;
  for (const l of [VIDEO, LAYERS[1], LAYERS[0]]) {
    const [lw, lh] = portrait ? [l.height, l.width] : [l.width, l.height];
    if (lw <= w && lh <= h) return { width: lw, height: lh, maxBitrate: l.maxBitrate };
  }
  return { width: w, height: h, maxBitrate: LAYERS[0].maxBitrate };
}

/** How often this page measures who it hears (./speaker). */
export const SAMPLE_MS = 100;

/** Speaking, for the spotlight: a level over the last sample above -30
 * dBov. LiveKit's own active level is -35 (`active_level: 35`), on each
 * packet; this is a 100 ms average, and a sound's last word fades out of
 * a receiver at about 10 dB a 100 ms (measured), so 5 dB higher cuts that
 * tail by half a sample. Speech, with the browser's gain control, sits
 * well above it; a room's hum, with its noise suppression, well below. */
export const VOICE_LEVEL = 10 ** (-30 / 20);

/** Krisp's package, once: loaded the first time a call wants it (and again
 * after a failure). */
let krispPackage: Promise<KrispModule> | null = null;
let krispLoaded: KrispModule | null = null;
export function loadKrisp(): Promise<KrispModule> {
  krispPackage ??= import("./krisp.ts").then(
    (m) => (krispLoaded = m),
    (e) => {
      krispPackage = null;
      throw e;
    },
  );
  return krispPackage;
}

export const joinLiveKit: JoinCall = async (j, on, o = {}) => {
  const noise = o.noise ?? "standard";
  // Alongside connecting: by the time the microphone opens it's often here.
  if (noise === "krisp") loadKrisp().catch(() => {});
  const { Room, RoomEvent, Track, TrackEvent, DisconnectReason, VideoPreset, createLocalAudioTrack } = await import("livekit-client");
  const layers = LAYERS.map((l) => new VideoPreset(l.width, l.height, l.maxBitrate, l.fps));
  const room = new Room({
    // Each video element gets the layer its size needs, and none while
    // it's hidden or off screen; a publisher stops encoding a layer
    // nobody's watching (so 720p goes out only while someone shows it big).
    adaptiveStream: true,
    dynacast: true,
    publishDefaults: {
      simulcast: true,
      videoEncoding: { maxBitrate: VIDEO.maxBitrate, maxFramerate: VIDEO.fps },
      videoSimulcastLayers: layers,
    },
  });
  // Everyone else's audio plays from elements of its own, out of sight, by
  // track: a track that goes may already be detached (LiveKit stops a
  // departing participant's first), so its element is found here.
  const players = new Map<object, HTMLMediaElement>();
  // The video elements views attached, by whose video they show.
  const views = new Map<string, Set<HTMLVideoElement>>();
  const me = room.localParticipant;
  // `sub`'s video now: their newest camera track that's on (a republished
  // camera, after a mode change, briefly has two).
  const camOf = (sub: string) => {
    const p = sub === me.identity ? me : room.getParticipantByIdentity(sub);
    const cams = [...(p?.trackPublications.values() ?? [])].filter((x) => x.source === Track.Source.Camera && x.videoTrack && !x.isMuted);
    return cams[cams.length - 1]?.videoTrack;
  };
  // Which track each view shows, so a change re-attaches and nothing else.
  const showing = new WeakMap<HTMLVideoElement, LocalVideoTrack | RemoteVideoTrack>();
  // Into every view of `sub`, their video now (or nothing).
  const show = (sub: string) => {
    const t = camOf(sub);
    for (const el of views.get(sub) ?? []) {
      const was = showing.get(el);
      if (was === t) continue;
      was?.detach(el);
      if (t) {
        t.attach(el);
        showing.set(el, t);
      } else {
        el.srcObject = null;
        showing.delete(el);
      }
    }
  };
  // The microphone's noise filter (./noise), over LiveKit's track.
  const micTrack = () => me.getTrackPublication(Track.Source.Microphone)?.track as LocalAudioTrack | undefined;
  const filter = new MicFilter(
    {
      mic: (): FilterMic | null => {
        const t = micTrack();
        if (!t) return null;
        return {
          restartTrack: (c) => t.restartTrack(c),
          setProcessor: (p) => t.setProcessor(p as unknown as TrackProcessor<LKTrack.Kind.Audio, AudioProcessorOptions>),
          stopProcessor: () => t.stopProcessor(),
          getProcessor: () => t.getProcessor(),
        };
      },
      load: loadKrisp,
      running: () => room.canPlaybackAudio,
      report: (r) => on.noise?.(r),
    },
    noise,
  );
  // The clone this page publishes, stopped when it's taken down.
  let mine: MediaStreamTrack | null = null;
  // The camera raised to 720p for it, and what it asked for before.
  let raised: { track: MediaStreamTrack; was: MediaTrackConstraints } | null = null;
  // The current speaker (made once connected, when this page has its
  // identity): each remote microphone's audio energy at the last sample,
  // to measure the level over the next.
  let picker: SpeakerPicker | null = null;
  const energy = new Map<string, { e: number; d: number; got: number; made: number }>();
  let sampling = false;
  const sample = async () => {
    if (sampling || !picker || room.state !== "connected") return;
    sampling = true;
    try {
      const voiced: [string, number][] = [];
      let measured = false;
      for (const p of room.remoteParticipants.values()) {
        // Muted ones too (they send nothing), so unmuting is heard at the
        // next sample, not after LiveKit says so.
        const rx = p.getTrackPublication(Track.Source.Microphone)?.track?.receiver;
        if (!rx) {
          energy.delete(p.identity);
          continue;
        }
        const now = { e: 0, d: 0, got: 0, made: 0 };
        (await rx.getStats()).forEach((s) => {
          if (s.type === "inbound-rtp") {
            now.e = s.totalAudioEnergy ?? 0;
            now.d = s.totalSamplesDuration ?? 0;
            now.got = s.totalSamplesReceived ?? 0;
            now.made = s.concealedSamples ?? 0;
          }
        });
        const was = energy.get(p.identity);
        energy.set(p.identity, now);
        // Nothing played since (audio blocked, or just subscribed).
        if (!was || now.d <= was.d) continue;
        measured = true;
        // Mostly made up (the receiver filling in for packets that stopped,
        // as they do when someone mutes): that tail of the last word isn't
        // talking.
        const got = now.got - was.got;
        if (got > 0 && (now.made - was.made) / got > 0.5) continue;
        const level = Math.sqrt(Math.max(0, now.e - was.e) / (now.d - was.d));
        if (level >= VOICE_LEVEL) voiced.push([p.identity, level]);
      }
      // Loudest first; LiveKit's own list where nothing's measurable here.
      const speakers = measured ? voiced.sort((a, b) => b[1] - a[1]).map(([s]) => s) : room.activeSpeakers.map((p) => p.identity);
      const people = [me.identity, ...[...room.remoteParticipants.values()].map((p) => p.identity)];
      const was = picker.current;
      const now = picker.update(performance.now(), { speakers, people, coarse: !measured });
      if (now !== was) on.speaker?.(now);
    } catch {
      // A receiver that went mid-sample: the next one sees.
    } finally {
      sampling = false;
    }
  };
  let sampler: ReturnType<typeof setInterval> | undefined;
  // The camera back to what presence asked of it, once video's down.
  const lower = () => {
    const r = raised;
    raised = null;
    if (r && r.track.readyState === "live") void r.track.applyConstraints(r.was).catch(() => {});
  };
  const tell = () => {
    for (const sub of views.keys()) show(sub);
    const speaking = new Set(room.activeSpeakers.map((p) => p.identity));
    on.people([
      {
        sub: me.identity,
        name: me.name || me.identity,
        muted: !me.isMicrophoneEnabled,
        speaking: speaking.has(me.identity),
        audio: !!me.getTrackPublication(Track.Source.Microphone)?.track,
        video: !!me.getTrackPublication(Track.Source.Camera)?.track,
      },
      ...[...room.remoteParticipants.values()].map((p) => {
        const mic = p.getTrackPublication(Track.Source.Microphone);
        const cam = p.getTrackPublication(Track.Source.Camera);
        return {
          sub: p.identity,
          name: p.name || p.identity,
          muted: !mic || mic.isMuted,
          speaking: speaking.has(p.identity),
          audio: !!mic?.isSubscribed && !!mic.track,
          video: !!cam?.isSubscribed && !!cam.track && !cam.isMuted,
        };
      }),
    ]);
  };
  room
    .on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) {
        const el = track.attach();
        el.hidden = true;
        document.body.append(el);
        players.set(track, el);
      }
      tell();
    })
    .on(RoomEvent.TrackUnsubscribed, (track) => {
      // Audio's elements go; video's views are the page's, and tell()
      // shows them whatever's on now (or blanks them).
      if (track.kind === Track.Kind.Audio) {
        for (const el of track.detach()) el.remove();
        players.get(track)?.remove();
        players.delete(track);
      }
      tell();
    })
    .on(RoomEvent.LocalTrackPublished, tell)
    .on(RoomEvent.LocalTrackUnpublished, tell)
    .on(RoomEvent.ParticipantConnected, tell)
    .on(RoomEvent.ParticipantDisconnected, tell)
    .on(RoomEvent.TrackPublished, tell)
    .on(RoomEvent.TrackUnpublished, tell)
    .on(RoomEvent.TrackMuted, tell)
    .on(RoomEvent.TrackUnmuted, tell)
    .on(RoomEvent.ActiveSpeakersChanged, tell)
    .on(RoomEvent.AudioPlaybackStatusChanged, () => {
      on.blocked?.(!room.canPlaybackAudio);
      // Krisp waits for the page's audio to run.
      if (room.canPlaybackAudio) void filter.refresh();
    })
    .on(RoomEvent.Reconnecting, () => on.state("reconnecting"))
    .on(RoomEvent.Reconnected, () => {
      on.state("on");
      void filter.refresh();
    })
    .on(RoomEvent.Disconnected, (why) => {
      clearInterval(sampler);
      picker = null;
      for (const el of players.values()) el.remove();
      players.clear();
      for (const els of views.values())
        for (const el of els) {
          showing.get(el)?.detach(el);
          showing.delete(el);
          el.srcObject = null;
        }
      mine?.stop();
      mine = null;
      lower();
      on.state("ended", why === DisconnectReason.CLIENT_INITIATED);
    });
  await room.connect(j.url, j.token);
  picker = new SpeakerPicker(me.identity);
  sampler = setInterval(() => void sample(), SAMPLE_MS);
  on.state("on");
  // Krisp's mode opens the microphone as Krisp wants it (no browser
  // suppression) if its package is here and runs in this browser, and as
  // Standard until then.
  const opened: NoiseFilter = noise === "krisp" ? (krispLoaded?.isKrispNoiseFilterSupported() ? "krisp" : "standard") : noise;
  try {
    // Muted for voice: opened now and published muted, so LiveKit tells
    // the others it's muted, nothing is heard, and unmuting (setMuted)
    // just enables it.
    const mic = await createLocalAudioTrack(micConstraints(opened));
    filter.openedFor(opened);
    if (o.muted) await mic.mute();
    await me.publishTrack(mic, { source: Track.Source.Microphone });
    // Krisp turned off by itself (LiveKit stopped it): Standard.
    mic.on(TrackEvent.AudioTrackFeatureUpdate, () => {
      if (!mic.enhancedNoiseCancellation) filter.lost("LiveKit stopped it");
    });
  } catch {
    // No microphone, or not allowed: in the call, listening, shown muted.
  }
  tell();
  void filter.set(noise);
  const takeDown = async () => {
    const pub = me.getTrackPublication(Track.Source.Camera);
    if (pub?.track) await me.unpublishTrack(pub.track, true);
    mine?.stop();
    mine = null;
    lower();
  };
  return {
    setMuted: async (muted) => {
      await me.setMicrophoneEnabled(!muted);
      tell();
    },
    setVideo: async (camera) => {
      await takeDown();
      if (camera) {
        // The same device, not a second getUserMedia: a clone shares the
        // camera's capture, and the browser crops and scales it to its own
        // size and rate. The presence camera asks for 640×480 (the outline
        // one at 15 fps): raised to 720p at 24 for a call, where the camera
        // has it, and back with the video (the trackers scale whatever
        // comes down to their own few hundred pixels).
        raised = { track: camera, was: camera.getConstraints() };
        const fps = Math.max(VIDEO.fps, camera.getSettings().frameRate ?? 0);
        await camera.applyConstraints({ ...raised.was, width: { ideal: VIDEO.width }, height: { ideal: VIDEO.height }, frameRate: { ideal: fps } }).catch(() => {});
        const got = camera.getSettings();
        const size = videoSize(got.width ?? 640, got.height ?? 480);
        const copy = camera.clone();
        await copy.applyConstraints({ width: { ideal: size.width }, height: { ideal: size.height }, frameRate: { ideal: VIDEO.fps } }).catch(() => {});
        mine = copy;
        try {
          // The top layer at the size it went up at; LiveKit adds the
          // layers under it that are smaller.
          await me.publishTrack(copy, { source: Track.Source.Camera, name: "camera", videoEncoding: { maxBitrate: size.maxBitrate, maxFramerate: VIDEO.fps } });
        } catch (e) {
          copy.stop();
          mine = null;
          lower();
          throw e;
        }
      }
      tell();
    },
    attach: (sub, el) => {
      let set = views.get(sub);
      if (!set) views.set(sub, (set = new Set()));
      set.add(el);
      show(sub);
      return () => {
        set.delete(el);
        showing.get(el)?.detach(el);
        showing.delete(el);
        el.srcObject = null;
      };
    },
    setNoise: (mode) => filter.set(mode),
    startAudio: () => room.startAudio(),
    leave: () => room.disconnect(),
  };
};
