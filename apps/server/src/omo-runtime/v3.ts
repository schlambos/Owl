/**
 * Slice 17 v3 telemetry bridge sanitizer and verifier.
 *
 * Mirrors the hardened bridge schema v3 exactly
 * (packages/omo-telemetry-bridge/src/stores.ts) and sanitizes it. Only
 * verified v3 may become current-generation authoritative; legacy v1/v2 are
 * accepted for historical/unverified display only.
 *
 * Security:
 * - GET only (enforced by the client).
 * - Loopback URL validation (enforced by the manager/client).
 * - Bounded payloads/timeouts (enforced by the client).
 * - This sanitizer rejects disallowed/unknown sensitive keys and never
 *   surfaces raw nonce/token/provider credential/environment/terminal
 *   content. Errors are redacted.
 */

import {
  OMO_BRIDGE_SCHEMA_VERSION_V3,
  OMO_BRIDGE_LEGACY_SCHEMA_VERSIONS,
  type OmoBridgeCapabilities,
  type OmoBridgeHealth,
  type OmoBridgeIdentity,
  type OmoBridgeStoreAvailability,
  type OmoBridgeStores,
} from "./types";

/** Exact set of identity fields allowed in v3. */
const IDENTITY_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "pluginInstanceId",
  "startupTimestamp",
  "canonicalOrigin",
  "nonceFingerprint",
  "transportMode",
  "bridgePackageVersion",
  "schemaVersion",
  "capturedAt",
]);

/** Exact set of capabilities fields allowed in v3. */
const CAPABILITIES_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "fallbackInProgress",
  "continuationGate",
  "multiplexerManager",
  "cmuxStore",
  "runtimePreset",
  "workerReuse",
  "terminalCapture",
]);

/** Exact set of health fields allowed in v3. */
const HEALTH_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "ok",
  "schemaVersion",
  "bound",
  "capabilities",
  "pluginInstanceId",
]);

/** Exact set of top-level telemetry payload fields allowed in v3. */
const TELEMETRY_PAYLOAD_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "telemetrySchemaVersion",
  "capturedAt",
  "stores",
  "identity",
  "capabilities",
]);

/** Cap for all emitted arrays and map entries. */
export const RECORD_CAP = 100;

/** Maximum string length for bounded string fields. */
const MAX_STRING_LEN = 200;

/** Maximum bridge package version length. */
const MAX_VERSION_LEN = 64;

/** Exact store availability enum values. */
const STORE_AVAILABILITY_VALUES: ReadonlySet<OmoBridgeStoreAvailability> =
  new Set(["present", "absent", "malformed"]);

/** Sensitive key patterns that must never appear in sanitized output. */
const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  /prompt/i,
  /authorization/i,
  /authheader/i,
  /api[-_]?key/i,
  /token/i,
  /secret/i,
  /password/i,
  /cookie/i,
  /^env$/i,
  /environment/i,
  /private[-_]?key/i,
  /nonce$/i, // raw nonce never appears; only nonceFingerprint (suffix differs)
  /scrollback/i,
  /pty/i,
  /terminal[-_]?(?:output|buffer|data|content|stream|log)/i, // terminal content, not the terminalCapture flag
];

export class BridgeV3ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeV3ParseError";
  }
}

/** Check a string is a valid UUID (v4-ish, hex + dashes). */
function isUuidLike(value: unknown): value is string {
  if (typeof value !== "string") return false;
  // crypto.randomUUID() emits 8-4-4-4-12 hex dashes.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

/** Check a string is exactly 64 lowercase SHA-256 hex characters. */
function isSha256Hex(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return /^[0-9a-f]{64}$/.test(value);
}

/** Check a value is a finite number. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Check a value is a plain object record (not array/null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject unknown/sensitive keys at the top level of a record. */
function assertAllowedKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new BridgeV3ParseError(
        `v3 ${path} contains non-whitelisted field "${key}"`,
      );
    }
  }
  assertNoSensitiveKeys(obj, path);
}

