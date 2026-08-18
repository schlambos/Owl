/**
 * Slice 17 hardened — Strict effective-plugin / raw-config extractor.
 *
 * Oracle decision 5: plugin entry is string OR readonly [string, plain options].
 * Remove {path, options} support. Model form separately from identity kind.
 * Parse only allowlisted bridge options: port, activationNonce, transport.
 * Options use activationNonce not nonce. Non-bridge options never copied.
 * Any unsupported effective entry invalidates whole effective view.
 *
 * Oracle decision 6: fingerprint is exact SHA-256 UTF-8, 64 lowercase hex.
 * Test vector: sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad.
 *
 * Raw OpenCode config exists in exactly ONE function. Only plugin array
 * is copied. Raw nonce is discarded immediately after fingerprinting.
 */

import { createHash, randomBytes } from "node:crypto";
import type {
  BridgeError,
  BridgeFingerprint,
  BridgeOptions,
  EffectivePluginEntry,
  EffectivePluginView,
  IdentityKind,
  PluginForm,
} from "./types";
import { detectIdentityKind, normalizePathIdentity, resolveCanonicalBridge } from "./canonical";

import { BRIDGE_PORT_RANGE_START, BRIDGE_PORT_RANGE_END } from "./types";

/**
 * Compute the exact SHA-256 fingerprint of a raw nonce.
 * 64-char lowercase hex. The raw nonce cannot be recovered.
 *
 * Oracle decision 6: exact SHA-256 UTF-8, 64 lowercase hex.
 * Test: sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
 */
export function fingerprintNonce(rawNonce: string): string {
  return createHash("sha256").update(rawNonce, "utf-8").digest("hex");
}

/**
 * Generate a cryptographically random nonce: randomBytes(32).toString("hex").
 * 64-char lowercase hex.
 */
export function generateNonce(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Extract a sanitized EffectivePluginView from raw OpenCode config.
 *
 * `rawConfig` is consumed here and NEVER returned, cached, or logged.
 * Only the plugin array is read. Any unsupported entry invalidates the
 * whole view (returns invalid: true).
 */
export function extractEffectivePluginView(
  rawConfig: unknown,
  authorizedRoots: string[],
  projectRoot: string,
): EffectivePluginView & { errors?: BridgeError[] } {
  const errors: BridgeError[] = [];

  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    errors.push({ code: "plugin-shape-unsupported", message: "OpenCode config root is not an object." });
    return { entries: [], unavailable: true, invalid: true, errors };
  }

  const root = rawConfig as Record<string, unknown>;
  const plugin = root["plugin"];

  if (plugin === undefined || plugin === null) {
    return { entries: [], unavailable: false, invalid: false };
  }

  if (!Array.isArray(plugin)) {
    errors.push({ code: "plugin-shape-unsupported", message: "plugin property is not an array." });
    return { entries: [], unavailable: true, invalid: true, errors };
  }

  const entries: EffectivePluginEntry[] = [];
  let invalid = false;

  for (const raw of plugin) {
    const extracted = extractOneEntry(raw, authorizedRoots, projectRoot);
    if (extracted.error) {
      errors.push(extracted.error);
      invalid = true;
      continue;
    }
    if (extracted.entry) entries.push(extracted.entry);
  }

  return { entries, unavailable: false, invalid, errors };
}

