/**
 * OmoRuntimeStore — lazily-polling telemetry store deriving OMO job records
 * from persisted OpenCode `task` tool parts.
 *
 * Design: does NOT subscribe to RuntimeStore (which dedupes message detail
 * per session). Instead refresh(liveSnapshot) is invoked:
 *   (a) on demand by GET /api/omo/runtime (3s min-interval memo),
 *   (b) by doctor each evaluation (fire-and-forget + cached read).
 *
 * Job↔session correlation is direct: task tool result taskID equals the
 * CHILD OpenCode session id, and persisted task tool parts carry
 * state.metadata.{parentSessionId,sessionId} (live-verified 2026-08-11).
 */

import type { LiveSession, LiveSnapshot, RuntimeConnection } from "@omo/shared";
import type { OpenCodeClient } from "../opencode/client";
import { flattenSessions } from "../domain/join";
import { isControlPlaneProbeSession } from "../runtime/probe-sessions";
import type { OmoBridgeClient } from "./bridge";
import type { TelemetryBridgeManager } from "./manager";
import { sanitizeJob } from "./security";
import {
  scanMessagesForJobs,
  type TaskCallEvidence,
} from "./scan";
import {
  OMO_TELEMETRY_SCHEMA_VERSION,
  OMO_TERMINAL_STATES,
  type OmoBridgeLifecycleState,
  type OmoBridgeStatus,
  type OmoJob,
  type OmoJobState,
  type OmoRuntimeSnapshot,
  type OmoRuntimeUpdatedEvent,
  type OmoWorkerView,
} from "./types";

export const OMO_REFRESH_MIN_INTERVAL_MS = 3_000;
export const OMO_MAX_SESSIONS_PER_REFRESH = 40;
export const OMO_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Prune jobs whose child+parent sessions both vanished more than 6h ago. */
export const OMO_PRUNE_AFTER_MS = 6 * 60 * 60 * 1000;
export const OMO_EMIT_DEBOUNCE_MS = 500;

export interface OmoRuntimeStoreOptions {
  client?: OpenCodeClient;
  getClient?: () => OpenCodeClient;
  bridge?: OmoBridgeClient;
  /**
   * Slice 17 v3: optional TelemetryBridgeManager. When wired, the store
   * surfaces bridge lifecycle state and emits independent runtime updates
   * on bridge changes WITHOUT clearing derived jobs. Bridge-only disconnect
   * marks only deep telemetry stale/unavailable.
   */
  bridgeManager?: TelemetryBridgeManager;
  now?: () => number;
  minRefreshIntervalMs?: number;
  maxSessionsPerRefresh?: number;
  sessionWindowMs?: number;
  pruneAfterMs?: number;
  emitDebounceMs?: number;
  /** Test hook: message fetcher override. */
  fetchMessages?: (sessionId: string) => Promise<unknown>;
}

export type OmoRuntimeListener = (evt: OmoRuntimeUpdatedEvent) => void;

interface InternalJob extends OmoJob {
  /* mutable working copy; sanitized on output */
}

export class OmoRuntimeStore {
  private jobs = new Map<string, InternalJob>();
  private lastConnection?: RuntimeConnection;
  private lastRefreshAt = 0;
  private refreshing?: Promise<void>;
  private lastSignature = "";
  private prevStates = new Map<string, OmoJobState>();
  private bothVanishedAt = new Map<string, number>();
  private childMissingSince = new Map<string, number>();
  private listeners = new Set<OmoRuntimeListener>();
  private emitTimer?: ReturnType<typeof setTimeout>;
  private pendingChanged: string[] = [];

  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly maxSessions: number;
  private readonly windowMs: number;
  private readonly pruneAfterMs: number;
  private readonly emitDebounceMs: number;
  private readonly fetchMessages: (sessionId: string) => Promise<unknown>;

  constructor(private readonly opts: OmoRuntimeStoreOptions) {
    this.now = opts.now ?? Date.now;
    this.minIntervalMs = opts.minRefreshIntervalMs ?? OMO_REFRESH_MIN_INTERVAL_MS;
    this.maxSessions = opts.maxSessionsPerRefresh ?? OMO_MAX_SESSIONS_PER_REFRESH;
    this.windowMs = opts.sessionWindowMs ?? OMO_SESSION_WINDOW_MS;
    this.pruneAfterMs = opts.pruneAfterMs ?? OMO_PRUNE_AFTER_MS;
    this.emitDebounceMs = opts.emitDebounceMs ?? OMO_EMIT_DEBOUNCE_MS;
    this.fetchMessages =
      opts.fetchMessages ?? ((id) => {
        const client = opts.getClient?.() ?? opts.client;
        if (!client) throw new Error("OpenCode backend is not active");
        return client.sessionMessages(id);
      });
  }