/** Deep-scan for forbidden key names. */
function assertNoSensitiveKeys(value: unknown, path: string): void {
  if (value == null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSensitiveKeys(v, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    for (const pat of SENSITIVE_KEY_PATTERNS) {
      if (pat.test(k)) {
        throw new BridgeV3ParseError(
          `v3 ${path} contains disallowed key "${k}"`,
        );
      }
    }
    assertNoSensitiveKeys(v, `${path}.${k}`);
  }
}

/**
 * Sanitize a v3 bridge identity. Throws BridgeV3ParseError on any
 * non-whitelisted field, sensitive key, or shape violation. Returns the
 * sanitized identity with only source-verifiable fields.
 */
export function sanitizeBridgeIdentity(raw: unknown): OmoBridgeIdentity {
  if (!isRecord(raw)) {
    throw new BridgeV3ParseError("v3 identity is not a record");
  }
  assertAllowedKeys(raw, IDENTITY_ALLOWED_KEYS, "identity");

  const pluginInstanceId = raw["pluginInstanceId"];
  if (!isUuidLike(pluginInstanceId)) {
    throw new BridgeV3ParseError(
      "v3 identity.pluginInstanceId is not a valid UUID",
    );
  }

  const startupTimestamp = raw["startupTimestamp"];
  if (!isFiniteNumber(startupTimestamp)) {
    throw new BridgeV3ParseError(
      "v3 identity.startupTimestamp is not a finite number",
    );
  }

  const transportMode = raw["transportMode"];
  if (transportMode !== "loopback-http") {
    throw new BridgeV3ParseError(
      "v3 identity.transportMode is not loopback-http",
    );
  }

  const schemaVersion = raw["schemaVersion"];
  if (schemaVersion !== OMO_BRIDGE_SCHEMA_VERSION_V3) {
    throw new BridgeV3ParseError(
      "v3 identity.schemaVersion is not 3",
    );
  }

  const capturedAt = raw["capturedAt"];
  if (!isFiniteNumber(capturedAt)) {
    throw new BridgeV3ParseError(
      "v3 identity.capturedAt is not a finite number",
    );
  }

  const out: OmoBridgeIdentity = {
    pluginInstanceId,
    startupTimestamp,
    transportMode: "loopback-http",
    schemaVersion: OMO_BRIDGE_SCHEMA_VERSION_V3,
    capturedAt,
  };

  const canonicalOrigin = raw["canonicalOrigin"];
  if (canonicalOrigin !== undefined) {
    if (typeof canonicalOrigin !== "string" || canonicalOrigin.length > 200) {
      throw new BridgeV3ParseError(
        "v3 identity.canonicalOrigin is not a bounded string",
      );
    }
    out.canonicalOrigin = canonicalOrigin;
  }

  const nonceFingerprint = raw["nonceFingerprint"];
  if (nonceFingerprint !== undefined) {
    if (!isSha256Hex(nonceFingerprint)) {
      throw new BridgeV3ParseError(
        "v3 identity.nonceFingerprint is not 64 lowercase hex chars",
      );
    }
    out.nonceFingerprint = nonceFingerprint;
  }

  const bridgePackageVersion = raw["bridgePackageVersion"];
  if (bridgePackageVersion !== undefined) {
    if (
      typeof bridgePackageVersion !== "string" ||
      bridgePackageVersion.length > 64
    ) {
      throw new BridgeV3ParseError(
        "v3 identity.bridgePackageVersion is not a bounded string",
      );
    }
    out.bridgePackageVersion = bridgePackageVersion;
  }

  return out;
}

/**
 * Sanitize a v3 capabilities report. Throws BridgeV3ParseError on any
 * non-whitelisted field, sensitive key, or shape violation.
 */
export function sanitizeBridgeCapabilities(raw: unknown): OmoBridgeCapabilities {
  if (!isRecord(raw)) {
    throw new BridgeV3ParseError("v3 capabilities is not a record");
  }
  assertAllowedKeys(raw, CAPABILITIES_ALLOWED_KEYS, "capabilities");

  const pick = (key: string): OmoBridgeStoreAvailability => {
    const v = raw[key];
    if (!STORE_AVAILABILITY_VALUES.has(v as OmoBridgeStoreAvailability)) {
      throw new BridgeV3ParseError(
        `v3 capabilities.${key} is not present|absent|malformed`,
      );
    }
    return v as OmoBridgeStoreAvailability;
  };

  const runtimePreset = raw["runtimePreset"];
  if (runtimePreset !== false) {
    throw new BridgeV3ParseError("v3 capabilities.runtimePreset is not false");
  }
  const workerReuse = raw["workerReuse"];
  if (workerReuse !== false) {
    throw new BridgeV3ParseError("v3 capabilities.workerReuse is not false");
  }
  const terminalCapture = raw["terminalCapture"];
  if (terminalCapture !== false) {
    throw new BridgeV3ParseError(
      "v3 capabilities.terminalCapture is not false",
    );
  }

  return {
    fallbackInProgress: pick("fallbackInProgress"),
    continuationGate: pick("continuationGate"),
    multiplexerManager: pick("multiplexerManager"),
    cmuxStore: pick("cmuxStore"),
    runtimePreset: false,
    workerReuse: false,
    terminalCapture: false,
  };
}

/**
 * Sanitize a v3 health document. Throws BridgeV3ParseError on any
 * non-whitelisted field, sensitive key, or shape violation.
 */
export function sanitizeBridgeHealth(raw: unknown): OmoBridgeHealth {
  if (!isRecord(raw)) {
    throw new BridgeV3ParseError("v3 health is not a record");
  }
  assertAllowedKeys(raw, HEALTH_ALLOWED_KEYS, "health");

  const ok = raw["ok"];
  if (typeof ok !== "boolean") {
    throw new BridgeV3ParseError("v3 health.ok is not a boolean");
  }
  const schemaVersion = raw["schemaVersion"];
  if (schemaVersion !== OMO_BRIDGE_SCHEMA_VERSION_V3) {
    throw new BridgeV3ParseError("v3 health.schemaVersion is not 3");
  }
  const bound = raw["bound"];
  if (typeof bound !== "boolean") {
    throw new BridgeV3ParseError("v3 health.bound is not a boolean");
  }
  const capabilities = sanitizeBridgeCapabilities(raw["capabilities"]);

  const out: OmoBridgeHealth = {
    ok,
    schemaVersion: OMO_BRIDGE_SCHEMA_VERSION_V3,
    bound,
    capabilities,
  };

  const pluginInstanceId = raw["pluginInstanceId"];
  if (pluginInstanceId !== undefined) {
    if (!isUuidLike(pluginInstanceId)) {
      throw new BridgeV3ParseError(
        "v3 health.pluginInstanceId is not a valid UUID",
      );
    }
    out.pluginInstanceId = pluginInstanceId;
  }

  return out;
}

/** Result of parsing a raw telemetry payload. */
export interface ParsedTelemetry {
  /** Schema version reported by the payload (1, 2, or 3). */
  schemaVersion: number;
  /** Raw stores payload (sanitized by the existing v1/v2 sanitizer). */
  stores: unknown;
  /** v3 identity, present only when schemaVersion is 3 and valid. */
  identity?: OmoBridgeIdentity;
  /** v3 capabilities, present only when schemaVersion is 3 and valid. */
  capabilities?: OmoBridgeCapabilities;
  /** v3 capturedAt, present only when schemaVersion is 3 and valid. */
  capturedAt?: number;
  /** Whether this is a verified v3 payload. */
  isV3: boolean;
}

/**
 * Parse a raw telemetry JSON payload into a structured result. v1/v2
 * payloads are accepted for historical display only (isV3=false); only v3
 * payloads with valid identity+capabilities are marked isV3=true.
 *
 * Never throws on legacy payloads — returns isV3=false. Throws
 * BridgeV3ParseError only when a payload CLAIMS to be v3 but is malformed
 * (fail-closed: a malformed v3 must not silently downgrade to legacy).
 */
export function parseTelemetryPayload(raw: unknown): ParsedTelemetry {
  if (!isRecord(raw)) {
    throw new BridgeV3ParseError("telemetry payload is not a record");
  }

  const schemaVersion = raw["telemetrySchemaVersion"];
  if (typeof schemaVersion !== "number") {
    throw new BridgeV3ParseError(
      "telemetry payload missing telemetrySchemaVersion",
    );
  }

  const stores = raw["stores"];
  const capturedAt = raw["capturedAt"];

  // Legacy v1/v2: accept for display only.
  if (OMO_BRIDGE_LEGACY_SCHEMA_VERSIONS.has(schemaVersion)) {
    return {
      schemaVersion,
      stores,
      isV3: false,
    };
  }

  // v3: must carry valid identity + capabilities. Enforce top-level whitelist.
  if (schemaVersion !== OMO_BRIDGE_SCHEMA_VERSION_V3) {
    throw new BridgeV3ParseError(
      `telemetry payload schemaVersion ${schemaVersion} is not accepted`,
    );
  }

  // Top-level whitelist: reject unknown/sensitive keys before parsing deeper.
  assertAllowedKeys(raw, TELEMETRY_PAYLOAD_ALLOWED_KEYS, "telemetry payload");

  // Malformed v3 fails closed — does NOT silently downgrade to legacy.
  const identity = sanitizeBridgeIdentity(raw["identity"]);
  const capabilities = sanitizeBridgeCapabilities(raw["capabilities"]);

  if (!isFiniteNumber(capturedAt)) {
    throw new BridgeV3ParseError(
      "v3 telemetry payload capturedAt is not a finite number",
    );
  }

  return {
    schemaVersion: OMO_BRIDGE_SCHEMA_VERSION_V3,
    stores: raw["stores"],
    identity,
    capabilities,
    capturedAt,
    isV3: true,
  };
}

/** Result of verifying a v3 telemetry response against expected identity. */
export interface VerifiedV3Result {
  /** Verified v3 identity. */
  identity: OmoBridgeIdentity;
  /** Verified v3 capabilities. */
  capabilities: OmoBridgeCapabilities;
  /** Whether the verification passed. */
  ok: boolean;
  /** Reason for failure (redacted, no raw secrets). */
  reason?: string;
}

/**
 * Verify a parsed v3 telemetry payload against the expected identity.
 *
 * Checks (per spec):
 * - schemaVersion is 3 (telemetry + identity).
 * - transportMode is exactly "loopback-http".
 * - expected fingerprint matches exactly (when expected is provided).
 * - canonicalOrigin equals the canonical OpenCode origin (when expected is
 *   provided).
 * - pluginInstanceId matches the health response instance (when
 *   healthInstanceId is provided).
 *
 * Store availability absent/malformed degrades capabilities but does NOT
 * invalidate identity. Package version is advisory.
 */
export function verifyV3Identity(
  parsed: ParsedTelemetry,
  expected: {
    expectedFingerprint?: string;
    canonicalOrigin?: string;
    healthInstanceId?: string;
  } = {},
): VerifiedV3Result {
  if (!parsed.isV3 || !parsed.identity || !parsed.capabilities) {
    return {
      identity: parsed.identity!,
      capabilities: parsed.capabilities!,
      ok: false,
      reason: "not a v3 payload",
    };
  }

  const id = parsed.identity;

  if (id.schemaVersion !== OMO_BRIDGE_SCHEMA_VERSION_V3) {
    return {
      identity: id,
      capabilities: parsed.capabilities,
      ok: false,
      reason: "identity schemaVersion is not 3",
    };
  }

  if (id.transportMode !== "loopback-http") {
    return {
      identity: id,
      capabilities: parsed.capabilities,
      ok: false,
      reason: "transportMode is not loopback-http",
    };
  }

  // Exactness: if an expected fingerprint is supplied, missing OR unequal
  // identity fingerprint fails. Not just unequal.
  if (
    expected.expectedFingerprint !== undefined &&
    id.nonceFingerprint !== expected.expectedFingerprint
  ) {
    return {
      identity: id,
      capabilities: parsed.capabilities,
      ok: false,
      reason: id.nonceFingerprint === undefined
        ? "nonce fingerprint missing (expected present)"
        : "nonce fingerprint mismatch",
    };
  }

  // Exactness: if expected canonical origin is supplied, missing OR unequal
  // origin fails. Not just unequal.
  if (
    expected.canonicalOrigin !== undefined &&
    id.canonicalOrigin !== expected.canonicalOrigin
  ) {
    return {
      identity: id,
      capabilities: parsed.capabilities,
      ok: false,
      reason: id.canonicalOrigin === undefined
        ? "canonicalOrigin missing (expected present)"
        : "canonicalOrigin mismatch",
    };
  }

  // Health instance must match exactly when supplied.
  if (
    expected.healthInstanceId !== undefined &&
    id.pluginInstanceId !== expected.healthInstanceId
  ) {
    return {
      identity: id,
      capabilities: parsed.capabilities,
      ok: false,
      reason: "pluginInstanceId differs from health response",
    };
  }

  return {
    identity: id,
    capabilities: parsed.capabilities,
    ok: true,
  };
}

// ── Store sanitizer (single source of truth, reused by client + manager) ──

/**
 * Whitelist-only pass-through of bridge store fields (defensive). This is
 * the SINGLE store sanitizer reused by both OmoBridgeClient and
 * TelemetryBridgeManager. Unknown/sensitive keys are dropped. Strings,
 * counts, and arrays are capped. Never surfaces raw nonce/token/provider
 * credential/environment/terminal content.
 */
export function sanitizeBridgeStores(raw: unknown): OmoBridgeStores | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const out: OmoBridgeStores = {};

  if (Array.isArray(r.fallbackInProgressSessionIDs)) {
    out.fallbackInProgressSessionIDs = r.fallbackInProgressSessionIDs.filter(
      (x): x is string => typeof x === "string",
    ).slice(0, RECORD_CAP);
  }

  const gate = r.continuationGate;
  if (gate && typeof gate === "object") {
    const g = gate as Record<string, unknown>;
    const cg: NonNullable<OmoBridgeStores["continuationGate"]> = {};
    if (g.attemptCounts && typeof g.attemptCounts === "object") {
      cg.attemptCounts = {};
      const entries = Object.entries(g.attemptCounts as Record<string, unknown>);
      for (const [k, v] of entries.slice(0, RECORD_CAP)) {
        // Bridge serializePrimitive (stores.ts:124-133) emits number OR string.
        if (typeof v === "number" || typeof v === "string") cg.attemptCounts[k] = v;
      }
    }
    if (g.lastRearmIdentity && typeof g.lastRearmIdentity === "object") {
      cg.lastRearmIdentity = {};
      const entries = Object.entries(g.lastRearmIdentity as Record<string, unknown>);
      for (const [k, v] of entries.slice(0, RECORD_CAP)) {
        if (typeof v === "string") cg.lastRearmIdentity[k] = v;
      }
    }
    if (Object.keys(cg).length > 0) out.continuationGate = cg;
  }

  const mux = r.multiplexer;
  if (mux && typeof mux === "object") {
    const m = mux as Record<string, unknown>;
    const cm: NonNullable<OmoBridgeStores["multiplexer"]> = {};
    if (typeof m.sessionsCount === "number") cm.sessionsCount = m.sessionsCount;
    if (typeof m.knownSessionsCount === "number") {
      cm.knownSessionsCount = m.knownSessionsCount;
    }
    if (typeof m.spawningCount === "number") cm.spawningCount = m.spawningCount;
    if (typeof m.closingCount === "number") cm.closingCount = m.closingCount;
    if (typeof m.permanentlyClosedCount === "number") {
      cm.permanentlyClosedCount = m.permanentlyClosedCount;
    }
    if (Object.keys(cm).length > 0) out.multiplexer = cm;
  }

  const cmux = r.cmux;
  if (cmux && typeof cmux === "object") {
    const c = cmux as Record<string, unknown>;
    if (typeof c.recordCount === "number") out.cmux = { recordCount: c.recordCount };
  }

  // v2 whitelisted records (Slice 16). Preserve aggregates above; add records.
  sanitizeMultiplexerRecords(r, out);
  sanitizeCmuxRecords(r, out);

  return Object.keys(out).length > 0 ? out : undefined;
}

