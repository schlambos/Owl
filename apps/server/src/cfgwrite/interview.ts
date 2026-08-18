/**
 * Typed Interview mutations (Slice 18 D2).
 *
 * Delegates every physical write exclusively to the D1 transaction boundary
 * (previewOmoCandidate / previewThenCommit). Only the five verified
 * installed InterviewConfigSchema fields are writable (maxQuestions,
 * outputFolder, autoOpenBrowser, port, dashboard), gated on the typed
 * capability version/hash/field audit (resolveInterviewTypedCapability).
 *
 * Semantics:
 * - `set` validates values against the audited installed metadata
 *   (exact types, ranges, minLength) and writes only `interview.<field>`.
 * - `remove` deletes only that source leaf so scope inheritance or the
 *   built-in default is restored; unrelated keys, unknown interview keys,
 *   comments, and formatting are preserved.
 * - Operations must be non-empty with unique fields.
 * - Apply independently revalidates through the transaction (expected
 *   source fingerprint + candidate SHA) and journals a revision.
 *
 * This module performs no Interview invocation, no browser/server/port
 * action, no lifecycle/restart/model-probe activity, and no output-folder
 * inspection. It performs no direct filesystem access; the transaction is
 * the only writer.
 */

import type {
  InterviewCommitResponse,
  InterviewMutationOperation,
  InterviewPreviewResponse,
  InterviewRawRepair,
  InterviewSemantics,
  InterviewTypedCapability,
  OmoCandidateProducer,
  OmoScope,
  OmoTransactionErrorCode,
  ProvenanceBundle,
  SourceFingerprint,
} from "@omo/shared";
import type { ServerConfig } from "../config";
import {
  buildInterviewState,
  INTERVIEW_FIELDS,
  INTERVIEW_FIELD_METADATA,
  resolveInterviewTypedCapability,
} from "../omo/interview";
import { loadInstalledSchema } from "../omo-schema/authority";
import { schemaContextFor } from "../omo-schema/validator";
import { applyJsoncPathEdit, getAtPath } from "./jsonc-edit";
import type { RevisionStore } from "./revisions";
import {
  expectedSourceFromHash,
  fingerprintScope,
  previewOmoCandidate,
  previewThenCommit,
  type OmoTransactionDeps,
  type OmoTransactionPreviewInternal,
} from "./transaction";

/**
 * Mutation request. Structurally compatible with the shared
 * `InterviewMutationRequest` DTO; `expectedSourceHash` is an additive
 * convenience mirroring the other config routes. At least one of
 * `expectedSource` / `expectedSourceHash` must be supplied by callers
 * (enforced at the route boundary).
 */
export interface InterviewMutation {
  scope: OmoScope;
  expectedSource?: SourceFingerprint;
  /** Legacy hash-only convenience (same semantics as other config routes). */
  expectedSourceHash?: string;
  operations: InterviewMutationOperation[];
  expectedCandidateSha256?: string;
}

export type { InterviewSemantics };

export type InterviewMutationResult =
  | InterviewPreviewResponse
  | InterviewCommitResponse;

const RAW_REPAIR_CODES: ReadonlySet<OmoTransactionErrorCode> = new Set([
  "syntax-invalid",
  "root-not-object",
  "schema-invalid",
  "schema-unavailable",
]);

const MIN_LENGTH_BY_FIELD = new Map<string, number | undefined>(
  INTERVIEW_FIELD_METADATA.map((m) => [
    m.name as string,
    (m as { minLength?: number }).minLength,
  ]),
);

/** HTTP status mapping follows the D1 transaction code semantics. */
export function interviewHttpStatus(
  code?: OmoTransactionErrorCode,
): InterviewCommitResponse["status"] {
  switch (code) {
    case "stale-source":
      return 409;
    case "oversize":
      return 413;
    case "schema-invalid":
    case "schema-unavailable":
    case "syntax-invalid":
    case "root-not-object":
      return 422;
    case "recovery-pending":
      return 503;
    default:
      return 400;
  }
}

/**
 * Validate operations against the audited installed field metadata:
 * exactly the five verified fields, unique per request, non-empty,
 * exact types/ranges/minLength for `set`, value-less `remove`.
 */
