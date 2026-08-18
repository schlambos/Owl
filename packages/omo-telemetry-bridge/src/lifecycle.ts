/**
 * Bridge process lifecycle (Phase 2 — Oracle-approved ownership hardening,
 * Gate 2 remediation).
 *
 * Versioned realm registry state machine over a `Symbol.for` slot on
 * `globalThis`:
 *
 *   Absent → Starting → Active | Failed(start)
 *   Active → Stopping → Absent | Failed(stop, fenced)
 *
 * Registry transition discipline:
 * - Every transition is a compare-and-transition on the EXACT record object
 *   plus a readback proof: the slot is written only when it still holds the
 *   expected record, and the post-write slot content is verified. A lost or
 *   replaced epoch is never clobbered.
 * - A registry READ failure is fail-closed: typed rejection, zero serve.
 *   An unreadable registry is never treated as Absent.
 * - `Active` never observably holds refcount <= 0: the final release
 *   transitions Active → Stopping at refcount 1 BEFORE calling stop.
 * - Refcount mutations are guarded; a mutation failure is fail-closed and
 *   never returns a lease.
 *
 * Invariants:
 * - REGISTRATION IS NOT ACTIVATION. This module is only reached with a
 *   complete, validated managed activation (see options.ts) whose identity
 *   is revalidated here BEFORE any publication/serve: activation nonce
 *   fingerprint exactly equals the identity fingerprint (both 64 lowercase
 *   hex), host exactly 127.0.0.1, explicit managed port 8788..8803, schema
 *   exactly 3, transport loopback-http, and a normalized parseable canonical
 *   HTTP loopback origin. Any mismatch rejects with zero serve.
 * - A Starting record is published BEFORE `factory.serve` is called. A
 *   starting-publication failure means ZERO serve calls.
 * - Compatible concurrent/reentrant acquisitions JOIN the one starting
 *   epoch; every accepted waiter settles (success or typed failure).
 * - The exact reuse key is: normalized canonical origin, host `127.0.0.1`,
 *   exact port, `loopback-http`, schema version 3, exact nonce fingerprint.
 * - An incompatible or incomplete key is a typed rejection with ZERO bind,
 *   refcount, stop, or adoption.
 * - An acquisition observing `stopping` rejects typed — it never reuses,
 *   refcounts, or rebinds a stopping epoch.
 * - Every successful lease captures its exact owner epoch. Stale, repeated,
 *   or out-of-order dispose calls cannot affect another epoch.
 * - An intermediate dispose preserves the listener; the final dispose
 *   transitions to Stopping and stops the server exactly once.
 * - Stop success clears ONLY the exact stopping epoch; a clear failure
 *   leaves an explicit blocking `cleanup-failed` record (never reusable).
 * - A stop failure fences the exact epoch as `failed-stop` (server retained,
 *   all acquisitions/rebinds rejected); if the fence write itself fails, the
 *   existing stopping object is mutated/fenced in place when possible.
 * - A failed start settles all waiters and returns the slot to Absent. If
 *   the failed-start cleanup cannot be proven, a BLOCKING `failed-start`
 *   record is left instead (never reusable).
 * - If activation succeeds but the Active transition is lost/replaced, only
 *   the newly created owned handle is stopped (exactly once) — the
 *   replacement is never clobbered. If that cleanup stop itself fails, the
 *   record is fenced when the slot is still ours; otherwise the attempt
 *   fails typed and the replacement remains authoritative.
 * - No port fallback, retry, sleep, listener probe/adoption, process-kind
 *   heuristic, or broad swallowed error.
 * - Truly separate realms/processes do NOT share this registry (Symbol.for
 *   is realm-global). A cross-realm/process duplicate bind surfaces as a
 *   typed EADDRINUSE loser via the factory — cross-realm reuse is never
 *   claimed.
 *
 * The server factory is injected (`BridgeServerFactory`) so unit tests can
 * exercise the lifecycle without binding real ports via `Bun.serve`. The
 * factory may return the handle synchronously or as a Promise (the latter
 * enables deterministic stall-gate tests).
 */

import { createHash } from "node:crypto";
import type { BridgeActivation } from "./options";
import { LOOPBACK_HOST, MANAGED_PORT_MIN, MANAGED_PORT_MAX } from "./options";
import type { BridgeIdentity } from "./stores";
import { TELEMETRY_SCHEMA_VERSION } from "./stores";

/* ------------------------------------------------------------------ */
/* Permanent failure classification + epoch/digest helpers             */
/* ------------------------------------------------------------------ */

/**
 * Stable, secret-free failure classification carried by typed ownership
 * errors ({@link BridgeActivationError.detail}), fenced registry records,
 * and realm poison records. Never derived from raw error text beyond the
 * EADDRINUSE recognition in {@link classifyServeFailure}.
 */
export type BridgeFailureClassification =
  | "EADDRINUSE"
  | "registry-read-failed"
  | "registry-write-failed"
  | "serve-failed"
  | "stop-failed";

/**
 * Reduce an arbitrary caught serve error to a stable classification. Only
 * `EADDRINUSE` is recognized (from the error code or message); everything
 * else collapses to `serve-failed`. The raw error, its stack, and its cause
 * are never retained in the result.
 */
function classifyServeFailure(error: unknown): BridgeFailureClassification {
  try {
    let code: string | undefined;
    let message = "";
    if (error instanceof Error) {
      message = error.message;
      const c = (error as { code?: unknown }).code;
      if (typeof c === "string") code = c;
    } else if (typeof error === "string") {
      message = error;
    }
    if (
      code === "EADDRINUSE" ||
      message.includes("EADDRINUSE") ||
      message.includes("address already in use")
    ) {
      return "EADDRINUSE";
    }
    return "serve-failed";
  } catch {
    return "serve-failed";
  }
}

/** Fresh opaque owner-epoch identifier (UUID). Never derived from secrets. */
function newEpochId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // Extremely defensive fallback; still secret-free.
    return `epoch-${Date.now().toString(36)}-${Math.floor(
      Math.random() * 0xffffffff,
    ).toString(36)}`;
  }
}

