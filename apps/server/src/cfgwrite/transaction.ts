/**
 * Single physical writer for authoritative OMO user/project JSON/JSONC.
 *
 * Preview is fully in-memory. Apply independently rereads, reruns the
 * producer, reparses, revalidates, and only then writes same-directory
 * temp → reread → atomic rename. Prompt-file and OpenCode-bridge writes
 * remain outside this module.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  ConfigRevision,
  ConfigValidationResult,
  OmoCandidateProducer,
  OmoCandidateRequest,
  OmoFormat,
  OmoProducerResult,
  OmoRevisionRestoreRequest,
  OmoScope,
  OmoTransactionCommit,
  OmoTransactionErrorCode,
  OmoTransactionIntent,
  OmoTransactionPreview,
  ProvenanceBundle,
  SchemaValidationSummary,
  SourceFingerprint,
} from "@omo/shared";
import {
  MAX_OMO_CANDIDATE_BYTES,
  MAX_OMO_REQUEST_BYTES,
} from "@omo/shared";
import type { ServerConfig } from "../config";
import { resolveProvenance } from "../omo/provenance";
import {
  assertSchemaValidCandidate,
  schemaContextFor,
} from "../omo-schema/validator";
import { fingerprintAuthorizedSource } from "../omo-schema/fingerprint";
import {
  emptyConfigDocument,
  hashContent,
  parseOmoDocument,
} from "./jsonc-edit";
import { assertSafeWritePath, resolveWriteTarget } from "./paths";
import type { RevisionStore } from "./revisions";
import {
  boundChangeList,
  boundTextDiff,
  companionPolicy,
  companionPolicyForRepair,
  effectiveValueTree,
  jsonChanges,
  provenanceChanges,
} from "./candidate-diff";
import {
  loadInstalledSchema,
  publicSchemaCacheKey,
} from "../omo-schema/authority";

export interface OmoTransactionHooks {
  afterTempWrite?: (tmpPath: string, bytes: string) => void;
  beforeRename?: (tmpPath: string, targetPath: string) => void;
  afterRename?: (targetPath: string) => void;
  failMarkCommitted?: boolean;
}

export interface OmoTransactionDeps {
  cfg: ServerConfig;
  revisions: RevisionStore;
  sourceGeneration?: number;
  now?: () => Date;
  hooks?: OmoTransactionHooks;
}

export interface OmoTransactionPreviewInternal extends OmoTransactionPreview {
  beforeText: string;
  afterText?: string;
  beforeDocument?: Record<string, unknown>;
  afterDocument?: Record<string, unknown>;
  beforeBundle?: ProvenanceBundle;
  afterBundle?: ProvenanceBundle;
  intent?: OmoTransactionIntent;
  /** Format used to parse/reparse this candidate (may be jsonc for legacy .json). */
  parseFormat?: OmoFormat;
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf-8");
}

