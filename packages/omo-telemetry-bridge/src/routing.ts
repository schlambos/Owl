/**
 * HTTP routing for the OMO telemetry bridge (Slice 17, hardened).
 *
 * Separated from the plugin entry point (`index.ts`) so that the default
 * plugin module does not export named functions that upstream could treat as
 * plugin candidates.
 *
 * - `GET /telemetry` → full v3 {@link TelemetrySnapshot}
 * - `GET /health`    → health document with schema version from constant
 * - non-GET on `/health` or `/telemetry` → `405 Method Not Allowed`
 * - anything else → `404 Not Found`
 *
 * No CORS headers on any response. Never throws into the event loop.
 */

import {
  captureBridgeCapabilities,
  captureTelemetrySnapshot,
  TELEMETRY_SCHEMA_VERSION,
  type BridgeIdentity,
} from "./stores";
import type { BridgeFetchHandler } from "./lifecycle";

/**
 * Build the request handler. GET-only on known endpoints; 405 for non-GET on
 * known endpoints; 404 otherwise. No CORS. Never throws into the event loop.
 *
 * The schema version in `/health` is always read from the
 * `TELEMETRY_SCHEMA_VERSION` constant — never hardcoded.
 */
export function buildBridgeFetchHandler(
  identity: BridgeIdentity | undefined,
  bound: boolean,
): BridgeFetchHandler {
  return (request: Request): Response => {
    try {
      const url = new URL(request.url);
      const isHealth = url.pathname === "/health";
      const isTelemetry = url.pathname === "/telemetry";

      if (isHealth || isTelemetry) {
        if (request.method !== "GET") {
          return new Response("method not allowed", {
            status: 405,
            headers: { Allow: "GET" },
          });
        }
        if (isTelemetry) {
          return Response.json(
            captureTelemetrySnapshot(undefined, identity, true),
          );
        }
        // /health — schema version from constant, never hardcoded.
        return Response.json({
          ok: true,
          schemaVersion: TELEMETRY_SCHEMA_VERSION,
          bound,
          capabilities: captureBridgeCapabilities(),
          ...(identity ? { pluginInstanceId: identity.pluginInstanceId } : {}),
        });
      }

      return new Response("not found", { status: 404 });
    } catch (error) {
      // Never throw into OpenCode's event loop.
      console.error(
        "[omo-telemetry-bridge] request handling failed",
        error,
      );
      return new Response("internal error", { status: 500 });
    }
  };
}