/**
 * Telemetry security enforcer.
 *
 * The OMO job corpus is derived from OpenCode message parts that ALSO carry
 * full prompt text and tool args. Only an explicit field whitelist may reach
 * a snapshot; anything else is rejected (fail-closed) — never silently
 * trimmed into shape.
 */

import type { OmoJob } from "./types";

/** Exact OmoJob key whitelist (types.ts). */
export const ALLOWED_JOB_FIELDS: ReadonlySet<string> = new Set([
  "taskId",
  "alias",
  "agent",
  "description",
  "parentSessionId",
  "childSessionId",
  "state",
  "timedOut",
  "resultSummary",
  "launchedAt",
  "completedAt",
  "resumeRequested",
  "statusUncertain",
  "source",
]);

/** resultSummary hard cap — never full <task_result> bodies. */
export const RESULT_SUMMARY_MAX = 200;

/**
 * Keys that must never appear anywhere in an output shape (case-insensitive
 * substring match). Covers prompt contents, provider auth, env values,
 * ACP env, file contents carriers.
 */
const DISALLOWED_KEY_PATTERNS: RegExp[] = [
  /prompt/i, // tool args.prompt, prompt text
  /authorization/i,
  /authheader/i,
  /api[-_]?key/i,
  /token/i,
  /secret/i,
  /password/i,
  /cookie/i,
  /^env$/i,
  /environment/i,
  /private[-_]?key/i,
];

export class TelemetrySecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelemetrySecurityError";
  }
}

/** Cap a result body to the summary limit (single line, no trailing space). */
export function capSummary(text: string, max = RESULT_SUMMARY_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

/**
 * Assert an object contains ONLY whitelisted keys (top level) and no
 * disallowed key names anywhere in its shape. Throws TelemetrySecurityError.
 */
export function assertNoDisallowedFields(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string> = ALLOWED_JOB_FIELDS,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new TelemetrySecurityError(
        `telemetry output contains non-whitelisted field "${key}"`,
      );
    }
  }
  assertNoSensitiveKeys(obj, "job");
}

/** Deep-scan for forbidden key names; throws TelemetrySecurityError. */
export function assertNoSensitiveKeys(value: unknown, path: string): void {
  if (value == null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSensitiveKeys(v, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    for (const pat of DISALLOWED_KEY_PATTERNS) {
      if (pat.test(k)) {
        throw new TelemetrySecurityError(
          `telemetry output contains disallowed key "${k}" at ${path}`,
        );
      }
    }
    assertNoSensitiveKeys(v, `${path}.${k}`);
  }
}

/**
 * Build a sanitized job: whitelist keys only, cap summary, drop empties.
 * This is the ONLY path through which scan evidence becomes an OmoJob.
 */
export function sanitizeJob(input: {
  taskId: string;
  alias?: string;
  agent: string;
  description?: string;
  parentSessionId: string;
  childSessionId: string;
  state: OmoJob["state"];
  timedOut?: boolean;
  resultSummary?: string;
  launchedAt?: number;
  completedAt?: number;
  resumeRequested?: boolean;
  statusUncertain?: boolean;
  source: OmoJob["source"];
}): OmoJob {
  const job: OmoJob = {
    taskId: input.taskId,
    agent: input.agent,
    parentSessionId: input.parentSessionId,
    childSessionId: input.childSessionId,
    state: input.state,
    source: input.source,
  };
  if (input.alias) job.alias = input.alias;
  if (input.description) job.description = input.description.slice(0, 120);
  if (input.timedOut !== undefined) job.timedOut = input.timedOut;
  if (input.resultSummary !== undefined) {
    job.resultSummary = capSummary(input.resultSummary);
  }
  if (input.launchedAt !== undefined) job.launchedAt = input.launchedAt;
  if (input.completedAt !== undefined) job.completedAt = input.completedAt;
  if (input.resumeRequested) job.resumeRequested = true;
  if (input.statusUncertain) job.statusUncertain = true;
  assertNoDisallowedFields(job as unknown as Record<string, unknown>);
  return job;
}
