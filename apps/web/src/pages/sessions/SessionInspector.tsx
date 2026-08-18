import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MultiplexerSessionRecord,
  MultiplexerSystemDto,
  NormalizedMessagePart,
  SessionDetail,
  SessionMessageSummary,
} from "@omo/shared";
import { api } from "../../api";
import { useRuntime } from "../../runtime/RuntimeContext";
import { useOmoRuntime } from "../../hooks/useOmoRuntime";
import { useMultiplexer } from "../../hooks/useMultiplexer";
import { Button } from "../../components/ui/Button";
import { StatusBadge } from "../../components/ui/StatusBadge";
import type { OmoJob } from "../omo-runtime-types";
import {
  OmoJobRow,
  jobLabel,
  jobTone,
  sortJobsRecent,
} from "./OmoJobsPanel";
import { muxTypeLabel, recordStateLabel } from "../system/multiplexer-utils";
import { statusTone } from "./SessionTree";

type Tab =
  | "overview"
  | "messages"
  | "activity"
  | "diff"
  | "permissions"
  | "omo"
  | "raw";

function fmtHMS(ms?: number): string {
  if (ms == null) return "—";
  try {
    return new Date(ms).toLocaleTimeString();
  } catch {
    return String(ms);
  }
}

const OMO_FOOTER =
  "Derived from persisted OpenCode task-tool parts (telemetrySchema 1). OMO board internals (reuse counts, eligibility, fallback chains, runtime preset) unavailable in installed 2.2.10.";

function fmtTime(ms?: number): string {
  if (ms == null) return "—";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

function ago(ms?: number): string {
  if (ms == null) return "—";
  const d = Date.now() - ms;
  if (d < 0) return "—";
  if (d < 1000) return "just now";
  if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3600_000) return `${Math.floor(d / 60_000)}m ago`;
  return `${Math.floor(d / 3600_000)}h ago`;
}

