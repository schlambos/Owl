import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Activity, HeartPulse, Server, Users } from "lucide-react";
import { useOmoRuntime } from "../hooks/useOmoRuntime";
import { useMultiplexer } from "../hooks/useMultiplexer";
import { WorkspaceHeader } from "../components/layout/WorkspaceHeader";
import { Button } from "../components/ui/Button";
import { StatusBadge } from "../components/ui/StatusBadge";
import { Surface } from "../components/ui/Surface";
import { useRuntime } from "../runtime/RuntimeContext";
import { mappingAuthoritative, muxTypeLabel } from "./system/multiplexer-utils";

interface ModelHealthCounts {
  referenced: number;
  probed: number;
  healthy: number;
  freshFailing: number;
  neverTested: number;
}

interface DoctorSummary {
  generatedAt: string;
  overall: string;
  counts: Record<string, number>;
  modelHealth?: ModelHealthCounts;
  top: Array<{ id: string; severity: string; title: string; summary: string }>;
}

function doctorTone(overall: string): "ok" | "warn" | "bad" {
  if (overall === "error") return "bad";
  if (overall === "degraded") return "warn";
  return "ok";
}

function findingTone(severity: string): "ok" | "warn" | "bad" | "neutral" {
  if (severity === "error") return "bad";
  if (severity === "warning") return "warn";
  return "neutral";
}

