import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  Info,
} from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { formatTimestamp } from "../format";
import { useRuntime } from "../runtime/RuntimeContext";
import "../styles/doctor.css";

interface DiagnosticEvidence {
  label: string;
  kind: string;
  value?: string;
}

interface Diagnostic {
  id: string;
  category: string;
  severity: "healthy" | "info" | "warning" | "error" | "unknown";
  title: string;
  summary: string;
  desired?: unknown;
  effective?: unknown;
  live?: unknown;
  evidence?: DiagnosticEvidence[];
  sourcePaths?: string[];
  remediation?: { action: string; target: string; label: string };
}

interface DoctorData {
  generatedAt: string;
  overall: string;
  counts: Record<string, number>;
  categories: Array<{ category: string; healthy: number; info: number; warning: number; error: number; unknown: number }>;
  diagnostics: Diagnostic[];
  system: {
    openCodeVersion?: string;
    omoPackageVersion?: string;
    omoManifestVersion?: string;
    activeConfiguredPreset?: string;
    runtimePresetKnown: boolean;
    runtimeStale: boolean;
    backendMode?: "managed" | "attach";
    backendOwnership?: "control-plane" | "external";
    backendStatus?: string;
    backendGeneration?: number;
  };
}

const CATS = [
  "all",
  "control-plane",
  "omo",
  "config",
  "providers",
  "agents",
  "prompts",
  "capabilities",
  "mcp",
  "acp",
  "companion",
  "interview",
  "sessions",
  "council",
  "revisions",
  "security",
  "environment",
  "version",
  "runtime",
  "models",
  "presets",
  "telemetry",
];

/** Segmented severity presets — same value sets as the legacy select. */
const SEV_OPTIONS = [
  { value: "warning,error,unknown,info", label: "Non-healthy" },
  { value: "error,warning", label: "Errors + warnings" },
  { value: "error", label: "Errors" },
  { value: "info,warning,error,unknown,healthy", label: "Everything" },
] as const;

function doctorRemediationHref(sel: Diagnostic): string {
  const target = sel.remediation?.target ?? "";
  if (sel.id.startsWith("multiplexer.") && target === "/system") {
    return "/system?section=multiplexer";
  }
  if (target.startsWith("/config")) return target;
  if (sel.category === "config" || sel.id.includes("schema") || sel.id.startsWith("interview.")) {
    const sourceId =
      /project/i.test(sel.summary + sel.id) || sel.sourcePaths?.some((p) => p.includes("/.opencode/"))
        ? "project-omo"
        : "user-omo";
    const path = sel.sourcePaths?.[0] ?? "";
    if (sel.id.includes("unavailable")) return "/system?section=schema";
    if (sel.id.includes("revision") || sel.category === "revisions") {
      return `/config?tab=revisions&sourceId=${sourceId}`;
    }
    const params = new URLSearchParams({ tab: "raw", sourceId });
    if (path) params.set("path", path);
    return `/config?${params.toString()}`;
  }
  return target || "/config";
}

function sevTone(s: Diagnostic["severity"]): string {
  if (s === "error") return "bad";
  if (s === "warning") return "warn";
  if (s === "healthy") return "ok";
  return "";
}

function SevIcon(props: { sev: Diagnostic["severity"] }) {
  const { sev } = props;
  if (sev === "error") return <AlertOctagon aria-hidden="true" />;
  if (sev === "warning") return <AlertTriangle aria-hidden="true" />;
  if (sev === "healthy") return <CheckCircle2 aria-hidden="true" />;
  if (sev === "info") return <Info aria-hidden="true" />;
  return <HelpCircle aria-hidden="true" />;
}

