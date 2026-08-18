/**
 * Slice 17 hardened — OpenCode config/source/revision foundation types.
 *
 * Stable error codes, DTOs, and internal shapes for the managed telemetry
 * bridge plugin lane. No raw OpenCode config, raw provider config, or raw
 * activation nonces are ever stored in any DTO, error, log, or revision.
 *
 * Binding oracle decisions:
 *  - registrationTransport: "env" | "tuple" (how the plugin is registered)
 *  - transportMode: "loopback-http" (endpoint scheme, derived, not stored as transport)
 *  - nonceFingerprint: 64-char lowercase SHA-256 hex
 *  - plugin entry: string | readonly [string, plain options object]
 *  - identity kind: npm | path | file-url (separate from form)
 */

// ── Stable error codes ────────────────────────────────────────────────

export type BridgeErrorCode =
  | "source-unproven"
  | "config-ambiguous"
  | "plugin-shape-unsupported"
  | "duplicate-config"
  | "duplicate-effective"
  | "transport-unverified"
  | "env-scope-unproven"
  | "port-exhausted"
  | "port-race"
  | "hash-conflict"
  | "preview-stale"
  | "restore-mismatch"
  | "override-invalid"
  | "override-unmanaged"
  | "state-recovery-pending"
  | "state-conflict"
  // Drift-acceptance (metadata-only trust rebase) codes.
  | "drift-not-eligible"
  | "drift-proof-failed"
  | "revision-not-restorable"
  | "post-acceptance-drift"
  | "local-request-required"
  | "confirmation-mismatch";

export interface BridgeError {
  code: BridgeErrorCode;
  /** Redacted, secret-free human description. Never raw nonce/identity/content. */
  message: string;
  diagnostics?: BridgeAdvisory[];
}

export interface BridgeAdvisory {
  kind: "remote-schema" | "symlink-escape" | "root-escape" | "ambiguous-path";
  message: string;
}

// ── Plugin representation ─────────────────────────────────────────────
//
// Oracle decision 5: plugin entry is string OR readonly [string, plain options].
// Remove {path, options} support. Model form separately from identity kind.
// Form: how the entry appears structurally.
// IdentityKind: what the identity string looks like lexically.

export type PluginForm = "string" | "tuple" | "unsupported";
export type IdentityKind = "npm" | "path" | "file-url";

/**
 * Allowlisted bridge options parsed from a tuple entry's options object.
 * Only port, activationNonce, and transport are read; everything else
 * is discarded. Raw activationNonce is consumed for fingerprinting then
 * discarded — never stored in this object.
 */
export interface BridgeOptions {
  port?: number;
  /** Registration transport from options (not the endpoint scheme). */
  registrationTransport?: "env" | "tuple";
}

/**
 * Allowlisted bridge fingerprint.
 * Oracle contract:
 *  - Includes pluginForm ("string" | "tuple")
 *  - Bare string proves canonical bridge presence/form/transportMode,
 *    has registrationTransport="env", transportMode="loopback-http",
 *    and has NO configuredPort/nonceFingerprint.
 *  - Tuple retains validated port + fingerprint only when activationNonce is valid.
 * Raw nonce is NEVER stored here.
 */
export interface BridgeFingerprint {
  pluginForm?: "string" | "tuple";
  port?: number;
  /** How the plugin is registered: "env" (bare string + env vars) or "tuple". */
  registrationTransport: "env" | "tuple";
  /** Endpoint scheme (derived, not stored as transport). */
  transportMode: "loopback-http";
  /** 64-char lowercase SHA-256 hex of the raw activation nonce (present only when valid). */
  nonceFingerprint?: string;
}

// ── Effective plugin view (sanitized, supplied by future OpenCodeClient) ──

export interface EffectivePluginEntry {
  /** Structural form of the entry. */
  form: PluginForm;
  /** Lexical identity string exactly as it appears. */
  effectiveIdentity: string;
  /** Lexical identity kind. */
  identityKind: IdentityKind;
  /**
   * Present only for entries the canonical bridge identity resolver
   * recognizes as the managed telemetry bridge. Carries ONLY allowlisted
   * fingerprint fields. Raw nonce is NEVER present.
   */
  bridge?: BridgeFingerprint;
}

export interface EffectivePluginView {
  entries: EffectivePluginEntry[];
  unavailable?: boolean;
  /** Any unsupported entry invalidates the whole view. */
  invalid?: boolean;
}

// ── Source candidate (raw file on disk) ───────────────────────────────

