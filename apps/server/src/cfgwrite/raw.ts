/**
 * Raw OMO source load / compare / simulate / apply (Slice 18 D3).
 *
 * Client requests carry only logical `sourceId` (`user-omo` | `project-omo`).
 * Physical writes go exclusively through the D1 transaction. Candidate text
 * is preserved byte-for-byte; `.json` candidates parse with
 * `candidateParse:"target-extension"`.
 */

import type {
  BoundedTextDiff,
  OmoFormat,
  OmoProducerResult,
  OmoRevisionDetail,
  OmoRevisionListItem,
  OmoScope,
  OmoTransactionErrorCode,
  RawCommitResponse,
  RawCompareResponse,
  RawCrossLink,
  RawPreviewResponse,
  RawSchemaIdentity,
  RawSemanticSummaries,
  RawSourceDiagnostic,
  RawSourceLoadResponse,
  RawOmoSourceId,
  SchemaValidationSummary,
  SourceFingerprint,
} from "@omo/shared";
import {
  MAX_OMO_CANDIDATE_BYTES,
  MISSING_PROJECT_EDITOR_TEXT,
  RAW_LIVE_UNCHANGED_NOTE,
  RAW_OMO_MUTATION_KIND,
  scopeToSourceId,
  sourceIdToScope,
} from "@omo/shared";
import type { ServerConfig } from "../config";
import {
  loadInstalledSchema,
  publicSchemaCacheKey,
  schemaGenerationFor,
} from "../omo-schema/authority";
import { fingerprintAuthorizedSource } from "../omo-schema/fingerprint";
import {
  assertSchemaValidCandidate,
  schemaContextFor,
} from "../omo-schema/validator";
import { resolveWriteTarget } from "./paths";
import {
  boundTextDiff,
  jsonChanges,
  rawSemanticSummaries,
} from "./candidate-diff";
import {
  emptyConfigDocument,
  parseOmoDocument,
} from "./jsonc-edit";
import type { RevisionStore } from "./revisions";
import {
  commitOmoRevisionRestore,
  ensureRecoveredOmoScope,
  previewOmoCandidate,
  previewOmoRevisionRestore,
  previewThenCommit,
  type OmoTransactionDeps,
  type OmoTransactionPreviewInternal,
} from "./transaction";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

export interface RawMutation {
  sourceId: RawOmoSourceId;
  expectedSource: SourceFingerprint;
  candidateText: string;
  expectedSchemaCacheKey?: string;
  expectedCandidateSha256?: string;
}

export function rawHttpStatus(
  code?: OmoTransactionErrorCode,
): RawCommitResponse["status"] {
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

export function schemaIdentityFor(cfg: ServerConfig): RawSchemaIdentity {
  const snap = loadInstalledSchema(schemaContextFor(cfg), cfg);
  if (!snap.available) {
    const cacheKey =
      snap.cacheKey ??
      (snap.schemaHash
        ? publicSchemaCacheKey(snap.packageVersion, snap.schemaHash)
        : undefined);
    return {
      available: false,
      packageVersion: snap.packageVersion,
      schemaHash: snap.schemaHash,
      cacheKey,
      schemaGeneration: cacheKey ? schemaGenerationFor(cacheKey) : undefined,
      error: snap.error,
    };
  }
  return {
    available: true,
    packageVersion: snap.packageVersion,
    schemaHash: snap.schemaHash,
    cacheKey: snap.cacheKey,
    schemaGeneration: schemaGenerationFor(snap.cacheKey),
  };
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf-8");
}

function emptySummaries(): RawSemanticSummaries {
  return {
    capabilities: { changed: false, notes: [] },
    prompts: { changed: false, notes: [] },
    presets: { changed: false, notes: [] },
    council: { changed: false, notes: [] },
    acp: { changed: false, notes: [] },
    interview: { changed: false, notes: [] },
    customAgents: { changed: false, notes: [] },
  };
}

function syntaxDiagnostics(
  text: string,
  format: OmoFormat,
): { ok: boolean; issues: RawSourceDiagnostic[] } {
  const parsed = parseOmoDocument(text, format);
  if (parsed.ok) return { ok: true, issues: [] };
  return {
    ok: false,
    issues: [
      {
        path: parsed.issue.path,
        keyword: parsed.issue.code,
        message: parsed.issue.message,
        offset: parsed.issue.offset,
        length: parsed.issue.length,
      },
    ],
  };
}

function rawDeps(
  cfg: ServerConfig,
  revisions?: RevisionStore,
  sourceGeneration = 0,
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
    sourceGeneration,
  };
}

