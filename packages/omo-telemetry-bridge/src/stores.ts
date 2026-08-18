/**
 * Read-only snapshot serialization for OMO-Slim's globalThis stores.
 *
 * Everything in this file is defensive by design:
 *
 * - Only the four whitelisted `Symbol.for` keys in {@link STORE_SYMBOLS} are
 *   ever looked up. Unknown symbols — including anything future OMO versions
 *   may add — are ignored by construction.
 * - Every store read verifies constructor shape (`Set`/`Map` `instanceof`,
 *   plain-object checks) before touching the value, and each reader is
 *   wrapped in its own try/catch. Nothing here may throw.
 * - Only primitive values (string/number/boolean/bigint) are serialized into
 *   snapshots. Objects, functions, symbols, `null`/`undefined`, and WeakMaps
 *   are dropped entirely.
 * - Reads never mutate the stores; they only iterate and count.
 *
 * This module has no runtime dependency (no Bun, no OpenCode imports) so it
 * can be unit-tested in isolation.
 */

/**
 * Schema version emitted with every snapshot. Bump on any shape change.
 *
 * v1: aggregate counts only.
 * v2 (Slice 16): adds capped (100), sorted, deduped whitelisted records/keys
 * for the multiplexer session-manager and cmux session stores. v1 aggregate
 * counts are preserved for backward compatibility.
 * v3 (Slice 17): adds `identity` (per-plugin-instance id, startup timestamp,
 * canonical OpenCode origin, nonce fingerprint, transport mode, bridge
 * package version, schema/capture time) and `capabilities` (per-store
 * availability for the four allowlisted stores plus explicit unavailable
 * flags for runtime preset, worker reuse, terminal capture). v1/v2 store
 * fields are preserved unchanged; the server sanitizer ignores unknown
 * top-level fields, so v3 is backward-compatible with v1/v2 consumers.
 */
export const TELEMETRY_SCHEMA_VERSION = 3;

/**
 * Whitelist of OMO globalThis stores this bridge is allowed to read.
 *
 * Citations refer to `oh-my-opencode-slim@2.2.10` `dist/index.js`
 * (verified against the installed copy).
 */
export const STORE_SYMBOLS = {
  /**
   * `Set<string>` of session IDs with an active foreground-fallback switch in
   * flight. Source: `getProcessFallbacksInProgress` —
   * `dist/index.js:26307-26315` (key declared at `dist/index.js:26309`).
   */
  fallbackInProgress: Symbol.for(
    "oh-my-opencode-slim.foreground-fallback.in-progress",
  ),
  /**
   * `{ attempts: Map, lastRearmIdentity: Map, messageObjectIdentity: WeakMap }`
   * continuation-attempt gate. Source: `getStore` —
   * `dist/index.js:27974-27985` (key declared at `dist/index.js:27972`).
   * The `messageObjectIdentity` WeakMap is never serialized (not iterable).
   */
  continuationAttemptGate: Symbol.for(
    "oh-my-opencode-slim.continuation-attempt-gate",
  ),
  /**
   * `Map` of multiplexer cmux session records. Source: `records` —
   * `dist/index.js:35669-35676` (key declared at `dist/index.js:35667`).
   */
  cmuxSessionStore: Symbol.for("oh-my-opencode-slim.cmux-session-store"),
  /**
   * `{ sessions: Map, knownSessions: Map, spawningSessions: Set,
   *   closingSessions: Map, permanentlyClosedSessions: Set }`
   * multiplexer session-manager shared state. Source: `getSharedState` —
   * `dist/index.js:36299-36312` (key declared at `dist/index.js:36299`).
   */
  multiplexerState: Symbol.for(
    "oh-my-opencode-slim.multiplexer-session-manager.state",
  ),
} as const;

/** Snapshot of the continuation-attempt gate (WeakMap members excluded). */
export interface ContinuationGateSnapshot {
  /** Serialized `attempts` map entries (primitive values only). */
  attemptCounts?: Record<string, number | string>;
  /** Serialized `lastRearmIdentity` map entries (stringified values). */
  lastRearmIdentity?: Record<string, string>;
}

