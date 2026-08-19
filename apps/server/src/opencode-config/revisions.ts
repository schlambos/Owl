/**
 * Dedicated SQLite store for OpenCode PROVIDER-management revisions.
 *
 * Separate table/domain by design — this store never shares rows with the
 * telemetry BridgeRevisionStore or the OMO RevisionStore. Summaries are
 * secret-free by construction (the mutation producers emit allowlisted
 * operation metadata only; no file text, no keys, no baseURL of external
 * providers, no auth material).
 */

import { Database } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isWithinRoots, realpathIfExists, realpathRoots } from "../opencode-bridge/canonical";

export interface ProviderRevisionRecord {
  id: string;
  timestamp: string;
  targetPath: string;
  operation: "provider-added" | "provider-blacklist" | "provider-enablement";
  providerId: string;
  baselineHash: string;
  postWriteHash: string;
  /** Secret-free JSON summary allowlist produced by the mutation. */
  summary: string;
}

export function defaultProviderRevisionDbPath(projectRoot: string): string {
  return join(projectRoot, "data", "control-plane-providers.db");
}

export class ProviderRevisionStore {
  private db: Database;
  private closed = false;

  constructor(dbPath: string, authorizedRoots?: string[]) {
    const realDbDir = realpathIfExists(dirname(dbPath));
    if (authorizedRoots && authorizedRoots.length > 0) {
      // The DB dir may not exist yet (cannot be realpath'd); accept either
      // the realpath or lexical form of each authorized root.
      const rootForms = [
        ...new Set([...realpathRoots(authorizedRoots), ...authorizedRoots]),
      ];
      if (!isWithinRoots(realDbDir, rootForms)) {
        throw new Error("Provider revision DB directory outside authorized roots — rejected.");
      }
    }
    if (existsSync(dbPath) && lstatSync(dbPath).isSymbolicLink()) {
      throw new Error("Provider revision DB path is a symlink — rejected for security.");
    }

    const dir = dirname(dbPath);
    mkdirSync(dir, { recursive: true });
    try {
      chmodSync(dir, 0o700);
    } catch {
      throw new Error(`Failed to set directory permissions on ${dir}`);
    }
    this.db = new Database(dbPath);
    try {
      chmodSync(dbPath, 0o600);
    } catch {
      throw new Error(`Failed to set database file permissions on ${dbPath}`);
    }
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = FULL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA secure_delete = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS opencode_provider_revisions (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        target_path TEXT NOT NULL,
        operation TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        baseline_hash TEXT NOT NULL,
        post_write_hash TEXT NOT NULL,
        summary TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_provider_rev_ts
        ON opencode_provider_revisions(timestamp DESC);
      PRAGMA user_version = 1;
    `);
  }

  insertRevision(rec: ProviderRevisionRecord): void {
    this.db
      .query(
        `INSERT INTO opencode_provider_revisions (
          id, timestamp, target_path, operation, provider_id,
          baseline_hash, post_write_hash, summary
        ) VALUES ($id, $timestamp, $target_path, $operation, $provider_id,
          $baseline_hash, $post_write_hash, $summary)`,
      )
      .run({
        $id: rec.id,
        $timestamp: rec.timestamp,
        $target_path: rec.targetPath,
        $operation: rec.operation,
        $provider_id: rec.providerId,
        $baseline_hash: rec.baselineHash,
        $post_write_hash: rec.postWriteHash,
        $summary: rec.summary,
      });
  }

  getLatestForTarget(targetPath: string): ProviderRevisionRecord | null {
    const row = this.db
      .query(
        `SELECT * FROM opencode_provider_revisions
         WHERE target_path = $path ORDER BY timestamp DESC LIMIT 1`,
      )
      .get({ $path: targetPath }) as Record<string, unknown> | null;
    return row ? rowToRecord(row) : null;
  }

  listRevisions(limit = 50): ProviderRevisionRecord[] {
    const rows = this.db
      .query("SELECT * FROM opencode_provider_revisions ORDER BY timestamp DESC LIMIT $limit")
      .all({ $limit: limit }) as Record<string, unknown>[];
    return rows.map(rowToRecord);
  }

  count(): number {
    const row = this.db
      .query("SELECT COUNT(*) as count FROM opencode_provider_revisions")
      .get() as { count: number } | null;
    return row?.count ?? 0;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      /* best effort */
    }
    try {
      this.db.close();
    } catch {
      /* */
    }
  }
}

function rowToRecord(row: Record<string, unknown>): ProviderRevisionRecord {
  return {
    id: String(row.id),
    timestamp: String(row.timestamp),
    targetPath: String(row.target_path),
    operation: String(row.operation) as ProviderRevisionRecord["operation"],
    providerId: String(row.provider_id),
    baselineHash: String(row.baseline_hash),
    postWriteHash: String(row.post_write_hash),
    summary: String(row.summary),
  };
}
