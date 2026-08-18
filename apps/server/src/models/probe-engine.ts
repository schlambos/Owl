/**
 * Model probe engine (Slice 15, Lane 1).
 *
 * Executes a single minimal-inference probe against OpenCode through an
 * injected gateway interface. The gateway is the ONLY OpenCode dependency —
 * tests fake it with zero real calls; production wiring adapts OpenCodeClient
 * (see index.ts).
 *
 * Lifecycle guarantees:
 *  - Terminal latch: exactly ONE terminal store write per run. Cleanup
 *    failure NEVER overrides the outcome.
 *  - Termination routine (shared by cancel + timeout): abort own controller
 *    → best-effort abortSession → best-effort deleteSession → rm own tempdir
 *    ONLY → persist terminal. Other sessions are never touched.
 *  - Tempdirs are mkdtemp children of an injected root and are always
 *    removed best-effort.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProbeRun } from "@omo/shared";
import {
  PROBE_TIMEOUT_MS,
  PROBE_TITLE_PREFIX,
} from "./constants";
import {
  normalizeProbeOutcome,
  sanitizeErrorMessage,
  type ProbeOutcome,
} from "./probe-normalize";
import type { ModelProbeStore } from "./probe-store";

/**
 * Gateway the engine probes through. Mirrors the Lane-0 OpenCodeClient
 * probe primitives plus read-only authority/catalog lookups. Everything is
 * best-effort: session cleanup methods reject freely — callers wrap in
 * try/catch and never let cleanup failure override the outcome.
 */
export interface OpenCodeProbeGateway {
  /** Connected-provider authority check (preflight). */
  isProviderConnected(providerId: string): boolean;
  /** Catalog check: model advertised for this provider right now. */
  isModelAdvertised(providerId: string, modelId: string): boolean;
  /** OpenCode version string (client health() / /global/health), if known. */
  opencodeVersion(): string | undefined;
  createProbeSession(opts: {
    directory: string;
    title: string;
    providerID: string;
    modelID: string;
    signal?: AbortSignal;
  }): Promise<{ id: string }>;
  promptProbe(opts: {
    directory: string;
    sessionId: string;
    providerID: string;
    modelID: string;
    signal?: AbortSignal;
  }): Promise<{ info?: unknown; parts?: unknown }>;
  abortSession(sessionId: string, directory?: string): Promise<unknown>;
  deleteSession(sessionId: string, directory?: string): Promise<unknown>;
}

export interface ModelProbeEngineDeps {
  gateway: OpenCodeProbeGateway;
  store: ModelProbeStore;
  /** Tempdir root (default: os.tmpdir()). Tests inject a sandbox. */
  tempRoot?: string;
  now?: () => number;
}

interface RunningProbe {
  id: string;
  dir: string;
  controller: AbortController;
  deadlineFired: boolean;
  cancelled: boolean;
  backendInterrupted: boolean;
  sessionId?: string;
  settled: boolean;
}

/** Structural check for HTTP errors (OpenCodeRequestError et al.) — the
 * engine deliberately does not import the client. */
function httpStatusOf(e: unknown): number | undefined {
  if (e && typeof e === "object" && typeof (e as { status?: unknown }).status === "number") {
    return (e as { status: number }).status;
  }
  return undefined;
}

export class ModelProbeEngine {
  private gateway: OpenCodeProbeGateway;
  private store: ModelProbeStore;
  private tempRoot: string;
  private now: () => number;
  private running = new Map<string, RunningProbe>();

