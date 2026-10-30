# arugula.stream SDKs: the surface (v0)

What a developer writes. The browser SDK and the server SDKs are built to
this; the site's docs show exactly this. PROTOCOL.md is underneath.

## Browser: one script tag (web components)

    <script type="module" src="https://arugula.stream/sdk/v0/presence.js"></script>

    <arugula-room room="design-team" token-url="/api/presence-token">
      <arugula-camera></arugula-camera>   <!-- camera on/off, avatar|outline, character, colour -->
      <arugula-people></arugula-people>   <!-- a tile per person in the room -->
      <arugula-chat></arugula-chat>       <!-- the room's text: messages and an input -->
      <arugula-call></arugula-call>       <!-- the call bar: a ring to answer, mute, video, leave -->
      <arugula-voice></arugula-voice>     <!-- the room's voice channel: who's in it, join (muted), unmute, video, leave -->
      <arugula-spotlight></arugula-spotlight> <!-- speaker view, in a call or voice: whoever's talking big, the rest in a strip -->
    </arugula-room>

    <!-- anywhere inside a room: one person's live face, e.g. beside their name -->
    <arugula-avatar user="u_123" size="head"></arugula-avatar>

`<arugula-room>` attributes:
- `room` (required): the room's id in your app.
- `token-url`: your endpoint; the element POSTs `{room}` (JSON, with the page's cookies) and expects `{token}` (a room token your server signed). Called on every (re)connect.
- `key` + `auth`: no server of yours: the app's publishable key, and the person's token from your auth provider (below). `auth="eyJ…"` is a token; a bare `auth` waits for the `auth` property, `el.auth = () => getToken()`, called on every (re)connect.
- `key` + `name`: a guest by name, where the app allows guests (with `auth`, `name` is only for a token without one).
- `demo` + `name`: prototype without a server: arugula.stream's public demo tokens (anyone who knows the room's name can join it). Not for production.
- `relay`: default `wss://arugula.stream/socket`.
- `mode` (`avatar`|`outline`, default `avatar`), `character`, `colour`: starting choices (the person can change them; kept in their browser).