/** Size-only snapshot of the multiplexer session-manager shared state. */
export interface MultiplexerSnapshot {
  sessionsCount?: number;
  knownSessionsCount?: number;
  spawningCount?: number;
  closingCount?: number;
  permanentlyClosedCount?: number;
}

/**
 * OMO-owned multiplexer session-manager record (v2).
 *
 * Exposes ONLY OMO-owned fields from the sessions Map values
 * (dist/index.js:36486-36493): sessionId, paneId, parentId, title plus exact
 * boolean collection membership. NEVER directory/owner/promise/raw object.
 * Pane ID is safe because the mapping is OMO-owned. Title comes from the
 * OMO-owned mapping, never from querying external panes.
 */
export interface MultiplexerSessionRecord {
  sessionId: string;
  paneId?: string;
  parentSessionId?: string;
  title?: string;
  known: boolean;
  spawning: boolean;
  closing: boolean;
  permanentlyClosed: boolean;
}

/**
 * OMO-owned cmux session-store record (v2, allowlist only).
 * Source: dist/multiplexer/cmux/session-state.d.ts:12-31.
 * Exposes sessionId=record.session, parentSessionId=record.parent, paneId,
 * title, spawnState, lifecycle, panePresent. No directory/owner/timestamps/
 * activity/intent/timers/promises.
 */
export interface CmuxSessionRecord {
  sessionId: string;
  parentSessionId?: string;
  paneId?: string;
  title?: string;
  spawnState: "known" | "spawning" | "attached" | "failed";
  lifecycle: "active" | "deleted" | "orphaned";
  panePresent: boolean;
}

/** All store snapshots; fields are omitted when a store is absent/malformed. */
export interface TelemetryStores {
  fallbackInProgressSessionIDs?: string[];
  continuationGate?: ContinuationGateSnapshot;
  cmux?: { recordCount: number };
  multiplexer?: MultiplexerSnapshot;
  /** v2: whitelisted session-manager records (capped 100, sorted, deduped). */
  multiplexerRecords?: MultiplexerSessionRecord[];
  /** v2: IDs in knownSessions/spawningSessions/closingSessions/
   * permanentlyClosedSessions when no sessions record exists for them. */
  multiplexerCollectionIds?: {
    known?: string[];
    spawning?: string[];
    closing?: string[];
    permanentlyClosed?: string[];
  };
  /** v2: whitelisted cmux session-store records (capped 100, sorted, deduped). */
  cmuxRecords?: CmuxSessionRecord[];
}

/** Full telemetry snapshot document served on `GET /telemetry`. */
export interface TelemetrySnapshot {
  telemetrySchemaVersion: number;
  capturedAt: number;
  stores: TelemetryStores;
  /** v3: bridge identity (per-plugin-instance). Omitted pre-v3. */
  identity?: BridgeIdentity;
  /** v3: capability-level availability. Omitted pre-v3. */
  capabilities?: BridgeCapabilities;
}

/* ------------------------------------------------------------------ */
/* Shape guards                                                        */
/* ------------------------------------------------------------------ */

function isSet(value: unknown): value is Set<unknown> {
  return value instanceof Set;
}

function isMap(value: unknown): value is Map<unknown, unknown> {
  return value instanceof Map;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Stricter plain-object check that excludes `Map`/`Set`/`Date`/`WeakMap` etc.
 * Used by the v3 capability classifier to distinguish a plain record store
 * (continuation gate, multiplexer state) from a `Map`/`Set` placed there by
 * mistake. The existing readers use {@link isRecord} and then probe members,
 * which naturally omits sub-fields on a Map (Map entries are not own props);
 * the classifier reports the top-level shape more precisely.
 */
function isPlainRecord(value: unknown): boolean {
  if (!isRecord(value)) return false;
  // Exclude built-in object kinds that are not plain records.
  if (
    value instanceof Map ||
    value instanceof Set ||
    value instanceof WeakMap ||
    value instanceof WeakSet ||
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Error
  ) {
    return false;
  }
  return true;
}

/** Size of a value that is genuinely a `Map` or `Set`; otherwise undefined. */
function sizeOf(value: unknown): number | undefined {
  if (isMap(value) || isSet(value)) return value.size;
  return undefined;
}

/**
 * Serialize a single map value. Only primitives survive:
 * strings and finite numbers pass through, booleans/bigints are stringified,
 * non-finite numbers are stringified (JSON would emit `null`), and
 * objects/functions/symbols/null/undefined are dropped (undefined).
 */
function serializePrimitive(value: unknown): string | number | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return undefined;
}

