/**
 * System → Multiplexer (Slice 16).
 *
 * Renders the multiplexer subsystem from GET /api/system/multiplexer with
 * the four pipeline stages kept deliberately separate — configured
 * (desired), effective, detected, runtime — plus a typed editor that goes
 * through simulate → preview → apply → guarded revision restore.
 *
 * The control plane cannot drive the multiplexer: this section contains NO
 * restart, session, pane, or attach controls, and apply never implies hot
 * activation (config is read once at plugin load).
 */
import { useEffect, useMemo, useState } from "react";
import type {
  MultiplexerSessionRecord,
  MultiplexerSystemDto,
  SchemaValidationSummary,
} from "@omo/shared";
import { useOmoRuntime } from "../../hooks/useOmoRuntime";
import { notifyOmoSchemaStatusRefresh } from "../../hooks/useOmoSchemaStatus";
import { jobLabel } from "../sessions/OmoJobsPanel";
import type { OmoJob } from "../omo-runtime-types";
import { Button } from "../../components/ui/Button";
import { ProvBadge } from "./ProvBadge";
import {
  ActionBar,
  Group,
  SectionIntro,
  SettingRow,
} from "./SystemPrimitives";
import {
  MUX_FIELDS,
  MUX_LAYOUT_OPTIONS,
  MUX_MAIN_PANE_MAX,
  MUX_MAIN_PANE_MIN,
  MUX_TYPE_OPTIONS,
  MUX_ZELLIJ_MODE_OPTIONS,
  detectionSignalNames,
  fieldRelevance,
  mappingAuthoritative,
  muxTypeLabel,
  recordStateLabel,
  resolvedBackend,
  type MuxField,
} from "./multiplexer-utils";

// ── Local shapes mirroring the global-settings writer responses ───────

interface MuxSimResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  revisionId?: string;
  targetPath?: string;
  oldHash?: string;
  newHash?: string;
  createsFile?: boolean;
  textDiff?: string;
  effectiveChanges?: Array<{ path: string; before: unknown; after: unknown }>;
  schemaValidation?: SchemaValidationSummary;
}

type FieldAction = "unchanged" | "set" | "remove";

type FieldOps = Record<string, { operation: "set"; value: unknown } | { operation: "remove" }>;

const FIELD_LABELS: Record<MuxField, string> = {
  type: "Type",
  layout: "Layout",
  main_pane_size: "Main pane",
  zellij_pane_mode: "Zellij mode",
};

const CONFLICT = /CONFIGURATION CHANGED EXTERNALLY/i;

function fmtValue(v: unknown): string {
  if (v === undefined || v === null) return "(not set)";
  return typeof v === "string" ? v : JSON.stringify(v);
}

