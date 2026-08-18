/** Shared DTOs for OMO Control Plane — Desired / Effective / Live */

export type ConfigScope = "user" | "project" | "env" | "builtin" | "runtime-preset";

export interface ConfigSource {
  id: string;
  scope: ConfigScope;
  path: string | null;
  format: "json" | "jsonc" | "md" | "env";
  hash?: string;
  mtimeMs?: number;
}

export interface ModelRef {
  id: string;
  variant?: string;
}

export interface DesiredAgent {
  name: string;
  kind: "builtin" | "custom";
  /**
   * Canonical persisted forms only: `"provider/model"` string, or an ordered
   * fallback array of strings / {id, variant} objects. A standalone
   * {id, variant} OBJECT (outside an array) is NOT schema-valid — runtime
   * readers must stay tolerant for legacy files, but the type reflects the
   * installed 2.2.10 schema.
   */
  model?: string | Array<string | ModelRef>;
  variant?: string;
  temperature?: number;
  skills?: string[];
  mcps?: string[];
  prompt?: string;
  orchestratorPrompt?: string;
  options?: Record<string, unknown>;
  displayName?: string;
  description?: string;
  permission?: unknown;
  /** Source ids that contributed fields */
  sourceIds: string[];
}

export interface DesiredOmoConfig {
  sources: ConfigSource[];
  activePresetName?: string;
  agents: Record<string, DesiredAgent>;
  presets: Record<string, Record<string, DesiredAgent>>;
  globals: {
    disabled_agents?: string[];
    disabled_mcps?: string[];
    disabled_tools?: string[];
    disabled_skills?: string[];
    backgroundJobs?: Record<string, unknown>;
    fallback?: Record<string, unknown>;
    companion?: Record<string, unknown>;
    council?: Record<string, unknown>;
    stripOrchestratorModel?: boolean;
    [key: string]: unknown;
  };
  raw: Record<string, unknown>;
}

export interface ProvenanceEntry {
  path: string;
  effectiveValue: unknown;
  winner: ConfigSource;
  reason: string;
  overridden: Array<{ source: ConfigSource; value: unknown }>;
}

/** Resolution stage for a candidate value */
export type ResolveStage =
  | "builtin"
  | "user-config"
  | "project-config"
  | "env"
  | "preset"
  | "root-agent"
  | "prompt-file"
  | "runtime-preset"
  | "merged";

export interface PropertyCandidate {
  value: unknown;
  sourceId: string;
  /** Human path e.g. file path or ENV:NAME */
  sourceLabel: string;
  /** JSON path within that source e.g. presets.openai.explorer.model */
  sourcePath: string;
  stage: ResolveStage;
  order: number;
  scope?: ConfigScope;
  filePath?: string | null;
}

export interface ResolvedProperty {
  path: string;
  value: unknown;
  winner: PropertyCandidate;
  overridden: PropertyCandidate[];
  reason: string;
  /** true when array was replaced wholesale at merge */
  arrayReplaced?: boolean;
}

export type ConfigWarningLevel = "info" | "warning" | "error";

export interface ConfigWarning {
  level: ConfigWarningLevel;
  kind: string;
  message: string;
  path?: string;
}

export interface EffectiveAgent {
  name: string;
  kind: "builtin" | "custom";
  enabled: boolean;
  modelPrimary?: string;
  modelFallbacks: string[];
  variant?: string;
  temperature?: number;
  skills: string[];
  mcps: string[];
  displayName?: string;
  description?: string;
  hasInlinePrompt: boolean;
  hasOrchestratorPrompt: boolean;
  /** @deprecated prefer fieldProvenance */
  provenance: ProvenanceEntry[];
  /** Per-field resolved properties under agents.<name>.* */
  fieldProvenance: Record<string, ResolvedProperty>;
  permission?: unknown;
  options?: Record<string, unknown>;
  prompt?: string;
  orchestratorPrompt?: string;
}

export interface EffectiveConfig {
  preset?: string;
  agents: Record<string, EffectiveAgent>;
  disabledAgents: string[];
  backgroundJobs: Record<string, unknown>;
  fallback: Record<string, unknown>;
  warnings: Array<{ kind: string; message: string; path?: string } | ConfigWarning>;
  sources: ConfigSource[];
  /** Full leaf-level provenance map path → ResolvedProperty */
  properties?: Record<string, ResolvedProperty>;
  /** Top-level globals as resolved object */
  globals?: Record<string, unknown>;
  /** Runtime preset observability */
  runtimePreset?: {
    known: boolean;
    name?: string | null;
    note: string;
  };
}

export type PromptSourceKind =
  | "builtin"
  | "inline"
  | "replacement-file"
  | "append-file";

export interface PromptSource {
  kind: PromptSourceKind;
  scope: "user" | "project" | "builtin" | "inline";
  preset?: string;
  path?: string;
  /** Present when content loaded */
  content?: string;
  contentLength?: number;
  applied: boolean;
  reason?: string;
  /** Search order rank (lower = higher priority for first-found) */
  rank?: number;
}

export interface EffectivePrompt {
  agent: string;
  sources: PromptSource[];
  baseSource: PromptSource;
  appendSources: PromptSource[];
  /** Composed text when requested */
  effectiveText?: string;
  /** Verified OMO resolvePrompt rule summary */
  compositionRule: string;
  warnings: string[];
}

export interface ConfigSourceInventoryItem {
  id: string;
  label: string;
  kind: "user-omo" | "project-omo" | "env" | "prompt-dir" | "opencode-json";
  path?: string | null;
  present: boolean;
  detail?: string;
}

export interface ProvenanceBundle {
  sources: ConfigSourceInventoryItem[];
  properties: Record<string, ResolvedProperty>;
  agents: Record<string, EffectiveAgent>;
  preset?: string;
  filePreset?: string;
  envPreset?: string;
  warnings: ConfigWarning[];
  runtimePreset: EffectiveConfig["runtimePreset"];
  prompts: Record<string, EffectivePrompt>;
  globals: Record<string, unknown>;
  rawMerged: Record<string, unknown>;
}

/**
 * Whitelisted model modalities/capability flags from OpenCode catalog
 * metadata (/config/providers or /provider). Never includes `headers`,
 * `options`, or any credential material.
 */
export interface LiveModelCapabilities {
  temperature?: boolean;
  reasoning?: boolean;
  attachment?: boolean;
  toolcall?: boolean;
  input?: {
    text?: boolean;
    audio?: boolean;
    image?: boolean;
    video?: boolean;
    pdf?: boolean;
  };
  output?: {
    text?: boolean;
    audio?: boolean;
    image?: boolean;
    video?: boolean;
    pdf?: boolean;
  };
}

export type ModelMetadataSource =
  | "opencode:/config/providers"
  | "opencode:/provider";

export interface LiveModel {
  id: string;
  name?: string;
  providerID: string;
  /** Whitelisted capability flags (optional for backward compat). */
  capabilities?: LiveModelCapabilities;
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number };
  status?: string;
  /** Which OpenCode endpoint this metadata was normalized from. */
  metadataSource?: ModelMetadataSource;
}

export interface LiveProvider {
  id: string;
  name: string;
  connected: boolean;
  source?: string;
  modelCount: number;
  models: LiveModel[];
}

export interface LiveAgent {
  name: string;
  mode?: string;
  native?: boolean;
  hidden?: boolean;
  description?: string;
  model?: { providerID: string; modelID: string };
  variant?: string;
  temperature?: number;
}

export interface LiveSession {
  id: string;
  parentID?: string;
  title?: string;
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
  directory?: string;
  projectID?: string;
  time?: { created?: number; updated?: number };
  /** Normalized status label: idle | busy | retry | error | unknown | … */
  status?: string;
  /** Raw OpenCode session.status payload when available */
  statusDetail?: unknown;
  /** Derived server-side: true for control-plane model-probe sessions
   * (excluded from public surfaces by default). Never set by OpenCode. */
  controlPlaneProbe?: boolean;
  children?: LiveSession[];
}

export type ConnState = "connected" | "connecting" | "reconnecting" | "disconnected";

/** Control-plane authority for the canonical OpenCode backend. */
export type OpenCodeLifecycleMode = "managed" | "attach";
export type OpenCodeLifecycleOwnership = "control-plane" | "external";
export type OpenCodeLifecycleStatus =
  | "initializing"
  | "starting"
  | "waiting-health"
  | "waiting-runtime"
  | "connected"
  | "restarting"
  | "stopped"
  | "failed";

