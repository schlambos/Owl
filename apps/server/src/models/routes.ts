/**
 * HTTP routes for the model inventory + probe subsystem (Slice 15, Lane 1).
 *
 * Route registration approach for slash-containing model IDs:
 * Bun's URL.pathname is NOT percent-decoded, so a client encodes the model
 * segment with encodeURIComponent ("/" → "%2F") and the raw pathname keeps a
 * single segment. The detail/history patterns therefore capture the model
 * with a greedy `(.+)` and decodeURIComponent it — this matches both encoded
 * %2F forms and (tolerantly) unencoded multi-slash paths. More specific
 * patterns (/probes suffix, /probes/:id/cancel, exact POST paths) are
 * matched BEFORE the greedy detail pattern.
 *
 * handleModelRequest returns undefined when the path doesn't belong to the
 * model subsystem, letting index.ts continue its route chain.
 */

import type {
  ModelAvailabilityDetail,
  ModelInventoryDto,
  ModelProbeRun,
} from "@omo/shared";
import {
  PROBE_BATCH_HARD_LIMIT,
  PROBE_BATCH_SOFT_LIMIT,
  PROBE_RETENTION_PER_MODEL,
} from "./constants";
import {
  ModelProbeQueue,
  ProbeQueueError,
  type BatchResult,
  type CancelResult,
  type SubmitResult,
} from "./probe-queue";
import type { ModelProbeStore } from "./probe-store";

export interface ModelRouteDeps {
  /** Compose the full inventory per request (fresh snapshots). */
  getInventory: () => Promise<ModelInventoryDto>;
  /** Detail for one model; undefined when unknown in every source. */
  getDetail: (
    providerId: string,
    modelId: string,
  ) => Promise<ModelAvailabilityDetail | undefined>;
  /** Newest-first probe history (persisted + overlay). */
  getHistory: (
    providerId: string,
    modelId: string,
    limit: number,
  ) => ModelProbeRun[];
  queue: ModelProbeQueue;
  store: ModelProbeStore;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
}

function badRequest(error: string, extra?: Record<string, unknown>): Response {
  return json({ error, ...extra }, 400);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function decodeSeg(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// Model segment is greedy (.+) so slash-containing ids survive; routes are
// ordered most-specific → detail.
const RE_PROBES_LIST = /^\/api\/models\/([^/]+)\/(.+)\/probes$/;
const RE_CANCEL = /^\/api\/models\/probes\/([^/]+)\/cancel$/;
const RE_DETAIL = /^\/api\/models\/([^/]+)\/(.+)$/;

/** Only providerId, modelId, force — any prompt-ish/extra field is rejected. */
function validateProbeBody(body: unknown):
  | { ok: true; providerId: string; modelId: string; force?: boolean }
  | { ok: false; error: string } {
  if (!isPlainObject(body)) return { ok: false, error: "body must be an object" };
  const allowed = new Set(["providerId", "modelId", "force"]);
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) {
      return { ok: false, error: `unexpected field "${k}" — probes carry a fixed control-plane prompt and accept no request content` };
    }
  }
  if (typeof body.providerId !== "string" || !body.providerId) {
    return { ok: false, error: "providerId must be a non-empty string" };
  }
  if (typeof body.modelId !== "string" || !body.modelId) {
    return { ok: false, error: "modelId must be a non-empty string" };
  }
  if (body.force !== undefined && typeof body.force !== "boolean") {
    return { ok: false, error: "force must be a boolean" };
  }
  return {
    ok: true,
    providerId: body.providerId,
    modelId: body.modelId,
    ...(body.force !== undefined ? { force: body.force } : {}),
  };
}

function validateBatchBody(body: unknown):
  | {
      ok: true;
      models: Array<{ providerId: string; modelId: string }>;
      force?: boolean;
      skipRecentlyTested?: boolean;
      acknowledgeLargeBatch?: boolean;
    }
  | { ok: false; error: string } {
  if (!isPlainObject(body)) return { ok: false, error: "body must be an object" };
  const allowed = new Set([
    "models",
    "force",
    "skipRecentlyTested",
    "acknowledgeLargeBatch",
  ]);
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) {
      return { ok: false, error: `unexpected field "${k}"` };
    }
  }
  if (!Array.isArray(body.models)) {
    return { ok: false, error: "models must be an array" };
  }
  const models: Array<{ providerId: string; modelId: string }> = [];
  for (const [i, m] of body.models.entries()) {
    if (!isPlainObject(m)) {
      return { ok: false, error: `models[${i}] must be an object` };
    }
    for (const k of Object.keys(m)) {
      if (k !== "providerId" && k !== "modelId") {
        return { ok: false, error: `models[${i}]: unexpected field "${k}"` };
      }
    }
    if (typeof m.providerId !== "string" || !m.providerId) {
      return { ok: false, error: `models[${i}].providerId must be a non-empty string` };
    }
    if (typeof m.modelId !== "string" || !m.modelId) {
      return { ok: false, error: `models[${i}].modelId must be a non-empty string` };
    }
    models.push({ providerId: m.providerId, modelId: m.modelId });
  }
  for (const flag of ["force", "skipRecentlyTested", "acknowledgeLargeBatch"] as const) {
    if (body[flag] !== undefined && typeof body[flag] !== "boolean") {
      return { ok: false, error: `${flag} must be a boolean` };
    }
  }
  return {
    ok: true,
    models,
    ...(body.force !== undefined ? { force: body.force as boolean } : {}),
    ...(body.skipRecentlyTested !== undefined
      ? { skipRecentlyTested: body.skipRecentlyTested as boolean }
      : {}),
    ...(body.acknowledgeLargeBatch !== undefined
      ? { acknowledgeLargeBatch: body.acknowledgeLargeBatch as boolean }
      : {}),
  };
}

