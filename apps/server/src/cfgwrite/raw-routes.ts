/**
 * Raw OMO + OMO-revision HTTP routes (Slice 18 D3).
 *
 * GET  /api/config/raw?sourceId=user-omo|project-omo
 * POST /api/config/raw/compare|simulate|apply
 * GET  /api/config/omo-revisions?sourceId=...&limit=
 * GET  /api/config/omo-revisions/:id
 * POST /api/config/omo-revisions/:id/simulate-restore|restore
 *
 * Client never supplies filesystem paths. Request bodies are bounded
 * before JSON decode.
 */

import type {
  OmoTransactionErrorCode,
  RawOmoSourceId,
  SourceFingerprint,
} from "@omo/shared";
import {
  MAX_OMO_CANDIDATE_BYTES,
  MAX_OMO_REQUEST_BYTES,
  isRawOmoSourceId,
} from "@omo/shared";
import type { ServerConfig } from "../config";
import type { RevisionStore } from "./revisions";
import {
  applyOmoRevisionRestore,
  applyRawMutation,
  compareRawSource,
  getOmoRevisionDetail,
  listOmoRevisions,
  loadRawSource,
  rawHttpStatus,
  simulateOmoRevisionRestore,
  simulateRawMutation,
  type RawMutation,
} from "./raw";

export interface RawConfigRouteDeps {
  cfg: ServerConfig;
  revisions: RevisionStore;
  sourceGeneration: () => number;
  /** Called after a successful apply so the watcher can suppress false stale. */
  noteOwnApply?: (sourceId: RawOmoSourceId, sha256: string | null) => void;
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

function rejectPathFields(body: Record<string, unknown>): string | null {
  for (const key of ["path", "filePath", "targetPath", "absolutePath"]) {
    if (key in body) {
      return `Client must not supply ${key}; use sourceId user-omo|project-omo`;
    }
  }
  return null;
}

function parseSourceId(value: unknown): RawOmoSourceId | null {
  return isRawOmoSourceId(value) ? value : null;
}

function errorCommit(
  sourceId: RawOmoSourceId,
  code: OmoTransactionErrorCode,
  errors: string[],
  status: number,
): Record<string, unknown> {
  const preview = errorEnvelope(sourceId, code, errors);
  return {
    ok: false,
    code,
    status,
    sourceId,
    preview,
    errors,
  };
}

function errorEnvelope(
  sourceId: RawOmoSourceId,
  code: OmoTransactionErrorCode,
  errors: string[],
): Record<string, unknown> {
  return {
    ok: false,
    canApply: false,
    code,
    sourceId,
    source: {
      exists: false,
      sha256: null,
      format: "jsonc",
      mtimeMs: null,
      generation: 0,
    },
    target: {
      scope: sourceId === "user-omo" ? "user" : "project",
      path: "",
      format: "jsonc",
      exists: false,
      createOnApplyOnly: sourceId === "project-omo",
    },
    semanticValidation: { ok: false, issues: [] },
    sourceChanges: [],
    desiredChanges: [],
    effectiveChanges: [],
    provenanceChanges: [],
    warnings: [],
    errors,
    liveUnchangedNote:
      "Live runtime is unchanged until OpenCode reloads this configuration.",
    semanticSummaries: {
      capabilities: { changed: false, notes: [] },
      prompts: { changed: false, notes: [] },
      presets: { changed: false, notes: [] },
      council: { changed: false, notes: [] },
      acp: { changed: false, notes: [] },
      interview: { changed: false, notes: [] },
      customAgents: { changed: false, notes: [] },
    },
  };
}

export function parseRawMutationBody(
  body: unknown,
): { ok: true; request: RawMutation } | { ok: false; errors: string[] } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: ["Body must be an object"] };
  }
  const b = body as Record<string, unknown>;
  const pathErr = rejectPathFields(b);
  if (pathErr) return { ok: false, errors: [pathErr] };
  const sourceId = parseSourceId(b.sourceId);
  if (!sourceId) {
    return { ok: false, errors: ['sourceId must be "user-omo" or "project-omo"'] };
  }
  if (typeof b.candidateText !== "string") {
    return { ok: false, errors: ["candidateText must be a string"] };
  }
  if (Buffer.byteLength(b.candidateText, "utf-8") > MAX_OMO_CANDIDATE_BYTES) {
    return { ok: false, errors: ["candidateText exceeds 2 MiB"] };
  }
  if (!isFingerprint(b.expectedSource)) {
    return {
      ok: false,
      errors: [
        "expectedSource must include exists, sha256, format, mtimeMs, and generation",
      ],
    };
  }
  return {
    ok: true,
    request: {
      sourceId,
      expectedSource: b.expectedSource,
      candidateText: b.candidateText,
      ...(typeof b.expectedSchemaCacheKey === "string"
        ? { expectedSchemaCacheKey: b.expectedSchemaCacheKey }
        : {}),
      ...(typeof b.expectedCandidateSha256 === "string"
        ? { expectedCandidateSha256: b.expectedCandidateSha256 }
        : {}),
    },
  };
}

