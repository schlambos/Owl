/**
 * OMO runtime telemetry DTOs.
 *
 * Source authority: installed oh-my-opencode-slim@2.2.10
 * (~/.config/opencode/node_modules/oh-my-opencode-slim/dist/index.js).
 *
 * Only externally-derivable facts are modeled here. OMO board internals
 * (reuse counts, eligibility, fallback chains, runtime preset) are
 * closure-scoped in the installed bundle and are NOT represented:
 * - BackgroundJobBoard class instance lives in plugin closure
 *   (dist/index.js:25015 class BackgroundJobBoard; board state "reconciled"
 *   exists only there — dist/index.js:25225).
 * - activeRuntimePreset is a module var (dist/index.js:21244) and the
 *   package's main entry exports ONLY the default plugin
 *   (dist/index.js:41424-41425) → unreachable for us.
 */

/**
 * Telemetry schema versions understood by this server. The bridge may emit
 * v1 (aggregates only), v2 (aggregates + whitelisted records), or v3
 * (aggregates + records + identity + capabilities). v1/v2 are accepted for
 * historical/unverified display only; only verified v3 may become
 * current-generation authoritative.
 */
export const OMO_TELEMETRY_SCHEMA_VERSION = 2 as const;
export const OMO_TELEMETRY_ACCEPTED_SCHEMA_VERSIONS: ReadonlySet<number> =
  new Set([1, 2, 3]);

/** Bridge schema version that is authoritative (current-generation). */
export const OMO_BRIDGE_SCHEMA_VERSION_V3 = 3 as const;
/** Legacy bridge schema versions accepted for display only (not authoritative). */
export const OMO_BRIDGE_LEGACY_SCHEMA_VERSIONS: ReadonlySet<number> =
  new Set([1, 2]);

/**
 * Exact installed TaskOutputState set (dist/utils/task.d.ts:
 * `export type TaskOutputState = 'running' | 'completed' | 'error' | 'cancelled'`).
 * "reconciled" is an OMO-closure-only board state (dist/index.js:25225) —
 * NOT derivable externally; never emitted here.
 */
export type OmoJobState = "running" | "completed" | "error" | "cancelled";

/** Terminal states per TERMINAL_STATES (dist/index.js:25000-25004). */
export const OMO_TERMINAL_STATES: ReadonlySet<OmoJobState> = new Set<
  OmoJobState
>(["completed", "error", "cancelled"]);

export interface OmoJob {
  /** = child session id (task tool result taskID equals child OpenCode session). */
  taskId: string;
  /** From task result metadata/text when present (alias shape per dist/index.js:25496-25503). */
  alias?: string;
  /** subagent_type from the task tool call args. */
  agent: string;
  description?: string;
  /** Session containing the task tool call. */
  parentSessionId: string;
  /** = taskId when child session present in OpenCode. */
  childSessionId: string;
  state: OmoJobState;
  /** Only when present in status output (dist/index.js:24972). */
  timedOut?: boolean;
  /** From <task_result> — capped at 200 chars; never full body. */
  resultSummary?: string;
  /** Part time (ms epoch). */
  launchedAt?: number;
  completedAt?: number;
  /** task_id arg seen on a LATER task call with same taskId/alias. */
  resumeRequested?: boolean;
  /** Only if telemetry-source flags it; never invented. */
  statusUncertain?: boolean;
  /** Provenance of the record. */
  source: "opencode-task-call";
}

/** Grouped per-agent view over jobs. */
export interface OmoWorkerView {
  agent: string;
  running: number;
  completed: number;
  errored: number;
  cancelled: number;
  /** taskIds */
  jobs: string[];
}

/**
 * Optional, only when bridge responds (bridge plugin is a separate lane).
 * Shape matches packages/omo-telemetry-bridge `TelemetryStores` EXACTLY
 * (stores.ts:82-87: fallbackInProgressSessionIDs / continuationGate /
 * cmux / multiplexer with sessionsCount, knownSessionsCount, spawningCount,
 * closingCount, permanentlyClosedCount).
 * Note: the bridge may serialize attemptCounts values as strings
 * (serializePrimitive, stores.ts:124-133); this DTO keeps the numeric
 * whitelist and the client sanitizer widens to `number | string`.
 *
 * v2 (Slice 16): adds whitelisted multiplexerRecords, multiplexerCollectionIds,
 * and cmuxRecords. The server accepts both v1 and v2; v1 fields are preserved.
 */
