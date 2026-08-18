/**
 * Slice 17 v3 TelemetryBridgeManager — canonical source for the dynamic
 * bridge URL and lifecycle state.
 *
 * Inputs are generic so the future index can feed them without the OMO
 * runtime lane depending on index/config/lifecycle internals.
 *
 * URL precedence:
 * 1. Valid explicit loopback override wins observation and opts out of
 *    management. Defense-in-depth: the manager validates the override is
 *    exactly `http://127.0.0.1:<valid port>` with no userinfo/path except
 *    `/`, query, or fragment. Never requests a non-loopback override even
 *    if the caller incorrectly marks it valid.
 * 2. Managed + control-plane without override derives
 *    `http://127.0.0.1:<committed port>`.
 * 3. Attach / managed-external without explicit discoverable/proven endpoint
 *    remains unavailable / awaiting owner.
 *
 * Never requests non-loopback. Does not hardcode 8788 as managed truth.
 *
 * Handshake/readiness: fetch /health then /telemetry with bounded timeout.
 * Active/verified only after lifecycle backend is connected/ready, health
 * ok+bound+schema3+capabilities+instance, telemetry schema3, identity
 * schema3, transport exact, expected fingerprint exact, canonicalOrigin
 * equals canonical OpenCode origin, same instance ID as health.
 *
 * Runtime/generation identity: verificationEpoch increments whenever
 * lifecycle generation, endpoint, expected fingerprint/source hash/revision/
 * origin/override changes; abort/discard in-flight old epoch. On generation
 * change, current bridge state immediately stale/unverified. During same
 * control-plane process, successful replacement generation requires a new
 * pluginInstanceId; after control-plane restart first binding may accept
 * existing instance for current backend (initialization flag). Old
 * telemetry never repopulates current state.
 *
 * The manager exposes:
 * - getBridgeStatus(): sanitized OmoBridgeStatus sourced from verified
 *   current-generation state (verified=true only after full correlation).
 * - getLifecycleState(): full lifecycle state.
 * - subscribe(): receive sanitized lifecycle/status changes without polling.
 *
 * Security: stores are sanitized to OmoBridgeStores before retention/exposure,
 * never raw unknown. No raw nonce/token/provider credential/environment/
 * terminal content. Errors are redacted. OMO version is never fabricated
 * from bridge package version (bridgePackageVersion remains advisory).
 */

import {
  OMO_BRIDGE_SCHEMA_VERSION_V3,
  type OmoBridgeCapabilities,
  type OmoBridgeCommittedActivation,
  type OmoBridgeHealth,
  type OmoBridgeIdentity,
  type OmoBridgeLifecycleState,
  type OmoBridgeManagerInput,
  type OmoBridgeOpenCodeMode,
  type OmoBridgeOwnership,
  type OmoBridgeRegistrationState,
  type OmoBridgeRuntimeState,
  type OmoBridgeStatus,
  type OmoBridgeStores,
} from "./types";
import {
  parseTelemetryPayload,
  sanitizeBridgeHealth,
  sanitizeBridgeStores,
  verifyV3Identity,
  type ParsedTelemetry,
  type VerifiedV3Result,
} from "./v3";
import {
  ReconnectScheduler,
  STEADY_STATE_INTERVAL_MS,
  type SchedulerFetch,
  type SchedulerTickResult,
  type SchedulerTimers,
} from "./scheduler";

/** Default fetch timeout (ms). */
export const BRIDGE_FETCH_TIMEOUT_MS = 1_500;

/** Loopback host (hardcoded — never read from input). */
const LOOPBACK_HOST = "127.0.0.1";

/** Injected timer functions (deterministic for tests). */
export type ManagerTimers = SchedulerTimers;

/** Injected fetch function. */
export type ManagerFetch = SchedulerFetch;

/** Options for the manager. */
export interface TelemetryBridgeManagerOptions {
  /** Fetch timeout (ms). */
  timeoutMs?: number;
  /** Injected fetch. */
  fetchImpl?: ManagerFetch;
  /** Injected timers. */
  timers?: ManagerTimers;
  /** Whether to fetch /health before /telemetry. Default true. */
  fetchHealth?: boolean;
  /** Steady-state poll interval after success (ms). Default 3000. */
  steadyStateIntervalMs?: number;
}