export type ConfigSourceKind = "opencode-config-dir" | "project-root";

export interface SourcePluginEntry {
  /** Structural form of the entry in the source file. */
  form: PluginForm;
  /** Lexical identity string. */
  identity: string;
  /** Normalized identity (absolute path for path/file-url, original for npm). */
  normalizedIdentity: string;
  /** Lexical identity kind. */
  identityKind: IdentityKind;
  /** Allowlisted bridge options (only for recognized bridge entries). */
  bridgeOptions?: BridgeOptions;
  /** AST offset span for narrow fragment patching. */
  offset: number;
  length: number;
}

export interface SourceCandidate {
  root: string;
  /** Absolute realpath of the file (verified under root). */
  path: string;
  kind: ConfigSourceKind;
  format: "json" | "jsonc";
  text: string;
  hash: string;
  pluginEntries: SourcePluginEntry[];
}

// ── Resolver result ───────────────────────────────────────────────────

export type ResolverResult =
  | { status: "proven"; candidate: SourceCandidate; bridgeEntry: SourcePluginEntry | null }
  | { status: "blocked"; errors: BridgeError[] };

// ── Desired activation descriptor (oracle decision 3) ─────────────────

export type DesiredActivation =
  | { enabled: false }
  | {
      enabled: true;
      registrationTransport: "env" | "tuple";
      transportMode: "loopback-http";
      port: number;
      nonceFingerprint: string;
    };

// ── Byte patch (oracle decision 8) ────────────────────────────────────

/**
 * Deterministic reversible byte edit for only the bridge string entry.
 * Stores offset + exact before/after bridge fragment. No neighboring
 * values, no raw nonce, no comments, no arbitrary JSON.
 */
export interface BridgeBytePatchV1 {
  version: 1;
  /** UTF-16 code unit offset in the source text. */
  offsetUtf16: number;
  /** Text to delete at the offset (the exact bridge fragment before). */
  deleteText: string;
  /** Text to insert at the offset (the exact bridge fragment after). */
  insertText: string;
}

// ── DTOs for future routes ────────────────────────────────────────────

export interface BridgeSourceStatus {
  kind: ConfigSourceKind;
  path: string;
  format: "json" | "jsonc";
  hash: string;
  present: boolean;
  pluginEntries: Array<{
    form: PluginForm;
    identity: string;
    identityKind: IdentityKind;
  }>;
}

export interface BridgeEffectiveStatus {
  available: boolean;
  invalid: boolean;
  entries: Array<{
    form: PluginForm;
    effectiveIdentity: string;
    identityKind: IdentityKind;
    bridge?: BridgeFingerprint;
  }>;
}

export interface BridgeDesiredStatus {
  managed: boolean;
  canonicalIdentity?: string;
  desired: DesiredActivation;
}

export type BridgeStateDisposition = "not-written" | "committed" | "recovery-pending";

export interface BridgeConfigStatusDto {
  source: BridgeSourceStatus;
  effective: BridgeEffectiveStatus;
  desired: BridgeDesiredStatus;
  duplicates: { inSource: boolean; inEffective: boolean };
  stateDisposition: BridgeStateDisposition;
  errors: BridgeError[];
  advisories: BridgeAdvisory[];
}

// ── Preview / Apply / Restore DTOs ────────────────────────────────────

export interface BridgePreviewDto {
  previewId: string;
  ok: boolean;
  operation: "add" | "remove";
  targetPath: string;
  targetFormat: "json" | "jsonc";
  /** Safe bridge-only model-generated diff (no source line scanning). */
  diff: string;
  port?: number;
  registrationTransport?: "env" | "tuple";
  transportMode?: "loopback-http";
  nonceFingerprint?: string;
  baselineHash: string;
  proposedHash: string;
  errors: BridgeError[];
}

export interface BridgeApplyDto {
  ok: boolean;
  previewId?: string;
  revisionId?: string;
  targetPath?: string;
  baselineHash?: string;
  postWriteHash?: string;
  port?: number;
  registrationTransport?: "env" | "tuple";
  transportMode?: "loopback-http";
  nonceFingerprint?: string;
  stateDisposition?: BridgeStateDisposition;
  errors: BridgeError[];
}

export interface BridgeRestoreDto {
  ok: boolean;
  revisionId?: string;
  targetPath?: string;
  restoredHash?: string;
  baselineHash?: string;
  stateDisposition?: BridgeStateDisposition;
  errors: BridgeError[];
}