export interface OpenCodeLifecycleReadiness {
  health: boolean;
  configProviders: boolean;
  providers: boolean;
  agents: boolean;
  /** True when registration is present, or when the OMO kill switch is intentional. */
  omo: boolean;
  omoExpected: boolean;
  rest: boolean;
  sse: boolean;
}

export interface OpenCodeLifecycleError {
  code: string;
  /** Bounded, credential-redacted message. */
  message: string;
  action: string;
  retryable: boolean;
  at: string;
}

/**
 * Public lifecycle state. Deliberately contains no PID, credentials, request
 * headers, or provider secrets. The installed SDK exposes only url + close().
 */
export interface OpenCodeLifecycleState {
  mode: OpenCodeLifecycleMode;
  ownership: OpenCodeLifecycleOwnership;
  status: OpenCodeLifecycleStatus;
  baseUrl?: string;
  version?: string;
  generation: number;
  projectDirectory: string;
  configDirectory: string;
  authConfigured: boolean;
  ready: OpenCodeLifecycleReadiness;
  detail?: string;
  restart?: {
    attempt: number;
    maxAttempts: number;
    nextRetryAt?: string;
    lastReason?: string;
  };
  error?: OpenCodeLifecycleError;
  updatedAt: string;
}

export interface RuntimeConnection {
  rest: ConnState;
  sse: ConnState;
  /** ISO timestamp of last OpenCode SSE event applied */
  lastEventAt?: string;
  /** Last OpenCode event type string */
  lastEventType?: string;
  /** ISO timestamp of last successful full REST reconcile/bootstrap */
  lastReconcileAt?: string;
  /** True when REST is down or SSE is down long enough that data may be stale */
  stale: boolean;
  restError?: string;
  sseError?: string;
  opencodeBaseUrl: string;
}

export interface LivePermission {
  id: string;
  sessionID?: string;
  permission?: string;
  patterns?: string[];
  tool?: unknown;
  metadata?: unknown;
  askedAt: string;
  source: "permission.asked" | "permission.v2.asked" | "rest";
}

export interface LiveSnapshot {
  health: { healthy: boolean; version?: string; error?: string };
  path?: {
    home?: string;
    state?: string;
    config?: string;
    worktree?: string;
    directory?: string;
  };
  projectCurrent?: unknown;
  providers: LiveProvider[];
  agents: LiveAgent[];
  sessions: LiveSession[];
  mcp: Record<string, { status: string }>;
  permissions: LivePermission[];
  connection: RuntimeConnection;
  fetchedAt: string;
  baseUrl: string;
  backendGeneration?: number;
}

/** Full runtime DTO served by control plane (from in-memory store). */
export interface RuntimeStateDto {
  health: LiveSnapshot["health"];
  path?: LiveSnapshot["path"];
  projectCurrent?: unknown;
  providers: LiveProvider[];
  agents: LiveAgent[];
  sessions: {
    roots: LiveSession[];
    flat: LiveSession[];
    total: number;
    byStatus: Record<string, number>;
  };
  mcp: Record<string, { status: string }>;
  permissions: LivePermission[];
  connection: RuntimeConnection;
  fetchedAt: string;
  baseUrl: string;
  backendGeneration?: number;
}

/**
 * Normalized events the browser receives on GET /api/events.
 * Frontend must not need OpenCode raw event schemas.
 */
export type ControlPlaneEvent =
  | { type: "hello"; version: string; at: string }
  | { type: "snapshot"; state: RuntimeStateDto; at: string }
  | {
      type: "connection";
      connection: RuntimeConnection;
      at: string;
    }
  | {
      type: "runtime.updated";
      /** Coarse reason for UI badges */
      reason: string;
      state: RuntimeStateDto;
      at: string;
    }
  | {
      type: "model-probes.updated";
      queue: ModelProbeQueueSnapshot;
      at: string;
    }
  | {
      type: "opencode.lifecycle.updated";
      lifecycle: OpenCodeLifecycleState;
      at: string;
    }
  | {
      type: "opencode.backend.generation";
      generation: number;
      baseUrl: string;
      ownership: OpenCodeLifecycleOwnership;
      at: string;
    }
  | {
      type: "telemetry-bridge.updated";
      /** Sanitized summarized bridge status — no raw config/nonce/credentials. */
      bridge: TelemetryBridgeStatusSummary;
      at: string;
    }
  | ConfigSourcesChangedEvent;

// ── Telemetry bridge status DTO (Slice 17) ──────────────────────────────
//
// Sanitized, summarized bridge lifecycle/registration/runtime/generation/
// epoch/capability availability. Never includes raw config, raw nonce, raw
// options, endpoint credentials, environment, or diffs. All fields are
// normalized enums, never a single boolean collapse.

/** Bridge runtime state (normalized, not collapsed to boolean). */
export type TelemetryBridgeRuntimeState =
  | "inactive"
  | "starting"
  | "active"
  | "failed"
  | "stale"
  | "unavailable"
  | "mismatch";

/** Bridge registration state of the plugin in the OpenCode config. */
export type TelemetryBridgeRegistrationState =
  | "not-registered"
  | "registered"
  | "duplicate"
  | "unknown";

/** Bridge compatibility with the current control-plane process. */
export type TelemetryBridgeCompatibility =
  | "compatible"
  | "incompatible"
  | "unknown";

/** Source of the bridge endpoint URL. */
export type TelemetryBridgeEndpointSource =
  | "managed-derived"
  | "explicit-override"
  | "unavailable";

/** OpenCode mode the bridge is associated with. */
export type TelemetryBridgeOpenCodeMode = "managed" | "attach";

/** Who owns the bridge process. */
export type TelemetryBridgeOwnership = "control-plane" | "external";

/** Local bridge package availability. */
export type TelemetryBridgeLocalPackage = boolean | "unknown";

/** Explicit lifecycle states (not one boolean). */
export type TelemetryBridgeLifecycleStatus =
  | "not-installed"
  | "available-locally"
  | "not-registered"
  | "registered"
  | "loading"
  | "active"
  | "registered-inactive"
  | "incompatible"
  | "failed"
  | "stale"
  | "external-unmanaged";

/** Per-store capability availability (v3 only). */
export type TelemetryBridgeStoreAvailability = "present" | "absent" | "malformed";

/** Capability-level availability for the four allowlisted stores. */
export interface TelemetryBridgeCapabilities {
  fallbackInProgress: TelemetryBridgeStoreAvailability;
  continuationGate: TelemetryBridgeStoreAvailability;
  multiplexerManager: TelemetryBridgeStoreAvailability;
  cmuxStore: TelemetryBridgeStoreAvailability;
  /** ALWAYS false — module var not exported. */
  runtimePreset: false;
  /** ALWAYS false — lives inside OMO closure. */
  workerReuse: false;
  /** ALWAYS false — no terminal/PTY/scrollback data is exposed. */
  terminalCapture: false;
}

/** Source gate status. */
export interface TelemetryBridgeSourceGate {
  present: boolean;
  path: string;
  format: "json" | "jsonc";
  hash: string;
  /** Schema gate mode: how the source was proven. */
  schemaGateMode: "proven" | "blocked" | "absent" | "committed-awaiting-restart";
  sourceKind?: "opencode-config-dir" | "project-root";
  pluginEntries: Array<{
    form: "string" | "tuple" | "unsupported";
    identity: string;
    identityKind: "npm" | "path" | "file-url";
  }>;
}

/** Desired activation state from the revision store (sanitized). */
export interface TelemetryBridgeDesiredState {
  managed: boolean;
  enabled: boolean;
  targetPath?: string;
  sourceKind?: "opencode-config-dir" | "project-root";
  /** Bind port (managed range 8788..8803). */
  port?: number;
  /** SHA-256 hex fingerprint of the activation nonce (64 lowercase hex). */
  nonceFingerprint?: string;
  /** Source hash of the config file. */
  sourceHash?: string;
  /** Revision id of the latest committed bridge-state revision. */
  revisionId?: string;
  /**
   * False when the latest committed bridge-state revision is metadata-only
   * (a drift-acceptance rebase): such revisions carry no byte patch and are
   * never restore-eligible. The original content-writing ADD anchor revision
   * is retained in history for future proof.
   */
  latestRevisionRestorable?: boolean;
  /** How the plugin is registered: "env" or "tuple". */
  registrationTransport?: "env" | "tuple";
  /** State disposition: not-written | committed | recovery-pending. */
  stateDisposition: "not-written" | "committed" | "recovery-pending";
}

