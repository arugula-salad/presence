// Agents: an API token lets an agent (Claude Code, Cursor, anything that
// speaks MCP) set up and manage this account's apps through the relay's
// MCP endpoint, /mcp, or a script call /api/v1 as the dashboard does. Make
// one here (it's shown once), copy the setup for your agent with it
// filled in, see when each was last used, revoke it.

import { useEffect, useState } from "preact/hooks";
import * as api from "./api";
import type { Token } from "./api";
import { Confirm, CopyButton, Section, Tabs, value } from "./ui";

const when = (iso: string) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });

/** How each agent adds the server, with `token` (or a placeholder). */
export function setups(mcp: string, token: string): Record<string, string> {
  const json = (key: string, extra: Record<string, string> = {}) =>
    JSON.stringify({ [key]: { arugula: { ...extra, url: mcp, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
  return {
    "Claude Code": `claude mcp add --transport http arugula ${mcp} \\\n  --header "Authorization: Bearer ${token}"`,
    Cursor: json("mcpServers"),
    "VS Code": json("servers", { type: "http" }),
    "Any MCP client": `URL:     ${mcp}\nHeader:  Authorization: Bearer ${token}\n\nStreamable HTTP, answered as JSON (no session, no stream).`,
  };
}

function NewToken({ onMade }: { onMade: (t: Token, secret: string) => void }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      class="row"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const { token, secret } = await api.makeToken(name.trim());
          onMade(token, secret);
          setName("");
          setErr("");
        } catch (e) {
          setErr((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <input type="text" maxLength={80} placeholder="What it's for: Claude Code on my laptop" aria-label="The token's name" value={name} onInput={(e) => setName(value(e))} />
      <button class="btn primary" type="submit" disabled={!name.trim() || busy}>
        Make a token
      </button>
      {err && (
        <span class="error" role="alert">
          {err}
        </span>
      )}
    </form>
  );
}

export function AgentsPage() {
  const [list, setList] = useState<Token[] | null>(null);
  const [err, setErr] = useState("");
  const [made, setMade] = useState<{ name: string; secret: string } | null>(null);
  useEffect(() => {
    api.tokens().then(setList, (e: Error) => setErr(e.message));
  }, []);
  const mcp = `${location.origin}/mcp`;
  const revoke = async (id: string) => {
    try {
      await api.revokeToken(id);
      setList((l) => (l ?? []).filter((t) => t.id !== id));
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <main class="agents-page">
      <h1 class="title">Agents</h1>
      <p class="lede small">
        Let an agent set up and run your apps: make them, add keys and origins, connect your sign-in, read usage. It works through our MCP server with
        an API token, which can do what you can here except make tokens and pay.
      </p>

      <Section id="tokens" title="API tokens" kind="--k-server" sub="Each token acts as you until you revoke it. Make one for each agent or machine, so you can revoke one without the others.">
        {made && (
          <div class="secret card" style={{ "--c": "var(--k-build)" }} role="status">
            <b>Your token for {made.name}</b>
            <p class="sub">This is the only time we can show it. The setup below has it filled in; copy that, or the token, now.</p>
            <div class="row">
              <code class="mono secret-value" aria-label="The API token">
                {made.secret}
              </code>
              <CopyButton text={made.secret} name="Copy the token" />
              <button class="btn small" onClick={() => setMade(null)}>
                I've kept it
              </button>
            </div>
          </div>
        )}
        {list && !list.length && <p class="empty">No tokens yet.</p>}
        {list && list.length > 0 && (
          <ul class="tokens">
            {list.map((t) => (
              <li key={t.id} class="token-row">
                <b>{t.name}</b>
                <code class="mono">{t.prefix}…</code>
                <span class="stats">
                  made {when(t.made)} · {t.last_used ? `last used ${when(t.last_used)}` : "never used"}
                </span>
                <span class="actions">
                  <Confirm label="Revoke" name={`Revoke ${t.name}`} question="Revoke it? Agents using it stop working." yes="Revoke" onYes={() => revoke(t.id)} />
                </span>
              </li>
            ))}
          </ul>
        )}
        <NewToken
          onMade={(t, secret) => {
            setList((l) => [t, ...(l ?? [])]);
            setMade({ name: t.name, secret });
          }}
        />
        {err && <p class="error">{err}</p>}
      </Section>

      <Section
        id="connect"
        title="Connect an agent"
        kind="--k-agent"
        sub={
          <>
            Our MCP server is at <code>{mcp}</code> <CopyButton text={mcp} name="Copy the MCP server's URL" />. Add it to your agent with a token:
          </>
        }
      >
        <Tabs tabs={setups(mcp, made?.secret ?? "ak_…")} label="Connect an agent" />
        <p class="hint">
          Cursor's goes in <code>~/.cursor/mcp.json</code> (or a project's <code>.cursor/mcp.json</code>), VS Code's in <code>.vscode/mcp.json</code>.
        </p>
        <p class="hint">
          Then ask it in your words: “make an arugula app for my site at https://app.example.com, with Clerk sign-in, and put the snippet in my page.” A
          token also works on the API the dashboard uses (<code>/api/v1</code>), as <code>Authorization: Bearer</code>.
        </p>
      </Section>
    </main>
  );
}