/** Verified bridge state (current generation only). */
export interface VerifiedBridgeState {
  /** Verified v3 identity. */
  identity: OmoBridgeIdentity;
  /** Verified v3 capabilities. */
  capabilities: OmoBridgeCapabilities;
  /** Sanitized stores payload (sanitized to OmoBridgeStores). */
  stores: OmoBridgeStores | undefined;
  /** Captured-at timestamp from telemetry. */
  capturedAt: number;
  /** Verification epoch when this state was verified. */
  epoch: number;
  /** Lifecycle generation when this state was verified. */
  generation: number;
}

/** Listener for sanitized lifecycle/status changes. */
export type BridgeManagerListener = (
  lifecycle: OmoBridgeLifecycleState,
  status: OmoBridgeStatus,
) => void;

/**
 * TelemetryBridgeManager — canonical source for the dynamic bridge URL and
 * lifecycle state. Owns the reconnect scheduler and the verification epoch.
 *
 * The manager does NOT write config, restart OpenCode, or depend on
 * task/runtime activity. It only reads the bridge endpoint and produces
 * lifecycle state.
 */
export class TelemetryBridgeManager {
  private readonly opts: Required<TelemetryBridgeManagerOptions>;
  private input: OmoBridgeManagerInput | undefined;
  private epoch = 0;
  private scheduler: ReconnectScheduler | undefined;
  private verified: VerifiedBridgeState | undefined;
  /**
   * Last accepted pluginInstanceId from the PREVIOUS generation (preserved
   * separately for comparison). On new generation within same control-plane
   * process, a different instance ID is required.
   */
  private prevGenAcceptedInstanceId: string | undefined;
  /** Last accepted pluginInstanceId for the CURRENT generation. */
  private currentGenAcceptedInstanceId: string | undefined;
  /** Whether the first binding has been observed for the current generation. */
  private firstBindingObserved = false;
  /** Current lifecycle state (cached). */
  private lifecycleState: OmoBridgeLifecycleState | undefined;
  /** Last structured redacted verify reason (for mismatch rendering). */
  private lastVerifyReason: string | undefined;
  /** Last error (redacted). */
  private lastError: string | undefined;
  /** Whether the backend (health) is connected/ready. */
  private backendConnected = false;
  /** Last health document (sanitized). */
  private lastHealth: OmoBridgeHealth | undefined;
  /** Listeners for state/status changes. */
  private listeners = new Set<BridgeManagerListener>();