  // ── public API ─────────────────────────────────────────────────────────

  /**
   * Refresh job corpus from the live runtime snapshot. Memoized to a
   * minimum interval; single-flight. Never throws — per-session fetch
   * failures are tolerated and reflected via `stale`.
   */
  async refresh(live: LiveSnapshot, opts: { force?: boolean } = {}): Promise<void> {
    this.lastConnection = live.connection;
    const now = this.now();
    if (!opts.force && now - this.lastRefreshAt < this.minIntervalMs) {
      return;
    }
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh(live, now).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  /** Force next refresh to bypass the min-interval memo. */
  invalidate(): void {
    this.lastRefreshAt = 0;
  }

  /** Backend replacement invalidates all live telemetry; no cross-generation jobs. */
  resetForBackendGeneration(): void {
    this.jobs.clear();
    this.prevStates.clear();
    this.bothVanishedAt.clear();
    this.childMissingSince.clear();
    this.lastConnection = undefined;
    this.lastRefreshAt = 0;
    this.lastSignature = "";
    this.pendingChanged = [];
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = undefined;
    }
  }

  /** Current snapshot (cheap rebuild from in-memory state). */
  getSnapshot(): OmoRuntimeSnapshot {
    const jobs = [...this.jobs.values()]
      .sort((a, b) => (b.launchedAt ?? 0) - (a.launchedAt ?? 0))
      .map((j) => ({ ...j }));
    // When bridgeManager is wired, use manager status as bridge authority.
    // Otherwise fall back to the legacy direct client (display-only).
    const bridge: OmoBridgeStatus | undefined = this.opts.bridgeManager
      ? this.opts.bridgeManager.getBridgeStatus()
      : this.opts.bridge?.configured
        ? this.opts.bridge.getBridgeStores()
        : undefined;
    const bridgeLifecycle: OmoBridgeLifecycleState | undefined =
      this.opts.bridgeManager?.getLifecycleState();
    return {
      telemetrySchemaVersion: OMO_TELEMETRY_SCHEMA_VERSION,
      generatedAt: this.lastRefreshAt || this.now(),
      stale: this.isStale(),
      availability: {
        opencodeJobs: this.lastConnection?.rest === "connected",
        bridge: !!bridge?.connected,
        // ALWAYS false on 2.2.10: activeRuntimePreset module var
        // (dist/index.js:21244) not exported by package main entry
        // (dist/index.js:41424-41425).
        runtimePreset: false,
      },
      jobs,
      workers: buildWorkerViews(jobs),
      bridge,
      ...(bridgeLifecycle ? { bridgeLifecycle } : {}),
      notes: [
        "OMO board internals (reuse counts, eligibility, fallback chains, runtime preset) are closure-scoped in installed 2.2.10 — unavailable",
        "'reconciled' board state is OMO-closure-only (dist/index.js:25225) — never emitted here",
        "resumeRequested labels observed task_id reuse requests; OMO-side reuse gating is not replicated",
      ],
    };
  }

  /** Lookup by taskId or alias. */
  getJob(taskIdOrAlias: string): OmoJob | undefined {
    const direct = this.jobs.get(taskIdOrAlias);
    if (direct) return { ...direct };
    for (const j of this.jobs.values()) {
      if (j.alias === taskIdOrAlias) return { ...j };
    }
    return undefined;
  }

  /** Orphan info for doctor: jobs whose child session is absent from OpenCode. */
  getOrphanInfo(): Array<{ taskId: string; missingSince?: number }> {
    const out: Array<{ taskId: string; missingSince?: number }> = [];
    for (const taskId of this.jobs.keys()) {
      const since = this.childMissingSince.get(taskId);
      if (since !== undefined) out.push({ taskId, missingSince: since });
    }
    return out;
  }