/** Override status (OMO_BRIDGE_BASE_URL). */
export interface TelemetryBridgeOverride {
  present: boolean;
  /** Canonical validated URL (only when valid). */
  url?: string;
  port?: number;
  invalid: boolean;
  invalidReason?: string;
  optsOutOfManagement: boolean;
}

/** Effective registration entry (sanitized). */
export interface TelemetryBridgeEffectiveEntry {
  form: "string" | "tuple" | "unsupported";
  effectiveIdentity: string;
  identityKind: "npm" | "path" | "file-url";
  /** Present only for recognized bridge entries. */
  bridge?: {
    pluginForm?: "string" | "tuple";
    port?: number;
    registrationTransport: "env" | "tuple";
    transportMode: "loopback-http";
    nonceFingerprint?: string;
  };
}

/** Action eligibility for management operations. */
export interface TelemetryBridgeActionEligibility {
  /** Preview/apply registration is eligible. */
  canRegister: boolean;
  /** Preview/apply removal is eligible. */
  canRemove: boolean;
  /** Restore is eligible. */
  canRestore: boolean;
  /** Restart (activate/deactivate/recover) is eligible. */
  canRestart: boolean;
  /** Probe is eligible. */
  canProbe: boolean;
  /** Reasons when an action is not eligible. */
  reasons: string[];
}

/** Full sanitized bridge status DTO. */
export interface TelemetryBridgeStatusDto {
  /** Source gate (raw file on disk). */
  source: TelemetryBridgeSourceGate | null;
  /** Effective plugin view (sanitized). */
  effective: {
    available: boolean;
    invalid: boolean;
    entries: TelemetryBridgeEffectiveEntry[];
  } | null;
  /** Desired activation state from revision store. */
  desired: TelemetryBridgeDesiredState | null;
  /** Duplicates detected. */
  duplicates: { inSource: boolean; inEffective: boolean };
  /** Override status. */
  override: TelemetryBridgeOverride;
  /** Registration state. */
  registration: TelemetryBridgeRegistrationState;
  /** Bridge runtime state. */
  runtime: TelemetryBridgeRuntimeState;
  /** Compatibility. */
  compatibility: TelemetryBridgeCompatibility;
  /** Local package availability. */
  localPackageAvailable: TelemetryBridgeLocalPackage;
  /** Endpoint source. */
  endpointSource: TelemetryBridgeEndpointSource;
  /** Effective bridge endpoint URL (undefined when unavailable). */
  endpoint?: string;
  /** Whether an explicit override is in effect. */
  overrideActive: boolean;
  /** Whether the override (if present) is invalid. */
  overrideInvalid: boolean;
  /** Bridge schema version reported; undefined when no response. */
  schemaVersion?: number;
  /** Bridge package version (advisory). */
  bridgePackageVersion?: string;
  /** Per-store capability availability (v3 only). */
  capabilities?: TelemetryBridgeCapabilities;
  /** Verification epoch. */
  verificationEpoch: number;
  /** Lifecycle generation. */
  generation: number;
  /** Whether the OMO runtime backend is ready. */
  omoReady: boolean;
  /** Whether the bridge backend is connected/ready. */
  backendConnected: boolean;
  /** Explicit lifecycle status (normalized, not one boolean). */
  lifecycleStatus: TelemetryBridgeLifecycleStatus;
  /** Lifecycle mode. */
  mode: TelemetryBridgeOpenCodeMode;
  /** Ownership. */
  ownership: TelemetryBridgeOwnership;
  /** Whether the control plane can restart the bridge. */
  restartControllable: boolean;
  /** Restart kind in progress, if any. */
  restartKind?: "ordinary" | "telemetry-activation" | "awaiting-owner";
  /** Whether a restart is required to apply the committed config. */
  restartRequired: boolean;
  /** Last error (redacted, no raw secrets). */
  error?: string;
  /** Action eligibility. */
  actions: TelemetryBridgeActionEligibility;
  /** Last updated timestamp (ms epoch). */
  updatedAt: number;
}

/**
 * Summarized bridge status for SSE events. Carries only summarized
 * lifecycle/registration/runtime/generation/epoch/capability availability.
 * NEVER carries source path/hash/diff/fingerprint/endpoint/override details.
 */
export interface TelemetryBridgeStatusSummary {
  runtime: TelemetryBridgeRuntimeState;
  registration: TelemetryBridgeRegistrationState;
  compatibility: TelemetryBridgeCompatibility;
  lifecycleStatus: TelemetryBridgeLifecycleStatus;
  generation: number;
  verificationEpoch: number;
  omoReady: boolean;
  backendConnected: boolean;
  overrideActive: boolean;
  overrideInvalid: boolean;
  restartRequired: boolean;
  capabilities?: TelemetryBridgeCapabilities;
  schemaVersion?: number;
  bridgePackageVersion?: string;
  endpointSource: TelemetryBridgeEndpointSource;
  localPackageAvailable: TelemetryBridgeLocalPackage;
  updatedAt: number;
}

export interface AgentRow {
  name: string;
  kind: "builtin" | "custom" | "native" | "unknown";
  enabled: boolean;
  desiredModel?: string;
  effectiveModel?: string;
  effectiveVariant?: string;
  liveModel?: string;
  liveVariant?: string;
  liveMode?: string;
  sessionCount: number;
  provenanceSummary?: string;
  modelSourceStage?: string;
  drift: {
    desiredVsEffective: boolean;
    effectiveVsLive: boolean;
  };
}

export interface OverviewDto {
  controlPlane: { name: string; version: string };
  opencode: {
    healthy: boolean;
    version?: string;
    baseUrl: string;
    error?: string;
    directory?: string;
    configDir?: string;
  };
  connection: RuntimeConnection;
  omo: {
    packageHint?: string;
    preset?: string;
    userConfigPath?: string | null;
    projectConfigPath?: string | null;
    agentCount: number;
    customAgentCount: number;
    presetCount: number;
    warnings: EffectiveConfig["warnings"];
  };
  providers: {
    connected: string[];
    connectedCount: number;
    totalKnown: number;
  };
  sessions: {
    total: number;
    roots: number;
    children: number;
  };
  mcp: Record<string, { status: string }>;
  permissions: LivePermission[];
  fetchedAt: string;
}

export interface AgentsDto {
  rows: AgentRow[];
  desired: DesiredOmoConfig;
  effective: EffectiveConfig;
  liveAgents: LiveAgent[];
}

export interface SessionsDto {
  roots: LiveSession[];
  flat: LiveSession[];
  total: number;
  connection?: RuntimeConnection;
  fetchedAt?: string;
}

export interface ProvidersDto {
  providers: LiveProvider[];
  connected: string[];
  fetchedAt: string;
  connection?: RuntimeConnection;
}

// ── Model inventory & probing (Slice 15) ─────────────────────────

export type ModelProbeState =
  | "never"
  | "running"
  | "healthy"
  | "unauthorized"
  | "model-not-found"
  | "rate-limited"
  | "timeout"
  | "provider-disconnected"
  | "opencode-disconnected"
  | "malformed"
  | "error";

export type ModelProbeTerminalState = Exclude<
  ModelProbeState,
  "never" | "running"
>;

export type ModelProbeFreshness = "fresh" | "stale" | "never";

export interface ModelProbeSummary {
  state: ModelProbeState;
  freshness: ModelProbeFreshness;
  /** ISO timestamps */
  lastStartedAt?: string;
  lastCompletedAt?: string;
  latencyMs?: number;
  statusCode?: number;
  errorCode?: string;
  errorMessage?: string;
  responseModel?: string;
}

export interface ModelAvailabilityCapabilities {
  state: "known" | "partial" | "unknown";
  tools?: boolean;
  vision?: boolean;
  reasoning?: boolean;
  structuredOutput?: boolean;
  toolIds?: string[];
  source: "opencode:/config/providers" | "opencode:/provider" | "none";
}

export interface ModelUsageReference {
  kind: "agent-primary" | "agent-fallback" | "council-member" | "acp-wrapper";
  ownerId: string;
  label: string;
  active: boolean;
  fallback: boolean;
}