export function validateInterviewOperations(
  operations: InterviewMutationOperation[],
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!Array.isArray(operations) || operations.length === 0) {
    errors.push("operations must be a non-empty array");
    return { errors, warnings };
  }
  const seen = new Set<string>();
  for (const op of operations) {
    if (!op || typeof op !== "object") {
      errors.push("each operation must be an object");
      continue;
    }
    const fieldName = String((op as { field?: unknown }).field);
    const spec = INTERVIEW_FIELDS[fieldName];
    if (!spec) {
      errors.push(`Unknown interview field: ${fieldName}`);
      continue;
    }
    if (seen.has(spec.name)) {
      errors.push(`Duplicate operation for interview.${spec.name}`);
      continue;
    }
    seen.add(spec.name);
    if (op.op === "remove") {
      if ((op as { value?: unknown }).value !== undefined) {
        errors.push(`interview.${spec.name} remove must not carry a value`);
      }
      continue;
    }
    if (op.op !== "set") {
      errors.push(`interview.${spec.name} op must be "set" or "remove"`);
      continue;
    }
    const v = (op as { value?: unknown }).value;
    if (v === undefined) {
      errors.push(`interview.${spec.name} set requires a value`);
      continue;
    }
    if (spec.schemaType === "integer") {
      if (typeof v !== "number" || !Number.isInteger(v)) {
        errors.push(`interview.${spec.name} must be an integer`);
      } else {
        if (spec.minimum !== undefined && v < spec.minimum) {
          errors.push(`interview.${spec.name} minimum ${spec.minimum}`);
        }
        if (spec.maximum !== undefined && v > spec.maximum) {
          errors.push(`interview.${spec.name} maximum ${spec.maximum}`);
        }
      }
    } else if (spec.schemaType === "boolean") {
      if (typeof v !== "boolean") {
        errors.push(`interview.${spec.name} must be a boolean`);
      }
    } else if (spec.schemaType === "string") {
      if (typeof v !== "string") {
        errors.push(`interview.${spec.name} must be a string`);
      } else {
        const minLength = MIN_LENGTH_BY_FIELD.get(spec.name);
        if (minLength !== undefined && v.length < minLength) {
          errors.push(
            `interview.${spec.name} must be a string of at least minLength ${minLength}`,
          );
        }
      }
    }
  }
  return { errors, warnings };
}

/**
 * Typed Interview candidate producer. Applies only the requested
 * interview.<field> leaf edits via the JSONC path editor, preserving
 * comments, ordering, and unrelated/unknown keys.
 */
export const produceInterviewCandidate: OmoCandidateProducer<InterviewMutation> =
  (input) => {
    const { errors, warnings } = validateInterviewOperations(
      input.input.operations,
    );
    const edits: Array<{ path: string[]; value: unknown }> = [];
    if (!errors.length) {
      for (const op of input.input.operations) {
        const path = ["interview", op.field as string];
        const value = op.op === "remove" ? undefined : op.value;
        // Removing an absent leaf is a textual no-op; jsonc modify cannot
        // delete inside a missing parent, so skip the edit entirely and let
        // the transaction report the overall no-op.
        if (op.op === "remove") {
          const current = getAtPath(input.beforeDocument, path);
          if (current === undefined) continue;
        }
        edits.push({ path, value });
      }
    }
    let candidateText = input.beforeText;
    if (!errors.length) {
      for (const e of edits) {
        candidateText = applyJsoncPathEdit(candidateText, e.path, e.value);
      }
    }
    const propertyPaths = edits.map((e) => e.path.join("."));
    return {
      candidateText,
      featureErrors: errors,
      featureWarnings: warnings,
      intent: {
        kind: "interview",
        summary: `interview ${propertyPaths.join(", ")}`,
        propertyPaths,
        mutationJson: JSON.stringify({
          scope: input.scope,
          operations: input.input.operations,
        }),
        property: propertyPaths.join(","),
      },
    };
  };

function interviewDeps(
  cfg: ServerConfig,
  revisions?: RevisionStore,
): OmoTransactionDeps {
  return {
    cfg,
    revisions:
      revisions ??
      ({
        available: true,
        isScopeWriteBlocked: () => false,
        recoverPendingOmo: () => [],
      } as unknown as RevisionStore),
  };
}

