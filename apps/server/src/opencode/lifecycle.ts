import type {
  OpenCodeLifecycleOwnership,
  OpenCodeLifecycleReadiness,
  OpenCodeLifecycleState,
  RuntimeConnection,
} from "@omo/shared";
import type { ServerConfig } from "../config";
import { PREFERRED_OPENCODE_BASE_URL } from "../config";
import { createServer } from "node:net";
import { OpenCodeClient, OpenCodeRequestError } from "./client";
import {
  INSTALLED_SDK_SUPPORTS_EPHEMERAL_PORT,
  startManagedSdkServer,
  setBridgeRevisionStoreForLaunch,
  type ManagedSdkHandle,
  type ManagedSdkStarter,
} from "./sdk-adapter";
import type { BridgeRevisionStore } from "../opencode-bridge/revisions-bridge";
import { BRIDGE_PORT_RANGE_START, BRIDGE_PORT_RANGE_END } from "../opencode-bridge/types";
import {
  openCodeAuthFromEnv,
  sanitizeOpenCodeError,
  type OpenCodeBasicAuth,
} from "./security";

const PROBE_TIMEOUT_MS = 1_500;
const START_TIMEOUT_MS = 15_000;
const READINESS_TIMEOUT_MS = 30_000;
const READINESS_POLL_MS = 250;
export const MANAGED_RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

type LifecycleListener = (state: OpenCodeLifecycleState) => void;

/**
 * Reconciliation-clean gate for owned starts (Phase 2).
 *
 * An owned OpenCode start/restart is permitted only when BOTH hold:
 *  - the cached bridge reconcile disposition is not `recovery-pending`
 *    (a failed/exceptional startup reconcile or drift recovery must block
 *    repeated SDK starts, not just the launch boundary); and
 *  - the revision store reports no unresolved or conflict intents
 *    (conflict/drift states surface as such intents).
 *
 * Exported as a pure helper so the composition root (index.ts) wires a thin
 * closure and the logic stays unit-testable without importing the server
 * entry point. Fails closed on store errors.
 */
export function computeBridgeReconciliationClean(input: {
  cachedDisposition?: "not-written" | "committed" | "recovery-pending";
  hasUnresolvedOrConflictIntents: () => boolean;
}): boolean {
  if (input.cachedDisposition === "recovery-pending") return false;
  try {
    return !input.hasUnresolvedOrConflictIntents();
  } catch {
    return false;
  }
}

/**
 * External-edit drift gate (Phase 2, Gate 2). When an external edit touches
 * a watched config directory while an active committed bridge activation
 * exists, the cached reconcile disposition must be dirtied IMMEDIATELY
 * (before any async refresh) so the owned-start gate blocks repeated SDK
 * starts until a real reconcile proves cleanliness. Unresolved-intent
 * absence alone must never make the gate clean again — only an explicit
 * reconcile/rewrite path may restore a clean disposition.
 *
 * Pure helper: returns the dirtied disposition object, or undefined when no
 * change is required (no active committed state, or already
 * recovery-pending). Callers treat read errors as "active committed state
 * present" (fail closed).
 */
export function bridgeReconcileDispositionAfterExternalEdit(input: {
  hasActiveCommittedState: boolean;
  currentDisposition: "not-written" | "committed" | "recovery-pending";
}): {
  disposition: "recovery-pending";
  errors: Array<{ code: "state-recovery-pending"; message: string }>;
} | undefined {
  if (!input.hasActiveCommittedState) return undefined;
  if (input.currentDisposition === "recovery-pending") return undefined;
  return {
    disposition: "recovery-pending",
    errors: [
      {
        code: "state-recovery-pending",
        message:
          "External edit detected with an active committed bridge activation; reconciliation required before owned start.",
      },
    ],
  };
}

// ── Lifecycle-local types (Slice 17) ───────────────────────────────────
//
// Narrow types that distinguish normal restarting vs telemetry activation
// restart and managed external/attach awaiting owner restart at the status
// composition boundary. These do NOT change mode/ownership semantics; they
// only add metadata for consumers that need to distinguish restart kinds.

/**
 * The kind of restart in progress, if any. Distinguishes:
 *  - `ordinary`: normal backend-loss recovery (uses MANAGED_RESTART_DELAYS_MS)
 *  - `telemetry-activation`: explicit restartForTelemetryBridge in progress
 *  - `awaiting-owner`: managed+external or attach lost backend, awaiting
 *    owner/external process action (no automatic owned restart)
 */
export type LifecycleRestartKind =
  | "ordinary"
  | "telemetry-activation"
  | "awaiting-owner";

/**
 * Extended lifecycle state with restart-kind metadata. The base
 * OpenCodeLifecycleState (in @omo/shared) is preserved unchanged; this
 * local extension adds a `restartKind` field for consumers that need to
 * distinguish restart kinds at the status composition boundary.
 */
export interface OpenCodeLifecycleStateWithRestartKind extends OpenCodeLifecycleState {
  /** Present only when status is "restarting"; distinguishes restart kinds. */
  restartKind?: LifecycleRestartKind;
}

export interface LifecycleProbeResult {
  kind: "ready" | "refused" | "collision" | "unavailable";
  version?: string;
  readiness: OpenCodeLifecycleReadiness;
  detail?: string;
}

/**
 * Bridge composition dependency hooks. The composition root owns and closes
 * the BridgeRevisionStore; the lifecycle never closes it. The reconciliation
 * hook is called before every owned startup/recovery/activation restart to
 * require bridge reconciliation clean. Dirty/conflict blocks owned start.
 */
export interface BridgeCompositionHooks {
  /** Long-lived bridge revision store (composition root owns/closes). */
  store?: BridgeRevisionStore;
  /**
   * Called before every owned startup/recovery/activation restart. Must
   * return true when bridge reconciliation is clean (no unresolved/conflict
   * intents). Returning false blocks owned start with a redacted error.
   * When omitted, reconciliation is assumed clean (disabled lane).
   */
  isReconciliationClean?: () => boolean;
  /**
   * Injectable port-occupancy check for the committed bridge port. Used
   * before closing owned backend on activate/recover to detect a foreign
   * listener (port race). When omitted, a TCP connect probe is used.
   * Returns true when the port is occupied (in use), false when free.
   */
  isBridgePortOccupied?: (port: number) => Promise<boolean>;
}

export interface OpenCodeLifecycleManagerDeps {
  env?: Record<string, string | undefined>;
  startSdk?: ManagedSdkStarter;
  probe?: (
    baseUrl: string,
    options: {
      projectDirectory: string;
      auth?: OpenCodeBasicAuth;
      requireRuntime: boolean;
      omoExpected: boolean;
      timeoutMs: number;
    },
  ) => Promise<LifecycleProbeResult>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  ephemeralPortSupported?: boolean;
  portBindable?: (port: number) => Promise<boolean>;
  /** Bridge composition dependency (optional; composition root owns store). */
  bridge?: BridgeCompositionHooks;
}