export function produceRawCandidate(input: {
  scope: OmoScope;
  beforeText: string;
  format: OmoFormat;
  input: { candidateText: string };
}): OmoProducerResult {
  return {
    candidateText: input.input.candidateText,
    featureErrors: [],
    featureWarnings: [],
    intent: {
      kind: RAW_OMO_MUTATION_KIND,
      summary: RAW_OMO_MUTATION_KIND,
      propertyPaths: [],
      mutationJson: JSON.stringify({
        kind: RAW_OMO_MUTATION_KIND,
        sourceId: scopeToSourceId(input.scope),
        format: input.format,
      }),
      property: scopeToSourceId(input.scope),
    },
  };
}

function crossLinksFor(
  sourceId: RawOmoSourceId,
  preview: OmoTransactionPreviewInternal,
): RawCrossLink[] {
  const links: RawCrossLink[] = [];
  const seen = new Set<string>();
  const consider = (path: string) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    let href = `/config?tab=raw&sourceId=${sourceId}&path=${encodeURIComponent(path)}`;
    let kind = "raw";
    let label = `Open ${path} in Raw`;
    if (path.startsWith("interview.")) {
      kind = "interview";
      label = `Interview ${path}`;
    } else if (path.startsWith("council.")) {
      kind = "council";
      href = "/council";
      label = "Open Council";
    } else if (path.startsWith("acpAgents.")) {
      kind = "acp";
      href = "/acp";
      label = "Open ACP";
    } else if (path === "preset" || path.startsWith("presets.")) {
      kind = "presets";
      href = "/presets";
      label = "Open Presets";
    }
    links.push({ kind, href, label, path });
  };
  for (const c of preview.sourceChanges.slice(0, 12)) consider(c.path);
  for (const c of preview.effectiveChanges.slice(0, 12)) consider(c.path);
  return links.slice(0, 16);
}

export function rawPreviewEnvelope(
  cfg: ServerConfig,
  sourceId: RawOmoSourceId,
  preview: OmoTransactionPreviewInternal,
): RawPreviewResponse {
  const schema = schemaIdentityFor(cfg);
  const errors =
    preview.code === "stale-source"
      ? ["CONFIGURATION CHANGED EXTERNALLY — re-preview required"]
      : preview.errors;
  const summaries =
    preview.beforeBundle && preview.afterBundle
      ? rawSemanticSummaries(preview.beforeBundle, preview.afterBundle)
      : emptySummaries();
  return {
    ok: preview.ok,
    canApply: preview.canApply && schema.available,
    code: preview.code,
    sourceId,
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
    schemaCacheKey: schema.cacheKey,
    schemaGeneration: schema.schemaGeneration,
    liveUnchangedNote: RAW_LIVE_UNCHANGED_NOTE,
    semanticSummaries: summaries,
    crossLinks: crossLinksFor(sourceId, preview),
  };
}

