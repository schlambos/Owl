/**
 * Interview config routes (Slice 18 D2).
 *
 * GET  /api/config/interview            — flat InterviewState (schema
 *                                         identity/typed capability/field
 *                                         metadata, Desired/Effective/
 *                                         provenance/raw scope state,
 *                                         fingerprints, restartRequired,
 *                                         runtimeAction "none").
 * POST /api/config/interview/simulate   — no-write transaction preview.
 * POST /api/config/interview/apply      — transaction commit (independent
 *                                         revalidation + revision).
 *
 * `GET /api/system/interview` remains untouched for compatibility. The
 * deps interface deliberately carries no lifecycle/runtime/model-probe
 * ports: Interview writes never trigger runtime reconciliation, restarts,
 * browser/server/port activity, or output-folder inspection.
 */

import type {
  InterviewField,
  InterviewMutationOperation,
  OmoTransactionErrorCode,
  ProvenanceBundle,
  SourceFingerprint,
} from "@omo/shared";
import type { ServerConfig } from "../config";
import { buildInterviewState } from "../omo/interview";
import { fingerprintAuthorizedSource } from "../omo-schema/fingerprint";
import {
  applyInterviewMutation,
  interviewHttpStatus,
  simulateInterviewMutation,
  type InterviewMutation,
} from "./interview";
import type { RevisionStore } from "./revisions";
import { ensureRecoveredOmoScope, requestByteLimitOk } from "./transaction";

export interface InterviewConfigRouteDeps {
  cfg: ServerConfig;
  revisions: RevisionStore;
  /** Read-only provenance loader (e.g. loadOmoSafe().provenance). */
  loadBundle: () => ProvenanceBundle;
  /** Monotonic authorized-source watcher generation. */
  sourceGeneration: () => number;
  env?: Record<string, string | undefined>;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function isFingerprint(v: unknown): v is SourceFingerprint {
  if (!v || typeof v !== "object") return false;
  const f = v as Record<string, unknown>;
  return (
    typeof f.exists === "boolean" &&
    (f.sha256 === null || typeof f.sha256 === "string") &&
    (f.format === "json" || f.format === "jsonc") &&
    (f.mtimeMs === null || typeof f.mtimeMs === "number") &&
    typeof f.generation === "number"
  );
}

/**
 * Structural body parsing. Semantic validation (exact fields, ranges,
 * uniqueness) is owned by the producer inside the transaction so every
 * caller gets identical gating.
 */
export function parseInterviewMutationBody(
  body: unknown,
): { ok: true; request: InterviewMutation } | { ok: false; errors: string[] } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: ["Body must be an object"] };
  }
  const b = body as Record<string, unknown>;
  if (b.scope !== "user" && b.scope !== "project") {
    return { ok: false, errors: ['scope must be "user" or "project"'] };
  }
  if (!Array.isArray(b.operations)) {
    return { ok: false, errors: ["operations must be an array"] };
  }
  const operations: InterviewMutationOperation[] = [];
  for (const raw of b.operations) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, errors: ["each operation must be an object"] };
    }
    const o = raw as Record<string, unknown>;
    if (o.op !== "set" && o.op !== "remove") {
      return { ok: false, errors: ['operation op must be "set" or "remove"'] };
    }
    if (typeof o.field !== "string") {
      return { ok: false, errors: ["operation field must be a string"] };
    }
    if (
      o.value !== undefined &&
      typeof o.value !== "number" &&
      typeof o.value !== "string" &&
      typeof o.value !== "boolean"
    ) {
      return {
        ok: false,
        errors: ["operation value must be number, string, or boolean"],
      };
    }
    operations.push({
      field: o.field as InterviewField,
      op: o.op,
      ...(o.value !== undefined ? { value: o.value } : {}),
    });
  }
  const expectedSource = isFingerprint(b.expectedSource)
    ? b.expectedSource
    : undefined;
  const expectedSourceHash =
    typeof b.expectedSourceHash === "string" ? b.expectedSourceHash : undefined;
  if (!expectedSource && !expectedSourceHash) {
    return {
      ok: false,
      errors: [
        "expectedSource must include exists, sha256, format, mtimeMs, and generation (or expectedSourceHash for legacy callers)",
      ],
    };
  }
  return {
    ok: true,
    request: {
      scope: b.scope,
      expectedSource,
      expectedSourceHash,
      operations,
      ...(typeof b.expectedCandidateSha256 === "string"
        ? { expectedCandidateSha256: b.expectedCandidateSha256 }
        : {}),
    },
  };
}

function errorPreview(
  scope: "user" | "project",
  code: OmoTransactionErrorCode,
  errors: string[],
): Record<string, unknown> {
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
    typedCapability: {
      available: false,
      installedFields: [],
      auditedFields: [],
    },
    restartRequired: true,
    runtimeAction: "none",
  };
}

function errorCommit(
  scope: "user" | "project",
  code: OmoTransactionErrorCode,
  errors: string[],
): Record<string, unknown> {
  const preview = errorPreview(scope, code, errors);
  return {
    ok: false,
    code,
    status: interviewHttpStatus(code),
    preview,
    errors,
    typedCapability: preview.typedCapability,
    restartRequired: true,
    runtimeAction: "none",
  };
}

/**
 * Handle the three /api/config/interview routes. Returns null when the
 * request does not match, so the caller can continue route dispatch.
 */
export async function handleInterviewConfigRoutes(
  deps: InterviewConfigRouteDeps,
  req: Request,
  url: URL,
): Promise<Response | null> {
  const { cfg } = deps;
  const isGet =
    url.pathname === "/api/config/interview" && req.method === "GET";
  const isSimulate =
    url.pathname === "/api/config/interview/simulate" &&
    req.method === "POST";
  const isApply =
    url.pathname === "/api/config/interview/apply" && req.method === "POST";
  if (!isGet && !isSimulate && !isApply) return null;

  if (isGet) {
    // Pending-revision recovery precedes scoped reads (D1 contract).
    ensureRecoveredOmoScope(
      { cfg, revisions: deps.revisions },
      "user",
    );
    ensureRecoveredOmoScope(
      { cfg, revisions: deps.revisions },
      "project",
    );
    const generation = deps.sourceGeneration();
    const bundle = deps.loadBundle();
    return jsonResponse(
      buildInterviewState(
        bundle,
        cfg.projectDirectory,
        cfg.authorizedRoots,
        deps.env ?? process.env,
        {
          cfg,
          fingerprints: {
            user: fingerprintAuthorizedSource(cfg, "user", generation),
            project: fingerprintAuthorizedSource(cfg, "project", generation),
          },
        },
      ),
    );
  }

  const text = await req.text();
  if (!requestByteLimitOk(text)) {
    return jsonResponse(errorPreview("user", "oversize", ["Request body exceeds limit"]), 413);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return jsonResponse(
      errorPreview("user", "malformed", ["Malformed JSON body"]),
      400,
    );
  }
  const parsed = parseInterviewMutationBody(body);
  if (!parsed.ok) {
    return jsonResponse(
      errorPreview("user", "malformed", parsed.errors),
      400,
    );
  }
  const request = parsed.request;

  if (isSimulate) {
    const result = simulateInterviewMutation(cfg, request, deps.revisions);
    return jsonResponse(result, result.ok ? 200 : interviewHttpStatus(result.code));
  }

  if (!request.expectedCandidateSha256) {
    return jsonResponse(
      errorCommit("user", "malformed", [
        "expectedCandidateSha256 is required to apply",
      ]),
      400,
    );
  }
  const result = applyInterviewMutation(cfg, request, deps.revisions);
  return jsonResponse(result, result.status);
}