function emptyReadiness(omoExpected: boolean): OpenCodeLifecycleReadiness {
  return {
    health: false,
    configProviders: false,
    providers: false,
    agents: false,
    omo: !omoExpected,
    omoExpected,
    rest: false,
    sse: false,
  };
}

function isOmoRegistered(agents: Array<{ name: string }>): boolean {
  const names = new Set(agents.map((a) => a.name));
  const specialists = ["explorer", "librarian", "oracle", "designer", "fixer"]
    .filter((name) => names.has(name));
  return names.has("orchestrator") && specialists.length >= 3;
}

function killSwitchDisabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  return !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function validAttachUrl(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") {
    throw new Error("OPENCODE_BASE_URL is present but empty");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("OPENCODE_BASE_URL is not a valid HTTP URL");
  }
  if (!/^https?:$/.test(url.protocol) || !url.hostname) {
    throw new Error("OPENCODE_BASE_URL must be an http:// or https:// URL");
  }
  // Userinfo can contain credentials and is unsupported; Basic auth comes
  // only from OpenCode's SERVER_USERNAME/PASSWORD environment semantics.
  if (url.username || url.password) {
    throw new Error("OPENCODE_BASE_URL must not contain credentials");
  }
  return url.toString().replace(/\/$/, "");
}

async function bounded<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await operation(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

function refused(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /ECONNREFUSED|connection refused|unable to connect|fetch failed/i.test(msg);
}

function validManagedUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("SDK returned an invalid OpenCode server URL");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("SDK returned a non-loopback OpenCode server URL");
  }
  if (url.username || url.password) {
    throw new Error("SDK returned credentials in the OpenCode server URL");
  }
  return url.toString().replace(/\/$/, "");
}

async function loopbackPortBindable(port: number): Promise<boolean> {
  const server = createServer();
  return new Promise<boolean>((resolve) => {
    const finish = (value: boolean) => {
      server.removeAllListeners();
      if (server.listening) server.close(() => resolve(value));
      else resolve(value);
    };
    server.once("error", () => finish(false));
    server.listen(port, "127.0.0.1", () => finish(true));
  });
}

/**
 * Default bridge port occupancy check: TCP connect to 127.0.0.1:port.
 * Returns true when occupied (connection accepted), false when free
 * (ECONNREFUSED). Other errors fail closed (treat as occupied).
 */
async function defaultBridgePortOccupied(port: number): Promise<boolean> {
  const { createConnection } = await import("node:net");
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const socket = createConnection(
      { host: "127.0.0.1", port, timeout: 250 },
      () => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(true);
      },
    );
    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (err.code === "ECONNREFUSED") {
        resolve(false);
      } else {
        resolve(true);
      }
    });
    socket.on("timeout", () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(true);
    });
  });
}

/** Bounded REST-only probe; SSE starts only after lifecycle activation. */
export async function probeOpenCodeBackend(
  baseUrl: string,
  options: {
    projectDirectory: string;
    auth?: OpenCodeBasicAuth;
    requireRuntime: boolean;
    omoExpected: boolean;
    timeoutMs: number;
  },
): Promise<LifecycleProbeResult> {
  const ready = emptyReadiness(options.omoExpected);
  const client = new OpenCodeClient(baseUrl, {
    projectDirectory: options.projectDirectory,
    auth: options.auth,
  });
  try {
    const health = await bounded(options.timeoutMs, (signal) =>
      client.healthWithSignal(signal));
    ready.health = health.healthy === true;
    ready.rest = ready.health;
    if (!ready.health) {
      return { kind: "collision", version: health.version, readiness: ready, detail: "Health response was not healthy" };
    }
    if (!options.requireRuntime) {
      return { kind: "ready", version: health.version, readiness: ready };
    }

    const runtime = await bounded(options.timeoutMs, () =>
      Promise.all([
        client.configProvidersReady(),
        client.providerReady(),
        client.agents(),
      ]),
    );
    ready.configProviders = runtime[0];
    ready.providers = runtime[1];
    ready.agents = true;
    ready.omo = !options.omoExpected || isOmoRegistered(runtime[2]);
    ready.rest = ready.health && ready.configProviders && ready.providers && ready.agents;
    if (!ready.omo) {
      return {
        kind: "unavailable",
        version: health.version,
        readiness: ready,
        detail: "OMO-Slim agents are not registered in OpenCode /agent",
      };
    }
    return { kind: "ready", version: health.version, readiness: ready };
  } catch (error) {
    return {
      kind: refused(error)
        ? "refused"
        : error instanceof OpenCodeRequestError && [401, 403].includes(error.status)
          ? "unavailable"
          : "collision",
      readiness: ready,
      detail: sanitizeOpenCodeError(error, [options.auth?.password]),
    };
  }
}

// ── restartForTelemetryBridge types ─────────────────────────────────────

/**
 * Intent for an explicit telemetry-bridge restart. The caller (future API)
 * validates explicit confirmation before invoking.
 *  - `activate`: enable the bridge on the committed port with env overlay.
 *  - `deactivate`: disable the bridge (remove env overlay, no bridge env).
 *  - `recover-activation-failure`: recover from a failed activation restart
 *    by starting through strict owned start with bridge env overlay.
 */
export type TelemetryBridgeRestartIntent =
  | "activate"
  | "deactivate"
  | "recover-activation-failure";

/**
 * Expected committed bridge activation state for precondition matching.
 * The caller supplies the committed state it expects; the lifecycle
 * verifies ALL fields match exactly before proceeding. No field may be
 * omitted to bypass a check.
 *
 * For activate / recover-activation-failure: all enabled fields must be
 * present and equal to the committed state (configHash, revisionId,
 * nonceFingerprint, port).
 *
 * For deactivate: generation + configHash + revisionId must be present
 * and equal to the committed disabled state; nonceFingerprint and port
 * must be undefined (the committed disabled state has them absent).
 */
export interface ExpectedBridgeActivationState {
  /** Expected lifecycle generation. */
  generation: number;
  /** Expected committed source hash (configHash from BridgeActivationStateRecord). */
  configHash: string;
  /** Expected committed revision id. */
  revisionId: string;
  /** Expected committed nonce fingerprint (64-char hex). Present for activate/recover; absent for deactivate. */
  nonceFingerprint?: string;
  /** Expected committed port (within managed range 8788..8803). Present for activate/recover; absent for deactivate. */
  port?: number;
}

/**
 * Result of restartForTelemetryBridge. Never contains the raw nonce.
 */