function emptyRawPreview(
  cfg: ServerConfig,
  sourceId: RawOmoSourceId,
  code: OmoTransactionErrorCode,
  errors: string[],
  source?: SourceFingerprint,
): RawPreviewResponse {
  const schema = schemaIdentityFor(cfg);
  const scope = sourceIdToScope(sourceId);
  const target = resolveWriteTarget(cfg, scope);
  return {
    ok: false,
    canApply: false,
    code,
    sourceId,
    source: source ?? {
      exists: false,
      sha256: null,
      format: target.format,
      mtimeMs: null,
      generation: 0,
    },
    target: {
      scope,
      path: target.path,
      format: target.format,
      exists: target.exists,
      createOnApplyOnly: !target.exists && scope === "project",
    },
    semanticValidation: { ok: false, issues: [] },
    sourceChanges: [],
    desiredChanges: [],
    effectiveChanges: [],
    provenanceChanges: [],
    warnings: [],
    errors,
    schemaCacheKey: schema.cacheKey,
    schemaGeneration: schema.schemaGeneration,
    liveUnchangedNote: RAW_LIVE_UNCHANGED_NOTE,
    semanticSummaries: emptySummaries(),
  };
}

export function loadRawSource(
  cfg: ServerConfig,
  sourceId: RawOmoSourceId,
  revisions?: RevisionStore,
  sourceGeneration = 0,
): RawSourceLoadResponse {
  const scope = sourceIdToScope(sourceId);
  const deps = rawDeps(cfg, revisions, sourceGeneration);
  ensureRecoveredOmoScope(deps, scope);
  const target = resolveWriteTarget(cfg, scope);
  const schema = schemaIdentityFor(cfg);
  const fingerprint = fingerprintAuthorizedSource(cfg, scope, sourceGeneration);
  const createOnApplyOnly = !target.exists && scope === "project";

  if (!target.exists || !existsSync(target.path)) {
    const text =
      scope === "project"
        ? MISSING_PROJECT_EDITOR_TEXT
        : emptyConfigDocument(target.format);
    return {
      ok: true,
      sourceId,
      scope,
      exists: false,
      format: target.format,
      createOnApplyOnly,
      path: target.path,
      fingerprint,
      text,
      byteLength: utf8Bytes(text),
      syntax: { ok: true, issues: [] },
      schemaValidation: schema.available
        ? assertSchemaValidCandidate(text, schemaContextFor(cfg))
        : undefined,
      schema,
      effectiveResolutionAvailable: schema.available,
      writeCapability: schema.available ? "open" : "closed",
      errors: schema.available
        ? []
        : [
            "Installed OMO-Slim schema unavailable — simulate/apply are fail-closed. Reads continue.",
          ],
    };
  }

  const text = readFileSync(target.path, "utf-8");
  const bytes = utf8Bytes(text);
  if (bytes > MAX_OMO_CANDIDATE_BYTES) {
    return {
      ok: false,
      sourceId,
      scope,
      exists: true,
      format: target.format,
      createOnApplyOnly: false,
      path: target.path,
      fingerprint,
      text: "",
      byteLength: bytes,
      syntax: { ok: false, issues: [] },
      schema,
      effectiveResolutionAvailable: false,
      writeCapability: "closed",
      code: "oversize",
      errors: [`Current source exceeds ${MAX_OMO_CANDIDATE_BYTES} bytes`],
    };
  }

  const syntax = syntaxDiagnostics(text, target.format);
  let schemaValidation: SchemaValidationSummary | undefined;
  if (syntax.ok && schema.available) {
    schemaValidation = assertSchemaValidCandidate(text, schemaContextFor(cfg));
  } else if (schema.available) {
    schemaValidation = {
      ok: false,
      packageVersion: schema.packageVersion,
      schemaHash: schema.schemaHash,
      issues: syntax.issues.map((i) => ({
        path: i.path,
        keyword: i.keyword,
        message: i.message,
      })),
    };
  }

  return {
    ok: true,
    sourceId,
    scope,
    exists: true,
    format: target.format,
    createOnApplyOnly: false,
    path: target.path,
    fingerprint,
    text,
    byteLength: bytes,
    syntax,
    schemaValidation,
    schema,
    effectiveResolutionAvailable: syntax.ok && schema.available,
    writeCapability: schema.available ? "open" : "closed",
    errors: schema.available
      ? []
      : [
          "Installed OMO-Slim schema unavailable — simulate/apply are fail-closed. Reads continue.",
        ],
  };
}

