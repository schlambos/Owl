/**
 * System → Interview (Slice 18 D2).
 *
 * Compact editable subsection. Desired / Effective / provenance stay
 * distinct. Typed writes go through GET /api/config/interview and
 * simulate → preview → apply. No interview server, browser, port probe,
 * or OpenCode restart is offered from this page.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useUnsavedChangesWarning } from "../../hooks/useUnsavedChangesWarning";
import type {
  InterviewCommitResponse,
  InterviewField,
  InterviewFieldMetadata,
  InterviewMutationOperation,
  InterviewMutationRequest,
  InterviewPreviewResponse,
  InterviewTypedCapability,
  JsonChange,
  OmoScope,
  ProvenanceChange,
  SchemaValidationSummary,
  SourceFingerprint,
} from "@omo/shared";
import { api } from "../../api";
import { notifyOmoSchemaStatusRefresh } from "../../hooks/useOmoSchemaStatus";
import { Button } from "../../components/ui/Button";
import { ProvBadge, type ProvLike } from "./ProvBadge";
import {
  ActionBar,
  Group,
  SectionIntro,
  SettingRow,
  TechDetails,
} from "./SystemPrimitives";

const INTERVIEW_FIELDS: InterviewField[] = [
  "maxQuestions",
  "outputFolder",
  "autoOpenBrowser",
  "port",
  "dashboard",
];

const DEFAULT_DASHBOARD_PORT = 43211;

const FALLBACK_METADATA: Record<InterviewField, InterviewFieldMetadata> = {
  maxQuestions: {
    name: "maxQuestions",
    schemaType: "integer",
    defaultValue: 2,
    minimum: 1,
    maximum: 10,
  },
  outputFolder: {
    name: "outputFolder",
    schemaType: "string",
    defaultValue: "interview",
    minLength: 1,
  },
  autoOpenBrowser: {
    name: "autoOpenBrowser",
    schemaType: "boolean",
    defaultValue: true,
    description:
      "Configured preference only. This control plane never opens a browser.",
  },
  port: {
    name: "port",
    schemaType: "integer",
    defaultValue: 0,
    minimum: 0,
    maximum: 65535,
  },
  dashboard: {
    name: "dashboard",
    schemaType: "boolean",
    defaultValue: false,
  },
};

const FIELD_LABELS: Record<InterviewField, string> = {
  maxQuestions: "Questions",
  outputFolder: "Output",
  autoOpenBrowser: "Browser",
  port: "Server",
  dashboard: "Dashboard",
};

type FieldAction = "unchanged" | "set" | "remove";

interface InterviewEffective {
  maxQuestions: number;
  outputFolder: string;
  autoOpenBrowser: boolean;
  port: number;
  dashboard: boolean;
}

interface InterviewView {
  fieldMetadata: InterviewFieldMetadata[];
  typedCapability: InterviewTypedCapability;
  restartRequired: true;
  runtimeAction: "none";
  desired: Record<string, unknown> | null;
  effective: InterviewEffective;
  properties: Record<string, ProvLike>;
  raw: { user?: Record<string, unknown>; project?: Record<string, unknown> };
  fingerprints: { user: SourceFingerprint; project: SourceFingerprint } | null;
  server: {
    mode: "per-session" | "dashboard";
    bindHost: string;
    configuredPort: number;
    portMeaning: string;
    defaultDashboardPort: number;
    dashboardDerived: { enabled: boolean; via: "explicit" | "port" | "no" };
    browser: { autoOpen: boolean; autoDisabledInAutomated?: boolean };
    notes: string[];
  };
  output: {
    configuredFolder: string;
    normalizedFolder: string;
    resolvedPath: string;
    withinAuthorizedScope: boolean;
    inspected: boolean;
    exists: null | boolean;
  };
  runtime: { observable: boolean; reasonUnavailable?: string };
  invocation: { mechanism: string; name: string; note: string };
  warnings: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function asEffective(v: unknown): InterviewEffective {
  const o = isRecord(v) ? v : {};
  return {
    maxQuestions: typeof o.maxQuestions === "number" ? o.maxQuestions : 2,
    outputFolder: typeof o.outputFolder === "string" ? o.outputFolder : "interview",
    autoOpenBrowser: o.autoOpenBrowser === false ? false : true,
    port: typeof o.port === "number" ? o.port : 0,
    dashboard: o.dashboard === true,
  };
}

function asFingerprint(v: unknown): SourceFingerprint | null {
  if (!isRecord(v)) return null;
  if (typeof v.exists !== "boolean") return null;
  if (v.sha256 !== null && typeof v.sha256 !== "string") return null;
  if (v.format !== "json" && v.format !== "jsonc") return null;
  if (v.mtimeMs !== null && typeof v.mtimeMs !== "number") return null;
  if (typeof v.generation !== "number") return null;
  return {
    exists: v.exists,
    sha256: v.sha256,
    format: v.format,
    mtimeMs: v.mtimeMs,
    generation: v.generation,
  };
}

function closedCapability(reason: string): InterviewTypedCapability {
  return {
    available: false,
    reason,
    installedFields: [],
    auditedFields: INTERVIEW_FIELDS,
  };
}

function parseInterviewDto(raw: unknown): InterviewView {
  const root = isRecord(raw) ? raw : {};
  const state = isRecord(root.state) ? { ...root, ...root.state } : root;
  const userFp = asFingerprint(
    isRecord(state.fingerprints) ? state.fingerprints.user : undefined,
  );
  const projectFp = asFingerprint(
    isRecord(state.fingerprints) ? state.fingerprints.project : undefined,
  );
  const capRaw = isRecord(state.typedCapability)
    ? state.typedCapability
    : isRecord(state.typedWrites)
      ? state.typedWrites
      : {};
  const metadata = Array.isArray(state.fieldMetadata)
    ? (state.fieldMetadata as InterviewFieldMetadata[])
    : INTERVIEW_FIELDS.map((name) => FALLBACK_METADATA[name]);
  const server = isRecord(state.server) ? state.server : {};
  const derived = isRecord(server.dashboardDerived) ? server.dashboardDerived : {};
  const browser = isRecord(server.browser) ? server.browser : {};
  const output = isRecord(state.output) ? state.output : {};
  const runtime = isRecord(state.runtime) ? state.runtime : {};
  const invocation = isRecord(state.invocation) ? state.invocation : {};
  const rawScopes = isRecord(state.raw) ? state.raw : {};

  return {
    fieldMetadata: metadata,
    typedCapability: {
      available: capRaw.available === true,
      reason: typeof capRaw.reason === "string" ? capRaw.reason : undefined,
      packageVersion:
        typeof capRaw.packageVersion === "string" ? capRaw.packageVersion : undefined,
      schemaHash: typeof capRaw.schemaHash === "string" ? capRaw.schemaHash : undefined,
      cacheKey: typeof capRaw.cacheKey === "string" ? capRaw.cacheKey : undefined,
      installedFields: Array.isArray(capRaw.installedFields)
        ? capRaw.installedFields.filter((x): x is string => typeof x === "string")
        : INTERVIEW_FIELDS.slice(),
      auditedFields: Array.isArray(capRaw.auditedFields)
        ? (capRaw.auditedFields.filter((x): x is InterviewField =>
            INTERVIEW_FIELDS.includes(x as InterviewField),
          ) as InterviewField[])
        : INTERVIEW_FIELDS,
    },
    restartRequired: true,
    runtimeAction: "none",
    desired: isRecord(state.desired) ? state.desired : null,
    effective: asEffective(state.effective),
    properties: isRecord(state.properties)
      ? (state.properties as Record<string, ProvLike>)
      : {},
    raw: {
      user: isRecord(rawScopes.user) ? rawScopes.user : undefined,
      project: isRecord(rawScopes.project) ? rawScopes.project : undefined,
    },
    fingerprints: userFp && projectFp ? { user: userFp, project: projectFp } : null,
    server: {
      mode: server.mode === "dashboard" ? "dashboard" : "per-session",
      bindHost: typeof server.bindHost === "string" ? server.bindHost : "127.0.0.1",
      configuredPort:
        typeof server.configuredPort === "number"
          ? server.configuredPort
          : asEffective(state.effective).port,
      portMeaning:
        typeof server.portMeaning === "string" ? server.portMeaning : "",
      defaultDashboardPort:
        typeof server.defaultDashboardPort === "number"
          ? server.defaultDashboardPort
          : DEFAULT_DASHBOARD_PORT,
      dashboardDerived: {
        enabled: derived.enabled === true,
        via:
          derived.via === "explicit" || derived.via === "port" ? derived.via : "no",
      },
      browser: {
        autoOpen: browser.autoOpen === true,
        autoDisabledInAutomated: browser.autoDisabledInAutomated === true,
      },
      notes: Array.isArray(server.notes)
        ? server.notes.filter((n): n is string => typeof n === "string")
        : [],
    },
    output: {
      configuredFolder:
        typeof output.configuredFolder === "string"
          ? output.configuredFolder
          : asEffective(state.effective).outputFolder,
      normalizedFolder:
        typeof output.normalizedFolder === "string"
          ? output.normalizedFolder
          : asEffective(state.effective).outputFolder,
      resolvedPath:
        typeof output.resolvedPath === "string" ? output.resolvedPath : "—",
      withinAuthorizedScope: output.withinAuthorizedScope === true,
      inspected: false,
      exists: null,
    },
    runtime: {
      observable: runtime.observable === true,
      reasonUnavailable:
        typeof runtime.reasonUnavailable === "string"
          ? runtime.reasonUnavailable
          : undefined,
    },
    invocation: {
      mechanism: typeof invocation.mechanism === "string" ? invocation.mechanism : "command",
      name: typeof invocation.name === "string" ? invocation.name : "/interview",
      note: typeof invocation.note === "string" ? invocation.note : "",
    },
    warnings: Array.isArray(state.warnings)
      ? state.warnings.filter((w): w is string => typeof w === "string")
      : [],
  };
}

function metaFor(
  dto: InterviewView,
  field: InterviewField,
): InterviewFieldMetadata {
  return (
    dto.fieldMetadata.find((m) => m.name === field) ?? FALLBACK_METADATA[field]
  );
}

function fmtVal(v: unknown): string {
  if (v === undefined) return "(not set)";
  if (v === null) return "null";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

function shortHash(sha: string | null): string {
  if (!sha) return "—";
  return sha.length > 12 ? `${sha.slice(0, 12)}…` : sha;
}

function scopeLeaf(
  dto: InterviewView,
  scope: OmoScope,
  field: InterviewField,
): unknown {
  return dto.raw[scope]?.[field];
}

function firstInvalidPath(dto: InterviewView): string {
  const warning = dto.warnings[0] ?? "";
  const match = warning.match(/interview\.([A-Za-z]+)/);
  if (match?.[1] && INTERVIEW_FIELDS.includes(match[1] as InterviewField)) {
    return `interview.${match[1]}`;
  }
  return "interview";
}

function winningScope(dto: InterviewView): OmoScope | "builtin" {
  let sawUser = false;
  for (const field of INTERVIEW_FIELDS) {
    const stage = dto.properties[`interview.${field}`]?.winner?.stage;
    if (stage === "project-config") return "project";
    if (stage === "user-config") sawUser = true;
  }
  return sawUser ? "user" : "builtin";
}

function defaultActions(): Record<InterviewField, FieldAction> {
  return {
    maxQuestions: "unchanged",
    outputFolder: "unchanged",
    autoOpenBrowser: "unchanged",
    port: "unchanged",
    dashboard: "unchanged",
  };
}

function defaultValues(dto: InterviewView, scope: OmoScope): Record<InterviewField, string> {
  const leaf = (field: InterviewField, fallback: unknown) => {
    const scoped = scopeLeaf(dto, scope, field);
    return scoped === undefined ? String(fallback ?? "") : String(scoped);
  };
  return {
    maxQuestions: leaf("maxQuestions", dto.effective.maxQuestions),
    outputFolder: leaf("outputFolder", dto.effective.outputFolder),
    autoOpenBrowser: leaf("autoOpenBrowser", dto.effective.autoOpenBrowser),
    port: leaf("port", dto.effective.port),
    dashboard: leaf("dashboard", dto.effective.dashboard),
  };
}

function changeRows(changes: JsonChange[] | undefined) {
  if (!changes?.length) {
    return <p className="omo-sys-note">none</p>;
  }
  return (
    <table className="data">
      <thead>
        <tr>
          <th scope="col">Path</th>
          <th scope="col">Before</th>
          <th scope="col">After</th>
        </tr>
      </thead>
      <tbody>
        {changes.map((c) => (
          <tr key={`${c.op}:${c.path}`}>
            <td className="mono">{c.path}</td>
            <td className="mono">{fmtVal(c.before)}</td>
            <td className="mono">{c.op === "remove" ? "(removed)" : fmtVal(c.after)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function InterviewSection() {
  const [dto, setDto] = useState<InterviewView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [scope, setScope] = useState<OmoScope>("user");
  const [actions, setActions] = useState<Record<InterviewField, FieldAction>>(defaultActions);
  const [values, setValues] = useState<Record<InterviewField, string>>({
    maxQuestions: "2",
    outputFolder: "interview",
    autoOpenBrowser: "true",
    port: "0",
    dashboard: "false",
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [preview, setPreview] = useState<InterviewPreviewResponse | null>(null);
  const [previewOps, setPreviewOps] = useState<InterviewMutationOperation[] | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<{
    revisionId: string;
    hash?: string;
  } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const raw = await api.interview();
      const next = parseInterviewDto(raw);
      setDto(next);
      setValues(defaultValues(next, scope));
    } catch (e) {
      setDto(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    void load();
  }, [load]);

  const touch = () => {
    setPreview(null);
    setPreviewOps(null);
    setFormError(null);
    setStale(false);
    setApplied(null);
  };

  const capability = dto?.typedCapability ?? closedCapability("unavailable");
  const writable = capability.available === true && !!dto?.fingerprints;
  const schemaUnavailable =
    !capability.available &&
    /schema|unavailable/i.test(capability.reason ?? "");
  const fingerprint = dto?.fingerprints?.[scope] ?? null;
  const interviewDirty =
    editing && INTERVIEW_FIELDS.some((field) => actions[field] !== "unchanged");
  useUnsavedChangesWarning(
    interviewDirty,
    "This Interview editor has unsaved field changes. Leave anyway?",
  );

  const resolvedPort = useMemo(() => {
    if (actions.port === "set") {
      const n = Number(values.port);
      return Number.isInteger(n) ? n : dto?.effective.port ?? 0;
    }
    if (actions.port === "remove") return 0;
    const scoped = dto ? scopeLeaf(dto, scope, "port") : undefined;
    if (typeof scoped === "number") return scoped;
    return dto?.effective.port ?? 0;
  }, [actions.port, values.port, dto, scope]);

  const resolvedDashboard = useMemo(() => {
    if (actions.dashboard === "set") return values.dashboard === "true";
    if (actions.dashboard === "remove") return false;
    const scoped = dto ? scopeLeaf(dto, scope, "dashboard") : undefined;
    if (typeof scoped === "boolean") return scoped;
    return dto?.effective.dashboard ?? false;
  }, [actions.dashboard, values.dashboard, dto, scope]);

  const dashboardViaPort = resolvedPort > 0;
  const dashboardDefaultPort =
    resolvedDashboard && resolvedPort === 0;

  const buildOps = ():
    | { ops: InterviewMutationOperation[] }
    | { error: string } => {
    if (!dto) return { error: "Interview configuration is not loaded." };
    const ops: InterviewMutationOperation[] = [];
    const seen = new Set<InterviewField>();
    for (const field of INTERVIEW_FIELDS) {
      const action = actions[field];
      if (action === "unchanged") continue;
      if (seen.has(field)) return { error: `Duplicate operation for ${field}` };
      seen.add(field);
      const meta = metaFor(dto, field);
      if (action === "remove") {
        ops.push({ field, op: "remove" });
        continue;
      }
      if (field === "maxQuestions" || field === "port") {
        const n = Number(values[field]);
        if (!Number.isInteger(n)) {
          return { error: `interview.${field} must be an integer` };
        }
        if (meta.minimum !== undefined && n < meta.minimum) {
          return { error: `interview.${field} must be ≥ ${meta.minimum}` };
        }
        if (meta.maximum !== undefined && n > meta.maximum) {
          return { error: `interview.${field} must be ≤ ${meta.maximum}` };
        }
        ops.push({ field, op: "set", value: n });
        continue;
      }
      if (field === "outputFolder") {
        const text = values.outputFolder;
        if (text.trim().length < (meta.minLength ?? 1)) {
          return { error: "interview.outputFolder must be a non-empty string" };
        }
        ops.push({ field, op: "set", value: text });
        continue;
      }
      ops.push({ field, op: "set", value: values[field] === "true" });
    }
    if (ops.length === 0) {
      return { error: "Choose Set or Remove on at least one field." };
    }
    return { ops };
  };

  const requestBody = (
    ops: InterviewMutationOperation[],
    candidate?: string,
  ): InterviewMutationRequest | { error: string } => {
    if (!fingerprint) return { error: "Source fingerprint is not available." };
    return {
      scope,
      expectedSource: fingerprint,
      operations: ops,
      ...(candidate ? { expectedCandidateSha256: candidate } : {}),
    };
  };

  const runPreview = async () => {
    const built = buildOps();
    if ("error" in built) {
      setFormError(built.error);
      setPreview(null);
      return;
    }
    const body = requestBody(built.ops);
    if ("error" in body) {
      setFormError(body.error);
      return;
    }
    setBusy(true);
    setFormError(null);
    setStale(false);
    try {
      const { status, data } = await api.simulateInterview(body);
      if (status === 409 || data.code === "stale-source") {
        setPreview(null);
        setPreviewOps(null);
        setStale(true);
        return;
      }
      setPreview(data);
      setPreviewOps(built.ops);
    } catch (e) {
      setPreview(null);
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runApply = async () => {
    if (!preview?.ok || !preview.canApply || !preview.candidateSha256 || !previewOps) {
      return;
    }
    const body = requestBody(previewOps, preview.candidateSha256);
    if ("error" in body) {
      setFormError(body.error);
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const { status, data } = await api.applyInterview(body);
      const commit: InterviewCommitResponse = data;
      const next = commit.preview;
      if (status === 409 || next.code === "stale-source" || commit.code === "stale-source") {
        setPreview(null);
        setPreviewOps(null);
        setStale(true);
        return;
      }
      if (!commit.ok) {
        setPreview(next);
        setFormError((commit.errors ?? next.errors).join("; ") || "Apply failed");
        return;
      }
      setPreview(null);
      setPreviewOps(null);
      setActions(defaultActions());
      setApplied({
        revisionId: commit.revisionId ?? "unknown",
        hash: commit.source?.sha256 ?? next.candidateSha256,
      });
      notifyOmoSchemaStatusRefresh();
      await load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const reloadSource = async () => {
    setPreview(null);
    setPreviewOps(null);
    setStale(false);
    setFormError(null);
    await load();
  };

  if (error) {
    return (
      <div className="interview-section" data-testid="interview-section">
        <SectionIntro title="Interview" />
        <div className="error" role="alert">{error}</div>
      </div>
    );
  }
  if (loading || !dto) {
    return (
      <div className="omo-sys-quiet" data-testid="interview-section">
        Loading…
      </div>
    );
  }

  const winner = winningScope(dto);
  const invalidCurrent = dto.warnings.length > 0;
  const repairScope: OmoScope = winner === "project" ? "project" : "user";
  const repairHref = `/config?tab=raw&sourceId=${repairScope === "project" ? "project-omo" : "user-omo"}&path=${encodeURIComponent(firstInvalidPath(dto))}`;
  const applyReady =
    !!preview &&
    preview.ok &&
    preview.canApply &&
    !!preview.candidateSha256 &&
    !!previewOps &&
    !stale &&
    writable &&
    (preview.schemaValidation ? preview.schemaValidation.ok : true);

  const authorityLabel = capability.packageVersion
    ? `OMO-Slim ${capability.packageVersion}`
    : "installed schema";

  return (
    <div className="interview-section" data-testid="interview-section">
      <div data-testid="interview-summary">
        <SectionIntro
          title="Interview"
          description={
            <>
              {INTERVIEW_FIELDS.length} installed fields
              {writable ? " · editable configuration" : " · read-only"}
              {" · "}
              {authorityLabel}
              {capability.schemaHash ? (
                <>
                  {" "}
                  · <span className="mono">{shortHash(capability.schemaHash)}</span>
                </>
              ) : null}
            </>
          }
          actions={
            writable ? (
              <Button
                variant="primary"
                data-testid="interview-edit"
                onClick={() => {
                  if (editing) {
                    const dirty = INTERVIEW_FIELDS.some((field) => actions[field] !== "unchanged");
                    if (
                      dirty &&
                      !window.confirm("This Interview editor has unsaved field changes. Close anyway?")
                    ) {
                      return;
                    }
                    setEditing(false);
                    return;
                  }
                  setValues(defaultValues(dto, scope));
                  setActions(defaultActions());
                  touch();
                  setEditing(true);
                }}
              >
                {editing ? "Close editor" : "Edit"}
              </Button>
            ) : (
              <span className="pill warn" data-testid="interview-readonly">
                typed writes unavailable
              </span>
            )
          }
        />

        <div className="interview-authority omo-sys-pills omo-sys-pad" data-testid="interview-authority">
          {schemaUnavailable ? (
            <span className="pill warn">schema unavailable</span>
          ) : capability.available ? (
            <span className="pill ok">typed writes available</span>
          ) : (
            <span className="pill warn">typed writes closed</span>
          )}
          <span className="pill">restart required</span>
          <span className="pill">no runtime action</span>
        </div>

        {!capability.available ? (
          <div className="warn-block" data-testid="interview-closed">
            Interview typed writes are closed
            {capability.reason ? ` (${capability.reason})` : ""}. The raw
            configuration remains readable. This page does not start the
            interview server or open a browser.
          </div>
        ) : null}

        {invalidCurrent ? (
          <div className="warn-block" data-testid="interview-invalid-current">
            Current Interview configuration has a problem. Repair it in Raw
            Config, then reload.{" "}
            <Link to={repairHref} className="mono">
              Open Raw Config
            </Link>
          </div>
        ) : null}

        <Group>
          <SettingRow
            title="Questions"
            description={`${metaFor(dto, "maxQuestions").minimum ?? 1}–${metaFor(dto, "maxQuestions").maximum ?? 10}`}
            control={
              <span className="omo-sys-value" data-testid="interview-summary-questions">
                {dto.effective.maxQuestions}{" "}
                <ProvBadge properties={dto.properties} path="interview.maxQuestions" />
              </span>
            }
          />
          <SettingRow
            title="Output"
            description={
              <span data-testid="interview-summary-output">
                <span className="interview-output-path">
                  {dto.output.configuredFolder}
                  {dto.output.normalizedFolder !== dto.output.configuredFolder
                    ? ` → ${dto.output.normalizedFolder}`
                    : ""}
                </span>
                <div className="muted interview-output-path">{dto.output.resolvedPath}</div>
                <div className="muted">
                  Not inspected
                  {!dto.output.withinAuthorizedScope
                    ? " · outside authorized scope (path only, not an error)"
                    : ""}
                  . This page never lists or checks that folder.
                </div>
              </span>
            }
          />
          <SettingRow
            title="Browser"
            description={
              <span data-testid="interview-summary-browser">
                Configured preference only
                {dto.server.browser.autoDisabledInAutomated
                  ? " · OMO also disables this in test/CI"
                  : ""}
                . This page does not open a browser.
              </span>
            }
            control={
              <>
                <span className="omo-sys-value">
                  {dto.effective.autoOpenBrowser ? "Yes" : "No"}
                </span>
                <ProvBadge properties={dto.properties} path="interview.autoOpenBrowser" />
              </>
            }
          />
          <SettingRow
            title="Server"
            description={<span className="muted">{dto.server.portMeaning}</span>}
            control={
              <span className="omo-sys-value" data-testid="interview-summary-server">
                {dto.server.configuredPort === 0
                  ? dto.server.dashboardDerived.enabled &&
                    dto.server.dashboardDerived.via === "explicit"
                    ? `0 · default dashboard port ${dto.server.defaultDashboardPort}`
                    : "0 — Automatic / OS assigned"
                  : dto.server.configuredPort}{" "}
                <ProvBadge properties={dto.properties} path="interview.port" />
              </span>
            }
          />
          <SettingRow
            title="Dashboard"
            description={
              <>
                {dto.server.dashboardDerived.via === "explicit"
                  ? "Enabled in config"
                  : dto.server.dashboardDerived.via === "port"
                    ? "Enabled because port is greater than 0"
                    : "Not enabled"}
                {dto.effective.dashboard
                  ? ""
                  : dto.server.dashboardDerived.via === "port"
                    ? " · configured dashboard is still off"
                    : ""}
              </>
            }
            control={
              <span className="omo-sys-value" data-testid="interview-summary-dashboard">
                {dto.server.dashboardDerived.enabled ? "On" : "Off"}{" "}
                <ProvBadge properties={dto.properties} path="interview.dashboard" />
              </span>
            }
          />
          <SettingRow
            title="Source"
            description={
              dto.fingerprints ? (
                <>
                  user {dto.fingerprints.user.exists ? dto.fingerprints.user.format : "missing"}{" "}
                  {shortHash(dto.fingerprints.user.sha256)} · project{" "}
                  {dto.fingerprints.project.exists
                    ? dto.fingerprints.project.format
                    : "missing"}{" "}
                  {shortHash(dto.fingerprints.project.sha256)}
                </>
              ) : (
                "Source fingerprints unavailable"
              )
            }
            control={
              <span className="omo-sys-value" data-testid="interview-summary-source">
                {winner === "builtin"
                  ? "OMO default"
                  : winner === "project"
                    ? "project config wins"
                    : "user config wins"}
              </span>
            }
          />
        </Group>

        <p className="omo-sys-note">
          Interview reads this configuration when the plugin loads. An OpenCode
          restart is required before a change takes effect. No interview server,
          browser, or port action is taken here.
        </p>
      </div>

      {editing && writable ? (
        <div data-testid="interview-editor">
          <SectionIntro
            title="Edit Interview"
            description={
              <>
                Writes the <span className="mono">interview</span> block of the selected
                source. Unchanged leaves the leaf alone. Remove deletes only that
                source leaf so the next source or the installed default applies.
              </>
            }
          />
          <div className="omo-sys-toolbar">
            <label className="omo-sys-scope" htmlFor="interview-scope">
              <span className="omo-sys-scope-label">Source</span>
              <select
                id="interview-scope"
                name="interview-source"
                className="omo-sys-select"
                autoComplete="off"
                data-testid="interview-scope"
                value={scope}
                onChange={(e) => {
                  const next = e.target.value as OmoScope;
                  setScope(next);
                  setValues(defaultValues(dto, next));
                  setActions(defaultActions());
                  touch();
                }}
              >
                <option value="user">user</option>
                <option value="project">project</option>
              </select>
            </label>
            {fingerprint ? (
              <span className="muted mono" data-testid="interview-fingerprint">
                {fingerprint.exists ? fingerprint.format : "missing"} ·{" "}
                <span title={fingerprint.sha256 ?? undefined} translate="no">
                  {shortHash(fingerprint.sha256)}
                </span>{" "}
                · gen {fingerprint.generation}
              </span>
            ) : (
              <span className="muted">No fingerprint for this source</span>
            )}
          </div>

          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void runPreview();
            }}
          >
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Field</th>
                    <th scope="col">Action</th>
                    <th scope="col">Value</th>
                    <th scope="col">This source</th>
                  </tr>
                </thead>
                <tbody>
                  {INTERVIEW_FIELDS.map((field) => {
                    const meta = metaFor(dto, field);
                    const current = scopeLeaf(dto, scope, field);
                    return (
                      <tr key={field}>
                        <td>
                          <label htmlFor={`interview-action-${field}`}>
                            {FIELD_LABELS[field]}
                          </label>
                          <div className="muted mono">
                            interview.{field}
                          </div>
                        </td>
                        <td>
                          <select
                            id={`interview-action-${field}`}
                            name={`interview-action-${field}`}
                            autoComplete="off"
                            data-testid={`interview-action-${field}`}
                            value={actions[field]}
                            onChange={(e) => {
                              touch();
                              setActions((a) => ({
                                ...a,
                                [field]: e.target.value as FieldAction,
                              }));
                            }}
                          >
                            <option value="unchanged">Keep unchanged</option>
                            <option value="set">Set value</option>
                            <option value="remove">Remove override (inherit)</option>
                          </select>
                        </td>
                        <td>
                          {actions[field] === "set" ? (
                            field === "maxQuestions" ? (
                              <>
                                <input
                                  id={`interview-value-${field}`}
                                  name="interview-max-questions"
                                  autoComplete="off"
                                  inputMode="numeric"
                                  data-testid={`interview-value-${field}`}
                                  aria-label="Questions value"
                                  type="number"
                                  min={meta.minimum}
                                  max={meta.maximum}
                                  step={1}
                                  value={values.maxQuestions}
                                  onChange={(e) => {
                                    touch();
                                    setValues((v) => ({
                                      ...v,
                                      maxQuestions: e.target.value,
                                    }));
                                  }}
                                />{" "}
                                <span className="muted">
                                  {meta.minimum}–{meta.maximum}
                                </span>
                              </>
                            ) : field === "outputFolder" ? (
                              <input
                                id={`interview-value-${field}`}
                                name="interview-output-folder"
                                autoComplete="off"
                                spellCheck={false}
                                data-testid={`interview-value-${field}`}
                                aria-label="Output folder"
                                type="text"
                                placeholder="interview…"
                                value={values.outputFolder}
                                onChange={(e) => {
                                  touch();
                                  setValues((v) => ({
                                    ...v,
                                    outputFolder: e.target.value,
                                  }));
                                }}
                              />
                            ) : field === "port" ? (
                              <div className="interview-port-edit">
                                <select
                                  id={`interview-value-${field}`}
                                  name="interview-port-mode"
                                  autoComplete="off"
                                  data-testid="interview-port-mode"
                                  aria-label="Server port mode"
                                  value={values.port === "0" ? "auto" : "custom"}
                                  onChange={(e) => {
                                    touch();
                                    setValues((v) => ({
                                      ...v,
                                      port: e.target.value === "auto" ? "0" : v.port === "0" ? "43211" : v.port,
                                    }));
                                  }}
                                >
                                  <option value="auto">Automatic / OS assigned</option>
                                  <option value="custom">Explicit port</option>
                                </select>
                                {values.port !== "0" ? (
                                  <input
                                    name="interview-port"
                                    autoComplete="off"
                                    inputMode="numeric"
                                    data-testid="interview-value-port"
                                    aria-label="Server port"
                                    type="number"
                                    min={1}
                                    max={65535}
                                    value={values.port}
                                    onChange={(e) => {
                                      touch();
                                      setValues((v) => ({ ...v, port: e.target.value }));
                                    }}
                                  />
                                ) : null}
                              </div>
                            ) : (
                              <select
                                id={`interview-value-${field}`}
                                name={`interview-value-${field}`}
                                autoComplete="off"
                                data-testid={`interview-value-${field}`}
                                aria-label={`${FIELD_LABELS[field]} value`}
                                value={values[field]}
                                onChange={(e) => {
                                  touch();
                                  setValues((v) => ({ ...v, [field]: e.target.value }));
                                }}
                              >
                                <option value="true">Yes</option>
                                <option value="false">No</option>
                              </select>
                            )
                          ) : (
                            <span className="muted mono">{fmtVal(current)}</span>
                          )}
                        </td>
                        <td className="mono muted">{fmtVal(current)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {dashboardDefaultPort ? (
              <p className="omo-sys-note" data-testid="interview-port-default">
                Dashboard on with port 0 uses installed default port{" "}
                {dto.server.defaultDashboardPort}. That is not an OS-assigned port.
              </p>
            ) : null}
            {dashboardViaPort ? (
              <p className="omo-sys-note" data-testid="interview-port-implies-dashboard">
                A port greater than 0 turns dashboard mode on, even if the
                dashboard field stays off or unchanged.
              </p>
            ) : null}
            {actions.autoOpenBrowser === "set" ? (
              <p className="omo-sys-note">
                Saves the configured browser preference only. This page never
                opens a window.
              </p>
            ) : null}

            {formError ? (
              <div
                className="error"
                role="alert"
                data-testid="interview-form-error"
              >
                {formError}
              </div>
            ) : null}

            <div className="omo-sys-pad">
              <ActionBar>
                <Button
                  type="submit"
                  data-testid="interview-preview"
                  disabled={busy}
                >
                  {busy ? "Working…" : "Preview"}
                </Button>
                <Button
                  data-testid="interview-reload"
                  disabled={busy}
                  onClick={() => void reloadSource()}
                >
                  Reload source
                </Button>
              </ActionBar>
            </div>
          </form>

          {stale ? (
            <div className="warn-block" role="alert" data-testid="interview-stale">
              The source changed since this editor loaded. Reload, then Preview
              again. Apply stays off until a fresh preview succeeds.
            </div>
          ) : null}

          {preview ? (
            <div
              className="omo-sys-preview"
              data-testid="interview-preview-panel"
              role="status"
              aria-live="polite"
            >
              <div className="section-title">Preview — interview ({scope})</div>
              <dl className="row-kv interview-kv">
                <dt>Can apply</dt>
                <dd>{preview.canApply && preview.ok ? "yes" : "no"}</dd>
                <dt>Restart</dt>
                <dd>
                  {preview.restartRequired
                    ? "required after apply — plugin load only"
                    : "not required"}
                </dd>
                <dt>Runtime action</dt>
                <dd data-testid="interview-runtime-action">{preview.runtimeAction}</dd>
                <dt>Target</dt>
                <dd className="mono interview-output-path" title={preview.target.path}>
                  {preview.target.path} ({preview.target.format})
                </dd>
              </dl>

              <div className="section-title">Field operations</div>
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Field</th>
                    <th scope="col">Op</th>
                    <th scope="col">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {(previewOps ?? []).map((op) => (
                    <tr key={op.field}>
                      <td className="mono">interview.{op.field}</td>
                      <td>{op.op}</td>
                      <td className="mono">
                        {op.op === "remove" ? "(inherit)" : fmtVal(op.value)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="section-title">Source impact</div>
              {changeRows(preview.sourceChanges)}
              <div className="section-title">Desired impact</div>
              {changeRows(preview.desiredChanges)}
              <div className="section-title">Effective impact</div>
              {changeRows(preview.effectiveChanges)}
              <div className="section-title">Provenance impact</div>
              {preview.provenanceChanges?.length ? (
                <table className="data">
                  <thead>
                    <tr>
                      <th scope="col">Path</th>
                      <th scope="col">Before</th>
                      <th scope="col">After</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.provenanceChanges.map((c: ProvenanceChange) => (
                      <tr key={c.path}>
                        <td className="mono">{c.path}</td>
                        <td className="mono">
                          {c.before?.stage ?? "—"} {fmtVal(c.before?.value)}
                        </td>
                        <td className="mono">
                          {c.after?.stage ?? "—"} {fmtVal(c.after?.value)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="omo-sys-note">none</p>
              )}

              <SchemaBlock sv={preview.schemaValidation} />

              <div className="section-title">Semantic validation</div>
              {(preview.semanticValidation.issues ?? []).length ? (
                <ul className="omo-sys-list mono">
                  {preview.semanticValidation.issues.map((iss, i) => (
                    <li key={i}>
                      {iss.path ?? "(root)"} — {iss.message}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="omo-sys-note">no issues</p>
              )}

              {(preview.errors ?? []).length ? (
                <div className="error" role="alert">
                  {preview.errors.map((e) => (
                    <div key={e}>{e}</div>
                  ))}
                </div>
              ) : null}

              <div className="section-title">Text diff</div>
              <pre className="msg-pre diff-patch">
                {preview.textDiff?.text ?? "(no textual change)"}
              </pre>
              {preview.textDiff?.truncated ? (
                <p className="muted">Diff truncated — full source stays in the editor.</p>
              ) : null}

              <p className="omo-sys-note">
                <strong>No runtime action will be taken.</strong> Apply writes
                configuration only.
              </p>

              <ActionBar>
                <Button
                  variant="primary"
                  data-testid="interview-apply"
                  disabled={busy || !applyReady}
                  onClick={() => void runApply()}
                >
                  Apply
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => {
                    setPreview(null);
                    setPreviewOps(null);
                  }}
                >
                  Discard preview
                </Button>
              </ActionBar>
            </div>
          ) : null}

          <div aria-live="polite" role="status" data-testid="interview-apply-status">
            {applied ? (
              <div className="info-block">
                Applied — revision{" "}
                <span className="mono" translate="no">
                  {applied.revisionId}
                </span>
                {applied.hash ? (
                  <>
                    {" "}
                    ·{" "}
                    <span className="mono" title={applied.hash} translate="no">
                      {shortHash(applied.hash)}
                    </span>
                  </>
                ) : null}
                . Interview reads configuration at plugin load; no runtime
                action was taken.
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {dto.server.notes.length ? (
        <Group title="Notes">
          <ul className="omo-sys-list mono">
            {dto.server.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Group>
      ) : null}

      {dto.warnings.length ? (
        <div className="omo-sys-pills omo-sys-pad">
          {dto.warnings.map((w) => (
            <span key={w} className="pill warn">
              {w}
            </span>
          ))}
        </div>
      ) : null}

      <Group title="Invocation">
        <SettingRow
          title={dto.invocation.name}
          description={dto.invocation.note || "OpenCode command"}
          control={
            <span className="omo-sys-value">
              {dto.runtime.observable
                ? "Observable"
                : "No interview runtime state is exposed"}
              {dto.runtime.reasonUnavailable ? ` · ${dto.runtime.reasonUnavailable}` : ""}
            </span>
          }
        />
      </Group>

      {dto.raw.user != null ? (
        <TechDetails summary="raw: user config">
          <pre className="msg-pre raw-json">{JSON.stringify(dto.raw.user, null, 2)}</pre>
        </TechDetails>
      ) : null}
      {dto.raw.project != null ? (
        <TechDetails summary="raw: project config">
          <pre className="msg-pre raw-json">{JSON.stringify(dto.raw.project, null, 2)}</pre>
        </TechDetails>
      ) : null}
    </div>
  );
}

function SchemaBlock(props: { sv?: SchemaValidationSummary }) {
  const sv = props.sv;
  if (!sv) return null;
  return (
    <div
      data-testid="interview-schema-validation"
      className={sv.unavailable ? "warn-block" : sv.ok ? "info-block" : "error"}
    >
      <strong>OMO-Slim schema validation</strong>{" "}
      {sv.unavailable ? (
        <span className="pill warn">schema unavailable — writes blocked</span>
      ) : sv.ok ? (
        <span className="pill ok">
          ✓ valid against installed schema
          {sv.packageVersion ? ` ${sv.packageVersion}` : ""}
        </span>
      ) : (
        <>
          <span className="pill bad">✕ invalid</span>
          <ul className="omo-sys-list mono">
            {(sv.issues ?? []).map((iss, i) => (
              <li key={i}>
                {iss.path || "(root)"} — {iss.message}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
