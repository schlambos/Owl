import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import { useModelAvailabilityOptional } from "../models/ModelAvailabilityContext";
import { ProbeBadge } from "../models/ProbeBadge";
import "../styles/specialists.css";

interface AcpAgent {
  name: string;
  sourceScopes: string[];
  config: Record<string, unknown>;
  envMasked: Record<string, string>;
  secretKeyCount: number;
  command?: string;
  wrapperModel?: string;
  permissionMode?: string;
  timeoutMs?: number;
  permission: string;
  commandResolution?: { status: string; path?: string; reason?: string };
  cwdAuthorized?: boolean | null;
  wrapperRegistered?: boolean;
  disabled?: boolean;
  warnings: string[];
}

interface AcpData {
  agents: AcpAgent[];
  note: string;
}

interface ProbeResult {
  ok: boolean;
  started: boolean;
  handshake: boolean;
  agentInfo?: { name?: string; version?: string; protocolVersion?: number };
  elapsedMs: number;
  error?: string;
  stderrTail?: string;
  stdoutTail?: string;
  terminated: boolean;
}

export function AcpPage() {
  const avail = useModelAvailabilityOptional();
  const [data, setData] = useState<AcpData | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [newName, setNewName] = useState("");
  const [newCommand, setNewCommand] = useState("");
  const [filter, setFilter] = useState("");
  const [sessions, setSessions] = useState<Array<{ id: string; agent?: string; title?: string; status?: string }>>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [inv, rt] = await Promise.all([
        fetch("/api/acp").then((r) => r.json()),
        fetch("/api/acp/runtime").then((r) => r.json()),
      ]);
      setData(inv);
      setSessions(rt.sessions ?? []);
      if (!selected && inv.agents?.[0]) setSelected(inv.agents[0].name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [selected]);

  useEffect(() => {
    void load();
  }, [load]);

  const agent = data?.agents.find((a) => a.name === selected) ?? null;

  const hash = async () => {
    const st = await fetch("/api/config/edit-state").then((r) => r.json());
    return st.user.hash;
  };

  const act = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/config/acp/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "acp",
          scope: "user",
          expectedSourceHash: await hash(),
          ...body,
        }),
      });
      const d = await r.json();
      if (!d.ok) {
        setError((d.errors || []).join("; "));
        return;
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!newName.trim() || !newCommand.trim()) return;
    await act({
      create: {
        name: newName.trim(),
        fields: { command: { operation: "set", value: newCommand.trim() } },
      },
    });
    setNewName("");
    setNewCommand("");
  };

  const remove = async () => {
    if (!selected) return;
    await act({ delete: { name: selected } });
  };

  const clone = async () => {
    if (!selected || !newName.trim()) return;
    await act({ create: { name: newName.trim(), cloneFrom: selected } });
    setNewName("");
  };

  const runProbe = async () => {
    if (!selected) return;
    setBusy(true);
    setProbe(null);
    setError(null);
    try {
      const r = await fetch("/api/acp/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: selected }),
      });
      setProbe(await r.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const visibleAgents = (data?.agents ?? []).filter(
    (a) =>
      a.name.toLowerCase().includes(filter.trim().toLowerCase()) ||
      (a.command ?? "").toLowerCase().includes(filter.trim().toLowerCase()),
  );

  return (
    <div className="omo-spec">
      <PageHeader
        title="ACP Agents"
        meta={data ? `${data.agents.length} configured` : undefined}
        onRefresh={() => void load()}
        loading={loading}
      />
      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}

      {/* External wrapper / runtime distinction: OMO wraps external ACP
          processes; native agents never appear on this surface. */}
      <div className="omo-spec-intro">
        <h2 className="omo-spec-intro-title">External ACP wrapper agents</h2>
        <p>{data?.note}</p>
        <p>
          Native OMO agents run inside OpenCode. ACP agents are OMO wrappers
          delegating to external ACP-compatible processes via{" "}
          <code>acp_run</code>. Wrapper gets deny-all permissions except{" "}
          <code>acp_run</code>.
        </p>
      </div>

      <div className="omo-spec-frame">
        <aside className="omo-spec-side" aria-label="ACP agents">
          <div className="omo-spec-side-head">
            <span>Agents</span>
            <span className="omo-spec-count">{visibleAgents.length}</span>
          </div>
          <input
            className="omo-spec-input"
            type="search"
            placeholder="Filter agents / commands…"
            aria-label="Filter ACP agents"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="omo-spec-list">
            {visibleAgents.map((a) => (
              <button
                key={a.name}
                type="button"
                className="omo-spec-row"
                aria-current={selected === a.name ? "true" : undefined}
                onClick={() => setSelected(a.name)}
              >
                <span className="omo-spec-row-title">{a.name}</span>
                <span className="omo-spec-row-meta mono">{a.command}</span>
                <span className="omo-spec-row-foot">
                  <span className={`pill ${a.wrapperRegistered ? "ok" : ""}`}>
                    {a.wrapperRegistered ? "live" : "config"}
                  </span>
                </span>
              </button>
            ))}
            {visibleAgents.length === 0 ? (
              <div className="omo-spec-list-empty">No ACP agents configured.</div>
            ) : null}
          </div>
          <div className="omo-spec-create">
            <input
              className="omo-spec-input"
              placeholder="new agent name"
              aria-label="New agent name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <input
              className="omo-spec-input mono"
              placeholder="command (e.g. npx)"
              aria-label="New agent command"
              value={newCommand}
              onChange={(e) => setNewCommand(e.target.value)}
            />
            <div className="omo-spec-create-actions">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void create()}
              >
                + Create
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy || !selected}
                onClick={() => void clone()}
              >
                Clone
              </button>
            </div>
          </div>
        </aside>

        <section className="omo-spec-pane">
          {!agent ? (
            <div className="omo-spec-detail-empty">Select an ACP agent.</div>
          ) : (
            <>
              <div className="omo-spec-head">
                <div className="omo-spec-head-text">
                  <h2 className="omo-spec-title">{agent.name}</h2>
                  <div className="omo-spec-badges">
                    <span className="pill">{agent.permissionMode}</span>
                    <span className={`pill ${agent.wrapperRegistered ? "ok" : ""}`}>
                      {agent.wrapperRegistered ? "wrapper live" : "not registered"}
                    </span>
                    {agent.disabled ? <span className="pill bad">disabled</span> : null}
                    {agent.secretKeyCount ? (
                      <span className="pill warn">{agent.secretKeyCount} secret env</span>
                    ) : null}
                  </div>
                </div>
                <div className="toolbar">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => void runProbe()}
                  >
                    Probe handshake
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => void remove()}
                  >
                    Delete
                  </button>
                </div>
              </div>

              <div className="omo-spec-body">
              {agent.warnings.map((w, i) => (
                <div key={i} className="error" role="status">
                  {w}
                </div>
              ))}

              <dl className="row-kv">
                <dt>command</dt>
                <dd>
                  {agent.command ?? "—"}
                  {agent.commandResolution ? (
                    <span
                      className={`pill ${agent.commandResolution.status === "resolved" ? "ok" : agent.commandResolution.status === "not-resolved" ? "warn" : ""} omo-spec-inline-pill`}
                    >
                      {agent.commandResolution.status}
                    </span>
                  ) : null}
                </dd>
                <dt>wrapper model</dt>
                <dd>{agent.wrapperModel ?? "fallback (oracle default)"}</dd>
                <dt>wrapper model probe</dt>
                <dd title="Probe of the wrapper's underlying model via OpenCode — separate from ACP handshake/process health below">
                  {(() => {
                    const raw = agent.wrapperModel;
                    if (!raw)
                      return <span className="muted">—</span>;
                    const slash = raw.indexOf("/");
                    if (slash <= 0 || !avail)
                      return <span className="muted">—</span>;
                    const av = avail.getModel(
                      raw.slice(0, slash),
                      raw.slice(slash + 1),
                    );
                    return av ? (
                      <ProbeBadge probe={av.probe} />
                    ) : (
                      <span className="muted">Not tested</span>
                    );
                  })()}
                </dd>
                <dt>timeout</dt>
                <dd>
                  {agent.timeoutMs ? `${agent.timeoutMs}ms` : "disabled (0)"}
                </dd>
                <dt>permission</dt>
                <dd className="omo-spec-kv-sans">{agent.permission}</dd>
                <dt>scopes</dt>
                <dd className="omo-spec-kv-sans">{agent.sourceScopes.join("+") || "—"}</dd>
                <dt>args</dt>
                <dd>
                  {Array.isArray(agent.config.args)
                    ? (agent.config.args as string[]).join(" ")
                    : "—"}
                </dd>
                <dt>cwd</dt>
                <dd>
                  {String(agent.config.cwd ?? "—")}
                  {agent.cwdAuthorized === false ? (
                    <span className="pill warn omo-spec-inline-pill">
                      outside scope
                    </span>
                  ) : null}
                </dd>
                <dt>env</dt>
                <dd>
                  {Object.entries(agent.envMasked ?? {})
                    .map(([k, v]) => `${k}=${v}`)
                    .join("\n") || "—"}
                </dd>
              </dl>

              <div className="section-title">Raw desired (masked)</div>
              <pre className="msg-pre raw-json">
                {JSON.stringify(agent.config, null, 2)}
              </pre>

              {probe ? (
                <div className="omo-spec-panel">
                  <h3>Handshake probe</h3>
                  <dl className="row-kv">
                    <dt>started</dt>
                    <dd className="omo-spec-kv-sans">{probe.started ? "yes" : "no"}</dd>
                    <dt>handshake</dt>
                    <dd>
                      <span className={`pill ${probe.handshake ? "ok" : "bad"}`}>
                        {probe.handshake ? "ok" : "failed"}
                      </span>
                    </dd>
                    <dt>agent info</dt>
                    <dd>
                      {probe.agentInfo
                        ? `${probe.agentInfo.name ?? "?"} ${probe.agentInfo.version ?? ""} (protocol ${probe.agentInfo.protocolVersion ?? "?"})`
                        : "—"}
                    </dd>
                    <dt>elapsed</dt>
                    <dd>{probe.elapsedMs}ms</dd>
                    <dt>terminated</dt>
                    <dd className="omo-spec-kv-sans">{probe.terminated ? "yes" : "no"}</dd>
                    {probe.error ? (
                      <>
                        <dt>error</dt>
                        <dd>{probe.error}</dd>
                      </>
                    ) : null}
                  </dl>
                  {probe.stderrTail ? (
                    <>
                      <div className="section-title">stderr (sanitized)</div>
                      <pre className="msg-pre dim">{probe.stderrTail}</pre>
                    </>
                  ) : null}
                </div>
              ) : null}
              </div>
            </>
          )}
        </section>
      </div>

      <div className="section-title">ACP-related sessions</div>
      <div className="omo-spec-table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>ID</th>
              <th>Agent</th>
              <th>Title</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {sessions.slice(0, 20).map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.id.slice(0, 14)}…</td>
                <td>{s.agent}</td>
                <td>{s.title}</td>
                <td>{s.status ?? "—"}</td>
              </tr>
            ))}
            {sessions.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted">
                  No ACP wrapper sessions visible.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
