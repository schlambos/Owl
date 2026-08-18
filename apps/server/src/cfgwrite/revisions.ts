/**
 * SQLite revision history for config mutations.
 * Not the authoritative config store.
 *
 * Slice 18 D1: additive open-path migration for pending/committed/abandoned/
 * conflict state. Historical rows remain committed. Migration never invents
 * pending/abandoned/conflict. Failure makes revision storage unavailable and
 * forces OMO JSON commits to 503 before mutation.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ConfigRevision,
  ConfigWriteScope,
  OmoFormat,
  OmoRevisionState,
  OmoScope,
} from "@omo/shared";
import { hashContent } from "./jsonc-edit";
import { resolveWriteTarget } from "./paths";
import type { ServerConfig } from "../config";

const NEW_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: "state", ddl: "state TEXT NOT NULL DEFAULT 'committed'" },
  { name: "prepared_at", ddl: "prepared_at TEXT" },
  { name: "committed_at", ddl: "committed_at TEXT" },
  { name: "recovery_note", ddl: "recovery_note TEXT" },
  { name: "before_exists", ddl: "before_exists INTEGER NOT NULL DEFAULT 1" },
  { name: "after_exists", ddl: "after_exists INTEGER NOT NULL DEFAULT 1" },
  { name: "target_format", ddl: "target_format TEXT" },
  { name: "schema_package_version", ddl: "schema_package_version TEXT" },
  { name: "schema_hash", ddl: "schema_hash TEXT" },
];

export type RevisionRecoveryOutcome =
  | { action: "none" }
  | { action: "committed" | "abandoned" | "conflict"; id: string; note?: string };

export class RevisionStore {
  private db: Database;
  private migrated = false;
  private migrationError: string | null = null;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS config_revisions (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        target_path TEXT NOT NULL,
        scope TEXT NOT NULL,
        old_hash TEXT NOT NULL,
        new_hash TEXT NOT NULL,
        mutation_kind TEXT NOT NULL,
        agent TEXT,
        property TEXT,
        old_value TEXT,
        new_value TEXT,
        mutation_json TEXT NOT NULL,
        before_content TEXT NOT NULL,
        after_content TEXT NOT NULL,
        note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_rev_ts ON config_revisions(timestamp DESC);
    `);
    this.migrateOpenPath();
  }

  get available(): boolean {
    return this.migrated && this.migrationError === null;
  }

  get unavailableReason(): string | null {
    return this.migrationError;
  }

  /**
   * Additive, idempotent open-path migration. Runs in BEGIN IMMEDIATE.
   * Failure rolls back and marks revision storage unavailable.
   */
  private migrateOpenPath(): void {
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const info = this.db
        .query(`PRAGMA table_info(config_revisions)`)
        .all() as Array<{ name: string }>;
      const existing = new Set(info.map((c) => c.name));
      for (const col of NEW_COLUMNS) {
        if (!existing.has(col.name)) {
          this.db.exec(`ALTER TABLE config_revisions ADD COLUMN ${col.ddl}`);
        }
      }
      this.db.exec(`
        UPDATE config_revisions
        SET state = 'committed'
        WHERE state IS NULL OR state NOT IN ('pending','committed','abandoned','conflict');
      `);
      this.db.exec(`
        UPDATE config_revisions SET before_exists = 1 WHERE before_exists IS NULL;
      `);
      this.db.exec(`
        UPDATE config_revisions SET after_exists = 1 WHERE after_exists IS NULL;
      `);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_rev_state_target
        ON config_revisions(state, target_path, timestamp DESC);
      `);
      this.db.exec("COMMIT");
      this.migrated = true;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* */
      }
      this.migrated = false;
      this.migrationError =
        e instanceof Error ? e.message : String(e);
    }
  }

  insert(rev: ConfigRevision): void {
    this.assertAvailable();
    this.db
      .query(
        `INSERT INTO config_revisions (
          id, timestamp, target_path, scope, old_hash, new_hash,
          mutation_kind, agent, property, old_value, new_value,
          mutation_json, before_content, after_content, note,
          state, prepared_at, committed_at, recovery_note,
          before_exists, after_exists, target_format,
          schema_package_version, schema_hash
        ) VALUES (
          $id, $timestamp, $target_path, $scope, $old_hash, $new_hash,
          $mutation_kind, $agent, $property, $old_value, $new_value,
          $mutation_json, $before_content, $after_content, $note,
          $state, $prepared_at, $committed_at, $recovery_note,
          $before_exists, $after_exists, $target_format,
          $schema_package_version, $schema_hash
        )`,
      )
      .run(bindRevision(rev) as never);
  }

  preparePending(rev: ConfigRevision): void {
    this.assertAvailable();
    const now = new Date().toISOString();
    this.insert({
      ...rev,
      state: "pending",
      preparedAt: rev.preparedAt ?? now,
      committedAt: undefined,
    });
  }

  markCommitted(id: string, note?: string): void {
    this.transition(id, "committed", note);
  }

  markAbandoned(id: string, note?: string): void {
    this.transition(id, "abandoned", note);
  }

  markConflict(id: string, note?: string): void {
    this.transition(id, "conflict", note);
  }

  private transition(
    id: string,
    next: Exclude<OmoRevisionState, "pending">,
    note?: string,
  ): void {
    this.assertAvailable();
    const current = this.get(id);
    if (!current) throw new Error(`Revision not found: ${id}`);
    if (current.state && current.state !== "pending") {
      throw new Error(
        `Revision ${id} is ${current.state} and cannot transition to ${next}`,
      );
    }
    const now = new Date().toISOString();
    this.db
      .query(
        `UPDATE config_revisions
         SET state = $state,
             committed_at = CASE WHEN $state = 'committed' THEN $now ELSE committed_at END,
             recovery_note = COALESCE($note, recovery_note)
         WHERE id = $id AND (state = 'pending' OR state IS NULL)`,
      )
      .run({
        $id: id,
        $state: next,
        $now: now,
        $note: note ?? null,
      });
  }

  list(limit = 50): ConfigRevision[] {
    const rows = this.db
      .query(
        `SELECT * FROM config_revisions ORDER BY timestamp DESC LIMIT $limit`,
      )
      .all({ $limit: limit }) as Record<string, unknown>[];
    return rows.map(rowToRev);
  }

  get(id: string): ConfigRevision | null {
    const row = this.db
      .query(`SELECT * FROM config_revisions WHERE id = $id`)
      .get({ $id: id }) as Record<string, unknown> | null;
    return row ? rowToRev(row) : null;
  }

  listPendingOmo(): ConfigRevision[] {
    if (!this.available) return [];
    const rows = this.db
      .query(
        `SELECT * FROM config_revisions
         WHERE state = 'pending'
         ORDER BY timestamp ASC`,
      )
      .all() as Record<string, unknown>[];
    return rows.map(rowToRev);
  }

  listCommittedOmo(
    cfg: ServerConfig,
    scope: OmoScope,
    limit = 50,
  ): ConfigRevision[] {
    if (!this.available) return [];
    const target = resolveWriteTarget(cfg, scope);
    const rows = this.db
      .query(
        `SELECT * FROM config_revisions
         WHERE state = 'committed'
           AND scope = $scope
         ORDER BY timestamp DESC
         LIMIT $limit`,
      )
      .all({ $scope: scope, $limit: limit }) as Record<string, unknown>[];
    return rows
      .map(rowToRev)
      .filter((r) => this.isOmoRevisionTarget(cfg, r));
    void target;
  }

  isOmoRevisionTarget(cfg: ServerConfig, rev: ConfigRevision): boolean {
    try {
      const current = resolveWriteTarget(cfg, rev.scope);
      return current.path === rev.targetPath;
    } catch {
      return false;
    }
  }

  isRestoreEligible(
    rev: ConfigRevision,
    currentSchemaOk: boolean,
  ): boolean {
    return (
      (rev.state ?? "committed") === "committed" &&
      currentSchemaOk
    );
  }

  listConflictScopes(cfg: ServerConfig): OmoScope[] {
    if (!this.available) return [];
    const rows = this.db
      .query(
        `SELECT DISTINCT scope FROM config_revisions WHERE state = 'conflict'`,
      )
      .all() as Array<{ scope: string }>;
    return rows
      .map((r) => r.scope)
      .filter((s): s is OmoScope => s === "user" || s === "project");
    void cfg;
  }

  isScopeWriteBlocked(cfg: ServerConfig, scope: OmoScope): boolean {
    if (!this.available) return true;
    const pending = this.listPendingOmo().filter((r) => r.scope === scope);
    if (pending.length) return true;
    const conflicts = this.db
      .query(
        `SELECT id FROM config_revisions
         WHERE state = 'conflict' AND scope = $scope
         LIMIT 1`,
      )
      .get({ $scope: scope }) as { id: string } | null;
    return !!conflicts;
    void cfg;
  }

  recoverPendingOmo(cfg: ServerConfig, scope?: OmoScope): RevisionRecoveryOutcome[] {
    if (!this.available) return [];
    const pending = this.listPendingOmo().filter((r) =>
      scope ? r.scope === scope : true,
    );
    const out: RevisionRecoveryOutcome[] = [];
    for (const rev of pending) {
      out.push(this.recoverOne(cfg, rev));
    }
    return out;
  }

  private recoverOne(
    cfg: ServerConfig,
    rev: ConfigRevision,
  ): RevisionRecoveryOutcome {
    let currentExists = false;
    let currentHash: string | null = null;
    try {
      const target = resolveWriteTarget(cfg, rev.scope);
      if (existsSync(target.path)) {
        currentExists = true;
        currentHash = hashContent(readFileSync(target.path, "utf-8"));
      }
    } catch {
      currentExists = false;
      currentHash = null;
    }

    const afterExists = rev.afterExists !== false;
    const beforeExists = rev.beforeExists !== false;

    if (currentExists && currentHash === rev.newHash && afterExists) {
      this.markCommitted(rev.id, "recovered: current bytes match after hash");
      return { action: "committed", id: rev.id };
    }
    if (
      (!currentExists && !beforeExists) ||
      (currentExists && currentHash === rev.oldHash)
    ) {
      this.markAbandoned(rev.id, "recovered: current matches before state");
      return { action: "abandoned", id: rev.id };
    }
    this.markConflict(
      rev.id,
      "recovered: current target diverged from pending before/after hashes",
    );
    return { action: "conflict", id: rev.id };
  }

  private assertAvailable(): void {
    if (!this.available) {
      throw new Error(
        this.migrationError
          ? `revision store unavailable: ${this.migrationError}`
          : "revision store unavailable",
      );
    }
  }
}

function bindRevision(rev: ConfigRevision): Record<string, unknown> {
  return {
    $id: rev.id,
    $timestamp: rev.timestamp,
    $target_path: rev.targetPath,
    $scope: rev.scope,
    $old_hash: rev.oldHash,
    $new_hash: rev.newHash,
    $mutation_kind: rev.mutationKind,
    $agent: rev.agent ?? null,
    $property: rev.property ?? null,
    $old_value: rev.oldValue ?? null,
    $new_value: rev.newValue ?? null,
    $mutation_json: rev.mutationJson,
    $before_content: rev.beforeContent,
    $after_content: rev.afterContent,
    $note: rev.note ?? null,
    $state: rev.state ?? "committed",
    $prepared_at: rev.preparedAt ?? null,
    $committed_at: rev.committedAt ?? (rev.state === "committed" || !rev.state
      ? rev.timestamp
      : null),
    $recovery_note: rev.recoveryNote ?? null,
    $before_exists: rev.beforeExists === false ? 0 : 1,
    $after_exists: rev.afterExists === false ? 0 : 1,
    $target_format: rev.targetFormat ?? null,
    $schema_package_version: rev.schemaPackageVersion ?? null,
    $schema_hash: rev.schemaHash ?? null,
  };
}

function rowToRev(row: Record<string, unknown>): ConfigRevision {
  return {
    id: String(row.id),
    timestamp: String(row.timestamp),
    targetPath: String(row.target_path),
    scope: String(row.scope) as ConfigWriteScope,
    oldHash: String(row.old_hash),
    newHash: String(row.new_hash),
    mutationKind: String(row.mutation_kind),
    agent: row.agent != null ? String(row.agent) : undefined,
    property: row.property != null ? String(row.property) : undefined,
    oldValue: row.old_value != null ? String(row.old_value) : undefined,
    newValue: row.new_value != null ? String(row.new_value) : undefined,
    mutationJson: String(row.mutation_json),
    beforeContent: String(row.before_content),
    afterContent: String(row.after_content),
    note: row.note != null ? String(row.note) : undefined,
    state: (row.state != null ? String(row.state) : "committed") as OmoRevisionState,
    preparedAt: row.prepared_at != null ? String(row.prepared_at) : undefined,
    committedAt: row.committed_at != null ? String(row.committed_at) : undefined,
    recoveryNote: row.recovery_note != null ? String(row.recovery_note) : undefined,
    beforeExists: row.before_exists == null ? true : Number(row.before_exists) !== 0,
    afterExists: row.after_exists == null ? true : Number(row.after_exists) !== 0,
    targetFormat: row.target_format != null ? (String(row.target_format) as OmoFormat) : undefined,
    schemaPackageVersion:
      row.schema_package_version != null
        ? String(row.schema_package_version)
        : undefined,
    schemaHash: row.schema_hash != null ? String(row.schema_hash) : undefined,
  };
}

export function defaultRevisionDbPath(projectRoot: string): string {
  return join(projectRoot, "data", "control-plane.db");
}
