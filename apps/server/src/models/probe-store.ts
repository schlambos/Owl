/**
 * SQLite persistence for model probe runs (Slice 15, Lane 1).
 *
 * Follows the RevisionStore pattern (bun:sqlite, CREATE TABLE IF NOT EXISTS
 * in constructor, typed insert/read, row mapper). Shares the control-plane
 * DB file (data/control-plane.db) via defaultProbeDbPath().
 *
 * Data-hygiene invariants:
 *  - Sanitized fields ONLY. Never prompt text, response text, tokens, or
 *    credentials. (Response text never enters this module at all.)
 *  - Retention: newest 50 COMPLETED runs per (provider, model); running
 *    rows are never counted or deleted by retention.
 *  - Store health: a failed terminal write marks the store degraded, the
 *    result is kept in an in-memory overlay map, and a warning is logged.
 *    Reads compose persisted rows + overlay (overlay wins per run id).
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelProbeRun, ModelProbeState } from "@omo/shared";
import {
  modelKey,
  PROBE_RECENT_WINDOW_MS,
  PROBE_RETENTION_PER_MODEL,
} from "./constants";

type RunState = ModelProbeRun["state"]; // Exclude<ModelProbeState, "never">

const DDL = `
  CREATE TABLE IF NOT EXISTS model_probe_runs (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    state TEXT NOT NULL CHECK (state IN ('running','healthy','unauthorized','model-not-found','rate-limited','timeout','provider-disconnected','opencode-disconnected','malformed','error')),
    latency_ms INTEGER,
    status_code INTEGER,
    error_code TEXT,
    error_message_sanitized TEXT,
    response_model TEXT,
    opencode_version TEXT,
    advertised_at_probe INTEGER NOT NULL CHECK (advertised_at_probe IN (0,1)),
    provider_connected_at_probe INTEGER NOT NULL CHECK (provider_connected_at_probe IN (0,1))
  );
  CREATE INDEX IF NOT EXISTS idx_model_probe_runs_lookup
    ON model_probe_runs(provider_id, model_id, completed_at DESC);
`;

export interface ProbeProviderStats {
  /** Completed non-healthy runs by terminal state, within the window. */
  recentFailureCounts: Partial<Record<ModelProbeState, number>>;
  /** Completed rate-limited runs within the window. */
  recentRateLimitCount: number;
  /** Last completed healthy probe for this provider (all time, ISO). */
  lastSuccessfulProbeAt?: string;
}

export class ModelProbeStore {
  private db: Database;
  private degraded = false;
  /**
   * Latest terminal runs whose persistence failed, keyed provider\0model.
   * Overlay entries always supersede the persisted row with the same run id
   * (which may exist as a leftover `running` row when insert succeeded but
   * the terminal write failed).
   */
  private overlay = new Map<string, ModelProbeRun>();

