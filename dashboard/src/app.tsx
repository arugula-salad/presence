// One app, in tabs (each its own path, /apps/<id>/<tab>): an overview with
// what's left to set up and a snippet to paste with its own key; its keys
// (live and test) and the origins they work from; how its people sign in
// (and the room rule) and whether guests may come; its usage; its plan;
// and its settings: its name, and the server secret, which most apps
// never need.

import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import * as api from "./api";
import { go, path, type App, type Issuer, type Key, type Usage } from "./api";
import { fresh } from "./apps";
import { PRESETS, ProviderSection, RoomRuleSection } from "./provider";
import { Quickstart } from "./quickstart";
import { UsageSection } from "./usage";
import { BillingSection } from "./billing";
import { Confirm, CopyButton, Field, Section, value } from "./ui";

/** The app's tabs: the path after /apps/<id>/ ("" is the overview), and the name. */
export const TABS = [
  ["", "Overview"],
  ["keys", "Keys & origins"],
  ["sign-in", "Sign-in"],
  ["usage", "Usage"],
  ["billing", "Billing"],
  ["settings", "Settings"],
] as const;

export type Tab = (typeof TABS)[number][0];

/** The tab each section is on, for links to a section (`#origins`). */
const ON: Record<string, Tab> = {
  quickstart: "",
  setup: "",
  keys: "keys",
  origins: "keys",
  "sign-in": "sign-in",
  "room-rule": "sign-in",
  guests: "sign-in",
  usage: "usage",
  billing: "billing",
  name: "settings",
  secret: "settings",
};

/** The tab a path's segment names, or (for the overview's path) the one
 * holding the section in the hash. */
export function tabOf(segment: string, hash: string): Tab {
  const t = TABS.find(([p]) => p === segment);
  if (t && segment) return t[0];
  return ON[hash] ?? "";
}

const tabPath = (id: string, t: Tab) => path(`/apps/${id}${t ? `/${t}` : ""}`);

/** A secret on screen the one time it can be, until they say they've kept it. */
function Secret({ secret, onDone, made }: { secret: string; onDone: () => void; made: "new" | "rotated" }) {
  return (
    <div class="secret card" style={{ "--c": "var(--k-build)" }} role="status">
      <b>{made === "new" ? "Your app's server secret" : "Your new server secret"}</b>
      <p class="sub">
        This is the only time we can show it. You only need it if your own server signs room tokens; keep it there, never in a page.
        {made === "rotated" && " The old secret stops working within a minute."}
      </p>
      <div class="row">
        <code class="mono secret-value" aria-label="The server secret">
          {secret}
        </code>
        <CopyButton text={secret} name="Copy the secret" />
        <button class="btn small" onClick={onDone}>
          I've kept it
        </button>
      </div>
    </div>
  );
}

function KeyRow({ k, onRevoke }: { k: Key; onRevoke: () => Promise<void> }) {
  return (
    <li class="key-row" data-mode={k.mode}>
      <span class={`tag ${k.mode}`}>{k.mode}</span>
      <code class="mono key" title={k.key}>
        {k.key}
      </code>
      <span class="actions">
        <CopyButton text={k.key} name={`Copy ${k.mode} key ${k.key}`} />
        <Confirm label="Revoke" name={`Revoke ${k.key}`} question="Revoke it? Pages using it stop connecting." yes="Revoke" onYes={onRevoke} />
      </span>
    </li>
  );
}

