import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { OpenCodeLifecyclePanel } from "../components/OpenCodeLifecyclePanel";
import { Button } from "../components/ui/Button";
import { StatusBadge } from "../components/ui/StatusBadge";
import type { MultiplexerSystemDto, OmoSchemaStatus } from "@omo/shared";
import { notifyOmoSchemaStatusRefresh } from "../hooks/useOmoSchemaStatus";
import { ProvBadge } from "./system/ProvBadge";
import { InterviewSection } from "./system/InterviewSection";
import { MultiplexerSection } from "./system/MultiplexerSection";
import { TelemetryBridgeSection } from "./system/TelemetryBridgeSection";
import {
  ActionBar,
  Group,
  SectionIntro,
  SettingRow,
  Switch,
  TechDetails,
} from "./system/SystemPrimitives";
import { SystemGroupTrack, SystemSectionIndex } from "./system/SystemNav";
import {
  GROUP_SECTIONS,
  SECTION_SLUGS,
  SYSTEM_GROUPS,
  parseSection,
  writeSectionParam,
  type Section,
} from "./system/system-nav";
import "../styles/system.css";

interface GlobalsData {
  globals: Record<string, unknown>;
  effective: Record<string, unknown>;
  live: { mcp: Record<string, { status: string }>; agents: string[] };
  environment: Record<string, string>;
  properties: Record<string, { winner: { stage: string; sourcePath: string }; value: unknown }>;
}

interface OptionCapabilities {
  readable: boolean;
  resolved: boolean;
  provenance: boolean;
  editable: boolean;
  runtimeObservable: boolean | "partial";
  runtimeControllable: boolean;
  doctor: boolean;
}

interface CatalogEntry {
  path: string;
  support: string;
  effect: string;
  defaultValue?: unknown;
  schemaType: string;
  capabilities?: OptionCapabilities;
}

interface ResolvedProperty {
  value: unknown;
  winner?: { stage?: string; sourceLabel?: string; sourcePath?: string };
  overridden?: unknown[];
  reason?: string;
}

interface FieldMeta {
  name: string;
  schemaType: string;
  defaultValue?: unknown;
  enumValues?: string[];
  minimum?: number;
  maximum?: number;
  desc?: string;
}

interface CompanionDto {
  fields: Record<string, FieldMeta>;
  desired: Record<string, unknown> | null;
  effective: {
    enabled: boolean;
    binaryPath?: string;
    position: string;
    size: string;
    gifPack: string;
    loopStyle: string;
    speed: number;
    debug: boolean;
  };
  properties: Record<string, ResolvedProperty>;
  raw: { user?: unknown; project?: unknown };
  binary: {
    configuredPath?: string;
    defaultPath: string;
    resolutionSource: "configured" | "default";
    withinAuthorizedScope: boolean;
    inspected: boolean;
    exists: boolean | null;
  };
  runtime: { observable: boolean; reasonUnavailable?: string };
  activation: string[];
  warnings: string[];
}

const BACKGROUND_JOB_FIELDS = [
  "backgroundJobs.strategy",
  "backgroundJobs.maxSessionsPerAgent",
  "backgroundJobs.maxContextLines",
  "backgroundJobs.readContextMinLines",
  "backgroundJobs.readContextMaxFiles",
  "backgroundJobs.maxRetainedSnapshots",
  "backgroundJobs.continueOnIdle",
  "backgroundJobs.wallClockTimeoutMs",
  "backgroundJobs.abortGraceMs",
] as const;

const FALLBACK_FIELDS = [
  "fallback.enabled",
  "fallback.timeoutMs",
  "fallback.retryDelayMs",
  "fallback.maxRetries",
  "fallback.retry_on_empty",
] as const;

const STARTUP_FIELDS: Array<[string, string, unknown]> = [
  ["Compact sidebar", "compactSidebar", true],
  ["Set default agent", "setDefaultAgent", undefined],
  ["Auto update", "autoUpdate", true],
  ["Strip orchestrator model", "stripOrchestratorModel", false],
];

const DISABLE_KEYS = [
  "disabled_agents",
  "disabled_skills",
  "disabled_mcps",
  "disabled_tools",
] as const;