function newRevisionId(): string {
  return `rev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function emptyPreview(
  source: SourceFingerprint,
  target: OmoTransactionPreview["target"],
  errors: string[],
  code?: OmoTransactionErrorCode,
  extra: Partial<OmoTransactionPreviewInternal> = {},
): OmoTransactionPreviewInternal {
  return {
    ok: false,
    canApply: false,
    code,
    source,
    target,
    semanticValidation: { ok: false, issues: [] },
    sourceChanges: [],
    desiredChanges: [],
    effectiveChanges: [],
    provenanceChanges: [],
    warnings: extra.warnings ?? [],
    errors,
    beforeText: extra.beforeText ?? "",
    ...extra,
  };
}

function fingerprintsMatch(
  expected: SourceFingerprint,
  actual: SourceFingerprint,
): boolean {
  if (expected.exists !== actual.exists) return false;
  if (expected.format !== actual.format) return false;
  if (expected.generation !== actual.generation) return false;
  if (expected.sha256 === actual.sha256) return true;
  if (!expected.exists && !actual.exists) {
    const emptyHash = hashContent(emptyConfigDocument(actual.format));
    if (expected.sha256 === emptyHash && actual.sha256 === null) return true;
    if (expected.sha256 === null && actual.sha256 === null) return true;
    return false;
  }
  return false;
}

export function ensureRecoveredOmoScope(
  deps: OmoTransactionDeps,
  scope: OmoScope,
): void {
  if (!deps.revisions.available) return;
  deps.revisions.recoverPendingOmo(deps.cfg, scope);
}

export function fingerprintScope(
  deps: OmoTransactionDeps,
  scope: OmoScope,
): SourceFingerprint {
  ensureRecoveredOmoScope(deps, scope);
  return fingerprintAuthorizedSource(
    deps.cfg,
    scope,
    deps.sourceGeneration ?? 0,
  );
}

function parseExistingSource(
  text: string,
  format: OmoFormat,
): ReturnType<typeof parseOmoDocument> & { usedFormat: OmoFormat } {
  const primary = parseOmoDocument(text, format);
  if (primary.ok) return { ...primary, usedFormat: format };
  // Historical `.json` files may contain comments because prior writers
  // always used the JSONC parser. Read them as JSONC so structured
  // producers can still repair; the on-disk extension is unchanged.
  if (format === "json") {
    const fallback = parseOmoDocument(text, "jsonc");
    if (fallback.ok) return { ...fallback, usedFormat: "jsonc" };
  }
  return { ...primary, usedFormat: format };
}

function readScopeText(
  deps: OmoTransactionDeps,
  scope: OmoScope,
): {
  target: ReturnType<typeof resolveWriteTarget>;
  fingerprint: SourceFingerprint;
  text: string;
  exists: boolean;
} {
  ensureRecoveredOmoScope(deps, scope);
  const target = resolveWriteTarget(deps.cfg, scope);
  assertSafeWritePath(target.path, deps.cfg.authorizedRoots);
  const fingerprint = fingerprintAuthorizedSource(
    deps.cfg,
    scope,
    deps.sourceGeneration ?? 0,
  );
  if (!target.exists || !existsSync(target.path)) {
    return {
      target,
      fingerprint,
      text: emptyConfigDocument(target.format),
      exists: false,
    };
  }
  return {
    target,
    fingerprint,
    text: readFileSync(target.path, "utf-8"),
    exists: true,
  };
}

function virtualSourceFor(
  target: ReturnType<typeof resolveWriteTarget>,
  text: string,
  document: Record<string, unknown>,
  exists: boolean,
) {
  return {
    text,
    document,
    format: target.format,
    path: target.path,
    exists,
    hash: exists ? hashContent(text) : undefined,
  };
}

function resolveVirtual(
  deps: OmoTransactionDeps,
  scope: OmoScope,
  text: string,
  document: Record<string, unknown>,
  exists: boolean,
  target: ReturnType<typeof resolveWriteTarget>,
): ProvenanceBundle {
  const counterpart = scope === "user" ? "project" : "user";
  const other = readScopeText(deps, counterpart);
  const otherParsed = other.exists
    ? parseExistingSource(other.text, other.target.format)
    : parseOmoDocument(other.text, other.target.format);
  const otherDoc = otherParsed.ok ? otherParsed.document : {};
  return resolveProvenance({
    opencodeConfigDir: deps.cfg.opencodeConfigDir,
    projectDirectory: deps.cfg.projectDirectory,
    authorizedRoots: deps.cfg.authorizedRoots,
    includePromptText: false,
    virtualSources: {
      user:
        scope === "user"
          ? virtualSourceFor(target, text, document, exists)
          : virtualSourceFor(
              other.target,
              other.text,
              otherDoc,
              other.exists,
            ),
      project:
        scope === "project"
          ? virtualSourceFor(target, text, document, exists)
          : virtualSourceFor(
              other.target,
              other.text,
              otherDoc,
              other.exists,
            ),
    },
  });
}

function semanticFrom(
  featureErrors: string[],
  featureWarnings: string[],
): ConfigValidationResult {
  return {
    ok: featureErrors.length === 0,
    issues: [
      ...featureErrors.map((message) => ({
        level: "error" as const,
        code: "feature",
        message,
      })),
      ...featureWarnings.map((message) => ({
        level: "warning" as const,
        code: "feature",
        message,
      })),
    ],
  };
}

function previewFromProducer<T>(
  deps: OmoTransactionDeps,
  request: OmoCandidateRequest<T>,
  producer: OmoCandidateProducer<T>,
  opts: { requireCandidateSha?: boolean },
): OmoTransactionPreviewInternal {
  ensureRecoveredOmoScope(deps, request.scope);
  const target = resolveWriteTarget(deps.cfg, request.scope);
  const descriptor = {
    scope: request.scope,
    path: target.path,
    format: target.format,
    exists: target.exists,
    createOnApplyOnly: !target.exists && request.scope === "project",
  };

  if (!deps.revisions.available) {
    return emptyPreview(
      request.expectedSource,
      descriptor,
      ["revision store unavailable"],
      "recovery-pending",
    );
  }
  if (deps.revisions.isScopeWriteBlocked(deps.cfg, request.scope)) {
    return emptyPreview(
      fingerprintScope(deps, request.scope),
      descriptor,
      ["scope write blocked by pending or conflict revision"],
      "recovery-pending",
    );
  }

  let current: ReturnType<typeof readScopeText>;
  try {
    current = readScopeText(deps, request.scope);
  } catch (e) {
    return emptyPreview(
      request.expectedSource,
      descriptor,
      [e instanceof Error ? e.message : String(e)],
      "policy",
    );
  }
  if (!fingerprintsMatch(request.expectedSource, current.fingerprint)) {
    return emptyPreview(
      current.fingerprint,
      descriptor,
      ["CONFIGURATION CHANGED EXTERNALLY — re-preview required"],
      "stale-source",
      { beforeText: current.text },
    );
  }

  if (request.expectedSchemaCacheKey) {
    const schema = loadInstalledSchema(schemaContextFor(deps.cfg), deps.cfg);
    const liveKey = schema.available
      ? schema.cacheKey
      : schema.cacheKey ??
        (schema.schemaHash
          ? publicSchemaCacheKey(schema.packageVersion, schema.schemaHash)
          : undefined);
    if (!schema.available || liveKey !== request.expectedSchemaCacheKey) {
      return emptyPreview(
        current.fingerprint,
        descriptor,
        [
          schema.available
            ? "Installed schema cache key changed — re-preview required"
            : "Installed OMO-Slim schema unavailable — simulate/apply are fail-closed",
        ],
        schema.available ? "stale-source" : "schema-unavailable",
        { beforeText: current.text },
      );
    }
  }

  const beforeParsed = current.exists
    ? parseExistingSource(current.text, current.target.format)
    : parseOmoDocument(current.text, current.target.format);
  const candidateFormat: OmoFormat =
    beforeParsed.ok && "usedFormat" in beforeParsed
      ? (beforeParsed.usedFormat as OmoFormat)
      : current.target.format;
  const invalidCurrentRepair = !beforeParsed.ok && !!request.allowInvalidCurrent;
  if (!beforeParsed.ok && !invalidCurrentRepair) {
    // Invalid current source: structured producers need an object. Surface
    // syntax so a later raw repair candidate can still be applied.
    if (current.exists) {
      return emptyPreview(
        current.fingerprint,
        descriptor,
        [beforeParsed.issue.message],
        beforeParsed.issue.code,
        { beforeText: current.text },
      );
    }
  }
  const beforeDocument = beforeParsed.ok ? beforeParsed.document : {};

  let produced: OmoProducerResult;
  try {
    produced = producer({
      scope: request.scope,
      beforeText: current.text,
      beforeDocument,
      format: current.target.format,
      source: current.fingerprint,
      input: request.input,
    });
  } catch (e) {
    return emptyPreview(
      current.fingerprint,
      descriptor,
      [e instanceof Error ? e.message : String(e)],
      "malformed",
      { beforeText: current.text },
    );
  }

  if (produced.featureErrors.length) {
    return emptyPreview(
      current.fingerprint,
      descriptor,
      produced.featureErrors,
      "policy",
      {
        beforeText: current.text,
        warnings: produced.featureWarnings,
        semanticValidation: semanticFrom(
          produced.featureErrors,
          produced.featureWarnings,
        ),
        intent: produced.intent,
      },
    );
  }

  const candidateBytes = utf8Bytes(produced.candidateText);
  if (candidateBytes > MAX_OMO_CANDIDATE_BYTES) {
    return emptyPreview(
      current.fingerprint,
      descriptor,
      [`Candidate exceeds ${MAX_OMO_CANDIDATE_BYTES} bytes`],
      "oversize",
      { beforeText: current.text, afterText: produced.candidateText },
    );
  }

  const candidateParse = request.candidateParse ?? "source-compatible";
  const afterFormat: OmoFormat =
    candidateParse === "target-extension"
      ? current.target.format
      : candidateFormat;
  const afterParsed = parseOmoDocument(produced.candidateText, afterFormat);
  if (!afterParsed.ok) {
    return emptyPreview(
      current.fingerprint,
      descriptor,
      [afterParsed.issue.message],
      afterParsed.issue.code,
      {
        beforeText: current.text,
        afterText: produced.candidateText,
        warnings: produced.featureWarnings,
      },
    );
  }

  const companion = invalidCurrentRepair
    ? companionPolicyForRepair(current.text, afterParsed.document)
    : companionPolicy(beforeDocument, afterParsed.document);
  if (!companion.ok) {
    return emptyPreview(
      current.fingerprint,
      descriptor,
      [
        `companion-read-only: ${companion.changedPaths.join(", ")}`,
      ],
      "companion-read-only",
      {
        beforeText: current.text,
        afterText: produced.candidateText,
        afterDocument: afterParsed.document,
        warnings: produced.featureWarnings,
      },
    );
  }

  const schemaValidation = assertSchemaValidCandidate(
    produced.candidateText,
    schemaContextFor(deps.cfg),
  );
  if (!schemaValidation.ok) {
    const schemaErrors = schemaValidation.issues.map(
      (i) => `Schema: ${i.path ? `${i.path}: ` : ""}${i.message}`,
    );
    return emptyPreview(
      current.fingerprint,
      descriptor,
      schemaErrors,
      schemaValidation.unavailable ? "schema-unavailable" : "schema-invalid",
      {
        beforeText: current.text,
        afterText: produced.candidateText,
        afterDocument: afterParsed.document,
        schemaValidation,
        warnings: produced.featureWarnings,
        semanticValidation: semanticFrom(
          produced.featureErrors,
          produced.featureWarnings,
        ),
      },
    );
  }

  const beforeBundle = resolveVirtual(
    deps,
    request.scope,
    current.text,
    beforeDocument,
    current.exists,
    current.target,
  );
  const afterBundle = resolveVirtual(
    deps,
    request.scope,
    produced.candidateText,
    afterParsed.document,
    true,
    current.target,
  );

  const sourceBound = boundChangeList(
    jsonChanges(beforeDocument, afterParsed.document),
  );
  const desiredBound = boundChangeList(
    jsonChanges(beforeBundle.rawMerged, afterBundle.rawMerged),
  );
  const effectiveBound = boundChangeList(
    jsonChanges(effectiveValueTree(beforeBundle), effectiveValueTree(afterBundle)),
  );
  const provenanceBound = boundChangeList(
    provenanceChanges(beforeBundle.properties, afterBundle.properties),
  );
  const truncation = sourceBound.truncation ??
    desiredBound.truncation ??
    effectiveBound.truncation ??
    provenanceBound.truncation;

  const textDiff = boundTextDiff(
    current.text,
    produced.candidateText,
    basename(current.target.path),
  );
  const candidateSha256 = hashContent(produced.candidateText);
  if (
    opts.requireCandidateSha &&
    request.expectedCandidateSha256 !== candidateSha256
  ) {
    return emptyPreview(
      current.fingerprint,
      descriptor,
      ["Preview candidate hash does not match current producer output"],
      "stale-source",
      {
        beforeText: current.text,
        afterText: produced.candidateText,
        candidateSha256,
        schemaValidation,
      },
    );
  }

  const semanticValidation = semanticFrom(
    produced.featureErrors,
    produced.featureWarnings,
  );
  const noOp =
    current.exists && current.text === produced.candidateText;
  if (noOp) {
    return {
      ok: false,
      canApply: false,
      code: "no-op",
      source: current.fingerprint,
      candidateSha256,
      target: descriptor,
      schemaValidation,
      semanticValidation,
      textDiff,
      sourceChanges: sourceBound.items,
      desiredChanges: desiredBound.items,
      effectiveChanges: effectiveBound.items,
      provenanceChanges: provenanceBound.items,
      truncation,
      warnings: produced.featureWarnings,
      errors: ["No changes"],
      beforeText: current.text,
      afterText: produced.candidateText,
      beforeDocument,
      afterDocument: afterParsed.document,
      beforeBundle,
      afterBundle,
      intent: produced.intent,
      parseFormat: afterFormat,
    };
  }

  return {
    ok: true,
    canApply: true,
    source: current.fingerprint,
    candidateSha256,
    target: descriptor,
    schemaValidation,
    semanticValidation,
    textDiff,
    sourceChanges: sourceBound.items,
    desiredChanges: desiredBound.items,
    effectiveChanges: effectiveBound.items,
    provenanceChanges: provenanceBound.items,
    truncation,
      warnings: produced.featureWarnings,
      errors: [],
      beforeText: current.text,
      afterText: produced.candidateText,
      beforeDocument,
      afterDocument: afterParsed.document,
      beforeBundle,
    afterBundle,
    intent: produced.intent,
    parseFormat: afterFormat,
  };
}

export function previewOmoCandidate<T>(
  deps: OmoTransactionDeps,
  request: OmoCandidateRequest<T>,
  producer: OmoCandidateProducer<T>,
): OmoTransactionPreviewInternal {
  return previewFromProducer(deps, request, producer, {
    requireCandidateSha: false,
  });
}

function commitStatus(
  preview: OmoTransactionPreviewInternal,
): OmoTransactionCommit["status"] {
  switch (preview.code) {
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

function physicalCommit(
  deps: OmoTransactionDeps,
  preview: OmoTransactionPreviewInternal,
  requestScope: OmoScope,
  intent: { kind: string; summary: string; mutationJson: string; agent?: string; property?: string },
): OmoTransactionCommitInternal {
  if (!preview.ok || !preview.canApply || !preview.afterText || !preview.candidateSha256) {
    return {
      ok: false,
      code: preview.code,
      status: commitStatus(preview),
      preview,
      errors: preview.errors,
    };
  }

  const target = resolveWriteTarget(deps.cfg, requestScope);
  const targetPath = assertSafeWritePath(target.path, deps.cfg.authorizedRoots);
  const format: OmoFormat = preview.parseFormat ?? target.format;
  const beforeExists = target.exists && existsSync(targetPath);
  const schema = preview.schemaValidation;

  const revision: ConfigRevision = {
    id: newRevisionId(),
    timestamp: (deps.now?.() ?? new Date()).toISOString(),
    targetPath,
    scope: requestScope,
    oldHash: beforeExists ? hashContent(preview.beforeText) : hashContent(preview.beforeText),
    newHash: preview.candidateSha256,
    mutationKind: intent.kind,
    agent: intent.agent,
    property: intent.property,
    mutationJson: intent.mutationJson,
    beforeContent: preview.beforeText,
    afterContent: preview.afterText,
    note: intent.summary,
    state: "pending",
    preparedAt: (deps.now?.() ?? new Date()).toISOString(),
    beforeExists,
    afterExists: true,
    targetFormat: format,
    schemaPackageVersion: schema?.packageVersion,
    schemaHash: schema?.schemaHash,
  };

  try {
    deps.revisions.preparePending(revision);
  } catch (e) {
    return {
      ok: false,
      code: "recovery-pending",
      status: 503,
      preview,
      errors: [
        e instanceof Error ? e.message : "failed to prepare pending revision",
      ],
    };
  }

  const tmp = join(
    dirname(targetPath),
    `.${basename(targetPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    if (!beforeExists) {
      mkdirSync(dirname(targetPath), { recursive: true });
    }
    assertSafeWritePath(tmp, deps.cfg.authorizedRoots);
    writeFileSync(tmp, preview.afterText, "utf-8");
    deps.hooks?.afterTempWrite?.(tmp, preview.afterText);
    const tmpRead = readFileSync(tmp, "utf-8");
    if (tmpRead !== preview.afterText) {
      try {
        unlinkSync(tmp);
      } catch {
        /* */
      }
      deps.revisions.markAbandoned(revision.id, "temp reread mismatch");
      return {
        ok: false,
        code: "policy",
        status: 400,
        preview,
        errors: ["Temp file verification failed"],
      };
    }
    const tmpParsed = parseOmoDocument(tmpRead, format);
    if (!tmpParsed.ok) {
      try {
        unlinkSync(tmp);
      } catch {
        /* */
      }
      deps.revisions.markAbandoned(revision.id, "temp parse failed");
      return {
        ok: false,
        code: tmpParsed.issue.code,
        status: 422,
        preview,
        errors: [tmpParsed.issue.message],
      };
    }
    const tmpValidation = assertSchemaValidCandidate(
      tmpRead,
      schemaContextFor(deps.cfg),
    );
    if (!tmpValidation.ok) {
      try {
        unlinkSync(tmp);
      } catch {
        /* */
      }
      deps.revisions.markAbandoned(revision.id, "temp schema invalid");
      return {
        ok: false,
        code: tmpValidation.unavailable ? "schema-unavailable" : "schema-invalid",
        status: 422,
        preview: { ...preview, schemaValidation: tmpValidation },
        errors: [
          "Installed OMO-Slim schema gate failed on candidate verification. No write performed.",
          ...tmpValidation.issues.map(
            (i) => `Schema: ${i.path ? `${i.path}: ` : ""}${i.message}`,
          ),
        ],
      };
    }
    deps.hooks?.beforeRename?.(tmp, targetPath);
    renameSync(tmp, targetPath);
    let renamed = true;
    try {
      deps.hooks?.afterRename?.(targetPath);
      const finalText = readFileSync(targetPath, "utf-8");
      const newHash = hashContent(finalText);
      if (finalText !== preview.afterText) {
        return {
          ok: false,
          code: "recovery-pending",
          status: 503,
          preview,
          revisionId: revision.id,
          errors: ["Post-rename content mismatch"],
        };
      }
      if (deps.hooks?.failMarkCommitted) {
        return {
          ok: false,
          code: "recovery-pending",
          status: 503,
          preview,
          revisionId: revision.id,
          errors: ["revision-finalization failed; recovery-pending"],
        };
      }
      try {
        deps.revisions.markCommitted(revision.id);
      } catch {
        return {
          ok: false,
          code: "recovery-pending",
          status: 503,
          preview,
          revisionId: revision.id,
          errors: ["revision-finalization failed; recovery-pending"],
        };
      }
      const st = statSync(targetPath);
      return {
        ok: true,
        status: 200,
        preview,
        revisionId: revision.id,
        source: {
          exists: true,
          sha256: newHash,
          format,
          mtimeMs: st.mtimeMs,
          generation: deps.sourceGeneration ?? 0,
        },
        errors: [],
      };
    } catch (e) {
      if (renamed) {
        return {
          ok: false,
          code: "recovery-pending",
          status: 503,
          preview,
          revisionId: revision.id,
          errors: [
            e instanceof Error
              ? `revision-finalization failed; recovery-pending: ${e.message}`
              : "revision-finalization failed; recovery-pending",
          ],
        };
      }
      throw e;
    }
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* */
    }
    try {
      deps.revisions.markAbandoned(
        revision.id,
        e instanceof Error ? e.message : String(e),
      );
    } catch {
      /* */
    }
    return {
      ok: false,
      code: "policy",
      status: 400,
      preview,
      errors: [e instanceof Error ? e.message : String(e)],
    };
  }
}

