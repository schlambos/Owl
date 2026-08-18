/**
 * Control-plane model-probe constants (Slice 15, Lane 1).
 *
 * PROBE_TIMEOUT_MS is a hard-coded control-plane safety constant: it is
 * NEVER user-configurable and is NEVER written into OMO/OpenCode config.
 * Probing is an explicit diagnostic action, not inference infrastructure —
 * long or tunable budgets would turn it into an implicit inference path.
 *
 * The probe title prefix / metadata key are owned by
 * ../runtime/probe-sessions.ts (Lane 0) and re-exported here — do not
 * duplicate their string literals.
 */

import {
  PROBE_METADATA_KEY,
  PROBE_TITLE_PREFIX,
} from "../runtime/probe-sessions";

export { PROBE_METADATA_KEY, PROBE_TITLE_PREFIX };

/** Hard deadline for a single probe (ms). See file header. */
export const PROBE_TIMEOUT_MS = 20_000;

/** Concurrent probe workers. */
export const PROBE_CONCURRENCY = 2;

/** Maximum pending (not yet started) probe jobs; submits beyond → 503. */
export const PROBE_MAX_PENDING = 100;

/** Completed probe runs retained per (provider, model); running rows never count. */
export const PROBE_RETENTION_PER_MODEL = 50;

/** UX-only freshness threshold (ms): probes completed within this are "fresh". */
export const PROBE_FRESHNESS_MS = 24 * 60 * 60 * 1000;

/** Recent window (ms) for ProviderDiagnostics failure/rate-limit counts. */
export const PROBE_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Batch soft guard: ≤ soft submits normally; above requires force+ack. */
export const PROBE_BATCH_SOFT_LIMIT = 25;

/** Batch hard guard: above is rejected outright (400). */
export const PROBE_BATCH_HARD_LIMIT = 100;

/** Dedupe/agreement key for a (provider, model) pair. NUL is impossible in ids. */
export function modelKey(providerId: string, modelId: string): string {
  return `${providerId}\0${modelId}`;
}

/** Inverse of modelKey. */
export function splitModelKey(key: string): { providerId: string; modelId: string } {
  const i = key.indexOf("\0");
  return { providerId: key.slice(0, i), modelId: key.slice(i + 1) };
}

/** Parse a "provider/model[/…]" reference. Model ids may contain slashes. */
export function splitModelRef(
  ref: string,
): { providerId: string; modelId: string } | undefined {
  const i = ref.indexOf("/");
  if (i <= 0) return undefined;
  const providerId = ref.slice(0, i);
  const modelId = ref.slice(i + 1);
  if (!modelId) return undefined;
  return { providerId, modelId };
}