// ── Revision metadata (stored in SQLite; never raw config/nonce) ──────

/**
 * Revision operations. `add`/`remove` are content-writing and restorable.
 * `rebase` is METADATA-ONLY (drift acceptance): it records a trust rebase of
 * the committed hash/revision without any config write and is NEVER
 * restorable — it carries no byte patch.
 */
export type BridgeOperation = "add" | "remove" | "rebase";

interface BridgeRevisionBase {
  id: string;
  timestamp: string;
  targetPath: string;
  sourceKind: ConfigSourceKind;
  canonicalIdentity: string;
  port?: number;
  registrationTransport?: "env" | "tuple";
  transportMode?: "loopback-http";
  nonceFingerprint?: string;
}

/** Content-writing revision (restorable via exact inverse byte patch). */
export interface ContentBridgeRevisionRecord extends BridgeRevisionBase {
  operation: "add" | "remove";
  baselineHash: string;
  postWriteHash: string;
  /** BridgeBytePatchV1 JSON (offset + fragments, no raw nonce). */
  bytePatch: string;
}

/**
 * Metadata-only drift-acceptance revision (DB v3). Never restorable:
 * `bytePatch` is null by construction and restore rejects `rebase` before
 * parsing. `baselineHash` is the old committed hash; `postWriteHash` is the
 * accepted observed hash. Links the parent (pre-rebase) revision, the
 * original content-writing ADD anchor revision, and the acceptance intent.
 */
export interface RebaseRevisionRecord extends BridgeRevisionBase {
  operation: "rebase";
  baselineHash: string;
  postWriteHash: string;
  /**
   * Null for every legitimately written rebase (commitDriftAcceptance).
   * A non-null value indicates CORRUPTION and is surfaced (not hidden) so
   * lineage validation can reject the row.
   */
  bytePatch: string | null;
  parentRevisionId: string;
  anchorRevisionId: string;
  acceptanceIntentId: string;
}

export type BridgeRevisionRecord =
  | ContentBridgeRevisionRecord
  | RebaseRevisionRecord;

// ── Activation intent (oracle decision 2) ─────────────────────────────

export type ActivationIntentStatus = "prepared" | "committed" | "aborted" | "conflict" | "recovery-pending";

interface ActivationIntentBase {
  id: string;
  status: ActivationIntentStatus;
  targetPath: string;
  sourceKind: ConfigSourceKind;
  baselineHash: string;
  proposedHash: string;
  canonicalIdentity: string;
  port?: number;
  registrationTransport?: "env" | "tuple";
  transportMode?: "loopback-http";
  nonceFingerprint?: string;
  createdAt: string;
  committedAt?: string;
}

/** Content intent (add/remove): carries byte patch (+ transient raw nonce). */
export interface ContentActivationIntentRecord extends ActivationIntentBase {
  operation: "add" | "remove";
  bytePatch: string;
  /** Raw activation nonce stored ONLY here, cleared on commit/abort. */
  rawActivationNonce?: string;
}

/**
 * Metadata-only rebase intent (DB v3). Committed directly (created_at ==
 * committed_at). Never carries a byte patch or raw nonce. Records the
 * expected (pre-rebase) revision, the original ADD anchor revision, and the
 * sanitized versioned audit metadata JSON.
 */
export interface RebaseActivationIntentRecord extends ActivationIntentBase {
  operation: "rebase";
  bytePatch: null;
  rawActivationNonce: null;
  expectedRevisionId: string;
  anchorRevisionId: string;
  auditMetadata: string;
}

export type ActivationIntentRecord =
  | ContentActivationIntentRecord
  | RebaseActivationIntentRecord;

export interface BridgeActivationStateRecord {
  nonceFingerprint?: string;
  port?: number;
  registrationTransport?: "env" | "tuple";
  transportMode?: "loopback-http";
  canonicalIdentity: string;
  targetPath: string;
  sourceKind: ConfigSourceKind;
  configHash?: string;
  revisionId?: string;
  active: boolean;
  updatedAt: string;
}

// ── Drift acceptance (metadata-only trust rebase) DTOs ────────────────

/**
 * Fixed confirmation token for drift acceptance apply. Public by design —
 * it proves deliberate operator intent, not knowledge of a secret.
 */
export const DRIFT_ACCEPT_CONFIRMATION_TOKEN = "accept-opaque-config-drift-v1";

