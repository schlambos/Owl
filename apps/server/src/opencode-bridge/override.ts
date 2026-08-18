/**
 * Slice 17 hardened — OpenCode override config: OMO_BRIDGE_BASE_URL validation.
 *
 * Oracle decision 10: consolidate duplicate validators. Reject
 * userinfo/query/fragment and non-127.0.0.1. Expose only canonical
 * validated URL. In config.ts set omoBridgeBaseUrl undefined when invalid.
 *
 * Only http://127.0.0.1:<port> is accepted. Valid override opts out of
 * management. Absence is preserved.
 */

import type { BridgeOverrideStatus } from "./types";

export type { BridgeOverrideStatus };

/**
 * Validate a raw OMO_BRIDGE_BASE_URL value. Returns a structured status
 * that never throws. The raw URL is NOT echoed back when invalid.
 *
 * This is the SINGLE consolidated validator (oracle decision 10).
 * config.ts delegates to this function.
 */
export function validateBridgeOverride(
  raw: string | undefined,
): BridgeOverrideStatus {
  if (raw === undefined || raw.trim() === "") {
    return { present: false, invalid: false, optsOutOfManagement: false };
  }

  const trimmed = raw.trim();

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { present: true, invalid: true, invalidReason: "Override is not a valid URL.", optsOutOfManagement: false };
  }

  if (parsed.protocol !== "http:") {
    return { present: true, invalid: true, invalidReason: "Override protocol not allowed; only http: is accepted.", optsOutOfManagement: false };
  }

  // Oracle decision 10: only 127.0.0.1 (not localhost, not [::1]).
  if (parsed.hostname !== "127.0.0.1") {
    return { present: true, invalid: true, invalidReason: "Override host must be exactly 127.0.0.1.", optsOutOfManagement: false };
  }

  // Reject userinfo.
  if (parsed.username || parsed.password) {
    return { present: true, invalid: true, invalidReason: "Override must not carry userinfo.", optsOutOfManagement: false };
  }

  // Reject query.
  if (parsed.search) {
    return { present: true, invalid: true, invalidReason: "Override must not carry a query string.", optsOutOfManagement: false };
  }

  // Reject fragment.
  if (parsed.hash) {
    return { present: true, invalid: true, invalidReason: "Override must not carry a fragment.", optsOutOfManagement: false };
  }

  const portStr = parsed.port;
  if (!portStr) {
    return { present: true, invalid: true, invalidReason: "Override missing explicit port.", optsOutOfManagement: false };
  }
  const port = Number.parseInt(portStr, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { present: true, invalid: true, invalidReason: "Override port out of valid range.", optsOutOfManagement: false };
  }

  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    return { present: true, invalid: true, invalidReason: "Override must not carry a path.", optsOutOfManagement: false };
  }

  const canonical = `http://127.0.0.1:${port}`;
  return { present: true, invalid: false, url: canonical, port, optsOutOfManagement: true };
}