export interface OmoTransactionCommitInternal extends OmoTransactionCommit {
  preview: OmoTransactionPreviewInternal;
}

export function commitOmoCandidate<T>(
  deps: OmoTransactionDeps,
  request: OmoCandidateRequest<T>,
  producer: OmoCandidateProducer<T>,
): OmoTransactionCommitInternal {
  if (!request.expectedCandidateSha256) {
    const target = resolveWriteTarget(deps.cfg, request.scope);
    const preview = emptyPreview(
      request.expectedSource,
      {
        scope: request.scope,
        path: target.path,
        format: target.format,
        exists: target.exists,
        createOnApplyOnly: !target.exists && request.scope === "project",
      },
      ["expectedCandidateSha256 is required to commit"],
      "stale-source",
    );
    return {
      ok: false,
      code: "stale-source",
      status: 409,
      preview,
      errors: preview.errors,
    };
  }
  const preview = previewFromProducer(deps, request, producer, {
    requireCandidateSha: true,
  });
  if (!preview.ok) {
    return {
      ok: false,
      code: preview.code,
      status: commitStatus(preview),
      preview,
      errors: preview.errors,
    };
  }
  const intent = preview.intent ?? {
    kind: "unknown",
    summary: "OMO candidate",
    propertyPaths: [],
    mutationJson: "{}",
  };
  return physicalCommit(deps, preview, request.scope, {
    kind: intent.kind,
    summary: intent.summary,
    mutationJson: intent.mutationJson,
    agent: intent.agent,
    property: intent.property,
  });
}

