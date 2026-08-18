/**
 * Control-plane probe-session classification (Slice 15).
 *
 * Probe sessions are created by the model probe engine with:
 *   - metadata { "omo.control-plane.probe": true }
 *   - title prefix "[OMO CP Probe] "
 *
 * Either signal marks a session as control-plane probe noise: metadata is
 * authoritative, the title prefix is a human-visible fallback that also
 * catches sessions whose metadata was not persisted/surfaced.
 *
 * Pure and dependency-free (type-only import) — unit-testable.
 */

import type { LiveSession } from "@omo/shared";

/** Metadata key written by the control plane into probe sessions. */
export const PROBE_METADATA_KEY = "omo.control-plane.probe";

/** Title prefix used for probe sessions (exact, case-sensitive). */
export const PROBE_TITLE_PREFIX = "[OMO CP Probe] ";

/** Input shape — matches the raw OpenCode session or a LiveSession. */
export interface ProbeSessionCandidate {
  title?: string;
  metadata?: unknown;
  controlPlaneProbe?: boolean;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (!v) return undefined;
  if (typeof v === "string") {
    // Tolerate serialized metadata
    try {
      const parsed: unknown = JSON.parse(v);
      return asRecord(parsed);
    } catch {
      return undefined;
    }
  }
  if (typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return undefined;
}

/**
 * True when the session is a control-plane probe session: normalized
 * metadata contains `"omo.control-plane.probe" === true`, OR the title
 * starts with exactly "[OMO CP Probe] ".
 */
export function isControlPlaneProbeSession(
  session: { title?: string; metadata?: unknown },
): boolean {
  const meta = asRecord(session.metadata);
  if (meta && meta[PROBE_METADATA_KEY] === true) return true;
  return (
    typeof session.title === "string" &&
    session.title.startsWith(PROBE_TITLE_PREFIX)
  );
}

/**
 * Derive the `controlPlaneProbe` flag for a session: an already-set explicit
 * flag wins; otherwise classify from title/metadata.
 */
export function deriveControlPlaneProbe(
  session: ProbeSessionCandidate,
): boolean {
  if (session.controlPlaneProbe === true) return true;
  return isControlPlaneProbeSession(session);
}

/**
 * Return a copy of a LiveSession with `controlPlaneProbe` set when the
 * classifier matches (idempotent; never clears an explicit true flag).
 */
export function withControlPlaneProbeFlag(
  session: LiveSession & { metadata?: unknown },
): LiveSession {
  if (session.controlPlaneProbe === true) return { ...session };
  if (!deriveControlPlaneProbe(session)) return { ...session };
  return { ...session, controlPlaneProbe: true };
}
