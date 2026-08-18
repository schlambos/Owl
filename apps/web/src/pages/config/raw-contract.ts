/**
 * D3 raw-config UI helpers over the shared backend contract.
 *
 * Requests use sourceId only. Load/preview/commit/revision shapes come from
 * `@omo/shared`. This file keeps tab labels, URI helpers, and diagnostic
 * flattening for the existing Configuration workspace.
 */
import type {
  OmoFormat,
  OmoRevisionDetail,
  OmoRevisionListItem,
  OmoSchemaDocumentDto,
  RawOmoSourceId,
  RawPreviewResponse,
  RawSemanticSummaries,
  RawSourceDiagnostic,
  RawSourceLoadResponse,
  SchemaValidationIssue,
  SourceFingerprint,
} from "@omo/shared";
import {
  MAX_OMO_CANDIDATE_BYTES,
  MISSING_PROJECT_EDITOR_TEXT,
  isRawOmoSourceId,
  scopeToSourceId,
  sourceIdToScope,
} from "@omo/shared";

export type {
  OmoRevisionDetail,
  OmoRevisionListItem,
  RawPreviewResponse,
  RawSourceLoadResponse,
};

export type ConfigWorkspaceTab =
  | "sources"
  | "effective"
  | "provenance"
  | "raw"
  | "diff"
  | "revisions"
  | "schema";

export const CONFIG_TABS: Array<{ id: ConfigWorkspaceTab; label: string }> = [
  { id: "sources", label: "Sources" },
  { id: "effective", label: "Effective" },
  { id: "provenance", label: "Provenance" },
  { id: "raw", label: "Raw Editor" },
  { id: "diff", label: "Diff" },
  { id: "revisions", label: "Revisions" },
  { id: "schema", label: "Schema" },
];

export const EMPTY_PROJECT_TEXT = MISSING_PROJECT_EDITOR_TEXT;

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function exceedsCandidateCap(text: string): boolean {
  return utf8Bytes(text) > MAX_OMO_CANDIDATE_BYTES;
}

export function sourceModelUri(sourceId: RawOmoSourceId, format: OmoFormat): string {
  const scope = sourceIdToScope(sourceId);
  return `file:///omo-control/${scope}/oh-my-opencode-slim.${format}`;
}

export function schemaModelUri(packageVersion: string | undefined, schemaHash: string): string {
  return `inmemory://omo-control/schema/oh-my-opencode-slim@${packageVersion ?? "unknown"}-${schemaHash}.json`;
}

export function parseSourceIdParam(
  sourceId: string | null,
  scope: string | null,
): RawOmoSourceId {
  if (isRawOmoSourceId(sourceId)) return sourceId;
  if (scope === "project" || scope === "project-omo") return "project-omo";
  return "user-omo";
}

export function rawRepairHref(sourceId: RawOmoSourceId, path?: string): string {
  const params = new URLSearchParams({ tab: "raw", sourceId });
  if (path) params.set("path", path);
  return `/config?${params.toString()}`;
}

export function shortHash(sha: string | null | undefined): string {
  if (!sha) return "—";
  return sha.length > 12 ? `${sha.slice(0, 12)}…` : sha;
}

export function flattenSourceDiagnostics(source: RawSourceLoadResponse): SchemaValidationIssue[] {
  const syntax = source.syntax?.issues ?? [];
  const schema = source.schemaValidation?.issues ?? [];
  return [
    ...syntax.map(toIssue),
    ...schema,
  ];
}

function toIssue(d: RawSourceDiagnostic): SchemaValidationIssue {
  return {
    path: d.path,
    keyword: d.keyword,
    message: d.message,
  };
}

export function sourceIsValid(source: RawSourceLoadResponse): boolean {
  if (!source.exists) return true;
  return (
    source.syntax.ok &&
    (source.schemaValidation ? source.schemaValidation.ok : true)
  );
}