function KeysSection({ app, onChange }: { app: App; onChange: (a: App) => void }) {
  const [err, setErr] = useState("");
  const make = async (mode: "live" | "test") => {
    try {
      const k = await api.makeKey(app.id, mode);
      onChange({ ...app, keys: [...app.keys, k] });
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const revoke = async (key: string) => {
    try {
      await api.revokeKey(app.id, key);
      onChange({ ...app, keys: app.keys.filter((k) => k.key !== key) });
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const live = app.keys.filter((k) => k.mode === "live");
  const test = app.keys.filter((k) => k.mode === "test");
  return (
    <Section id="keys" title="Keys" kind="--k-server" sub="Publishable keys are safe to put in your page: they only work from your origins. Use a test key while you build; it also works from your own computer.">
      {!app.keys.length && <p class="empty">No keys. Make one to connect.</p>}
      <ul class="keys">
        {[...live, ...test].map((k) => (
          <KeyRow key={k.key} k={k} onRevoke={() => revoke(k.key)} />
        ))}
      </ul>
      <div class="row">
        <button class="btn small" onClick={() => void make("live")}>
          New live key
        </button>
        <button class="btn small" onClick={() => void make("test")}>
          New test key
        </button>
      </div>
      {err && <span class="error">{err}</span>}
    </Section>
  );
}

function OriginsSection({ app, onChange }: { app: App; onChange: (a: App) => void }) {
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState("");
  const add = async () => {
    const o = draft.trim();
    if (!o) return;
    try {
      onChange(await api.addOrigin(app.id, o));
      setDraft("");
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const remove = async (o: string) => {
    try {
      onChange(await api.removeOrigin(app.id, o));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Section
      id="origins"
      title="Origins"
      kind="--k-test"
      sub={
        <>
          The sites your pages are on. A key only connects from these. Write each as <code>https://app.example.com</code>: the scheme, the host, and
          a port if it isn't the usual one, with no path. <code>https://*.example.com</code> covers every subdomain, but not{" "}
          <code>example.com</code> itself. Test keys also work from <code>localhost</code> and <code>127.0.0.1</code> on any port, so you
          needn't list those.
        </>
      }
    >
      {!app.origins.length && <p class="empty">No origins yet: live keys won't connect from anywhere until you add one.</p>}
      <ul class="origins">
        {app.origins.map((o) => (
          <li key={o}>
            <code class="mono">{o}</code>
            <button class="btn small" onClick={() => void remove(o)} aria-label={`Remove ${o}`}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form
        class="row"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input type="text" inputMode="url" placeholder="https://app.example.com" aria-label="An origin" value={draft} onInput={(e) => setDraft(value(e))} />
        <button class="btn" type="submit" disabled={!draft.trim()}>
          Add the origin
        </button>
      </form>
      {err && (
        <span class="error" role="alert">
          {err}
        </span>
      )}
    </Section>
  );
}

function GuestsSection({ app, onChange }: { app: App; onChange: (a: App) => void }) {
  const [err, setErr] = useState("");
  const flip = async () => {
    try {
      onChange(await api.updateApp(app.id, { guests: !app.guests }));
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Section id="guests" title="Guests" kind="--k-editor" sub="Guests come in with just a name, no sign-in: good for public rooms, demos and trying things out. Anyone on your site could join any room as a guest, and room rules don't apply to them.">
      <button class="switch" role="switch" aria-checked={app.guests} onClick={() => void flip()}>
        <span class="knob" aria-hidden="true" />
        {app.guests ? "Guests can join" : "Signed-in people only"}
      </button>
      {err && <span class="error">{err}</span>}
    </Section>
  );
}

function SecretSection({ app }: { app: App }) {
  const [secret, setSecret] = useState("");
  const [err, setErr] = useState("");
  return (
    <Section
      id="secret"
      title="Server secret"
      kind="--k-build"
      sub={
        <>
          Only for apps whose own server signs room tokens (see <a href="/docs#tokens">Room tokens</a>). With a key and your sign-in provider, you
          can leave it alone. We keep it encrypted and can't show it again; if it's lost or leaked, make a new one.
        </>
      }
    >
      {secret ? (
        <Secret secret={secret} made="rotated" onDone={() => setSecret("")} />
      ) : (
        <div class="row">
          <Confirm
            label="Make a new secret"
            question="Make a new one? The old secret stops working within a minute, so update your server first."
            yes="Make a new secret"
            onYes={async () => {
              try {
                setSecret(await api.rotateSecret(app.id));
                setErr("");
              } catch (e) {
                setErr((e as Error).message);
              }
            }}
          />
        </div>
      )}
      {err && <span class="error">{err}</span>}
    </Section>
  );
}

/** One step of setting up: done or not, and the tab to do it on. */
function Step({ done, title, to, children }: { done: boolean | null; title: string; to: string; children: ComponentChildren }) {
  return (
    <li class={done ? "step done" : done === false ? "step todo" : "step"}>
      <span class="mark-dot" aria-hidden="true">
        {done ? "✓" : ""}
      </span>
      <div>
        <a href={to} onClick={(e) => (e.preventDefault(), go(to))}>
          <b>{title}</b>
        </a>
        {done && <span class="visually-hidden"> (done)</span>}
        <p class="hint">{children}</p>
      </div>
    </li>
  );
}

/** What's done and what's left, in order, each a link to its tab. */
function Setup({ app, issuer }: { app: App; issuer: Issuer | null }) {
  // undefined: loading; null: this relay doesn't meter.
  const [usage, setUsage] = useState<Usage | null | undefined>(undefined);
  useEffect(() => {
    api.usage(app.id, 1).then(setUsage, () => setUsage(null));
  }, [app.id]);
  const live = app.keys.some((k) => k.mode === "live");
  const test = app.keys.some((k) => k.mode === "test");
  const joined = usage ? usage.this_month.active_users > 0 || usage.days.some((d) => d.active_users > 0) : null;
  const left = [!!app.keys.length, app.origins.length > 0, !!issuer || app.guests].filter((done) => !done).length;
  return (
    <Section
      id="setup"
      title={left ? "Setting up" : "Set up"}
      kind="--k-test"
      sub={left ? `${left} ${left === 1 ? "thing" : "things"} left to set up.` : "Everything's in place. Paste the snippet below into your page."}
    >
      <ol class="checklist">
        <Step done={!!app.keys.length} title="A key" to={tabPath(app.id, "keys")}>
          {app.keys.length
            ? `${live ? "A live key" : "No live key"}${test ? " and a test key" : ""}.${!test ? " A test key also works from your own computer." : ""}`
            : "Make one to connect: a test key for building, a live key for your site."}
        </Step>
        <Step done={app.origins.length > 0} title="Where your pages live" to={tabPath(app.id, "keys")}>
          {app.origins.length
            ? app.origins.join(", ")
            : "Live keys only connect from the sites you list. Test keys work from localhost meanwhile."}
        </Step>
        <Step done={!!issuer || app.guests} title="How people sign in" to={tabPath(app.id, "sign-in")}>
          {issuer
            ? `With ${PRESETS[issuer.provider].label}${issuer.room_rule ? ", with a room rule" : ""}${app.guests ? "; guests welcome too" : ""}.`
            : app.guests
              ? "As guests, by name. Connect your sign-in so people come in as themselves."
              : "Connect your sign-in provider, or let guests in by name."}
        </Step>
        <Step done={joined} title="People in your rooms" to={tabPath(app.id, "usage")}>
          {joined ? `${usage!.this_month.active_users.toLocaleString()} this month.` : "Paste the snippet below; the first person to join shows up here."}
        </Step>
      </ol>
    </Section>
  );
}

function NameSection({ app, onChange }: { app: App; onChange: (a: App) => void }) {
  const [draft, setDraft] = useState(app.name);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState(false);
  const save = async () => {
    try {
      onChange(await api.updateApp(app.id, { name: draft.trim() }));
      setErr("");
      setSaved(true);
    } catch (e) {
      setErr((e as Error).message);
      setSaved(false);
    }
  };
  return (
    <Section id="name" title="Name" kind="--k-editor" sub="Only you see it: here, and in the apps an agent lists.">
      <form
        class="fields"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="The app's name" error={err || undefined}>
          <input type="text" maxLength={80} value={draft} onInput={(e) => (setDraft(value(e)), setSaved(false))} />
        </Field>
        <div class="row">
          <button class="btn" type="submit" disabled={!draft.trim() || draft.trim() === app.name}>
            Rename
          </button>
          {saved && (
            <span class="ok" role="status">
              Saved.
            </span>
          )}
        </div>
      </form>
      <p class="hint">
        Its id, which room tokens and API calls name: <code>{app.id}</code>
      </p>
    </Section>
  );
}

export function AppPage({ id, tab }: { id: string; tab: Tab }) {
  const [app, setApp] = useState<App | null>(null);
  const [issuer, setIssuer] = useState<Issuer | null>(null);
  const [err, setErr] = useState("");
  const [secret, setSecret] = useState(fresh.id === id ? fresh.secret : "");
  useEffect(() => {
    // Shown once: a reload or a visit back doesn't bring it back.
    fresh.id = fresh.secret = "";
    Promise.all([api.getApp(id), api.issuer(id)]).then(
      ([a, i]) => (setApp(a), setIssuer(i)),
      (e: Error) => setErr(e.message),
    );
  }, [id]);
  // At phone width the tabs scroll sideways: keep this one in sight.
  useEffect(() => {
    document.querySelector(".app-tabs [aria-current]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [app, tab]);
  // A link to a section (#origins) scrolls to it once it's there.
  useEffect(() => {
    const at = location.hash.slice(1);
    if (app && at) document.getElementById(at)?.scrollIntoView();
  }, [app, tab]);
  if (err)
    return (
      <main class="app-page">
        <p class="error">{err === "no such app" ? "There's no app here, or it isn't yours." : err}</p>
        <a href={path("/")} onClick={(e) => (e.preventDefault(), go(path("/")))}>
          Back to your apps
        </a>
      </main>
    );
  if (!app) return <main class="app-page" aria-busy="true" />;
  const name = TABS.find(([t]) => t === tab)![1];
  return (
    <main class="app-page">
      <a class="back" href={path("/")} onClick={(e) => (e.preventDefault(), go(path("/")))}>
        ← Your apps
      </a>
      <header class="app-head">
        <h1 class="title">{app.name}</h1>
        <span class="stats">
          <code class="mono">{app.id}</code> <CopyButton text={app.id} name="Copy the app's id" />
        </span>
      </header>
      {secret && <Secret secret={secret} made="new" onDone={() => setSecret("")} />}
      <nav class="app-tabs" aria-label={`${app.name}'s pages`}>
        {TABS.map(([t, title]) => (
          <a href={tabPath(id, t)} aria-current={t === tab ? "page" : undefined} onClick={(e) => (e.preventDefault(), go(tabPath(id, t)))}>
            {title}
          </a>
        ))}
      </nav>
      <div class="sections" aria-label={name} role="region">
        {tab === "" && (
          <>
            <Setup app={app} issuer={issuer} />
            <Quickstart app={app} issuer={issuer} />
          </>
        )}
        {tab === "keys" && (
          <>
            <KeysSection app={app} onChange={setApp} />
            <OriginsSection app={app} onChange={setApp} />
          </>
        )}
        {tab === "sign-in" && (
          <>
            <ProviderSection app={app} issuer={issuer} onChange={setIssuer} />
            <RoomRuleSection app={app} issuer={issuer} onChange={setIssuer} />
            <GuestsSection app={app} onChange={setApp} />
          </>
        )}
        {tab === "usage" && <UsageSection app={app} />}
        {tab === "billing" && <BillingSection app={app} />}
        {tab === "settings" && (
          <>
            <NameSection app={app} onChange={setApp} />
            <SecretSection app={app} />
          </>
        )}
      </div>
    </main>
  );
}
