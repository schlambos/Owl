/**
 * Slice 17 v3 independent reconnect scheduler.
 *
 * Polls the bridge endpoint with an exponential backoff: immediate, then
 * 1s, 2s, 5s, 10s, 30s cap. One in-flight fetch at a time. Resets the delay
 * only after a verified current response. Aborts/resets on epoch/generation/
 * shutdown.
 *
 * It NEVER writes config, restarts OpenCode, or depends on task/runtime
 * activity. Exposes start/stop/updateExpectedRuntime/test tick with
 * injectable timers/fetch for deterministic tests.
 */

/** Backoff schedule (ms). Immediate (0) then 1s, 2s, 5s, 10s, 30s cap. */
export const RECONNECT_BACKOFF_MS: readonly number[] = [
  0,
  1_000,
  2_000,
  5_000,
  10_000,
  30_000,
];
export const RECONNECT_BACKOFF_CAP_MS = 30_000;

/** Injected timer functions (deterministic for tests). */
export interface SchedulerTimers {
  now: () => number;
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

/** Injected fetch function. */
export type SchedulerFetch = (
  url: string,
  opts: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Outcome of a single tick fetch. */
export interface SchedulerTickResult {
  /** Whether the fetch succeeded and the response was verified current. */
  verified: boolean;
  /** Whether the response was a legacy v1/v2 (display-only). */
  legacy: boolean;
  /** Redacted error reason (no raw secrets). */
  error?: string;
  /**
   * Structured redacted verify reason from the verifier (when verify
   * returned false). The manager uses this to distinguish mismatch from
   * generic failure. May carry values like "nonce fingerprint mismatch",
   * "canonicalOrigin mismatch", "pluginInstanceId differs from health
   * response", "identity schemaVersion is not 3", etc.
   */
  verifyReason?: string;
  /** Raw parsed payload (for the manager to process). */
  payload?: unknown;
  /** Health document (when fetched). */
  health?: unknown;
}

/** Options for the scheduler. */
export interface ReconnectSchedulerOptions {
  /** Base URL (loopback). */
  baseUrl: string;
  /** Fetch timeout (ms). */
  timeoutMs: number;
  /** Injected fetch. */
  fetchImpl: SchedulerFetch;
  /** Injected timers. */
  timers: SchedulerTimers;
  /** Callback invoked after each tick with the result. */
  onTick: (result: SchedulerTickResult) => void;
  /**
   * Verifier: given a parsed payload, return whether it is verified-current
   * and an optional redacted reason for failure. The scheduler resets
   * backoff only when this returns true.
   */
  verify: (payload: unknown, health: unknown) => { ok: boolean; reason?: string };
  /**
   * Whether to fetch /health before /telemetry. Default true.
   */
  fetchHealth?: boolean;
  /**
   * Steady-state poll interval (ms) after a successful verified response.
   * Default 3000. After success, the scheduler waits this long before the
   * next tick (avoiding a zero-delay hot loop). Failure backoff is separate.
   */
  steadyStateIntervalMs?: number;
}

/** Steady-state poll interval after successful verification (3s). */
export const STEADY_STATE_INTERVAL_MS = 3_000;

/**
 * Independent reconnect scheduler. One in-flight fetch at a time. Backoff
 * resets only after a verified current response. After success, uses a
 * bounded steady-state poll interval (not zero-delay) to avoid a hot loop.
 * Stop/update actively aborts in-flight fetch via retained AbortController.
 */
export class ReconnectScheduler {
  private timerHandle: unknown;
  private inFlight = false;
  private backoffIndex = 0;
  private stopped = true;
  private epoch = 0;
  private abortCtrl: AbortController | undefined;
  private readonly opts: ReconnectSchedulerOptions;
  private readonly fetchHealth: boolean;
  private readonly steadyStateMs: number;

  constructor(opts: ReconnectSchedulerOptions) {
    this.opts = opts;
    this.fetchHealth = opts.fetchHealth ?? true;
    this.steadyStateMs = opts.steadyStateIntervalMs ?? STEADY_STATE_INTERVAL_MS;
  }

  /** Start polling. Idempotent. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.backoffIndex = 0;
    this.scheduleNext(0);
  }

  /** Stop polling and abort in-flight fetch. Idempotent. */
  stop(): void {
    this.stopped = true;
    this.epoch++;
    this.clearTimer();
    this.abortInFlight();
  }

  /**
   * Update the expected runtime/generation. Aborts in-flight old-epoch work
   * and resets the backoff so the next tick runs immediately.
   */
  updateExpectedRuntime(): void {
    this.epoch++;
    this.backoffIndex = 0;
    this.clearTimer();
    this.abortInFlight();
    if (!this.stopped) {
      this.scheduleNext(0);
    }
  }

  /** Current epoch (for diagnostics). */
  getEpoch(): number {
    return this.epoch;
  }

  /** Whether the scheduler is running. */
  get running(): boolean {
    return !this.stopped;
  }

  /** Actively abort any in-flight fetch via the retained AbortController. */
  private abortInFlight(): void {
    if (this.abortCtrl) {
      try {
        this.abortCtrl.abort();
      } catch {
        // ignore
      }
      this.abortCtrl = undefined;
    }
  }

  private clearTimer(): void {
    if (this.timerHandle !== undefined && this.timerHandle !== null) {
      this.opts.timers.clearTimeout(this.timerHandle);
      this.timerHandle = undefined;
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.clearTimer();
    this.timerHandle = this.opts.timers.setTimeout(() => {
      this.timerHandle = undefined;
      void this.tick();
    }, delayMs);
  }

  private nextDelay(): number {
    const delay = RECONNECT_BACKOFF_MS[
      Math.min(this.backoffIndex, RECONNECT_BACKOFF_MS.length - 1)
    ];
    return delay ?? RECONNECT_BACKOFF_CAP_MS;
  }

  private advanceBackoff(): void {
    this.backoffIndex = Math.min(
      this.backoffIndex + 1,
      RECONNECT_BACKOFF_MS.length - 1,
    );
  }

  private resetBackoff(): void {
    this.backoffIndex = 0;
  }

  /** Execute one fetch cycle. Guarded against re-entry. */
  private async tick(): Promise<void> {
    if (this.stopped || this.inFlight) return;
    const tickEpoch = this.epoch;
    this.inFlight = true;
    try {
      const result = await this.fetchCycle(tickEpoch);
      // Epoch changed during fetch → discard.
      if (this.epoch !== tickEpoch || this.stopped) return;
      this.opts.onTick(result);
      if (result.verified) {
        this.resetBackoff();
        // After success, use bounded steady-state interval (not zero-delay).
        this.scheduleNext(this.steadyStateMs);
      } else {
        this.advanceBackoff();
        this.scheduleNext(this.nextDelay());
      }
    } catch {
      if (this.epoch !== tickEpoch || this.stopped) return;
      this.opts.onTick({ verified: false, legacy: false, error: "tick-failed" });
      this.advanceBackoff();
      this.scheduleNext(this.nextDelay());
    } finally {
      this.inFlight = false;
    }
  }

  /** Fetch /health then /telemetry with a bounded timeout (injected timers). */
  private async fetchCycle(tickEpoch: number): Promise<SchedulerTickResult> {
    const urlBase = this.opts.baseUrl.replace(/\/$/, "");
    this.abortCtrl = new AbortController();
    const ctrl = this.abortCtrl;
    // Use injected timers for timeout (deterministic for tests).
    const timerHandle = this.opts.timers.setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
    try {
      let health: unknown;
      if (this.fetchHealth) {
        const healthRes = await this.opts.fetchImpl(
          `${urlBase}/health`,
          { signal: ctrl.signal, headers: { Accept: "application/json" } },
        );
        if (!healthRes.ok) {
          return {
            verified: false,
            legacy: false,
            error: `health-${healthRes.status}`,
          };
        }
        try {
          health = await healthRes.json();
        } catch {
          return {
            verified: false,
            legacy: false,
            error: "health-json",
          };
        }
      }

      // Epoch check after health.
      if (this.epoch !== tickEpoch || this.stopped) {
        return { verified: false, legacy: false, error: "epoch-changed" };
      }

      const telRes = await this.opts.fetchImpl(
        `${urlBase}/telemetry`,
        { signal: ctrl.signal, headers: { Accept: "application/json" } },
      );
      if (!telRes.ok) {
        return {
          verified: false,
          legacy: false,
          error: `telemetry-${telRes.status}`,
        };
      }
      let payload: unknown;
      try {
        payload = await telRes.json();
      } catch {
        return {
          verified: false,
          legacy: false,
          error: "telemetry-json",
        };
      }

      const verifyResult = this.opts.verify(payload, health);
      const legacy = !verifyResult.ok && isLegacyPayload(payload);
      return {
        verified: verifyResult.ok,
        legacy,
        verifyReason: verifyResult.reason,
        payload,
        health,
        ...(verifyResult.ok || legacy ? {} : { error: verifyResult.reason ?? "verify-failed" }),
      };
    } catch {
      return { verified: false, legacy: false, error: "fetch-error" };
    } finally {
      this.opts.timers.clearTimeout(timerHandle);
      this.abortCtrl = undefined;
    }
  }
}

/** Heuristic: does a payload look like a legacy v1/v2 payload? */
function isLegacyPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const r = payload as Record<string, unknown>;
  const sv = r["telemetrySchemaVersion"];
  return sv === 1 || sv === 2;
}