export function MultiplexerSection(props: {
  dto: MultiplexerSystemDto | null;
  error: string | null;
  scope: "user" | "project";
  onChanged: () => void;
}) {
  const { dto, error, scope } = props;
  const { snapshot: omo } = useOmoRuntime();

  // ── Typed editor state ────────────────────────────────────────────
  const [actions, setActions] = useState<Record<MuxField, FieldAction>>({
    type: "unchanged",
    layout: "unchanged",
    main_pane_size: "unchanged",
    zellij_pane_mode: "unchanged",
  });
  const [values, setValues] = useState<Record<MuxField, string>>({
    type: "auto",
    layout: "main-vertical",
    main_pane_size: "60",
    zellij_pane_mode: "agent-tab",
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [sim, setSim] = useState<MuxSimResult | null>(null);
  const [simErrors, setSimErrors] = useState<string[]>([]);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<{
    revisionId: string;
    targetPath?: string;
    newHash?: string;
  } | null>(null);
  const [restoreConfirm, setRestoreConfirm] = useState(false);
  const [restoreStatus, setRestoreStatus] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  // Seed editor values from the DTO whenever no edit is in progress.
  useEffect(() => {
    if (!dto) return;
    const untouched = MUX_FIELDS.every((f) => actions[f] === "unchanged");
    if (!untouched) return;
    setValues({
      type: String(dto.configured.type ?? dto.effective.type),
      layout: String(dto.configured.layout ?? dto.effective.layout),
      main_pane_size: String(
        dto.configured.main_pane_size ?? dto.effective.main_pane_size,
      ),
      zellij_pane_mode: String(
        dto.configured.zellij_pane_mode ?? dto.effective.zellij_pane_mode,
      ),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dto]);

  const touch = () => {
    setSim(null);
    setSimErrors([]);
    setConflict(false);
    setFormError(null);
    setApplied(null);
    setRestoreConfirm(false);
    setRestoreStatus(null);
    setRestoreError(null);
  };

  const hash = async (): Promise<string | undefined> => {
    const st = (await fetch("/api/config/edit-state").then((r) => r.json())) as {
      user: { hash: string | null };
      project: { hash: string | null };
    };
    return (scope === "user" ? st.user.hash : st.project.hash) ?? undefined;
  };

  /** Build the multiplexer FieldOps from the form; validates values. */
  const buildOps = (): { ops?: FieldOps; error?: string } => {
    const ops: FieldOps = {};
    for (const f of MUX_FIELDS) {
      const a = actions[f];
      if (a === "unchanged") continue;
      if (a === "remove") {
        ops[f] = { operation: "remove" };
        continue;
      }
      const raw = values[f];
      if (f === "main_pane_size") {
        const n = Number(raw);
        if (!Number.isFinite(n) || raw.trim() === "") {
          return { error: "multiplexer.main_pane_size must be a number" };
        }
        if (n < MUX_MAIN_PANE_MIN || n > MUX_MAIN_PANE_MAX) {
          return {
            error: `multiplexer.main_pane_size must be ${MUX_MAIN_PANE_MIN}–${MUX_MAIN_PANE_MAX}`,
          };
        }
        ops[f] = { operation: "set", value: n };
      } else if (f === "type") {
        if (!(MUX_TYPE_OPTIONS as readonly string[]).includes(raw)) {
          return { error: "multiplexer.type must be a listed backend" };
        }
        ops[f] = { operation: "set", value: raw };
      } else if (f === "layout") {
        if (!(MUX_LAYOUT_OPTIONS as readonly string[]).includes(raw)) {
          return { error: "multiplexer.layout must be a listed layout" };
        }
        ops[f] = { operation: "set", value: raw };
      } else {
        if (!(MUX_ZELLIJ_MODE_OPTIONS as readonly string[]).includes(raw)) {
          return { error: "multiplexer.zellij_pane_mode must be a listed mode" };
        }
        ops[f] = { operation: "set", value: raw };
      }
    }
    if (Object.keys(ops).length === 0) {
      return { error: "No changes requested — choose Set or Remove on at least one field." };
    }
    return { ops };
  };

  const postGlobal = async (
    kind: "simulate" | "apply",
    ops: FieldOps,
  ): Promise<MuxSimResult> => {
    const r = await fetch(`/api/config/global/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "global-settings",
        scope,
        multiplexer: ops,
        expectedSourceHash: await hash(),
      }),
    });
    return (await r.json()) as MuxSimResult;
  };

  const preview = async () => {
    const { ops, error: vErr } = buildOps();
    if (vErr) {
      setFormError(vErr);
      return;
    }
    setBusy(true);
    setFormError(null);
    setSimErrors([]);
    setConflict(false);
    try {
      const res = await postGlobal("simulate", ops!);
      if (!res.ok) {
        setSim(null);
        setSimErrors(res.errors ?? ["Simulation failed"]);
        if ((res.errors ?? []).some((e) => CONFLICT.test(e))) setConflict(true);
        return;
      }
      setSim(res);
    } catch (e) {
      setSim(null);
      setSimErrors([e instanceof Error ? e.message : String(e)]);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    const { ops, error: vErr } = buildOps();
    if (vErr || !sim?.ok) return;
    setBusy(true);
    setSimErrors([]);
    setConflict(false);
    try {
      const res = await postGlobal("apply", ops!);
      if (!res.ok) {
        const errs = res.errors ?? ["Apply failed"];
        setSimErrors(errs);
        if (errs.some((e) => CONFLICT.test(e))) {
          // The preview is stale — require a fresh preview before applying.
          setSim(null);
          setConflict(true);
        }
        return;
      }
      setSim(null);
      setApplied({
        revisionId: res.revisionId ?? "unknown",
        targetPath: res.targetPath,
        newHash: res.newHash,
      });
      setActions({
        type: "unchanged",
        layout: "unchanged",
        main_pane_size: "unchanged",
        zellij_pane_mode: "unchanged",
      });
      notifyOmoSchemaStatusRefresh();
      props.onChanged();
    } catch (e) {
      setSimErrors([e instanceof Error ? e.message : String(e)]);
    } finally {
      setBusy(false);
    }
  };

  const restore = async (revisionId: string) => {
    setBusy(true);
    setRestoreError(null);
    setRestoreStatus(null);
    try {
      const r = await fetch(
        `/api/config/revisions/${encodeURIComponent(revisionId)}/restore`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedSourceHash: applied?.newHash }),
        },
      );
      const d = (await r.json()) as { ok?: boolean; errors?: string[]; error?: string };
      if (!d.ok) {
        setRestoreError(d.errors?.join("; ") || d.error || "Restore failed");
        return;
      }
      setRestoreConfirm(false);
      setApplied(null);
      setRestoreStatus(`Restored revision ${revisionId}.`);
      notifyOmoSchemaStatusRefresh();
      props.onChanged();
    } catch (e) {
      setRestoreError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // ── Runtime join (multiplexer DTO × OMO jobs, by exact session ID) ─
  const jobs = useMemo(() => omo?.jobs ?? [], [omo]);
  const jobsByChild = useMemo(() => {
    const m = new Map<string, OmoJob>();
    for (const j of jobs) if (j.childSessionId) m.set(j.childSessionId, j);
    return m;
  }, [jobs]);

  // ── Render ────────────────────────────────────────────────────────

  if (error) {
    return (
      <div>
        <SectionIntro title="Multiplexer" />
        <div className="error">{error}</div>
      </div>
    );
  }
  if (!dto) {
    return <div className="omo-sys-quiet">Loading…</div>;
  }

  const backend = resolvedBackend(dto);
  const authoritative = mappingAuthoritative(dto);
  const records = dto.runtime.stores.sessions;
  const cmuxRecords = dto.runtime.stores.cmux;
  const mappedJobs = jobs.filter((j) => dto.runtime.mapping.bySessionId[j.childSessionId]);
  const changesSincePreview = sim !== null;

  return (
    <div data-testid="mux-section">
      {dto.warnings.length ? (
        <div className="omo-sys-pills omo-sys-pad">
          {dto.warnings.map((w, i) => (
            <span
              key={i}
              className={`pill ${w.severity === "warning" ? "warn" : ""}`}
            >
              {w.message}
            </span>
          ))}
        </div>
      ) : null}

      {/* ── System Configuration ─────────────────────────────────── */}
      <div data-testid="mux-config">
        <SectionIntro
          title="System Configuration"
          description="Desired = raw configured value (post-merge, pre-defaults) · Effective = after OMO builtin defaults · Source = winning config layer. Configured values stay visible even when the backend does not consume them."
        />
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Desired</th>
                <th scope="col">Effective</th>
                <th scope="col">Builtin default</th>
                <th scope="col">Source</th>
                <th scope="col">Relevance</th>
              </tr>
            </thead>
            <tbody>
              {MUX_FIELDS.map((f) => {
                const rel = fieldRelevance(dto, f);
                const desired = dto.configured[f];
                const configuredInactive =
                  desired !== undefined && f !== "type" && rel.state !== "active";
                return (
                  <tr key={f}>
                    <td>
                      {FIELD_LABELS[f]}
                      <div className="muted mono">
                        multiplexer.{f}
                      </div>
                    </td>
                    <td className="mono" data-testid={`mux-desired-${f}`}>
                      {fmtValue(desired)}
                      {f === "main_pane_size" && desired !== undefined ? "%" : ""}
                      {configuredInactive ? (
                        <>
                          {" "}
                          <span className="pill">configured · inactive</span>
                        </>
                      ) : null}
                    </td>
                    <td className="mono">
                      {fmtValue(dto.effective[f])}
                      {f === "main_pane_size" ? "%" : ""}
                      {f === "type" && dto.effective.type === "auto" ? (
                        <span className="muted">
                          {" "}
                          → {backend ?? "no backend detected"}
                        </span>
                      ) : null}
                    </td>
                    <td className="mono muted">{fmtValue(dto.builtinDefaults[f])}</td>
                    <td>
                      <ProvBadge
                        properties={dto.provenance.properties}
                        path={`multiplexer.${f}`}
                      />
                    </td>
                    <td data-testid={`mux-relevance-${f}`}>
                      <span className={rel.state === "active" ? "" : "muted"}>
                        {rel.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="omo-sys-note">
          Activation: {dto.activation.note} Configuration is read once at plugin
          load — no hot reload.
        </p>
      </div>

      {/* ── Edit Configuration ───────────────────────────────────── */}
      <div data-testid="mux-edit">
        <SectionIntro
          title="Edit Configuration"
          description={
            <>
              Writes the <span className="mono">multiplexer</span> block of the{" "}
              {scope} config file. Per field: keep unchanged, set a value, or remove
              the override (inherit from the next source / builtin default).
            </>
          }
        />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void preview();
          }}
        >
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col">Action</th>
                  <th scope="col">Value</th>
                </tr>
              </thead>
              <tbody>
                {MUX_FIELDS.map((f) => (
                  <tr key={f}>
                    <td>
                      <label htmlFor={`mux-action-${f}`}>{FIELD_LABELS[f]}</label>
                    </td>
                    <td>
                      <select
                        id={`mux-action-${f}`}
                        value={actions[f]}
                        onChange={(e) => {
                          touch();
                          setActions((a) => ({
                            ...a,
                            [f]: e.target.value as FieldAction,
                          }));
                        }}
                      >
                        <option value="unchanged">Keep unchanged</option>
                        <option value="set">Set value</option>
                        <option value="remove">Remove override (inherit)</option>
                      </select>
                    </td>
                    <td>
                      {actions[f] === "set" ? (
                        f === "main_pane_size" ? (
                          <>
                            <input
                              id={`mux-value-${f}`}
                              aria-label="Main pane size percent"
                              type="number"
                              min={MUX_MAIN_PANE_MIN}
                              max={MUX_MAIN_PANE_MAX}
                              value={values[f]}
                              onChange={(e) => {
                                touch();
                                setValues((v) => ({ ...v, [f]: e.target.value }));
                              }}
                            />{" "}
                            <span className="muted">
                              % ({MUX_MAIN_PANE_MIN}–{MUX_MAIN_PANE_MAX})
                            </span>
                          </>
                        ) : (
                          <select
                            id={`mux-value-${f}`}
                            aria-label={`${FIELD_LABELS[f]} value`}
                            value={values[f]}
                            onChange={(e) => {
                              touch();
                              setValues((v) => ({ ...v, [f]: e.target.value }));
                            }}
                          >
                            {(f === "type"
                              ? MUX_TYPE_OPTIONS
                              : f === "layout"
                                ? MUX_LAYOUT_OPTIONS
                                : MUX_ZELLIJ_MODE_OPTIONS
                            ).map((o) => (
                              <option key={o} value={o}>
                                {o}
                              </option>
                            ))}
                          </select>
                        )
                      ) : (
                        <span className="muted mono">{fmtValue(dto.configured[f])}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {formError ? (
            <div className="error" role="alert">
              {formError}
            </div>
          ) : null}
          <div className="omo-sys-pad">
            <ActionBar>
              <Button type="submit" disabled={busy}>
                {busy ? "Working…" : "Preview changes"}
              </Button>
            </ActionBar>
          </div>
        </form>

        {simErrors.length ? (
          <div className="error" role="alert">
            {conflict
              ? "Configuration changed externally — preview again before applying."
              : null}
            {simErrors.map((e, i) => (
              <div key={i}>{e}</div>
            ))}
          </div>
        ) : null}

        {sim?.ok ? (
          <div
            className="omo-sys-preview"
            data-testid="mux-preview"
            role="status"
            aria-live="polite"
          >
            <div className="section-title">Preview — multiplexer ({scope} scope)</div>
            <dl className="row-kv">
              <dt>Target file</dt>
              <dd className="mono mux-break">{sim.targetPath ?? "—"}</dd>
              <dt>Creates file</dt>
              <dd>{sim.createsFile ? "yes" : "no"}</dd>
              <dt>Effective before</dt>
              <dd className="mono">
                type {dto.effective.type} · layout {dto.effective.layout} · main{" "}
                {dto.effective.main_pane_size}% · zellij {dto.effective.zellij_pane_mode}
              </dd>
              <dt>Effective after</dt>
              <dd className="muted">
                re-resolved from all config sources after the write
              </dd>
            </dl>

            <div className="section-title">Desired changes</div>
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Path</th>
                  <th scope="col">Desired before</th>
                  <th scope="col">Proposed</th>
                </tr>
              </thead>
              <tbody>
                {MUX_FIELDS.filter((f) => actions[f] !== "unchanged").map((f) => (
                  <tr key={f}>
                    <td className="mono">multiplexer.{f}</td>
                    <td className="mono">{fmtValue(dto.configured[f])}</td>
                    <td className="mono">
                      {actions[f] === "remove"
                        ? "(removed — inherits)"
                        : values[f]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {sim.effectiveChanges?.length ? (
              <>
                <div className="section-title">Exact file changes</div>
                <table className="data">
                  <thead>
                    <tr>
                      <th scope="col">Path</th>
                      <th scope="col">Before</th>
                      <th scope="col">After</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sim.effectiveChanges.map((c) => (
                      <tr key={c.path}>
                        <td className="mono">{c.path}</td>
                        <td className="mono">{fmtValue(c.before)}</td>
                        <td className="mono">{fmtValue(c.after)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : null}

            {/* Compatibility: relevance of each changed field vs the current
                effective backend, plus any writer warnings. */}
            {MUX_FIELDS.filter((f) => actions[f] !== "unchanged").map((f) => {
              const rel = fieldRelevance(dto, f);
              if (rel.state === "active") return null;
              return (
                <div key={f} className="warn-block">
                  multiplexer.{f} — {rel.label}
                </div>
              );
            })}
            {(sim.warnings ?? []).map((w, i) => (
              <div key={i} className="warn-block">
                {w}
              </div>
            ))}

            {sim.schemaValidation ? (
              <div
                data-testid="mux-schema-validation"
                className={
                  sim.schemaValidation.unavailable
                    ? "warn-block"
                    : sim.schemaValidation.ok
                      ? "info-block"
                      : "error"
                }
              >
                <strong>OMO-Slim schema validation</strong>{" "}
                {sim.schemaValidation.unavailable ? (
                  <span className="pill warn">schema unavailable — writes blocked</span>
                ) : sim.schemaValidation.ok ? (
                  <span className="pill ok">
                    ✓ valid against installed schema
                    {sim.schemaValidation.packageVersion
                      ? ` ${sim.schemaValidation.packageVersion}`
                      : ""}
                  </span>
                ) : (
                  <>
                    <span className="pill bad">✕ invalid</span>
                    <ul className="omo-sys-list mono">
                      {(sim.schemaValidation.issues ?? []).map((iss, i) => (
                        <li key={i}>
                          {iss.path || "(root)"} — {iss.message}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            ) : null}

            <div className="section-title">Text diff</div>
            <pre className="msg-pre diff-patch">{sim.textDiff ?? "(no diff)"}</pre>

            <p className="omo-sys-note">
              Activation: configuration is read once at plugin load
              {dto.activation.hotReload === false ? " — no hot reload" : ""}.
            </p>
            <p className="omo-sys-note">
              <strong>No runtime action will be taken.</strong>
            </p>

            <ActionBar>
              <Button
                variant="primary"
                disabled={
                  busy ||
                  !changesSincePreview ||
                  (sim.schemaValidation ? !sim.schemaValidation.ok : false)
                }
                onClick={() => void apply()}
              >
                Apply
              </Button>
              <Button disabled={busy} onClick={() => setSim(null)}>
                Discard preview
              </Button>
            </ActionBar>
          </div>
        ) : null}

        <div aria-live="polite" role="status" data-testid="mux-apply-status">
          {applied ? (
            <div className="info-block">
              Applied — revision <span className="mono">{applied.revisionId}</span>
              {applied.targetPath ? (
                <>
                  {" "}
                  written to <span className="mono">{applied.targetPath}</span>
                </>
              ) : null}
              . The multiplexer reads configuration at plugin load; no runtime
              action was taken.{" "}
              <Button
                size="sm"
                disabled={busy}
                onClick={() => setRestoreConfirm((c) => !c)}
              >
                Restore
              </Button>
            </div>
          ) : null}
          {restoreStatus ? (
            <div className="info-block">
              {restoreStatus} The multiplexer reads configuration at plugin load.
            </div>
          ) : null}
        </div>
        {restoreError ? (
          <div className="error" role="alert">
            {restoreError}
          </div>
        ) : null}
        {applied && restoreConfirm ? (
          <div className="warn-block">
            Restores the <strong>whole file</strong> to its pre-apply snapshot —
            any later changes in that file will be reverted. The multiplexer
            picks the restored values up at the next plugin load.{" "}
            <ActionBar>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void restore(applied.revisionId)}
              >
                Confirm restore
              </Button>
              <Button size="sm" onClick={() => setRestoreConfirm(false)}>
                Cancel
              </Button>
            </ActionBar>
          </div>
        ) : null}
      </div>

      {/* ── Availability ─────────────────────────────────────────── */}
      <div data-testid="mux-availability">
        <SectionIntro
          title="Availability"
          description={
            <>
              Static <span className="mono">command -v</span> probe by the control
              plane. Command paths are metadata only — binaries are never executed.
            </>
          }
        />
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Command</th>
                <th scope="col">Status</th>
                <th scope="col">Path</th>
              </tr>
            </thead>
            <tbody>
              {Object.values(dto.availability).map((a) => (
                <tr key={a.command}>
                  <td className="mono">{a.command}</td>
                  <td>
                    <span
                      className={`pill ${
                        a.status === "resolved"
                          ? "ok"
                          : a.status === "not-applicable"
                            ? ""
                            : "warn"
                      }`}
                    >
                      {a.status}
                    </span>
                  </td>
                  <td className="mono muted mux-break">{a.path ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Auto Detection ───────────────────────────────────────── */}
      <div data-testid="mux-detection">
        <SectionIntro title="Auto Detection" />
        <Group>
          <SettingRow
            title="Resolved type"
            control={
              <span className="omo-sys-value omo-mono">
                {dto.detection.resolvedType ?? "none — no signal matched"}
              </span>
            }
          />
          <SettingRow
            title="Inside session"
            control={
              <span className="omo-sys-value">{dto.detection.insideSession ? "yes" : "no"}</span>
            }
          />
          <SettingRow
            title="Signals set"
            control={
              <span className="omo-sys-value omo-mono">
                {detectionSignalNames(dto).join(", ") || "none"}
              </span>
            }
          />
        </Group>
        <p className="omo-sys-note">
          Only which environment signals are set is shown — values are never
          displayed. Resolution order (first match wins):
        </p>
        <ul className="omo-sys-list mono">
          {dto.detection.order.map((o, i) => (
            <li key={i}>
              {o.match} → {o.type ?? "no backend"}
            </li>
          ))}
        </ul>
      </div>

      {/* ── Runtime Observation ──────────────────────────────────── */}
      <div data-testid="mux-runtime">
        <SectionIntro title="Runtime Observation" />
        {!authoritative ? (
          <p className="omo-sys-note" data-testid="mux-runtime-unavailable">
            Unavailable — the OMO bridge is not connected or not registered, so
            multiplexer runtime state is not observable. This is neutral, not a
            health warning.
          </p>
        ) : (
          <>
            <dl className="row-kv">
              <dt>Bridge</dt>
              <dd>
                connected{dto.runtime.bridgeSchemaVersion ? ` · schema v${dto.runtime.bridgeSchemaVersion}` : ""}{" "}
                {dto.runtime.mapping.stale ? (
                  <span className="pill warn">stale</span>
                ) : null}
              </dd>
              <dt>Mapped OMO jobs</dt>
              <dd>
                {dto.runtime.mapping.mappedJobs.length} mapped ·{" "}
                {dto.runtime.mapping.unmappedJobs.length} unmapped
              </dd>
              {dto.runtime.mapping.graceAppliedMs !== undefined ? (
                <>
                  <dt>Reconciliation</dt>
                  <dd>{dto.runtime.mapping.graceAppliedMs / 1000}s grace applied</dd>
                </>
              ) : null}
              <dt>Records</dt>
              <dd className="mono">
                {[
                  ["sessions", dto.runtime.stores.counts.sessions],
                  ["known", dto.runtime.stores.counts.knownSessions],
                  ["spawning", dto.runtime.stores.counts.spawning],
                  ["closing", dto.runtime.stores.counts.closing],
                  ["closed", dto.runtime.stores.counts.permanentlyClosed],
                  ["cmux", dto.runtime.stores.counts.cmuxRecords],
                ]
                  .filter(([, v]) => v !== undefined)
                  .map(([k, v]) => `${k} ${v}`)
                  .join(" · ") || "—"}
              </dd>
            </dl>

            {records.length === 0 && cmuxRecords.length === 0 ? (
              <p className="omo-sys-note">
                No multiplexer session records in the bridge snapshot.
              </p>
            ) : null}

            {records.length > 0 ? (
              <>
                <div className="section-title">Session mappings</div>
                <div className="table-wrap">
                  <table className="data" data-testid="mux-runtime-table">
                    <thead>
                      <tr>
                        <th scope="col">OpenCode Session</th>
                        <th scope="col">Agent</th>
                        <th scope="col">OMO Job</th>
                        <th scope="col">Multiplexer</th>
                        <th scope="col">Session/Pane</th>
                        <th scope="col">State</th>
                      </tr>
                    </thead>
                    <tbody>
                      {records.map((rec) => {
                        const job = jobsByChild.get(rec.sessionId);
                        return (
                          <tr key={rec.sessionId}>
                            <td className="mono mux-break">{rec.sessionId}</td>
                            <td>{job?.agent ?? "—"}</td>
                            <td className="mono" title={job ? `task ${job.taskId}` : undefined}>
                              {job ? jobLabel(job) : "—"}
                            </td>
                            <td className="mono">{muxTypeLabel(dto)}</td>
                            <td className="mono">{rec.paneId ?? "—"}</td>
                            <td>{recordStateLabel(rec)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            ) : null}

            {cmuxRecords.length > 0 ? (
              <>
                <div className="section-title">cmux records</div>
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th scope="col">Session</th>
                        <th scope="col">Pane</th>
                        <th scope="col">Spawn state</th>
                        <th scope="col">Lifecycle</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cmuxRecords.map((r) => (
                        <tr key={r.sessionId}>
                          <td className="mono mux-break">{r.sessionId}</td>
                          <td className="mono">{r.paneId ?? "—"}</td>
                          <td>{r.spawnState}</td>
                          <td>{r.lifecycle}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : null}

            {mappedJobs.length > 0 ? (
              <>
                <div className="section-title">Runtime topology</div>
                <MuxTopology dto={dto} jobs={mappedJobs} />
              </>
            ) : null}
          </>
        )}
      </div>

      {/* ── Capability Matrix ────────────────────────────────────── */}
      <div data-testid="mux-capabilities">
        <SectionIntro title="Capability Matrix" />
        <dl className="row-kv">
          <dt>Readable</dt>
          <dd>{dto.capabilities.readable ? "✓" : "—"}</dd>
          <dt>Resolved</dt>
          <dd>{dto.capabilities.resolved ? "✓" : "—"}</dd>
          <dt>Provenance</dt>
          <dd>{dto.capabilities.provenance ? "✓" : "—"}</dd>
          <dt>Editable</dt>
          <dd>{dto.capabilities.editable ? "✓" : "—"}</dd>
          <dt>Runtime observable</dt>
          <dd>
            partial — bridge store snapshots and OpenCode session/job mapping
            only
          </dd>
          <dt>Runtime controllable</dt>
          <dd>✗ — the control plane cannot drive the multiplexer</dd>
          <dt>Doctor</dt>
          <dd>{dto.capabilities.doctor ? "✓" : "—"}</dd>
        </dl>
      </div>

      {/* ── Legacy tmux findings ─────────────────────────────────── */}
      <div data-testid="mux-legacy">
        <SectionIntro title="Legacy tmux findings" />
        {dto.legacy.tmuxPresent ? (
          <p className="omo-sys-note">
            <span className="pill warn">legacy top-level tmux key present</span>{" "}
            {dto.legacy.note}
          </p>
        ) : (
          <p className="omo-sys-note">No legacy top-level tmux key present.</p>
        )}
      </div>
    </div>
  );
}

/**
 * Readable branch-line topology: one Orchestrator/main row per real parent
 * session and worker rows only for OMO jobs with an authoritative multiplexer
 * record. Nothing is fabricated — unmapped jobs and absent parents are left
 * out, and the whole block is omitted when no mappings exist.
 */
function MuxTopology(props: { dto: MultiplexerSystemDto; jobs: OmoJob[] }) {
  const { dto, jobs } = props;
  const byParent = new Map<string, OmoJob[]>();
  for (const j of jobs) {
    const p = j.parentSessionId || "(unknown parent)";
    const list = byParent.get(p) ?? [];
    list.push(j);
    byParent.set(p, list);
  }
  return (
    <div className="mux-topo mono" data-testid="mux-topology" role="list">
      {[...byParent.entries()].map(([parent, list]) => (
        <div key={parent}>
          <div className="mux-topo-row" role="listitem">
            <span className="mux-topo-branch" aria-hidden="true">
              ●
            </span>{" "}
            Orchestrator/main <span className="muted mux-break">{parent}</span>
          </div>
          {list.map((j, i) => {
            const rec = dto.runtime.mapping.bySessionId[j.childSessionId];
            const last = i === list.length - 1;
            return (
              <div className="mux-topo-row mux-topo-worker" role="listitem" key={j.taskId}>
                <span className="mux-topo-branch" aria-hidden="true">
                  {last ? "└─" : "├─"}
                </span>{" "}
                {j.agent} · {jobLabel(j)} →{" "}
                {rec ? (
                  <span>
                    {muxTypeLabel(dto)} {rec.paneId ?? ""}
                  </span>
                ) : (
                  <span className="muted">no mapping</span>
                )}{" "}
                <span className="muted">({rec ? recordStateLabel(rec) : "—"})</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