function declaredContentLength(req: Request): number | undefined {
  const raw = req.headers.get("content-length");
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Bound the HTTP request before decode. Oversized Content-Length is
 * rejected without reading the body. Chunked/unknown-length bodies are
 * streamed and cancelled once `MAX_OMO_REQUEST_BYTES` is exceeded.
 */
export async function readBoundedJson(
  req: Request,
): Promise<
  | { ok: true; body: unknown }
  | { ok: false; status: number; code: OmoTransactionErrorCode; errors: string[] }
> {
  const declared = declaredContentLength(req);
  if (declared !== undefined && declared > MAX_OMO_REQUEST_BYTES) {
    return {
      ok: false,
      status: 413,
      code: "oversize",
      errors: ["Request body exceeds limit"],
    };
  }

  const stream = req.body;
  if (!stream) {
    return {
      ok: false,
      status: 400,
      code: "malformed",
      errors: ["Malformed JSON body"],
    };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > MAX_OMO_REQUEST_BYTES) {
        try {
          await reader.cancel();
        } catch {
          /* already cancelled or closed */
        }
        return {
          ok: false,
          status: 413,
          code: "oversize",
          errors: ["Request body exceeds limit"],
        };
      }
      chunks.push(value);
    }
  } catch {
    return {
      ok: false,
      status: 400,
      code: "malformed",
      errors: ["Request body could not be read"],
    };
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      concatBytes(chunks, total),
    );
  } catch {
    return {
      ok: false,
      status: 400,
      code: "malformed",
      errors: ["Request body is not valid UTF-8"],
    };
  }

  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      status: 400,
      code: "malformed",
      errors: ["Malformed JSON body"],
    };
  }
}