export function OverviewPage() {
  const { overview, connection, runtime, error, loading, refreshAll } =
    useRuntime();
  const [doctor, setDoctor] = useState<DoctorSummary | null>(null);
  const { snapshot: omo, error: omoError } = useOmoRuntime();
  const { dto: mux } = useMultiplexer(60000);
  const data = overview;

  const muxRow = (() => {
    if (!mux || !mappingAuthoritative(mux)) return null;
    const panes = mux.runtime.stores.sessions.filter((r) => r.paneId).length;
    return `Multiplexer ${muxTypeLabel(mux)} · ${mux.runtime.mapping.mappedJobs.length} mapped OMO jobs · ${panes} tracked panes`;
  })();

  const omoCounts = (() => {
    const jobs = omo?.jobs ?? [];
    return {
      total: jobs.length,
      running: jobs.filter((j) => j.state === "running").length,
      completed: jobs.filter((j) => j.state === "completed").length,
      error: jobs.filter((j) => j.state === "error").length,
      cancelled: jobs.filter((j) => j.state === "cancelled").length,
    };
  })();

  const bridgeRow = (() => {
    if (!omo) return null;
    if (!("bridge" in omo)) return "bridge —";
    return `Bridge ${omo.bridge?.connected ? "connected :8788" : "not configured"}`;
  })();

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/doctor/summary");
        if (!r.ok) return;
        if (!cancelled) setDoctor(await r.json());
      } catch {
        /* */
      }
    };
    void tick();
    const t = setInterval(tick, 15000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const sessionTotal = runtime?.sessions.total ?? data?.sessions.total ?? 0;
  const healthLabel = doctor?.overall ?? (data?.opencode.healthy ? "healthy" : "unknown");

  return (
    <div className="omo-overview">
      <WorkspaceHeader
        title="Overview"
        description="Environment health, team configuration, and live runtime at a glance."
        meta={data ? `fetched ${data.fetchedAt}` : undefined}
        actions={
          <Button onClick={() => void refreshAll()} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </Button>
        }
      />
      {error ? <div className="error">{error}</div> : null}

      {!data && loading ? <p className="omo-quiet">Loading…</p> : null}

      {data ? (
        <>
          <div className="omo-metric-grid">
            <Surface className="omo-metric" padding="md">
              <div className="omo-metric-kicker">
                <span className="omo-metric-label">
                  <HeartPulse aria-hidden="true" />
                  Health
                </span>
                <StatusBadge tone={doctor ? doctorTone(doctor.overall) : data.opencode.healthy ? "ok" : "bad"}>
                  {healthLabel}
                </StatusBadge>
              </div>
              <div className="omo-metric-value">
                {doctor
                  ? `${(doctor.counts.error ?? 0) + (doctor.counts.warning ?? 0)}`
                  : data.opencode.healthy
                    ? "Online"
                    : "Offline"}
              </div>
              <div className="omo-metric-sub">
                {doctor
                  ? `${doctor.counts.error ?? 0} errors · ${doctor.counts.warning ?? 0} warnings`
                  : data.opencode.version ?? "OpenCode status"}
              </div>
            </Surface>

            <Surface className="omo-metric" padding="md">
              <div className="omo-metric-kicker">
                <span className="omo-metric-label">
                  <Users aria-hidden="true" />
                  Team
                </span>
              </div>
              <div className="omo-metric-value">{data.omo.agentCount}</div>
              <div className="omo-metric-sub">
                {data.omo.preset ?? "no preset"} · {data.omo.customAgentCount} custom
              </div>
            </Surface>

            <Surface className="omo-metric" padding="md">
              <div className="omo-metric-kicker">
                <span className="omo-metric-label">
                  <Activity aria-hidden="true" />
                  Sessions
                </span>
              </div>
              <div className="omo-metric-value">{sessionTotal}</div>
              <div className="omo-metric-sub">
                {data.sessions.roots} roots · {data.sessions.children} children
              </div>
            </Surface>

            <Surface className="omo-metric" padding="md">
              <div className="omo-metric-kicker">
                <span className="omo-metric-label">
                  <Server aria-hidden="true" />
                  Providers
                </span>
              </div>
              <div className="omo-metric-value">
                {data.providers.connectedCount}
                <span className="omo-quiet"> / {data.providers.totalKnown}</span>
              </div>
              <div className="omo-metric-sub">connected / listed</div>
            </Surface>
          </div>

          <div className="omo-panel-grid">
            <Surface className="omo-panel" padding="lg">
              <h2 className="omo-panel-title">System health</h2>
              {doctor ? (
                <div className="omo-panel-stack">
                  <div className="omo-inline-actions">
                    <StatusBadge tone={doctorTone(doctor.overall)}>
                      {doctor.overall}
                    </StatusBadge>
                    <span className="omo-quiet">
                      {doctor.counts.error} errors · {doctor.counts.warning} warnings ·{" "}
                      {doctor.counts.info} info · {doctor.counts.unknown} unknown
                    </span>
                    <Link to="/doctor" className="omo-btn omo-btn-secondary omo-btn-sm">
                      Open Doctor
                    </Link>
                  </div>
                  {doctor.top.length ? (
                    <div className="omo-findings">
                      {doctor.top.slice(0, 4).map((d) => (
                        <div key={d.id} className="omo-finding">
                          <StatusBadge tone={findingTone(d.severity)}>
                            {d.severity}
                          </StatusBadge>
                          <span>{d.title}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="omo-quiet">No outstanding diagnostics.</p>
                  )}
                </div>
              ) : (
                <p className="omo-quiet">Doctor summary unavailable.</p>
              )}
            </Surface>

            <Surface className="omo-panel" padding="lg">
              <h2 className="omo-panel-title">OpenCode</h2>
              <div className="omo-panel-stack">
                <StatusBadge tone={data.opencode.healthy ? "ok" : "bad"}>
                  {data.opencode.healthy ? "Online" : "Offline"}
                </StatusBadge>
                <dl className="omo-kv">
                  <dt>Version</dt>
                  <dd>{data.opencode.version ?? "—"}</dd>
                  <dt>REST</dt>
                  <dd>{connection.rest}</dd>
                  <dt>SSE</dt>
                  <dd>
                    {connection.sse}
                    {connection.stale ? " · STALE" : ""}
                  </dd>
                </dl>
                {data.opencode.error ? (
                  <div className="error">{data.opencode.error}</div>
                ) : null}
                <details className="omo-disclose">
                  <summary>Connection path</summary>
                  <div className="omo-mono">{data.opencode.baseUrl}</div>
                </details>
              </div>
            </Surface>

            <Surface className="omo-panel" padding="lg">
              <h2 className="omo-panel-title">OMO Config</h2>
              <div className="omo-panel-stack">
                <div className="omo-metric-value omo-metric-value-sm">
                  {data.omo.preset ?? "—"}
                </div>
                <p className="omo-quiet">
                  {data.omo.packageHint ?? "package unknown"} · agents {data.omo.agentCount} ·
                  custom {data.omo.customAgentCount} · presets {data.omo.presetCount}
                </p>
                <details className="omo-disclose">
                  <summary>Config paths</summary>
                  <dl className="omo-kv">
                    <dt>directory</dt>
                    <dd className="omo-mono">{data.opencode.directory ?? "—"}</dd>
                    <dt>config</dt>
                    <dd className="omo-mono">{data.opencode.configDir ?? "—"}</dd>
                    <dt>user OMO</dt>
                    <dd className="omo-mono">{data.omo.userConfigPath ?? "—"}</dd>
                    <dt>project OMO</dt>
                    <dd className="omo-mono">{data.omo.projectConfigPath ?? "(none)"}</dd>
                  </dl>
                </details>
              </div>
            </Surface>

            <Surface className="omo-panel" padding="lg">
              <h2 className="omo-panel-title">Runtime</h2>
              <div className="omo-panel-stack">
                <dl className="omo-kv">
                  <dt>Sessions</dt>
                  <dd>
                    {sessionTotal}
                    {runtime?.sessions.byStatus
                      ? ` · ${Object.entries(runtime.sessions.byStatus)
                          .map(([k, v]) => `${k}:${v}`)
                          .join(" ")}`
                      : ""}
                  </dd>
                  <dt>OMO jobs</dt>
                  <dd>
                    {omoError && !omo
                      ? `telemetry unavailable: ${omoError}`
                      : !omo
                        ? "loading…"
                        : omoCounts.total === 0
                          ? "No OMO task activity observed"
                          : `${omoCounts.running} running · ${omoCounts.completed} completed · ${omoCounts.error} error · ${omoCounts.cancelled} cancelled${omo.stale ? " · stale" : ""}`}
                  </dd>
                  <dt>Bridge</dt>
                  <dd>{bridgeRow ?? "bridge —"}</dd>
                </dl>
                {muxRow ? (
                  <p className="omo-quiet" data-testid="overview-multiplexer">
                    {muxRow}
                  </p>
                ) : null}
                <p className="omo-quiet">
                  Runtime preset unavailable (installed 2.2.10 closure)
                </p>
              </div>
            </Surface>

            <Surface className="omo-panel" padding="lg">
              <h2 className="omo-panel-title">Model health</h2>
              {doctor?.modelHealth ? (
                <div className="omo-panel-stack">
                  <div className="omo-metric-value">
                    {doctor.modelHealth.referenced}
                    <span className="omo-quiet"> referenced</span>
                  </div>
                  <p className="omo-quiet">
                    {doctor.modelHealth.probed} probed · {doctor.modelHealth.healthy} healthy
                    {doctor.modelHealth.freshFailing > 0
                      ? ` · ${doctor.modelHealth.freshFailing} fresh failing`
                      : ""}
                  </p>
                  <p className="omo-quiet">
                    {doctor.modelHealth.neverTested} never tested
                  </p>
                  {doctor.modelHealth.freshFailing > 0 ? (
                    <StatusBadge tone="bad">
                      {doctor.modelHealth.freshFailing} fresh failing
                    </StatusBadge>
                  ) : null}
                  <Link to="/models" className="omo-btn omo-btn-secondary omo-btn-sm">
                    Open Models
                  </Link>
                </div>
              ) : (
                <div className="omo-panel-stack">
                  <p className="omo-quiet">model inventory unavailable</p>
                  <Link to="/models" className="omo-btn omo-btn-secondary omo-btn-sm">
                    Open Models
                  </Link>
                </div>
              )}
            </Surface>

            <Surface className="omo-panel" padding="lg">
              <h2 className="omo-panel-title">Providers & capabilities</h2>
              <div className="omo-panel-stack">
                <dl className="omo-kv">
                  <dt>Connected</dt>
                  <dd>
                    {data.providers.connected.length
                      ? data.providers.connected.join(", ")
                      : "none"}
                  </dd>
                  <dt>MCP</dt>
                  <dd>
                    {Object.keys(data.mcp).length === 0
                      ? "none"
                      : Object.entries(data.mcp)
                          .map(([k, v]) => `${k}: ${v.status}`)
                          .join(" · ")}
                  </dd>
                  <dt>Permissions</dt>
                  <dd>{data.permissions?.length ?? 0} outstanding</dd>
                </dl>
              </div>
            </Surface>
          </div>

          {data.omo.warnings.length > 0 ? (
            <Surface className="omo-panel" padding="lg">
              <h2 className="omo-panel-title">Config warnings</h2>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Kind</th>
                      <th>Message</th>
                      <th>Path</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.omo.warnings.map((w, i) => (
                      <tr key={i}>
                        <td>{w.kind}</td>
                        <td>{w.message}</td>
                        <td className="mono">{w.path ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Surface>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