function semanticsFromBundle(
  cfg: ServerConfig,
  bundle: ProvenanceBundle | undefined,
): InterviewSemantics | undefined {
  if (!bundle) return undefined;
  const st = buildInterviewState(
    bundle,
    cfg.projectDirectory,
    cfg.authorizedRoots,
    process.env,
    { cfg },
  );
  return { effective: st.effective, server: st.server, output: st.output };
}

/**
 * Typed-capability gate (fail-closed). Distinguishes installed-schema
 * unavailability (422, writes blocked environment-wide) from version/hash/
 * field-set skew (400 policy: typed writes closed for this installation).
 */
function typedGate(cfg: ServerConfig): {
  capability: InterviewTypedCapability;
  failure?: {
    code: OmoTransactionErrorCode;
    status: 400 | 422;
    errors: string[];
  };
} {
  const capability = resolveInterviewTypedCapability(cfg);
  if (capability.available) return { capability };
  const schema = loadInstalledSchema(schemaContextFor(cfg), cfg);
  if (!schema.available) {
    return {
      capability,
      failure: {
        code: "schema-unavailable",
        status: 422,
        errors: [
          "Installed OMO-Slim schema unavailable — typed Interview writes are fail-closed. No write performed.",
          capability.reason ?? schema.error,
        ],
      },
    };
  }
  return {
    capability,
    failure: {
      code: "policy",
      status: 400,
      errors: [
        `Interview typed writes unavailable for the installed oh-my-opencode-slim (${capability.reason ?? "typed capability closed"})`,
      ],
    },
  };
}

function gateFailurePreview(
  capability: InterviewTypedCapability,
  scope: OmoScope,
  failure: NonNullable<ReturnType<typeof typedGate>["failure"]>,
): InterviewPreviewResponse {
  return emptyPreview(capability, scope, failure.code, failure.errors);
}

function gateFailureCommit(
  capability: InterviewTypedCapability,
  scope: OmoScope,
  failure: NonNullable<ReturnType<typeof typedGate>["failure"]>,
): InterviewCommitResponse {
  const preview = emptyPreview(capability, scope, failure.code, failure.errors);
  return {
    ok: false,
    code: failure.code,
    status: failure.status,
    preview,
    errors: failure.errors,
    typedCapability: capability,
    restartRequired: true,
    runtimeAction: "none",
  };
}

/**
 * Preserve the client-supplied fingerprint generation/hash/format/existence
 * (and mtime when provided). The transaction reports stale 409; this
 * adapter must not replace load-time generation with the live watcher value.
 */
function resolveExpectedSource(
  deps: OmoTransactionDeps,
  m: InterviewMutation,
): SourceFingerprint {
  const live = fingerprintScope(deps, m.scope);
  if (m.expectedSource) return m.expectedSource;
  return expectedSourceFromHash(live, m.expectedSourceHash);
}

function rawRepairFor(
  code: OmoTransactionErrorCode,
  errors: string[],
): InterviewRawRepair | undefined {
  if (!RAW_REPAIR_CODES.has(code)) return undefined;
  const reason =
    code === "syntax-invalid" || code === "root-not-object"
      ? "Current OMO source is not parseable; repair it through raw configuration editing before typed Interview writes."
      : code === "schema-unavailable"
        ? "Installed OMO-Slim schema is unavailable; typed Interview writes are blocked until the schema authority is restored."
        : "Candidate rejected by the installed OMO-Slim schema because of unrelated existing issues; use raw configuration repair.";
  return { needed: true, reason: reason + ` First error: ${errors[0] ?? code}` };
}

function previewEnvelope(
  cfg: ServerConfig,
  capability: InterviewTypedCapability,
  preview: OmoTransactionPreviewInternal,
): InterviewPreviewResponse {
  const errors =
    preview.code === "stale-source"
      ? ["CONFIGURATION CHANGED EXTERNALLY — re-preview required"]
      : preview.errors;
  const result: InterviewPreviewResponse = {
    ok: preview.ok,
    canApply: preview.canApply,
    code: preview.code,
    source: preview.source,
    candidateSha256: preview.candidateSha256,
    target: preview.target,
    schemaValidation: preview.schemaValidation,
    semanticValidation: preview.semanticValidation,
    textDiff: preview.textDiff,
    sourceChanges: preview.sourceChanges,
    desiredChanges: preview.desiredChanges,
    effectiveChanges: preview.effectiveChanges,
    provenanceChanges: preview.provenanceChanges,
    truncation: preview.truncation,
    warnings: preview.warnings,
    errors,
    typedCapability: capability,
    restartRequired: true,
    runtimeAction: "none",
    interview: {
      before: semanticsFromBundle(cfg, preview.beforeBundle),
      after: semanticsFromBundle(cfg, preview.afterBundle),
    },
  };
  const rawRepair = preview.code ? rawRepairFor(preview.code, errors) : undefined;
  if (rawRepair) result.rawRepair = rawRepair;
  return result;
}