/**
 * Versioned Symbol.for key for the active bridge registry slot. v2: the
 * Starting/Stopping/waiter/epoch state machine. A v1 slot (legacy record
 * shape) is never read by this module.
 */
export const BRIDGE_REGISTRY_SYMBOL = Symbol.for(
  "omo-telemetry-bridge.v2.active",
);

/**
 * Structural server handle (avoids leaking Bun types into this module). The
 * production `Bun.serve` result satisfies this interface. `stop` is async
 * (Bun's `Server.stop()` returns `Promise<void>`).
 */
export interface BridgeServerHandle {
  readonly hostname: string;
  readonly port: number;
  stop(closeActiveConnections?: boolean): Promise<void>;
}

/** Request handler signature. */
export type BridgeFetchHandler = (request: Request) => Response;

/**
 * Factory that starts a loopback server. Injectable for tests. May return
 * the handle directly or as a Promise; `Bun.serve` is synchronous and
 * satisfies the direct form.
 */
export interface BridgeServerFactory {
  serve(opts: {
    hostname: string;
    port: number;
    fetch: BridgeFetchHandler;
  }): BridgeServerHandle | Promise<BridgeServerHandle>;
}

/**
 * The exact ownership reuse key. ALL fields are required; a missing or
 * mismatched field makes an acquisition incompatible (typed reject).
 */
export interface BridgeReuseKey {
  readonly canonicalOrigin: string;
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly transportMode: "loopback-http";
  readonly schemaVersion: number;
  readonly nonceFingerprint: string;
}

/** Stable, secret-free codes for typed activation/ownership failures. */
export type BridgeActivationErrorCode =
  /** Incompatible or incomplete ownership identity (key mismatch/missing). */
  | "activation-incompatible"
  /** Registry is fenced by a prior failure; no acquisition/rebind. */
  | "activation-fenced"
  /** An existing epoch is stopping; no reuse/refcount/rebind. */
  | "activation-stopping"
  /** `factory.serve` failed (detail carries the normalized classification). */
  | "activation-start-failed"
  /** A registry transition could not be proven. */
  | "activation-registry-failed";

/**
 * Typed, redacted activation/ownership failure. Carries ONLY stable codes —
 * never raw error messages, stacks, causes, nonce material, or config values.
 */
