/**
 * Loopback-only authenticated `POST /internal/shutdown` (desktop sidecar mode).
 *
 * The desktop shell (Tauri host process) receives an unpredictable per-launch
 * token that it must present here to request graceful shutdown. The route is
 * only registered when desktop mode is active (`OMO_CP_DESKTOP=1`).
 *
 * Security properties:
 * - only `POST`; any other method yields a generic 404 (the route pretends
 *   not to exist rather than advertising its semantics);
 * - the peer must be loopback (the server is loopback-bound in desktop mode,
 *   but the peer is rechecked defensively);
 * - the token is compared in constant time via `crypto.timingSafeEqual`;
 * - failures return a generic 403 without revealing which check failed;
 * - the token is accepted via `Authorization: Bearer <token>` or the
 *   `x-owl-shutdown-token` header.
 */

import { timingSafeEqual } from "node:crypto";

export interface InternalShutdownOptions {
  /** Per-launch secret from OMO_CP_SHUTDOWN_TOKEN. */
  token: string;
  /** Peer address as reported by the server, if available. */
  requestAddress: string | undefined;
  /** Invoked asynchronously after the 200 response is returned. */
  onShutdown: () => void;
}

function isLoopbackPeer(address: string | undefined): boolean {
  if (address === undefined) return false;
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address === "localhost"
  );
}

function extractToken(req: Request): string | undefined {
  const bearer = req.headers.get("authorization");
  if (bearer?.startsWith("Bearer ")) {
    const t = bearer.slice("Bearer ".length).trim();
    if (t) return t;
  }
  const direct = req.headers.get("x-owl-shutdown-token")?.trim();
  if (direct) return direct;
  return undefined;
}

function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf-8");
  const b = Buffer.from(expected, "utf-8");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/**
 * Handle `POST /internal/shutdown`. Assumes the caller already matched the
 * exact pathname and that desktop mode is active.
 */
export function handleInternalShutdown(
  req: Request,
  opts: InternalShutdownOptions,
): Response {
  const reject = (status: number) =>
    new Response(JSON.stringify({ error: "not found" }), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });

  if (req.method !== "POST") return reject(404);
  if (!isLoopbackPeer(opts.requestAddress)) return reject(403);

  const presented = extractToken(req);
  if (presented === undefined || !tokensMatch(presented, opts.token)) {
    return reject(403);
  }

  // Respond first, then run the graceful shutdown so the desktop shell
  // always observes the acknowledgement before the listener closes.
  setTimeout(() => opts.onShutdown(), 25);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