  subscribe(listener: OmoRuntimeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Slice 17 v3: notify the store that the bridge (manager) produced an
   * update. Emits an independent `omo-runtime.updated` event reflecting the
   * bridge change WITHOUT clearing derived jobs. Bridge-only disconnect
   * marks only deep telemetry stale/unavailable — derived jobs from
   * persisted task parts remain separate and continue.
   */
  notifyBridgeUpdate(): void {
    // Force signature recompute by clearing the cached signature so the
    // bridge-connected portion of the signature is re-evaluated.
    this.lastSignature = "";
    this.detectChangesAndScheduleEmit();
  }

  dispose(): void {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.listeners.clear();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private isStale(): boolean {
    const c = this.lastConnection;
    if (!c) return true;
    // Derived per spec: rest+sse BOTH disconnected → stale.
    return c.rest !== "connected" && c.sse !== "connected";
  }

  private async doRefresh(live: LiveSnapshot, now: number): Promise<void> {
    this.lastRefreshAt = now;

    const flat = flattenSessions(live.sessions);
    const selected = selectSessions(flat, now, this.windowMs, this.maxSessions);

    // When bridgeManager is wired, use manager status as bridge authority
    // and skip the old piggyback OmoBridgeClient.fetchTelemetry(). The
    // manager's independent reconnect scheduler handles bridge polling.
    // Legacy direct client remains display-only for configurations without
    // a manager.
    const bridgeFetch = this.opts.bridgeManager
      ? Promise.resolve(undefined)
      : this.opts.bridge?.configured
        ? this.opts.bridge.fetchTelemetry()
        : Promise.resolve(undefined);

    const scans = await Promise.all(
      selected.map(async (s) => {
        try {
          const messages = await this.fetchMessages(s.id);
          return scanMessagesForJobs(messages, s.id);
        } catch {
          return { calls: [], otherTools: [] };
        }
      }),
    );
    await bridgeFetch;

    for (const scan of scans) {
      for (const ev of scan.calls) this.applyEvidence(ev);
    }

    this.reconcilePresence(new Set(flat.map((s) => s.id)), now);
    this.detectChangesAndScheduleEmit();
  }

  private applyEvidence(ev: TaskCallEvidence): void {
    // Resume labeling: task_id arg referencing an existing job (by taskId or
    // alias) — observe & label only; OMO-side gating is NOT replicated.
    let refJob: InternalJob | undefined;
    if (ev.requestedTaskId) {
      refJob = this.jobs.get(ev.requestedTaskId);
      if (!refJob) {
        for (const j of this.jobs.values()) {
          if (j.alias === ev.requestedTaskId) {
            refJob = j;
            break;
          }
        }
      }
      if (refJob) refJob.resumeRequested = true;
    }

    const identity =
      ev.childSessionId ?? ev.outputTaskId ?? refJob?.taskId ?? ev.requestedTaskId;
    if (!identity) return;

    let job = this.jobs.get(identity);
    if (!job) {
      job = sanitizeJob({
        taskId: identity,
        agent: ev.subagentType ?? "unknown",
        parentSessionId: ev.parentSessionId,
        childSessionId: identity,
        state: ev.state ?? "running",
        source: "opencode-task-call",
      }) as InternalJob;
      this.jobs.set(identity, job);
    }

    if (ev.subagentType) job.agent = ev.subagentType;
    if (ev.description) job.description = ev.description.slice(0, 120);
    job.parentSessionId = ev.parentSessionId;
    if (ev.childSessionId) job.childSessionId = ev.childSessionId;
    if (ev.alias) job.alias = ev.alias;

    // Re-launch detection: terminal job seeing a newer running launch.
    const relaunch =
      !!job.state &&
      OMO_TERMINAL_STATES.has(job.state) &&
      ev.state === "running" &&
      (ev.startedAt ?? 0) >= (job.completedAt ?? 0);
    if (relaunch) {
      job.completedAt = undefined;
      job.resultSummary = undefined;
      job.timedOut = undefined;
    }

    if (ev.state) job.state = ev.state;
    // timedOut: only when present in status output (dist/index.js:24972).
    if (ev.timedOut === true) job.timedOut = true;
    if (ev.result !== undefined) {
      job.resultSummary = sanitizeSummary(ev.result);
    }
    if (ev.startedAt !== undefined) {
      job.launchedAt =
        job.launchedAt === undefined
          ? ev.startedAt
          : Math.min(job.launchedAt, ev.startedAt);
    }
    if (ev.state && OMO_TERMINAL_STATES.has(ev.state)) {
      job.completedAt = ev.endedAt ?? job.completedAt;
    }
  }

  private reconcilePresence(sessionIds: Set<string>, now: number): void {
    for (const [taskId, job] of [...this.jobs]) {
      const childPresent = sessionIds.has(job.childSessionId);
      const parentPresent = sessionIds.has(job.parentSessionId);

      if (!childPresent) {
        if (!this.childMissingSince.has(taskId)) {
          this.childMissingSince.set(taskId, now);
        }
      } else {
        this.childMissingSince.delete(taskId);
      }

      if (!childPresent && !parentPresent) {
        const since = this.bothVanishedAt.get(taskId) ?? now;
        this.bothVanishedAt.set(taskId, since);
        if (now - since > this.pruneAfterMs) {
          this.jobs.delete(taskId);
          this.bothVanishedAt.delete(taskId);
          this.childMissingSince.delete(taskId);
        }
      } else {
        this.bothVanishedAt.delete(taskId);
      }
    }
  }

  private signature(): string {
    const ids = [...this.jobs.keys()].sort();
    const parts = ids.map((id) => {
      const j = this.jobs.get(id)!;
      return `${id}:${j.state}`;
    });
    // When bridgeManager is wired, derive bridge-connected from manager
    // verified status (bridge authority). Otherwise use legacy client.
    const bridgeConnected = this.opts.bridgeManager
      ? this.opts.bridgeManager.getBridgeStatus().connected
      : this.opts.bridge?.getBridgeStores().connected ?? false;
    parts.push(`bridge:${bridgeConnected}`);
    return parts.join("|");
  }

  private detectChangesAndScheduleEmit(): void {
    const sig = this.signature();
    if (sig === this.lastSignature) return;
    this.lastSignature = sig;

    const changed: string[] = [];
    for (const [id, j] of this.jobs) {
      const prev = this.prevStates.get(id);
      if (prev !== j.state) changed.push(id);
    }
    this.prevStates = new Map([...this.jobs].map(([id, j]) => [id, j.state]));
    this.pendingChanged = [...new Set([...this.pendingChanged, ...changed])];

    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      // When bridgeManager is wired, derive bridgeConnected from manager.
      const bridgeConnected = this.opts.bridgeManager
        ? this.opts.bridgeManager.getBridgeStatus().connected
        : this.opts.bridge?.getBridgeStores().connected ?? false;
      const evt: OmoRuntimeUpdatedEvent = {
        type: "omo-runtime.updated",
        ts: this.now(),
        jobCount: this.jobs.size,
        changed: this.pendingChanged.slice(0, 50),
        bridgeConnected,
      };
      this.pendingChanged = [];
      for (const l of this.listeners) {
        try {
          l(evt);
        } catch {
          /* listener errors must not break the store */
        }
      }
    }, this.emitDebounceMs);
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function sanitizeSummary(text: string): string {
  // security.capSummary is applied here via sanitizeJob's contract; keep the
  // 200-char hard cap for incremental updates too.
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 200 ? flat : `${flat.slice(0, 199)}…`;
}

/**
 * Session selection per spec: sessions updated in the last 24h AND all
 * children of roots; hard cap by most-recently-updated.
 */
export function selectSessions(
  flat: LiveSession[],
  now: number,
  windowMs: number,
  cap: number,
): LiveSession[] {
  const candidates = flat.filter((s) => {
    // Defense-in-depth: probe sessions must never be interpreted as OMO
    // background jobs. Check the server-set flag first; flagless raw
    // sessions that can reach this path are re-classified on title/metadata.
    if (s.controlPlaneProbe === true) return false;
    if (
      isControlPlaneProbeSession({
        title: s.title,
        metadata: (s as { metadata?: unknown }).metadata,
      })
    ) {
      return false;
    }
    const updated = s.time?.updated ?? s.time?.created ?? 0;
    return now - updated <= windowMs || !!s.parentID;
  });
  candidates.sort(
    (a, b) =>
      (b.time?.updated ?? b.time?.created ?? 0) -
      (a.time?.updated ?? a.time?.created ?? 0),
  );
  return candidates.slice(0, cap);
}

function buildWorkerViews(jobs: OmoJob[]): OmoWorkerView[] {
  const byAgent = new Map<string, OmoWorkerView>();
  for (const j of jobs) {
    let v = byAgent.get(j.agent);
    if (!v) {
      v = { agent: j.agent, running: 0, completed: 0, errored: 0, cancelled: 0, jobs: [] };
      byAgent.set(j.agent, v);
    }
    if (j.state === "running") v.running++;
    else if (j.state === "completed") v.completed++;
    else if (j.state === "error") v.errored++;
    else if (j.state === "cancelled") v.cancelled++;
    v.jobs.push(j.taskId);
  }
  return [...byAgent.values()].sort((a, b) => a.agent.localeCompare(b.agent));
}