export interface OmoBridgeStores {
  fallbackInProgressSessionIDs?: string[];
  continuationGate?: {
    attemptCounts?: Record<string, number | string>;
    lastRearmIdentity?: Record<string, string>;
  };
  multiplexer?: {
    sessionsCount?: number;
    knownSessionsCount?: number;
    spawningCount?: number;
    closingCount?: number;
    permanentlyClosedCount?: number;
  };
  cmux?: { recordCount?: number };
  /** v2: whitelisted session-manager records (capped 100, sorted, deduped). */
  multiplexerRecords?: Array<{
    sessionId: string;
    paneId?: string;
    parentSessionId?: string;
    title?: string;
    known: boolean;
    spawning: boolean;
    closing: boolean;
    permanentlyClosed: boolean;
  }>;
  /** v2: collection IDs without sessions records. */
  multiplexerCollectionIds?: {
    known?: string[];
    spawning?: string[];
    closing?: string[];
    permanentlyClosed?: string[];
  };
  /** v2: whitelisted cmux session-store records (capped 100, sorted, deduped). */
  cmuxRecords?: Array<{
    sessionId: string;
    parentSessionId?: string;
    paneId?: string;
    title?: string;
    spawnState: "known" | "spawning" | "attached" | "failed";
    lifecycle: "active" | "deleted" | "orphaned";
    panePresent: boolean;
  }>;
}

export interface OmoBridgeStatus {
  connected: boolean;
  lastSeenAt?: number;
  stores?: OmoBridgeStores;
  schemaVersion?: number;
  /**
   * v3: per-plugin-instance bridge identity. Present only when a verified
   * v3 response has been received and validated. Legacy v1/v2 responses never
   * populate this field.
   */
  identity?: OmoBridgeIdentity;
  /**
   * v3: capability-level availability. Present only when a verified v3
   * response has been received and validated.
   */
  capabilities?: OmoBridgeCapabilities;
  /**
   * v3: bridge package version (advisory). Present only when a verified v3
   * response carries it.
   */
  bridgePackageVersion?: string;
  /**
   * v3: whether this status is verified-authoritative (true) or
   * legacy/unverified display-only (false). Only verified v3 may become
   * current-generation authoritative.
   */
  verified?: boolean;
}

/**
 * v3 per-plugin-instance bridge identity. Mirrors the hardened bridge schema
 * v3 exactly (packages/omo-telemetry-bridge/src/stores.ts BridgeIdentity).
 * Fields are populated only when source-verifiable; absent fields are omitted
 * rather than fabricated. Contains NO raw secrets — the activation nonce is
 * reduced to a SHA-256 fingerprint.
 */
export interface OmoBridgeIdentity {
  /** Fresh random UUID per plugin instance. */
  pluginInstanceId: string;
  /** `Date.now()` at plugin init (ms epoch). */
  startupTimestamp: number;
  /**
   * Canonical OpenCode origin (scheme + host + port, no userinfo/path/query/
   * fragment). Omitted when the bridge could not parse the OpenCode serverUrl.
   */
  canonicalOrigin?: string;
  /**
   * SHA-256 hex fingerprint of the activation nonce (exactly 64 lowercase hex
   * characters). Omitted when no nonce was supplied. The raw nonce is NEVER
   * present.
   */
  nonceFingerprint?: string;
  /** Transport mode is always loopback HTTP for this bridge. */
  transportMode: "loopback-http";
  /** Bridge package version read from package.json at init (advisory). */
  bridgePackageVersion?: string;
  /** Schema version in effect at capture (always 3 for v3 identity). */
  schemaVersion: number;
  /** `Date.now()` at identity capture (ms epoch). */
  capturedAt: number;
}

/**
 * v3 capability-level availability for the four allowlisted stores plus
 * explicit unavailable flags. Mirrors the hardened bridge schema v3 exactly
 * (packages/omo-telemetry-bridge/src/stores.ts BridgeCapabilities).
 */
export type OmoBridgeStoreAvailability = "present" | "absent" | "malformed";