**A room you already connected.** Set the element's `room` property to a
Room from `connect()` (below), before or after the element is in the
page, and it and everything inside it (camera, people, chat, call, voice,
spotlight, avatar) draw from that room instead of connecting: one
connection per page, shared by your own code and the elements. The
element then ignores its connecting attributes (`room`, `token-url`,
`key`, `auth`, `demo`…) and still re-dispatches the room's events.
Taking the element out of the page never leaves the room (whoever called
`connect()` does, with `room.leave()`); back in, it draws again. Setting
`el.room` to another Room swaps everything inside to it; `null` goes
back to the attributes. `el.room` reads the room it draws from (its own
connection's too), or null.

    const room = await connect({ room: "design-team", token: getToken });
    document.querySelector("arugula-room").room = room;   // <arugula-room><arugula-people></arugula-people></arugula-room>

`<arugula-people>`: attributes `size` (`bust`, default; `head` for a compact strip), `self` (`first`|`hide`), `calls` (`off` hides the Call button on tiles; it shows only where the relay has calls). `<arugula-camera>`: attribute `controls` (`full`, default; `button` for just the toggle). `<arugula-spotlight>`: `self` (`hide` leaves you out of the strip), `pin` (`off`: clicking doesn't pin). `<arugula-avatar>`: `user`, `size` (`head`|`bust`), `draw` (`live`, default: whatever they send; `character`: always their character, as `room.avatar`'s `draw` below). Theming: CSS custom properties on any ancestor: `--arugula-accent`, `--arugula-bg`, `--arugula-fg`, `--arugula-dim`, `--arugula-radius`.

Events (bubbling, on the room element): `arugula:members` (`detail.members`), `arugula:wave` (`detail.from`), `arugula:answer` (`detail.from, detail.yes`), `arugula:react` (`detail.from, detail.emoji`), `arugula:message` (`detail.message`), `arugula:ring` (`detail.from, detail.id`), `arugula:call` (`detail.call`, null when it's over), `arugula:voice` (`detail.members` in voice, `detail.joined`: you in it, or null), `arugula:speaker` (`detail.active`: the current speaker in your call or voice, `detail.pinned`: who you pinned, or null), `arugula:live` (`detail.state`). `<arugula-camera>` also has a row of reactions.

## Browser: JS API (same bundle, or npm `@arugula/presence`)

    import { connect } from "https://arugula.stream/sdk/v0/presence.js";

    const room = await connect({
      room: "design-team",
      token: async () => (await fetch("/api/presence-token", { method: "POST", body: JSON.stringify({ room: "design-team" }) })).json().then((r) => r.token),
      // or, no server: key: "pk_live_…", auth: () => getToken()   (or guest: "Ada")
      // relay: "wss://arugula.stream/socket",
    });
    room.members;                       // [{ sub, name, look, mode, away, watching, call, voice, muted }]
    room.on("members", (members) => {}); // also "wave", "answer", "react", "message", "ring", "call", "voice", "speaker", "noise", "live"
    await room.camera.start({ mode: "avatar" });   // or "outline"
    room.camera.stop();
    room.setLook({ character: 2, colour: 0 });
    room.wave(sub); room.answer(sub, true);
    room.react("👍");                              // an emoji for the room
    await room.say("hi");                          // a kept text message
    room.messages;                                 // [{ id, sub, name, text, at }], oldest first
    await room.loadEarlier();                      // the 50 before the first one here
    room.chat(element);                            // draw the chat into an element
    room.calls;                                    // whether the relay has calls (LiveKit keys)
    await room.call(sub);                          // ask to talk: a voice call once they say yes
    room.on("ring", (from, id) => room.answerCall(id, true));
    room.inCall;                                   // { id, state, ringing, people: [{ sub, name, muted, speaking, video }], muted, video }
    room.setMuted(true); room.leaveCall();
    await room.setVideo(true);                     // your camera's real video, to the people in the call
    room.callBar(element);                         // draw the call bar into an element
    room.voice.available;                          // whether the relay has voice (it does wherever it has calls)
    await room.voice.join();                       // the room's voice channel: in, muted (out of your call first)
    room.voice.setMuted(false); room.voice.leave();
    await room.voice.setVideo(true);               // as in a call: real video, to the people in voice
    room.voice.members;                            // who's in voice (presence: everyone in the room sees it)
    room.voice.joined;                             // you in voice: { state, people: [{ sub, name, muted, speaking, video }], muted, video }, or null
    room.voice.speaking(sub);                      // whether they're speaking (known while you're in voice)
    room.on("voice", (members, joined) => {});
    room.voiceBar(element);                        // draw the voice bar into an element
    await room.setNoiseFilter("krisp");            // or "standard" (the browser's) or "off": kept in this browser, calls and voice
    room.noise;                                    // { mode, active, krisp, fallback }: what you picked, what's on your mic now, why not Krisp
    room.activeSpeaker;                            // the current speaker in your call or voice (held steady), or null
    room.pin(sub); room.pin(null);                 // show someone big on this page alone; null follows the speaker
    room.pinned; room.featured;                    // who you pinned; who a spotlight shows big now
    room.on("speaker", (active, pinned) => {});
    room.spotlight(element, { self: "show", pin: true }); // draw speaker view into an element
    room.mount(element, { size: "bust" });          // draw everyone into an element
    room.avatar(element, sub, { size: "head" });    // draw one person
    room.avatar(element, sub, { size: "head", draw: "character" }); // always their character (small faces)
    room.leave();

**`draw: "character"`.** By default an avatar draws whatever the person
sends: their outline, their character, or their video in your call.
`draw: "character"` (`<arugula-avatar draw="character">`, `<Avatar
draw="character" />`) always draws their character, for faces too small
for an outline (24–32 px beside a name in a chat): live while they send a
rig (avatar mode), idling in their look while they send an outline or
their camera's off. The look is the one their rigs carry, else presence's
(`look` in the token, or the one their page sent on turning the camera on
or changing it). Someone with no look anywhere (outline only, and none in
their token) gets their initial, as a tile does. Your own face is always
your character, in this browser's look.

**One person on several pages** (PROTOCOL.md, "One person, several
pages"): the same `sub` connected from several pages at once (each its
own socket and token) is one member. `room.members` lists them once: on
camera if any page is, `away` only when every page is, in a call if a
page is. Their frames come from whichever page is sending; a ring rings
every page and the one that answers takes the call (the others stop
ringing); one page leaving doesn't take them out of the room. On your own
pages, your own tile shows this page's camera, or, with it off, what your
other page sends.

## React: `@arugula/presence-react`

    <PresenceRoom room="design-team" token={getToken}>   {/* or publishableKey="pk_live_…" auth={getToken}; or room={r}, a Room from connect() */}
      <CameraControls />
      <People />
      <Avatar user={id} size="head" />                     {/* draw="character": always their character */}
      <CallControls />
      <VoiceBar />
      <Spotlight />                                        {/* self="hide", pin={false} */}
    </PresenceRoom>
    const { members, messages, say, wave, camera, calls, rings, inCall, call, answerCall, leaveCall, setMuted, setVideo, voice, noise, setNoiseFilter, activeSpeaker, pinned, pin } = usePresence();
    // voice: { available, members, joined, speaking(sub), join(), leave(), setMuted(m), setVideo(on) }
    // noise: { mode, active, krisp, fallback }; setNoiseFilter("krisp" | "standard" | "off")

`<PresenceRoom room={r}>` with a Room from `connect()` draws from it
without connecting again, and never leaves it (unmounting doesn't; its
owner does); the connecting props are ignored.

**Video in a call is real video.** Presence sends a rig or an outline,
never a picture. A call's video (`setVideo(true)`, or the call bar's Start
video) is the camera's actual picture, sent to the people in that call
while it's on; tiles in the call show it in place of the character. It
shares the presence camera (no second camera prompt), with simulcast and
adaptive stream so each tile gets only the size it shows.

**Every room has a voice channel.** Besides a wave's private call, each
room has one drop-in voice channel (PROTOCOL.md, "Voice"): `room.voice.join()`
(or `<arugula-voice>`, `<VoiceBar />`) puts the person in it muted, they
unmute to talk, and everyone in the room sees who's in it. A page is in
voice or in a call, never both: joining voice leaves the call, and taking
a call leaves voice, with a short notice. At most 25 people in a room's
voice; voice minutes count as call minutes.

**Noise filter.** In a call or voice the microphone runs one of three:
Krisp (LiveKit Cloud's noise cancellation, a processor in the browser),
Standard (the browser's own suppression) or Off. `room.setNoiseFilter(mode)`
(or the call and voice bars' Noise choice) switches it in place, muted or
not, and the browser keeps the choice for calls and voice alike. Krisp is
the default where the browser runs it (not Safari before 17.4); where it
can't start (unsupported, its code or models not loading, LiveKit refusing
it), the microphone uses Standard and `room.noise.fallback` says why.
Echo cancellation and gain control stay on in all three; while Krisp runs
the browser's suppression is off. Krisp's code is LiveKit's
(`@livekit/krisp-noise-filter`, under LiveKit's terms of service, not this
repo's licence), about 2 MB compressed, loaded only when a call or voice
wants it, from beside the SDK; its models come from integrations.livekit.io.
A page with a Content Security Policy has to let Krisp fetch from that
host and run WebAssembly and its audio worklet, or it falls back to
Standard.

**Speaker view.** In a call or voice, `<arugula-spotlight>` (`room.spotlight`,
`<Spotlight />`) shows whoever's talking big (their video if it's on,
otherwise their live character or outline, drawn big), with their name and
whether they're muted or speaking, and everyone else in it in a strip.
Clicking someone pins them big on that page (no one else sees it);
clicking them again goes back to following whoever's talking. The current
speaker (`activeSpeaker`) is held steady: a newcomer takes over after
talking for 0.7 s, a cough doesn't take it, the last speaker keeps
it while nobody talks, and you're never big on your own screen unless
you're alone. A call's video goes up in layers (up to 1280×720 where the
camera gives that much, 640×360, 320×180), and a publisher sends the
720p layer only while some page shows them big. It's all the page's
own doing: nothing new on the wire.

## Publishable keys (hosted, no server of yours)

On arugula.stream an app also has publishable keys (`pk_live_…` for its
allowed origins, `pk_test_…` for those and localhost), safe in a page.
The key only works from the origins you list for the app. Keys are
revocable.

**Signed-in members, with your own auth provider.** Set the app's issuer
(Clerk, Auth0, Firebase, Supabase or any OIDC provider; PROTOCOL.md,
"Members by sign-in"), then hand `connect()` the person's token from it.
`auth` is a token or a function for a fresh one, called on every
(re)connect; the relay checks it against the provider's keys, and the
member's id is their provider id, scoped to the issuer:

    connect({ room: "design-team", key: "pk_live_…", auth: () => getToken() })

    <arugula-room room="design-team" key="pk_live_…" auth></arugula-room>
    <script>document.querySelector("arugula-room").auth = () => getToken()</script>

    <PresenceRoom room="design-team" publishableKey="pk_live_…" auth={getToken}>

Where the token comes from, for each provider (and the issuer to set):

| provider | `auth` | issuer settings |
|---|---|---|
| Clerk | `() => Clerk.session.getToken()` | `{provider: "clerk", issuer: "https://<your Frontend API>"}`; add `"name": "{{user.full_name}}"` under Customize session token (or pass `name`) |
| Auth0 | `() => auth0.getTokenSilently()` (with `authorizationParams.audience`) | `{provider: "auth0", issuer: "<tenant>.auth0.com", audience: "<API identifier>"}` |
| Firebase | `() => getAuth().currentUser.getIdToken()` | `{provider: "firebase", project: "<project id>"}` |
| Supabase | `async () => (await supabase.auth.getSession()).data.session.access_token` | `{provider: "supabase", issuer: "https://<ref>.supabase.co"}` (asymmetric signing keys; legacy HS256 projects aren't supported) |
| OIDC | `async () => (await userManager.getUser()).id_token` | `{provider: "oidc", issuer: "<iss>", audience: "<client id>"}` |

A room rule keeps members to their rooms by a claim: `{"claim":
"org_id", "match": "prefix"}` admits org `acme`'s members to
`acme:standup` and no other org's rooms; `"match": "contains"` wants the
room in a list claim.

**Guests**, where the app allows them, come by name; the relay makes
their ids:

    connect({ room: "design-team", key: "pk_live_…", guest: "Ada" })

Where your server decides who's in which room, sign room tokens instead:

## Server: sign a room token (every language, same shape)

    createRoomToken({ app, secret, room, user: { id, name }, look?, ttl = 3600 }) -> string

An HS256 JWT. Claims are serialized compact (no spaces), in this order:
`app, room, sub, name, exp` then `look` (`{"character":n,"colour":n}`) if
given. The header is exactly `{"alg":"HS256","typ":"JWT"}`. base64url
without padding. So every SDK makes byte-identical tokens for the same
inputs (sdk/vectors.json), and the relay verifies them.

- Node/TS: `sdk/node` (`@arugula/presence-server`): `createRoomToken({...})`
- Python: `sdk/python` (`arugula_presence`): `create_room_token(app=, secret=, room=, user_id=, name=, look=None, ttl=3600)`
- Go: `sdk/go` (`arugula.stream/presence`): `presence.CreateRoomToken(presence.TokenOptions{...})`
- Elixir: `sdk/elixir` (`:arugula_presence`): `ArugulaPresence.create_room_token(app: , secret: , room: , user_id: , name: , look: nil, ttl: 3600)`
- Ruby: `sdk/ruby` (`arugula_presence`): `ArugulaPresence.create_room_token(app:, secret:, room:, user_id:, name:, look: nil, ttl: 3600)`

Each has a `now`/clock parameter for tests and zero dependencies beyond
the language's standard library (Elixir: :crypto + Jason, which Phoenix
apps already have). Each validates as PROTOCOL.md does, a little stricter
so every SDK's token is byte-identical:
- app and room ids: `[A-Za-z0-9_.:-]{1,128}`; user ids `[A-Za-z0-9_.:@-]{1,128}`;
- a name: 1–80 code points, no control characters (U+0000–001F, U+007F)
  and no U+2028/2029 (JSON encoders escape those differently);
- ttl 1–86400 seconds (Go: `TTL time.Duration`, zero is an hour);
- look: character and colour 0–255.
Node ships plain ESM `index.js` with a handwritten `index.d.ts` (no build).