export interface ModelAvailability {
  providerId: string;
  modelId: string;
  configured: boolean;
  provider: { known: boolean; connected: boolean };
  advertised: boolean;
  probe: ModelProbeSummary;
  capabilities: ModelAvailabilityCapabilities;
  /** ISO timestamp */
  lastUpdatedAt: string;
  usage: ModelUsageReference[];
  limit?: { context?: number; output?: number };
  status?: string;
}

export interface ModelProbeRun {
  id: string;
  providerId: string;
  modelId: string;
  /** ISO timestamps */
  startedAt: string;
  completedAt?: string;
  state: Exclude<ModelProbeState, "never">;
  latencyMs?: number;
  statusCode?: number;
  errorCode?: string;
  errorMessage?: string;
  responseModel?: string;
  opencodeVersion?: string;
  advertisedAtProbe: boolean;
  providerConnectedAtProbe: boolean;
}

export interface ProviderDiagnostics {
  providerId: string;
  name?: string;
  known: boolean;
  connected: boolean;
  advertisedCount: number;
  referencedCount: number;
  authMethods: Array<{ type: string; label: string }>;
  /** ISO timestamp */
  lastSuccessfulProbeAt?: string;
  recentFailureCounts: Partial<Record<ModelProbeState, number>>;
  recentRateLimitCount: number;
}

export interface ModelProbeQueueItem {
  id: string;
  providerId: string;
  modelId: string;
  state: "pending" | "running";
  /** ISO timestamps */
  enqueuedAt: string;
  startedAt?: string;
}

export interface ModelProbeQueueSnapshot {
  concurrency: number;
  pending: ModelProbeQueueItem[];
  running: ModelProbeQueueItem[];
}

export interface ModelInventoryDto {
  /** ISO timestamp */
  generatedAt: string;
  models: ModelAvailability[];
  providers: ProviderDiagnostics[];
  queue: ModelProbeQueueSnapshot;
}

export interface ModelAvailabilityDetail {
  availability: ModelAvailability;
  history: ModelProbeRun[];
}

/** Normalized message part kinds for UI rendering */
export type MessagePartKind =
  | "text"
  | "reasoning"
  | "tool"
  | "file"
  | "subtask"
  | "step-start"
  | "step-finish"
  | "snapshot"
  | "patch"
  | "agent"
  | "retry"
  | "compaction"
  | "unknown";

export interface NormalizedMessagePart {
  id: string;
  kind: MessagePartKind;
  /** Original OpenCode part.type */
  rawType: string;
  text?: string;
  synthetic?: boolean;
  tool?: {
    name: string;
    callID?: string;
    status: string;
    title?: string;
    /** Short one-line summary of input */
    inputSummary?: string;
    input?: unknown;
    output?: string;
    error?: string;
    time?: { start?: number; end?: number };
  };
  file?: {
    filename?: string;
    mime?: string;
    url?: string;
  };
  subtask?: {
    agent?: string;
    description?: string;
    prompt?: string;
  };
  /** Truncated for UI; full available via expand / raw */
  truncated?: boolean;
  meta?: Record<string, unknown>;
}

export interface SessionMessageSummary {
  id: string;
  role: "user" | "assistant" | "unknown";
  agent?: string;
  model?: { providerID?: string; modelID?: string; variant?: string };
  createdAt?: number;
  completedAt?: number;
  cost?: number;
  error?: unknown;
  /** Plain-text preview (first user/assistant text) */
  preview?: string;
  parts: NormalizedMessagePart[];
}

export interface SessionActivityItem {
  id: string;
  at?: number;
  kind: "tool" | "text" | "reasoning" | "step" | "error" | "other";
  label: string;
  detail?: string;
  status?: string;
  messageID?: string;
}

export interface SessionFileDiff {
  file?: string;
  patch?: string;
  additions: number;
  deletions: number;
  status?: "added" | "deleted" | "modified" | string;
}

export interface SessionDiffSummary {
  files: SessionFileDiff[];
  totalAdditions: number;
  totalDeletions: number;
  empty: boolean;
  error?: string;
  /** From session.summary when diff endpoint empty */
  fromSummary?: boolean;
}

export interface SessionAgentModelCompare {
  agent?: string;
  desiredModel?: string;
  effectiveModel?: string;
  effectiveVariant?: string;
  sessionModel?: string;
  sessionVariant?: string;
  differsFromEffective: boolean;
  note?: string;
}

export interface SessionDetail {
  id: string;
  parentID?: string;
  title?: string;
  agent?: string;
  model?: { providerID: string; modelID: string; variant?: string };
  status?: string;
  statusDetail?: unknown;
  createdAt?: number;
  updatedAt?: number;
  directory?: string;
  /** Metadata only — may be outside authorized FS roots */
  directoryNote?: string;
  version?: string;
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  summary?: {
    additions?: number;
    deletions?: number;
    files?: number;
  };
  /** Best-effort initial instruction (first non-synthetic user text) */
  initialInstruction?: string;
  initialInstructionLabel: string;
  messages: SessionMessageSummary[];
  activity: SessionActivityItem[];
  diff: SessionDiffSummary;
  permissions: LivePermission[];
  children: LiveSession[];
  parent?: LiveSession;
  siblings: LiveSession[];
  agentCompare?: SessionAgentModelCompare;
  exists: boolean;
  stale?: boolean;
  errors: string[];
  fetchedAt: string;
}

// ── Config mutation (Slice 5) ──────────────────────────────────────

export type ConfigWriteScope = "user" | "project";

export type ConfigDestination =
  | { kind: "preset"; preset: string }
  | { kind: "root-agent" };

export type ModelChainEntry =
  | string
  | { id: string; variant?: string };

export type MutationFieldOp<T> =
  | { op: "set"; value: T }
  | { op: "remove" };

export type PermissionDecision = "allow" | "ask" | "deny";

/** OMO PermissionRule: decision or pattern→decision map */
export type PermissionRule =
  | PermissionDecision
  | Record<string, PermissionDecision>;

/** OMO agent permission object (plus catchall tools) */
export type AgentPermissionConfig =
  | PermissionDecision
  | {
      read?: PermissionRule;
      edit?: PermissionRule;
      glob?: PermissionRule;
      grep?: PermissionRule;
      list?: PermissionRule;
      bash?: PermissionRule;
      task?: PermissionRule;
      external_directory?: PermissionRule;
      lsp?: PermissionRule;
      skill?: PermissionRule;
      todowrite?: PermissionDecision;
      question?: PermissionDecision;
      webfetch?: PermissionDecision;
      websearch?: PermissionDecision;
      codesearch?: PermissionDecision;
      doom_loop?: PermissionDecision;
      [tool: string]: PermissionRule | PermissionDecision | undefined;
    };

export type ConfigMutation =
  | {
      kind: "agent-model";
      scope: ConfigWriteScope;
      destination: ConfigDestination;
      agent: string;
      /**
       * Ordered model fallback chain — ALWAYS an array (even for one entry).
       * The server tolerantly normalizes a legacy non-array payload (string or
       * standalone {id, variant} object) into a one-element chain at the
       * boundary, but never emits a standalone object form, which the
       * installed oh-my-opencode-slim schema rejects.
       */
      model: ModelChainEntry[];
      expectedSourceHash?: string;
    }
  | {
      kind: "agent-variant";
      scope: ConfigWriteScope;
      destination: ConfigDestination;
      agent: string;
      variant: string | null;
      expectedSourceHash?: string;
    }
  | {
      kind: "agent-temperature";
      scope: ConfigWriteScope;
      destination: ConfigDestination;
      agent: string;
      /** null = remove property */
      temperature: number | null;
      expectedSourceHash?: string;
    }
  | {
      kind: "agent-skills";
      scope: ConfigWriteScope;
      destination: ConfigDestination;
      agent: string;
      /** null = remove property */
      skills: string[] | null;
      expectedSourceHash?: string;
    }
  | {
      kind: "agent-mcps";
      scope: ConfigWriteScope;
      destination: ConfigDestination;
      agent: string;
      mcps: string[] | null;
      expectedSourceHash?: string;
    }
  | {
      kind: "agent-permission";
      scope: ConfigWriteScope;
      destination: ConfigDestination;
      agent: string;
      permission: AgentPermissionConfig | null;
      expectedSourceHash?: string;
    }
  | {
      kind: "agent-capabilities";
      scope: ConfigWriteScope;
      destination: ConfigDestination;
      agent: string;
      temperature?: MutationFieldOp<number>;
      skills?: MutationFieldOp<string[]>;
      mcps?: MutationFieldOp<string[]>;
      permission?: MutationFieldOp<AgentPermissionConfig>;
      expectedSourceHash?: string;
    }
  | {
      kind: "agent-inline-prompt";
      scope: ConfigWriteScope;
      destination: ConfigDestination;
      agent: string;
      /** null = remove property */
      prompt: string | null;
      expectedSourceHash?: string;
    }
  | {
      kind: "agent-orchestrator-prompt";
      scope: ConfigWriteScope;
      destination: ConfigDestination;
      agent: string;
      prompt: string | null;
      expectedSourceHash?: string;
    }
  | {
      kind: "prompt-file";
      scope: ConfigWriteScope;
      /** Preset subdir; undefined = generic */
      preset?: string;
      agent: string;
      fileType: "replacement" | "append";
      operation: "set" | "delete";
      /** set only */
      content?: string;
      expectedSourceHash?: string;
    };