export function compareRawSource(
  cfg: ServerConfig,
  sourceId: RawOmoSourceId,
  draftText: string,
  revisions?: RevisionStore,
  sourceGeneration = 0,
): RawCompareResponse {
  const load = loadRawSource(cfg, sourceId, revisions, sourceGeneration);
  if (load.code === "oversize") {
    return {
      ok: false,
      sourceId,
      fingerprint: load.fingerprint,
      currentText: "",
      errors: load.errors,
      code: "oversize",
    };
  }
  if (utf8Bytes(draftText) > MAX_OMO_CANDIDATE_BYTES) {
    return {
      ok: false,
      sourceId,
      fingerprint: load.fingerprint,
      currentText: load.text,
      errors: [`Draft exceeds ${MAX_OMO_CANDIDATE_BYTES} bytes`],
      code: "oversize",
    };
  }
  const textDiff: BoundedTextDiff = boundTextDiff(
    load.text,
    draftText,
    basename(load.path),
  );
  return {
    ok: true,
    sourceId,
    fingerprint: load.fingerprint,
    currentText: load.text,
    textDiff,
    truncation: textDiff.truncated
      ? {
          truncated: true,
          omittedBytes: textDiff.omittedBytes,
          fullSourceAvailableInEditor: true,
        }
      : undefined,
    errors: [],
  };
}

export function simulateRawMutation(
  cfg: ServerConfig,
  m: RawMutation,
  revisions?: RevisionStore,
  sourceGeneration = 0,
): RawPreviewResponse {
  const schema = schemaIdentityFor(cfg);
  if (!schema.available) {
    return emptyRawPreview(
      cfg,
      m.sourceId,
      "schema-unavailable",
      [
        "Installed OMO-Slim schema unavailable — simulate/apply are fail-closed. No write performed.",
        schema.error ?? "",
      ],
      m.expectedSource,
    );
  }
  const deps = rawDeps(cfg, revisions, sourceGeneration);
  const preview = previewOmoCandidate(
    deps,
    {
      scope: sourceIdToScope(m.sourceId),
      expectedSource: m.expectedSource,
      input: { candidateText: m.candidateText },
      candidateParse: "target-extension",
      allowInvalidCurrent: true,
      expectedSchemaCacheKey: m.expectedSchemaCacheKey ?? schema.cacheKey,
    },
    produceRawCandidate,
  );
  return rawPreviewEnvelope(cfg, m.sourceId, preview);
}

export function applyRawMutation(
  cfg: ServerConfig,
  m: RawMutation,
  revisions: RevisionStore,
  sourceGeneration = 0,
): RawCommitResponse {
  const schema = schemaIdentityFor(cfg);
  if (!m.expectedCandidateSha256) {
    const preview = emptyRawPreview(
      cfg,
      m.sourceId,
      "malformed",
      ["expectedCandidateSha256 is required to apply"],
      m.expectedSource,
    );
    return {
      ok: false,
      code: "malformed",
      status: 400,
      sourceId: m.sourceId,
      preview,
      errors: preview.errors,
    };
  }
  if (!schema.available) {
    const preview = emptyRawPreview(
      cfg,
      m.sourceId,
      "schema-unavailable",
      [
        "Installed OMO-Slim schema unavailable — simulate/apply are fail-closed. No write performed.",
        schema.error ?? "",
      ],
      m.expectedSource,
    );
    return {
      ok: false,
      code: "schema-unavailable",
      status: 422,
      sourceId: m.sourceId,
      preview,
      errors: preview.errors,
    };
  }
  const deps = rawDeps(cfg, revisions, sourceGeneration);
  const commit = previewThenCommit(
    deps,
    {
      scope: sourceIdToScope(m.sourceId),
      expectedSource: m.expectedSource,
      input: { candidateText: m.candidateText },
      expectedCandidateSha256: m.expectedCandidateSha256,
      candidateParse: "target-extension",
      allowInvalidCurrent: true,
      expectedSchemaCacheKey: m.expectedSchemaCacheKey ?? schema.cacheKey,
    },
    produceRawCandidate,
  );
  const preview = rawPreviewEnvelope(cfg, m.sourceId, commit.preview);
  return {
    ok: commit.ok,
    code: commit.code,
    status: commit.status,
    sourceId: m.sourceId,
    preview,
    revisionId: commit.revisionId,
    source: commit.source,
    errors:
      commit.code === "stale-source"
        ? ["CONFIGURATION CHANGED EXTERNALLY — re-preview required"]
        : commit.errors,
  };
}