export async function handleRawConfigRoutes(
  deps: RawConfigRouteDeps,
  req: Request,
  url: URL,
): Promise<Response | null> {
  const { cfg, revisions } = deps;
  const gen = deps.sourceGeneration();

  if (url.pathname === "/api/config/raw" && req.method === "GET") {
    const sourceId = parseSourceId(url.searchParams.get("sourceId"));
    if (!sourceId) {
      return jsonResponse(
        {
          ok: false,
          code: "malformed",
          errors: ['sourceId must be "user-omo" or "project-omo"'],
        },
        400,
      );
    }
    const result = loadRawSource(cfg, sourceId, revisions, gen);
    return jsonResponse(result, result.code === "oversize" ? 413 : 200);
  }

  if (url.pathname === "/api/config/raw/compare" && req.method === "POST") {
    const parsed = await readBoundedJson(req);
    if (!parsed.ok) {
      return jsonResponse(
        { ok: false, code: parsed.code, errors: parsed.errors },
        parsed.status,
      );
    }
    if (!parsed.body || typeof parsed.body !== "object") {
      return jsonResponse(
        { ok: false, code: "malformed", errors: ["Body must be an object"] },
        400,
      );
    }
    const b = parsed.body as Record<string, unknown>;
    const pathErr = rejectPathFields(b);
    if (pathErr) return jsonResponse({ ok: false, errors: [pathErr] }, 400);
    const sourceId = parseSourceId(b.sourceId);
    if (!sourceId || typeof b.draftText !== "string") {
      return jsonResponse(
        {
          ok: false,
          code: "malformed",
          errors: ["sourceId and draftText are required"],
        },
        400,
      );
    }
    const result = compareRawSource(cfg, sourceId, b.draftText, revisions, gen);
    return jsonResponse(result, result.code === "oversize" ? 413 : 200);
  }

  if (url.pathname === "/api/config/raw/simulate" && req.method === "POST") {
    const parsed = await readBoundedJson(req);
    if (!parsed.ok) {
      return jsonResponse(
        errorEnvelope("user-omo", parsed.code, parsed.errors),
        parsed.status,
      );
    }
    const mut = parseRawMutationBody(parsed.body);
    if (!mut.ok) {
      return jsonResponse(errorEnvelope("user-omo", "malformed", mut.errors), 400);
    }
    const result = simulateRawMutation(cfg, mut.request, revisions, gen);
    return jsonResponse(result, result.ok ? 200 : rawHttpStatus(result.code));
  }

  if (url.pathname === "/api/config/raw/apply" && req.method === "POST") {
    const parsed = await readBoundedJson(req);
    if (!parsed.ok) {
      return jsonResponse(
        errorCommit("user-omo", parsed.code, parsed.errors, parsed.status),
        parsed.status,
      );
    }
    const mut = parseRawMutationBody(parsed.body);
    if (!mut.ok) {
      return jsonResponse(
        errorCommit("user-omo", "malformed", mut.errors, 400),
        400,
      );
    }
    if (!mut.request.expectedCandidateSha256) {
      return jsonResponse(
        errorCommit(
          mut.request.sourceId,
          "malformed",
          ["expectedCandidateSha256 is required to apply"],
          400,
        ),
        400,
      );
    }
    const result = applyRawMutation(cfg, mut.request, revisions, gen);
    if (result.ok && result.source) {
      deps.noteOwnApply?.(result.sourceId, result.source.sha256);
    }
    return jsonResponse(result, result.status);
  }

  if (url.pathname === "/api/config/omo-revisions" && req.method === "GET") {
    const sourceId = parseSourceId(url.searchParams.get("sourceId"));
    if (!sourceId) {
      return jsonResponse(
        {
          ok: false,
          code: "malformed",
          errors: ['sourceId must be "user-omo" or "project-omo"'],
        },
        400,
      );
    }
    const rawLimit = Number(url.searchParams.get("limit") ?? "50");
    const limit = Number.isFinite(rawLimit)
      ? Math.min(100, Math.max(1, Math.floor(rawLimit)))
      : 50;
    return jsonResponse({
      ok: true,
      sourceId,
      revisions: listOmoRevisions(cfg, sourceId, revisions, limit),
    });
  }

  {
    const m = url.pathname.match(/^\/api\/config\/omo-revisions\/([^/]+)$/);
    if (m && req.method === "GET") {
      const result = getOmoRevisionDetail(
        cfg,
        decodeURIComponent(m[1]!),
        revisions,
      );
      if (!result.ok) {
        return jsonResponse(result, result.code === "malformed" ? 404 : 400);
      }
      return jsonResponse(result.detail);
    }
  }

  {
    const m = url.pathname.match(
      /^\/api\/config\/omo-revisions\/([^/]+)\/simulate-restore$/,
    );
    if (m && req.method === "POST") {
      const parsed = await readBoundedJson(req);
      if (!parsed.ok) {
        return jsonResponse(
          errorEnvelope("user-omo", parsed.code, parsed.errors),
          parsed.status,
        );
      }
      const body = parsed.body as Record<string, unknown>;
      if (!isFingerprint(body.expectedSource)) {
        return jsonResponse(
          errorEnvelope("user-omo", "malformed", [
            "expectedSource fingerprint is required",
          ]),
          400,
        );
      }
      const result = simulateOmoRevisionRestore(
        cfg,
        decodeURIComponent(m[1]!),
        body.expectedSource,
        revisions,
        gen,
      );
      return jsonResponse(result, result.ok ? 200 : rawHttpStatus(result.code));
    }
  }

  {
    const m = url.pathname.match(
      /^\/api\/config\/omo-revisions\/([^/]+)\/restore$/,
    );
    if (m && req.method === "POST") {
      const parsed = await readBoundedJson(req);
      if (!parsed.ok) {
        return jsonResponse(
          errorCommit("user-omo", parsed.code, parsed.errors, parsed.status),
          parsed.status,
        );
      }
      const body = parsed.body as Record<string, unknown>;
      if (!isFingerprint(body.expectedSource)) {
        return jsonResponse(
          errorCommit(
            "user-omo",
            "malformed",
            ["expectedSource fingerprint is required"],
            400,
          ),
          400,
        );
      }
      if (typeof body.expectedCandidateSha256 !== "string") {
        return jsonResponse(
          errorCommit(
            "user-omo",
            "malformed",
            ["expectedCandidateSha256 is required to restore"],
            400,
          ),
          400,
        );
      }
      const result = applyOmoRevisionRestore(
        cfg,
        decodeURIComponent(m[1]!),
        body.expectedSource,
        body.expectedCandidateSha256,
        revisions,
        gen,
      );
      if (result.ok && result.source) {
        deps.noteOwnApply?.(result.sourceId, result.source.sha256);
      }
      return jsonResponse(result, result.status);
    }
  }

  return null;
}
