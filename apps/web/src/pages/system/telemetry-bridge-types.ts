// Local re-declaration of the Slice 17 telemetry-bridge management contract.
//
// The server keeps the preview/apply/restore/restart DTOs local to its routes
// (apps/server/src/opencode-bridge/types.ts); only the read-only status DTO
// lives in @omo/shared. These web-local mirrors describe ONLY the sanitized
// fields the control plane ever returns — never raw config, raw nonce, raw
// options, endpoint credentials, environment, or raw envelopes. They are
// kept structurally identical to the server types so the UI stays truthful.

/** Redacted, secret-free error from any bridge management operation. */
export interface BridgeErrorView {
  code: string;
  /** Redacted, secret-free human description. Never raw nonce/identity/content. */
  message: string;
}

/** POST /api/opencode/bridge/preview response body (wrapped: { ok, preview }). */
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
  /** SHA-256 hex fingerprint of the activation nonce (64 lowercase hex). */
  nonceFingerprint?: string;
  baselineHash: string;
  proposedHash: string;
  errors: BridgeErrorView[];
}

/** POST /api/opencode/bridge/apply response body (wrapped: { ok, apply }). */
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
  stateDisposition?: "not-written" | "committed" | "recovery-pending";
  errors: BridgeErrorView[];
}

/** POST /api/opencode/bridge/restore response body (wrapped: { ok, restore }). */
export interface BridgeRestoreDto {
  ok: boolean;
  revisionId?: string;
  targetPath?: string;
  restoredHash?: string;
  baselineHash?: string;
  stateDisposition?: "not-written" | "committed" | "recovery-pending";
  errors: BridgeErrorView[];
}

/** POST /api/opencode/bridge/restart response body (wrapped: { ok, restart }). */
export interface BridgeRestartResultView {
  ok: boolean;
  code?: string;
  /** Redacted, secret-free message. */
  message?: string;
}

/** Normalized error envelope returned by the bridge management endpoints. */
export interface BridgeApiError {
  ok: false;
  error: { code: string; message: string; action?: string };
}

/** Restart intent derived from authoritative actual state. */
export type BridgeRestartIntent =
  | "activate"
  | "deactivate"
  | "recover-activation-failure";

/**
 * Exact /restart request fields sourced from the current real DTO/state.
 * Only nonceFingerprint/port are sent when the DTO actually exposes them
 * (activate/recover); they are omitted for deactivate.
 */
export interface BridgeRestartRequest {
  intent: BridgeRestartIntent;
  expectedGeneration: number;
  expectedSourceHash: string;
  revisionId: string;
  nonceFingerprint?: string;
  port?: number;
  confirmation: "restart-owned-bridge";
}