/**
 * In-memory model probe queue (Slice 15, Lane 1).
 *
 * - PROBE_CONCURRENCY (2) workers; max PROBE_MAX_PENDING pending jobs.
 * - Dedupes on providerId\0modelId across pending + running.
 * - Explicit submit only — nothing auto-enqueues (no quota burn by surprise).
 * - submit rejects 503-style when OpenCode REST is disconnected or the
 *   probe store is degraded. Without force, a fresh persisted probe skips.
 * - onUpdate fires on every queue-state change; index.ts wires it to the
 *   model-probes.updated SSE event + doctor invalidation.
 */

import type {
  ModelProbeQueueItem,
  ModelProbeQueueSnapshot,
  ModelProbeRun,
} from "@omo/shared";
import {
  modelKey,
  PROBE_CONCURRENCY,
  PROBE_MAX_PENDING,
} from "./constants";
import { classifyFreshness } from "./probe-normalize";
import type { ModelProbeEngine } from "./probe-engine";
import type { ModelProbeStore } from "./probe-store";

/** Error carrying an HTTP-style status for route mapping. */
export class ProbeQueueError extends Error {
  override readonly name = "ProbeQueueError";
  constructor(
    readonly statusCode: 400 | 404 | 409 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type SubmitResult =
  | { status: "queued"; item: ModelProbeQueueItem }
  | { status: "duplicate"; item: ModelProbeQueueItem }
  | { status: "skipped"; reason: "fresh"; latest: ModelProbeRun };

export interface BatchSkipped {
  providerId: string;
  modelId: string;
  reason: "fresh" | "queue-full";
  latest?: ModelProbeRun;
}

export interface BatchDeduped {
  providerId: string;
  modelId: string;
  existing: ModelProbeQueueItem;
}

export interface BatchResult {
  accepted: ModelProbeQueueItem[];
  skipped: BatchSkipped[];
  deduped: BatchDeduped[];
  queue: ModelProbeQueueSnapshot;
}

export type CancelResult =
  | { ok: true }
  | { ok: false; status: 404 | 409; error: string };

interface QueueJob {
  id: string;
  providerId: string;
  modelId: string;
  state: "pending" | "running";
  enqueuedAt: string;
  startedAt?: string;
}

export interface ModelProbeQueueDeps {
  engine: ModelProbeEngine;
  store: ModelProbeStore;
  /** OpenCode REST connectivity (runtime connection). */
  isRestConnected: () => boolean;
  now?: () => number;
}

export class ModelProbeQueue {
  private engine: ModelProbeEngine;
  private store: ModelProbeStore;
  private isRestConnected: () => boolean;
  private now: () => number;

  private pending: QueueJob[] = [];
  private runningJobs = new Map<string, QueueJob>();
  /** Recently-finished job ids (bounded) → cancel returns 409, not 404. */
  private completedIds: string[] = [];
  private listeners = new Set<(snapshot: ModelProbeQueueSnapshot) => void>();

  constructor(deps: ModelProbeQueueDeps) {
    this.engine = deps.engine;
    this.store = deps.store;
    this.isRestConnected = deps.isRestConnected;
    this.now = deps.now ?? Date.now;
  }

  onUpdate(listener: (snapshot: ModelProbeQueueSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): ModelProbeQueueSnapshot {
    const item = (j: QueueJob): ModelProbeQueueItem => ({
      id: j.id,
      providerId: j.providerId,
      modelId: j.modelId,
      state: j.state,
      enqueuedAt: j.enqueuedAt,
      startedAt: j.startedAt,
    });
    return {
      concurrency: PROBE_CONCURRENCY,
      pending: this.pending.map(item),
      running: [...this.runningJobs.values()].map(item),
    };
  }

  private assertAccepting(): void {
    if (!this.isRestConnected()) {
      throw new ProbeQueueError(
        503,
        "opencode-unavailable",
        "OpenCode REST is disconnected; probing is unavailable",
      );
    }
    if (!this.store.isHealthy()) {
      throw new ProbeQueueError(
        503,
        "probe-store-degraded",
        "Probe persistence is degraded; probing is unavailable",
      );
    }
  }

  private findActive(
    providerId: string,
    modelId: string,
  ): QueueJob | undefined {
    const key = modelKey(providerId, modelId);
    for (const j of this.pending) {
      if (modelKey(j.providerId, j.modelId) === key) return j;
    }
    for (const j of this.runningJobs.values()) {
      if (modelKey(j.providerId, j.modelId) === key) return j;
    }
    return undefined;
  }

  private toItem(j: QueueJob): ModelProbeQueueItem {
    return {
      id: j.id,
      providerId: j.providerId,
      modelId: j.modelId,
      state: j.state,
      enqueuedAt: j.enqueuedAt,
      startedAt: j.startedAt,
    };
  }

  submit(spec: {
    providerId: string;
    modelId: string;
    force?: boolean;
  }): SubmitResult {
    this.assertAccepting();
    const activeDupe = this.findActive(spec.providerId, spec.modelId);
    if (activeDupe) {
      return { status: "duplicate", item: this.toItem(activeDupe) };
    }
    if (spec.force !== true) {
      const latest = this.store.latestFor(spec.providerId, spec.modelId);
      if (
        latest &&
        classifyFreshness(latest.completedAt, this.now()) === "fresh"
      ) {
        return { status: "skipped", reason: "fresh", latest };
      }
    }
    if (this.pending.length >= PROBE_MAX_PENDING) {
      throw new ProbeQueueError(
        503,
        "queue-full",
        `Probe queue is full (${PROBE_MAX_PENDING} pending)`,
      );
    }
    const job: QueueJob = {
      id: crypto.randomUUID(),
      providerId: spec.providerId,
      modelId: spec.modelId,
      state: "pending",
      enqueuedAt: new Date(this.now()).toISOString(),
    };
    this.pending.push(job);
    this.emitUpdate();
    this.pump();
    return { status: "queued", item: this.toItem(job) };
  }

  /**
   * Batch submit: server-side dedupe (within the batch AND against the
   * live queue). skipRecentlyTested skips models whose latest persisted
   * probe is fresh (force overrides). Body-size guards live in routes.ts.
   */
  submitBatch(
    models: Array<{ providerId: string; modelId: string }>,
    opts: { force?: boolean; skipRecentlyTested?: boolean } = {},
  ): BatchResult {
    this.assertAccepting();
    const accepted: ModelProbeQueueItem[] = [];
    const skipped: BatchSkipped[] = [];
    const deduped: BatchDeduped[] = [];
    for (const m of models) {
      // findActive scans pending + running, so it catches both pre-queue
      // dupes and earlier entries accepted from this same batch.
      const dupe = this.findActive(m.providerId, m.modelId);
      if (dupe) {
        deduped.push({ ...m, existing: this.toItem(dupe) });
        continue;
      }
      if (opts.skipRecentlyTested === true && opts.force !== true) {
        const latest = this.store.latestFor(m.providerId, m.modelId);
        if (
          latest &&
          classifyFreshness(latest.completedAt, this.now()) === "fresh"
        ) {
          skipped.push({ ...m, reason: "fresh", latest });
          continue;
        }
      }
      if (this.pending.length >= PROBE_MAX_PENDING) {
        skipped.push({ ...m, reason: "queue-full" });
        continue;
      }
      const job: QueueJob = {
        id: crypto.randomUUID(),
        providerId: m.providerId,
        modelId: m.modelId,
        state: "pending",
        enqueuedAt: new Date(this.now()).toISOString(),
      };
      this.pending.push(job);
      accepted.push(this.toItem(job));
    }
    if (accepted.length > 0 || deduped.length > 0 || skipped.length > 0) {
      this.emitUpdate();
      this.pump();
    }
    return { accepted, skipped, deduped, queue: this.snapshot() };
  }

  /**
   * Cancel by job id. Pending → removed. Running → engine termination
   * routine with the aborted outcome (asynchronous; the job leaves the
   * queue when the run settles). Terminal → 409. Unknown → 404.
   */
  cancel(id: string): CancelResult {
    const pi = this.pending.findIndex((j) => j.id === id);
    if (pi >= 0) {
      this.pending.splice(pi, 1);
      this.rememberCompleted(id);
      this.emitUpdate();
      return { ok: true };
    }
    const running = this.runningJobs.get(id);
    if (running) {
      this.engine.cancel(id);
      return { ok: true };
    }
    if (this.completedIds.includes(id)) {
      return { ok: false, status: 409, error: "Probe already completed" };
    }
    return { ok: false, status: 404, error: "Unknown probe id" };
  }

  /**
   * Backend generation replacement interrupts in-flight work as disconnected
   * and drops queued (never-started) work. Persisted completed history remains.
   */
  interruptForBackendChange(): void {
    const completedAt = new Date(this.now()).toISOString();
    for (const job of this.pending) {
      const interrupted: ModelProbeRun = {
        id: job.id,
        providerId: job.providerId,
        modelId: job.modelId,
        startedAt: job.enqueuedAt,
        completedAt,
        state: "opencode-disconnected",
        errorCode: "backend-generation-changed",
        errorMessage: "OpenCode backend changed before the queued probe started",
        advertisedAtProbe: false,
        providerConnectedAtProbe: false,
      };
      this.store.insertRunning(interrupted);
      this.store.complete(interrupted);
      this.rememberCompleted(job.id);
    }
    this.pending = [];
    this.engine.interruptAll();
    this.emitUpdate();
  }

  // ── workers ─────────────────────────────────────────────────────────

  private pump(): void {
    while (
      this.runningJobs.size < PROBE_CONCURRENCY &&
      this.pending.length > 0
    ) {
      const job = this.pending.shift();
      if (!job) break;
      job.state = "running";
      job.startedAt = new Date(this.now()).toISOString();
      this.runningJobs.set(job.id, job);
      this.emitUpdate();
      void this.execute(job);
    }
  }

  private async execute(job: QueueJob): Promise<void> {
    try {
      // Engine NEVER throws; belt-and-suspenders so the queue can't wedge.
      await this.engine.run({
        id: job.id,
        providerId: job.providerId,
        modelId: job.modelId,
      });
    } catch (e) {
      // Engine contract is never-throw; avoid logging a raw unexpected error
      // because provider transports can include credential-bearing details.
      console.error(
        "[probe-queue] unexpected engine failure for %s/%s",
        job.providerId,
        job.modelId,
      );
    } finally {
      this.runningJobs.delete(job.id);
      this.rememberCompleted(job.id);
      this.emitUpdate();
      this.pump();
    }
  }

  private rememberCompleted(id: string): void {
    this.completedIds.push(id);
    if (this.completedIds.length > 500) {
      this.completedIds.splice(0, this.completedIds.length - 500);
    }
  }

  private emitUpdate(): void {
    const snapshot = this.snapshot();
    for (const l of this.listeners) {
      try {
        l(snapshot);
      } catch (e) {
        console.error("[probe-queue] onUpdate listener error", e);
      }
    }
  }
}