export interface PromptSourceState {
  id: string;
  kind: "builtin" | "inline" | "replacement" | "append";
  scope?: "user" | "project";
  preset?: string;
  agent: string;
  path?: string;
  exists: boolean;
  active: boolean;
  selectedAsBase?: boolean;
  selectedAsAppend?: boolean;
  shadowedBy?: string;
  reason?: string;
  hash?: string;
  mtimeMs?: number;
  chars?: number;
  lines?: number;
  preview?: string;
}

export interface AgentPromptDetail {
  agent: string;
  base?: PromptSourceState;
  append?: PromptSourceState;
  sources: PromptSourceState[];
  effectiveText?: string;
  effectiveChars?: number;
  effectiveLines?: number;
  compositionRule: string;
  orphanFiles: Array<{ path: string; agent: string }>;
  warnings: string[];
}

export interface PromptFileSimulation {
  ok: boolean;
  operation: "set" | "delete";
  targetPath: string;
  createsFile: boolean;
  createsDir: boolean;
  currentHash?: string;
  textDiff?: string;
  beforeComposition: {
    base?: string;
    append?: string;
  };
  afterComposition: {
    base?: string;
    append?: string;
  };
  shadowedAfter: string[];
  activatedAfter: string[];
  warnings: string[];
  errors: string[];
  contentPreview?: string;
}

export interface ListExpressionSemantic {
  mode: "all" | "none" | "selective" | "unset";
  /** Raw configured expression */
  configured?: string[];
  allowed: string[];
  denied: string[];
  /** Configured names not in inventory */
  configuredUnknown: string[];
  globallyDisabled: string[];
}

export interface AgentCapabilitySummary {
  agent: string;
  temperature?: number;
  skills: ListExpressionSemantic;
  mcps: ListExpressionSemantic;
  permission?: AgentPermissionConfig;
  permissionSummary: string;
  tools: Record<string, PermissionDecision | "patterned" | "unset">;
}

export interface CapabilityInventory {
  skills: Array<{
    name: string;
    installed: boolean;
    globallyDisabled: boolean;
  }>;
  mcps: Array<{
    name: string;
    runtimeStatus?: string;
    globallyDisabled: boolean;
  }>;
  tools: string[];
  agents: AgentCapabilitySummary[];
  globals: {
    disabled_skills: string[];
    disabled_mcps: string[];
    disabled_tools: string[];
    disabled_agents: string[];
  };
}

export interface ConfigValidationIssue {
  level: "error" | "warning" | "info";
  code: string;
  message: string;
  path?: string;
}

export interface ConfigValidationResult {
  ok: boolean;
  issues: ConfigValidationIssue[];
}

export interface ConfigConflict {
  path: string;
  expectedHash?: string;
  actualHash: string;
  message: string;
}

// ── Installed OMO-Slim schema validation (fail-closed write gate) ─────

export interface SchemaValidationIssue {
  /** dot path, e.g. "agents.critic.model"; "" for root/syntax issues */
  path: string;
  /** JSON Schema keyword, or "parity" | "unavailable" | "syntax" | "truncation" */
  keyword?: string;
  message: string;
  expected?: string;
  received?: unknown;
}

export interface SchemaValidationSummary {
  ok: boolean;
  /** true when the installed schema could not be loaded (fail-closed) */
  unavailable?: boolean;
  /** installed oh-my-opencode-slim package version, e.g. "2.2.10" */
  packageVersion?: string;
  /** sha256 of the schema file content */
  schemaHash?: string;
  issues: SchemaValidationIssue[];
}

export interface OmoSchemaStatus {
  available: boolean;
  packageVersion?: string;
  schemaPath?: string;
  schemaHash?: string;
  /** Public cache key `oh-my-opencode-slim@<version>-<hash>` for Monaco/preview invalidation. */
  cacheKey?: string;
  /** Monotonic schema identity generation; changes when version/hash/cache key change. */
  schemaGeneration?: number;
  /** Monotonic authorized source-watcher generation (0 until D3 watcher wiring). */
  sourceGeneration?: number;
  /** True when this payload is the current installed snapshot (never a cached Preview). */
  current?: boolean;
  /**
   * Schema-gated OMO JSON write capability. Closed when the installed schema
   * is unavailable; reads/status remain available. Distinct from Interview
   * typed-write capability.
   */
  writeCapability?: "open" | "closed";
  userConfig: {
    present: boolean;
    valid: boolean | null;
    issues: SchemaValidationIssue[];
  };
  projectConfig: {
    present: boolean;
    valid: boolean | null;
    issues: SchemaValidationIssue[];
  };
  error?: string;
}

export interface OmoSchemaDocument {
  available: true;
  packageVersion?: string;
  schemaHash: string;
  cacheKey: string;
  schema: Record<string, unknown>;
}

export interface OmoSchemaDocumentUnavailable {
  available: false;
  error: string;
  packageVersion?: string;
  schemaHash?: string;
  cacheKey?: string;
}

export type OmoSchemaDocumentDto = OmoSchemaDocument | OmoSchemaDocumentUnavailable;

// ── Slice 18 D0: shared source / Interview / transaction DTO groundwork ──

export type OmoScope = ConfigWriteScope;
export type OmoFormat = "json" | "jsonc";

export interface SourceFingerprint {
  exists: boolean;
  sha256: string | null;
  format: OmoFormat;
  mtimeMs: number | null;
  generation: number;
}

export interface OmoTargetDescriptor {
  scope: OmoScope;
  path: string;
  format: OmoFormat;
  exists: boolean;
  createOnApplyOnly: boolean;
}

export interface JsonChange {
  path: string;
  op: "add" | "remove" | "replace";
  before?: unknown;
  after?: unknown;
}

export interface ProvenanceChange {
  path: string;
  before?: { sourceId?: string; stage?: string; value?: unknown };
  after?: { sourceId?: string; stage?: string; value?: unknown };
}

export interface BoundedTextDiff {
  text: string;
  truncated: boolean;
  omittedBytes?: number;
}

export interface DiffTruncation {
  truncated: boolean;
  omittedChangeEntries?: number;
  omittedBytes?: number;
  fullSourceAvailableInEditor?: true;
}

export const MAX_OMO_CANDIDATE_BYTES = 2_097_152;
export const MAX_OMO_REQUEST_BYTES = 2_162_688;
export const MAX_DIFF_CHANGE_ENTRIES = 500;
export const MAX_DIFF_VALUE_PREVIEW_BYTES = 8_192;
export const MAX_TEXT_DIFF_BYTES = 262_144;

export type OmoTransactionErrorCode =
  | "syntax-invalid"
  | "root-not-object"
  | "companion-read-only"
  | "stale-source"
  | "schema-unavailable"
  | "schema-invalid"
  | "oversize"
  | "malformed"
  | "policy"
  | "no-op"
  | "recovery-pending"
  | "revision-domain-mismatch";

export interface OmoTransactionIntent {
  kind: string;
  summary: string;
  propertyPaths: string[];
  mutationJson: string;
  agent?: string;
  property?: string;
}

export type InterviewField =
  | "maxQuestions"
  | "outputFolder"
  | "autoOpenBrowser"
  | "port"
  | "dashboard";

export interface InterviewFieldMetadata {
  name: InterviewField;
  schemaType: "integer" | "string" | "boolean";
  defaultValue: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  description?: string;
}

export interface InterviewTypedCapability {
  available: boolean;
  reason?: string;
  packageVersion?: string;
  schemaHash?: string;
  cacheKey?: string;
  installedFields: string[];
  auditedFields: InterviewField[];
}

