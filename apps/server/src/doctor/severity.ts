/**
 * Central severity + aggregation policy. Single source of truth.
 */

import type {
  Diagnostic,
  DiagnosticSeverity,
  DoctorOverall,
} from "./types";

/**
 * Which severities degrade overall health:
 * - error → overall "error"
 * - warning → overall "degraded"
 * - healthy/info/unknown do NOT degrade.
 */
export function computeOverall(diagnostics: Diagnostic[]): DoctorOverall {
  if (diagnostics.some((d) => d.severity === "error")) return "error";
  if (diagnostics.some((d) => d.severity === "warning")) return "degraded";
  return "healthy";
}

/** Dedupe by stable id; last writer wins (deterministic order). */
export function dedupeDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const map = new Map<string, Diagnostic>();
  for (const d of diagnostics) map.set(d.id, d);
  return [...map.values()];
}

export function countBySeverity(diagnostics: Diagnostic[]): {
  healthy: number;
  info: number;
  warning: number;
  error: number;
  unknown: number;
} {
  const counts = { healthy: 0, info: 0, warning: 0, error: 0, unknown: 0 };
  for (const d of diagnostics) counts[d.severity]++;
  return counts;
}

/** Stable sort: error > warning > unknown > info > healthy, then category, id. */
const SEVERITY_RANK: Record<DiagnosticSeverity, number> = {
  error: 0,
  warning: 1,
  unknown: 2,
  info: 3,
  healthy: 4,
};

export function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((a, b) => {
    const r = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (r !== 0) return r;
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.id.localeCompare(b.id);
  });
}
