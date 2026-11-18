import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import "./style.css";

type Generation = {
  active: number | null;
  gen: number;
  head: string;
  checkpoint: string;
  lag: string;
  phase: string;
  mapping: number;
  error: string | null;
  failures: number;
  scan_id: number;
  ceiling: number;
};
type Status = { tenant: string; role: string; generations: Generation[] };
type Hit = { id: number; title: string; body: string; version: string };
type Results = { generation: number; items: Hit[]; next: number | null };
type Audit = {
  checked: number;
  generation: number;
  differences: { id: number; kind: string }[];
  next: number | null;
  repaired: number;
};
async function request<T>(
  key: string,
  path: string,
  data?: unknown,
): Promise<T> {
  const response = await fetch("/api/v1/" + path, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      Authorization: "Bearer " + key,
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
function Workspace({ token, logout }: { token: string; logout: () => void }) {
  const [status, setStatus] = useState<Status | null>(null),
    [tab, setTab] = useState("Search"),
    [q, setQ] = useState(""),
    [applied, setApplied] = useState(""),
    [data, setData] = useState<Results | null>(null),
    [error, setError] = useState(""),
    [network, setNetwork] = useState(""),
    [report, setReport] = useState<Audit | null>(null),
    [busy, setBusy] = useState(false),
    [after, setAfter] = useState(0);
  const seq = useRef(0);
  async function search(term: string, append = false) {
    const n = ++seq.current;
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ q: term });
      if (append && data) {
        params.set("offset", String(data.next));
        params.set("gen", String(data.generation));
      }
      const res = await request<Results>(token, "search?" + params);
      if (n === seq.current) {
        setData({
          ...res,
          items: append ? [...(data?.items || []), ...res.items] : res.items,
        });
        setApplied(term);
      }
    } catch (e) {
      if (n === seq.current) setError((e as Error).message);
    } finally {
      if (n === seq.current) setBusy(false);
    }
  }
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const s = await request<Status>(token, "status");
        if (alive) {
          setStatus(s);
          setNetwork("");
        }
      } catch (e) {
        if (alive) setNetwork((e as Error).message);
      } finally {
        if (alive) timer = setTimeout(poll, 2500);
      }
    }
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [token]);
  const active = status?.generations.find((g) => g.gen === g.active);
  useEffect(() => {
    if (active) void search(applied);
  }, [active?.gen]);
  async function operate(path: string, body: unknown, cursor = 0) {
    setBusy(true);
    setError("");
    try {
      if (path === "audit") {
        setReport(await request<Audit>(token, path, body));
        setAfter(cursor);
      } else {
        await request(token, path, body);
        setReport(null);
      }
      setStatus(await request<Status>(token, "status"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <header>
        <b>≋ &nbsp; Index Tide</b>
        <span>
          {status?.tenant || "Workspace"} &nbsp; / &nbsp; {status?.role}
        </span>
        <button onClick={logout}>Disconnect</button>
      </header>
      <main>
        <nav aria-label="Workspace views">
          {["Search", "Index operations"].map((t) => (
            <button
              key={t}
              aria-current={t === tab ? "page" : undefined}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </nav>
        {(error || network) && <p role="alert">{error || network}</p>}
        {tab === "Search" ? (
          <>
            <h1>Search the collection</h1>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void search(q);
              }}
            >
              <label htmlFor="query">Search runbooks</label>
              <div className="row">
                <input
                  id="query"
                  type="search"
                  maxLength={160}
                  value={q}
                  placeholder="Try replica recovery"
                  onChange={(e) => setQ(e.target.value)}
                />
                <button className="primary" disabled={busy}>
                  Search
                </button>
              </div>
            </form>
            <p role="status">
              {data
                ? data.items.length +
                  " results shown · generation " +
                  data.generation
                : active
                  ? "Loading results…"
                  : "Waiting for the first index…"}
            </p>
            <section aria-label="Search results">
              {data?.items.map((h) => (
                <article key={h.id}>
                  <small>
                    RUNBOOK {String(h.id).padStart(3, "0")} · VERSION{" "}
                    {h.version}
                  </small>
                  <h2>{h.title}</h2>
                  <p>{h.body}</p>
                </article>
              ))}
              {data && !data.items.length && (
                <p>No runbooks matched. Try a broader term.</p>
              )}
            </section>
            {data?.next != null && (
              <button
                disabled={busy}
                onClick={() => void search(applied, true)}
              >
                Load more results
              </button>
            )}
          </>
        ) : (
          <>
            <h1>Index operations</h1>
            <div className="metrics">
              {[
                ["Active generation", active?.gen],
                ["Change lag", active?.lag],
                ["Source version", active?.head],
              ].map(([name, value]) => (
                <div key={name}>
                  <small>{name}</small>
                  <strong>{value ?? "—"}</strong>
                </div>
              ))}
            </div>
            <h2>Generations</h2>
            {status?.generations.map((g) => (
              <article key={g.gen}>
                <h3>
                  Generation {g.gen} · {g.gen === g.active ? "active" : g.phase}
                </h3>
                <p>
                  Mapping {g.mapping} · Checkpoint {g.checkpoint} · {g.lag}{" "}
                  changes behind
                </p>
                {g.phase === "scan" && (
                  <p>
                    Backfill cursor {g.scan_id} of {g.ceiling}
                  </p>
                )}
                {g.error && (
                  <p role="alert">
                    {g.error} · {g.failures} consecutive failures
                  </p>
                )}
                {status.role === "operator" && g.active !== g.gen && (
                  <button
                    disabled={
                      busy || g.phase !== "tail" || g.lag !== "0" || !!g.error
                    }
                    onClick={() =>
                      void operate("generations/" + g.gen + "/activate", {})
                    }
                  >
                    Activate generation {g.gen}
                  </button>
                )}
              </article>
            ))}
            {status?.role === "operator" && (
              <>
                <button
                  disabled={
                    busy || status.generations.some((g) => g.gen !== g.active)
                  }
                  onClick={() => void operate("generations", { mapping: 2 })}
                >
                  Build title-weighted index
                </button>
                <h2>Consistency audit</h2>
                <p>
                  Compare up to 32 source and index records per page, including
                  tombstones and unexpected keys.
                </p>
                <button
                  disabled={busy}
                  onClick={() => void operate("audit", { after: 0 })}
                >
                  Audit first page
                </button>
                {report && (
                  <div role="status">
                    <p>
                      Generation {report.generation} · {report.checked} checked
                      · {report.differences.length} differences ·{" "}
                      {report.repaired} repaired
                    </p>
                    <ul>
                      {report.differences.map((d) => (
                        <li key={d.id}>
                          Runbook {d.id} · {d.kind}
                        </li>
                      ))}
                    </ul>
                    {report.differences.length > 0 && !report.repaired && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void operate(
                            "audit",
                            {
                              after,
                              repair: true,
                              generation: report.generation,
                            },
                            after,
                          )
                        }
                      >
                        Repair this page
                      </button>
                    )}
                    {report.next !== null && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void operate(
                            "audit",
                            {
                              after: report.next,
                              generation: report.generation,
                            },
                            report.next!,
                          )
                        }
                      >
                        Audit next page
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </main>
    </>
  );
}
function App() {
  const [token, setToken] = useState(""),
    [input, setInput] = useState(""),
    [error, setError] = useState("");
  async function connect(e: FormEvent) {
    e.preventDefault();
    try {
      await request(input, "status");
      setToken(input);
      setInput("");
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (token) return <Workspace token={token} logout={() => setToken("")} />;
  return (
    <main className="login">
      <b>≋ &nbsp; Index Tide</b>
      <h1>Search workspace</h1>
      <p>Connect to your collection of engineering runbooks.</p>
      <form onSubmit={connect}>
        <label htmlFor="key">Workspace key</label>
        <input
          id="key"
          type="password"
          required
          autoComplete="off"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button className="primary">Connect</button>
      </form>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