function restoreEligible(
  revisions: RevisionStore,
  cfg: ServerConfig,
  rev: NonNullable<ReturnType<RevisionStore["get"]>>,
): { eligible: boolean; compatible: boolean; reason?: string } {
  if (!revisions.isOmoRevisionTarget(cfg, rev)) {
    return {
      eligible: false,
      compatible: false,
      reason: "revision-domain-mismatch",
    };
  }
  const schema = assertSchemaValidCandidate(
    rev.beforeContent || "{}",
    schemaContextFor(cfg),
  );
  const compatible = schema.ok;
  const eligible = revisions.isRestoreEligible(rev, compatible);
  return {
    eligible,
    compatible,
    reason: eligible
      ? undefined
      : compatible
        ? "Revision is not restore-eligible"
        : "Historical revision is incompatible with the current installed schema",
  };
}

export function listOmoRevisions(
  cfg: ServerConfig,
  sourceId: RawOmoSourceId,
  revisions: RevisionStore,
  limit = 50,
): OmoRevisionListItem[] {
  const scope = sourceIdToScope(sourceId);
  ensureRecoveredOmoScope(rawDeps(cfg, revisions), scope);
  return revisions.listCommittedOmo(cfg, scope, limit).map((rev) => {
    const elig = restoreEligible(revisions, cfg, rev);
    return {
      id: rev.id,
      timestamp: rev.timestamp,
      sourceId,
      scope,
      state: rev.state ?? "committed",
      mutationKind: rev.mutationKind,
      kindLabel:
        rev.mutationKind === RAW_OMO_MUTATION_KIND
          ? RAW_OMO_MUTATION_KIND
          : rev.mutationKind,
      summary: rev.note,
      oldHash: rev.oldHash,
      newHash: rev.newHash,
      schemaPackageVersion: rev.schemaPackageVersion,
      schemaHash: rev.schemaHash,
      restoreEligible: elig.eligible,
    };
  });
}

export function getOmoRevisionDetail(
  cfg: ServerConfig,
  id: string,
  revisions: RevisionStore,
):
  | { ok: true; detail: OmoRevisionDetail }
  | { ok: false; code: OmoTransactionErrorCode; errors: string[] } {
  ensureRecoveredOmoScope(rawDeps(cfg, revisions), "user");
  ensureRecoveredOmoScope(rawDeps(cfg, revisions), "project");
  const rev = revisions.get(id);
  if (!rev) {
    return { ok: false, code: "malformed", errors: [`Revision not found: ${id}`] };
  }
  if (!revisions.isOmoRevisionTarget(cfg, rev)) {
    return {
      ok: false,
      code: "revision-domain-mismatch",
      errors: ["revision-domain-mismatch"],
    };
  }
  const sourceId = scopeToSourceId(rev.scope);
  const elig = restoreEligible(revisions, cfg, rev);
  const beforeParsed = parseOmoDocument(
    rev.beforeContent,
    rev.targetFormat ?? "jsonc",
  );
  const afterParsed = parseOmoDocument(
    rev.afterContent,
    rev.targetFormat ?? "jsonc",
  );
  const semanticChangedPaths =
    beforeParsed.ok && afterParsed.ok
      ? jsonChanges(beforeParsed.document, afterParsed.document).map((c) => c.path)
      : [];
  return {
    ok: true,
    detail: {
      id: rev.id,
      timestamp: rev.timestamp,
      sourceId,
      scope: rev.scope,
      state: rev.state ?? "committed",
      mutationKind: rev.mutationKind,
      kindLabel:
        rev.mutationKind === RAW_OMO_MUTATION_KIND
          ? RAW_OMO_MUTATION_KIND
          : rev.mutationKind,
      summary: rev.note,
      oldHash: rev.oldHash,
      newHash: rev.newHash,
      schemaPackageVersion: rev.schemaPackageVersion,
      schemaHash: rev.schemaHash,
      restoreEligible: elig.eligible,
      path: rev.targetPath,
      format: rev.targetFormat,
      beforeContent: rev.beforeContent,
      afterContent: rev.afterContent,
      textDiff: boundTextDiff(
        rev.beforeContent,
        rev.afterContent,
        basename(rev.targetPath),
      ),
      semanticChangedPaths,
      currentSchemaCompatible: elig.compatible,
      restoreBlockedReason: elig.reason,
    },
  };
}