export type InterviewRuntimeAction = "none";

export interface InterviewMutationOperation {
  field: InterviewField;
  op: "set" | "remove";
  value?: number | string | boolean;
}

export interface InterviewMutationRequest {
  scope: OmoScope;
  expectedSource: SourceFingerprint;
  operations: InterviewMutationOperation[];
  expectedCandidateSha256?: string;
}

export interface SimulationResult {
  ok: boolean;
  mutation: ConfigMutation;
  targetPath: string;
  jsonPath: string[];
  scope: ConfigWriteScope;
  createsFile: boolean;
  currentHash?: string;
  currentValue?: unknown;
  proposedValue?: unknown;
  /** Unified diff of file text */
  textDiff?: string;
  effectiveBefore?: unknown;
  effectiveAfter?: unknown;
  effectiveChanged: Array<{ path: string; before: unknown; after: unknown }>;
  masked: boolean;
  validation: ConfigValidationResult;
  /**
   * Full-document validation of the candidate against the installed
   * oh-my-opencode-slim schema. Present whenever the schema gate ran.
   * `!ok` → the candidate would be rejected by OMO-Slim; writers do not write.
   */
  schemaValidation?: SchemaValidationSummary;
  warnings: string[];
  errors: string[];
  liveNote: string;
}

export interface ApplyResult {
  ok: boolean;
  revisionId?: string;
  targetPath?: string;
  oldHash?: string;
  newHash?: string;
  simulation?: SimulationResult;
  conflict?: ConfigConflict;
  /** Present when the installed-schema gate blocked the write. */
  schemaValidation?: SchemaValidationSummary;
  errors: string[];
  effectiveChanged?: SimulationResult["effectiveChanged"];
}

export type OmoRevisionState = "pending" | "committed" | "abandoned" | "conflict";

export interface ConfigRevision {
  id: string;
  timestamp: string;
  targetPath: string;
  scope: ConfigWriteScope;
  oldHash: string;
  newHash: string;
  mutationKind: string;
  agent?: string;
  property?: string;
  oldValue?: string;
  newValue?: string;
  mutationJson: string;
  /** Full file content before */
  beforeContent: string;
  /** Full file content after */
  afterContent: string;
  note?: string;
  state?: OmoRevisionState;
  preparedAt?: string;
  committedAt?: string;
  recoveryNote?: string;
  beforeExists?: boolean;
  afterExists?: boolean;
  targetFormat?: OmoFormat;
  schemaPackageVersion?: string;
  schemaHash?: string;
}

export interface OmoProducerInput<T> {
  scope: OmoScope;
  beforeText: string;
  beforeDocument: Record<string, unknown>;
  format: OmoFormat;
  source: SourceFingerprint;
  input: T;
}

export interface OmoProducerResult {
  candidateText: string;
  featureErrors: string[];
  featureWarnings: string[];
  intent: OmoTransactionIntent;
}

export type OmoCandidateProducer<T> = (
  input: OmoProducerInput<T>,
) => OmoProducerResult;

export type OmoCandidateParseMode =
  | "source-compatible"
  | "target-extension";

export interface OmoCandidateRequest<T> {
  scope: OmoScope;
  expectedSource: SourceFingerprint;
  input: T;
  expectedCandidateSha256?: string;
  /**
   * How to parse the produced candidate.
   * - `source-compatible` (structured producers): if the current `.json`
   *   source is a legacy commented file, the candidate may also be parsed
   *   as JSONC so comments/extension survive repair. Disk extension is unchanged.
   * - `target-extension` (raw editor / D3): always parse the candidate
   *   by the authorized target extension — `.json` is strict JSON even when
   *   the current source was read leniently.
   */
  candidateParse?: OmoCandidateParseMode;
  /**
   * Raw repair only: continue Preview/Apply when the current source is
   * unparseable. Candidate validity still governs Apply. Companion remains
   * fail-closed unless unchanged Companion can be proven.
   */
  allowInvalidCurrent?: boolean;
  /** Installed schema cache key observed at load/Preview; mismatch invalidates. */
  expectedSchemaCacheKey?: string;
}

export interface OmoRevisionRestoreRequest {
  scope: OmoScope;
  revisionId: string;
  expectedSource: SourceFingerprint;
  expectedCandidateSha256?: string;
}

export interface OmoTransactionPreview {
  ok: boolean;
  canApply: boolean;
  code?: OmoTransactionErrorCode;
  source: SourceFingerprint;
  candidateSha256?: string;
  target: OmoTargetDescriptor;
  schemaValidation?: SchemaValidationSummary;
  semanticValidation: ConfigValidationResult;
  textDiff?: BoundedTextDiff;
  sourceChanges: JsonChange[];
  desiredChanges: JsonChange[];
  effectiveChanges: JsonChange[];
  provenanceChanges: ProvenanceChange[];
  truncation?: DiffTruncation;
  warnings: string[];
  errors: string[];
}

export interface OmoTransactionCommit {
  ok: boolean;
  code?: OmoTransactionErrorCode;
  status: 200 | 400 | 409 | 413 | 422 | 503;
  preview: OmoTransactionPreview;
  revisionId?: string;
  source?: SourceFingerprint;
  errors: string[];
}

export interface InterviewEffectiveDto {
  maxQuestions: number;
  outputFolder: string;
  autoOpenBrowser: boolean;
  port: number;
  dashboard: boolean;
}

export interface InterviewServerSemantics {
  mode: "per-session" | "dashboard";
  bindHost: "127.0.0.1" | string;
  configuredPort: number;
  portMeaning: string;
  defaultDashboardPort: number;
  dashboardDerived: { enabled: boolean; via: "explicit" | "port" | "no" };
  browser: { autoOpen: boolean; autoDisabledInAutomated?: boolean };
  notes: string[];
}

export interface InterviewOutputSemantics {
  configuredFolder: string;
  normalizedFolder: string;
  resolvedPath: string;
  withinAuthorizedScope: boolean;
  inspected: false;
  exists: null;
}

export interface InterviewSemantics {
  effective: InterviewEffectiveDto;
  server: InterviewServerSemantics;
  output: InterviewOutputSemantics;
}

export interface InterviewRawRepair {
  needed: true;
  reason: string;
}

/**
 * Interview simulate response: D1 Preview plus additive Interview metadata.
 * The web parser may treat this as `OmoTransactionPreview` because every
 * Preview field is present at the top level (`canApply`, `target`,
 * `semanticValidation`, `textDiff: BoundedTextDiff`, change arrays).
 */
export interface InterviewPreviewResponse extends OmoTransactionPreview {
  typedCapability: InterviewTypedCapability;
  restartRequired: true;
  runtimeAction: InterviewRuntimeAction;
  interview?: { before?: InterviewSemantics; after?: InterviewSemantics };
  rawRepair?: InterviewRawRepair;
}

/**
 * Interview apply response: D1 Commit plus the same additive metadata.
 * The web parser detects Apply by the nested `preview` object.
 */
export interface InterviewCommitResponse extends OmoTransactionCommit {
  preview: InterviewPreviewResponse;
  typedCapability: InterviewTypedCapability;
  restartRequired: true;
  runtimeAction: InterviewRuntimeAction;
  interview?: { before?: InterviewSemantics; after?: InterviewSemantics };
  rawRepair?: InterviewRawRepair;
}

export type InterviewMutationResponse =
  | InterviewPreviewResponse
  | InterviewCommitResponse;

const INTERVIEW_PREVIEW_KEYS = [
  "ok",
  "canApply",
  "source",
  "target",
  "semanticValidation",
  "sourceChanges",
  "desiredChanges",
  "effectiveChanges",
  "provenanceChanges",
  "warnings",
  "errors",
  "typedCapability",
  "restartRequired",
  "runtimeAction",
] as const;

/**
 * Pure structural guard for the Interview Preview envelope. Safe for web
 * tests and the designer lane; does not import server runtime.
 */
export function isInterviewPreviewResponse(
  value: unknown,
): value is InterviewPreviewResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if ("preview" in v) return false;
  for (const key of INTERVIEW_PREVIEW_KEYS) {
    if (!(key in v)) return false;
  }
  if (v.restartRequired !== true || v.runtimeAction !== "none") return false;
  if (!v.target || typeof v.target !== "object") return false;
  if (!v.semanticValidation || typeof v.semanticValidation !== "object") {
    return false;
  }
  if (v.textDiff !== undefined) {
    const diff = v.textDiff as { text?: unknown; truncated?: unknown };
    if (typeof diff?.text !== "string" || typeof diff?.truncated !== "boolean") {
      return false;
    }
  }
  return true;
}