/** v2: whitelisted multiplexer session-manager records (capped 100, deduped). */
function sanitizeMultiplexerRecords(
  raw: Record<string, unknown>,
  out: OmoBridgeStores,
): void {
  const recordsRaw = raw.multiplexerRecords;
  if (Array.isArray(recordsRaw)) {
    const seen = new Set<string>();
    const records: NonNullable<OmoBridgeStores["multiplexerRecords"]>[number][] = [];
    for (const entry of recordsRaw) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const sessionId = typeof e.sessionId === "string" ? e.sessionId : undefined;
      if (!sessionId || seen.has(sessionId)) continue;
      seen.add(sessionId);
      records.push({
        sessionId,
        ...(typeof e.paneId === "string" ? { paneId: e.paneId } : {}),
        ...(typeof e.parentSessionId === "string" ? { parentSessionId: e.parentSessionId } : {}),
        ...(typeof e.title === "string" ? { title: e.title } : {}),
        known: e.known === true,
        spawning: e.spawning === true,
        closing: e.closing === true,
        permanentlyClosed: e.permanentlyClosed === true,
      });
    }
    records.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    if (records.length > 0) out.multiplexerRecords = records.slice(0, RECORD_CAP);
  }

  const idsRaw = raw.multiplexerCollectionIds;
  if (idsRaw && typeof idsRaw === "object") {
    const i = idsRaw as Record<string, unknown>;
    const ids: NonNullable<OmoBridgeStores["multiplexerCollectionIds"]> = {};
    const filterStrings = (v: unknown): string[] | undefined => {
      if (!Array.isArray(v)) return undefined;
      const out = v.filter((x): x is string => typeof x === "string");
      return out.length > 0 ? [...new Set(out)].sort().slice(0, RECORD_CAP) : undefined;
    };
    const known = filterStrings(i.known);
    const spawning = filterStrings(i.spawning);
    const closing = filterStrings(i.closing);
    const permanentlyClosed = filterStrings(i.permanentlyClosed);
    if (known) ids.known = known;
    if (spawning) ids.spawning = spawning;
    if (closing) ids.closing = closing;
    if (permanentlyClosed) ids.permanentlyClosed = permanentlyClosed;
    if (Object.keys(ids).length > 0) out.multiplexerCollectionIds = ids;
  }
}