export class BridgeActivationError extends Error {
  readonly code: BridgeActivationErrorCode;
  /** Normalized failure classification (e.g. EADDRINUSE), when applicable. */
  readonly detail?: BridgeFailureClassification;
  constructor(
    code: BridgeActivationErrorCode,
    message: string,
    detail?: BridgeFailureClassification,
  ) {
    super(message);
    this.name = "BridgeActivationError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/* ------------------------------------------------------------------ */
/* Registry records                                                    */
/* ------------------------------------------------------------------ */

type RegistryState =
  | "starting"
  | "active"
  | "stopping"
  | "failed-start"
  | "failed-stop"
  | "cleanup-failed";

/**
 * Single mutable registry record shape. `state` is deliberately mutable so
 * that, when a fence WRITE itself fails, the existing in-slot object can
 * still be fenced in place (fail-closed) rather than left reusable.
 */
interface RegistryRecord {
  state: RegistryState;
  readonly epoch: string;
  readonly key: BridgeReuseKey;
  readonly identity: BridgeIdentity;
  server?: BridgeServerHandle;
  refcount: number;
  outcome?: Promise<void>;
  settle?: (error?: BridgeActivationError) => void;
  errorCode?: BridgeFailureClassification;
}

/* ------------------------------------------------------------------ */
/* Registry I/O with failure injection (test-only) + CAS + readback      */
/* ------------------------------------------------------------------ */

let failNextRegistryReads = 0;
let skipNextRegistryReads = 0;
let skipNextRegistryWrites = 0;
let failNextRegistryWrites = 0;

/**
 * Test-only: skip `skip` reads, then make the next `count` registry reads
 * report failure. Enables deterministic readback-failure injection.
 */
export function __failNextRegistryReadsForTests(count: number, skip = 0): void {
  skipNextRegistryReads = skip;
  failNextRegistryReads = count;
}

/**
 * Test-only: skip `skip` writes, then make the next `count` writes report
 * failure. Enables deterministic per-transition failure injection.
 */
export function __failNextRegistryWritesForTests(count: number, skip = 0): void {
  skipNextRegistryWrites = skip;
  failNextRegistryWrites = count;
}

function readRegistry(): { ok: boolean; record: RegistryRecord | undefined } {
  if (skipNextRegistryReads > 0) {
    skipNextRegistryReads -= 1;
  } else if (failNextRegistryReads > 0) {
    failNextRegistryReads -= 1;
    return { ok: false, record: undefined };
  }
  try {
    return {
      ok: true,
      record: (globalThis as unknown as Record<symbol, unknown>)[
        BRIDGE_REGISTRY_SYMBOL
      ] as RegistryRecord | undefined,
    };
  } catch {
    return { ok: false, record: undefined };
  }
}

function writeRegistryRaw(record: RegistryRecord | undefined): boolean {
  if (skipNextRegistryWrites > 0) {
    skipNextRegistryWrites -= 1;
  } else if (failNextRegistryWrites > 0) {
    failNextRegistryWrites -= 1;
    return false;
  }
  try {
    const g = globalThis as unknown as Record<symbol, unknown>;
    if (record === undefined) {
      delete g[BRIDGE_REGISTRY_SYMBOL];
    } else {
      g[BRIDGE_REGISTRY_SYMBOL] = record;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Discriminated compare-and-transition outcome. The write-vs-readback
 * ambiguity is never collapsed to a boolean:
 * - `verified`    — slot held exactly `expected`; write applied; readback
 *                   confirms the slot now holds exactly `next`.
 * - `not-written` — the write reported failure BEFORE applying; the slot is
 *                   presumed to still hold `expected`.
 * - `unknown`     — a read failed, or the write applied but the readback
 *                   could not prove the result. The slot state is UNKNOWN.
 * - `replaced`    — the slot demonstrably holds a different record (a
 *                   replacement); it is never clobbered.
 */
type TransitionOutcome = "verified" | "not-written" | "unknown" | "replaced";

function compareAndTransition(
  expected: RegistryRecord,
  next: RegistryRecord | undefined,
): TransitionOutcome {
  const before = readRegistry();
  if (!before.ok) return "unknown";
  if (before.record !== expected) return "replaced";
  if (!writeRegistryRaw(next)) return "not-written";
  const after = readRegistry();
  if (!after.ok) return "unknown";
  return after.record === next ? "verified" : "replaced";
}

/** Whether the slot currently holds exactly this record. */
function slotHolds(expected: RegistryRecord): boolean {
  const read = readRegistry();
  return read.ok && read.record === expected;
}

/**
 * Fail-closed in-place fence: when a fence WRITE fails but the slot still
 * holds the object, mutate the object itself so future reads observe the
 * blocking state. Best-effort; never throws.
 */
function fenceInPlace(
  record: RegistryRecord,
  state: "failed-start" | "failed-stop" | "cleanup-failed",
  errorCode: BridgeFailureClassification,
): void {
  try {
    record.state = state;
    record.errorCode = errorCode;
  } catch {
    // ignore — nothing more can be done in-realm
  }
}

/* ------------------------------------------------------------------ */
/* Realm-wide poison/orphan fence (observation/fencing — never adoption) */
/* ------------------------------------------------------------------ */

/**
 * Realm-wide poison slot. When an owned handle cannot be provably cleaned
 * up (e.g. its Active transition was replaced AND the cleanup stop failed,
 * or a write/readback left the registry state unknowable), the realm is
 * poisoned: ALL subsequent acquisitions reject, regardless of what the
 * primary registry slot holds. This record RETAINS the orphan handle's
 * metadata for observation; it NEVER adopts, reuses, or stops a replacement
 * listener. First poison wins (kept for forensic stability).
 */
const REALM_POISON_SYMBOL = Symbol.for("omo-telemetry-bridge.v2.poison");

export interface RealmPoison {
  readonly epoch: string;
  readonly reason:
    | "active-publish-lost-cleanup-pending"
    | "release-transition-cleanup-pending"
    | "active-publish-unknown"
    | "starting-publish-unknown"
    | "failed-start-cleanup-unknown"
    | "stop-clear-unknown"
    | "stop-fence-unknown";
  readonly errorCode: BridgeFailureClassification;
  /** Orphaned owned handle metadata (never adopted, never served from). */
  readonly orphanPort?: number;
  readonly keyDigest?: string;
  /**
   * The actual failed/cleanup-pending owned handle, retained PRIVATELY for
   * observation/fencing only. Never exposed to acquisitions, never adopted,
   * never reused. (Test introspection may assert identity.)
   */
  readonly orphanHandle?: BridgeServerHandle;
}

let failNextPoisonReads = 0;
let skipNextPoisonReads = 0;
let failNextPoisonWrites = 0;

/**
 * Module-local fallback fence. When global `Symbol.for` poison publication
 * is unverified or unavailable, this fallback blocks acquisitions in this
 * module instance before stop, and preserves the failed handle if stop
 * rejects. Checked BEFORE global poison and the primary registry.
 */
let moduleFallbackPoison: RealmPoison | undefined;

/** Test-only: fail the next `count` poison reads (after `skip` succeed). */
export function __failNextPoisonReadsForTests(count: number, skip = 0): void {
  skipNextPoisonReads = skip;
  failNextPoisonReads = count;
}

/** Test-only: fail the next `count` poison writes. */
export function __failNextPoisonWritesForTests(count: number): void {
  failNextPoisonWrites = count;
}

type PoisonReadResult =
  | { state: "absent" }
  | { state: "present"; poison: RealmPoison }
  | { state: "read-failed" };

function readPoison(): PoisonReadResult {
  if (skipNextPoisonReads > 0) {
    skipNextPoisonReads -= 1;
  } else if (failNextPoisonReads > 0) {
    failNextPoisonReads -= 1;
    return { state: "read-failed" };
  }
  try {
    const val = (globalThis as unknown as Record<symbol, unknown>)[
      REALM_POISON_SYMBOL
    ] as RealmPoison | undefined;
    if (val === undefined) return { state: "absent" };
    return { state: "present", poison: val };
  } catch {
    return { state: "read-failed" };
  }
}

function writePoisonRaw(poison: RealmPoison): boolean {
  if (failNextPoisonWrites > 0) {
    failNextPoisonWrites -= 1;
    return false;
  }
  try {
    (globalThis as unknown as Record<symbol, unknown>)[REALM_POISON_SYMBOL] =
      poison;
    return true;
  } catch {
    return false;
  }
}

/**
 * Publish a realm poison with READBACK VERIFICATION. If the realm is
 * already poisoned for the SAME epoch (e.g. transient cleanup-pending
 * poison transitioning to permanent failure), the poison record is updated
 * in place. If already poisoned for a DIFFERENT epoch, the first epoch's
 * poison is preserved for forensic stability. Always installs the
 * module-local fallback fence first as fail-closed defense. Returns true
 * only when the realm is provably fenced globally.
 */
function publishRealmPoison(poison: RealmPoison): boolean {
  if (moduleFallbackPoison === undefined || moduleFallbackPoison.epoch === poison.epoch) {
    moduleFallbackPoison = poison;
  }
  const before = readPoison();
  if (before.state === "read-failed") return false;
  if (before.state === "present" && before.poison.epoch !== poison.epoch) {
    return true; // already fenced by an earlier epoch
  }
  if (!writePoisonRaw(poison)) return false;
  const after = readPoison();
  return after.state === "present";
}

function poisonRealm(poison: RealmPoison): void {
  // Best-effort fire-and-forget for legacy call sites; new code must use
  // publishRealmPoison and act on the verification result.
  publishRealmPoison(poison);
}

/**
 * Clear a transient cleanup-pending poison ONLY after exact cleanup state
 * is proven. If the poison in place belongs to a different epoch (e.g.
 * another failed stop), it is preserved.
 */
function clearRealmPoison(epoch: string): boolean {
  if (moduleFallbackPoison?.epoch === epoch) {
    moduleFallbackPoison = undefined;
  }
  const current = readPoison();
  if (current.state === "read-failed") return false;
  if (current.state === "absent") return true;
  if (current.poison.epoch !== epoch) {
    return true;
  }
  try {
    delete (globalThis as unknown as Record<symbol, unknown>)[
      REALM_POISON_SYMBOL
    ];
  } catch {
    return false;
  }
  const after = readPoison();
  return after.state === "absent";
}

function realmPoison(): RealmPoison | undefined {
  const res = readPoison();
  return res.state === "present" ? res.poison : moduleFallbackPoison;
}

/** Test-only: observe the realm poison state. */
export function __realmPoisonForTests(): RealmPoison | undefined {
  return realmPoison();
}

/** Test-only: observe the module fallback poison state. */
export function __moduleFallbackPoisonForTests(): RealmPoison | undefined {
  return moduleFallbackPoison;
}

/* ------------------------------------------------------------------ */
/* Test-only introspection                                             */
/* ------------------------------------------------------------------ */

/** Reset the registry (test-only). Stops any tracked server best-effort. */
export async function __resetBridgeRegistryForTests(): Promise<void> {
  const { record } = readRegistry();
  if (record?.server) {
    try {
      await record.server.stop(true);
    } catch {
      // ignore
    }
  }
  try {
    const g = globalThis as unknown as Record<symbol, unknown>;
    delete g[BRIDGE_REGISTRY_SYMBOL];
    delete g[REALM_POISON_SYMBOL];
  } catch {
    // ignore
  }
  moduleFallbackPoison = undefined;
  failNextRegistryReads = 0;
  skipNextRegistryReads = 0;
  skipNextRegistryWrites = 0;
  failNextRegistryWrites = 0;
  failNextPoisonReads = 0;
  skipNextPoisonReads = 0;
  failNextPoisonWrites = 0;
}

/** @internal Current refcount (test introspection; 0 unless active). */
export function __bridgeRefcountForTests(): number {
  const { record } = readRegistry();
  return record !== undefined && record.state === "active" ? record.refcount : 0;
}

/** @internal Whether a bridge is active (test introspection). */
export function __bridgeActiveForTests(): boolean {
  const { record } = readRegistry();
  return record !== undefined && record.state === "active";
}

/** @internal Current registry state name (test introspection). */
export function __bridgeRegistryStateForTests(): RegistryState | "absent" {
  const { record } = readRegistry();
  return record === undefined ? "absent" : record.state;
}

/** @internal Current owner epoch (test introspection). */
export function __bridgeOwnerEpochForTests(): string | undefined {
  const { record } = readRegistry();
  return record?.epoch;
}

/* ------------------------------------------------------------------ */
/* Reuse key validation (activation ↔ served identity)                  */
/* ------------------------------------------------------------------ */

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

/**
 * Revalidate a normalized canonical origin: parseable, already in normalized
 * origin form, HTTP(S), loopback host only.
 */
function isCanonicalLoopbackHttpOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.origin !== origin) return false; // must be normalized origin form
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Build the exact reuse key, revalidating the activation↔identity binding:
 * fingerprints must match exactly (both 64 lowercase hex), host exactly
 * 127.0.0.1, explicit managed port, schema exactly 3, transport
 * loopback-http, normalized canonical HTTP loopback origin. Returns
 * undefined (incompatible) on ANY mismatch. Never throws.
 */
function buildReuseKey(
  activation: BridgeActivation,
  identity: BridgeIdentity,
  allowUnmanagedPort: boolean,
): BridgeReuseKey | undefined {
  if (activation.host !== LOOPBACK_HOST) return undefined;
  if (
    !allowUnmanagedPort &&
    (!Number.isInteger(activation.port) ||
      activation.port < MANAGED_PORT_MIN ||
      activation.port > MANAGED_PORT_MAX)
  ) {
    return undefined;
  }
  if (
    !Number.isInteger(activation.port) ||
    activation.port < 1 ||
    activation.port > 65535
  ) {
    return undefined;
  }
  if (!FINGERPRINT_RE.test(activation.nonceFingerprint)) return undefined;
  if (identity.nonceFingerprint !== activation.nonceFingerprint) {
    return undefined;
  }
  if (identity.schemaVersion !== TELEMETRY_SCHEMA_VERSION) return undefined;
  if (identity.transportMode !== "loopback-http") return undefined;
  const origin = identity.canonicalOrigin;
  if (origin === undefined || !isCanonicalLoopbackHttpOrigin(origin)) {
    return undefined;
  }
  return {
    canonicalOrigin: origin,
    host: LOOPBACK_HOST,
    port: activation.port,
    transportMode: "loopback-http",
    schemaVersion: identity.schemaVersion,
    nonceFingerprint: activation.nonceFingerprint,
  };
}

function reuseKeyEqual(a: BridgeReuseKey, b: BridgeReuseKey): boolean {
  return (
    a.canonicalOrigin === b.canonicalOrigin &&
    a.host === b.host &&
    a.port === b.port &&
    a.transportMode === b.transportMode &&
    a.schemaVersion === b.schemaVersion &&
    a.nonceFingerprint === b.nonceFingerprint
  );
}

function keyDigest(key: BridgeReuseKey): string | undefined {
  try {
    const canonical = [
      key.canonicalOrigin,
      key.host,
      String(key.port),
      String(key.schemaVersion),
      key.transportMode,
      key.nonceFingerprint,
    ].join("|");
    return createHash("sha256").update(canonical, "utf8").digest("hex");
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Lease                                                               */
/* ------------------------------------------------------------------ */

/**
 * An idempotent acquisition lease bound to its exact owner epoch. Only this
 * lease's first `dispose()` can decrement its refcount. Repeated, stale, or
 * out-of-order dispose calls are no-ops.
 */
export interface BridgeLease {
  /** The exact owner epoch this lease belongs to. */
  readonly epoch: string;
  /** The bound server handle. */
  readonly server: BridgeServerHandle;
  /** The active owner identity (first registrant of the epoch). */
  readonly identity: BridgeIdentity;
  /** Whether this acquisition joined an existing epoch (true) or created it (false). */
  readonly reused: boolean;
  /**
   * Release this lease. Async: the final release transitions the exact epoch
   * to Stopping and AWAITS the server stop while that epoch remains
   * `stopping`. Stop resolution clears only the exact stopping epoch; a stop
   * rejection fences the epoch (`failed-stop`).
   *
   * Accounting: the lease is marked disposed ONLY when the release was
   * consumed, final, or fenced. A retryable failure (registry read failure
   * or an unproven Active→Stopping transition) leaves the lease undisposed
   * so the caller may retry the SAME lease — no phantom ref, no double stop.
   *
   * @returns true when this call performed the final release (the stop
   *          attempt), false otherwise.
   */
  dispose(): Promise<boolean>;
}

/* ------------------------------------------------------------------ */
/* Acquire                                                             */
/* ------------------------------------------------------------------ */

interface AcquireOptions {
  /** Test-only: permit a port outside the managed range. Never set by the
   *  production plugin path. */
  allowUnmanagedPort?: boolean;
}

/**
 * Acquire (or join) the bridge process singleton for the exact reuse key.
 *
 * Returns a lease on success. Throws a typed, redacted
 * {@link BridgeActivationError} on: incompatible/missing identity, fenced or
 * stopping registry, registry read/transition failure, or bind/serve
 * failure. A failed acquisition performs ZERO bind/refcount/stop/adoption
 * side effects beyond its own starting epoch (which is always settled and
 * cleaned up or fenced).
 */
export async function acquireBridge(
  activation: BridgeActivation,
  identity: BridgeIdentity,
  factory: BridgeServerFactory,
  fetchHandler: BridgeFetchHandler,
): Promise<BridgeLease> {
  return acquireBridgeInternal(activation, identity, factory, fetchHandler, {});
}

/**
 * Test-only seam: acquire with an unmanaged (outside 8788..8803) test port
 * so collision behavior can be exercised on a fixed test-only port. The
 * production plugin path NEVER reaches this seam — `acquireBridge` always
 * enforces the managed range.
 */
export function __acquireBridgeWithTestPortForTests(
  activation: BridgeActivation,
  identity: BridgeIdentity,
  factory: BridgeServerFactory,
  fetchHandler: BridgeFetchHandler,
): Promise<BridgeLease> {
  return acquireBridgeInternal(activation, identity, factory, fetchHandler, {
    allowUnmanagedPort: true,
  });
}

async function acquireBridgeInternal(
  activation: BridgeActivation,
  identity: BridgeIdentity,
  factory: BridgeServerFactory,
  fetchHandler: BridgeFetchHandler,
  opts: AcquireOptions,
): Promise<BridgeLease> {
  const key = buildReuseKey(
    activation,
    identity,
    opts.allowUnmanagedPort === true,
  );
  const digest = key !== undefined ? keyDigest(key) : undefined;

  if (key === undefined) {
    throw new BridgeActivationError(
      "activation-incompatible",
      "bridge activation identity is incomplete, mismatched, or not schema v3 loopback-http",
    );
  }

  // 1. Module fallback fence checked BEFORE global poison and primary registry
  if (moduleFallbackPoison !== undefined) {
    throw new BridgeActivationError(
      "activation-fenced",
      `bridge realm is poisoned (${moduleFallbackPoison.reason}); no acquisition or rebind is permitted`,
      moduleFallbackPoison.errorCode,
    );
  }

  // 2. Global realm poison consult BEFORE any registry reuse/bind. Discriminated
  // read: any read failure typed-rejects with ZERO primary registry read/reuse/bind.
  const poisonResult = readPoison();
  if (poisonResult.state === "read-failed") {
    throw new BridgeActivationError(
      "activation-registry-failed",
      "bridge poison read failed; refusing to bind without proof of state",
      "registry-read-failed",
    );
  }
  if (poisonResult.state === "present") {
    const poison = poisonResult.poison;
    throw new BridgeActivationError(
      "activation-fenced",
      `bridge realm is poisoned (${poison.reason}); no acquisition or rebind is permitted`,
      poison.errorCode,
    );
  }

  const read = readRegistry();
  const record = read.record;

  // Registry READ failure is fail-closed: never treat as Absent, zero serve.
  if (!read.ok) {
    throw new BridgeActivationError(
      "activation-registry-failed",
      "bridge registry read failed; refusing to bind without proof of state",
      "registry-read-failed",
    );
  }

  if (record !== undefined) {
    // Any existing record must match the exact reuse key.
    if (!reuseKeyEqual(record.key, key)) {
      throw new BridgeActivationError(
        "activation-incompatible",
        "an existing bridge epoch holds an incompatible ownership identity",
      );
    }

    if (
      record.state === "failed-start" ||
      record.state === "failed-stop" ||
      record.state === "cleanup-failed"
    ) {
      throw new BridgeActivationError(
        "activation-fenced",
        `bridge registry is fenced (${record.state}); no acquisition or rebind is permitted`,
        record.errorCode,
      );
    }

    if (record.state === "stopping") {
      // Never reuse/refcount/rebind a stopping epoch.
      throw new BridgeActivationError(
        "activation-stopping",
        "an existing bridge epoch is stopping; acquisition must wait for a later epoch",
      );
    }

    if (record.state === "starting") {
      // Compatible waiter: join the one starting epoch. Every waiter settles.
      try {
        await record.outcome;
      } catch (error) {
        throw error;
      }
      const settled = readRegistry();
      if (
        settled.ok &&
        settled.record !== undefined &&
        settled.record.state === "active" &&
        settled.record.epoch === record.epoch
      ) {
        return joinActiveEpoch(settled.record);
      }
      throw new BridgeActivationError(
        "activation-registry-failed",
        "starting epoch settled without a provable active bridge record",
      );
    }

    // record.state === "active" with an exact key match: compatible reuse.
    return joinActiveEpoch(record);
  }

  // ── Absent: become the starting epoch owner ──────────────────────────

  const epoch = newEpochId();
  let settleFn: (error?: BridgeActivationError) => void = () => {};
  const outcome = new Promise<void>((resolve, reject) => {
    settleFn = (error?: BridgeActivationError) => {
      if (error === undefined) resolve();
      else reject(error);
    };
  });
  // Prevent unhandled-rejection noise when no waiter has attached yet.
  outcome.catch(() => {});

  const starting: RegistryRecord = {
    state: "starting",
    epoch,
    key,
    identity,
    refcount: 0,
    outcome,
    settle: settleFn,
  };

  // Publish Starting BEFORE any serve call. Publication (or its readback
  // proof) failure → zero serve calls. A readback-unknown result poisons
  // the possibly-written starting record in place (so it can never be
  // joined/reused) and fences the realm.
  const startingPublish = publishAbsentToStarting(starting);
  if (startingPublish !== "verified") {
    if (startingPublish === "unknown") {
      // The write may have applied: poison the exact record so a possibly
      // published Starting can never be joined, and fence the realm.
      fenceInPlace(starting, "failed-start", "registry-write-failed");
      poisonRealm({
        epoch,
        reason: "starting-publish-unknown",
        errorCode: "registry-write-failed",
        orphanPort: key.port,
        keyDigest: digest,
      });
    }
    const error = new BridgeActivationError(
      "activation-registry-failed",
      "could not publish the starting bridge record; no bind was attempted",
      "registry-write-failed",
    );
    starting.settle?.(error);
    throw error;
  }

  let server: BridgeServerHandle;
  try {
    server = await factory.serve({
      hostname: key.host,
      port: key.port,
      fetch: fetchHandler,
    });
  } catch (serveError) {
    // Typed, redacted start failure. Settle every waiter; return to Absent.
    const errorCode = classifyServeFailure(serveError);
    const typed = new BridgeActivationError(
      "activation-start-failed",
      `bridge activation failed to bind the managed port (classification: ${errorCode})`,
      errorCode,
    );
    starting.settle?.(typed);
    // Clear ONLY the exact starting epoch. If cleanup cannot be proven,
    // leave a BLOCKING failed-start record (never reusable).
    const cleared = compareAndTransition(starting, undefined);
    if (cleared === "verified") {
    } else if (cleared === "replaced") {
      // A replacement is authoritative — never clobber it.
    } else {
      // not-written or unknown: leave/poison a blocking failed-start record.
      if (cleared === "unknown") {
        // The clear may have applied; poison the record so a possibly
        // lingering Starting/Active record is never reusable, and fence.
        fenceInPlace(starting, "failed-start", errorCode);
        poisonRealm({
          epoch,
          reason: "failed-start-cleanup-unknown",
          errorCode,
          orphanPort: key.port,
          keyDigest: digest,
        });
      }
      const blocking: RegistryRecord = {
        state: "failed-start",
        epoch,
        key,
        identity,
        refcount: 0,
        errorCode,
      };
      if (compareAndTransition(starting, blocking) !== "verified") {
        fenceInPlace(starting, "failed-start", errorCode);
      }
    }
    throw typed;
  }

  // Prove the Active transition via compare-and-transition + readback.
  const active: RegistryRecord = {
    state: "active",
    epoch,
    key,
    identity,
    server,
    refcount: 1,
  };
  const activeTransition = compareAndTransition(starting, active);
  if (activeTransition !== "verified") {
    // Transition lost/replaced or unprovable. Stop ONLY the just-created
    // owned handle (exactly once); never clobber a replacement.
    if (activeTransition === "unknown") {
      // The write may have applied: the slot may hold a REUSABLE active
      // record. Poison the exact next record in place BEFORE any cleanup so
      // it can never be reused.
      fenceInPlace(active, "failed-stop", "registry-write-failed");
    }
    const stillOurs =
      activeTransition === "unknown" ? false : slotHolds(starting);
    let stopFailed = false;
    if (stillOurs) {
      const poisonVerified = publishRealmPoison({
        epoch,
        reason: "active-publish-unknown",
        errorCode: "registry-write-failed",
        orphanPort: key.port,
        keyDigest: digest,
        orphanHandle: server,
      });
      if (!poisonVerified) {
      }
      try {
        await server.stop(true);
      } catch {
        stopFailed = true;
      }
      if (stopFailed) {
        const fenced: RegistryRecord = {
          state: "failed-stop",
          epoch,
          key,
          identity,
          server,
          refcount: 0,
          errorCode: "stop-failed",
        };
        if (compareAndTransition(starting, fenced) !== "verified") {
          fenceInPlace(starting, "failed-stop", "stop-failed");
        }
      } else {
        const blocking: RegistryRecord = {
          state: "failed-start",
          epoch,
          key,
          identity,
          refcount: 0,
          errorCode: "registry-write-failed",
        };
        if (compareAndTransition(starting, blocking) === "verified") {
          clearRealmPoison(epoch);
        } else {
          fenceInPlace(starting, "failed-start", "registry-write-failed");
        }
      }
    } else {
      // Replacement (or unreadable slot) is authoritative — never clobber.
      // Publish + readback-verify the realm cleanup-pending poison
      // (retaining the failed handle PRIVATELY) BEFORE awaiting the cleanup
      // stop, so every acquisition is fenced while cleanup is pending.
      // Observation/fencing only — never adoption.
      const outcome = await fencedOwnedStopOnce({
        epoch,
        key,
        server,
        reason:
          activeTransition === "unknown"
            ? "active-publish-unknown"
            : "active-publish-lost-cleanup-pending",
        errorCode: "registry-write-failed",
      });
      stopFailed = outcome.stopFailed;
    }
    const typed = new BridgeActivationError(
      "activation-registry-failed",
      "bridge activation succeeded but the active registry transition could not be proven",
      stopFailed ? "stop-failed" : "registry-write-failed",
    );
    starting.settle?.(typed);
    throw typed;
  }

  starting.settle?.();
  return makeLease(active, false);
}

/**
 * Publish Absent → Starting with readback proof: the slot must be empty
 * before and hold exactly our starting record after. Discriminated outcome:
 * `replaced` when the slot was demonstrably occupied, `not-written` when the
 * write failed before applying, `unknown` when a read/readback failed.
 */
function publishAbsentToStarting(starting: RegistryRecord): TransitionOutcome {
  const before = readRegistry();
  if (!before.ok) return "unknown";
  if (before.record !== undefined) return "replaced";
  if (!writeRegistryRaw(starting)) return "not-written";
  const after = readRegistry();
  if (!after.ok) return "unknown";
  return after.record === starting ? "verified" : "replaced";
}

/**
 * Join an active epoch: guarded refcount transition. Fail-closed — a
 * corrupt (refcount < 1) or unmutable record never returns a lease.
 */
function joinActiveEpoch(
  record: RegistryRecord,
): BridgeLease {
  if (record.refcount < 1) {
    throw new BridgeActivationError(
      "activation-registry-failed",
      "active bridge record has a corrupt refcount; refusing to join",
      "registry-write-failed",
    );
  }
  try {
    record.refcount += 1;
  } catch {
    throw new BridgeActivationError(
      "activation-registry-failed",
      "active bridge refcount transition failed; refusing to join",
      "registry-write-failed",
    );
  }
  return makeLease(record, true);
}

/** Build an idempotent, epoch-bound lease for an active record. */
function makeLease(
  record: RegistryRecord,
  reused: boolean,
): BridgeLease {
  const epoch = record.epoch;
  // Single-flight lease state. A deferred shared Promise is allocated and
  // assigned SYNCHRONOUSLY before any release work begins. Reentrant /
  // concurrent calls while releasing receive that exact Promise.
  let leaseState: "open" | "releasing" | "settled" = "open";
  let inflight: Promise<boolean> | undefined;
  return {
    epoch,
    server: record.server as BridgeServerHandle,
    identity: record.identity,
    reused,
    dispose(): Promise<boolean> {
      if (leaseState === "settled") return Promise.resolve(false);
      if (leaseState === "releasing") return inflight as Promise<boolean>;
      leaseState = "releasing";
      let resolveDeferred!: (value: boolean) => void;
      let rejectDeferred!: (reason: unknown) => void;
      inflight = new Promise<boolean>((resolve, reject) => {
        resolveDeferred = resolve;
        rejectDeferred = reject;
      });
      releaseLease(epoch).then(
        (result) => {
          if (result.kind === "retryable") {
            // Return to open ONLY after the release promise settled. The
            // rejection is a stable, redacted, typed error — never raw.
            leaseState = "open";
            inflight = undefined;
            rejectDeferred(
              new BridgeActivationError(
                "activation-registry-failed",
                "bridge lease release could not be proven; the lease remains open and retryable",
                result.detail,
              ),
            );
            return;
          }
          leaseState = "settled";
          inflight = undefined;
          resolveDeferred(result.kind === "final");
        },
        (error: unknown) => {
          leaseState = "open";
          inflight = undefined;
          rejectDeferred(error);
        },
      );
      return inflight;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Release                                                             */
/* ------------------------------------------------------------------ */

/**
 * Internal release accounting result:
 * - `consumed` — an intermediate decrement, or a stale/no-op release with
 *   nothing left to account for (terminal for this lease).
 * - `final` — this release performed the final stop attempt (terminal).
 * - `fenced` — the epoch/realm is fenced or corrupt (terminal; no stop).
 * - `retryable` — registry read failure or an Active→Stopping transition
 *   that failed BEFORE writing; NO stop was attempted and the lease must
 *   NOT be marked disposed (the caller may retry the same lease).
 */
type ReleaseResult =
  | { kind: "consumed" }
  | { kind: "final" }
  | { kind: "fenced" }
  | { kind: "retryable"; detail: BridgeFailureClassification };

/**
 * Stop an owned handle exactly once under a realm fence: publish + readback
 * verify the cleanup-pending poison (retaining the handle PRIVATELY) BEFORE
 * awaiting the stop, so every acquisition is fenced while cleanup is
 * pending. The poison is retained regardless of the stop outcome (success:
 * cleanup complete but the fence stays until process teardown; failure: the
 * fence retains the live handle). Returns verification and stop outcomes.
 */
async function fencedOwnedStopOnce(input: {
  epoch: string;
  key: BridgeReuseKey;
  server: BridgeServerHandle;
  reason: RealmPoison["reason"];
  errorCode: BridgeFailureClassification;
}): Promise<{ poisonVerified: boolean; stopFailed: boolean }> {
  const poisonVerified = publishRealmPoison({
    epoch: input.epoch,
    reason: input.reason,
    errorCode: input.errorCode,
    orphanPort: input.key.port,
    keyDigest: keyDigest(input.key),
    orphanHandle: input.server,
  });
  if (!poisonVerified) {
    // Observable, typed downstream: the caller fails typed and never claims
    // cleanup safety. The stop below is still attempted exactly once (the
    // strongest available action for our own handle).
  }
  let stopFailed = false;
  try {
    await input.server.stop(true);
  } catch {
    stopFailed = true;
  }
  return { poisonVerified, stopFailed };
}

/**
 * Release one reference for the given owner epoch. Epoch fencing: a stale
 * (mismatched epoch) or out-of-order release never affects the current
 * record. The final release transitions Active → Stopping (at refcount 1 —
 * Active never observably holds refcount 0), then AWAITS the server stop
 * while the exact epoch remains `stopping`. Stop resolution clears ONLY the
 * exact stopping epoch; a clear failure leaves a blocking cleanup-failed
 * record (and poisons the realm when the slot state is unknowable). A stop
 * rejection fences the exact epoch as failed-stop (in place if the fence
 * write itself fails).
 */
async function releaseLease(
  epoch: string,
): Promise<ReleaseResult> {
  const read = readRegistry();
  if (!read.ok) {
    // No stop without proof of state; lease stays open/retryable.
    return { kind: "retryable", detail: "registry-read-failed" };
  }
  const record = read.record;
  if (record === undefined) {
    return { kind: "consumed" };
  }
  if (record.state !== "active" || record.epoch !== epoch) {
    // Stale/out-of-order release, or the registry is fenced/stopping.
    return { kind: "consumed" };
  }
  if (record.refcount < 1) return { kind: "fenced" }; // corrupt: terminal

  if (record.refcount > 1) {
    try {
      record.refcount -= 1;
    } catch {
      // Mutation failure: no stop, lease retriable.
      return { kind: "retryable", detail: "registry-write-failed" };
    }
    return { kind: "consumed" };
  }

  // Final release (refcount === 1): transition to Stopping BEFORE stop.
  const stopping: RegistryRecord = {
    state: "stopping",
    epoch: record.epoch,
    key: record.key,
    identity: record.identity,
    server: record.server,
    refcount: 0,
  };
  const toStopping = compareAndTransition(record, stopping);
  if (toStopping === "not-written") {
    // Pre-write failure: the slot still holds the active record; no stop
    // attempted, no false claim — the lease stays open/retryable.
    return { kind: "retryable", detail: "registry-write-failed" };
  }
  if (toStopping === "unknown" || toStopping === "replaced") {
    // Write-applied/readback-unknown OR replaced mid-transition. NEVER leave
    // a reusable active or an unowned stopping record behind:
    //  - unknown: poison BOTH candidate records in place (whichever the
    //    slot holds is fenced, never reusable/stranded).
    //  - replaced: the replacement is authoritative — never clobbered.
    // Then, under verified realm poison, stop the owned handle exactly once.
    if (toStopping === "unknown") {
      fenceInPlace(record, "failed-stop", "registry-write-failed");
      fenceInPlace(stopping, "failed-stop", "registry-write-failed");
    }
    const outcome = await fencedOwnedStopOnce({
      epoch,
      key: record.key,
      server: record.server as BridgeServerHandle,
      reason: "release-transition-cleanup-pending",
      errorCode: "registry-write-failed",
    });
    if (outcome.stopFailed) {
      console.error("[omo-telemetry-bridge] failed to stop telemetry server");
    }
    if (!outcome.poisonVerified) {
      // Poison could not be proven: typed-fail; the in-place fences are the
      // strongest retained guard. Cleanup safety is NOT claimed.
      return { kind: "retryable", detail: "registry-write-failed" };
    }
    return { kind: "final" };
  }

  // Publish + readback-verify a transient realm cleanup-pending poison BEFORE
  // awaiting the final stop. Any acquisition arriving while stop is pending
  // will reject; if stop rejects, the poison remains and failed handle is
  // retained privately.
  const poisonVerified = publishRealmPoison({
    epoch: stopping.epoch,
    reason: "release-transition-cleanup-pending",
    errorCode: "stop-failed",
    orphanPort: stopping.key.port,
    keyDigest: keyDigest(stopping.key),
    orphanHandle: stopping.server,
  });
  if (!poisonVerified) {
  }

  let stopFailed = false;
  try {
    await stopping.server?.stop(true);
  } catch {
    stopFailed = true;
  }
  if (stopFailed) {
    console.error("[omo-telemetry-bridge] failed to stop telemetry server");
    const fenced: RegistryRecord = {
      state: "failed-stop",
      epoch: stopping.epoch,
      key: stopping.key,
      identity: stopping.identity,
      server: stopping.server,
      refcount: 0,
      errorCode: "stop-failed",
    };
    const fenceOutcome = compareAndTransition(stopping, fenced);
    if (fenceOutcome !== "verified") {
      fenceInPlace(stopping, "failed-stop", "stop-failed");
      if (fenceOutcome === "unknown") {
        poisonRealm({
          epoch: stopping.epoch,
          reason: "stop-fence-unknown",
          errorCode: "stop-failed",
          orphanPort: stopping.key.port,
          orphanHandle: stopping.server,
        });
      }
    }
    return { kind: "final" };
  }

  // Stop succeeded: clear ONLY the exact stopping epoch.
  const clearOutcome = compareAndTransition(stopping, undefined);
  if (clearOutcome === "verified") {
    clearRealmPoison(epoch);
    return { kind: "final" };
  }
  if (clearOutcome === "replaced") {
    // A replacement is authoritative — never clobber it. Our handle is
    // already stopped, so nothing is left untracked.
    clearRealmPoison(epoch);
    return { kind: "final" };
  }
  // not-written or unknown: leave an explicit blocking cleanup-failed
  // record; poison the realm when the slot state is unknowable.
  if (clearOutcome === "unknown") {
    poisonRealm({
      epoch: stopping.epoch,
      reason: "stop-clear-unknown",
      errorCode: "registry-write-failed",
      orphanPort: stopping.key.port,
    });
  }
  const cleanupFailed: RegistryRecord = {
    state: "cleanup-failed",
    epoch: stopping.epoch,
    key: stopping.key,
    identity: stopping.identity,
    server: stopping.server,
    refcount: 0,
    errorCode: "registry-write-failed",
  };
  if (compareAndTransition(stopping, cleanupFailed) !== "verified") {
    fenceInPlace(stopping, "cleanup-failed", "registry-write-failed");
  }
  return { kind: "final" };
}

/**
 * Test-only seam: invoke the epoch-fenced release path directly (reaches
 * the stale/epoch-mismatch branch without a local disposed guard).
 */
export function __releaseLeaseForTests(
  epoch: string,
): Promise<boolean> {
  return releaseLease(epoch).then((r) => r.kind === "final");
}

/**
 * Test-only server-factory override slot for the plugin entry (index.ts).
 * Kept as a Symbol.for slot so index.ts retains its default-only export
 * surface (upstream must never see named exports as plugin candidates).
 * Production never sets this; tests must reset it afterwards.
 */
const TEST_FACTORY_SYMBOL = Symbol.for("omo-telemetry-bridge.test.serverFactory");

/** Test-only: override the plugin entry's server factory. */
export function __setBridgeServerFactoryForTests(
  factory: BridgeServerFactory | undefined,
): void {
  try {
    const g = globalThis as unknown as Record<symbol, unknown>;
    if (factory === undefined) delete g[TEST_FACTORY_SYMBOL];
    else g[TEST_FACTORY_SYMBOL] = factory;
  } catch {
    // ignore
  }
}

/** @internal Read the test-only factory override (undefined in production). */
export function __testServerFactoryOverride(): BridgeServerFactory | undefined {
  try {
    return (globalThis as unknown as Record<symbol, unknown>)[
      TEST_FACTORY_SYMBOL
    ] as BridgeServerFactory | undefined;
  } catch {
    return undefined;
  }
}