export interface TelemetryBridgeRestartResult {
  ok: boolean;
  /** Error code when ok is false. */
  code?: string;
  /** Redacted, secret-free message. */
  message?: string;
  /** The lifecycle state after the attempt. */
  state: OpenCodeLifecycleState;
}

/**
 * Result of restartForOwnedConfigApply. Never contains secrets.
 */
export interface OwnedConfigApplyRestartResult {
  ok: boolean;
  code?: string;
  /** Redacted, secret-free message. */
  message?: string;
  /** The lifecycle state after the attempt. */
  state: OpenCodeLifecycleState;
}

export class OpenCodeLifecycleManager {
  private readonly env: Record<string, string | undefined>;
  private readonly auth?: OpenCodeBasicAuth;
  private readonly startSdk: ManagedSdkStarter;
  private readonly probe: NonNullable<OpenCodeLifecycleManagerDeps["probe"]>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly ephemeralPortSupported: boolean;
  private readonly portBindable: (port: number) => Promise<boolean>;
  private readonly bridge?: BridgeCompositionHooks;
  private readonly isBridgePortOccupied: (port: number) => Promise<boolean>;
  private readonly listeners = new Set<LifecycleListener>();
  private state: OpenCodeLifecycleStateWithRestartKind;
  private owned?: ManagedSdkHandle;
  private runId = 0;
  private startPromise?: Promise<OpenCodeLifecycleState>;
  private restartPromise?: Promise<void>;
  private stopping = false;
  private restartIndex = 0;
  private lossTimer?: ReturnType<typeof setTimeout>;
  // Telemetry-bridge activation restart state.
  private activationRestartPromise?: Promise<TelemetryBridgeRestartResult>;
  private activationRestartInFlight = false;
  // Owned config-apply restart state (provider management R/W).
  private configApplyRestartPromise?: Promise<OwnedConfigApplyRestartResult>;
  private configApplyRestartInFlight = false;

  constructor(
    private readonly cfg: ServerConfig,
    deps: OpenCodeLifecycleManagerDeps = {},
  ) {
    this.env = deps.env ?? process.env;
    this.auth = openCodeAuthFromEnv(this.env);
    this.startSdk = deps.startSdk ?? startManagedSdkServer;
    this.probe = deps.probe ?? probeOpenCodeBackend;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? Date.now;
    this.ephemeralPortSupported =
      deps.ephemeralPortSupported ?? INSTALLED_SDK_SUPPORTS_EPHEMERAL_PORT;
    this.portBindable = deps.portBindable ?? loopbackPortBindable;
    this.bridge = deps.bridge;
    this.isBridgePortOccupied = deps.bridge?.isBridgePortOccupied ?? defaultBridgePortOccupied;
    // Inject the bridge store into the sdk-adapter for owned launch env
    // verification. The composition root owns/closes the store.
    setBridgeRevisionStoreForLaunch(this.bridge?.store);
    const omoExpected = !killSwitchDisabled(
      this.env.OH_MY_OPENCODE_SLIM_DISABLE,
    );
    const mode = cfg.opencodeMode ??
      (cfg.opencodeAttachBaseUrl !== undefined ? "attach" : "managed");
    this.state = {
      mode,
      ownership: "external",
      status: "initializing",
      ...(mode === "attach" && cfg.opencodeAttachBaseUrl
        ? { baseUrl: cfg.opencodeAttachBaseUrl }
        : {}),
      generation: 0,
      projectDirectory: cfg.projectDirectory,
      configDirectory: cfg.opencodeConfigDir,
      authConfigured: !!this.auth,
      ready: emptyReadiness(omoExpected),
      updatedAt: this.iso(),
    };
  }

  getState(): OpenCodeLifecycleState {
    // Base state without restartKind (consumers that need it use getStateWithRestartKind).
    const { restartKind: _rk, ...base } = this.state;
    return structuredClone(base);
  }

  /** Extended state with restartKind metadata. */
  getStateWithRestartKind(): OpenCodeLifecycleStateWithRestartKind {
    return structuredClone(this.state);
  }