export async function handleModelRequest(
  req: Request,
  url: URL,
  deps: ModelRouteDeps,
): Promise<Response | undefined> {
  const path = url.pathname;
  const method = req.method.toUpperCase();

  // GET /api/models — full inventory.
  if (path === "/api/models" && method === "GET") {
    return json(await deps.getInventory());
  }

  // POST /api/models/probe {providerId, modelId, force?} — strict body.
  if (path === "/api/models/probe" && method === "POST") {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return badRequest("invalid JSON body");
    }
    const v = validateProbeBody(body);
    if (!v.ok) return badRequest(v.error);
    try {
      const result: SubmitResult = deps.queue.submit({
        providerId: v.providerId,
        modelId: v.modelId,
        force: v.force,
      });
      if (result.status === "skipped") {
        return json({
          queued: false,
          skipped: "fresh",
          latest: result.latest,
          queue: deps.queue.snapshot(),
        });
      }
      if (result.status === "duplicate") {
        return json({
          queued: false,
          duplicate: true,
          item: result.item,
          queue: deps.queue.snapshot(),
        });
      }
      return json({ queued: true, item: result.item, queue: deps.queue.snapshot() }, 202);
    } catch (e) {
      if (e instanceof ProbeQueueError) {
        return json({ error: e.message, code: e.code }, e.statusCode);
      }
      throw e;
    }
  }

  // POST /api/models/probe-batch — tiered guards.
  if (path === "/api/models/probe-batch" && method === "POST") {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return badRequest("invalid JSON body");
    }
    const v = validateBatchBody(body);
    if (!v.ok) return badRequest(v.error);
    if (v.models.length > PROBE_BATCH_HARD_LIMIT) {
      return badRequest(
        `batch of ${v.models.length} exceeds the hard limit of ${PROBE_BATCH_HARD_LIMIT}`,
      );
    }
    if (
      v.models.length > PROBE_BATCH_SOFT_LIMIT &&
      (v.force !== true || v.acknowledgeLargeBatch !== true)
    ) {
      return badRequest(
        `batch of ${v.models.length} exceeds the soft limit of ${PROBE_BATCH_SOFT_LIMIT} — requires force:true AND acknowledgeLargeBatch:true`,
      );
    }
    try {
      const result: BatchResult = deps.queue.submitBatch(v.models, {
        ...(v.force !== undefined ? { force: v.force } : {}),
        ...(v.skipRecentlyTested !== undefined
          ? { skipRecentlyTested: v.skipRecentlyTested }
          : {}),
      });
      return json(result, result.accepted.length > 0 ? 202 : 200);
    } catch (e) {
      if (e instanceof ProbeQueueError) {
        return json({ error: e.message, code: e.code }, e.statusCode);
      }
      throw e;
    }
  }

  // POST /api/models/probes/:id/cancel → 200 queue snapshot / 404 / 409.
  {
    const m = path.match(RE_CANCEL);
    if (m) {
      if (method !== "POST") return json({ error: "method not allowed" }, 405);
      const result: CancelResult = deps.queue.cancel(decodeSeg(m[1]!));
      if (result.ok) return json({ ok: true, queue: deps.queue.snapshot() });
      return json({ ok: false, error: result.error }, result.status);
    }
  }

  // GET /api/models/:provider/:model/probes — newest-first history.
  {
    const m = path.match(RE_PROBES_LIST);
    if (m && method === "GET") {
      const providerId = decodeSeg(m[1]!);
      const modelId = decodeSeg(m[2]!);
      const detail = await deps.getDetail(providerId, modelId);
      if (!detail) {
        return json({ error: "unknown model", providerId, modelId }, 404);
      }
      return json({
        providerId,
        modelId,
        probes: deps.getHistory(providerId, modelId, PROBE_RETENTION_PER_MODEL),
      });
    }
  }

  // GET /api/models/:provider/:model — availability detail.
  {
    const m = path.match(RE_DETAIL);
    if (m) {
      if (method !== "GET") return json({ error: "method not allowed" }, 405);
      const providerId = decodeSeg(m[1]!);
      const modelId = decodeSeg(m[2]!);
      const detail = await deps.getDetail(providerId, modelId);
      if (!detail) {
        return json({ error: "unknown model", providerId, modelId }, 404);
      }
      return json(detail);
    }
  }

  return undefined;
}