export interface OmoBridgeCapabilities {
  fallbackInProgress: OmoBridgeStoreAvailability;
  continuationGate: OmoBridgeStoreAvailability;
  multiplexerManager: OmoBridgeStoreAvailability;
  cmuxStore: OmoBridgeStoreAvailability;
  /** ALWAYS false — module var not exported (dist/index.js:21244, 41424-41425). */
  runtimePreset: false;
  /** ALWAYS false — lives inside OMO BackgroundJobBoard closure. */
  workerReuse: false;
  /** ALWAYS false — no terminal/PTY/scrollback data is exposed. */
  terminalCapture: false;
}

/**
 * v3 health document from `GET /health`. Mirrors the hardened bridge schema
 * (packages/omo-telemetry-bridge/src/routing.ts /health response).
 */
export interface OmoBridgeHealth {
  ok: boolean;
  schemaVersion: number;
  bound: boolean;
  capabilities: OmoBridgeCapabilities;
  /** Present when the bridge has captured an identity. */
  pluginInstanceId?: string;
}

export interface OmoRuntimeSnapshot {
  telemetrySchemaVersion: 1 | 2 | 3;
  generatedAt: number;
  /** Derived: upstream OpenCode rest+sse both disconnected → stale. */
  stale: boolean;
  availability: {
    opencodeJobs: boolean;
    bridge: boolean;
    /** ALWAYS false on 2.2.10 — module var not exported (dist/index.js:21244, 41424-41425). */
    runtimePreset: false;
  };
  jobs: OmoJob[];
  workers: OmoWorkerView[];
  bridge?: OmoBridgeStatus;
  /**
   * v3: bridge lifecycle state. Present when a TelemetryBridgeManager is
   * wired (future index integration). Omitted when the bridge is unmanaged.
   */
  bridgeLifecycle?: OmoBridgeLifecycleState;
  notes: string[];
}

/**
 * Small SSE payload for /api/events (`omo-runtime.updated`).
 * Full snapshot is never sent on the stream.
 * (Local extension of the shared ControlPlaneEvent union — packages/shared
 * is not modified by this lane.)
 */
export interface OmoRuntimeUpdatedEvent {
  type: "omo-runtime.updated";
  ts: number;
  jobCount: number;
  /** taskIds whose state/appearance changed since last emitted signature */
  changed: string[];
  bridgeConnected: boolean;
}

// ── Slice 17 v3: bridge lifecycle state ───────────────────────────────────
//
// These types model the runtime/lifecycle state of the telemetry bridge as
// observed by the OMO runtime lane. They adapt the approved normalized
// structure without collapsing binary distinctions. The future index wires
// a TelemetryBridgeManager that produces these states; the OMO runtime lane
// consumes them read-only.

/** OpenCode mode the bridge is associated with. */
export type OmoBridgeOpenCodeMode = "managed" | "attach";

/** Who owns the bridge process. */
export type OmoBridgeOwnership = "control-plane" | "external";

/**
 * Bridge runtime state. Adapts the approved normalized structure to existing
 * conventions. Do not collapse binary — each value carries distinct meaning.
 */
export type OmoBridgeRuntimeState =
  | "inactive"
  | "starting"
  | "active"
  | "failed"
  | "stale"
  | "unavailable"
  | "mismatch";

/**
 * Bridge registration state of the plugin in the OpenCode config.
 * - `not-registered` — plugin entry absent.
 * - `registered` — exactly one recognized bridge entry present.
 * - `duplicate` — more than one recognized bridge entry present.
 * - `unknown` — effective plugin view unavailable (OpenCode not ready).
 */
export type OmoBridgeRegistrationState =
  | "not-registered"
  | "registered"
  | "duplicate"
  | "unknown";

/**
 * Bridge compatibility with the current control-plane process.
 * - `compatible` — verified v3, identity matches expected generation.
 * - `incompatible` — v3 present but identity/fingerprint/origin mismatch.
 * - `unknown` — legacy v1/v2, or no verified response yet.
 */
export type OmoBridgeCompatibility =
  | "compatible"
  | "incompatible"
  | "unknown";

/** Source of the bridge endpoint URL. */
export type OmoBridgeEndpointSource =
  | "managed-derived"
  | "explicit-override"
  | "unavailable";

/**
 * Full bridge lifecycle state. Produced by TelemetryBridgeManager. All
 * fields are populated only when source-verifiable; absent/unknown fields
 * use the `unknown` enum value rather than being collapsed to a boolean.
 */