function restoreProducer(
  revision: ConfigRevision,
): OmoCandidateProducer<{ revisionId: string }> {
  return () => ({
    candidateText: revision.beforeContent,
    featureErrors: [],
    featureWarnings: [],
    intent: {
      kind: "restore",
      summary: `Restore of ${revision.id}`,
      propertyPaths: [],
      mutationJson: JSON.stringify({
        kind: "restore",
        restoredFrom: revision.id,
      }),
      agent: revision.agent,
      property: revision.property,
    },
  });
}

export function previewOmoRevisionRestore(
  deps: OmoTransactionDeps,
  request: OmoRevisionRestoreRequest,
): OmoTransactionPreviewInternal {
  ensureRecoveredOmoScope(deps, request.scope);
  const target = resolveWriteTarget(deps.cfg, request.scope);
  const descriptor = {
    scope: request.scope,
    path: target.path,
    format: target.format,
    exists: target.exists,
    createOnApplyOnly: false,
  };
  const rev = deps.revisions.get(request.revisionId);
  if (!rev) {
    return emptyPreview(
      request.expectedSource,
      descriptor,
      [`Revision not found: ${request.revisionId}`],
      "malformed",
    );
  }
  if (!deps.revisions.isOmoRevisionTarget(deps.cfg, rev)) {
    return emptyPreview(
      request.expectedSource,
      descriptor,
      ["revision-domain-mismatch"],
      "revision-domain-mismatch",
    );
  }
  const schema = assertSchemaValidCandidate(
    rev.beforeContent || "{}",
    schemaContextFor(deps.cfg),
  );
  if (!deps.revisions.isRestoreEligible(rev, schema.ok)) {
    return emptyPreview(
      request.expectedSource,
      descriptor,
      schema.ok
        ? ["Revision is not restore-eligible"]
        : [
            "Revision was valid/recorded under older state but is incompatible with the current installed OMO-Slim schema.",
            ...schema.issues.map(
              (i) => `Schema: ${i.path ? `${i.path}: ` : ""}${i.message}`,
            ),
          ],
      schema.ok ? "policy" : "schema-invalid",
      { schemaValidation: schema },
    );
  }
  return previewFromProducer(
    deps,
    {
      scope: request.scope,
      expectedSource: request.expectedSource,
      input: { revisionId: request.revisionId },
      expectedCandidateSha256: request.expectedCandidateSha256,
    },
    restoreProducer(rev),
    { requireCandidateSha: false },
  );
}