export function DoctorPage() {
  const [data, setData] = useState<DoctorData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [cat, setCat] = useState("all");
  const [sev, setSev] = useState<string>("warning,error,unknown,info");
  const [selected, setSelected] = useState<string | null>(null);
  const [showHealthy, setShowHealthy] = useState(false);
  const { lifecycle, retryLifecycle, refreshAll } = useRuntime();
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryNotice, setRetryNotice] = useState<string | null>(null);

  const onRetry = useCallback(async () => {
    if (!lifecycle?.error?.retryable) return;
    setRetryBusy(true);
    setRetryNotice(null);
    try {
      const next = await retryLifecycle();
      setRetryNotice(next.error ? "Retry accepted; awaiting backend update." : "Retry accepted.");
      void refreshAll().catch(() => {
        /* ignore transient */
      });
    } catch (e) {
      setRetryNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setRetryBusy(false);
    }
  }, [lifecycle, retryLifecycle, refreshAll]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/doctor");
      if (!r.ok) throw new Error(`doctor → ${r.status}`);
      setData(await r.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const recheck = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/doctor/recheck", { method: "POST" });
      setData(await r.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [load]);

  // Category filter options: hardcoded baseline plus any category the server
  // actually emits (e.g. new schema diagnostics land without a UI deploy).
  const catOptions = useMemo(() => {
    const base = CATS.filter((c) => c !== "all");
    const extra = (data?.categories ?? [])
      .map((c) => c.category)
      .filter((c) => !base.includes(c));
    return [...base, ...extra];
  }, [data]);

  const rows = useMemo(() => {
    if (!data) return [];
    const sevSet = new Set(sev.split(","));
    return data.diagnostics.filter((d) => {
      if (cat !== "all" && d.category !== cat) return false;
      if (!showHealthy && d.severity === "healthy") return false;
      if (!sevSet.has(d.severity)) return false;
      return true;
    });
  }, [data, cat, sev, showHealthy]);

  const sel = rows.find((r) => r.id === selected) ?? data?.diagnostics.find((d) => d.id === selected) ?? null;

  const overallClass =
    data?.overall === "error" ? "bad" : data?.overall === "degraded" ? "warn" : "ok";

  const backendStatusTone =
    data?.system.backendStatus === "connected" || lifecycle?.status === "connected"
      ? "ok"
      : data?.system.backendStatus === "failed" || lifecycle?.status === "failed"
        ? "bad"
        : "warn";

  const selectRow = (id: string) => setSelected(id);

  return (
    <div className="omo-doc">
      <PageHeader
        title="Doctor"
        meta={
          data
            ? `${formatTimestamp(data.generatedAt)} · ${data.diagnostics.length} diagnostics`
            : undefined
        }
        onRefresh={() => void recheck()}
        loading={loading}
      />
      {error ? <div className="error" role="alert">{error}</div> : null}

      {data ? (
        <>
          {/* Compact top summary — one rounded strip, no card mosaic. */}
          <div className="omo-doc-summary">
            <div className="omo-doc-stat">
              <span className="omo-doc-stat-label">Overall</span>
              <span className="omo-doc-stat-value">
                <span className={`pill ${overallClass}`}>{data.overall}</span>
              </span>
              <span className="omo-doc-stat-sub">
                <span className="omo-doc-count bad">{data.counts.error}</span>e ·{" "}
                <span className="omo-doc-count warn">{data.counts.warning}</span>w ·{" "}
                <span className="omo-doc-count">{data.counts.info}</span>i ·{" "}
                <span className="omo-doc-count">{data.counts.unknown}</span>u
              </span>
            </div>

            <div className="omo-doc-stat">
              <span className="omo-doc-stat-label">OpenCode</span>
              <span className="omo-doc-stat-value">
                {data.system.openCodeVersion ?? "—"}
              </span>
              <span className="omo-doc-stat-sub">
                OMO {data.system.omoPackageVersion ?? "?"} · manifest{" "}
                {data.system.omoManifestVersion ?? "?"}
              </span>
              {data.system.backendMode || lifecycle ? (
                <div
                  className="omo-doc-backend-pills"
                  data-testid="doctor-backend-mode"
                >
                  <span className="pill">
                    {data.system.backendMode === "managed"
                      ? "Managed"
                      : data.system.backendMode === "attach"
                        ? "Attached"
                        : lifecycle
                          ? "Unknown"
                          : "—"}
                  </span>
                  <span className="pill">
                    {data.system.backendOwnership === "control-plane"
                      ? "Control Plane"
                      : data.system.backendOwnership === "external"
                        ? "External"
                        : lifecycle
                          ? "Unknown"
                          : "—"}
                  </span>
                  <span
                    className={`pill ${backendStatusTone}`}
                    data-testid="doctor-backend-status"
                  >
                    {data.system.backendStatus ?? lifecycle?.status ?? "—"}
                  </span>
                </div>
              ) : null}
              {lifecycle?.status === "failed" && lifecycle.error ? (
                <div
                  className="omo-doc-failure"
                  data-testid="doctor-failure"
                  data-mode={lifecycle.mode}
                >
                  <strong>
                    {lifecycle.mode === "managed"
                      ? "Managed OpenCode failed to start"
                      : "Unable to reach configured OpenCode backend"}
                  </strong>
                  {lifecycle.error.message ? (
                    <div className="omo-doc-failure-msg">
                      {lifecycle.error.message}
                    </div>
                  ) : null}
                  {lifecycle.error.action ? (
                    <div className="omo-doc-failure-action">
                      {lifecycle.error.action}
                    </div>
                  ) : null}
                  {lifecycle.error.retryable ? (
                    <div className="toolbar">
                      <button
                        type="button"
                        className="btn"
                        data-testid="doctor-retry"
                        onClick={() => void onRetry()}
                        disabled={retryBusy}
                      >
                        {retryBusy ? "Retrying…" : "Retry"}
                      </button>
                    </div>
                  ) : null}
                  {retryNotice ? (
                    <div
                      role="status"
                      aria-live="polite"
                      className="muted"
                      data-testid="doctor-retry-notice"
                    >
                      {retryNotice}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {lifecycle?.status === "restarting" ? (
                <p
                  className="omo-doc-restarting"
                  data-testid="doctor-restarting-note"
                >
                  Restarting rather than stale: the control plane is bringing
                  the OpenCode backend back up automatically.
                </p>
              ) : null}
            </div>

            <div className="omo-doc-stat">
              <span className="omo-doc-stat-label">Preset</span>
              <span className="omo-doc-stat-value">
                {data.system.activeConfiguredPreset ?? "—"}
              </span>
              <span className="omo-doc-stat-sub">
                runtime preset {data.system.runtimePresetKnown ? "known" : "unknown"}
              </span>
            </div>

            <div className="omo-doc-stat">
              <span className="omo-doc-stat-label">Runtime</span>
              <span className="omo-doc-stat-value">
                <span className={`pill ${data.system.runtimeStale ? "warn" : "ok"}`}>
                  {data.system.runtimeStale ? "stale" : "live"}
                </span>
              </span>
            </div>
          </div>

          {/* Compact filters: category select + segmented severity. */}
          <div className="omo-doc-toolbar">
            <label className="omo-sr-only" htmlFor="doctor-category">
              Category
            </label>
            <select
              id="doctor-category"
              name="doctor-category"
              className="omo-doc-select"
              autoComplete="off"
              value={cat}
              onChange={(e) => setCat(e.target.value)}
            >
              <option value="all">all categories</option>
              {catOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <div
              className="omo-doc-seg"
              id="doctor-severity"
              role="group"
              aria-label="Severity"
            >
              {SEV_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className="omo-doc-seg-item"
                  aria-pressed={sev === o.value ? "true" : "false"}
                  onClick={() => setSev(o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <label className="omo-doc-toggle" htmlFor="doctor-show-healthy">
              <input
                id="doctor-show-healthy"
                name="doctor-show-healthy"
                type="checkbox"
                checked={showHealthy}
                onChange={(e) => setShowHealthy(e.target.checked)}
              />{" "}
              show healthy
            </label>
          </div>

          {/* One rounded diagnostic list + detail pane. */}
          <div className="omo-doc-frame">
            <div className="omo-doc-list">
              <table className="data">
                <thead>
                  <tr>
                    <th>Severity</th>
                    <th>Category</th>
                    <th>Diagnostic</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.id}
                      tabIndex={0}
                      aria-current={selected === r.id ? "true" : undefined}
                      onClick={() => selectRow(r.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          selectRow(r.id);
                        }
                      }}
                    >
                      <td>
                        <span className="omo-doc-sev" data-sev={r.severity}>
                          <SevIcon sev={r.severity} />
                          {r.severity}
                        </span>
                      </td>
                      <td className="mono">{r.category}</td>
                      <td>
                        <span className="omo-doc-cell-title" title={r.title}>
                          {r.title}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={3}>
                        <div className="omo-doc-empty">No diagnostics match.</div>
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            <section className="omo-doc-pane" aria-label="Diagnostic detail">
              {!sel ? (
                <div className="omo-doc-detail-empty">Select a diagnostic.</div>
              ) : (
                <div className="omo-doc-detail">
                  <h2 className="omo-doc-detail-title">{sel.title}</h2>
                  <div className="omo-doc-badges">
                    <span className={`pill ${sevTone(sel.severity)}`}>{sel.severity}</span>
                    <span className="pill">{sel.category}</span>
                    <span className="pill mono">{sel.id}</span>
                  </div>
                  <p className="omo-doc-summary-text">{sel.summary}</p>

                  {sel.desired !== undefined ? (
                    <div className="omo-doc-layer">
                      <div className="section-title">Desired</div>
                      <pre className="msg-pre">{JSON.stringify(sel.desired, null, 2)}</pre>
                    </div>
                  ) : null}
                  {sel.effective !== undefined ? (
                    <div className="omo-doc-layer">
                      <div className="section-title">Effective</div>
                      <pre className="msg-pre">{JSON.stringify(sel.effective, null, 2)}</pre>
                    </div>
                  ) : null}
                  {sel.live !== undefined ? (
                    <div className="omo-doc-layer">
                      <div className="section-title">Live</div>
                      <pre className="msg-pre">{JSON.stringify(sel.live, null, 2)}</pre>
                    </div>
                  ) : null}
                  {sel.evidence?.length ? (
                    <div>
                      <div className="section-title">Evidence</div>
                      <div className="omo-doc-evidence">
                        <table className="data">
                          <thead>
                            <tr>
                              <th>Label</th>
                              <th>Kind</th>
                              <th>Value</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sel.evidence.map((e, i) => (
                              <tr key={i}>
                                <td>{e.label}</td>
                                <td>{e.kind}</td>
                                <td className="mono">{e.value ?? "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : null}
                  {sel.sourcePaths?.length ? (
                    <div className="omo-doc-layer">
                      <div className="section-title">Source paths</div>
                      <pre className="msg-pre dim">{sel.sourcePaths.join("\n")}</pre>
                    </div>
                  ) : null}
                  {sel.remediation ? (
                    /* Multiplexer diagnostics (category "agents" in the
                       backend contract) deep-link straight to the
                       Multiplexer section of the System workspace. */
                    <Link className="omo-doc-remedy" to={doctorRemediationHref(sel)}>
                      {sel.remediation.label}
                    </Link>
                  ) : null}
                </div>
              )}
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}