function emptyPreview(
  capability: InterviewTypedCapability,
  scope: OmoScope,
  code: OmoTransactionErrorCode,
  errors: string[],
): InterviewPreviewResponse {
  return {
    ok: false,
    canApply: false,
    code,
    source: {
      exists: false,
      sha256: null,
      format: "jsonc",
      mtimeMs: null,
      generation: 0,
    },
    target: {
      scope,
      path: "",
      format: "jsonc",
      exists: false,
      createOnApplyOnly: scope === "project",
    },
    semanticValidation: { ok: false, issues: [] },
    sourceChanges: [],
    desiredChanges: [],
    effectiveChanges: [],
    provenanceChanges: [],
    warnings: [],
    errors,
    typedCapability: capability,
    restartRequired: true,
    runtimeAction: "none",
  };
}

/** No-write simulation through the D1 transaction preview. */
export function simulateInterviewMutation(
  cfg: ServerConfig,
  m: InterviewMutation,
  revisions?: RevisionStore,
): InterviewPreviewResponse {
  const gate = typedGate(cfg);
  if (gate.failure) return gateFailurePreview(gate.capability, m.scope, gate.failure);
  const deps = interviewDeps(cfg, revisions);
  let expected: SourceFingerprint;
  try {
    expected = resolveExpectedSource(deps, m);
  } catch (e) {
    return emptyPreview(gate.capability, m.scope, "policy", [
      e instanceof Error ? e.message : String(e),
    ]);
  }
  const preview = previewOmoCandidate(
    deps,
    {
      scope: m.scope,
      expectedSource: expected,
      input: m,
    },
    produceInterviewCandidate,
  );
  return previewEnvelope(cfg, gate.capability, preview);
}

/**
 * Apply through the D1 transaction: preview once, then commit with the
 * preview candidate SHA (or the caller-supplied SHA, which must match or
 * the commit fails 409). The commit path independently rereads, reruns the
 * producer, reparses, revalidates against the installed schema, writes the
 * same-directory temp, rereads, and atomically renames with revision
 * journaling and recovery.
 */
export function applyInterviewMutation(
  cfg: ServerConfig,
  m: InterviewMutation,
  revisions: RevisionStore,
): InterviewCommitResponse {
  const gate = typedGate(cfg);
  if (gate.failure) return gateFailureCommit(gate.capability, m.scope, gate.failure);
  if (!m.expectedCandidateSha256) {
    return gateFailureCommit(gate.capability, m.scope, {
      code: "malformed",
      status: 400,
      errors: ["expectedCandidateSha256 is required to apply"],
    });
  }
  const deps = interviewDeps(cfg, revisions);
  let expected: SourceFingerprint;
  try {
    expected = resolveExpectedSource(deps, m);
  } catch (e) {
    return gateFailureCommit(gate.capability, m.scope, {
      code: "policy",
      status: 400,
      errors: [e instanceof Error ? e.message : String(e)],
    });
  }
  const commit = previewThenCommit(
    deps,
    {
      scope: m.scope,
      expectedSource: expected,
      input: m,
      expectedCandidateSha256: m.expectedCandidateSha256,
    },
    produceInterviewCandidate,
  );
  const preview = previewEnvelope(cfg, gate.capability, commit.preview);
  return {
    ok: commit.ok,
    code: commit.code,
    status: commit.status,
    preview,
    revisionId: commit.revisionId,
    source: commit.source,
    errors:
      commit.code === "stale-source"
        ? ["CONFIGURATION CHANGED EXTERNALLY — re-preview required"]
        : commit.errors,
    typedCapability: gate.capability,
    restartRequired: true,
    runtimeAction: "none",
    interview: preview.interview,
    rawRepair: preview.rawRepair,
  };
}