  constructor(dbPath: string) {
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
      this.db = new Database(dbPath);
      this.db.exec(DDL);
    } catch (e) {
      console.warn(
        "[models] probe store unavailable at %s — falling back to in-memory (degraded): %s",
        dbPath,
        e instanceof Error ? e.message : String(e),
      );
      try {
        this.db = new Database(":memory:");
        this.db.exec(DDL);
      } catch (e2) {
        throw e2 instanceof Error ? e2 : new Error(String(e2));
      }
      this.degraded = true;
    }
  }

  /** False once any persistence operation has failed (or DB fell back to memory). */
  isHealthy(): boolean {
    return !this.degraded;
  }

  /** Failed-persistence terminal results keyed provider\0model (read-only view). */
  getOverlay(): ReadonlyMap<string, ModelProbeRun> {
    return this.overlay;
  }

  private markDegraded(op: string, e: unknown): void {
    this.degraded = true;
    console.warn(
      "[models] probe store degraded — %s failed: %s",
      op,
      e instanceof Error ? e.message : String(e),
    );
  }

  // ── writes ──────────────────────────────────────────────────────────

  /**
   * Insert the `running` row for a new probe. Failure-absorbing: marks the
   * store degraded and logs instead of throwing (probing is best-effort).
   */
  insertRunning(run: ModelProbeRun): void {
    try {
      this.db
        .query(
          `INSERT INTO model_probe_runs (
            id, provider_id, model_id, started_at, completed_at, state,
            latency_ms, status_code, error_code, error_message_sanitized,
            response_model, opencode_version,
            advertised_at_probe, provider_connected_at_probe
          ) VALUES (
            $id, $provider_id, $model_id, $started_at, NULL, 'running',
            NULL, NULL, NULL, NULL,
            NULL, $opencode_version,
            $advertised_at_probe, $provider_connected_at_probe
          )`,
        )
        .run({
          $id: run.id,
          $provider_id: run.providerId,
          $model_id: run.modelId,
          $started_at: run.startedAt,
          $opencode_version: run.opencodeVersion ?? null,
          $advertised_at_probe: run.advertisedAtProbe ? 1 : 0,
          $provider_connected_at_probe: run.providerConnectedAtProbe ? 1 : 0,
        });
    } catch (e) {
      this.markDegraded("insertRunning", e);
    }
  }

  /**
   * Terminal write + SAME-TRANSACTION retention (delete completed rows for
   * this (provider, model) beyond the newest PROBE_RETENTION_PER_MODEL
   * completed rows; running rows never counted/deleted).
   *
   * Failure-absorbing: on throw the store is marked degraded and the full
   * terminal result is retained in the overlay map (never lost silently).
   */
  complete(run: ModelProbeRun): void {
    if (!run.completedAt || run.state === "running") {
      throw new Error(
        `complete() requires a terminal state + completedAt (got ${run.state})`,
      );
    }
    const completedAt = run.completedAt;
    try {
      const tx = this.db.transaction(() => {
        this.db
          .query(
            `UPDATE model_probe_runs SET
              completed_at = $completed_at,
              state = $state,
              latency_ms = $latency_ms,
              status_code = $status_code,
              error_code = $error_code,
              error_message_sanitized = $error_message_sanitized,
              response_model = $response_model
            WHERE id = $id`,
          )
          .run({
            $id: run.id,
            $completed_at: completedAt,
            $state: run.state,
            $latency_ms: run.latencyMs ?? null,
            $status_code: run.statusCode ?? null,
            $error_code: run.errorCode ?? null,
            $error_message_sanitized: run.errorMessage ?? null,
            $response_model: run.responseModel ?? null,
          });
        // Retention: keep newest N COMPLETED rows for this (provider, model).
        this.db
          .query(
            `DELETE FROM model_probe_runs
             WHERE provider_id = $p AND model_id = $m
               AND completed_at IS NOT NULL
               AND id NOT IN (
                 SELECT id FROM model_probe_runs
                 WHERE provider_id = $p AND model_id = $m
                   AND completed_at IS NOT NULL
                 ORDER BY completed_at DESC
                 LIMIT $keep
               )`,
          )
          .run({
            $p: run.providerId,
            $m: run.modelId,
            $keep: PROBE_RETENTION_PER_MODEL,
          });
      });
      tx();
    } catch (e) {
      this.markDegraded("complete", e);
      this.overlay.set(modelKey(run.providerId, run.modelId), { ...run });
    }
  }

  /**
   * Startup reconciliation: rows left `running` by a previous control-plane
   * process become opencode-disconnected with error_code
   * "control-plane-restarted". No latency is fabricated (latency_ms stays
   * NULL). Must run BEFORE the queue accepts jobs.
   */
  finalizeAbandonedRuns(nowIso = new Date().toISOString()): number {
    try {
      const res = this.db
        .query(
          `UPDATE model_probe_runs SET
            state = 'opencode-disconnected',
            completed_at = $now,
            error_code = 'control-plane-restarted',
            error_message_sanitized = 'Control plane restarted while the probe was running'
           WHERE state = 'running' AND completed_at IS NULL`,
        )
        .run({ $now: nowIso });
      return Number(res.changes ?? 0);
    } catch (e) {
      this.markDegraded("finalizeAbandonedRuns", e);
      return 0;
    }
  }

  // ── reads (persisted rows composed with the overlay) ────────────────

  /** Latest row for a model (terminal preferred; running if newer). */
  latestFor(providerId: string, modelId: string): ModelProbeRun | undefined {
    const all = this.latestByModel();
    return all.get(modelKey(providerId, modelId));
  }

  /** Newest-first history (terminal + residual running rows), overlay-composed. */
  historyFor(
    providerId: string,
    modelId: string,
    limit = PROBE_RETENTION_PER_MODEL,
  ): ModelProbeRun[] {
    const rows = this.db
      .query(
        `SELECT * FROM model_probe_runs
         WHERE provider_id = $p AND model_id = $m
         ORDER BY started_at DESC
         LIMIT $limit`,
      )
      .all({ $p: providerId, $m: modelId, $limit: limit }) as Record<
      string,
      unknown
    >[];
    let out = rows.map(rowToRun);
    const over = this.overlay.get(modelKey(providerId, modelId));
    if (over) {
      out = out.filter((r) => r.id !== over.id);
      out.unshift(over);
      out = out.slice(0, limit);
    }
    return out;
  }

  /** Map provider\0model → latest run across all models (overlay-composed). */
  latestByModel(): Map<string, ModelProbeRun> {
    // Latest completed run per model.
    const completed = this.db
      .query(
        `SELECT r.* FROM model_probe_runs r
         INNER JOIN (
           SELECT provider_id AS p, model_id AS m, MAX(completed_at) AS c
           FROM model_probe_runs
           WHERE completed_at IS NOT NULL
           GROUP BY p, m
         ) latest
           ON r.provider_id = latest.p
          AND r.model_id = latest.m
          AND r.completed_at = latest.c`,
      )
      .all() as Record<string, unknown>[];
    const out = new Map<string, ModelProbeRun>();
    for (const row of completed) {
      const run = rowToRun(row);
      out.set(modelKey(run.providerId, run.modelId), run);
    }
    // Residual running rows (should not exist post-finalizeAbandonedRuns):
    // a running row newer than the latest completion represents current work.
    const runningRows = this.db
      .query(`SELECT * FROM model_probe_runs WHERE completed_at IS NULL`)
      .all() as Record<string, unknown>[];
    for (const row of runningRows) {
      const run = rowToRun(row);
      const key = modelKey(run.providerId, run.modelId);
      const cur = out.get(key);
      if (!cur || (cur.completedAt ?? cur.startedAt) <= run.startedAt) {
        out.set(key, run);
      }
    }
    // Overlay: failed terminal writes supersede the persisted row with the
    // same run id and win per model.
    for (const [key, over] of this.overlay) {
      const cur = out.get(key);
      if (!cur || (cur.completedAt ?? cur.startedAt) <= over.startedAt) {
        out.set(key, over);
      }
      if (cur && cur.id === over.id) out.set(key, over);
    }
    return out;
  }

  /**
   * Completed-row counts per provider over a recent window (default 24h):
   * failures by terminal state + rate-limit count + all-time last healthy.
   * Overlay results are included (they are real outcomes, just unpersisted).
   */
  recentCountsByProvider(
    windowMs = PROBE_RECENT_WINDOW_MS,
    nowMs = Date.now(),
  ): Map<string, ProbeProviderStats> {
    const cutoffIso = new Date(nowMs - windowMs).toISOString();
    const out = new Map<string, ProbeProviderStats>();
    const statsFor = (providerId: string): ProbeProviderStats => {
      let s = out.get(providerId);
      if (!s) {
        s = { recentFailureCounts: {}, recentRateLimitCount: 0 };
        out.set(providerId, s);
      }
      return s;
    };
    const tally = (run: {
      providerId: string;
      state: RunState;
      completedAt?: string;
    }) => {
      if (!run.completedAt || run.completedAt < cutoffIso) return;
      const s = statsFor(run.providerId);
      if (run.state !== "healthy" && run.state !== "running") {
        s.recentFailureCounts[run.state] =
          (s.recentFailureCounts[run.state] ?? 0) + 1;
        if (run.state === "rate-limited") s.recentRateLimitCount += 1;
      }
    };

    const windowRows = this.db
      .query(
        `SELECT provider_id, model_id, state, completed_at FROM model_probe_runs
         WHERE completed_at IS NOT NULL AND completed_at >= $cutoff`,
      )
      .all({ $cutoff: cutoffIso }) as Record<string, unknown>[];
    for (const r of windowRows) {
      tally({
        providerId: String(r.provider_id),
        state: String(r.state) as RunState,
        completedAt: String(r.completed_at),
      });
    }
    const healthyRows = this.db
      .query(
        `SELECT provider_id, MAX(completed_at) AS last_ok FROM model_probe_runs
         WHERE state = 'healthy' AND completed_at IS NOT NULL
         GROUP BY provider_id`,
      )
      .all() as Record<string, unknown>[];
    for (const r of healthyRows) {
      const s = statsFor(String(r.provider_id));
      if (r.last_ok != null) s.lastSuccessfulProbeAt = String(r.last_ok);
    }
    for (const run of this.overlay.values()) {
      tally(run);
      if (run.state === "healthy" && run.completedAt) {
        const s = statsFor(run.providerId);
        if (!s.lastSuccessfulProbeAt || s.lastSuccessfulProbeAt < run.completedAt) {
          s.lastSuccessfulProbeAt = run.completedAt;
        }
      }
    }
    return out;
  }
}

function rowToRun(row: Record<string, unknown>): ModelProbeRun {
  return {
    id: String(row.id),
    providerId: String(row.provider_id),
    modelId: String(row.model_id),
    startedAt: String(row.started_at),
    completedAt: row.completed_at != null ? String(row.completed_at) : undefined,
    state: String(row.state) as RunState,
    latencyMs: row.latency_ms != null ? Number(row.latency_ms) : undefined,
    statusCode: row.status_code != null ? Number(row.status_code) : undefined,
    errorCode: row.error_code != null ? String(row.error_code) : undefined,
    errorMessage:
      row.error_message_sanitized != null
        ? String(row.error_message_sanitized)
        : undefined,
    responseModel:
      row.response_model != null ? String(row.response_model) : undefined,
    opencodeVersion:
      row.opencode_version != null ? String(row.opencode_version) : undefined,
    advertisedAtProbe: Number(row.advertised_at_probe) === 1,
    providerConnectedAtProbe: Number(row.provider_connected_at_probe) === 1,
  };
}

/** Shared control-plane DB (same file as RevisionStore). */
export function defaultProbeDbPath(projectRoot: string): string {
  return join(projectRoot, "data", "control-plane.db");
}