function elapsed(created?: number, updated?: number): string {
  if (created == null) return "—";
  const end = updated ?? Date.now();
  const s = Math.max(0, Math.floor((end - created) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function Expandable({
  title,
  children,
  defaultOpen,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="omo-sess-disclose">
      <button
        type="button"
        className="omo-sess-disclose-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="omo-sess-disclose-chevron" aria-hidden="true">
          ▶
        </span>{" "}
        {title}
      </button>
      {open ? (
        <div className="omo-sess-disclose-body">{children}</div>
      ) : null}
    </div>
  );
}

function PartView({ part }: { part: NormalizedMessagePart }) {
  if (part.kind === "text") {
    return (
      <div
        className={`omo-sess-part ${part.synthetic ? "omo-sess-part-synthetic" : ""}`}
      >
        <pre className="omo-sess-pre">{part.text}</pre>
        {part.truncated ? (
          <span className="omo-badge omo-badge-warn">truncated</span>
        ) : null}
      </div>
    );
  }
  if (part.kind === "reasoning") {
    return (
      <Expandable title="reasoning">
        <pre className="omo-sess-pre omo-sess-pre-dim">{part.text}</pre>
      </Expandable>
    );
  }
  if (part.kind === "tool" && part.tool) {
    const t = part.tool;
    return (
      <div className="omo-sess-part">
        <div className="omo-sess-tool-head">
          <span className="omo-badge omo-mono">{t.name}</span>
          <StatusBadge
            tone={
              t.status === "completed"
                ? "ok"
                : t.status === "error"
                  ? "bad"
                  : "warn"
            }
          >
            {t.status}
          </StatusBadge>
          {t.title ? <span className="omo-sess-note">{t.title}</span> : null}
        </div>
        {t.inputSummary ? (
          <div className="omo-sess-tool-summary">{t.inputSummary}</div>
        ) : null}
        <Expandable title="input / output">
          {t.input != null ? (
            <pre className="omo-sess-pre omo-sess-pre-dim">
              {JSON.stringify(t.input, null, 2)}
            </pre>
          ) : null}
          {t.output ? <pre className="omo-sess-pre">{t.output}</pre> : null}
          {t.error ? (
            <pre className="omo-sess-pre omo-sess-pre-error">{t.error}</pre>
          ) : null}
        </Expandable>
      </div>
    );
  }
  if (part.kind === "subtask" && part.subtask) {
    return (
      <div className="omo-sess-part">
        <span className="omo-badge">subtask → {part.subtask.agent}</span>
        <div className="omo-sess-note">{part.subtask.description}</div>
        {part.subtask.prompt ? (
          <Expandable title="subtask prompt">
            <pre className="omo-sess-pre">{part.subtask.prompt}</pre>
          </Expandable>
        ) : null}
      </div>
    );
  }
  if (part.kind === "step-start" || part.kind === "step-finish") {
    return (
      <div className="omo-sess-part omo-sess-part-step">
        <span className="omo-badge">{part.kind}</span>
      </div>
    );
  }
  if (part.kind === "file" && part.file) {
    return (
      <div className="omo-sess-part omo-mono">
        file {part.file.filename ?? part.file.url ?? "—"}
      </div>
    );
  }
  return (
    <div className="omo-sess-part omo-sess-note">
      <span className="omo-badge">{part.rawType}</span> (unstructured)
    </div>
  );
}

function MessageCard({ m }: { m: SessionMessageSummary }) {
  return (
    <div className="omo-sess-msg">
      <div className="omo-sess-msg-head">
        <StatusBadge tone={m.role === "user" ? "ok" : "neutral"}>
          {m.role}
        </StatusBadge>
        {m.agent ? <span className="omo-badge">{m.agent}</span> : null}
        <span className="omo-sess-note omo-mono">{fmtTime(m.createdAt)}</span>
        {m.cost != null ? (
          <span className="omo-sess-note">${m.cost.toFixed(4)}</span>
        ) : null}
        {m.error ? <StatusBadge tone="bad">error</StatusBadge> : null}
      </div>
      {m.parts.map((p) => (
        <PartView key={p.id} part={p} />
      ))}
    </div>
  );
}

export function SessionInspector(props: {
  sessionId: string | null;
  onSelect: (id: string) => void;
}) {
  const { connection, runtime } = useRuntime();
  const [tab, setTab] = useState<Tab>("overview");
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const lastReason = useRef<string>("");
  const selectedLive = runtime?.sessions.flat.find((s) => s.id === props.sessionId);
  // Multiplexer mapping for this exact OpenCode session ID (bridge v2
  // authoritative only). No mapping → the section is omitted entirely.
  const { dto: mux } = useMultiplexer(30000);
  const muxRecord: MultiplexerSessionRecord | undefined = props.sessionId
    ? mux?.runtime.mapping.bySessionId[props.sessionId]
    : undefined;

  const load = useCallback(
    async (id: string, force = false) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setLoading(true);
      setError(null);
      try {
        const d = await api.sessionDetail(id, force);
        if (ac.signal.aborted) return;
        setDetail(d);
      } catch (e) {
        if (ac.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!props.sessionId) {
      setDetail(null);
      return;
    }
    void load(props.sessionId);
    return () => abortRef.current?.abort();
  }, [props.sessionId, load]);

  // Debounced refresh when runtime updates for this session
  useEffect(() => {
    if (!props.sessionId || !runtime) return;
    const reason = `${runtime.fetchedAt}:${selectedLive?.status}:${selectedLive?.time?.updated}:${runtime.permissions.length}`;
    if (reason === lastReason.current) return;
    lastReason.current = reason;
    const t = setTimeout(() => {
      void load(props.sessionId!, false);
    }, 400);
    return () => clearTimeout(t);
  }, [
    props.sessionId,
    runtime?.fetchedAt,
    selectedLive?.status,
    selectedLive?.time?.updated,
    runtime?.permissions.length,
    load,
    runtime,
    selectedLive,
  ]);

  if (!props.sessionId) {
    return (
      <div className="omo-sess-inspector omo-sess-inspector-empty">
        <p>Select a session from the tree.</p>
      </div>
    );
  }

  const d = detail;
  const status = selectedLive?.status ?? d?.status ?? "—";

  return (
    <div className="omo-sess-inspector">
      <div className="omo-sess-head">
        <div className="omo-sess-head-text">
          <h2 className="omo-sess-title">
            {d?.agent ?? selectedLive?.agent ?? "session"}
            <span className="omo-sess-title-sep"> · </span>
            {(d?.title ?? selectedLive?.title ?? props.sessionId).slice(0, 60)}
          </h2>
          <div className="omo-sess-badges">
            <StatusBadge tone={statusTone(status)}>{status}</StatusBadge>
            {d?.model ? (
              <span className="omo-badge omo-mono">
                {d.model.providerID}/{d.model.modelID}
                {d.model.variant ? ` (${d.model.variant})` : ""}
              </span>
            ) : null}
            {connection.stale || d?.stale ? (
              <span className="omo-badge omo-badge-warn">stale</span>
            ) : null}
            {d && !d.exists ? (
              <span className="omo-badge omo-badge-bad">missing</span>
            ) : null}
            {loading ? <span className="omo-sess-loading">loading…</span> : null}
          </div>
        </div>
        <div className="toolbar">
          <Button size="sm" onClick={() => void load(props.sessionId!, true)}>
            Refresh
          </Button>
        </div>
      </div>

      {error ? (
        <div className="error omo-sess-banner" role="alert">
          {error}
        </div>
      ) : null}
      {d?.errors?.length ? (
        <div className="error omo-sess-banner" role="alert">
          {d.errors.map((e, i) => (
            <div key={i}>{e}</div>
          ))}
        </div>
      ) : null}

      <div
        className="omo-sess-tabs"
        role="tablist"
        aria-label="Session inspector views"
      >
        {(
          [
            "overview",
            "messages",
            "activity",
            "diff",
            "permissions",
            "omo",
            "raw",
          ] as Tab[]
        ).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            className="omo-sess-tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
          >
            {t}
            {t === "messages" && d ? ` (${d.messages.length})` : ""}
            {t === "activity" && d ? ` (${d.activity.length})` : ""}
            {t === "diff" && d && !d.diff.empty
              ? ` (+${d.diff.totalAdditions}/-${d.diff.totalDeletions})`
              : ""}
            {t === "permissions" && d ? ` (${d.permissions.length})` : ""}
          </button>
        ))}
      </div>

      <div className="omo-sess-body">
        {!d && loading ? <p className="omo-sess-note">Loading session…</p> : null}
        {d && tab === "overview" ? (
          <OverviewTab
            d={d}
            onSelect={props.onSelect}
            mux={mux && muxRecord ? { dto: mux, record: muxRecord } : undefined}
          />
        ) : null}
        {d && tab === "messages" ? (
          <div className="omo-sess-msgs">
            {d.initialInstruction ? (
              <div className="omo-sess-task">
                <div className="omo-sess-section-title">
                  {d.initialInstructionLabel}
                </div>
                <pre className="omo-sess-pre">{d.initialInstruction}</pre>
              </div>
            ) : (
              <p className="omo-sess-note">
                No initial user/delegation message found.
              </p>
            )}
            {d.messages.length === 0 ? (
              <p className="omo-sess-note">No messages.</p>
            ) : (
              d.messages.map((m) => <MessageCard key={m.id} m={m} />)
            )}
          </div>
        ) : null}
        {d && tab === "activity" ? (
          <div className="omo-sess-table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Kind</th>
                  <th>Label</th>
                  <th>Detail</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {d.activity.map((a) => (
                  <tr key={a.id}>
                    <td className="omo-mono">{a.at ? fmtTime(a.at) : "—"}</td>
                    <td>{a.kind}</td>
                    <td className="omo-mono">{a.label}</td>
                    <td className="omo-mono">{a.detail ?? "—"}</td>
                    <td>{a.status ?? "—"}</td>
                  </tr>
                ))}
                {d.activity.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="omo-sess-note">
                      No tool/step activity extracted.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        ) : null}
        {d && tab === "diff" ? <DiffTab d={d} /> : null}
        {d && tab === "permissions" ? (
          <div className="omo-sess-body">
            <div className="omo-sess-section-title">Pending (live store)</div>
            {d.permissions.length === 0 ? (
              <p className="omo-sess-note">
                No outstanding permissions for this session.
              </p>
            ) : (
              <div className="omo-sess-table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Permission</th>
                      <th>Patterns</th>
                      <th>Asked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.permissions.map((p) => (
                      <tr key={p.id}>
                        <td className="omo-mono">{p.id}</td>
                        <td>{p.permission ?? "—"}</td>
                        <td className="omo-mono">
                          {(p.patterns ?? []).join(", ") || "—"}
                        </td>
                        <td className="omo-mono">{p.askedAt}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="omo-sess-note omo-sess-note-indent">
              Permission reply (allow/deny) deferred — OpenCode exposes{" "}
              <code>POST /permission/{"{id}"}/reply</code>. Read-only in this
              slice.
            </p>
          </div>
        ) : null}
        {tab === "omo" ? (
          <OmoTab sessionId={props.sessionId!} onSelect={props.onSelect} />
        ) : null}
        {d && tab === "raw" ? (
          <pre className="omo-sess-pre omo-sess-pre-raw">
            {JSON.stringify(
              {
                id: d.id,
                parentID: d.parentID,
                title: d.title,
                agent: d.agent,
                model: d.model,
                status: d.status,
                cost: d.cost,
                tokens: d.tokens,
                summary: d.summary,
                directory: d.directory,
                errors: d.errors,
                messageCount: d.messages.length,
                activityCount: d.activity.length,
                diff: {
                  empty: d.diff.empty,
                  files: d.diff.files.length,
                  additions: d.diff.totalAdditions,
                  deletions: d.diff.totalDeletions,
                },
                agentCompare: d.agentCompare,
              },
              null,
              2,
            )}
          </pre>
        ) : null}
      </div>
    </div>
  );
}

function OverviewTab({
  d,
  onSelect,
  mux,
}: {
  d: SessionDetail;
  onSelect: (id: string) => void;
  /** Authoritative multiplexer mapping for this session — omitted otherwise. */
  mux?: { dto: MultiplexerSystemDto; record: MultiplexerSessionRecord };
}) {
  return (
    <div className="omo-sess-grid">
      <div className="omo-sess-panel">
        <h2 className="omo-sess-panel-title">Metadata</h2>
        <dl className="omo-sess-kv">
          <dt>Session ID</dt>
          <dd className="omo-mono">{d.id}</dd>
          <dt>Parent ID</dt>
          <dd className="omo-mono">
            {d.parentID ? (
              <button type="button" className="linkish" onClick={() => onSelect(d.parentID!)}>
                {d.parentID}
              </button>
            ) : (
              "—"
            )}
          </dd>
          <dt>Agent</dt>
          <dd>{d.agent ?? "—"}</dd>
          <dt>Model</dt>
          <dd className="omo-mono">
            {d.model
              ? `${d.model.providerID}/${d.model.modelID}${d.model.variant ? ` · ${d.model.variant}` : ""}`
              : "—"}
          </dd>
          <dt>Status</dt>
          <dd>{d.status ?? "—"}</dd>
          <dt>Created</dt>
          <dd>{fmtTime(d.createdAt)}</dd>
          <dt>Updated</dt>
          <dd>
            {fmtTime(d.updatedAt)} · {ago(d.updatedAt)}
          </dd>
          <dt>Elapsed</dt>
          <dd>{elapsed(d.createdAt, d.updatedAt)}</dd>
          <dt>Directory</dt>
          <dd className="omo-mono" title={d.directoryNote}>
            {d.directory ?? "—"}
          </dd>
          <dt>Version</dt>
          <dd>{d.version ?? "—"}</dd>
          <dt>Cost</dt>
          <dd>{d.cost != null ? `$${d.cost.toFixed(6)}` : "—"}</dd>
          <dt>Tokens</dt>
          <dd className="omo-mono">
            {d.tokens
              ? `in ${d.tokens.input ?? "—"} · out ${d.tokens.output ?? "—"} · reason ${d.tokens.reasoning ?? "—"} · cache r/w ${d.tokens.cacheRead ?? "—"}/${d.tokens.cacheWrite ?? "—"}`
              : "—"}
          </dd>
        </dl>
      </div>

      <div className="omo-sess-panel">
        <h2 className="omo-sess-panel-title">Agent model</h2>
        {d.agentCompare ? (
          <dl className="omo-sess-kv">
            <dt>Desired</dt>
            <dd className="omo-mono">{d.agentCompare.desiredModel ?? "—"}</dd>
            <dt>Effective</dt>
            <dd className="omo-mono">
              {d.agentCompare.effectiveModel ?? "—"}
              {d.agentCompare.effectiveVariant
                ? ` (${d.agentCompare.effectiveVariant})`
                : ""}
            </dd>
            <dt>This session</dt>
            <dd className="omo-mono">
              {d.agentCompare.sessionModel ?? "—"}
              {d.agentCompare.sessionVariant
                ? ` (${d.agentCompare.sessionVariant})`
                : ""}
            </dd>
          </dl>
        ) : (
          <p className="omo-sess-note">No agent/model compare available.</p>
        )}
        {d.agentCompare?.differsFromEffective ? (
          <p className="omo-sess-note omo-sess-note-indent">
            {d.agentCompare.note}
          </p>
        ) : null}
      </div>

      {mux ? (
        <div className="omo-sess-panel" data-testid="session-multiplexer">
          <h2 className="omo-sess-panel-title">Multiplexer</h2>
          <dl className="omo-sess-kv">
            <dt>Type</dt>
            <dd className="omo-mono">{muxTypeLabel(mux.dto)}</dd>
            <dt>Session</dt>
            <dd className="omo-mono">{mux.record.sessionId}</dd>
            <dt>Pane</dt>
            <dd className="omo-mono">{mux.record.paneId ?? "—"}</dd>
            <dt>Parent session</dt>
            <dd className="omo-mono">{mux.record.parentSessionId ?? "—"}</dd>
            <dt>State</dt>
            <dd>{recordStateLabel(mux.record)}</dd>
            <dt>Source</dt>
            <dd className="omo-sess-note">
              OMO session-manager record
              {mux.dto.runtime.bridgeSchemaVersion
                ? ` · bridge v${mux.dto.runtime.bridgeSchemaVersion}`
                : ""}
              {mux.dto.runtime.mapping.stale ? " · stale" : ""}
            </dd>
          </dl>
        </div>
      ) : null}

      <div className="omo-sess-panel">
        <h2 className="omo-sess-panel-title">Hierarchy</h2>
        {d.parent ? (
          <div>
            <span className="omo-sess-note">Parent </span>
            <button type="button" className="linkish" onClick={() => onSelect(d.parent!.id)}>
              {d.parent.agent ?? d.parent.id} — {d.parent.title ?? d.parent.id}
            </button>
          </div>
        ) : (
          <div className="omo-sess-note">Root session</div>
        )}
        <div className="omo-sess-section-title">Children ({d.children.length})</div>
        {d.children.length === 0 ? (
          <div className="omo-sess-note">None</div>
        ) : (
          d.children.map((c) => (
            <div key={c.id}>
              <button type="button" className="linkish" onClick={() => onSelect(c.id)}>
                {c.agent ?? "?"} · {(c.title ?? c.id).slice(0, 50)}
              </button>
            </div>
          ))
        )}
        {d.siblings.length > 0 ? (
          <>
            <div className="omo-sess-section-title">Siblings ({d.siblings.length})</div>
            {d.siblings.map((s) => (
              <div key={s.id}>
                <button type="button" className="linkish" onClick={() => onSelect(s.id)}>
                  {s.agent ?? "?"} · {(s.title ?? s.id).slice(0, 50)}
                </button>
              </div>
            ))}
          </>
        ) : null}
      </div>

      {d.initialInstruction ? (
        <div className="omo-sess-panel omo-sess-panel-wide">
          <h2 className="omo-sess-panel-title">{d.initialInstructionLabel}</h2>
          <pre className="omo-sess-pre">{d.initialInstruction.slice(0, 4000)}</pre>
        </div>
      ) : null}
    </div>
  );
}

function OmoTab({
  sessionId,
  onSelect,
}: {
  sessionId: string;
  onSelect: (id: string) => void;
}) {
  const { snapshot } = useOmoRuntime();
  const jobs = snapshot?.jobs ?? [];
  const asChild: OmoJob | undefined = jobs.find(
    (j) => j.childSessionId === sessionId,
  );
  const spawned = sortJobsRecent(
    jobs.filter((j) => j.parentSessionId === sessionId),
  );

  return (
    <div className="omo-sess-body">
      {!asChild && spawned.length === 0 ? (
        <p className="omo-sess-note">No OMO job telemetry for this session.</p>
      ) : null}

      {asChild ? (
        <div className="omo-sess-panel">
          <h2 className="omo-sess-panel-title">OMO Job</h2>
          <dl className="omo-sess-kv">
            <dt>Job</dt>
            <dd className="omo-mono" title={`taskId ${asChild.taskId}`}>
              {jobLabel(asChild)}
            </dd>
            <dt>Agent</dt>
            <dd>{asChild.agent}</dd>
            <dt>State</dt>
            <dd>
              <StatusBadge tone={jobTone(asChild.state)}>
                {asChild.state}
              </StatusBadge>{" "}
              {asChild.timedOut ? (
                <span className="omo-badge omo-badge-warn">Timed out (OMO)</span>
              ) : null}{" "}
              {asChild.resumeRequested ? (
                <span className="omo-badge">Resume requested</span>
              ) : null}{" "}
              {asChild.statusUncertain ? (
                <span className="omo-badge omo-badge-warn">
                  status uncertain
                </span>
              ) : null}
            </dd>
            <dt>Launched</dt>
            <dd className="omo-mono">{fmtHMS(asChild.launchedAt)}</dd>
            <dt>Completed</dt>
            <dd className="omo-mono">{fmtHMS(asChild.completedAt)}</dd>
            <dt>Parent session</dt>
            <dd>
              <button
                type="button"
                className="linkish"
                onClick={() => onSelect(asChild.parentSessionId)}
              >
                {asChild.parentSessionId}
              </button>
            </dd>
          </dl>
          {asChild.resultSummary ? (
            <>
              <div className="omo-sess-section-title">Result summary</div>
              <pre className="omo-sess-pre omo-sess-pre-dim">
                {asChild.resultSummary}
              </pre>
            </>
          ) : null}
        </div>
      ) : null}

      {spawned.length > 0 ? (
        <div className="omo-sess-panel">
          <h2 className="omo-sess-panel-title">Child jobs ({spawned.length})</h2>
          {spawned.map((j) => (
            <OmoJobRow
              key={j.taskId}
              job={j}
              selected={j.childSessionId === sessionId}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : null}

      <p className="omo-sess-note omo-sess-note-indent">{OMO_FOOTER}</p>
    </div>
  );
}

function DiffTab({ d }: { d: SessionDetail }) {
  const diff = d.diff;
  if (diff.error) {
    return <div className="error omo-sess-banner">Diff error: {diff.error}</div>;
  }
  if (diff.empty) {
    return (
      <p className="omo-sess-note">
        No diff for this session
        {diff.fromSummary ? " (summary also empty)" : ""}.
        {d.summary
          ? ` Summary: +${d.summary.additions ?? 0} / -${d.summary.deletions ?? 0} · files ${d.summary.files ?? 0}.`
          : ""}
      </p>
    );
  }
  return (
    <div>
      <div className="omo-sess-diff-meta">
        <span>
          +{diff.totalAdditions} / -{diff.totalDeletions} · {diff.files.length} file(s)
          {diff.fromSummary ? " · from session.summary" : " · from GET /session/id/diff"}
        </span>
        <span>
          Diff payload is OpenCode runtime API data (not independent filesystem
          reads).
        </span>
      </div>
      {diff.files.map((f, i) => (
        <div key={i} className="omo-sess-diff-file">
          <div className="omo-sess-diff-head">
            <span className="omo-mono">{f.file ?? "(unnamed)"}</span>
            <span className="omo-badge">{f.status ?? "modified"}</span>
            <span className="omo-sess-note">
              +{f.additions} / -{f.deletions}
            </span>
          </div>
          {f.patch ? (
            <pre className="omo-sess-pre omo-sess-diff-patch">{f.patch}</pre>
          ) : (
            <div className="omo-sess-note">No patch text</div>
          )}
        </div>
      ))}
    </div>
  );
}