export {
  INTERVIEW_COMMIT_CONTRACT_FIXTURE,
  INTERVIEW_CONTRACT_USAGE,
  INTERVIEW_PREVIEW_CONTRACT_FIXTURE,
} from "./interview-contract-fixture";

export function isInterviewCommitResponse(
  value: unknown,
): value is InterviewCommitResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (!("preview" in v) || !isInterviewPreviewResponse(v.preview)) return false;
  return (
    typeof v.ok === "boolean" &&
    typeof v.status === "number" &&
    Array.isArray(v.errors) &&
    v.restartRequired === true &&
    v.runtimeAction === "none"
  );
}

// ── Slice 18 D3: raw OMO source / revision / watcher contracts ─────────

/** Client-facing logical source. Never a filesystem path. */
export type RawOmoSourceId = "user-omo" | "project-omo";

export const RAW_OMO_SOURCE_IDS = ["user-omo", "project-omo"] as const;

export const RAW_OMO_MUTATION_KIND = "Raw OMO configuration edit";

export const MISSING_PROJECT_EDITOR_TEXT = "{}\n";

export function isRawOmoSourceId(value: unknown): value is RawOmoSourceId {
  return value === "user-omo" || value === "project-omo";
}

export function sourceIdToScope(sourceId: RawOmoSourceId): OmoScope {
  return sourceId === "user-omo" ? "user" : "project";
}

export function scopeToSourceId(scope: OmoScope): RawOmoSourceId {
  return scope === "user" ? "user-omo" : "project-omo";
}

export interface RawSourceDiagnostic {
  path: string;
  keyword?: string;
  message: string;
  offset?: number;
  length?: number;
}

export interface RawSchemaIdentity {
  available: boolean;
  packageVersion?: string;
  schemaHash?: string;
  cacheKey?: string;
  schemaGeneration?: number;
  error?: string;
}

export interface RawSourceLoadResponse {
  ok: boolean;
  sourceId: RawOmoSourceId;
  scope: OmoScope;
  exists: boolean;
  format: OmoFormat;
  createOnApplyOnly: boolean;
  /** Authorized logical path metadata. Never accepted as a client input. */
  path: string;
  fingerprint: SourceFingerprint;
  text: string;
  byteLength: number;
  syntax: { ok: boolean; issues: RawSourceDiagnostic[] };
  schemaValidation?: SchemaValidationSummary;
  schema: RawSchemaIdentity;
  effectiveResolutionAvailable: boolean;
  writeCapability: "open" | "closed";
  code?: OmoTransactionErrorCode;
  errors: string[];
}

export interface RawCompareRequest {
  sourceId: RawOmoSourceId;
  draftText: string;
}

export interface RawCompareResponse {
  ok: boolean;
  sourceId: RawOmoSourceId;
  fingerprint: SourceFingerprint;
  currentText: string;
  textDiff?: BoundedTextDiff;
  truncation?: DiffTruncation;
  errors: string[];
  code?: OmoTransactionErrorCode;
}

export interface RawMutationRequest {
  sourceId: RawOmoSourceId;
  expectedSource: SourceFingerprint;
  candidateText: string;
  expectedSchemaCacheKey?: string;
  expectedCandidateSha256?: string;
}

export interface RawSemanticSummary {
  changed: boolean;
  notes: string[];
}

export interface RawSemanticSummaries {
  capabilities: RawSemanticSummary;
  prompts: RawSemanticSummary;
  presets: RawSemanticSummary;
  council: RawSemanticSummary;
  acp: RawSemanticSummary;
  interview: RawSemanticSummary;
  customAgents: RawSemanticSummary;
}

export interface RawCrossLink {
  kind: string;
  href: string;
  label: string;
  path?: string;
}

export interface RawPreviewResponse extends OmoTransactionPreview {
  sourceId: RawOmoSourceId;
  schemaCacheKey?: string;
  schemaGeneration?: number;
  liveUnchangedNote: string;
  semanticSummaries: RawSemanticSummaries;
  crossLinks?: RawCrossLink[];
}

export interface RawCommitResponse extends OmoTransactionCommit {
  sourceId: RawOmoSourceId;
  preview: RawPreviewResponse;
}

export interface OmoRevisionListItem {
  id: string;
  timestamp: string;
  sourceId: RawOmoSourceId;
  scope: OmoScope;
  state: OmoRevisionState;
  mutationKind: string;
  kindLabel: string;
  summary?: string;
  oldHash: string;
  newHash: string;
  schemaPackageVersion?: string;
  schemaHash?: string;
  restoreEligible: boolean;
}

export interface OmoRevisionDetail extends OmoRevisionListItem {
  path: string;
  format?: OmoFormat;
  beforeContent: string;
  afterContent: string;
  textDiff?: BoundedTextDiff;
  semanticChangedPaths: string[];
  currentSchemaCompatible: boolean;
  restoreBlockedReason?: string;
}

export interface ConfigSourcesChangedEvent {
  type: "config.sources.changed";
  at: string;
  generation: number;
  sources: Record<RawOmoSourceId, SourceFingerprint>;
  schema: RawSchemaIdentity & { changed: boolean };
  /**
   * Compatibility flag: true only when at least one source matched a
   * Control Plane apply and no other logical source changed externally
   * in the same coalesced event. Clients must prefer `ownApplyBySource`.
   */
  ownApply?: boolean;
  /** Per-source own-apply match. An unmatched sibling remains false. */
  ownApplyBySource?: Record<RawOmoSourceId, boolean>;
}

export const RAW_LIVE_UNCHANGED_NOTE =
  "Live runtime is unchanged until OpenCode reloads this configuration.";

export {
  RAW_COMMIT_CONTRACT_FIXTURE,
  RAW_CONTRACT_USAGE,
  RAW_PREVIEW_CONTRACT_FIXTURE,
} from "./raw-contract-fixture";

export function isRawPreviewResponse(
  value: unknown,
): value is RawPreviewResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if ("preview" in v) return false;
  if (!isRawOmoSourceId(v.sourceId)) return false;
  if (typeof v.ok !== "boolean" || typeof v.canApply !== "boolean") return false;
  if (!v.target || typeof v.target !== "object") return false;
  if (!v.semanticValidation || typeof v.semanticValidation !== "object") {
    return false;
  }
  if (typeof v.liveUnchangedNote !== "string") return false;
  if (!v.semanticSummaries || typeof v.semanticSummaries !== "object") {
    return false;
  }
  return (
    Array.isArray(v.sourceChanges) &&
    Array.isArray(v.desiredChanges) &&
    Array.isArray(v.effectiveChanges) &&
    Array.isArray(v.provenanceChanges)
  );
}

export function isRawCommitResponse(
  value: unknown,
): value is RawCommitResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    isRawOmoSourceId(v.sourceId) &&
    typeof v.ok === "boolean" &&
    typeof v.status === "number" &&
    Array.isArray(v.errors) &&
    isRawPreviewResponse(v.preview)
  );
}

export const BUILTIN_OMO_AGENTS = [
  "orchestrator",
  "explorer",
  "librarian",
  "oracle",
  "designer",
  "fixer",
  "observer",
  "council",
  "councillor",
] as const;

export const PROTECTED_AGENTS = new Set(["orchestrator", "councillor"]);

// ── Multiplexer (Slice 16) ──────────────────────────────────────────────
//
// Source authority: installed oh-my-opencode-slim@2.2.10
//   schema  oh-my-opencode-slim.schema.json:941-982
//   zod     dist/index.js:18753-18775 (MultiplexerConfigSchema, Zod strip)
//   loader  dist/index.js:18881-18944 (safeParse; legacy tmux warning 18901-18911)
//   factory dist/index.js:35525-35586 (getMultiplexer; auto order)
//   init    dist/index.js:40831-40846 (defaults + startAvailabilityCheck)
//   stores  dist/index.js:35667-35672 (cmux), 36299-36315 (session-manager)
//
// Distinct stages kept deliberately separate so the UI can render
// Desired → Effective → Live without conflating them:
//   configured  : raw merged config leaf values (post deep-merge, pre-defaults)
//   effective  : OMO-resolved value after builtin defaults are applied
//   provenance : per-leaf source tracing (reuses ProvenanceBundle)
//   availability : static `command -v` probe of backend binaries (control-plane only)
//   detection  : environment-signal auto resolution (factory order)
//   runtime    : cached bridge store snapshots + OpenCode session/job mapping