/** Fixed acknowledgement text surfaced in the preview. */
export const DRIFT_ACCEPT_ACKNOWLEDGEMENT =
  "I accept that the control plane cannot inspect the historical content of " +
  "this externally modified configuration. This records a metadata-only " +
  "trust rebase of the committed hash/revision: no config content is " +
  "written, no runtime action occurs, non-bridge changes remain opaque and " +
  "unverified, and no rollback is available for this acceptance.";

/** Exact limitation booleans — every preview/apply states them verbatim. */
export interface DriftAcceptanceLimitations {
  historicalContentAvailable: false;
  fullDiffAvailable: false;
  contentEquivalenceProven: false;
  nonBridgeChangesOpaque: true;
  canonicalBridgeContinuityProven: true;
  configWritePlanned: false;
  runtimeActionPlanned: "none";
  rollbackAvailable: false;
}

/** Sanitized plugin-sequence entry (no raw arbitrary paths/options). */
export interface DriftAcceptancePluginEntry {
  index: number;
  form: PluginForm;
  identityKind: IdentityKind;
  /** Fixed label for the canonical managed bridge entry. */
  label?: "managed-telemetry-bridge";
  /** SHA-256 fingerprint of the lexical identity — noncanonical entries only. */
  identityFingerprint?: string;
}

/**
 * Sanitized drift-acceptance proof. Contains hashes, digests, spans, and
 * allowlisted metadata only — never raw config text, raw nonce, raw
 * arbitrary paths, tuple options, or provider/auth values.
 */
export interface DriftAcceptanceProof {
  version: 1;
  oldCommittedHash: string;
  observedHash: string;
  expectedRevisionId: string;
  targetRealpath: string;
  sourceKind: ConfigSourceKind;
  format: "json" | "jsonc";
  byteLength: number;
  pluginSequence: DriftAcceptancePluginEntry[];
  canonicalBridgeIndex: number;
  canonicalBridgeSpan: { offset: number; length: number };
  fragmentDigest: string;
  anchorRevisionId: string;
  patchDigest: string;
  anchorPresent: true;
  preserved: {
    port: number;
    transportMode: "loopback-http";
    canonicalIdentity: string;
    nonceFingerprint: string;
  };
  topLevel: {
    knownKeysPresent: string[];
    totalCount: number;
    unknownCount: number;
  };
  limitations: DriftAcceptanceLimitations;
}

export interface DriftAcceptancePreviewRequest {
  expectedRevisionId: string;
  expectedCommittedHash: string;
  expectedObservedHash: string;
}

export interface DriftAcceptanceApplyRequest extends DriftAcceptancePreviewRequest {
  previewId: string;
  confirmation: string;
}

export interface DriftAcceptancePreviewDto {
  ok: boolean;
  previewId?: string;
  proof?: DriftAcceptanceProof;
  /** SHA-256 digest of the sanitized proof (binds apply to this preview). */
  proofDigest?: string;
  acknowledgement: string;
  confirmationToken: string;
  errors: BridgeError[];
}

export interface DriftAcceptanceApplyDto {
  ok: boolean;
  previewId?: string;
  /** True once the metadata transaction committed (even on post-commit drift). */
  metadataCommitted: boolean;
  configWritten: false;
  runtimeAction: "none";
  restorable: false;
  restartRequired?: true;
  revisionId?: string;
  oldConfigHash?: string;
  newConfigHash?: string;
  stateDisposition?: BridgeStateDisposition;
  errors: BridgeError[];
}

// ── Override (OMO_BRIDGE_BASE_URL) ────────────────────────────────────

export interface BridgeOverrideStatus {
  present: boolean;
  url?: string;
  port?: number;
  invalid: boolean;
  invalidReason?: string;
  optsOutOfManagement: boolean;
}

// ── Port selection ────────────────────────────────────────────────────

export const BRIDGE_PORT_RANGE_START = 8788;
export const BRIDGE_PORT_RANGE_END = 8803;

export interface PortSelectionResult {
  port: number | null;
  errors: BridgeError[];
  probed: number[];
}

// ── Watcher ───────────────────────────────────────────────────────────

export interface BridgeWatcherEvent {
  kind: "external-edit" | "self-write" | "removed";
  path: string;
  hash: string;
  timestamp: string;
}

/** One-shot self-write intent keyed exact path+hash+token+expiry. */
export interface SelfWriteIntent {
  path: string;
  hash: string;
  token: string;
  expiresAt: number;
}

export interface BridgeWatcherOptions {
  directory: string;
  debounceMs?: number;
}