export interface OmoBridgeLifecycleState {
  /** OpenCode mode the bridge is associated with. */
  mode: OmoBridgeOpenCodeMode;
  /** Who owns the bridge process. */
  ownership: OmoBridgeOwnership;
  /** Whether the control plane can restart the bridge (managed only). */
  restartControllable: boolean;
  /** Runtime state of the bridge connection. */
  runtime: OmoBridgeRuntimeState;
  /** Registration state of the plugin in the OpenCode config. */
  registration: OmoBridgeRegistrationState;
  /** Compatibility with the current control-plane process. */
  compatibility: OmoBridgeCompatibility;
  /** Local bridge package availability (best-effort). */
  localPackageAvailable: boolean | "unknown";
  /** Source of the bridge endpoint URL. */
  endpointSource: OmoBridgeEndpointSource;
  /** Effective bridge endpoint URL (undefined when unavailable). */
  endpoint?: string;
  /** Whether an explicit override is in effect (opts out of management). */
  overrideActive: boolean;
  /** Whether the override (if present) is invalid. */
  overrideInvalid: boolean;
  /** Bridge schema version reported (1, 2, or 3); undefined when no response. */
  schemaVersion?: number;
  /** OMO version hint (advisory, from bridge package version). */
  omoVersion?: string;
  /** Bridge package version (advisory). */
  bridgePackageVersion?: string;
  /** Per-store capability availability (v3 only). */
  capabilities?: OmoBridgeCapabilities;
  /** Verified v3 identity (present only when compatible). */
  identity?: OmoBridgeIdentity;
  /** Verification epoch (increments on generation/endpoint/identity change). */
  verificationEpoch: number;
  /** Lifecycle generation (from lifecycle input). */
  generation: number;
  /** Whether the OMO runtime backend is ready (from lifecycle input). */
  omoReady: boolean;
  /** Whether the bridge backend is connected/ready (health ok + bound). */
  backendConnected: boolean;
  /** Last error (redacted, no raw secrets). */
  error?: string;
  /** Last updated timestamp (ms epoch). */
  updatedAt: number;
}

/**
 * Committed desired activation state for the bridge. Fed by the future index
 * from the control-plane config/revision pipeline. Contains NO raw nonce —
 * only the fingerprint.
 */
export interface OmoBridgeCommittedActivation {
  enabled: boolean;
  /** Bind port (managed range 8788..8803). */
  port?: number;
  /** SHA-256 hex fingerprint of the activation nonce (64 lowercase hex). */
  nonceFingerprint?: string;
  /** Source hash of the config file (for generation change detection). */
  sourceHash?: string;
  /** Revision id of the last committed write. */
  revisionId?: string;
  /** How the plugin is registered: "env" (bare string) or "tuple". */
  registrationTransport?: "env" | "tuple";
}

/**
 * Inputs to TelemetryBridgeManager. Generic so the future index can feed
 * them without the OMO runtime lane depending on index/config/lifecycle
 * internals.
 */
export interface OmoBridgeManagerInput {
  /** OpenCode mode. */
  mode: OmoBridgeOpenCodeMode;
  /** Who owns the bridge process. */
  ownership: OmoBridgeOwnership;
  /** Lifecycle generation (increments on backend replacement). */
  generation: number;
  /** Canonical OpenCode origin (scheme + host + port). */
  canonicalOrigin?: string;
  /** Whether the OMO runtime backend is connected/ready. */
  omoReady: boolean;
  /** Committed desired activation state (from config/revision pipeline). */
  committed: OmoBridgeCommittedActivation;
  /**
   * Optional validated explicit OMO_BRIDGE_BASE_URL override. When valid,
   * wins observation and opts out of management. When invalid, ignored.
   */
  overrideUrl?: string;
  /** Override invalid flag (from config validation). */
  overrideInvalid?: boolean;
  /**
   * Initialization flag for control-plane restart. When true, the first
   * binding may accept an existing pluginInstanceId for the current backend
   * (same control-plane process restart). When false (default), a
   * successful replacement generation requires a new pluginInstanceId.
   */
  acceptExistingInstanceOnFirstBinding?: boolean;
  /** Local bridge package availability (best-effort). */
  localPackageAvailable?: boolean | "unknown";
  /** Registration state (from config/effective view). */
  registration?: OmoBridgeRegistrationState;
}