export type MultiplexerType =
  | "auto"
  | "tmux"
  | "zellij"
  | "herdr"
  | "kitty"
  | "cmux"
  | "none";

export type MultiplexerLayout =
  | "main-horizontal"
  | "main-vertical"
  | "tiled"
  | "even-horizontal"
  | "even-vertical";

export type ZellijPaneMode = "agent-tab" | "current-tab";

/** Raw configured multiplexer leaf values (post deep-merge, pre-defaults). */
export interface MultiplexerConfigured {
  type?: MultiplexerType;
  layout?: MultiplexerLayout;
  main_pane_size?: number;
  zellij_pane_mode?: ZellijPaneMode;
  /** Unknown nested keys preserved by JSONC writer but stripped by Zod at runtime. */
  [key: string]: unknown;
}

/** Effective values after OMO builtin defaults are applied. */
export interface MultiplexerEffective {
  type: MultiplexerType;
  layout: MultiplexerLayout;
  main_pane_size: number;
  zellij_pane_mode: ZellijPaneMode;
}

/** Per-field resolved provenance under `multiplexer.*`. */
export interface MultiplexerProvenance {
  properties: Record<string, ResolvedProperty>;
  /** Synthetic builtin-default leaves for fields absent from all sources. */
  builtinDefaults: string[];
}

/**
 * Static backend command availability. The control plane probes ONLY with
 * `command -v <name>` (never executes the binary, never crawls PATH beyond
 * the shell's resolution). `path` is the first stdout line when present.
 */
export interface MultiplexerCommandAvailability {
  command: string;
  status: "resolved" | "not-resolved" | "unknown" | "not-applicable";
  path?: string;
}

export type MultiplexerAvailabilityStatus =
  | "resolved"
  | "not-resolved"
  | "unknown"
  | "not-applicable";

export interface MultiplexerAvailability {
  tmux: MultiplexerCommandAvailability;
  zellij: MultiplexerCommandAvailability;
  herdr: MultiplexerCommandAvailability;
  kitten: MultiplexerCommandAvailability;
  kitty: MultiplexerCommandAvailability;
  cmux: MultiplexerCommandAvailability;
  opencode: MultiplexerCommandAvailability;
}

/**
 * Environment-signal auto detection (factory order, dist/index.js:35553-35572).
 * `resolvedType` is the concrete backend auto would pick, or null when no
 * signal matches. `insideSession` mirrors `isInsideSession()` per backend.
 */
export interface MultiplexerDetection {
  signals: {
    CMUX_SOCKET_PATH?: string;
    CMUX_WORKSPACE_ID?: string;
    CMUX_SURFACE_ID?: string;
    TMUX?: string;
    ZELLIJ?: string;
    HERDR_ENV?: string;
    HERDR_PANE_ID?: string;
    KITTY_PID?: string;
    KITTY_WINDOW_ID?: string;
  };
  /** Concrete backend auto resolves to; null when no signal matches. */
  resolvedType: MultiplexerType | null;
  /** Per-backend isInsideSession() outcome for the detected type. */
  insideSession: boolean;
  /** Order trace explaining the resolution. */
  order: Array<{ match: string; type: MultiplexerType } | { match: "none"; type: null }>;
}

/**
 * OMO-owned multiplexer session-manager record (session-manager store).
 * Exposes ONLY OMO-owned fields; never directory/owner/promise/raw object.
 * Pane ID is safe because the mapping is OMO-owned. Title comes from the
 * OMO-owned mapping, never from querying external panes.
 */
export interface MultiplexerSessionRecord {
  sessionId: string;
  paneId?: string;
  parentSessionId?: string;
  title?: string;
  /** Exact collection membership flags from the shared state. */
  known: boolean;
  spawning: boolean;
  closing: boolean;
  permanentlyClosed: boolean;
}

/** OMO-owned cmux session-store record (allowlist only). */
export interface CmuxSessionRecord {
  sessionId: string;
  parentSessionId?: string;
  paneId?: string;
  title?: string;
  spawnState: "known" | "spawning" | "attached" | "failed";
  lifecycle: "active" | "deleted" | "orphaned";
  /** True when the record carries a paneId (panePresent). */
  panePresent: boolean;
}

/** Runtime view composed from cached bridge stores (v2) only. */
export interface MultiplexerRuntimeStores {
  /** Session-manager records (capped 100, sorted by sessionId, deduped). */
  sessions: MultiplexerSessionRecord[];
  /** cmux session-store records (capped 100, sorted by sessionId, deduped). */
  cmux: CmuxSessionRecord[];
  /** Collection sizes (preserved from v1 for backward compatibility). */
  counts: {
    sessions?: number;
    knownSessions?: number;
    spawning?: number;
    closing?: number;
    permanentlyClosed?: number;
    cmuxRecords?: number;
  };
}

/**
 * Runtime correlation: OMO job → child OpenCode session mapping joined with
 * multiplexer session-manager records by exact OpenCode session ID. Reuses
 * the existing Slice 14 OMO job mapping. No calls to OpenCode/session APIs
 * from GET multiplexer and no mux queries.
 */
export interface MultiplexerRuntimeMapping {
  /** OpenCode session ID → multiplexer session record (when present). */
  bySessionId: Record<string, MultiplexerSessionRecord>;
  /** OMO job taskIds whose child session has a multiplexer record. */
  mappedJobs: string[];
  /** OMO job taskIds whose child session has no multiplexer record. */
  unmappedJobs: string[];
  /** True when bridge/runtime unavailable — mappings absent, not invented. */
  unavailable: boolean;
  /** Reuses Slice 14 staleness (rest+sse both disconnected). */
  stale: boolean;
  /** Reconciliation grace applied only when authoritative; else null. */
  graceAppliedMs?: number;
}

export interface MultiplexerRuntime {
  stores: MultiplexerRuntimeStores;
  mapping: MultiplexerRuntimeMapping;
  /** Bridge schema version reported (1 or 2); undefined when bridge down. */
  bridgeSchemaVersion?: number;
  bridgeConnected: boolean;
}

/** Activation behavior (verified from source, not invented). */
export interface MultiplexerActivation {
  /** "plugin-load" — config read once at plugin init; restart required. */
  configReadAt: "plugin-load";
  /** Availability check starts once at plugin init only if inside session. */
  availabilityCheckAt: "plugin-init-if-in-session";
  /** No hot reload proven in 2.2.10. */
  hotReload: false;
  /** Effective backend type controls behavior; legacy top-level tmux ignored. */
  legacyTmuxIgnored: boolean;
  note: string;
}

/** Capability matrix for the four multiplexer fields. */
export interface MultiplexerCapabilities {
  readable: true;
  resolved: true;
  provenance: true;
  editable: true;
  /** Partial: bridge store snapshots + OpenCode session/job mapping only. */
  runtimeObservable: "partial";
  /** False: control plane cannot drive the multiplexer. */
  runtimeControllable: false;
  doctor: true;
}

export interface MultiplexerSystemDto {
  /** Builtin defaults (provenance: builtin). */
  builtinDefaults: MultiplexerEffective;
  /** Raw configured leaves (post deep-merge, pre-defaults). */
  configured: MultiplexerConfigured;
  /** Effective values after builtin defaults. */
  effective: MultiplexerEffective;
  /** Per-field provenance. */
  provenance: MultiplexerProvenance;
  /** Legacy top-level `tmux` presence (inspected but ignored by OMO). */
  legacy: {
    tmuxPresent: boolean;
    ignored: true;
    note: string;
  };
  /** Static command availability (control-plane `command -v` only). */
  availability: MultiplexerAvailability;
  /** Environment-signal auto detection. */
  detection: MultiplexerDetection;
  /** Runtime stores + correlation (cached bridge only). */
  runtime: MultiplexerRuntime;
  /** Activation behavior. */
  activation: MultiplexerActivation;
  /** Capability matrix. */
  capabilities: MultiplexerCapabilities;
  /** Conservative warnings (configured/detected drift, missing explicit backend). */
  warnings: Array<{ kind: string; message: string; severity: "info" | "warning" }>;
  generatedAt: string;
}