export function fingerprintsEqual(
  a: SourceFingerprint | null | undefined,
  b: SourceFingerprint | null | undefined,
): boolean {
  if (!a || !b) return false;
  return (
    a.exists === b.exists &&
    a.sha256 === b.sha256 &&
    a.format === b.format &&
    a.generation === b.generation
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function parseRevisionList(raw: unknown): OmoRevisionListItem[] {
  const o = isRecord(raw) ? raw : {};
  const list = Array.isArray(o.revisions) ? o.revisions : Array.isArray(raw) ? raw : [];
  return list.filter(isRecord).map((item) => {
    const sourceId: RawOmoSourceId = isRawOmoSourceId(item.sourceId)
      ? item.sourceId
      : scopeToSourceId(item.scope === "project" ? "project" : "user");
    return {
      id: String(item.id ?? ""),
      timestamp: String(item.timestamp ?? ""),
      sourceId,
      scope: sourceIdToScope(sourceId),
      state: (typeof item.state === "string" ? item.state : "committed") as OmoRevisionListItem["state"],
      mutationKind: String(item.mutationKind ?? ""),
      kindLabel: String(item.kindLabel ?? item.mutationKind ?? ""),
      summary: typeof item.summary === "string" ? item.summary : typeof item.note === "string" ? item.note : undefined,
      oldHash: String(item.oldHash ?? ""),
      newHash: String(item.newHash ?? ""),
      schemaPackageVersion:
        typeof item.schemaPackageVersion === "string" ? item.schemaPackageVersion : undefined,
      schemaHash: typeof item.schemaHash === "string" ? item.schemaHash : undefined,
      restoreEligible: item.restoreEligible !== false && item.eligible !== false,
    };
  });
}

export function parseRevisionDetail(raw: unknown): OmoRevisionDetail | null {
  if (!isRecord(raw)) return null;
  const inner = isRecord(raw.detail) ? raw.detail : raw;
  const list = parseRevisionList({ revisions: [inner] })[0];
  if (!list) return null;
  return {
    ...list,
    path: String(inner.path ?? inner.targetPath ?? ""),
    format: inner.format === "json" ? "json" : "jsonc",
    beforeContent: typeof inner.beforeContent === "string" ? inner.beforeContent : "",
    afterContent: typeof inner.afterContent === "string" ? inner.afterContent : "",
    textDiff: isRecord(inner.textDiff)
      ? {
          text: String(inner.textDiff.text ?? ""),
          truncated: inner.textDiff.truncated === true,
        }
      : undefined,
    semanticChangedPaths: Array.isArray(inner.semanticChangedPaths)
      ? inner.semanticChangedPaths.map(String)
      : [],
    currentSchemaCompatible: inner.currentSchemaCompatible !== false,
    restoreBlockedReason:
      typeof inner.restoreBlockedReason === "string" ? inner.restoreBlockedReason : undefined,
    restoreEligible: inner.restoreEligible !== false && inner.eligible !== false,
  };
}

export function parseSchemaDocument(raw: unknown): OmoSchemaDocumentDto {
  const o = isRecord(raw) ? raw : {};
  if (o.available === false) {
    return {
      available: false,
      error: typeof o.error === "string" ? o.error : "installed schema unavailable",
      packageVersion: typeof o.packageVersion === "string" ? o.packageVersion : undefined,
      schemaHash: typeof o.schemaHash === "string" ? o.schemaHash : undefined,
      cacheKey: typeof o.cacheKey === "string" ? o.cacheKey : undefined,
    };
  }
  const schema = isRecord(o.schema) ? o.schema : {};
  const schemaHash = typeof o.schemaHash === "string" ? o.schemaHash : "unknown";
  const packageVersion = typeof o.packageVersion === "string" ? o.packageVersion : undefined;
  return {
    available: true,
    packageVersion,
    schemaHash,
    cacheKey:
      typeof o.cacheKey === "string"
        ? o.cacheKey
        : `oh-my-opencode-slim@${packageVersion ?? "unknown"}-${schemaHash}`,
    schema,
  };
}

export function emptySemanticSummaries(): RawSemanticSummaries {
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

export function semanticRows(summaries: RawSemanticSummaries | undefined) {
  const s = summaries ?? emptySemanticSummaries();
  return [
    ["Capabilities", s.capabilities],
    ["Prompts", s.prompts],
    ["Presets", s.presets],
    ["Council", s.council],
    ["ACP", s.acp],
    ["Interview", s.interview],
    ["Custom agents", s.customAgents],
  ] as const;
}