  constructor(deps: ModelProbeEngineDeps) {
    this.gateway = deps.gateway;
    this.store = deps.store;
    this.tempRoot = deps.tempRoot ?? tmpdir();
    this.now = deps.now ?? Date.now;
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  /**
   * User cancel: flips the cancelled flag and aborts the run's own
   * controller. The in-flight run flow then drives the shared termination
   * routine and persists the aborted outcome. Returns false when the id is
   * not currently running here.
   */
  cancel(id: string): boolean {
    const ctx = this.running.get(id);
    if (!ctx || ctx.settled) return false;
    ctx.cancelled = true;
    ctx.controller.abort();
    return true;
  }

  /** Backend loss is transport interruption, never a model timeout/user abort. */
  interruptAll(): number {
    let count = 0;
    for (const ctx of this.running.values()) {
      if (ctx.settled) continue;
      ctx.backendInterrupted = true;
      ctx.controller.abort();
      count++;
    }
    return count;
  }

  /**
   * Execute one probe end-to-end and return the terminal run record.
   * NEVER throws: outcome normalization covers every failure mode, and the
   * store absorbs its own write failures (degraded + overlay).
   */
  async run(spec: {
    id: string;
    providerId: string;
    modelId: string;
  }): Promise<ModelProbeRun> {
    const { id, providerId, modelId } = spec;
    const startedMs = this.now();
    const startedAt = new Date(startedMs).toISOString();

    // Step 1 — preflight: connected set + catalog/version capture.
    const providerConnectedAtProbe = this.gateway.isProviderConnected(providerId);
    const advertisedAtProbe = this.gateway.isModelAdvertised(providerId, modelId);
    const opencodeVersion = this.gateway.opencodeVersion();

    const baseRun = (): ModelProbeRun => ({
      id,
      providerId,
      modelId,
      startedAt,
      state: "running",
      opencodeVersion,
      advertisedAtProbe,
      providerConnectedAtProbe,
    });

    const terminal = (outcome: ProbeOutcome): ModelProbeRun => {
      const completedMs = this.now();
      const run: ModelProbeRun = {
        ...baseRun(),
        state: outcome.state,
        completedAt: new Date(completedMs).toISOString(),
        // Real end-to-end latency (started → terminal). No fabrication.
        latencyMs: Math.max(0, completedMs - startedMs),
        statusCode: outcome.statusCode,
        errorCode: outcome.errorCode,
        errorMessage: outcome.errorMessage,
        responseModel: outcome.responseModel,
      };
      // Terminal latch: the single terminal write for this run.
      this.store.complete(run);
      return run;
    };

    if (!providerConnectedAtProbe) {
      // Terminal provider-disconnected, NO session created, no tempdir.
      this.store.insertRunning(baseRun());
      return terminal(
        normalizeProbeOutcome({ providerPreflightDisconnected: true }),
      );
    }

    // Step 2 — tempdir (own mkdtemp child only). Engine never throws.
    let dir: string;
    try {
      dir = await mkdtemp(join(this.tempRoot, "omo-cp-probe-"));
    } catch (e) {
      this.store.insertRunning(baseRun());
      return terminal({
        state: "error",
        errorCode: "engine-failure",
        errorMessage: sanitizeErrorMessage(e),
      });
    }
    // Step 3 — persisted running row.
    this.store.insertRunning(baseRun());

    const ctx: RunningProbe = {
      id,
      dir,
      controller: new AbortController(),
      deadlineFired: false,
      cancelled: false,
      backendInterrupted: false,
      settled: false,
    };
    this.running.set(id, ctx);
    try {
      // Steps 4–5 — session + prompt under the deadline controller.
      const timer = setTimeout(() => {
        ctx.deadlineFired = true;
        ctx.controller.abort();
      }, PROBE_TIMEOUT_MS);

      let response: unknown;
      let requestError: { status: number; message?: unknown } | undefined;
      let transportError: unknown;
      try {
        const session = await this.gateway.createProbeSession({
          directory: dir,
          title: `${PROBE_TITLE_PREFIX}${providerId}/${modelId}`,
          providerID: providerId,
          modelID: modelId,
          signal: ctx.controller.signal,
        });
        ctx.sessionId = session.id;
        response = await this.gateway.promptProbe({
          directory: dir,
          sessionId: session.id,
          providerID: providerId,
          modelID: modelId,
          signal: ctx.controller.signal,
        });
      } catch (e) {
        const status = httpStatusOf(e);
        if (ctx.backendInterrupted) {
          // Generation interruption wins over any coincident HTTP error.
        } else if (status !== undefined) {
          requestError = {
            status,
            message:
              (e as { bodySummary?: unknown }).bodySummary ??
              (e instanceof Error ? e.message : String(e)),
          };
        } else if (ctx.controller.signal.aborted) {
          // Our own abort (deadline or cancel) — flags govern. Anything else
          // swallowed here would be a misclassify; flags win by design order.
        } else {
          transportError = e;
        }
      } finally {
        clearTimeout(timer);
      }

      // Steps 6–7 — latency + authoritative normalization.
      const outcome = normalizeProbeOutcome({
        // A backend-generation interruption is transport loss even if it
        // races the local deadline/user cancellation latch.
        deadlineFired: ctx.deadlineFired && !ctx.backendInterrupted,
        cancelled: ctx.cancelled && !ctx.backendInterrupted,
        transportError: ctx.backendInterrupted
          ? new Error("OpenCode backend generation changed during probe")
          : transportError,
        requestError,
        response,
      });

      // Steps 8–10 — latch + cleanup; cleanup NEVER overrides the outcome.
      if (ctx.cancelled || ctx.deadlineFired || ctx.backendInterrupted) {
        // Termination routine (shared by cancel + timeout): abort own
        // controller (already aborted) → abort → delete → rm → persist.
        ctx.controller.abort();
        await this.cleanup(ctx, { abortSessionFirst: true });
        ctx.settled = true;
        return terminal(outcome);
      }
      ctx.settled = true;
      const run = terminal(outcome);
      await this.cleanup(ctx, { abortSessionFirst: false });
      return run;
    } catch (e) {
      // Defensive: the engine never throws. Any unexpected failure (e.g.
      // mkdtemp raced, gateway threw non-Error) becomes an error outcome.
      ctx.settled = true;
      await this.cleanup(ctx, { abortSessionFirst: true });
      return terminal({
        state: "error",
        errorCode: "engine-failure",
        errorMessage: sanitizeErrorMessage(e),
      });
    } finally {
      this.running.delete(id);
    }
  }

  /**
   * Best-effort session + tempdir cleanup. Every step is individually
   * swallowed. Only this run's own session/tempdir is touched.
   */
  private async cleanup(
    ctx: RunningProbe,
    opts: { abortSessionFirst: boolean },
  ): Promise<void> {
    if (opts.abortSessionFirst && ctx.sessionId) {
      await this.gateway.abortSession(ctx.sessionId, ctx.dir).catch(() => {});
    }
    if (ctx.sessionId) {
      await this.gateway.deleteSession(ctx.sessionId, ctx.dir).catch(() => {});
    }
    await rm(ctx.dir, { recursive: true, force: true }).catch(() => {});
  }
}