export function commitOmoRevisionRestore(
  deps: OmoTransactionDeps,
  request: OmoRevisionRestoreRequest,
): OmoTransactionCommitInternal {
  ensureRecoveredOmoScope(deps, request.scope);
  if (!request.expectedCandidateSha256) {
    const target = resolveWriteTarget(deps.cfg, request.scope);
    const preview = emptyPreview(
      request.expectedSource,
      {
        scope: request.scope,
        path: target.path,
        format: target.format,
        exists: target.exists,
        createOnApplyOnly: false,
      },
      ["expectedCandidateSha256 is required to restore"],
      "stale-source",
    );
    return {
      ok: false,
      code: "stale-source",
      status: 409,
      preview,
      errors: preview.errors,
    };
  }
  const preview = previewOmoRevisionRestore(deps, request);
  if (!preview.ok) {
    return {
      ok: false,
      code: preview.code,
      status: commitStatus(preview),
      preview,
      errors: preview.errors,
    };
  }
  if (request.expectedCandidateSha256 !== preview.candidateSha256) {
    return {
      ok: false,
      code: "stale-source",
      status: 409,
      preview,
      errors: ["Preview candidate hash does not match current restore output"],
    };
  }
  const rev = deps.revisions.get(request.revisionId)!;
  return physicalCommit(deps, preview, request.scope, {
    kind: "restore",
    summary: `Restore of ${request.revisionId}`,
    mutationJson: JSON.stringify({
      kind: "restore",
      restoredFrom: request.revisionId,
    }),
    agent: rev.agent,
    property: rev.property,
  });
}