  constructor(opts: TelemetryBridgeManagerOptions = {}) {
    this.opts = {
      timeoutMs: opts.timeoutMs ?? BRIDGE_FETCH_TIMEOUT_MS,
      fetchImpl: opts.fetchImpl ?? (globalThis.fetch as unknown as ManagerFetch),
      timers: opts.timers ?? {
        now: Date.now,
        setTimeout: (cb, ms) => setTimeout(cb, ms),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      fetchHealth: opts.fetchHealth ?? true,
      steadyStateIntervalMs: opts.steadyStateIntervalMs ?? STEADY_STATE_INTERVAL_MS,
    };
  }

  // ── public API ───────────────────────────────────────────────────────

  /**
   * Update the manager input. When the generation/endpoint/expected
   * fingerprint/source hash/revision/origin/override changes, the
   * verification epoch increments and in-flight old-epoch work is aborted.
   */
  update(input: OmoBridgeManagerInput): void {
    const prev = this.input;
    const changed = this.inputChanged(prev, input);
    this.input = input;

    if (changed) {
      this.epoch++;
      // On generation change, current bridge state immediately stale.
      this.verified = undefined;
      this.lastHealth = undefined;
      this.backendConnected = false;
      this.lastError = undefined;
      this.lastVerifyReason = undefined;
      // Preserve previous generation's accepted instance ID for comparison.
      // Do NOT erase it before comparison. Reset first-binding flag.
      if (prev && input.generation !== prev.generation) {
        this.prevGenAcceptedInstanceId = this.currentGenAcceptedInstanceId;
        this.currentGenAcceptedInstanceId = undefined;
        this.firstBindingObserved = false;
      }
    }
    this.reconcileScheduler(changed);
    this.refreshLifecycleState();
  }

  /** Get the current bridge endpoint URL (undefined when unavailable). */
  getEndpoint(): string | undefined {
    return this.deriveEndpoint(this.input);
  }

  /** Get the current verified bridge state (undefined when not verified). */
  getVerifiedState(): VerifiedBridgeState | undefined {
    return this.verified;
  }

  /**
   * Get the sanitized bridge status sourced from the verified
   * current-generation state. verified=true only after full health+telemetry
   * expected fingerprint+origin+instance match. Stores are sanitized to
   * OmoBridgeStores before exposure, never raw unknown.
   */
  getBridgeStatus(): OmoBridgeStatus {
    if (this.verified) {
      const v = this.verified;
      return {
        connected: true,
        lastSeenAt: this.opts.timers.now(),
        schemaVersion: OMO_BRIDGE_SCHEMA_VERSION_V3,
        stores: v.stores,
        identity: v.identity,
        capabilities: v.capabilities,
        ...(v.identity.bridgePackageVersion
          ? { bridgePackageVersion: v.identity.bridgePackageVersion }
          : {}),
        verified: true,
      };
    }
    // Not verified — return disconnected/unverified.
    return { connected: false, verified: false };
  }

  /** Get the current lifecycle state. */
  getLifecycleState(): OmoBridgeLifecycleState | undefined {
    return this.lifecycleState;
  }

  /** Get the current verification epoch. */
  getEpoch(): number {
    return this.epoch;
  }

  /** Start the reconnect scheduler (idempotent). */
  start(): void {
    if (this.scheduler) this.scheduler.start();
  }

  /** Stop the reconnect scheduler and abort in-flight work (idempotent). */
  stop(): void {
    this.epoch++;
    this.scheduler?.stop();
  }

  /** Whether the manager has been given input. */
  get configured(): boolean {
    return this.input !== undefined;
  }

  /**
   * Subscribe to sanitized lifecycle/status changes. The listener receives
   * only sanitized lifecycle state and bridge status (no raw secrets).
   * Returns an unsubscribe function.
   */
  subscribe(listener: BridgeManagerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── internals ───────────────────────────────────────────────────────

  /**
   * Derive the bridge endpoint URL per the precedence rules.
   * 1. Valid explicit loopback override wins and opts out of management.
   *    Defense-in-depth: validate the override is exactly
   *    `http://127.0.0.1:<valid port>` with no userinfo/path except `/`,
   *    query, or fragment. Never request a non-loopback override even if
   *    the caller incorrectly marks it valid.
   * 2. Managed + control-plane with committed port derives
   *    http://127.0.0.1:<committed port>.
   * 3. Attach / external without explicit endpoint → unavailable.
   */
  private deriveEndpoint(input: OmoBridgeManagerInput | undefined): string | undefined {
    if (!input) return undefined;
    // 1. Valid explicit override — defense-in-depth validate loopback.
    if (input.overrideUrl && !input.overrideInvalid) {
      const validated = validateLoopbackUrl(input.overrideUrl);
      if (validated) return validated;
      // Override marked valid but failed defense-in-depth validation →
      // do NOT request a non-loopback URL. Fall through to managed.
    }
    // 2. Managed + control-plane with committed port.
    if (
      input.mode === "managed" &&
      input.ownership === "control-plane" &&
      input.committed.enabled &&
      typeof input.committed.port === "number"
    ) {
      return `http://${LOOPBACK_HOST}:${input.committed.port}`;
    }
    // 3. Attach / external without explicit endpoint → unavailable.
    return undefined;
  }

  /** Whether the endpoint source is an explicit override. */
  private isOverrideActive(input: OmoBridgeManagerInput | undefined): boolean {
    if (!input?.overrideUrl || input.overrideInvalid) return false;
    // Defense-in-depth: only count as active if it passes validation.
    return validateLoopbackUrl(input.overrideUrl) !== undefined;
  }

  /** Detect whether the input changed in a way that requires epoch bump. */
  private inputChanged(
    prev: OmoBridgeManagerInput | undefined,
    next: OmoBridgeManagerInput,
  ): boolean {
    if (!prev) return true;
    if (
      prev.mode !== next.mode ||
      prev.ownership !== next.ownership ||
      prev.generation !== next.generation ||
      prev.canonicalOrigin !== next.canonicalOrigin ||
      prev.omoReady !== next.omoReady ||
      prev.overrideUrl !== next.overrideUrl ||
      prev.overrideInvalid !== next.overrideInvalid ||
      prev.acceptExistingInstanceOnFirstBinding !==
        next.acceptExistingInstanceOnFirstBinding ||
      prev.localPackageAvailable !== next.localPackageAvailable ||
      prev.registration !== next.registration
    ) {
      return true;
    }
    return this.committedChanged(prev.committed, next.committed);
  }

  /** Whether the committed activation changed (port/fingerprint/hash/revision/transport). */
  private committedChanged(
    prev: OmoBridgeCommittedActivation,
    next: OmoBridgeCommittedActivation,
  ): boolean {
    return (
      prev.enabled !== next.enabled ||
      prev.port !== next.port ||
      prev.nonceFingerprint !== next.nonceFingerprint ||
      prev.sourceHash !== next.sourceHash ||
      prev.revisionId !== next.revisionId ||
      prev.registrationTransport !== next.registrationTransport
    );
  }

  /** Reconcile the scheduler with the current input. */
  private reconcileScheduler(changed: boolean): void {
    const endpoint = this.deriveEndpoint(this.input);
    if (!endpoint) {
      // No endpoint → stop scheduler.
      this.scheduler?.stop();
      this.scheduler = undefined;
      return;
    }
    if (!this.scheduler || changed) {
      this.scheduler?.stop();
      this.scheduler = new ReconnectScheduler({
        baseUrl: endpoint,
        timeoutMs: this.opts.timeoutMs,
        fetchImpl: this.opts.fetchImpl,
        timers: this.opts.timers,
        fetchHealth: this.opts.fetchHealth,
        steadyStateIntervalMs: this.opts.steadyStateIntervalMs,
        verify: (payload, health) => this.verifyPayload(payload, health),
        onTick: (result) => this.handleTick(result),
      });
      this.scheduler.start();
    }
  }

  /**
   * Verify a payload+health pair against the current expected identity.
   * Returns { ok, reason } with a structured redacted reason for failure.
   */
  private verifyPayload(
    payload: unknown,
    health: unknown,
  ): { ok: boolean; reason?: string } {
    const input = this.input;
    if (!input) return { ok: false, reason: "no input" };
    // OMO readiness arrives via lifecycle input; do not infer from port.
    if (!input.omoReady) return { ok: false, reason: "omo not ready" };

    let parsed: ParsedTelemetry;
    try {
      parsed = parseTelemetryPayload(payload);
    } catch (e) {
      return {
        ok: false,
        reason: e instanceof Error ? e.message : "parse failed",
      };
    }
    if (!parsed.isV3) return { ok: false, reason: "legacy payload" };

    let healthDoc: OmoBridgeHealth | undefined;
    if (health !== undefined) {
      try {
        healthDoc = sanitizeBridgeHealth(health);
      } catch (e) {
        return {
          ok: false,
          reason: e instanceof Error ? e.message : "health parse failed",
        };
      }
    }

    // Health must be ok+bound+schema3+capabilities+instance.
    if (healthDoc) {
      if (!healthDoc.ok) return { ok: false, reason: "health not ok" };
      if (!healthDoc.bound) return { ok: false, reason: "health not bound" };
      if (healthDoc.schemaVersion !== OMO_BRIDGE_SCHEMA_VERSION_V3) {
        return { ok: false, reason: "health schemaVersion is not 3" };
      }
      if (!healthDoc.pluginInstanceId) {
        return { ok: false, reason: "health missing pluginInstanceId" };
      }
    }

    const expectedFingerprint = input.committed.nonceFingerprint;
    const canonicalOrigin = input.canonicalOrigin;
    const healthInstanceId = healthDoc?.pluginInstanceId;

    const result: VerifiedV3Result = verifyV3Identity(parsed, {
      expectedFingerprint,
      canonicalOrigin,
      healthInstanceId,
    });
    if (!result.ok) return { ok: false, reason: result.reason };

    // Generation identity: same control-plane process replacement requires
    // a new pluginInstanceId. After control-plane restart first binding may
    // accept existing instance for current backend (initialization flag).
    // The previous generation's accepted instance ID is preserved separately
    // for comparison — do NOT erase it before comparison.
    const instanceId = result.identity.pluginInstanceId;
    if (this.firstBindingObserved) {
      // A binding was already observed for the current generation. The same
      // instance continuing is fine. A different instance for the same
      // generation within the same process is a replacement — accept the
      // new instance.
    } else {
      // First binding for this generation.
      if (this.prevGenAcceptedInstanceId !== undefined) {
        // There was a previous generation in this process. Replacement
        // generation within same process requires a NEW pluginInstanceId.
        if (instanceId === this.prevGenAcceptedInstanceId) {
          // Same instance as previous generation — reject unless this is
          // a control-plane restart first binding (initialization flag).
          if (!input.acceptExistingInstanceOnFirstBinding) {
            return {
              ok: false,
              reason: "pluginInstanceId same as previous generation (stale)",
            };
          }
          // acceptExistingInstanceOnFirstBinding — accept.
        }
        // Different instance — accept.
      }
      // No previous generation — first binding ever, accept.
    }

    return { ok: true };
  }

  /** Handle a scheduler tick result. */
  private handleTick(result: SchedulerTickResult): void {
    const input = this.input;
    if (!input) return;
    if (result.verified && result.payload) {
      try {
        const parsed = parseTelemetryPayload(result.payload);
        if (parsed.isV3 && parsed.identity && parsed.capabilities) {
          const instanceId = parsed.identity.pluginInstanceId;
          this.currentGenAcceptedInstanceId = instanceId;
          this.firstBindingObserved = true;
          // Sanitize stores to OmoBridgeStores before retention.
          const sanitizedStores = sanitizeBridgeStores(parsed.stores);
          this.verified = {
            identity: parsed.identity,
            capabilities: parsed.capabilities,
            stores: sanitizedStores,
            capturedAt: parsed.capturedAt ?? this.opts.timers.now(),
            epoch: this.epoch,
            generation: input.generation,
          };
          this.lastError = undefined;
          this.lastVerifyReason = undefined;
          if (result.health) {
            try {
              this.lastHealth = sanitizeBridgeHealth(result.health);
              this.backendConnected =
                !!this.lastHealth.ok && !!this.lastHealth.bound;
            } catch {
              this.lastHealth = undefined;
              this.backendConnected = false;
            }
          }
        }
      } catch {
        // ignore parse failure
      }
    } else if (result.legacy) {
      // Legacy v1/v2 — display only, never authoritative.
      this.verified = undefined;
      this.lastVerifyReason = result.verifyReason;
      this.lastError = result.error ?? "legacy";
    } else {
      // Failed / mismatch. Preserve the actual verifier failure reason.
      this.verified = undefined;
      this.lastVerifyReason = result.verifyReason;
      this.lastError = result.error ?? result.verifyReason ?? "unverified";
      this.backendConnected = false;
    }
    this.refreshLifecycleState();
  }

  /** Refresh the cached lifecycle state from current inputs+verified state. */
  private refreshLifecycleState(): void {
    const input = this.input;
    if (!input) {
      this.lifecycleState = undefined;
      return;
    }
    const endpoint = this.deriveEndpoint(input);
    const overrideActive = this.isOverrideActive(input);
    const verified = this.verified;

    let runtime: OmoBridgeRuntimeState;
    let compatibility: OmoBridgeLifecycleState["compatibility"];
    const registration: OmoBridgeRegistrationState = input.registration ?? "unknown";

    if (!input.omoReady) {
      runtime = "unavailable";
      compatibility = "unknown";
    } else if (!endpoint) {
      runtime = "unavailable";
      compatibility = "unknown";
    } else if (verified) {
      runtime = "active";
      compatibility = "compatible";
    } else {
      // Distinguish mismatch from generic failure using the structured
      // verify reason. Mismatch reasons render runtime=mismatch,
      // compatibility=incompatible.
      const reason = this.lastVerifyReason ?? this.lastError;
      const isMismatch = reason !== undefined && isMismatchReason(reason);
      if (isMismatch) {
        runtime = "mismatch";
        compatibility = "incompatible";
      } else if (this.scheduler?.running) {
        runtime = "starting";
        compatibility = "unknown";
      } else {
        runtime = "failed";
        compatibility = "unknown";
      }
    }

    const endpointSource: OmoBridgeLifecycleState["endpointSource"] = overrideActive
      ? "explicit-override"
      : endpoint
        ? "managed-derived"
        : "unavailable";

    // Do NOT fabricate OMO version from bridge package version. Omit
    // omoVersion unless an authoritative OMO version field actually exists
    // (it currently does not). Bridge package version remains advisory.
    this.lifecycleState = {
      mode: input.mode,
      ownership: input.ownership,
      restartControllable:
        input.mode === "managed" && input.ownership === "control-plane",
      runtime,
      registration,
      compatibility,
      localPackageAvailable: input.localPackageAvailable ?? "unknown",
      endpointSource,
      ...(endpoint ? { endpoint } : {}),
      overrideActive,
      overrideInvalid: !!input.overrideInvalid,
      ...(verified ? { schemaVersion: verified.identity.schemaVersion } : {}),
      // omoVersion is intentionally omitted — no authoritative OMO version
      // field exists in the bridge payload. Do not fabricate from
      // bridgePackageVersion.
      ...(verified?.identity.bridgePackageVersion
        ? { bridgePackageVersion: verified.identity.bridgePackageVersion }
        : {}),
      ...(verified ? { capabilities: verified.capabilities } : {}),
      ...(verified ? { identity: verified.identity } : {}),
      verificationEpoch: this.epoch,
      generation: input.generation,
      omoReady: input.omoReady,
      backendConnected: this.backendConnected,
      ...(this.lastError ? { error: this.lastError } : {}),
      updatedAt: this.opts.timers.now(),
    };

    // Emit to subscribers with sanitized lifecycle + status.
    const status = this.getBridgeStatus();
    for (const l of this.listeners) {
      try {
        l(this.lifecycleState!, status);
      } catch {
        /* listener errors must not break the manager */
      }
    }
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * Defense-in-depth loopback URL validation. Validates the URL is exactly
 * `http://127.0.0.1:<valid port>` with no userinfo, path except `/`, query,
 * or fragment. Returns the canonical URL when valid, undefined otherwise.
 * Never requests a non-loopback URL even if the caller incorrectly marks
 * it valid.
 */
function validateLoopbackUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:") return undefined;
    if (parsed.hostname !== LOOPBACK_HOST) return undefined;
    if (parsed.username || parsed.password) return undefined;
    if (parsed.search) return undefined;
    if (parsed.hash) return undefined;
    if (parsed.pathname !== "/" && parsed.pathname !== "") return undefined;
    const portStr = parsed.port;
    if (!portStr) return undefined;
    const port = Number.parseInt(portStr, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    return `http://${LOOPBACK_HOST}:${port}`;
  } catch {
    return undefined;
  }
}

/**
 * Whether a verify reason indicates a mismatch (fingerprint/origin/instance/
 * schema/transport). Used to render runtime=mismatch,
 * compatibility=incompatible.
 */
function isMismatchReason(reason: string): boolean {
  const mismatchPatterns = [
    "fingerprint",
    "canonicalOrigin",
    "pluginInstanceId",
    "schemaVersion",
    "transportMode",
    "same as previous generation",
  ];
  return mismatchPatterns.some((p) => reason.includes(p));
}