  subscribe(listener: LifecycleListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<OpenCodeLifecycleState> {
    if (this.startPromise) return this.startPromise;
    this.stopping = false;
    const id = ++this.runId;
    this.startPromise = this.run(id).finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  async retry(): Promise<OpenCodeLifecycleState> {
    if (this.state.status !== "failed" && this.state.status !== "stopped") {
      return this.getState();
    }
    this.restartIndex = 0;
    this.transition({
      status: this.state.generation > 0 ? "restarting" : "initializing",
      restartKind: "ordinary",
      error: undefined,
      restart: undefined,
      detail: "Manual retry requested",
    });
    return this.start();
  }

  async backendLost(reason: unknown): Promise<void> {
    if (this.stopping || this.state.status !== "connected") return;
    const message = this.sanitize(reason);
    if (this.state.mode === "attach" || this.state.ownership === "external") {
      // Attach or managed+external: awaiting owner restart (no automatic owned restart).
      this.transition({
        status: "restarting",
        restartKind: "awaiting-owner",
        ready: emptyReadiness(this.state.ready.omoExpected),
        detail: "External OpenCode backend was lost; awaiting owner action",
      });
      this.fail(
        "attached-backend-unavailable",
        message,
        "Restore the external OpenCode server, then Retry.",
        true,
      );
      return;
    }
    this.closeOwned();
    this.transition({
      status: "restarting",
      restartKind: "ordinary",
      ready: emptyReadiness(this.state.ready.omoExpected),
      error: undefined,
      detail: "Owned OpenCode backend was lost",
    });
    if (!this.restartPromise) {
      this.restartPromise = this.restartOwned(message).finally(() => {
        this.restartPromise = undefined;
      });
    }
    await this.restartPromise;
  }

  /**
   * Runtime reconciliation can transiently fail. Confirm sustained loss with
   * a bounded health probe before replacing/stopping the canonical backend.
   */
  scheduleBackendLossCheck(reason: unknown, graceMs = 1_000): void {
    if (this.stopping || this.state.status !== "connected" || this.lossTimer) return;
    const generation = this.state.generation;
    const baseUrl = this.state.baseUrl;
    this.lossTimer = setTimeout(() => {
      this.lossTimer = undefined;
      void (async () => {
        if (
          this.stopping ||
          this.state.status !== "connected" ||
          this.state.generation !== generation ||
          !baseUrl
        ) return;
        const probe = await this.probeTarget(baseUrl, false);
        if (probe.kind === "ready") return;
        await this.backendLost(reason);
      })();
    }, graceMs);
  }

  /** RuntimeStore supplies post-activation REST/SSE transport readiness. */
  updateRuntimeConnection(connection: RuntimeConnection): void {
    if (this.state.status !== "connected") return;
    const rest = connection.rest === "connected";
    const sse = connection.sse === "connected";
    if (this.state.ready.rest === rest && this.state.ready.sse === sse) return;
    // Runtime transport readiness is live metadata, not a lifecycle state
    // transition/generation event. Update in place to avoid recursive
    // lifecycle→runtime reset broadcasts while SSE connects.
    this.state = {
      ...this.state,
      ready: { ...this.state.ready, rest, sse },
      updatedAt: this.iso(),
    };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.lossTimer) {
      clearTimeout(this.lossTimer);
      this.lossTimer = undefined;
    }
    ++this.runId;
    this.closeOwned();
    this.transition({
      status: "stopped",
      restartKind: undefined,
      ready: emptyReadiness(this.state.ready.omoExpected),
      restart: undefined,
      detail: "Lifecycle stopped",
    });
  }

  // ── restartForTelemetryBridge ─────────────────────────────────────────

  /**
   * Explicit telemetry-bridge restart with intent activate|deactivate|recover-activation-failure.
   *
   * Preconditions (validated here; explicit caller confirmation is validated
   * by the future API before invoking):
   *  - Mode managed.
   *  - Ownership control-plane.
   *  - Connected+owned handle for activate/deactivate, or failed-but-owned
   *    (status failed, ownership control-plane) for recovery.
   *  - Expected generation matches.
   *  - Expected source hash/revision/config state matches committed
   *    BridgeActivationState.
   *  - Selected managed port range (8788..8803).
   *  - No stop, ordinary restart, probe, or activation restart in flight.
   *
   * Rejects attach and managed+external without process action.
   *
   * Behavior:
   *  - Dedicated promise/state, one explicit attempt per call.
   *  - Never uses or consumes MANAGED_RESTART_DELAYS_MS.
   *  - Never adopts/reuses an external listener.
   *  - Closes only owned handle.
   *  - Starts through strict owned start with bridge env overlay.
   *  - Readiness is existing OpenCode+OMO readiness only.
   *  - Lifecycle generation increments exactly once per successful new backend.
   *  - On start failure after close: ownership remains control-plane, status
   *    failed, generation remains last successful, no automatic restartOrFail.
   *  - Only explicit recover or restore/deactivation recovery may start.
   *
   * Port race: before closing owned backend on activate/recover, passively
   * recheck committed selected bridge port. If occupied, return
   * bridge-port-race and do not close. For ordinary recovery, do not treat
   * the bridge's own listener before process close as foreign.
   */
  async restartForTelemetryBridge(
    intent: TelemetryBridgeRestartIntent,
    expected: ExpectedBridgeActivationState,
  ): Promise<TelemetryBridgeRestartResult> {
    // One explicit attempt per call: reject if already in flight.
    if (this.activationRestartInFlight || this.activationRestartPromise) {
      return this.activationResult({
        ok: false,
        code: "activation-restart-in-flight",
        message: "A telemetry-bridge activation restart is already in progress.",
      });
    }

    // No stop, ordinary restart, probe, or activation restart in flight.
    if (this.stopping) {
      return this.activationResult({
        ok: false,
        code: "lifecycle-stopping",
        message: "Lifecycle is stopping; cannot restart for telemetry bridge.",
      });
    }
    if (this.restartPromise) {
      return this.activationResult({
        ok: false,
        code: "ordinary-restart-in-flight",
        message: "An ordinary backend-loss restart is in flight.",
      });
    }
    if (this.startPromise && this.state.status === "initializing") {
      return this.activationResult({
        ok: false,
        code: "start-in-flight",
        message: "Lifecycle start is in flight.",
      });
    }

    // Mode managed.
    if (this.state.mode !== "managed") {
      return this.activationResult({
        ok: false,
        code: "mode-not-managed",
        message: "Telemetry-bridge restart requires managed mode.",
      });
    }

    // Ownership control-plane.
    if (this.state.ownership !== "control-plane") {
      // Reject attach and managed+external without process action.
      return this.activationResult({
        ok: false,
        code: "ownership-not-control-plane",
        message: "Telemetry-bridge restart requires control-plane ownership; attach/external rejected.",
      });
    }

    // Connected+owned handle for activate/deactivate, or failed-but-owned for recovery.
    const isConnected = this.state.status === "connected";
    const isFailed = this.state.status === "failed";
    if (intent === "recover-activation-failure") {
      if (!isFailed) {
        return this.activationResult({
          ok: false,
          code: "not-failed",
          message: "Recovery requires a failed owned state.",
        });
      }
    } else {
      // activate / deactivate require connected+owned handle.
      if (!isConnected || !this.owned) {
        return this.activationResult({
          ok: false,
          code: "not-connected-owned",
          message: "Activate/deactivate requires a connected owned handle.",
        });
      }
    }

    // Expected generation matches.
    if (expected.generation !== this.state.generation) {
      return this.activationResult({
        ok: false,
        code: "generation-mismatch",
        message: "Expected generation does not match current lifecycle generation.",
      });
    }

    // Verify committed bridge activation state matches expected.
    const bridgeStore = this.bridge?.store;
    if (!bridgeStore) {
      return this.activationResult({
        ok: false,
        code: "bridge-store-unavailable",
        message: "Bridge revision store is not available; cannot verify committed state.",
      });
    }

    const committedState = bridgeStore.getActivationState();
    if (!committedState) {
      return this.activationResult({
        ok: false,
        code: "no-committed-activation-state",
        message: "No committed bridge activation state found.",
      });
    }

    // Exact expected committed fields — no omitted field bypass.
    // configHash and revisionId are always required and must match exactly.
    if (expected.configHash !== committedState.configHash) {
      return this.activationResult({
        ok: false,
        code: "config-hash-mismatch",
        message: "Expected config hash does not match committed state.",
      });
    }
    if (expected.revisionId !== committedState.revisionId) {
      return this.activationResult({
        ok: false,
        code: "revision-mismatch",
        message: "Expected revision id does not match committed state.",
      });
    }

    if (intent === "activate" || intent === "recover-activation-failure") {
      // Enabled committed state: nonceFingerprint and port must be present and match.
      if (expected.nonceFingerprint === undefined) {
        return this.activationResult({
          ok: false,
          code: "missing-nonce-fingerprint",
          message: "Activate/recover requires expected nonceFingerprint to be present.",
        });
      }
      if (expected.nonceFingerprint !== committedState.nonceFingerprint) {
        return this.activationResult({
          ok: false,
          code: "nonce-fingerprint-mismatch",
          message: "Expected nonce fingerprint does not match committed state.",
        });
      }
      if (expected.port === undefined) {
        return this.activationResult({
          ok: false,
          code: "missing-port",
          message: "Activate/recover requires expected port to be present.",
        });
      }

      // Selected managed port range.
      const committedPort = committedState.port;
      if (
        committedPort === undefined ||
        committedPort < BRIDGE_PORT_RANGE_START ||
        committedPort > BRIDGE_PORT_RANGE_END
      ) {
        return this.activationResult({
          ok: false,
          code: "port-out-of-range",
          message: "Committed bridge port is outside the managed range.",
        });
      }
      if (expected.port !== committedPort) {
        return this.activationResult({
          ok: false,
          code: "port-mismatch",
          message: "Expected port does not match committed state.",
        });
      }

      // Committed state must be active for activate/recover.
      if (!committedState.active) {
        return this.activationResult({
          ok: false,
          code: "committed-state-not-active",
          message: "Committed bridge activation state is not active.",
        });
      }
    } else {
      // deactivate: committed state must be disabled (active=false).
      // nonceFingerprint and port must be absent in committed disabled state.
      if (committedState.active) {
        return this.activationResult({
          ok: false,
          code: "committed-state-still-active",
          message: "Committed bridge activation state is still active; deactivate requires disabled state.",
        });
      }
      if (committedState.nonceFingerprint !== undefined) {
        return this.activationResult({
          ok: false,
          code: "committed-state-not-disabled",
          message: "Committed disabled state must not have a nonce fingerprint.",
        });
      }
      if (committedState.port !== undefined) {
        return this.activationResult({
          ok: false,
          code: "committed-state-not-disabled",
          message: "Committed disabled state must not have a port.",
        });
      }
      // Expected nonceFingerprint/port must be absent for deactivate.
      if (expected.nonceFingerprint !== undefined) {
        return this.activationResult({
          ok: false,
          code: "unexpected-nonce-fingerprint",
          message: "Deactivate must not include expected nonceFingerprint.",
        });
      }
      if (expected.port !== undefined) {
        return this.activationResult({
          ok: false,
          code: "unexpected-port",
          message: "Deactivate must not include expected port.",
        });
      }
    }

    // Bridge reconciliation clean before owned startup/recovery/activation restart.
    if (!this.isReconciliationClean()) {
      return this.activationResult({
        ok: false,
        code: "bridge-reconciliation-dirty",
        message: "Bridge reconciliation is dirty; resolve conflicts before restart.",
      });
    }

    // Port race: before closing owned backend on activate/recover, passively
    // recheck committed selected bridge port. If occupied, return
    // bridge-port-race and DO NOT close. For activate, the bridge is not yet
    // loaded in the current pre-restart generation; occupied means collision.
    // No process action on this precondition failure.
    if (intent === "activate" || intent === "recover-activation-failure") {
      const committedPort = committedState.port!;
      const occupied = await this.isBridgePortOccupied(committedPort);
      if (occupied) {
        return this.activationResult({
          ok: false,
          code: "bridge-port-race",
          message: "Committed bridge port is occupied; cannot restart without collision.",
        });
      }
    }

    // All preconditions passed. Close owned handle and proceed to start.
    // Deactivate does not need a port check.
    this.closeOwned();

    // Start through strict owned start with bridge env overlay.
    this.activationRestartInFlight = true;
    this.transition({
      status: "restarting",
      restartKind: "telemetry-activation",
      ready: emptyReadiness(this.state.ready.omoExpected),
      error: undefined,
      restart: undefined,
      detail: `Telemetry-bridge ${intent} restart in progress`,
    });

    this.activationRestartPromise = this.runActivationRestart(intent, expected)
      .finally(() => {
        this.activationRestartInFlight = false;
        this.activationRestartPromise = undefined;
      });
    return this.activationRestartPromise;
  }

  private async runActivationRestart(
    intent: TelemetryBridgeRestartIntent,
    _expected: ExpectedBridgeActivationState,
  ): Promise<TelemetryBridgeRestartResult> {
    // Strict owned start with bridge env overlay. The sdk-adapter handles
    // the launch boundary env overlay around createOpencodeServer().
    const id = ++this.runId;
    // Capture prior OPENCODE_CONFIG_DIR to restore after owned start.
    const priorConfigDir = process.env.OPENCODE_CONFIG_DIR;
    try {
      process.env.OPENCODE_CONFIG_DIR = this.cfg.opencodeConfigDir;
      const handle = await this.startSdk({
        hostname: "127.0.0.1",
        port: 0, // OS-selected loopback port (strict owned start)
        timeout: START_TIMEOUT_MS,
      });
      if (id !== this.runId || this.stopping) {
        handle.close();
        return this.activationResult({
          ok: false,
          code: "superseded",
          message: "Activation restart was superseded or lifecycle stopped.",
        });
      }
      this.owned = handle;
      let baseUrl: string;
      try {
        baseUrl = validManagedUrl(handle.url);
      } catch (error) {
        this.closeOwned();
        this.failActivationRestart(error);
        return this.activationResult({
          ok: false,
          code: "invalid-managed-url",
          message: this.sanitize(error),
        });
      }
      this.transition({
        baseUrl,
        ownership: "control-plane",
        status: "waiting-health",
        restartKind: "telemetry-activation",
        detail: `Owned SDK backend started for telemetry-bridge ${intent}; waiting for health`,
      });
      const full = await this.waitReady(baseUrl, id);
      if (full) {
        // Success: generation increments exactly once per successful new backend.
        this.restartIndex = 0;
        this.activate(baseUrl, "control-plane", full, `Telemetry-bridge ${intent} restart complete`);
        return this.activationResult({ ok: true });
      }
      if (id !== this.runId && this.owned) {
        this.closeOwned();
      }
      // Start failure after close: ownership remains control-plane, status
      // failed, generation remains last successful, no automatic restartOrFail.
      this.failActivationRestart("OpenCode readiness timed out during activation restart");
      return this.activationResult({
        ok: false,
        code: "activation-restart-readiness-failed",
        message: "OpenCode readiness timed out during activation restart.",
      });
    } catch (error) {
      this.failActivationRestart(error);
      return this.activationResult({
        ok: false,
        code: "activation-restart-start-failed",
        message: this.sanitize(error),
      });
    } finally {
      // Restore exact prior OPENCODE_CONFIG_DIR.
      if (priorConfigDir === undefined) {
        delete process.env.OPENCODE_CONFIG_DIR;
      } else {
        process.env.OPENCODE_CONFIG_DIR = priorConfigDir;
      }
    }
  }

  /**
   * Fail an activation restart: ownership remains control-plane, status
   * failed, generation remains last successful, no automatic restartOrFail.
   */
  private failActivationRestart(reason: unknown): void {
    this.closeOwned();
    const message = this.sanitize(reason);
    this.transition({
      status: "failed",
      restartKind: undefined,
      ready: emptyReadiness(this.state.ready.omoExpected),
      error: {
        code: "activation-restart-failed",
        message,
        action:
          "A duplicate or unmanaged bridge activation may already own the selected port. " +
          "Do NOT free the port or stop unknown listeners: verify a single managed activation " +
          "owns it (bridge status / Doctor), resolve any duplicate or unmanaged registration, " +
          "then explicitly recover.",
        retryable: true,
        at: this.iso(),
      },
      detail: "Telemetry-bridge activation restart failed",
    });
  }

  private activationResult(partial: {
    ok: boolean;
    code?: string;
    message?: string;
  }): TelemetryBridgeRestartResult {
    return {
      ok: partial.ok,
      code: partial.code,
      message: partial.message,
      state: this.getState(),
    };
  }

  // ── restartForOwnedConfigApply ────────────────────────────────────────

  /**
   * Explicit owned restart after an owned config write (OpenCode provider
   * management apply). This is deliberately SEPARATE from
   * restartForTelemetryBridge:
   *  - It never calls restartForTelemetryBridge.
   *  - It never consumes MANAGED_RESTART_DELAYS_MS (one explicit attempt
   *    per call; no backoff schedule, restartIndex untouched).
   *  - Allowed only when mode === "managed" AND ownership === "control-plane".
   *    Attach mode and managed+external are rejected WITHOUT any process
   *    action (the external backend is never closed); the caller surfaces a
   *    warning while the Desired write already stands.
   *  - Lifecycle generation increments exactly once on success.
   */
  async restartForOwnedConfigApply(): Promise<OwnedConfigApplyRestartResult> {
    const fail = (
      code: string,
      message: string,
    ): OwnedConfigApplyRestartResult => ({
      ok: false,
      code,
      message,
      state: this.getState(),
    });

    if (this.configApplyRestartInFlight || this.configApplyRestartPromise) {
      return fail(
        "config-apply-restart-in-flight",
        "An owned config-apply restart is already in progress.",
      );
    }
    if (this.stopping) {
      return fail("lifecycle-stopping", "Lifecycle is stopping; cannot restart for config apply.");
    }
    if (this.activationRestartInFlight || this.activationRestartPromise) {
      return fail(
        "activation-restart-in-flight",
        "A telemetry-bridge activation restart is in flight.",
      );
    }
    if (this.restartPromise) {
      return fail("ordinary-restart-in-flight", "An ordinary backend-loss restart is in flight.");
    }
    if (this.startPromise && this.state.status === "initializing") {
      return fail("start-in-flight", "Lifecycle start is in flight.");
    }

    // Attach mode: warn only, no process action.
    if (this.state.mode !== "managed") {
      return fail(
        "mode-not-managed",
        "Owned config-apply restart requires managed mode; attached backend left untouched (Desired written).",
      );
    }

    // Managed + external ownership: warn only, no process action. The
    // external backend is never closed or adopted.
    if (this.state.ownership !== "control-plane") {
      return fail(
        "ownership-not-control-plane",
        "Owned config-apply restart requires control-plane ownership; external backend left untouched (Desired written).",
      );
    }

    if (this.state.status !== "connected" || !this.owned) {
      return fail(
        "not-connected-owned",
        "Config-apply restart requires a connected owned handle.",
      );
    }

    // Bridge reconciliation clean before the owned restart.
    if (!this.isReconciliationClean()) {
      return fail(
        "bridge-reconciliation-dirty",
        "Bridge reconciliation is dirty; resolve conflicts before restart.",
      );
    }

    // All preconditions passed: close ONLY the owned handle and do one
    // explicit strict owned start. Never restartForTelemetryBridge, never
    // the MANAGED_RESTART_DELAYS_MS schedule.
    this.closeOwned();
    this.configApplyRestartInFlight = true;
    this.transition({
      status: "restarting",
      ready: emptyReadiness(this.state.ready.omoExpected),
      error: undefined,
      restart: undefined,
      detail: "Owned config-apply restart in progress",
    });

    this.configApplyRestartPromise = this.runConfigApplyRestart()
      .finally(() => {
        this.configApplyRestartInFlight = false;
        this.configApplyRestartPromise = undefined;
      });
    return this.configApplyRestartPromise;
  }

  private async runConfigApplyRestart(): Promise<OwnedConfigApplyRestartResult> {
    const id = ++this.runId;
    const priorConfigDir = process.env.OPENCODE_CONFIG_DIR;
    try {
      process.env.OPENCODE_CONFIG_DIR = this.cfg.opencodeConfigDir;
      const handle = await this.startSdk({
        hostname: "127.0.0.1",
        port: 0, // OS-selected loopback port (strict owned start)
        timeout: START_TIMEOUT_MS,
      });
      if (id !== this.runId || this.stopping) {
        handle.close();
        return {
          ok: false,
          code: "superseded",
          message: "Config-apply restart was superseded or lifecycle stopped.",
          state: this.getState(),
        };
      }
      this.owned = handle;
      let baseUrl: string;
      try {
        baseUrl = validManagedUrl(handle.url);
      } catch (error) {
        this.closeOwned();
        this.fail("config-apply-restart-failed", error, "Explicit Retry after correcting the backend.", true);
        return {
          ok: false,
          code: "invalid-managed-url",
          message: this.sanitize(error),
          state: this.getState(),
        };
      }
      this.transition({
        baseUrl,
        ownership: "control-plane",
        status: "waiting-health",
        detail: "Owned SDK backend restarted for config apply; waiting for health",
      });
      const full = await this.waitReady(baseUrl, id);
      if (full) {
        // Success: generation increments exactly once (via activate).
        this.restartIndex = 0;
        this.activate(baseUrl, "control-plane", full, "Owned config-apply restart complete");
        return { ok: true, state: this.getState() };
      }
      if (id !== this.runId && this.owned) {
        this.closeOwned();
      }
      return {
        ok: false,
        code: "config-apply-restart-readiness-failed",
        message: "OpenCode readiness timed out during the config-apply restart.",
        state: this.getState(),
      };
    } catch (error) {
      this.fail("config-apply-restart-failed", error, "Explicit Retry after correcting the backend.", true);
      return {
        ok: false,
        code: "config-apply-restart-start-failed",
        message: this.sanitize(error),
        state: this.getState(),
      };
    } finally {
      if (priorConfigDir === undefined) {
        delete process.env.OPENCODE_CONFIG_DIR;
      } else {
        process.env.OPENCODE_CONFIG_DIR = priorConfigDir;
      }
    }
  }

  /**
   * Bridge reconciliation check. Returns true when clean (no unresolved/conflict
   * intents). When the hook is omitted, reconciliation is assumed clean.
   */
  private isReconciliationClean(): boolean {
    if (this.bridge?.isReconciliationClean) {
      return this.bridge.isReconciliationClean();
    }
    if (this.bridge?.store) {
      return !this.bridge.store.hasUnresolvedOrConflictIntents();
    }
    // No bridge store: reconciliation assumed clean (disabled lane).
    return true;
  }

  private async run(id: number): Promise<OpenCodeLifecycleState> {
    if (this.state.mode === "attach") {
      await this.attach(id);
    } else {
      await this.manage(id, false);
    }
    return this.getState();
  }

  private async attach(id: number): Promise<void> {
    let baseUrl: string;
    try {
      baseUrl = validAttachUrl(this.cfg.opencodeAttachBaseUrl);
    } catch (error) {
      this.fail(
        "invalid-attach-url",
        error,
        "Set OPENCODE_BASE_URL to an explicit valid OpenCode HTTP URL, or unset it for Managed mode.",
        true,
      );
      return;
    }
    this.transition({
      baseUrl,
      ownership: "external",
      status: "waiting-health",
      detail: "Attaching to explicit OPENCODE_BASE_URL",
    });
    const first = await this.probeTarget(baseUrl, false);
    if (id !== this.runId || this.stopping) return;
    if (first.kind !== "ready") {
      this.fail(
        first.kind === "collision" ? "attach-not-opencode" : "attach-unavailable",
        first.detail ?? "Attached OpenCode health check failed",
        "Verify OPENCODE_BASE_URL, Basic auth environment, and the external OpenCode server, then Retry.",
        true,
      );
      return;
    }
    this.transition({ status: "waiting-runtime", version: first.version });
    const full = await this.waitReady(baseUrl, id);
    if (full) this.activate(baseUrl, "external", full, "Attached external backend");
  }

  private async manage(id: number, restarting: boolean): Promise<void> {
    // NOTE: the bridge reconciliation gate is deliberately NOT checked here.
    // `manage()` first probes the preferred loopback port and may REUSE a
    // compatible preexisting backend (ownership "external", no owned spawn,
    // no bridge env overlay). A dirty reconciliation (e.g. committed-target
    // config-hash drift) must not block that reuse path — the bridge, if any,
    // is already running in the external process. The gate is enforced only
    // when an OWNED start is actually required, inside startOwned() (and the
    // launch boundary independently fails closed on drift/intents).

    this.transition({
      baseUrl: PREFERRED_OPENCODE_BASE_URL,
      ownership: "external",
      status: restarting ? "restarting" : "waiting-health",
      restartKind: restarting ? "ordinary" : undefined,
      detail: "Probing preferred loopback OpenCode port",
    });
    // Full compatibility is required before classifying the occupant as
    // reusable OpenCode. A health-only lookalike must remain a collision.
    const preferred = await this.probeTarget(PREFERRED_OPENCODE_BASE_URL, true);
    if (id !== this.runId || this.stopping) return;
    if (preferred.kind === "ready") {
      this.activate(
        PREFERRED_OPENCODE_BASE_URL,
        "external",
        preferred,
        "Reused compatible preexisting backend",
      );
      return;
    }

    if (preferred.kind === "unavailable") {
      const omoRegistrationFailed =
        preferred.readiness.omoExpected && !preferred.readiness.omo;
      if (preferred.readiness.health && omoRegistrationFailed) {
        this.transition({
          status: "waiting-runtime",
          version: preferred.version,
          ready: preferred.readiness,
          detail: preferred.detail,
        });
        const full = await this.waitReady(PREFERRED_OPENCODE_BASE_URL, id);
        if (full) {
          this.activate(
            PREFERRED_OPENCODE_BASE_URL,
            "external",
            full,
            "Reused compatible preexisting backend",
          );
        }
        return;
      }
      this.fail(
        omoRegistrationFailed
          ? "omo-registration-failed"
          : "preferred-opencode-unavailable",
        preferred.detail ?? "OpenCode on the preferred port rejected lifecycle checks",
        "Verify OpenCode Basic auth and runtime configuration on port 4096, then Retry.",
        true,
      );
      return;
    }

    // A health refusal alone does not prove the port is free: a loopback
    // listener may accept TCP and close/reset HTTP. Confirm bindability before
    // asking the SDK to claim 4096; never kill an occupant.
    if (preferred.kind === "refused") {
      const bindable = await this.portBindable(4096);
      if (!bindable) {
        if (!this.ephemeralPortSupported) {
          this.fail(
            "preferred-port-collision",
            preferred.detail ?? "Loopback port 4096 is occupied",
            "Free loopback port 4096 or set OPENCODE_BASE_URL to a compatible external OpenCode server.",
            false,
          );
          return;
        }
        this.transition({
          status: "starting",
          detail: "Preferred port is occupied; starting owned backend on an OS-selected loopback port",
        });
        await this.startOwned(id, 0);
        return;
      }
    }

    let requestedPort = 4096;
    if (preferred.kind === "collision") {
      if (!this.ephemeralPortSupported) {
        this.fail(
          "preferred-port-collision",
          preferred.detail ?? "Port 4096 is occupied by a non-OpenCode service",
          "Free loopback port 4096 or set OPENCODE_BASE_URL to a compatible external OpenCode server.",
          false,
        );
        return;
      }
      requestedPort = 0;
      this.transition({
        status: "starting",
        detail: "Preferred port collision; starting owned backend on an OS-selected loopback port",
      });
    } else {
      this.transition({ status: "starting", detail: "Starting owned OpenCode backend" });
    }

    await this.startOwned(id, requestedPort);
  }

  private async startOwned(id: number, requestedPort: number): Promise<void> {
    // Bridge reconciliation clean before an OWNED start. This is the correct
    // enforcement point: an owned start injects the bridge env overlay via the
    // launch boundary, so a dirty reconciliation (committed-target hash drift,
    // unresolved/conflict intents) must block it. Preexisting-backend reuse
    // (handled earlier in manage()) is unaffected.
    if (!this.isReconciliationClean()) {
      this.fail(
        "bridge-reconciliation-dirty",
        "Bridge reconciliation is dirty; resolve conflicts before owned start.",
        "Resolve bridge conflicts/unresolved intents, then Retry.",
        true,
      );
      return;
    }

    let handle: ManagedSdkHandle;
    // Capture prior OPENCODE_CONFIG_DIR to restore after owned start.
    const priorConfigDir = process.env.OPENCODE_CONFIG_DIR;
    try {
      // SDK inherits the complete process environment (verified in installed
      // source), including provider auth and the configured OPENCODE_CONFIG_DIR.
      // Config loading already installs the default into process.env before
      // lifecycle startup. Normal scripts run with cwd=the fixed project.
      //
      // Slice 17: the sdk-adapter integrates withOwnedBridgeLaunchEnv around
      // createOpencodeServer(), applying the verified bridge env overlay
      // (OMO_BRIDGE_PORT + OMO_BRIDGE_ACTIVATION_NONCE) synchronously during
      // spawn and restoring exact parent env before awaiting. Ordinary
      // recovery reuses the same committed port/nonce on every owned start.
      process.env.OPENCODE_CONFIG_DIR = this.cfg.opencodeConfigDir;
      handle = await this.startSdk({
        hostname: "127.0.0.1",
        port: requestedPort,
        timeout: START_TIMEOUT_MS,
      });
    } catch (error) {
      await this.restartOrFail(error);
      return;
    } finally {
      // Restore exact prior OPENCODE_CONFIG_DIR.
      if (priorConfigDir === undefined) {
        delete process.env.OPENCODE_CONFIG_DIR;
      } else {
        process.env.OPENCODE_CONFIG_DIR = priorConfigDir;
      }
    }
    if (id !== this.runId || this.stopping) {
      handle.close();
      return;
    }
    this.owned = handle;
    let baseUrl: string;
    try {
      baseUrl = validManagedUrl(handle.url);
    } catch (error) {
      this.closeOwned();
      await this.restartOrFail(error);
      return;
    }
    this.transition({
      baseUrl,
      ownership: "control-plane",
      status: "waiting-health",
      detail: "Owned SDK backend started; waiting for health",
    });
    const full = await this.waitReady(baseUrl, id);
    if (full) {
      this.restartIndex = 0;
      this.activate(baseUrl, "control-plane", full, "Owned SDK backend ready");
    } else if (id !== this.runId && this.owned === handle) {
      // A nested restart superseded this attempt while its readiness loop was
      // unwinding. Never retain the stale owned handle.
      this.closeOwned();
    }
  }

  private async waitReady(
    baseUrl: string,
    id: number,
  ): Promise<LifecycleProbeResult | undefined> {
    const deadline = this.now() + READINESS_TIMEOUT_MS;
    let last: LifecycleProbeResult | undefined;
    while (this.now() <= deadline && id === this.runId && !this.stopping) {
      last = await this.probeTarget(baseUrl, true);
      if (last.kind === "ready") return last;
      this.transition({
        status: last.readiness.health ? "waiting-runtime" : "waiting-health",
        version: last.version,
        ready: last.readiness,
        detail: last.detail,
      });
      await this.sleep(READINESS_POLL_MS);
    }
    if (id !== this.runId || this.stopping) return undefined;
    if (this.state.ownership === "control-plane") {
      await this.restartOrFail(last?.detail ?? "OpenCode readiness timed out");
    } else {
      const omoRegistrationFailed =
        last?.readiness.omoExpected === true && last.readiness.omo === false;
      this.fail(
        omoRegistrationFailed
          ? "omo-registration-failed"
          : this.state.mode === "attach"
            ? "attach-readiness-failed"
            : "preexisting-readiness-failed",
        last?.detail ?? "Attached OpenCode did not become runtime-ready",
        "Restore OpenCode providers/agents and OMO registration on the external backend, then Retry.",
        true,
      );
    }
    return undefined;
  }

  private async restartOwned(reason: string): Promise<void> {
    await this.restartOrFail(reason);
  }

  private async restartOrFail(reason: unknown): Promise<void> {
    this.closeOwned();
    if (this.restartIndex >= MANAGED_RESTART_DELAYS_MS.length) {
      const message = this.sanitize(reason);
      this.fail(
        /OMO-Slim agents are not registered/i.test(message)
          ? "omo-registration-failed"
          : "managed-restart-exhausted",
        message,
        "Inspect the sanitized startup error, free the selected port if needed, then Retry.",
        true,
      );
      return;
    }
    const delay = MANAGED_RESTART_DELAYS_MS[this.restartIndex]!;
    this.restartIndex += 1;
    const message = this.sanitize(reason);
    this.transition({
      status: "restarting",
      restartKind: "ordinary",
      ready: emptyReadiness(this.state.ready.omoExpected),
      restart: {
        attempt: this.restartIndex,
        maxAttempts: MANAGED_RESTART_DELAYS_MS.length,
        nextRetryAt: new Date(this.now() + delay).toISOString(),
        lastReason: message,
      },
      detail: `Restart ${this.restartIndex}/${MANAGED_RESTART_DELAYS_MS.length} scheduled`,
    });
    await this.sleep(delay);
    if (this.stopping) return;
    const id = ++this.runId;
    await this.manage(id, true);
  }

  private activate(
    baseUrl: string,
    ownership: OpenCodeLifecycleOwnership,
    probe: LifecycleProbeResult,
    detail: string,
  ): void {
    this.transition({
      baseUrl,
      ownership,
      status: "connected",
      restartKind: undefined,
      version: probe.version,
      generation: this.state.generation + 1,
      ready: { ...probe.readiness, rest: true },
      restart: undefined,
      error: undefined,
      detail,
    });
  }

  private async probeTarget(
    baseUrl: string,
    requireRuntime: boolean,
  ): Promise<LifecycleProbeResult> {
    return this.probe(baseUrl, {
      projectDirectory: this.cfg.projectDirectory,
      auth: this.auth,
      requireRuntime,
      omoExpected: this.state.ready.omoExpected,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
  }

  private fail(
    code: string,
    error: unknown,
    action: string,
    retryable: boolean,
  ): void {
    this.closeOwned();
    this.transition({
      status: "failed",
      restartKind: undefined,
      ready: emptyReadiness(this.state.ready.omoExpected),
      error: {
        code,
        message: this.sanitize(error),
        action,
        retryable,
        at: this.iso(),
      },
      restart: this.state.restart
        ? { ...this.state.restart, nextRetryAt: undefined }
        : undefined,
      detail: "OpenCode lifecycle failed",
    });
  }

  private closeOwned(): void {
    const handle = this.owned;
    this.owned = undefined;
    if (!handle) return;
    try {
      handle.close();
    } catch {
      /* close is best-effort and never applies to external handles */
    }
  }

  private transition(
    patch: Partial<OpenCodeLifecycleStateWithRestartKind>,
  ): void {
    this.state = {
      ...this.state,
      ...patch,
      ready: patch.ready ? { ...patch.ready } : this.state.ready,
      updatedAt: this.iso(),
    };
    // Emit base state (without restartKind) to listeners for backward compat.
    const { restartKind: _rk, ...base } = this.state;
    const snapshot = structuredClone(base);
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        /* listener isolation */
      }
    }
  }

  private sanitize(error: unknown): string {
    return sanitizeOpenCodeError(error, [this.auth?.password]);
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}