/** v2: whitelisted cmux session-store records (capped 100, deduped). */
function sanitizeCmuxRecords(
  raw: Record<string, unknown>,
  out: OmoBridgeStores,
): void {
  const recordsRaw = raw.cmuxRecords;
  if (!Array.isArray(recordsRaw)) return;
  const seen = new Set<string>();
  const records: NonNullable<OmoBridgeStores["cmuxRecords"]>[number][] = [];
  for (const entry of recordsRaw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const sessionId = typeof e.sessionId === "string" ? e.sessionId : undefined;
    if (!sessionId || seen.has(sessionId)) continue;
    const spawnState =
      e.spawnState === "known" || e.spawnState === "spawning" || e.spawnState === "attached" || e.spawnState === "failed"
        ? (e.spawnState as "known" | "spawning" | "attached" | "failed")
        : undefined;
    const lifecycle =
      e.lifecycle === "active" || e.lifecycle === "deleted" || e.lifecycle === "orphaned"
        ? (e.lifecycle as "active" | "deleted" | "orphaned")
        : undefined;
    if (!spawnState || !lifecycle) continue;
    seen.add(sessionId);
    records.push({
      sessionId,
      ...(typeof e.parentSessionId === "string" ? { parentSessionId: e.parentSessionId } : {}),
      ...(typeof e.paneId === "string" ? { paneId: e.paneId } : {}),
      ...(typeof e.title === "string" ? { title: e.title } : {}),
      spawnState,
      lifecycle,
      panePresent: e.paneId !== undefined && typeof e.paneId === "string",
    });
  }
  records.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  if (records.length > 0) out.cmuxRecords = records.slice(0, RECORD_CAP);
}