export function simulateOmoRevisionRestore(
  cfg: ServerConfig,
  id: string,
  expectedSource: SourceFingerprint,
  revisions: RevisionStore,
  sourceGeneration = 0,
): RawPreviewResponse {
  const rev = revisions.get(id);
  if (!rev) {
    return emptyRawPreview(cfg, "user-omo", "malformed", [
      `Revision not found: ${id}`,
    ]);
  }
  if (!revisions.isOmoRevisionTarget(cfg, rev)) {
    return emptyRawPreview(
      cfg,
      scopeToSourceId(rev.scope),
      "revision-domain-mismatch",
      ["revision-domain-mismatch"],
    );
  }
  const sourceId = scopeToSourceId(rev.scope);
  const preview = previewOmoRevisionRestore(rawDeps(cfg, revisions, sourceGeneration), {
    scope: rev.scope,
    revisionId: id,
    expectedSource,
  });
  return rawPreviewEnvelope(cfg, sourceId, preview);
}

export function applyOmoRevisionRestore(
  cfg: ServerConfig,
  id: string,
  expectedSource: SourceFingerprint,
  expectedCandidateSha256: string,
  revisions: RevisionStore,
  sourceGeneration = 0,
): RawCommitResponse {
  const rev = revisions.get(id);
  if (!rev) {
    const preview = emptyRawPreview(cfg, "user-omo", "malformed", [
      `Revision not found: ${id}`,
    ]);
    return {
      ok: false,
      code: "malformed",
      status: 400,
      sourceId: "user-omo",
      preview,
      errors: preview.errors,
    };
  }
  const sourceId = scopeToSourceId(rev.scope);
  if (!revisions.isOmoRevisionTarget(cfg, rev)) {
    const preview = emptyRawPreview(cfg, sourceId, "revision-domain-mismatch", [
      "revision-domain-mismatch",
    ]);
    return {
      ok: false,
      code: "revision-domain-mismatch",
      status: 400,
      sourceId,
      preview,
      errors: preview.errors,
    };
  }
  const commit = commitOmoRevisionRestore(rawDeps(cfg, revisions, sourceGeneration), {
    scope: rev.scope,
    revisionId: id,
    expectedSource,
    expectedCandidateSha256,
  });
  return {
    ok: commit.ok,
    code: commit.code,
    status: commit.status,
    sourceId,
    preview: rawPreviewEnvelope(cfg, sourceId, commit.preview),
    revisionId: commit.revisionId,
    source: commit.source,
    errors: commit.errors,
  };
}

export function currentFingerprints(
  cfg: ServerConfig,
  generation: number,
): Record<RawOmoSourceId, SourceFingerprint> {
  return {
    "user-omo": fingerprintAuthorizedSource(cfg, "user", generation),
    "project-omo": fingerprintAuthorizedSource(cfg, "project", generation),
  };
}
