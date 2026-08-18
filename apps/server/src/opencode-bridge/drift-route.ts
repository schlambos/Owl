/**
 * Metadata-only drift acceptance — local-only HTTP routes.
 *
 * Routes:
 *   POST /api/opencode/bridge/accept-drift/preview
 *   POST /api/opencode/bridge/accept-drift/apply
 *
 * Local request security (API/CLI only; no browser surface):
 *  - The control-plane bind host must be loopback AND `requestIP` must be
 *    loopback; otherwise 403 local-request-required.
 *  - Any `Origin` header or any `sec-fetch-*` browser/cross-site fetch
 *    metadata header → rejected.
 *  - OPTIONS is rejected (405) — these routes never participate in CORS and
 *    responses carry NO CORS headers.
 *  - Bodies are bounded JSON (max 4 KiB).
 *  - The routes work while the lifecycle is failed at generation 0 and never
 *    start/reconcile the runtime or touch process control.
 */

import type { BridgeError, DriftAcceptanceApplyDto } from "./types";
import type { BridgeService } from "./service";

export const DRIFT_PREVIEW_PATH = "/api/opencode/bridge/accept-drift/preview";
export const DRIFT_APPLY_PATH = "/api/opencode/bridge/accept-drift/apply";

const MAX_BODY_BYTES = 4096;

export function isDriftRoutePath(pathname: string): boolean {
  return pathname === DRIFT_PREVIEW_PATH || pathname === DRIFT_APPLY_PATH;
}

export interface DriftRouteContext {
  /** True when the control-plane bind host is loopback. */
  loopbackBind: boolean;
  /** Remote address of the request (Bun server.requestIP), if available. */
  requestAddress: (req: Request) => string | undefined;
  /** Bridge service; undefined when the DB/service is unavailable. */
  getService: () => BridgeService | undefined;
  /** True when the bridge override opts out of management. */
  overrideActive: () => boolean;
  /**
   * Post-commit integration hook (index-owned). Runs for EVERY
   * metadata-committed outcome — clean commit AND post-commit drift/fault.
   * The composition root runs bridgeService.reconcile(), updates the cached
   * disposition, invalidates Doctor, and broadcasts the sanitized status,
   * then returns the ACTUAL reconciliation disposition. Never calls
   * refreshEffectiveState, runtime.reconcile, feedBridgeManager, or any
   * lifecycle/process control.
   */
  onMetadataCommitted: (
    result: DriftAcceptanceApplyDto,
  ) => "not-written" | "committed" | "recovery-pending";
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const a = address.trim().toLowerCase();
  return a === "127.0.0.1" || a === "::1" || a === "[::1]" || a === "localhost";
}

function jsonNoCors(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function reject(
  code: BridgeError["code"],
  message: string,
  status: number,
): Response {
  return jsonNoCors({ ok: false, error: { code, message } }, status);
}

/** Bounded JSON reader: max 4 KiB, root must be a plain object. */
async function readBoundedJson(
  req: Request,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: false, response: reject("local-request-required", "Request body could not be read.", 400) };
  }
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    return { ok: false, response: reject("local-request-required", "Request body exceeds the 4KiB bound.", 413) };
  }
  let parsed: unknown;
  try {
    parsed = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    return { ok: false, response: reject("local-request-required", "Request body is not valid JSON.", 400) };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, response: reject("local-request-required", "Request body must be a JSON object.", 400) };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