export function expectedSourceFromHash(
  live: SourceFingerprint,
  expectedSourceHash?: string,
): SourceFingerprint {
  if (!expectedSourceHash) return live;
  return { ...live, sha256: expectedSourceHash };
}

/** Preview once so legacy adapters can supply the required commit SHA. */
export function previewThenCommit<T>(
  deps: OmoTransactionDeps,
  request: Omit<OmoCandidateRequest<T>, "expectedCandidateSha256"> & {
    expectedCandidateSha256?: string;
  },
  producer: OmoCandidateProducer<T>,
): OmoTransactionCommitInternal {
  const preview = previewOmoCandidate(
    deps,
    request as OmoCandidateRequest<T>,
    producer,
  );
  if (!preview.ok || !preview.candidateSha256) {
    return {
      ok: false,
      code: preview.code,
      status: commitStatus(preview),
      preview,
      errors: preview.errors,
    };
  }
  return commitOmoCandidate(
    deps,
    {
      ...request,
      expectedCandidateSha256:
        request.expectedCandidateSha256 ?? preview.candidateSha256,
    },
    producer,
  );
}

export function requestByteLimitOk(text: string): boolean {
  return utf8Bytes(text) <= MAX_OMO_REQUEST_BYTES;
}

export type { SchemaValidationSummary };