/** Read a symbol-keyed property off globalThis without ever throwing. */
function readGlobal(key: symbol): unknown {
  try {
    return (globalThis as unknown as Record<symbol, unknown>)[key];
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Caps and shared helpers                                             */
/* ------------------------------------------------------------------ */

/**
 * Cap for all emitted arrays and map entries (100). Applied consistently to
 * fallback session IDs, continuation gate maps, multiplexer/cmux records, and
 * collection ID lists.
 */
export const RECORD_CAP = 100;

/* ------------------------------------------------------------------ */
/* Store readers (each individually guarded)                           */
/* ------------------------------------------------------------------ */

/**
 * Session IDs with an active foreground-fallback switch in flight.
 * Non-string entries are filtered out. Capped at {@link RECORD_CAP}, sorted,
 * and deduped. Omitted (undefined) when the store is missing or not a `Set`.
 */
export function readFallbackInProgressSessionIDs(): string[] | undefined {
  try {
    const store = readGlobal(STORE_SYMBOLS.fallbackInProgress);
    if (!isSet(store)) return undefined;
    const seen = new Set<string>();
    const sessionIDs: string[] = [];
    for (const entry of store) {
      if (typeof entry === "string" && !seen.has(entry)) {
        seen.add(entry);
        sessionIDs.push(entry);
      }
    }
    sessionIDs.sort();
    return sessionIDs.slice(0, RECORD_CAP);
  } catch {
    return undefined;
  }
}

/**
 * Continuation-attempt gate snapshot. The `messageObjectIdentity` WeakMap is
 * skipped entirely. Sub-fields are omitted unless the corresponding member is
 * a real `Map`; entries are capped at {@link RECORD_CAP}, sorted by key, and
 * deduped. The whole snapshot is omitted when nothing survives.
 */
export function readContinuationGate(): ContinuationGateSnapshot | undefined {
  try {
    const store = readGlobal(STORE_SYMBOLS.continuationAttemptGate);
    if (!isRecord(store)) return undefined;

    const snapshot: ContinuationGateSnapshot = {};

    const attempts = store["attempts"];
    if (isMap(attempts)) {
      const attemptCounts: Record<string, number | string> = {};
      const keys: string[] = [];
      for (const [key, value] of attempts) {
        if (typeof key !== "string") continue;
        if (key in attemptCounts) continue; // dedup by key
        const serialized = serializePrimitive(value);
        if (serialized !== undefined) {
          attemptCounts[key] = serialized;
          keys.push(key);
        }
      }
      keys.sort();
      const capped: Record<string, number | string> = {};
      for (const k of keys.slice(0, RECORD_CAP)) {
        capped[k] = attemptCounts[k]!;
      }
      snapshot.attemptCounts = capped;
    }

    const lastRearm = store["lastRearmIdentity"];
    if (isMap(lastRearm)) {
      const lastRearmIdentity: Record<string, string> = {};
      const keys: string[] = [];
      for (const [key, value] of lastRearm) {
        if (typeof key !== "string") continue;
        if (key in lastRearmIdentity) continue; // dedup by key
        const serialized = serializePrimitive(value);
        if (serialized !== undefined) {
          lastRearmIdentity[key] =
            typeof serialized === "string" ? serialized : String(serialized);
          keys.push(key);
        }
      }
      keys.sort();
      const capped: Record<string, string> = {};
      for (const k of keys.slice(0, RECORD_CAP)) {
        capped[k] = lastRearmIdentity[k]!;
      }
      snapshot.lastRearmIdentity = capped;
    }

    if (
      snapshot.attemptCounts === undefined &&
      snapshot.lastRearmIdentity === undefined
    ) {
      return undefined;
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

/**
 * cmux session-store snapshot (record count only — record contents are
 * objects and are never serialized). Omitted unless the store is a `Map`.
 */
export function readCmuxSnapshot(): { recordCount: number } | undefined {
  try {
    const store = readGlobal(STORE_SYMBOLS.cmuxSessionStore);
    if (!isMap(store)) return undefined;
    return { recordCount: store.size };
  } catch {
    return undefined;
  }
}

/**
 * Multiplexer session-manager snapshot (collection sizes only). Each count is
 * emitted only when the corresponding member is a real `Map`/`Set`; the whole
 * snapshot is omitted when the store is missing or nothing survives.
 */
export function readMultiplexerSnapshot(): MultiplexerSnapshot | undefined {
  try {
    const store = readGlobal(STORE_SYMBOLS.multiplexerState);
    if (!isRecord(store)) return undefined;

    const snapshot: MultiplexerSnapshot = {};

    const sessionsCount = sizeOf(store["sessions"]);
    if (sessionsCount !== undefined) snapshot.sessionsCount = sessionsCount;

    const knownSessionsCount = sizeOf(store["knownSessions"]);
    if (knownSessionsCount !== undefined) {
      snapshot.knownSessionsCount = knownSessionsCount;
    }

    const spawningCount = sizeOf(store["spawningSessions"]);
    if (spawningCount !== undefined) snapshot.spawningCount = spawningCount;

    const closingCount = sizeOf(store["closingSessions"]);
    if (closingCount !== undefined) snapshot.closingCount = closingCount;

    const permanentlyClosedCount = sizeOf(store["permanentlyClosedSessions"]);
    if (permanentlyClosedCount !== undefined) {
      snapshot.permanentlyClosedCount = permanentlyClosedCount;
    }

    if (Object.keys(snapshot).length === 0) return undefined;
    return snapshot;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* v2 whitelisted record readers (Slice 16)                            */
/* ------------------------------------------------------------------ */

function isString(v: unknown): v is string {
  return typeof v === "string";
}

/**
 * Read a `Set<string>` member as a string array (filtered). Returns undefined
 * when the member is absent or not a Set.
 */
function readStringSet(member: unknown): string[] | undefined {
  if (!isSet(member)) return undefined;
  const out: string[] = [];
  for (const entry of member) {
    if (isString(entry)) out.push(entry);
  }
  return out;
}

/** Read a `Map<string, unknown>` member keys as a string array. */
function readMapKeys(member: unknown): string[] | undefined {
  if (!isMap(member)) return undefined;
  const out: string[] = [];
  for (const key of member.keys()) {
    if (isString(key)) out.push(key);
  }
  return out;
}

/**
 * v2: whitelisted multiplexer session-manager records.
 *
 * sessions Map values (dist/index.js:36486-36493) contain sessionId, paneId,
 * parentId, title, directory, ownerInstanceId. We expose ONLY sessionId,
 * paneId, parentId, title plus exact boolean collection membership. NEVER
 * directory/owner/promise/raw object.
 *
 * IDs in known/spawning/closing/permanentlyClosed that have no sessions record
 * are exposed via {@link readMultiplexerCollectionIds} (normalized into one
 * session record when practical by the server, not here).
 *
 * Capped at {@link RECORD_CAP}, sorted by sessionId, deduped. Never mutates
 * the store. Unknown/malformed entries are ignored.
 */
export function readMultiplexerRecords(): MultiplexerSessionRecord[] | undefined {
  try {
    const store = readGlobal(STORE_SYMBOLS.multiplexerState);
    if (!isRecord(store)) return undefined;

    const sessions = store["sessions"];
    if (!isMap(sessions)) return undefined;

    const knownSet = isSet(store["knownSessions"]) ? (store["knownSessions"] as Set<unknown>) : new Set<unknown>();
    const spawningSet = isSet(store["spawningSessions"]) ? (store["spawningSessions"] as Set<unknown>) : new Set<unknown>();
    const closingMap = isMap(store["closingSessions"]) ? (store["closingSessions"] as Map<unknown, unknown>) : new Map<unknown, unknown>();
    const permanentlyClosedSet = isSet(store["permanentlyClosedSessions"]) ? (store["permanentlyClosedSessions"] as Set<unknown>) : new Set<unknown>();

    const records: MultiplexerSessionRecord[] = [];
    const seen = new Set<string>();

    for (const [key, value] of sessions) {
      if (!isString(key)) continue;
      if (!isRecord(value)) continue;

      const sessionId = isString(value["sessionId"]) ? value["sessionId"] : key;
      // Dedup by emitted sessionId, not just Map key.
      if (seen.has(sessionId)) continue;
      const paneId = isString(value["paneId"]) ? value["paneId"] : undefined;
      const parentSessionId = isString(value["parentId"]) ? value["parentId"] : undefined;
      const title = isString(value["title"]) ? value["title"] : undefined;

      records.push({
        sessionId,
        ...(paneId !== undefined ? { paneId } : {}),
        ...(parentSessionId !== undefined ? { parentSessionId } : {}),
        ...(title !== undefined ? { title } : {}),
        known: knownSet.has(key),
        spawning: spawningSet.has(key),
        closing: closingMap.has(key),
        permanentlyClosed: permanentlyClosedSet.has(key),
      });
      seen.add(sessionId);
    }

    records.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    return records.slice(0, RECORD_CAP);
  } catch {
    return undefined;
  }
}

/**
 * v2: IDs in known/spawning/closing/permanentlyClosed collections that have no
 * sessions record. The server may normalize these into one session record when
 * practical. Exposed as exact ID lists (capped, sorted, deduped).
 */
export function readMultiplexerCollectionIds(): {
  known?: string[];
  spawning?: string[];
  closing?: string[];
  permanentlyClosed?: string[];
} | undefined {
  try {
    const store = readGlobal(STORE_SYMBOLS.multiplexerState);
    if (!isRecord(store)) return undefined;

    const sessions = store["sessions"];
    const sessionsMap = isMap(sessions) ? (sessions as Map<unknown, unknown>) : new Map<unknown, unknown>();

    const filterMissing = (ids: string[] | undefined): string[] | undefined => {
      if (ids === undefined) return undefined;
      const out = ids.filter((id) => !sessionsMap.has(id));
      out.sort();
      const deduped = [...new Set(out)];
      return deduped.slice(0, RECORD_CAP);
    };

    const known = filterMissing(readMapKeys(store["knownSessions"]));
    const spawning = filterMissing(readStringSet(store["spawningSessions"]));
    const closing = filterMissing(readMapKeys(store["closingSessions"]));
    const permanentlyClosed = filterMissing(
      readStringSet(store["permanentlyClosedSessions"]),
    );

    const out: {
      known?: string[];
      spawning?: string[];
      closing?: string[];
      permanentlyClosed?: string[];
    } = {};
    if (known !== undefined && known.length > 0) out.known = known;
    if (spawning !== undefined && spawning.length > 0) out.spawning = spawning;
    if (closing !== undefined && closing.length > 0) out.closing = closing;
    if (permanentlyClosed !== undefined && permanentlyClosed.length > 0) {
      out.permanentlyClosed = permanentlyClosed;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * v2: whitelisted cmux session-store records (allowlist only).
 *
 * Source: dist/multiplexer/cmux/session-state.d.ts:12-31.
 * Exposes sessionId=record.session, parentSessionId=record.parent, paneId,
 * title, spawnState, lifecycle, panePresent. No directory/owner/timestamps/
 * activity/intent/timers/promises.
 *
 * Capped at {@link RECORD_CAP}, sorted by sessionId, deduped. Never mutates.
 * Unknown/malformed entries ignored.
 */
export function readCmuxRecords(): CmuxSessionRecord[] | undefined {
  try {
    const store = readGlobal(STORE_SYMBOLS.cmuxSessionStore);
    if (!isMap(store)) return undefined;

    const records: CmuxSessionRecord[] = [];
    const seen = new Set<string>();

    for (const [key, value] of store) {
      if (!isString(key)) continue;
      if (!isRecord(value)) continue;

      const sessionId = isString(value["session"]) ? value["session"] : key;
      // Dedup by emitted sessionId, not just Map key.
      if (seen.has(sessionId)) continue;
      const parentSessionId = isString(value["parent"]) ? value["parent"] : undefined;
      const paneId = isString(value["paneId"]) ? value["paneId"] : undefined;
      const title = isString(value["title"]) ? value["title"] : undefined;
      const spawnStateRaw = value["spawnState"];
      const lifecycleRaw = value["lifecycle"];

      const spawnState =
        spawnStateRaw === "known" || spawnStateRaw === "spawning" || spawnStateRaw === "attached" || spawnStateRaw === "failed"
          ? spawnStateRaw
          : undefined;
      const lifecycle =
        lifecycleRaw === "active" || lifecycleRaw === "deleted" || lifecycleRaw === "orphaned"
          ? lifecycleRaw
          : undefined;

      // Skip records that don't carry the minimum allowlist identity
      if (!spawnState || !lifecycle) continue;

      records.push({
        sessionId,
        ...(parentSessionId !== undefined ? { parentSessionId } : {}),
        ...(paneId !== undefined ? { paneId } : {}),
        ...(title !== undefined ? { title } : {}),
        spawnState,
        lifecycle,
        panePresent: paneId !== undefined,
      });
      seen.add(sessionId);
    }

    records.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    return records.slice(0, RECORD_CAP);
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* v3 identity (Slice 17)                                               */
/* ------------------------------------------------------------------ */

/**
 * Per-plugin-instance bridge identity. Captured once at plugin init and
 * embedded in every snapshot. Contains NO raw secrets — the activation nonce
 * is reduced to a SHA-256 fingerprint.
 *
 * Fields are populated only when source-verifiable at capture time; absent
 * fields are omitted (undefined) rather than fabricated.
 */
export interface BridgeIdentity {
  /** Fresh random UUID per plugin instance (crypto.randomUUID). */
  pluginInstanceId: string;
  /** `Date.now()` at plugin init (ms epoch). */
  startupTimestamp: number;
  /**
   * Canonical OpenCode origin: the normalized string form of
   * `PluginInput.serverUrl` (origin only — scheme + host + port, no path/query/
   * fragment/userinfo). Omitted when `serverUrl` is absent or unparseable.
   */
  canonicalOrigin?: string;
  /**
   * SHA-256 hex fingerprint of the activation nonce. The raw nonce is NEVER
   * serialized or retained beyond the digest call. Omitted when no nonce is
   * supplied.
   */
  nonceFingerprint?: string;
  /** Transport mode is always loopback HTTP for this bridge. */
  transportMode: "loopback-http";
  /**
   * Bridge package version read from `package.json` at init. Omitted when the
   * package.json cannot be resolved (e.g. bundled without import.meta.url).
   */
  bridgePackageVersion?: string;
  /** Schema version in effect at capture (TELEMETRY_SCHEMA_VERSION). */
  schemaVersion: number;
  /** `Date.now()` at identity capture (ms epoch). */
  capturedAt: number;
}

/**
 * Capability-level availability for the four allowlisted stores plus explicit
 * unavailable flags. Availability is reported per-store as one of:
 * - `"present"`   — the store exists on globalThis and has a recognizable shape.
 * - `"absent"`    — the store is not set on globalThis.
 * - `"malformed"` — the store exists but its shape does not match expectations.
 *
 * Conservative semantics: a store is `"present"` only when its top-level
 * constructor shape passes the same guard the readers use. Per-member
 * malformation (e.g. a Map where a Set is expected inside a record) does NOT
 * downgrade the top-level availability — that detail is already reflected by
 * the readers omitting the affected sub-fields.
 */
export type StoreAvailability = "present" | "absent" | "malformed";

/** Explicitly-unavailable capability flags (always false on this bridge). */
export interface UnavailableCapabilities {
  /**
   * Runtime preset is a module-scoped variable inside the OMO bundle
   * (dist/index.js:21244) and is NOT exported from the plugin entry
   * (dist/index.js:41424-41425). It is unreachable from this bridge and never
   * fabricated.
   */
  runtimePreset: false;
  /**
   * Worker reuse counts/eligibility live inside the OMO BackgroundJobBoard
   * closure (dist/index.js:25015 class, dist/index.js:25225 state) and are not
   * externally derivable. Never fabricated.
   */
  workerReuse: false;
  /**
   * Terminal/pane capture (raw PTY output, scrollback) is not exposed by any
   * allowlisted store. The bridge performs no terminal I/O.
   */
  terminalCapture: false;
}

/** v3 capability report. */
export interface BridgeCapabilities extends UnavailableCapabilities {
  fallbackInProgress: StoreAvailability;
  continuationGate: StoreAvailability;
  multiplexerManager: StoreAvailability;
  cmuxStore: StoreAvailability;
}

/**
 * Classify a single store's availability by running the same shape guard the
 * corresponding reader uses. Never throws.
 */
function classifyStore(
  key: symbol,
  guard: (value: unknown) => boolean,
): StoreAvailability {
  try {
    const value = readGlobal(key);
    if (value === undefined || value === null) return "absent";
    return guard(value) ? "present" : "malformed";
  } catch {
    return "malformed";
  }
}

/** Guard matching {@link readFallbackInProgressSessionIDs}: must be a Set. */
function isFallbackStore(value: unknown): boolean {
  return isSet(value);
}

/** Guard matching {@link readContinuationGate}: must be a plain object record. */
function isContinuationStore(value: unknown): boolean {
  return isPlainRecord(value);
}

/** Guard matching {@link readMultiplexerSnapshot}: must be a plain object record. */
function isMultiplexerStore(value: unknown): boolean {
  return isPlainRecord(value);
}

/** Guard matching {@link readCmuxSnapshot}: must be a Map. */
function isCmuxStore(value: unknown): boolean {
  return isMap(value);
}

/**
 * Capture capability-level availability for the four allowlisted stores plus
 * explicit unavailable flags. Never throws; never mutates.
 */
export function captureBridgeCapabilities(): BridgeCapabilities {
  return {
    fallbackInProgress: classifyStore(
      STORE_SYMBOLS.fallbackInProgress,
      isFallbackStore,
    ),
    continuationGate: classifyStore(
      STORE_SYMBOLS.continuationAttemptGate,
      isContinuationStore,
    ),
    multiplexerManager: classifyStore(
      STORE_SYMBOLS.multiplexerState,
      isMultiplexerStore,
    ),
    cmuxStore: classifyStore(STORE_SYMBOLS.cmuxSessionStore, isCmuxStore),
    runtimePreset: false,
    workerReuse: false,
    terminalCapture: false,
  };
}

/**
 * Normalize a `PluginInput.serverUrl` (URL or string) to a canonical origin
 * string (scheme + host + port). Returns undefined when the input is absent or
 * cannot be parsed as a URL with a non-empty host. Never throws.
 */
export function normalizeCanonicalOrigin(serverUrl: unknown): string | undefined {
  try {
    if (serverUrl === undefined || serverUrl === null) return undefined;
    let url: URL | undefined;
    if (serverUrl instanceof URL) {
      url = serverUrl;
    } else if (typeof serverUrl === "string" && serverUrl.trim() !== "") {
      url = new URL(serverUrl);
    }
    if (!url) return undefined;
    const host = url.host;
    if (!host) return undefined;
    // url.origin is scheme + host + port, with no userinfo/path/query/fragment.
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * Compute a SHA-256 hex fingerprint of the activation nonce. The raw nonce is
 * consumed only by the digest and is never returned or retained. Returns
 * undefined when the nonce is absent, empty, or non-string. Never throws.
 */
export async function computeNonceFingerprint(nonce: unknown): Promise<
  string | undefined
> {
  try {
    if (typeof nonce !== "string" || nonce.length === 0) return undefined;
    const data = new TextEncoder().encode(nonce);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const bytes = new Uint8Array(hashBuffer);
    let hex = "";
    for (const b of bytes) hex += b.toString(16).padStart(2, "0");
    return hex;
  } catch {
    return undefined;
  }
}

/** Read the bridge package version from a resolved package.json object. */
function readPackageVersion(pkg: unknown): string | undefined {
  if (!isRecord(pkg)) return undefined;
  const version = pkg["version"];
  return typeof version === "string" && version.length > 0 ? version : undefined;
}

/**
 * Resolve the bridge package version from an importable `package.json` module
 * URL. Returns undefined when the module cannot be imported or has no version.
 * Never throws (the dynamic import is awaited inside a try/catch).
 */
export async function resolveBridgePackageVersion(
  packageJsonUrl: string | URL,
): Promise<string | undefined> {
  try {
    const mod = (await import(packageJsonUrl.toString())) as {
      default?: unknown;
    };
    return readPackageVersion(mod.default);
  } catch {
    return undefined;
  }
}

/** Inputs to {@link captureBridgeIdentity}. */
export interface BridgeIdentityInput {
  /** `PluginInput.serverUrl` (URL or string). */
  serverUrl?: unknown;
  /**
   * Pre-computed SHA-256 hex fingerprint of the activation nonce. The raw
   * nonce is NEVER passed to this function — it is fingerprinted during
   * option resolution and only the fingerprint is carried forward.
   */
  nonceFingerprint?: string;
  /** Resolved bridge package version (from package.json), if available. */
  bridgePackageVersion?: string;
  /** Optional startup timestamp override (defaults to Date.now()). */
  startupTimestamp?: number;
  /** Optional capture timestamp override (defaults to Date.now()). */
  capturedAt?: number;
}

/**
 * Capture a fresh per-plugin-instance bridge identity. The activation nonce
 * is supplied only as a pre-computed SHA-256 fingerprint — the raw nonce is
 * never passed to or retained by this function. Never throws; unresolvable
 * fields are omitted.
 */
export async function captureBridgeIdentity(
  input: BridgeIdentityInput,
): Promise<BridgeIdentity> {
  const now = Date.now();
  const identity: BridgeIdentity = {
    pluginInstanceId: crypto.randomUUID(),
    startupTimestamp:
      typeof input.startupTimestamp === "number" &&
      Number.isFinite(input.startupTimestamp)
        ? input.startupTimestamp
        : now,
    transportMode: "loopback-http",
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    capturedAt:
      typeof input.capturedAt === "number" &&
      Number.isFinite(input.capturedAt)
        ? input.capturedAt
        : now,
  };

  const origin = normalizeCanonicalOrigin(input.serverUrl);
  if (origin !== undefined) identity.canonicalOrigin = origin;

  if (input.nonceFingerprint !== undefined) {
    identity.nonceFingerprint = input.nonceFingerprint;
  }

  if (input.bridgePackageVersion !== undefined) {
    identity.bridgePackageVersion = input.bridgePackageVersion;
  }

  return identity;
}

/**
 * Capture a full read-only telemetry snapshot of the whitelisted OMO stores.
 * Never throws: every store reader is individually guarded, and missing or
 * malformed stores simply omit their fields.
 *
 * @param now Optional timestamp override (defaults to `Date.now()`); exposed
 *            for deterministic tests.
 * @param identity Optional v3 bridge identity captured once at plugin init.
 *                 When supplied, embedded in the snapshot.
 * @param includeCapabilities When true (default), compute and embed v3
 *                            capability-level availability.
 */
export function captureTelemetrySnapshot(
  now?: number,
  identity?: BridgeIdentity,
  includeCapabilities: boolean = true,
): TelemetrySnapshot {
  const capturedAt =
    typeof now === "number" && Number.isFinite(now) ? now : Date.now();

  const stores: TelemetryStores = {};

  const fallbackInProgressSessionIDs = readFallbackInProgressSessionIDs();
  if (fallbackInProgressSessionIDs !== undefined) {
    stores.fallbackInProgressSessionIDs = fallbackInProgressSessionIDs;
  }

  const continuationGate = readContinuationGate();
  if (continuationGate !== undefined) {
    stores.continuationGate = continuationGate;
  }

  const cmux = readCmuxSnapshot();
  if (cmux !== undefined) stores.cmux = cmux;

  const multiplexer = readMultiplexerSnapshot();
  if (multiplexer !== undefined) stores.multiplexer = multiplexer;

  // v2 whitelisted records (capped, sorted, deduped)
  const muxRecords = readMultiplexerRecords();
  if (muxRecords !== undefined && muxRecords.length > 0) {
    stores.multiplexerRecords = muxRecords;
  }
  const muxCollectionIds = readMultiplexerCollectionIds();
  if (muxCollectionIds !== undefined) {
    stores.multiplexerCollectionIds = muxCollectionIds;
  }
  const cmuxRecords = readCmuxRecords();
  if (cmuxRecords !== undefined && cmuxRecords.length > 0) {
    stores.cmuxRecords = cmuxRecords;
  }

  const snapshot: TelemetrySnapshot = {
    telemetrySchemaVersion: TELEMETRY_SCHEMA_VERSION,
    capturedAt,
    stores,
  };

  if (identity !== undefined) snapshot.identity = identity;
  if (includeCapabilities) snapshot.capabilities = captureBridgeCapabilities();

  return snapshot;
}