function strField(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export async function handleBridgeDriftRoute(
  req: Request,
  ctx: DriftRouteContext,
): Promise<Response> {
  // The drift routes are mounted OUTSIDE the generic route try/catch, so
  // every fault is converted to a structured response internally.
  try {
    return await handleBridgeDriftRouteInner(req, ctx);
  } catch {
    return jsonNoCors(
      {
        ok: false,
        error: { code: "state-recovery-pending", message: "Drift route failed; structured fallback." },
      },
      500,
    );
  }
}

async function handleBridgeDriftRouteInner(
  req: Request,
  ctx: DriftRouteContext,
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // OPTIONS (and any non-POST) rejected: no CORS participation at all.
  if (req.method === "OPTIONS") {
    return reject("local-request-required", "OPTIONS is not supported on this route.", 405);
  }
  if (req.method !== "POST") {
    return reject("local-request-required", "Only POST is supported on this route.", 405);
  }

  // Loopback-only: bind host AND observed peer must both be loopback.
  if (!ctx.loopbackBind || !isLoopbackAddress(ctx.requestAddress(req))) {
    return reject("local-request-required", "This route is only available to local loopback clients.", 403);
  }

  // Reject browser/cross-site fetch metadata outright.
  if (req.headers.get("origin") !== null) {
    return reject("local-request-required", "Origin-bearing requests are not accepted.", 403);
  }
  for (const [name] of req.headers) {
    if (name.toLowerCase().startsWith("sec-fetch-")) {
      return reject("local-request-required", "Browser fetch metadata is not accepted.", 403);
    }
  }

  const service = ctx.getService();
  if (!service) {
    return reject("state-recovery-pending", "Bridge revision service is unavailable.", 503);
  }

  const bodyResult = await readBoundedJson(req);
  if (!bodyResult.ok) return bodyResult.response;
  const body = bodyResult.body;

  if (path === DRIFT_PREVIEW_PATH) {
    const expectedRevisionId = strField(body, "expectedRevisionId");
    const expectedCommittedHash = strField(body, "expectedCommittedHash");
    const expectedObservedHash = strField(body, "expectedObservedHash");
    if (!expectedRevisionId || !expectedCommittedHash || !expectedObservedHash) {
      return reject("drift-not-eligible", "expectedRevisionId, expectedCommittedHash, and expectedObservedHash are required.", 400);
    }
    const result = service.previewDriftAcceptance(
      { expectedRevisionId, expectedCommittedHash, expectedObservedHash },
      { overrideActive: ctx.overrideActive() },
    );
    if (!result.ok) {
      const first = result.errors[0];
      return reject(first?.code ?? "drift-proof-failed", result.errors.map((e) => e.message).join("; "), 409);
    }
    return jsonNoCors({ ok: true, preview: result });
  }

  // DRIFT_APPLY_PATH
  const previewId = strField(body, "previewId");
  const expectedRevisionId = strField(body, "expectedRevisionId");
  const expectedCommittedHash = strField(body, "expectedCommittedHash");
  const expectedObservedHash = strField(body, "expectedObservedHash");
  const confirmation = strField(body, "confirmation");
  if (!previewId || !expectedRevisionId || !expectedCommittedHash || !expectedObservedHash || !confirmation) {
    return reject("state-conflict", "previewId, expectedRevisionId, expectedCommittedHash, expectedObservedHash, and confirmation are required.", 400);
  }
  const result = service.applyDriftAcceptance(
    { previewId, expectedRevisionId, expectedCommittedHash, expectedObservedHash, confirmation },
    { overrideActive: ctx.overrideActive() },
  );

  // The metadata hook runs for EVERY metadata-committed outcome (clean
  // commit AND post-commit drift/fault) and returns the ACTUAL
  // reconciliation disposition. A hook failure is structured, never thrown.
  if (result.metadataCommitted) {
    let hookDisposition: "not-written" | "committed" | "recovery-pending";
    try {
      hookDisposition = ctx.onMetadataCommitted(result);
    } catch {
      hookDisposition = "recovery-pending";
    }
    if (hookDisposition !== "committed") {
      // Reconciliation is not clean — report post-acceptance drift even if
      // the service's immediate verification was clean.
      const drifted: DriftAcceptanceApplyDto = {
        ...result,
        ok: false,
        stateDisposition: "recovery-pending",
        errors: [
          {
            code: "post-acceptance-drift",
            message:
              "Post-commit reconciliation is not clean; metadata is committed and cannot be rolled back.",
          },
        ],
      };
      return jsonNoCors(
        {
          ok: false,
          apply: drifted,
          error: { code: "post-acceptance-drift", message: drifted.errors[0]!.message },
        },
        500,
      );
    }
  }

  if (!result.ok) {
    // Post-commit drift is reported, never hidden.
    const first = result.errors[0];
    const status = first?.code === "post-acceptance-drift" ? 500 : 409;
    return jsonNoCors({ ok: false, apply: result, error: { code: first?.code ?? "state-conflict", message: result.errors.map((e) => e.message).join("; ") } }, status);
  }
  return jsonNoCors({ ok: true, apply: result });
}