function extractOneEntry(
  raw: unknown,
  authorizedRoots: string[],
  projectRoot: string,
):
  | { entry: EffectivePluginEntry; error?: undefined }
  | { entry?: undefined; error: BridgeError } {
  // Form: string
  if (typeof raw === "string") {
    const identityKind = detectIdentityKind(raw);
    if (identityKind === null) {
      return {
        error: {
          code: "plugin-shape-unsupported",
          message: "Plugin entry string is not a recognized identity kind.",
        },
      };
    }
    const bridge = tryBridgeFingerprint(raw, undefined, authorizedRoots, projectRoot, "string");
    return {
      entry: {
        form: "string",
        effectiveIdentity: raw,
        identityKind,
        bridge: bridge ?? undefined,
      },
    };
  }

  // Form: tuple [string, options]
  if (Array.isArray(raw) && raw.length === 2 && typeof raw[0] === "string" && isPlainObject(raw[1])) {
    const identity = raw[0] as string;
    const options = raw[1] as Record<string, unknown>;
    const identityKind = detectIdentityKind(identity);
    if (identityKind === null) {
      return {
        error: {
          code: "plugin-shape-unsupported",
          message: "Plugin tuple identity is not a recognized identity kind.",
        },
      };
    }
    const bridge = tryBridgeFingerprint(identity, options, authorizedRoots, projectRoot, "tuple");
    return {
      entry: {
        form: "tuple",
        effectiveIdentity: identity,
        identityKind,
        bridge: bridge ?? undefined,
      },
    };
  }

  // Unsupported form (including {path, options} which is now rejected)
  return {
    error: {
      code: "plugin-shape-unsupported",
      message: "Plugin entry is not string or [string, options] tuple.",
    },
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * When the identity resolves to the canonical bridge, extract ONLY
 * allowlisted fingerprint fields. Raw nonce is consumed and discarded.
 *
 * Oracle contract:
 *  - Effective bridge fingerprint includes `pluginForm` ("string" | "tuple")
 *  - Bare string proves only canonical bridge presence/form/transportMode,
 *    and has NO configuredPort/nonceFingerprint.
 *  - Tuple retains validated port + fingerprint ONLY when activationNonce is valid
 *    (exact string, length 16..256, hashes exact value without trimming).
 *  - Managed port must be within BRIDGE_PORT_RANGE_START..BRIDGE_PORT_RANGE_END.
 *  - Never default string to tuple.
 */
function tryBridgeFingerprint(
  identity: string,
  options: Record<string, unknown> | undefined,
  authorizedRoots: string[],
  projectRoot: string,
  form: "string" | "tuple",
): BridgeFingerprint | null {
  // Only path-like identities can be canonical bridge.
  const norm = normalizePathIdentity(identity, authorizedRoots);
  if (norm.path === null) return null;

  // Check canonical bridge equivalence via realpath.
  const canonicalCheck = resolveCanonicalBridge(identity, projectRoot, authorizedRoots);
  if (!canonicalCheck.isCanonical) return null;

  if (form === "string") {
    return {
      pluginForm: "string",
      registrationTransport: "env",
      transportMode: "loopback-http",
    };
  }

  // Form is tuple:
  const opts = options ?? {};
  const bridgeOptions = parseBridgeOptions(opts);

  // Validate activationNonce: exact string of length 16..256, hash exact value (no trim).
  let nonceFingerprint: string | undefined = undefined;
  const rawNonce = opts["activationNonce"];
  if (typeof rawNonce === "string" && rawNonce.length >= 16 && rawNonce.length <= 256) {
    nonceFingerprint = fingerprintNonce(rawNonce);
  }

  return {
    pluginForm: "tuple",
    port: bridgeOptions.port,
    registrationTransport: bridgeOptions.registrationTransport ?? "tuple",
    transportMode: "loopback-http",
    nonceFingerprint,
  };
}

/**
 * Parse only allowlisted bridge options: port, activationNonce, transport.
 * Managed port must be in range BRIDGE_PORT_RANGE_START..BRIDGE_PORT_RANGE_END (8788..8803).
 * Non-bridge options are never copied or compared.
 */
export function parseBridgeOptions(opts: Record<string, unknown>): BridgeOptions {
  const result: BridgeOptions = {};

  const portRaw = opts["port"];
  if (
    typeof portRaw === "number" &&
    Number.isInteger(portRaw) &&
    portRaw >= BRIDGE_PORT_RANGE_START &&
    portRaw <= BRIDGE_PORT_RANGE_END
  ) {
    result.port = portRaw;
  }

  const transportRaw = opts["transport"];
  if (transportRaw === "env" || transportRaw === "tuple") {
    result.registrationTransport = transportRaw;
  }

  return result;
}