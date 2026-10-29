// S45 spike: fake people in a LiveKit room, speaking LibriSpeech, with the
// transcriber dispatched to it. Headless Chromium, one page per person
// (page/speaker.html: livekit-client 2.23.0, the product's version), each
// publishing a WebAudio "microphone" and taking captions. Everything any
// page sees is logged to runs/<run>/speakers.jsonl, with a local stand-in
// for the relay's HTTP endpoint logging to runs/<run>/relay.jsonl.
//
//   ./with-livekit.sh node speakers.mjs <scenario> <run> [--dispatch api|token|none]
//       [--model deepgram/nova-3] [--gate vad|mute|none] [--keyterms a,b] [--post]
//
// The worker (agent.mjs) must be running. The room is s45:<run>:voice,
// shaped like the relay's voice rooms (<app>:<room>:voice).

import { chromium } from "playwright";
import { AccessToken, TrackSource } from "livekit-server-sdk";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { scenarios } from "./scenarios.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const [scenarioName, run] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const scenario = scenarios[scenarioName];
if (!scenario || !run) {
  console.log(`usage: node speakers.mjs <${Object.keys(scenarios).join("|")}> <run> [options]`);
  process.exit(2);
}
const dispatch = opt("--dispatch", "api");
const meta = {
  run,
  model: opt("--model", "deepgram/nova-3"),
  gate: opt("--gate", "vad"),
  keyterms: (opt("--keyterms", "") || "").split(",").filter(Boolean),
  text: true,
  ...(opt("--idle") ? { idle_s: Number(opt("--idle")) } : {}),
};
const POST_KEY = process.env.S45_POST_KEY ?? "local-spike-key";
const lkRoom = `s45:${run}:voice`;
const dir = join(here, "runs", run);
mkdirSync(dir, { recursive: true });
const LOG = join(dir, "speakers.jsonl");
const log = (o) => appendFileSync(LOG, JSON.stringify(o) + "\n");
const refs = JSON.parse(readFileSync(join(here, "fixtures", "refs.json"), "utf8"));
writeFileSync(join(dir, "meta.json"), JSON.stringify({ scenario: scenarioName, room: lkRoom, dispatch, ...meta, started: Date.now() }, null, 1));

// Static files for the pages, and the relay stand-in.
const roots = { "/lk/": join(here, "node_modules/livekit-client/dist/"), "/fixtures/": join(here, "fixtures/"), "/page/": join(here, "page/") };
const types = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".wav": "audio/wav", ".map": "application/json" };
const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/relay/transcript") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const ok = createHmac("sha256", POST_KEY).update(body).digest("hex") === req.headers["x-s45-signature"];
      const seg = JSON.parse(body);
      appendFileSync(join(dir, "relay.jsonl"), JSON.stringify({ t: Date.now(), ok, ...seg }) + "\n");
      res.writeHead(ok ? 204 : 401).end();
    });
    return;
  }
  const url = new URL(req.url, "http://x");
  for (const [p, root] of Object.entries(roots))
    if (url.pathname.startsWith(p)) {
      const f = normalize(join(root, url.pathname.slice(p.length)));
      if (f.startsWith(root) && existsSync(f)) {
        res.writeHead(200, { "content-type": types[extname(f)] ?? "application/octet-stream" });
        return res.end(readFileSync(f));
      }
    }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
if (args.includes("--post")) meta.post = `${base}/relay/transcript`;

const elixir = (...a) =>
  execFileSync("mise", ["exec", "-C", join(here, "../../relay"), "--", "elixir", join(here, "dispatch.exs"), ...a], { encoding: "utf8" }).trim();

async function token(identity, name) {
  const t = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { identity, name, ttl: 600 });
  // The relay's call grant (PresenceRelay.Calls.token/5).
  t.addGrant({ room: lkRoom, roomJoin: true, canPublish: true, canPublishSources: [TrackSource.MICROPHONE, TrackSource.CAMERA], canPublishData: false, canSubscribe: true });
  return t.toJwt();
}

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const pages = {};
let dispatched = false;

const ctl = {
  refs,
  t0: Date.now(),
  log,
  async join(name, { listen = false } = {}) {
    let page = pages[name];
    if (!page) {
      const ctx = await browser.newContext();
      page = await ctx.newPage();
      await page.exposeFunction("s45log", (o) => log(o));
      page.on("pageerror", (e) => log({ t: Date.now(), page: name, ev: "page_error", error: e.message }));
      await page.goto(`${base}/page/speaker.html?name=${name}${listen ? "&listen=1" : ""}`);
      await page.waitForFunction(() => window.s45ready);
      pages[name] = page;
    }
    const identity = `sub_${name.toLowerCase()}`;
    let jwt;
    // token-late: the room's first person has a plain token, the second
    // one with roomConfig (transcription turned on in a room that exists).
    const late = dispatch === "token-late" && Object.keys(pages).indexOf(name) === 1;
    if ((dispatch === "token" && !dispatched) || dispatch === "token-all" || late) {
      // The first person's token carries the dispatch (roomConfig.agents).
      const f = join(tmpdir(), `s45-token-${process.pid}`);
      console.log(elixir("token", lkRoom, identity, name, "s45-transcriber", f, JSON.stringify(meta)));
      jwt = readFileSync(f, "utf8");
      writeFileSync(f, "");
      dispatched = true;
    } else jwt = await token(identity, name);
    log({ t: Date.now(), page: name, ev: "join_call" });
    await page.evaluate(([u, t]) => window.s45.join(u, t), [process.env.LIVEKIT_URL, jwt]);
    if (dispatch === "api" && !dispatched) {
      // The room exists once someone's in it; then the relay dispatches.
      const r = elixir("create", lkRoom, "s45-transcriber", JSON.stringify(meta));
      log({ t: Date.now(), ev: "dispatch", via: "api", result: JSON.parse(r) });
      console.log(`dispatch: ${r.slice(0, 200)}`);
      dispatched = true;
    }
  },
  say(name, i) {
    const u = refs[name].utterances[i];
    return pages[name].evaluate(([w, id]) => window.s45.say(w, id), [u.wav, u.id]);
  },
  mute: (name) => pages[name].evaluate(() => window.s45.mute()),
  unmute: (name) => pages[name].evaluate(() => window.s45.unmute()),
  leave: (name) => pages[name].evaluate(() => window.s45.leave()),
  people: (name) => pages[name].evaluate(() => window.s45.people()),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
};

let failed = false;
try {
  console.log(`${scenarioName} → ${lkRoom} (${dispatch} dispatch, ${meta.model}, gate ${meta.gate}${meta.keyterms.length ? ", keyterms" : ""})`);
  await scenario(ctl);
  // Let the last finals and text streams land.
  await ctl.wait(4000);
  for (const n of Object.keys(pages)) log({ t: Date.now(), page: n, ev: "people_end", people: await ctl.people(n).catch(() => null) });
} catch (e) {
  failed = true;
  console.log(`FAIL ${e.stack}`);
} finally {
  for (const n of Object.keys(pages)) await ctl.leave(n).catch(() => {});
  await browser.close();
  server.close();
  log({ t: Date.now(), ev: "end" });
}
console.log(`${failed ? "failed" : "done"}: ${Math.round((Date.now() - ctl.t0) / 1000)} s; logs in runs/${run}/`);
process.exit(failed ? 1 : 0);