const CAP_MARKS: ReadonlyArray<[string, keyof OptionCapabilities]> = [
  ["R", "readable"],
  ["S", "resolved"],
  ["P", "provenance"],
  ["E", "editable"],
  ["O", "runtimeObservable"],
  ["C", "runtimeControllable"],
  ["D", "doctor"],
];

function capMark(label: string, value: boolean | "partial") {
  const glyph = value === "partial" ? "partial" : value ? "✓" : "—";
  return (
    <span key={label} className={value ? undefined : "muted"}>
      {label}
      <span className={value === "partial" ? "muted" : undefined}>{glyph}</span>
    </span>
  );
}

function schemaTone(
  present: boolean,
  valid: boolean | null,
): "ok" | "warn" | "bad" | "neutral" {
  if (!present) return "neutral";
  if (valid === true) return "ok";
  if (valid === false) return "bad";
  return "warn";
}

function schemaLabel(present: boolean, valid: boolean | null): string {
  if (!present) return "Not present";
  if (valid === true) return "Valid";
  if (valid === false) return "Invalid";
  return "Unchecked";
}

function fmt(value: unknown, fallback = "—"): string {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string") return value;
  return String(value);
}

export function SystemPage() {
  const [data, setData] = useState<GlobalsData | null>(null);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [searchParams, setSearchParams] = useSearchParams();
  // URL-addressable section: /system?section=multiplexer etc. Default
  // (Overview) is omitted from the URL; unrelated params are preserved.
  const section = parseSection(searchParams.get("section"));
  const setSection = (s: Section) =>
    setSearchParams((prev) => writeSectionParam(prev, s));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editField, setEditField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [simResult, setSimResult] = useState<Record<string, unknown> | null>(null);
  const [scope, setScope] = useState<"user" | "project">("user");
  const [companion, setCompanion] = useState<CompanionDto | null>(null);
  const [companionError, setCompanionError] = useState<string | null>(null);
  const [multiplexer, setMultiplexer] = useState<MultiplexerSystemDto | null>(null);
  const [multiplexerError, setMultiplexerError] = useState<string | null>(null);
  const [schemaStatus, setSchemaStatus] = useState<OmoSchemaStatus | null>(null);
  const [schemaError, setSchemaError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setCompanionError(null);
    try {
      const [g, c] = await Promise.all([
        fetch("/api/system/globals").then((r) => r.json()),
        fetch("/api/system/options").then((r) => r.json()),
      ]);
      setData(g as GlobalsData);
      setCatalog((c as { catalog: CatalogEntry[] }).catalog);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    try {
      const r = await fetch("/api/system/companion");
      if (!r.ok) throw new Error(`/api/system/companion → ${r.status}`);
      setCompanion((await r.json()) as CompanionDto);
    } catch (e) {
      setCompanion(null);
      setCompanionError(e instanceof Error ? e.message : String(e));
    }
    // Multiplexer subsystem (Slice 16) — soft-fails like companion.
    try {
      const r = await fetch("/api/system/multiplexer");
      if (!r.ok) throw new Error(`/api/system/multiplexer → ${r.status}`);
      setMultiplexer((await r.json()) as MultiplexerSystemDto);
      setMultiplexerError(null);
    } catch (e) {
      setMultiplexer(null);
      setMultiplexerError(e instanceof Error ? e.message : String(e));
    }
    // OMO-Slim schema status (installed schema + user/project validity).
    // Soft-fails — the section reports unavailable like companion.
    try {
      const r = await fetch("/api/omo/schema");
      if (!r.ok) throw new Error(`/api/omo/schema → ${r.status}`);
      setSchemaStatus((await r.json()) as OmoSchemaStatus);
      setSchemaError(null);
    } catch (e) {
      setSchemaStatus(null);
      setSchemaError(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const hash = async () => {
    const st = await fetch("/api/config/edit-state").then((r) => r.json());
    return scope === "user" ? st.user.hash : st.project.hash;
  };

  const simulate = async (body: Record<string, unknown>) => {
    const r = await fetch("/api/config/global/simulate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "global-settings", scope, ...body, expectedSourceHash: await hash() }),
    });
    return (await r.json()) as Record<string, unknown>;
  };

  const apply = async (body: Record<string, unknown>) => {
    const r = await fetch("/api/config/global/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "global-settings", scope, ...body, expectedSourceHash: await hash() }),
    });
    const d = await r.json();
    if (!d.ok) {
      setError((d.errors || []).join("; "));
      return;
    }
    setSimResult(null);
    setEditField(null);
    notifyOmoSchemaStatusRefresh();
    await load();
  };

  void simulate;

  const g = data?.globals ?? {};
  const props = data?.properties ?? {};

  const field = (path: string) => {
    const p = props[path];
    return {
      value: p?.value,
      stage: p?.winner?.stage ?? "builtin",
      source: p?.winner?.sourcePath ?? "OMO default",
    };
  };

  const sourceNote = (path: string) => `Source: ${field(path).source}`;

  return (
    <div className="omo-system">
      <PageHeader
        title="System"
        meta={data ? `global OMO configuration` : undefined}
        onRefresh={() => void load()}
        loading={loading}
      />
      {error ? <div className="error">{error}</div> : null}

      <SystemGroupTrack section={section} onSectionChange={setSection} />

      <div className="omo-sys-sheet">
        <div className="omo-sys-toolbar">
          <SystemSectionIndex section={section} onSectionChange={setSection} />
          {/* Section chooser: every original section stays one accessible
              action and deep link (?section= slug) even though the index
              above only shows the current group. Values are the URL slugs. */}
          <label className="omo-sys-scope" htmlFor="system-section-chooser">
            <span className="omo-sys-scope-label">Section</span>
            <select
              id="system-section-chooser"
              name="system-section"
              className="omo-sys-select"
              autoComplete="off"
              value={SECTION_SLUGS[section]}
              onChange={(e) => setSection(parseSection(e.target.value))}
            >
              {SYSTEM_GROUPS.map((g) => (
                <optgroup key={g} label={g}>
                  {GROUP_SECTIONS[g].map((s) => (
                    <option key={s} value={SECTION_SLUGS[s]}>
                      {s}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <label className="omo-sys-scope" htmlFor="system-scope">
            <span className="omo-sys-scope-label">Scope</span>
            <select
              id="system-scope"
              name="system-scope"
              className="omo-sys-select"
              autoComplete="off"
              value={scope}
              onChange={(e) => setScope(e.target.value as "user" | "project")}
            >
              <option value="user">user</option>
              <option value="project">project</option>
            </select>
          </label>
        </div>

        <div className="omo-sys-body">
          {section === "Overview" ? (
            <>
              <SectionIntro
                title="Overview"
                description="The live effective values for the settings that most often change orchestration behavior."
              />
              <div className="omo-sys-metric-grid">
                <div className="omo-sys-metric">
                  <div className="omo-sys-metric-label">Image routing</div>
                  <div className="omo-sys-metric-value">
                    {fmt(field("image_routing").value, "direct (default)")}
                  </div>
                  <div className="omo-sys-metric-sub">{sourceNote("image_routing")}</div>
                </div>
                <div className="omo-sys-metric">
                  <div className="omo-sys-metric-label">Background jobs</div>
                  <div className="omo-sys-metric-value">
                    {fmt(field("backgroundJobs.maxSessionsPerAgent").value, "2")}
                  </div>
                  <div className="omo-sys-metric-sub">
                    workers/agent · ctx {fmt(field("backgroundJobs.maxContextLines").value, "50000")}
                  </div>
                </div>
                <div className="omo-sys-metric">
                  <div className="omo-sys-metric-label">Fallback</div>
                  <div className="omo-sys-metric-value">
                    {String(field("fallback.enabled").value ?? true) === "true" ? "enabled" : "disabled"}
                  </div>
                  <div className="omo-sys-metric-sub">
                    retries {fmt(field("fallback.maxRetries").value, "3")}
                  </div>
                </div>
                <div className="omo-sys-metric">
                  <div className="omo-sys-metric-label">Disabled agents</div>
                  <div className="omo-sys-metric-value">
                    {Array.isArray(g.disabled_agents) ? g.disabled_agents.length : 0}
                  </div>
                  <div className="omo-sys-metric-sub omo-mono">
                    {Array.isArray(g.disabled_agents)
                      ? g.disabled_agents.join(", ") || "none"
                      : "default (observer)"}
                  </div>
                </div>
              </div>
            </>
          ) : null}

          {section === "OpenCode Backend" ? (
            <>
              <OpenCodeLifecyclePanel />
              <p className="omo-sys-quiet omo-sys-pad">
                Mode, ownership, and readiness come from the control plane
                lifecycle. Live REST/SSE freshness stays in the connection bar.
              </p>
            </>
          ) : null}

          {section === "Global Availability" ? (
            <>
              <SectionIntro
                title="Global availability"
                description="Disabled lists replace, they do not union. Remove an override to inherit the next source or the installed default."
              />
              {DISABLE_KEYS.map((key) => (
                <Group key={key} title={key.replaceAll("_", " ")}>
                  <SettingRow
                    title={key}
                    description={
                      <>
                        Effective:{" "}
                        {JSON.stringify(
                          key === "disabled_agents" ? data?.effective.disabled_agents : g[key] ?? [],
                        )}
                        {" · "}
                        {sourceNote(key)}
                      </>
                    }
                    control={
                      <>
                        <Button
                          size="sm"
                          onClick={() => {
                            setEditField(key);
                            setEditValue(JSON.stringify(g[key] ?? []));
                          }}
                        >
                          Edit array
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => {
                            void apply({ [key]: { operation: "remove" } });
                          }}
                        >
                          Remove override
                        </Button>
                      </>
                    }
                  />
                </Group>
              ))}
              {editField ? (
                <Group title={`Set ${editField}`}>
                  <SettingRow
                    stacked
                    title={editField}
                    description="JSON array of identifiers. Apply writes the selected scope only."
                    control={
                      <input
                        className="mono omo-sys-input-wide"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                      />
                    }
                  />
                  <div className="omo-sys-pad">
                    <ActionBar>
                      <Button
                        variant="primary"
                        onClick={() => {
                          try {
                            const arr = JSON.parse(editValue) as string[];
                            void apply({ [editField]: { operation: "set", value: arr } });
                          } catch {
                            setError("invalid array JSON");
                          }
                        }}
                      >
                        Apply
                      </Button>
                      <Button onClick={() => setEditField(null)}>Cancel</Button>
                    </ActionBar>
                  </div>
                </Group>
              ) : null}
            </>
          ) : null}

          {section === "Background Jobs" ? (
            <>
              <SectionIntro
                title="Background jobs"
                description="Worker reuse, context retention, and execution supervision. Model request timeout lives under Failure Handling."
              />
              <Group>
                {BACKGROUND_JOB_FIELDS.map((p) => {
                  const f = field(p);
                  const def = catalog.find((c) => c.path === p)?.defaultValue;
                  return (
                    <SettingRow
                      key={p}
                      title={p.replace("backgroundJobs.", "")}
                      description={
                        <>
                          <span className="mono">{p}</span>
                          {" · "}default {JSON.stringify(def)}
                          {" · "}
                          {sourceNote(p)}
                        </>
                      }
                      control={
                        <>
                          <span className="omo-sys-value omo-mono">{fmt(f.value)}</span>
                          <Button
                            size="sm"
                            onClick={() => {
                              setEditField(p);
                              setEditValue(String(f.value ?? ""));
                            }}
                          >
                            Edit
                          </Button>
                        </>
                      }
                    />
                  );
                })}
              </Group>
              {editField?.startsWith("backgroundJobs.") ? (
                <Group title={`Edit ${editField}`}>
                  <SettingRow
                    stacked
                    title={editField}
                    description="Booleans accept true/false. Numbers are written as numbers."
                    control={
                      <input
                        className="mono omo-sys-input-wide"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                      />
                    }
                  />
                  <div className="omo-sys-pad">
                    <ActionBar>
                      <Button
                        variant="primary"
                        onClick={() => {
                          const key = editField.replace("backgroundJobs.", "");
                          const raw = editValue.trim();
                          const v =
                            raw === "true" || raw === "false"
                              ? raw === "true"
                              : Number.isNaN(Number(raw))
                                ? raw
                                : Number(raw);
                          void apply({ backgroundJobs: { [key]: { operation: "set", value: v } } });
                        }}
                      >
                        Apply
                      </Button>
                      <Button
                        onClick={() => {
                          const key = editField.replace("backgroundJobs.", "");
                          void apply({ backgroundJobs: { [key]: { operation: "remove" } } });
                        }}
                      >
                        Remove
                      </Button>
                      <Button onClick={() => setEditField(null)}>Cancel</Button>
                    </ActionBar>
                  </div>
                </Group>
              ) : null}
            </>
          ) : null}

          {section === "Failure Handling" ? (
            <>
              <SectionIntro
                title="Failure handling"
                description="Model request timeout is distinct from the background-jobs worker deadline."
              />
              <Group>
                {FALLBACK_FIELDS.map((p) => {
                  const f = field(p);
                  const def = catalog.find((c) => c.path === p)?.defaultValue;
                  return (
                    <SettingRow
                      key={p}
                      title={p.replace("fallback.", "")}
                      description={
                        <>
                          <span className="mono">{p}</span>
                          {" · "}default {JSON.stringify(def)}
                          {" · "}
                          {sourceNote(p)}
                        </>
                      }
                      control={<span className="omo-sys-value omo-mono">{fmt(f.value)}</span>}
                    />
                  );
                })}
              </Group>
            </>
          ) : null}

          {section === "Routing" ? (
            <>
              <SectionIntro
                title="Routing"
                description="How images reach the Orchestrator. Auto routes through Observer when that agent is available."
              />
              <Group>
                <SettingRow
                  title="Image routing"
                  description={
                    <>
                      Effective: {fmt(field("image_routing").value, "direct (default)")} ·{" "}
                      {sourceNote("image_routing")}
                    </>
                  }
                  control={
                    <ActionBar>
                      <Button
                        onClick={() => void apply({ image_routing: { operation: "set", value: "auto" } })}
                      >
                        Set auto
                      </Button>
                      <Button
                        onClick={() => void apply({ image_routing: { operation: "set", value: "direct" } })}
                      >
                        Set direct
                      </Button>
                      <Button
                        onClick={() => void apply({ image_routing: { operation: "remove" } })}
                      >
                        Remove override
                      </Button>
                    </ActionBar>
                  }
                />
              </Group>
            </>
          ) : null}

          {section === "Startup / UI" ? (
            <>
              <SectionIntro
                title="Startup / UI"
                description="Installed OMO startup and sidebar preferences. Unsupported fields stay visible."
              />
              <Group>
                {STARTUP_FIELDS.map(([label, p, def]) => {
                  const f = field(p);
                  const isBool = typeof f.value === "boolean" || typeof def === "boolean";
                  return (
                    <SettingRow
                      key={p}
                      title={label}
                      description={
                        <>
                          <span className="mono">{p}</span>
                          {" · "}default {JSON.stringify(def)}
                          {" · "}
                          {sourceNote(p)}
                        </>
                      }
                      control={
                        isBool ? (
                          <Switch
                            checked={Boolean(f.value ?? def)}
                            disabled
                            label={label}
                          />
                        ) : (
                          <span className="omo-sys-value omo-mono">{fmt(f.value)}</span>
                        )
                      }
                    />
                  );
                })}
                <SettingRow
                  title="Startup toast"
                  description={<span className="mono">showStartupToast</span>}
                  control={<span className="pill warn">not in installed version</span>}
                />
              </Group>
            </>
          ) : null}

          {section === "Companion" ? (
            <>
              {companionError ? <div className="error">{companionError}</div> : null}
              {!companion && !companionError ? (
                <p className="omo-sys-quiet">Loading…</p>
              ) : null}
              {companion ? (
                <>
                  <SectionIntro
                    title="Companion"
                    description={`${Object.keys(companion.fields).length} supported fields · read-only · intentionally not developed further`}
                  />
                  {companion.warnings.length ? (
                    <div className="omo-sys-pills omo-sys-pad">
                      {companion.warnings.map((w) => (
                        <span key={w} className="pill warn">
                          {w}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <Group title="Effective">
                    <SettingRow
                      title="Enabled"
                      control={
                        <>
                          <Switch
                            checked={companion.effective.enabled}
                            disabled
                            label="Enabled"
                          />
                          <ProvBadge properties={companion.properties} path="companion.enabled" />
                        </>
                      }
                    />
                    <SettingRow
                      title="Position"
                      control={
                        <>
                          <span className="omo-sys-value">{companion.effective.position}</span>
                          <ProvBadge properties={companion.properties} path="companion.position" />
                        </>
                      }
                    />
                    <SettingRow
                      title="Size"
                      control={
                        <>
                          <span className="omo-sys-value">{companion.effective.size}</span>
                          <ProvBadge properties={companion.properties} path="companion.size" />
                        </>
                      }
                    />
                    <SettingRow
                      title="Gif pack"
                      control={
                        <>
                          <span className="omo-sys-value">{companion.effective.gifPack}</span>
                          <ProvBadge properties={companion.properties} path="companion.gifPack" />
                        </>
                      }
                    />
                    <SettingRow
                      title="Loop style"
                      control={
                        <>
                          <span className="omo-sys-value">{companion.effective.loopStyle}</span>
                          <ProvBadge properties={companion.properties} path="companion.loopStyle" />
                        </>
                      }
                    />
                    <SettingRow
                      title="Speed"
                      control={
                        <>
                          <span className="omo-sys-value">{companion.effective.speed}</span>
                          <ProvBadge properties={companion.properties} path="companion.speed" />
                        </>
                      }
                    />
                    <SettingRow
                      title="Debug"
                      control={
                        <>
                          <Switch
                            checked={companion.effective.debug}
                            disabled
                            label="Debug"
                          />
                          <ProvBadge properties={companion.properties} path="companion.debug" />
                        </>
                      }
                    />
                  </Group>
                  <Group title="Binary">
                    <SettingRow
                      title="Path"
                      description={
                        companion.binary.resolutionSource === "configured"
                          ? companion.binary.configuredPath ?? companion.effective.binaryPath ?? "—"
                          : "Auto-discovery"
                      }
                      control={
                        <span className="omo-sys-value omo-mono">{companion.binary.defaultPath}</span>
                      }
                    />
                    {!companion.binary.withinAuthorizedScope ? (
                      <p className="omo-sys-note">Outside authorized scope — not inspected</p>
                    ) : null}
                    {companion.binary.inspected ? (
                      <SettingRow
                        title="Exists"
                        control={
                          <span className="omo-sys-value">
                            {companion.binary.exists === null
                              ? "Unknown"
                              : companion.binary.exists
                                ? "Yes"
                                : "No"}
                          </span>
                        }
                      />
                    ) : null}
                  </Group>
                  <Group title="Runtime">
                    <SettingRow
                      title="Observability"
                      description={companion.runtime.reasonUnavailable}
                      control={
                        <span className="omo-sys-value">
                          {companion.runtime.observable ? "Observable" : "Not exposed by OMO"}
                        </span>
                      }
                    />
                  </Group>
                  <Group title="Activation">
                    {companion.activation.length ? (
                      <ul className="omo-sys-list mono">
                        {companion.activation.map((a) => (
                          <li key={a}>{a}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="omo-sys-note">none</p>
                    )}
                  </Group>
                  {companion.raw.user != null ? (
                    <TechDetails summary="raw: user config">
                      <pre className="msg-pre raw-json">
                        {JSON.stringify(companion.raw.user, null, 2)}
                      </pre>
                    </TechDetails>
                  ) : null}
                  {companion.raw.project != null ? (
                    <TechDetails summary="raw: project config">
                      <pre className="msg-pre raw-json">
                        {JSON.stringify(companion.raw.project, null, 2)}
                      </pre>
                    </TechDetails>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}

          {section === "Interview" ? <InterviewSection /> : null}

          {section === "Multiplexer" ? (
            <MultiplexerSection
              dto={multiplexer}
              error={multiplexerError}
              scope={scope}
              onChanged={() => void load()}
            />
          ) : null}

          {section === "Telemetry Bridge" ? <TelemetryBridgeSection /> : null}

          {section === "Environment" ? (
            <>
              <SectionIntro
                title="Environment"
                description="Process-level overrides. These are not written by the control plane."
              />
              <Group>
                {Object.entries(data?.environment ?? {}).map(([k, v]) => (
                  <SettingRow
                    key={k}
                    title={k}
                    control={<span className="omo-sys-value omo-mono">{v}</span>}
                  />
                ))}
              </Group>
            </>
          ) : null}

          {section === "Option Coverage" ? (
            <>
              <SectionIntro
                title="Option coverage"
                description={
                  catalog.some((c) => c.capabilities)
                    ? "Capabilities: R readable · S resolved · P provenance · E editable · O runtime-observable · C runtime-controllable · D doctor — ✓ supported, — not supported, partial limited"
                    : "Installed option catalog for this OMO-Slim version."
                }
              />
              <Group>
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Path</th>
                        <th>Type</th>
                        <th>Default</th>
                        <th>Support</th>
                        <th>Effect</th>
                        <th>Capabilities</th>
                      </tr>
                    </thead>
                    <tbody>
                      {catalog.map((c) => (
                        <tr key={c.path}>
                          <td className="mono">{c.path}</td>
                          <td className="mono">{c.schemaType}</td>
                          <td className="mono">{JSON.stringify(c.defaultValue)}</td>
                          <td>
                            <span
                              className={`pill ${
                                c.support.startsWith("implemented")
                                  ? "ok"
                                  : c.support === "deferred"
                                    ? "warn"
                                    : "bad"
                              }`}
                            >
                              {c.support}
                            </span>
                          </td>
                          <td className="mono">{c.effect}</td>
                          <td>
                            {c.capabilities ? (
                              <span className="omo-sys-caps">
                                {CAP_MARKS.map(([label, key]) =>
                                  capMark(label, c.capabilities?.[key] ?? false),
                                )}
                              </span>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Group>
            </>
          ) : null}

          {section === "Schema" ? (
            <div data-testid="schema-health">
              <SectionIntro
                title="OMO-Slim schema"
                description="Installed package schema plus user and project document validity. Writes stay blocked when the schema is unavailable."
              />
              {schemaError ? <div className="error">{schemaError}</div> : null}
              {!schemaStatus && !schemaError ? (
                <p className="omo-sys-quiet">Loading…</p>
              ) : null}
              {schemaStatus ? (
                <>
                  <Group>
                    <SettingRow
                      title="Installed OMO-Slim"
                      control={
                        <span className="omo-sys-value omo-mono">
                          {schemaStatus.packageVersion ?? "—"}
                        </span>
                      }
                    />
                    <SettingRow
                      title="Schema"
                      control={
                        schemaStatus.available ? (
                          <span className="pill ok">Loaded</span>
                        ) : (
                          <span className="pill warn">Unavailable</span>
                        )
                      }
                    />
                    <SettingRow
                      title="User config"
                      control={
                        <StatusBadge
                          tone={schemaTone(
                            schemaStatus.userConfig.present,
                            schemaStatus.userConfig.valid,
                          )}
                        >
                          {schemaLabel(
                            schemaStatus.userConfig.present,
                            schemaStatus.userConfig.valid,
                          )}
                        </StatusBadge>
                      }
                    />
                    <SettingRow
                      title="Project config"
                      control={
                        <StatusBadge
                          tone={schemaTone(
                            schemaStatus.projectConfig.present,
                            schemaStatus.projectConfig.valid,
                          )}
                        >
                          {schemaLabel(
                            schemaStatus.projectConfig.present,
                            schemaStatus.projectConfig.valid,
                          )}
                        </StatusBadge>
                      }
                    />
                  </Group>
                  {schemaStatus.available ? (
                    <p className="omo-sys-note mono">
                      schema {schemaStatus.schemaHash ?? "—"} · {schemaStatus.schemaPath ?? "—"}
                    </p>
                  ) : (
                    <p className="omo-sys-note">
                      {schemaStatus.error ??
                        "The installed OMO-Slim package does not ship a readable schema — configuration writes are blocked."}
                    </p>
                  )}
                </>
              ) : null}
            </div>
          ) : null}

          {simResult ? (
            <TechDetails summary="Simulation result">
              <pre className="msg-pre raw-json">{JSON.stringify(simResult, null, 2)}</pre>
            </TechDetails>
          ) : null}
        </div>
      </div>
    </div>
  );
}
