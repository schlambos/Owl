/**
 * AgentDetailDrawer — right-docked detail side-sheet for the Agents page.
 * Does NOT shrink the assignment list (replaces the old sessions-split
 * pattern which collapsed the table to a 320px sidebar).
 *
 * Rendered through FocusTrapDialog: role=dialog, aria-modal, labelledby,
 * trapped Tab cycle, Escape/backdrop close, inert (but visible) background,
 * focus returned to the row's agent-name detail trigger.
 */
import { useEffect, useState } from "react";
import type {
  AgentRow,
  EffectivePrompt,
  ResolvedProperty,
} from "@omo/shared";
import { FocusTrapDialog } from "../../components/FocusTrapDialog";
import { Button } from "../../components/ui/Button";
import type { AgentPresentation } from "./presentation";

export const AGENT_DRAWER_TITLE_ID = "agent-detail-drawer-title";

export function AgentDetailDrawer(props: {
  row: AgentRow;
  presentation: AgentPresentation;
  onClose: () => void;
  onEdit?: (agent: string) => void;
  editHint?: string;
  /** Focus-return target getter (row detail trigger). */
  returnFocus?: () => HTMLElement | null;
}) {
  const { row, presentation } = props;
  const [fields, setFields] = useState<Record<string, ResolvedProperty>>({});
  const [prompt, setPrompt] = useState<EffectivePrompt | null>(null);
  const [tab, setTab] = useState<"fields" | "prompt">("fields");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [prov, pr] = await Promise.all([
          fetch("/api/omo/provenance").then((r) => r.json()),
          fetch(`/api/agents/${encodeURIComponent(row.name)}/prompts?text=1`).then(
            (r) => r.json(),
          ),
        ]);
        if (cancelled) return;
        const prefix = `agents.${row.name}.`;
        const props = (prov as { properties: Record<string, ResolvedProperty> })
          .properties;
        const filtered: Record<string, ResolvedProperty> = {};
        for (const [k, v] of Object.entries(props)) {
          if (k.startsWith(prefix) || k === `agents.${row.name}`) {
            filtered[k] = v;
          }
        }
        setFields(filtered);
        setPrompt(pr as EffectivePrompt);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [row.name]);

  return (
    <FocusTrapDialog
      variant="sheet"
      labelledBy={AGENT_DRAWER_TITLE_ID}
      onClose={props.onClose}
      returnFocus={props.returnFocus}
      className="drawer agents-detail-drawer"
    >
      <div id="agent-detail-drawer">
      <div className="inspector-head">
        <div>
          <h2
            className="inspector-title"
            id={AGENT_DRAWER_TITLE_ID}
            tabIndex={-1}
          >
            {row.name}
          </h2>
          <div className="inspector-badges">
            <span className="pill">{row.kind}</span>
            {presentation.isCustom ? <span className="pill">Custom</span> : null}
            {presentation.isBuiltinOmo ? (
              <span className="pill">Built-in</span>
            ) : null}
            {presentation.isDisabled ? (
              <span className="pill bad">Disabled</span>
            ) : null}
            {presentation.isAcp ? (
              <span className="pill">ACP-managed</span>
            ) : null}
          </div>
        </div>
        <Button size="sm" onClick={props.onClose}>
          Close
        </Button>
      </div>
      {err ? <div className="error">{err}</div> : null}

      {/* Assignment summary — uses the presentation model. */}
      <div className="card">
        <h2>Assignment</h2>
        <dl className="row-kv">
          <dt>Assigned</dt>
          <dd title={presentation.assigned.model ?? ""}>
            {presentation.assigned.model ?? "—"}
            {presentation.assigned.variant
              ? ` · ${presentation.assigned.variant}`
              : ""}
          </dd>
          <dt>Effective</dt>
          <dd title={presentation.effective.model ?? ""}>
            {presentation.effective.model ?? "—"}
            {presentation.effective.variant
              ? ` · ${presentation.effective.variant}`
              : ""}
          </dd>
          <dt>Live</dt>
          <dd title={presentation.live.model ?? ""}>
            {presentation.live.model ?? "—"}
            {presentation.live.variant
              ? ` · ${presentation.live.variant}`
              : ""}
          </dd>
          <dt>Source</dt>
          <dd>
            <span className="pill">{presentation.sourceLabel}</span>
            {presentation.sourceDetail ? (
              <div className="source-detail">{presentation.sourceDetail}</div>
            ) : null}
          </dd>
          <dt>Alignment</dt>
          <dd>
            <span
              className={`alignment-pill ${presentation.alignment}`}
            >
              {alignmentLabel(presentation.alignment)}
            </span>
          </dd>
          {presentation.fallbackCount > 0 ? (
            <>
              <dt>Fallbacks</dt>
              <dd>
                <ol className="agents-fallback-list">
                  {presentation.effective.fallbacks.map((f, i) => (
                    <li key={i} title={f}>
                      {f}
                    </li>
                  ))}
                </ol>
              </dd>
            </>
          ) : null}
          <dt>Sessions</dt>
          <dd className="mono">{presentation.sessionCount}</dd>
          {presentation.probeIssueCount > 0 ? (
            <>
              <dt>Model issues</dt>
              <dd>
                <ul className="agents-issue-list">
                  {presentation.probeIssues.map((iss, i) => (
                    <li key={i}>
                      <span className={`probe-inline ${iss.class}`}>
                        {iss.label}
                      </span>{" "}
                      <span className="mono muted">
                        {iss.role === "primary" ? "primary" : "fallback"} ·{" "}
                        {iss.model}
                      </span>
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          ) : null}
        </dl>
        {presentation.alignment === "runtime-drift" ||
        presentation.alignment === "both" ? (
          <div className="warn-block">
            Runtime differs from current effective configuration. Possible
            causes are not determined by OpenCode session data alone. Runtime
            preset state is not currently observable.
          </div>
        ) : null}
        <div className="toolbar">
          {props.onEdit ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => props.onEdit?.(row.name)}
            >
              Edit
            </Button>
          ) : props.editHint ? (
            <span className="muted">{props.editHint}</span>
          ) : null}
        </div>
        <p className="agents-footnote">
          Existing sessions retain their recorded model; changes apply on
          OMO/OpenCode reload/session lifecycle.
        </p>
      </div>

      <div className="tab-bar">
        <button
          type="button"
          className={`tab ${tab === "fields" ? "active" : ""}`}
          onClick={() => setTab("fields")}
        >
          Field provenance
        </button>
        <button
          type="button"
          className={`tab ${tab === "prompt" ? "active" : ""}`}
          onClick={() => setTab("prompt")}
        >
          Prompt
        </button>
      </div>

      {tab === "fields" ? (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Field</th>
                <th>Value</th>
                <th>Stage</th>
                <th>Source path</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {Object.values(fields).map((p) => (
                <tr key={p.path}>
                  <td className="mono">
                    {p.path.replace(`agents.${row.name}.`, "")}
                  </td>
                  <td className="mono">{short(p.value)}</td>
                  <td>
                    <span className="pill">{p.winner.stage}</span>
                  </td>
                  <td className="mono">{p.winner.sourcePath}</td>
                  <td className="muted">{p.reason}</td>
                </tr>
              ))}
              {Object.keys(fields).length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    No field-level provenance (agent may be defaults-only).
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "prompt" && prompt ? (
        <div className="agents-drawer-stack">
          <p className="agents-quiet-note">
            {prompt.compositionRule}
          </p>
          <div className="card">
            <h2>Base</h2>
            <div>
              <span className="pill ok">{prompt.baseSource.kind}</span>{" "}
              {prompt.baseSource.path ?? prompt.baseSource.reason}
            </div>
          </div>
          <div className="card">
            <h2>Sources</h2>
            <table className="data">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Scope</th>
                  <th>Applied</th>
                  <th>Path / reason</th>
                </tr>
              </thead>
              <tbody>
                {prompt.sources.map((s, i) => (
                  <tr key={i}>
                    <td>{s.kind}</td>
                    <td>{s.scope}</td>
                    <td>
                      <span className={`pill ${s.applied ? "ok" : ""}`}>
                        {s.applied ? "yes" : "no"}
                      </span>
                    </td>
                    <td className="mono">
                      {s.path ?? "—"}
                      <div className="muted">{s.reason}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {prompt.effectiveText ? (
            <div className="card">
              <h2>Effective composition (text)</h2>
              <pre className="msg-pre">{prompt.effectiveText}</pre>
            </div>
          ) : null}
          {prompt.warnings.length > 0 ? (
            <div className="error">
              {prompt.warnings.join(" · ")}
            </div>
          ) : null}
        </div>
      ) : null}
      </div>
    </FocusTrapDialog>
  );
}

function alignmentLabel(s: AgentPresentation["alignment"]): string {
  switch (s) {
    case "aligned":
      return "Aligned";
    case "assignment-override":
      return "Assignment overridden";
    case "runtime-drift":
      return "Runtime drift";
    case "both":
      return "Assignment overridden + Runtime drift";
    case "unconfigured":
      return "Unconfigured";
    case "unconfigured-live":
      return "No assignment (live only)";
    default:
      return "—";
  }
}

function short(v: unknown): string {
  if (typeof v === "string") return v.length > 80 ? v.slice(0, 80) + "…" : v;
  try {
    const s = JSON.stringify(v);
    return s.length > 80 ? s.slice(0, 80) + "…" : s;
  } catch {
    return String(v);
  }
}