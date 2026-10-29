// arugula.stream's dashboard (#318 P10): where a customer signs in, makes
// apps, copies their keys, says where their pages live and how their
// people sign in, and sees what they've used. /dashboard lists the apps;
// /dashboard/apps/<id> is one app's overview, and /dashboard/apps/<id>/<tab>
// its other tabs (app.tsx's TABS); /dashboard/agents makes API tokens for
// agents (MCP). Served by the relay under /dashboard (api.ts's BASE), on
// the same session cookie as meet.

import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { BASE, accountName, go, me as fetchMe, path, providers as fetchProviders, signOut, type Account, type Providers } from "./api";
import { AppsPage } from "./apps";
import { AgentsPage } from "./agents";
import { AppPage, tabOf, type Tab } from "./app";
import { SignInPage } from "./signin";
import "./style.css";

type Route = { page: "apps" } | { page: "agents" } | { page: "app"; id: string; tab: Tab };

/** Which page a path is: `<base>/apps/<id>[/<tab>]`, `<base>/agents`, else
 * the apps. A link from before the tabs (`/apps/<id>#origins`) opens the
 * tab that section is on. */
function routeOf(pathname: string, hash: string): Route {
  const rest = pathname.slice(BASE.length);
  if (/^\/agents\/?$/.test(rest)) return { page: "agents" };
  const m = /^\/apps\/([^/]+)(?:\/([^/]+))?\/?$/.exec(rest);
  if (!m) return { page: "apps" };
  return { page: "app", id: decodeURIComponent(m[1]!), tab: tabOf(m[2] ?? "", hash.slice(1)) };
}

/** A link within the dashboard. */
function NavLink({ to, on, children }: { to: string; on: boolean; children: string }) {
  return (
    <a href={path(to)} aria-current={on ? "page" : undefined} onClick={(e) => (e.preventDefault(), go(path(to)))}>
      {children}
    </a>
  );
}

/** arugula.stream's name and the dashboard's, its pages, and who's in. */
export function Top({ me, onSignedOut, route }: { me: Account | null; onSignedOut: () => void; route?: Route }) {
  return (
    <header class="top">
      <a class="mark" href="/">
        arugula<span>.</span>stream
      </a>
      <a class="where" href={path("/")} onClick={(e) => (e.preventDefault(), go(path("/")))}>
        dashboard
      </a>
      <nav class="who">
        {me && (
          <>
            <NavLink to="/" on={route?.page === "apps" || route?.page === "app"}>
              Apps
            </NavLink>
            <NavLink to="/agents" on={route?.page === "agents"}>
              Agents
            </NavLink>
          </>
        )}
        <a href="/docs">Docs</a>
        {me && (
          <>
            <span class="stats" title={me.email ?? ""}>
              {me.email ?? accountName(me)}
            </span>
            <button
              class="btn small"
              onClick={async () => {
                await signOut().catch(() => undefined);
                onSignedOut();
              }}
            >
              Sign out
            </button>
          </>
        )}
      </nav>
    </header>
  );
}

function App() {
  const [where, setWhere] = useState(location.pathname + location.hash);
  const [me, setMe] = useState<Account | null | undefined>(undefined);
  const [ways, setWays] = useState<Providers>({ email: false, google: false });
  const [failed, setFailed] = useState("");
  const load = () =>
    Promise.all([fetchMe(), fetchProviders()])
      .then(([m, w]) => (setMe(m), setWays(w), setFailed("")))
      .catch((e: Error) => setFailed(e.message));
  useEffect(() => {
    void load();
    const moved = () => setWhere(location.pathname + location.hash);
    addEventListener("popstate", moved);
    return () => removeEventListener("popstate", moved);
  }, []);
  if (failed)
    return (
      <main class="lobby">
        <h2>The dashboard isn't answering</h2>
        <p class="sub">{failed}</p>
        <button class="btn" onClick={() => void load()}>
          Try again
        </button>
      </main>
    );
  if (me === undefined) return <main class="lobby" aria-busy="true" />;
  const signedOut = () => (setMe(null), go(path("/")));
  const route = routeOf(location.pathname, location.hash);
  return (
    <div class="page">
      <Top me={me} onSignedOut={signedOut} route={route} />
      {!me ? (
        <SignInPage ways={ways} returnTo={where.startsWith(BASE) ? where : path("/")} />
      ) : route.page === "app" ? (
        <AppPage key={route.id} id={route.id} tab={route.tab} />
      ) : route.page === "agents" ? (
        <AgentsPage />
      ) : (
        <AppsPage me={me} />
      )}
    </div>
  );
}

render(<App />, document.getElementById("app")!);
