/**
 * Doctor diagnostic domain.
 * Deterministic, rule-based, explainable diagnostics across Desired → Effective → Live.
 */

export type DiagnosticSeverity =
  | "healthy"
  | "info"
  | "warning"
  | "error"
  | "unknown";

export type DiagnosticCategory =
  | "control-plane"
  | "opencode"
  | "omo"
  | "config"
  | "providers"
  | "models"
  | "agents"
  | "presets"
  | "prompts"
  | "capabilities"
  | "mcp"
  | "sessions"
  | "runtime"
  | "council"
  | "acp"
  | "companion"
  | "interview"
  | "revisions"
  | "filesystem"
  | "security"
  | "version"
  | "environment"
  | "telemetry";

export interface DiagnosticEvidence {
  label: string;
  kind:
    | "rest-endpoint"
    | "resolved-property"
    | "runtime-store"
    | "config-source"
    | "invariant"
    | "observation"
    | "limitation";
  value?: string;
}

export interface DiagnosticRemediation {
  action: "navigate";
  target: string; // UI route e.g. "/agents?focus=explorer"
  label: string;
}

export interface Diagnostic {
  /** Stable deterministic id, e.g. agent.explorer.model-drift */
  id: string;
  category: DiagnosticCategory;
  severity: DiagnosticSeverity;
  title: string;
  summary: string;
  entityType?: string;
  entityId?: string;
  desired?: unknown;
  effective?: unknown;
  live?: unknown;
  evidence?: DiagnosticEvidence[];
  sourcePaths?: string[];
  /** Logical raw source for Config workspace deep links. */
  sourceId?: "user-omo" | "project-omo";
  /** First schema/Interview issue path for Raw navigation. */
  issuePath?: string;
  relatedDiagnosticIds?: string[];
  remediation?: DiagnosticRemediation;
}

export interface DoctorCategorySummary {
  category: DiagnosticCategory;
  healthy: number;
  info: number;
  warning: number;
  error: number;
  unknown: number;
}

export type DoctorOverall = "healthy" | "degraded" | "error" | "unknown";

/**
 * Compact model-inventory health roll-up (Slice 15, Lane 2).
 * neverTested is informational — never rendered as alarming.
 */
export interface ModelHealthCounts {
  /** Models referenced by the effective configuration. */
  referenced: number;
  /** Models with at least one completed probe (ever). */
  probed: number;
  /** Models whose latest probe is healthy. */
  healthy: number;
  /** Models with a FRESH failing terminal probe (aborted excluded). */
  freshFailing: number;
  /** Referenced models never probed (informational). */
  neverTested: number;
}

export interface DoctorSnapshot {
  generatedAt: string;
  overall: DoctorOverall;
  counts: {
    healthy: number;
    info: number;
    warning: number;
    error: number;
    unknown: number;
  };
  categories: DoctorCategorySummary[];
  diagnostics: Diagnostic[];
  /** Present when the doctor input carried a composed model inventory. */
  modelHealth?: ModelHealthCounts;
  system: {
    openCodeVersion?: string;
    omoPackageVersion?: string;
    omoManifestVersion?: string;
    activeConfiguredPreset?: string;
    runtimePresetKnown: boolean;
    configGeneration: number;
    runtimeStale: boolean;
    lastEventAt?: string;
    lastReconcileAt?: string;
    backendMode: "managed" | "attach";
    backendOwnership: "control-plane" | "external";
    backendStatus: string;
    backendGeneration: number;
  };
}
