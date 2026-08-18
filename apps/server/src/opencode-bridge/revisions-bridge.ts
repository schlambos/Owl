/**
 * Slice 17 hardened — Dedicated SQLite tables for bridge activation state.
 *
 * Oracle decision 1: separate long-lived data/control-plane-bridge.db.
 * Data dir 0700; DB 0600; reject symlink DB path; WAL, synchronous=FULL,
 * foreign_keys=ON, busy_timeout=5000, secure_delete=ON, user_version
 * migrations; clean checkpoint/truncate on close.
 *
 * Oracle decision 2: persistent bridge_activation_intents with
 * prepared|committed|aborted|conflict|recovery-pending. Singleton bridge_activation_state
 * stores committed desired state only. Insert prepared intent before
 * rename. After verified rename, one DB transaction inserts sanitized
 * revision, replaces committed activation state, marks committed, clears
 * pending raw nonce. If final DB commit fails, return recovery-pending.
 * Startup reconcile by file hash.
 *
 * Oracle decision 4/8: raw nonce boundary — no public getter/barrel export.
 * Raw nonce stored ONLY in bridge_activation_intents (cleared on commit)
 * and in committed bridge_activation_state (accessible only by internal
 * launch boundary accessor via scoped callback withCommittedRawNonce).
 */

import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ActivationIntentRecord,
  ActivationIntentStatus,
  BridgeActivationStateRecord,
  BridgeRevisionRecord,
  ConfigSourceKind,
  ContentActivationIntentRecord,
  ContentBridgeRevisionRecord,
} from "./types";
import { isWithinRoots, realpathRoots, realpathIfExists } from "./canonical";

export const CURRENT_BRIDGE_DB_VERSION = 3;

export class BridgeRevisionStore {
  private db: Database;
  private closed = false;
  private readonly authorizedRoots: string[];

  constructor(dbPath: string, authorizedRoots?: string[]) {
    this.authorizedRoots = authorizedRoots ?? [];
    // DB path security: reject symlinks and ensure path is authorized if roots provided.
    const realDbDir = realpathIfExists(dirname(dbPath));
    if (authorizedRoots && authorizedRoots.length > 0) {
      const realRoots = realpathRoots(authorizedRoots);
      if (!isWithinRoots(realDbDir, realRoots)) {
        throw new Error("Bridge DB directory outside authorized roots — rejected.");
      }
    }

    try {
      if (existsSync(dbPath)) {
        const stat = lstatSync(dbPath);
        if (stat.isSymbolicLink()) {
          throw new Error("Bridge DB path is a symlink — rejected for security.");
        }
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("rejected")) throw e;
    }

    // Create data dir with 0700.
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

    // Pragmas (oracle decision 1).
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = FULL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA secure_delete = ON;");

    this.runMigrations();
  }

  private runMigrations(): void {
    const current = this.db.query("PRAGMA user_version").get() as Record<string, unknown> | null;
    const version = current && typeof current["user_version"] === "number" ? current["user_version"] : 0;

    if (version > CURRENT_BRIDGE_DB_VERSION) {
      throw new Error(`Unsupported bridge database version: ${version} (max supported: ${CURRENT_BRIDGE_DB_VERSION})`);
    }

    if (version === 0) {
      this.migrateFromV0();
    } else if (version === 1) {
      this.migrateFromV1();
    } else if (version === 2) {
      this.migrateFromV2();
    }
  }

  /**
   * v2 → v3: metadata-only drift acceptance. Rebuilds the intents and
   * revisions tables so `byte_patch` becomes nullable (rebase records carry
   * none) and the rebase linkage/audit columns exist. Existing add/remove
   * rows are preserved verbatim and remain restorable.
   */
  private migrateFromV2(): void {
    try {
      this.db.exec("BEGIN IMMEDIATE;");
      this.rebuildToV3Tables();
      this.db.exec(`PRAGMA user_version = ${CURRENT_BRIDGE_DB_VERSION};`);
      this.db.exec("COMMIT;");
    } catch (e) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        /* */
      }
      throw new Error(`Bridge DB migration from v2 failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private rebuildToV3Tables(): void {
    // bridge_activation_intents: byte_patch nullable + rebase columns.
    // Defensive: skip when the table is absent (legacy DBs without it are
    // created fresh at the current schema by createCurrentSchema) or already
    // carries the v3 columns.
    const intentCols = this.getTableColumns("bridge_activation_intents");
    if (intentCols.length > 0 && !intentCols.includes("anchor_revision_id")) {
      this.rebuildIntentsToV3();
    }
    const revCols = this.getTableColumns("bridge_revisions");
    if (revCols.length > 0 && !revCols.includes("parent_revision_id")) {
      this.rebuildRevisionsToV3();
    }
    // Recreate indexes (dropped with rebuilt tables; harmless otherwise).
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_intent_status
        ON bridge_activation_intents(status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_unresolved_intent
        ON bridge_activation_intents ((1))
        WHERE status IN ('prepared', 'recovery-pending');
      CREATE INDEX IF NOT EXISTS idx_bridge_rev_ts
        ON bridge_revisions(timestamp DESC);
    `);
  }

  private rebuildIntentsToV3(): void {
    const cols = this.getTableColumns("bridge_activation_intents");
    const sourceKindExpr = cols.includes("source_kind") ? "source_kind" : "'project-root'";
    this.db.exec(`
      CREATE TABLE bridge_activation_intents_v3 (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        target_path TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        operation TEXT NOT NULL,
        baseline_hash TEXT NOT NULL,
        proposed_hash TEXT NOT NULL,
        canonical_identity TEXT NOT NULL,
        port INTEGER,
        registration_transport TEXT,
        transport_mode TEXT,
        nonce_fingerprint TEXT,
        byte_patch TEXT,
        raw_activation_nonce TEXT,
        expected_revision_id TEXT,
        anchor_revision_id TEXT,
        audit_metadata TEXT,
        created_at TEXT NOT NULL,
        committed_at TEXT
      );
      INSERT INTO bridge_activation_intents_v3 (
        id, status, target_path, source_kind, operation,
        baseline_hash, proposed_hash, canonical_identity,
        port, registration_transport, transport_mode,
        nonce_fingerprint, byte_patch, raw_activation_nonce,
        expected_revision_id, anchor_revision_id, audit_metadata,
        created_at, committed_at
      ) SELECT
        id, status, target_path, ${sourceKindExpr}, operation,
        baseline_hash, proposed_hash, canonical_identity,
        port, registration_transport, transport_mode,
        nonce_fingerprint, byte_patch, raw_activation_nonce,
        NULL, NULL, NULL,
        created_at, committed_at
      FROM bridge_activation_intents;
      DROP TABLE bridge_activation_intents;
      ALTER TABLE bridge_activation_intents_v3 RENAME TO bridge_activation_intents;
    `);
  }

  private rebuildRevisionsToV3(): void {
    const cols = this.getTableColumns("bridge_revisions");
    const sourceKindExpr = cols.includes("source_kind") ? "source_kind" : "'project-root'";
    this.db.exec(`
      CREATE TABLE bridge_revisions_v3 (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        target_path TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        operation TEXT NOT NULL,
        baseline_hash TEXT NOT NULL,
        post_write_hash TEXT NOT NULL,
        canonical_identity TEXT NOT NULL,
        port INTEGER,
        registration_transport TEXT,
        transport_mode TEXT,
        nonce_fingerprint TEXT,
        byte_patch TEXT,
        parent_revision_id TEXT,
        anchor_revision_id TEXT,
        acceptance_intent_id TEXT
      );
      INSERT INTO bridge_revisions_v3 (
        id, timestamp, target_path, source_kind, operation,
        baseline_hash, post_write_hash, canonical_identity,
        port, registration_transport, transport_mode,
        nonce_fingerprint, byte_patch,
        parent_revision_id, anchor_revision_id, acceptance_intent_id
      ) SELECT
        id, timestamp, target_path, ${sourceKindExpr}, operation,
        baseline_hash, post_write_hash, canonical_identity,
        port, registration_transport, transport_mode,
        nonce_fingerprint, byte_patch,
        NULL, NULL, NULL
      FROM bridge_revisions;
      DROP TABLE bridge_revisions;
      ALTER TABLE bridge_revisions_v3 RENAME TO bridge_revisions;
    `);
  }

  private migrateFromV0(): void {
    try {
      this.db.exec("BEGIN IMMEDIATE;");

      // Check if tables already exist (legacy unversioned DB).
      const tables = this.db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('bridge_activation_state', 'bridge_activation_intents', 'bridge_revisions')")
        .all() as Array<{ name: string }>;

      if (tables.length === 0) {
        // Fresh database: create all tables cleanly at current version.
        this.createCurrentSchema();
        this.db.exec(`PRAGMA user_version = ${CURRENT_BRIDGE_DB_VERSION};`);
        this.db.exec("COMMIT;");
        return;
      }

      // Legacy v0 database exists: inspect columns and rebuild tables cleanly.
      this.rebuildLegacyV0Tables();
      this.rebuildToV3Tables();
      this.db.exec(`PRAGMA user_version = ${CURRENT_BRIDGE_DB_VERSION};`);
      this.db.exec("COMMIT;");
    } catch (e) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        /* */
      }
      throw new Error(`Bridge DB migration from v0 failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private migrateFromV1(): void {
    try {
      this.db.exec("BEGIN IMMEDIATE;");
      this.upgradeLegacyTables();
      this.rebuildToV3Tables();
      this.db.exec(`PRAGMA user_version = ${CURRENT_BRIDGE_DB_VERSION};`);
      this.db.exec("COMMIT;");
    } catch (e) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        /* */
      }
      throw new Error(`Bridge DB migration from v1 failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private createCurrentSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bridge_activation_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        raw_activation_nonce TEXT,
        nonce_fingerprint TEXT,
        port INTEGER,
        registration_transport TEXT,
        transport_mode TEXT,
        canonical_identity TEXT NOT NULL,
        target_path TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        config_hash TEXT,
        revision_id TEXT,
        active INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bridge_activation_intents (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        target_path TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        operation TEXT NOT NULL,
        baseline_hash TEXT NOT NULL,
        proposed_hash TEXT NOT NULL,
        canonical_identity TEXT NOT NULL,
        port INTEGER,
        registration_transport TEXT,
        transport_mode TEXT,
        nonce_fingerprint TEXT,
        byte_patch TEXT,
        raw_activation_nonce TEXT,
        expected_revision_id TEXT,
        anchor_revision_id TEXT,
        audit_metadata TEXT,
        created_at TEXT NOT NULL,
        committed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_intent_status
        ON bridge_activation_intents(status);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_unresolved_intent
        ON bridge_activation_intents ((1))
        WHERE status IN ('prepared', 'recovery-pending');

      CREATE TABLE IF NOT EXISTS bridge_revisions (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        target_path TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        operation TEXT NOT NULL,
        baseline_hash TEXT NOT NULL,
        post_write_hash TEXT NOT NULL,
        canonical_identity TEXT NOT NULL,
        port INTEGER,
        registration_transport TEXT,
        transport_mode TEXT,
        nonce_fingerprint TEXT,
        byte_patch TEXT,
        parent_revision_id TEXT,
        anchor_revision_id TEXT,
        acceptance_intent_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_bridge_rev_ts
        ON bridge_revisions(timestamp DESC);

      CREATE TABLE IF NOT EXISTS bridge_probe_state (
        port INTEGER PRIMARY KEY,
        last_checked TEXT NOT NULL,
        in_use INTEGER NOT NULL,
        probe_kind TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bridge_probe_runs (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        port INTEGER NOT NULL,
        result TEXT NOT NULL,
        duration_ms INTEGER,
        note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_bridge_probe_ts
        ON bridge_probe_runs(timestamp DESC);
    `);
  }

  private rebuildLegacyV0Tables(): void {
    // 1. Rebuild bridge_activation_state if it exists
    const stateCols = this.getTableColumns("bridge_activation_state");
    if (stateCols.length > 0) {
      // Create new table
      this.db.exec(`
        CREATE TABLE bridge_activation_state_new (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          raw_activation_nonce TEXT,
          nonce_fingerprint TEXT,
          port INTEGER,
          registration_transport TEXT,
          transport_mode TEXT,
          canonical_identity TEXT NOT NULL,
          target_path TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          config_hash TEXT,
          revision_id TEXT,
          active INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );
      `);

      const hasRawNonce = stateCols.includes("raw_activation_nonce");
      const hasNonceFp = stateCols.includes("nonce_fingerprint");
      const hasPort = stateCols.includes("port");
      const hasRegTrans = stateCols.includes("registration_transport") || stateCols.includes("transport");
      const regTransCol = stateCols.includes("registration_transport") ? "registration_transport" : "transport";
      const hasTransMode = stateCols.includes("transport_mode");
      const hasCanon = stateCols.includes("canonical_identity");
      const hasTarget = stateCols.includes("target_path");
      const hasSourceKind = stateCols.includes("source_kind");
      const hasConfigHash = stateCols.includes("config_hash");
      const hasRevId = stateCols.includes("revision_id");
      const hasActive = stateCols.includes("active");
      const hasUpdatedAt = stateCols.includes("updated_at");

      this.db.exec(`
        INSERT INTO bridge_activation_state_new (
          id, raw_activation_nonce, nonce_fingerprint, port, registration_transport,
          transport_mode, canonical_identity, target_path, source_kind, config_hash,
          revision_id, active, updated_at
        ) SELECT
          id,
          ${hasRawNonce ? "raw_activation_nonce" : "NULL"},
          ${hasNonceFp ? "nonce_fingerprint" : "NULL"},
          ${hasPort ? "port" : "NULL"},
          ${hasRegTrans ? regTransCol : "'env'"},
          ${hasTransMode ? "transport_mode" : "'loopback-http'"},
          ${hasCanon ? "canonical_identity" : "''"},
          ${hasTarget ? "target_path" : "''"},
          ${hasSourceKind ? "source_kind" : "'project-root'"},
          ${hasConfigHash ? "config_hash" : "NULL"},
          ${hasRevId ? "revision_id" : "NULL"},
          ${hasActive ? "active" : "0"},
          ${hasUpdatedAt ? "updated_at" : "datetime('now')"}
        FROM bridge_activation_state;
      `);

      this.db.exec("DROP TABLE bridge_activation_state;");
      this.db.exec("ALTER TABLE bridge_activation_state_new RENAME TO bridge_activation_state;");
    }

    // 2. Rebuild bridge_revisions if it had legacy columns like patch_metadata
    const revCols = this.getTableColumns("bridge_revisions");
    if (revCols.length > 0 && (revCols.includes("patch_metadata") || revCols.includes("transport"))) {
      this.db.exec(`
        CREATE TABLE bridge_revisions_new (
          id TEXT PRIMARY KEY,
          timestamp TEXT NOT NULL,
          target_path TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          operation TEXT NOT NULL,
          baseline_hash TEXT NOT NULL,
          post_write_hash TEXT NOT NULL,
          canonical_identity TEXT NOT NULL,
          port INTEGER,
          registration_transport TEXT,
          transport_mode TEXT,
          nonce_fingerprint TEXT,
          byte_patch TEXT NOT NULL
        );
      `);

      const hasBytePatch = revCols.includes("byte_patch");
      const hasRegTrans = revCols.includes("registration_transport");
      const regTransCol = hasRegTrans ? "registration_transport" : (revCols.includes("transport") ? "transport" : "'env'");

      this.db.exec(`
        INSERT INTO bridge_revisions_new (
          id, timestamp, target_path, source_kind, operation,
          baseline_hash, post_write_hash, canonical_identity,
          port, registration_transport, transport_mode,
          nonce_fingerprint, byte_patch
        ) SELECT
          id, timestamp, target_path,
          ${revCols.includes("source_kind") ? "source_kind" : "'project-root'"},
          operation, baseline_hash, post_write_hash, canonical_identity,
          ${revCols.includes("port") ? "port" : "NULL"},
          ${regTransCol},
          ${revCols.includes("transport_mode") ? "transport_mode" : "'loopback-http'"},
          ${revCols.includes("nonce_fingerprint") ? "nonce_fingerprint" : "NULL"},
          ${hasBytePatch ? "byte_patch" : (revCols.includes("patch_metadata") ? "patch_metadata" : "'{}'")}
        FROM bridge_revisions;
      `);

      this.db.exec("DROP TABLE bridge_revisions;");
      this.db.exec("ALTER TABLE bridge_revisions_new RENAME TO bridge_revisions;");
    }

    this.createCurrentSchema();
  }

  private upgradeLegacyTables(): void {
    const stateCols = this.getTableColumns("bridge_activation_state");
    if (!stateCols.includes("source_kind")) {
      this.db.exec("ALTER TABLE bridge_activation_state ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'project-root';");
    }
    if (!stateCols.includes("config_hash")) {
      this.db.exec("ALTER TABLE bridge_activation_state ADD COLUMN config_hash TEXT;");
    }
    if (!stateCols.includes("revision_id")) {
      this.db.exec("ALTER TABLE bridge_activation_state ADD COLUMN revision_id TEXT;");
    }

    this.createCurrentSchema();
  }

  private getTableColumns(tableName: string): string[] {
    try {
      const rows = this.db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
      return rows.map((r) => r.name);
    } catch {
      return [];
    }
  }

  // ── Intent lifecycle (oracle decision 2) ────────────────────────────

  /**
   * Insert a prepared intent BEFORE rename.
   * Enforced in SQLite via partial unique index idx_unresolved_intent.
   * Stores raw nonce temporarily in intent record.
   */
  insertPreparedIntent(rec: Omit<ContentActivationIntentRecord, "status" | "createdAt" | "committedAt">): void {
    const existing = this.getPreparedIntents();
    if (existing.length > 0) {
      throw new Error(`Cannot insert prepared intent: unresolved intent already exists (${existing[0]!.id}).`);
    }

    this.db
      .query(
        `INSERT INTO bridge_activation_intents (
          id, status, target_path, source_kind, operation,
          baseline_hash, proposed_hash, canonical_identity,
          port, registration_transport, transport_mode,
          nonce_fingerprint, byte_patch, raw_activation_nonce, created_at
        ) VALUES (
          $id, 'prepared', $target_path, $source_kind, $operation,
          $baseline_hash, $proposed_hash, $canonical_identity,
          $port, $registration_transport, $transport_mode,
          $nonce_fingerprint, $byte_patch, $raw_nonce, $created_at
        )`,
      )
      .run({
        $id: rec.id,
        $target_path: rec.targetPath,
        $source_kind: rec.sourceKind,
        $operation: rec.operation,
        $baseline_hash: rec.baselineHash,
        $proposed_hash: rec.proposedHash,
        $canonical_identity: rec.canonicalIdentity,
        $port: rec.port ?? null,
        $registration_transport: rec.registrationTransport ?? null,
        $transport_mode: rec.transportMode ?? null,
        $nonce_fingerprint: rec.nonceFingerprint ?? null,
        $byte_patch: rec.bytePatch,
        $raw_nonce: rec.rawActivationNonce ?? null,
        $created_at: new Date().toISOString(),
      });
  }

  /**
   * Finalize a prepared intent in a single transaction:
   * 1. Insert sanitized revision.
   * 2. Replace committed activation state with desired enabled/disabled semantics.
   * 3. Mark intent committed.
   * 4. Clear raw nonce from intent.
   *
   * Returns true on success, false if the transaction failed (leaving intent for forward recovery).
   */
  finalizeIntent(
    intentId: string,
    revisionId: string,
    timestamp: string,
    configHash?: string,
  ): boolean {
    try {
      this.db.exec("BEGIN IMMEDIATE;");
      const intent = this.db
        .query("SELECT * FROM bridge_activation_intents WHERE id = $id")
        .get({ $id: intentId }) as Record<string, unknown> | null;
      if (!intent) {
        this.db.exec("ROLLBACK;");
        return false;
      }

      const op = String(intent.operation) as "add" | "remove";
      const finalConfigHash = configHash ?? String(intent.proposed_hash);

      // 1. Insert revision.
      this.db
        .query(
          `INSERT INTO bridge_revisions (
            id, timestamp, target_path, source_kind, operation,
            baseline_hash, post_write_hash, canonical_identity,
            port, registration_transport, transport_mode,
            nonce_fingerprint, byte_patch
          ) VALUES (
            $rev_id, $timestamp, $target_path, $source_kind, $operation,
            $baseline_hash, $proposed_hash, $canonical_identity,
            $port, $registration_transport, $transport_mode,
            $nonce_fingerprint, $byte_patch
          )`,
        )
        .run({
          $rev_id: revisionId,
          $timestamp: timestamp,
          $target_path: String(intent.target_path),
          $source_kind: String(intent.source_kind),
          $operation: op,
          $baseline_hash: String(intent.baseline_hash),
          $proposed_hash: String(intent.proposed_hash),
          $canonical_identity: String(intent.canonical_identity),
          $port: intent.port != null ? Number(intent.port) : null,
          $registration_transport: intent.registration_transport != null ? String(intent.registration_transport) : null,
          $transport_mode: intent.transport_mode != null ? String(intent.transport_mode) : null,
          $nonce_fingerprint: intent.nonce_fingerprint != null ? String(intent.nonce_fingerprint) : null,
          $byte_patch: String(intent.byte_patch),
        });

      // 2. Replace committed activation state.
      if (op === "add") {
        this.db
          .query(
            `INSERT OR REPLACE INTO bridge_activation_state (
              id, raw_activation_nonce, nonce_fingerprint, port, registration_transport,
              transport_mode, canonical_identity, target_path, source_kind,
              config_hash, revision_id, active, updated_at
            ) VALUES (
              1, $raw_nonce, $nonce_fingerprint, $port, $registration_transport,
              $transport_mode, $canonical_identity, $target_path, $source_kind,
              $config_hash, $revision_id, 1, $updated_at
            )`,
          )
          .run({
            $raw_nonce: intent.raw_activation_nonce != null ? String(intent.raw_activation_nonce) : null,
            $nonce_fingerprint: intent.nonce_fingerprint != null ? String(intent.nonce_fingerprint) : null,
            $port: intent.port != null ? Number(intent.port) : null,
            $registration_transport: intent.registration_transport != null ? String(intent.registration_transport) : "env",
            $transport_mode: intent.transport_mode != null ? String(intent.transport_mode) : "loopback-http",
            $canonical_identity: String(intent.canonical_identity),
            $target_path: String(intent.target_path),
            $source_kind: String(intent.source_kind),
            $config_hash: finalConfigHash,
            $revision_id: revisionId,
            $updated_at: timestamp,
          });
      } else {
        // remove → disabled committed state: clears secret fields/port/transport,
        // but RETAINS committed disabled target_path, source_kind, resulting config_hash, and revision_id.
        this.db
          .query(
            `INSERT OR REPLACE INTO bridge_activation_state (
              id, raw_activation_nonce, nonce_fingerprint, port, registration_transport,
              transport_mode, canonical_identity, target_path, source_kind,
              config_hash, revision_id, active, updated_at
            ) VALUES (
              1, NULL, NULL, NULL, NULL,
              NULL, $canonical_identity, $target_path, $source_kind,
              $config_hash, $revision_id, 0, $updated_at
            )`,
          )
          .run({
            $canonical_identity: String(intent.canonical_identity),
            $target_path: String(intent.target_path),
            $source_kind: String(intent.source_kind),
            $config_hash: finalConfigHash,
            $revision_id: revisionId,
            $updated_at: timestamp,
          });
      }

      // 3. Mark intent committed, clear raw nonce from intent.
      this.db
        .query(
          `UPDATE bridge_activation_intents
           SET status = 'committed', committed_at = $ts, raw_activation_nonce = NULL
           WHERE id = $id`,
        )
        .run({ $id: intentId, $ts: timestamp });

      this.db.exec("COMMIT;");
      return true;
    } catch {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        /* */
      }
      return false;
    }
  }

  /**
   * Metadata-only drift acceptance commit (DB v3). BEGIN IMMEDIATE
   * transaction:
   *  1. Re-read and re-validate the committed activation state (every
   *     committed field must still match the proven expectation exactly).
   *  2. Insert the committed rebase intent (created_at == committed_at, null
   *     byte patch / raw nonce, expected revision + anchor + audit metadata).
   *  3. Insert the rebase revision (non-restorable, parent/anchor linkage).
   *  4. CAS-update ONLY config_hash/revision_id/updated_at with a WHERE
   *     binding every committed field; require exactly one row.
   * The raw nonce column is never read or written here — it remains
   * byte-identical. Any failure rolls back completely.
   */
  commitDriftAcceptance(input: {
    intentId: string;
    revisionId: string;
    timestamp: string;
    targetPath: string;
    sourceKind: ConfigSourceKind;
    canonicalIdentity: string;
    port: number;
    nonceFingerprint: string;
    oldConfigHash: string;
    newConfigHash: string;
    expectedRevisionId: string;
    anchorRevisionId: string;
    auditMetadata: string;
  }): { ok: true } | { ok: false; code: "state-conflict"; message: string } {
    try {
      this.db.exec("BEGIN IMMEDIATE;");

      // 1. Re-read and validate the committed state inside the transaction.
      const row = this.db
        .query("SELECT * FROM bridge_activation_state WHERE id = 1")
        .get() as Record<string, unknown> | null;
      const stateOk =
        row !== null &&
        Number(row.active) === 1 &&
        String(row.config_hash) === input.oldConfigHash &&
        String(row.revision_id) === input.expectedRevisionId &&
        String(row.target_path) === input.targetPath &&
        String(row.source_kind) === input.sourceKind &&
        String(row.canonical_identity) === input.canonicalIdentity &&
        Number(row.port) === input.port &&
        String(row.registration_transport) === "env" &&
        String(row.transport_mode) === "loopback-http" &&
        String(row.nonce_fingerprint) === input.nonceFingerprint;
      if (!stateOk) {
        this.db.exec("ROLLBACK;");
        return {
          ok: false,
          code: "state-conflict",
          message: "Committed activation state changed before acceptance commit.",
        };
      }

      // 1b. Revalidate the CURRENT revision AND the complete anchor lineage
      //     inside the transaction (never trust a caller-supplied anchor).
      const lineageState: BridgeActivationStateRecord = {
        nonceFingerprint: String(row!.nonce_fingerprint),
        port: Number(row!.port),
        registrationTransport: "env",
        transportMode: "loopback-http",
        canonicalIdentity: String(row!.canonical_identity),
        targetPath: String(row!.target_path),
        sourceKind: String(row!.source_kind) as ConfigSourceKind,
        configHash: String(row!.config_hash),
        revisionId: String(row!.revision_id),
        active: true,
        updatedAt: String(row!.updated_at),
      };
      const lineage = this.validateAnchorLineage(lineageState);
      if (!lineage.ok || lineage.anchor.id !== input.anchorRevisionId) {
        this.db.exec("ROLLBACK");
        return {
          ok: false,
          code: "state-conflict",
          message: "Anchor lineage revalidation failed inside the acceptance transaction.",
        };
      }

      // 2. Insert the committed rebase intent (null byte patch / raw nonce).
      this.db
        .query(
          `INSERT INTO bridge_activation_intents (
            id, status, target_path, source_kind, operation,
            baseline_hash, proposed_hash, canonical_identity,
            port, registration_transport, transport_mode,
            nonce_fingerprint, byte_patch, raw_activation_nonce,
            expected_revision_id, anchor_revision_id, audit_metadata,
            created_at, committed_at
          ) VALUES (
            $id, 'committed', $target_path, $source_kind, 'rebase',
            $baseline_hash, $proposed_hash, $canonical_identity,
            $port, 'env', 'loopback-http',
            $nonce_fingerprint, NULL, NULL,
            $expected_revision_id, $anchor_revision_id, $audit_metadata,
            $created_at, $committed_at
          )`,
        )
        .run({
          $id: input.intentId,
          $target_path: input.targetPath,
          $source_kind: input.sourceKind,
          $baseline_hash: input.oldConfigHash,
          $proposed_hash: input.newConfigHash,
          $canonical_identity: input.canonicalIdentity,
          $port: input.port,
          $nonce_fingerprint: input.nonceFingerprint,
          $expected_revision_id: input.expectedRevisionId,
          $anchor_revision_id: input.anchorRevisionId,
          $audit_metadata: input.auditMetadata,
          $created_at: input.timestamp,
          $committed_at: input.timestamp,
        });

      // 3. Insert the rebase revision (non-restorable: null byte patch).
      this.db
        .query(
          `INSERT INTO bridge_revisions (
            id, timestamp, target_path, source_kind, operation,
            baseline_hash, post_write_hash, canonical_identity,
            port, registration_transport, transport_mode,
            nonce_fingerprint, byte_patch,
            parent_revision_id, anchor_revision_id, acceptance_intent_id
          ) VALUES (
            $id, $timestamp, $target_path, $source_kind, 'rebase',
            $baseline_hash, $post_write_hash, $canonical_identity,
            $port, 'env', 'loopback-http',
            $nonce_fingerprint, NULL,
            $parent_revision_id, $anchor_revision_id, $acceptance_intent_id
          )`,
        )
        .run({
          $id: input.revisionId,
          $timestamp: input.timestamp,
          $target_path: input.targetPath,
          $source_kind: input.sourceKind,
          $baseline_hash: input.oldConfigHash,
          $post_write_hash: input.newConfigHash,
          $canonical_identity: input.canonicalIdentity,
          $port: input.port,
          $nonce_fingerprint: input.nonceFingerprint,
          $parent_revision_id: input.expectedRevisionId,
          $anchor_revision_id: input.anchorRevisionId,
          $acceptance_intent_id: input.intentId,
        });

      // 4. CAS update ONLY config_hash/revision_id/updated_at, bound by
      //    every committed field; require exactly one row.
      const cas = this.db
        .query(
          `UPDATE bridge_activation_state
           SET config_hash = $new_hash, revision_id = $new_rev, updated_at = $ts
           WHERE id = 1
             AND active = 1
             AND config_hash = $old_hash
             AND revision_id = $expected_rev
             AND target_path = $target_path
             AND source_kind = $source_kind
             AND canonical_identity = $canonical_identity
             AND port = $port
             AND registration_transport = 'env'
             AND transport_mode = 'loopback-http'
             AND nonce_fingerprint = $nonce_fingerprint`,
        )
        .run({
          $new_hash: input.newConfigHash,
          $new_rev: input.revisionId,
          $ts: input.timestamp,
          $old_hash: input.oldConfigHash,
          $expected_rev: input.expectedRevisionId,
          $target_path: input.targetPath,
          $source_kind: input.sourceKind,
          $canonical_identity: input.canonicalIdentity,
          $port: input.port,
          $nonce_fingerprint: input.nonceFingerprint,
        });
      if (cas.changes !== 1) {
        this.db.exec("ROLLBACK;");
        return {
          ok: false,
          code: "state-conflict",
          message: "Committed activation state CAS update matched zero rows.",
        };
      }

      this.db.exec("COMMIT;");
      return { ok: true };
    } catch {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        /* */
      }
      return {
        ok: false,
        code: "state-conflict",
        message: "Drift acceptance transaction failed; rolled back.",
      };
    }
  }

  /**
   * Validate the complete anchor lineage for a committed activation state.
   *
   * Starts from `state.revisionId` EXACTLY (never a caller-supplied anchor)
   * and walks rebase parent links back to the original content-writing ADD:
   *  - every link proves child.baselineHash === parent.postWriteHash;
   *  - target/source/canonical/port/transport/fingerprint are identical
   *    across the whole chain and the committed state;
   *  - every rebase link carries the identical anchorRevisionId, is
   *    non-restorable by construction (null byte patch);
   *  - the chain terminates at an `add` revision whose ID equals the
   *    recorded anchor and whose content patch is a valid BridgeBytePatchV1
   *    (empty deleteText, non-empty insertText);
   *  - remove/unknown/malformed rows, broken parent/hash/key links, cycles,
   *    and chains deeper than 4096 are rejected.
   *
   * Read-only. Used by the drift proof and re-validated inside
   * commitDriftAcceptance's BEGIN IMMEDIATE transaction.
   */
  validateAnchorLineage(
    state: BridgeActivationStateRecord,
  ): { ok: true; anchor: BridgeRevisionRecord } | { ok: false; reason: string } {
    const MAX_DEPTH = 4096;
    if (state.revisionId === undefined) {
      return { ok: false, reason: "committed state has no revision" };
    }
    const visited = new Set<string>();
    let recordedAnchorId: string | undefined;
    let current = this.getRevision(state.revisionId);
    // Lineage START: the current revision's post-write hash must equal the
    // committed config hash — for a direct add AND for a current rebase.
    if (
      current !== null &&
      state.configHash !== undefined &&
      current.postWriteHash !== state.configHash
    ) {
      return { ok: false, reason: "lineage-current-hash-mismatch" };
    }
    let depth = 0;
    while (current !== null) {
      if (depth > MAX_DEPTH) return { ok: false, reason: "lineage-depth-exceeded" };
      if (visited.has(current.id)) return { ok: false, reason: "lineage-cycle" };
      visited.add(current.id);
      depth++;

      // Every link must match the committed state's identity fields.
      if (
        current.targetPath !== state.targetPath ||
        current.sourceKind !== state.sourceKind ||
        current.canonicalIdentity !== state.canonicalIdentity ||
        current.port !== state.port ||
        current.registrationTransport !== state.registrationTransport ||
        current.transportMode !== state.transportMode ||
        current.nonceFingerprint !== state.nonceFingerprint
      ) {
        return { ok: false, reason: "lineage-identity-mismatch" };
      }

      if (current.operation !== "rebase") {
        if (current.operation === "remove") {
          return { ok: false, reason: "lineage-remove-in-chain" };
        }
        // Termination at an ADD: ID must equal the recorded anchor (when
        // links preceded it) and the content patch must be valid.
        if (recordedAnchorId !== undefined && current.id !== recordedAnchorId) {
          return { ok: false, reason: "lineage-anchor-mismatch" };
        }
        try {
          const p = JSON.parse(current.bytePatch) as Record<string, unknown>;
          if (
            p === null ||
            typeof p !== "object" ||
            p["version"] !== 1 ||
            !Number.isInteger(p["offsetUtf16"]) ||
            typeof p["deleteText"] !== "string" ||
            p["deleteText"] !== "" ||
            typeof p["insertText"] !== "string" ||
            (p["insertText"] as string).length === 0
          ) {
            return { ok: false, reason: "lineage-anchor-patch-invalid" };
          }
        } catch {
          return { ok: false, reason: "lineage-anchor-patch-invalid" };
        }
        return { ok: true, anchor: current };
      }

      // Rebase link: non-restorable by construction + hash/anchor linkage.
      if (current.bytePatch !== null) {
        return { ok: false, reason: "lineage-rebase-has-patch" };
      }
      if (recordedAnchorId === undefined) {
        recordedAnchorId = current.anchorRevisionId;
      } else if (current.anchorRevisionId !== recordedAnchorId) {
        return { ok: false, reason: "lineage-anchor-inconsistent" };
      }
      const parent = this.getRevision(current.parentRevisionId);
      if (parent === null) return { ok: false, reason: "lineage-parent-missing" };
      if (current.baselineHash !== parent.postWriteHash) {
        return { ok: false, reason: "lineage-hash-mismatch" };
      }
      current = parent;
    }
    return { ok: false, reason: "lineage-revision-missing" };
  }

  /**
   * Mark a prepared intent as aborted (rename failed or pre-rename error).
   * Clears raw nonce.
   */
  abortIntent(intentId: string): void {
    this.db
      .query(
        `UPDATE bridge_activation_intents
         SET status = 'aborted', raw_activation_nonce = NULL
         WHERE id = $id`,
      )
      .run({ $id: intentId });
  }

  /**
   * Mark a prepared intent as conflict (post-rename hash drift/conflict where recovery is impossible).
   * Clears raw nonce.
   */
  conflictIntent(intentId: string): void {
    this.db
      .query(
        `UPDATE bridge_activation_intents
         SET status = 'conflict', raw_activation_nonce = NULL
         WHERE id = $id`,
      )
      .run({ $id: intentId });
  }

  /**
   * Mark an intent as recovery-pending. DOES NOT clear raw nonce so forward
   * reconciliation can finalize it when file hash matches.
   */
  markRecoveryPending(intentId: string): void {
    this.db
      .query(
        `UPDATE bridge_activation_intents
         SET status = 'recovery-pending'
         WHERE id = $id`,
      )
      .run({ $id: intentId });
  }

  getIntent(id: string): ActivationIntentRecord | null {
    const row = this.db
      .query("SELECT * FROM bridge_activation_intents WHERE id = $id")
      .get({ $id: id }) as Record<string, unknown> | null;
    if (!row) return null;
    try {
      return rowToIntent(row);
    } catch {
      // Unknown/malformed operation: stable rejection (treated as absent),
      // never an uncaught exception.
      return null;
    }
  }

  /**
   * Get all unresolved intents (prepared or recovery-pending).
   */
  getPreparedIntents(): ActivationIntentRecord[] {
    const rows = this.db
      .query("SELECT * FROM bridge_activation_intents WHERE status IN ('prepared', 'recovery-pending')")
      .all() as Record<string, unknown>[];
    const out: ActivationIntentRecord[] = [];
    for (const row of rows) {
      try {
        out.push(rowToIntent(row));
      } catch {
        // Unknown/malformed operation rows are skipped (fail closed).
      }
    }
    return out;
  }

  /**
   * Check if any unresolved or conflict intents exist in the store.
   */
  hasUnresolvedOrConflictIntents(): boolean {
    const row = this.db
      .query("SELECT COUNT(*) as count FROM bridge_activation_intents WHERE status IN ('prepared', 'recovery-pending', 'conflict')")
      .get() as { count: number } | null;
    return (row?.count ?? 0) > 0;
  }

  // ── Revisions ───────────────────────────────────────────────────────

  /**
   * Generic revision insert — CONTENT revisions only. Rebase rows are
   * written exclusively by commitDriftAcceptance (inside its transaction
   * with full lineage revalidation); they are rejected here.
   */
  insertRevision(rec: ContentBridgeRevisionRecord): void {
    // Runtime guard: rebase rows are written exclusively by
    // commitDriftAcceptance inside its lineage-validated transaction.
    if ((rec as { operation: string }).operation === "rebase") {
      throw new Error("rebase revisions are not accepted by the generic insert");
    }
    this.db
      .query(
        `INSERT INTO bridge_revisions (
          id, timestamp, target_path, source_kind, operation,
          baseline_hash, post_write_hash, canonical_identity,
          port, registration_transport, transport_mode,
          nonce_fingerprint, byte_patch
        ) VALUES (
          $id, $timestamp, $target_path, $source_kind, $operation,
          $baseline_hash, $post_write_hash, $canonical_identity,
          $port, $registration_transport, $transport_mode,
          $nonce_fingerprint, $byte_patch
        )`,
      )
      .run({
        $id: rec.id,
        $timestamp: rec.timestamp,
        $target_path: rec.targetPath,
        $source_kind: rec.sourceKind,
        $operation: rec.operation,
        $baseline_hash: rec.baselineHash,
        $post_write_hash: rec.postWriteHash,
        $canonical_identity: rec.canonicalIdentity,
        $port: rec.port ?? null,
        $registration_transport: rec.registrationTransport ?? null,
        $transport_mode: rec.transportMode ?? null,
        $nonce_fingerprint: rec.nonceFingerprint ?? null,
        $byte_patch: rec.bytePatch,
      });
  }

  getRevision(id: string): BridgeRevisionRecord | null {
    const row = this.db
      .query("SELECT * FROM bridge_revisions WHERE id = $id")
      .get({ $id: id }) as Record<string, unknown> | null;
    if (!row) return null;
    try {
      return rowToBridgeRev(row);
    } catch {
      // Unknown/malformed operation: stable rejection (treated as absent).
      return null;
    }
  }

  listRevisions(limit = 50): BridgeRevisionRecord[] {
    const rows = this.db
      .query("SELECT * FROM bridge_revisions ORDER BY timestamp DESC LIMIT $limit")
      .all({ $limit: limit }) as Record<string, unknown>[];
    const out: BridgeRevisionRecord[] = [];
    for (const row of rows) {
      try {
        out.push(rowToBridgeRev(row));
      } catch {
        // Unknown/malformed operation rows are skipped (fail closed).
      }
    }
    return out;
  }

  // ── Activation state (committed, sanitized — no raw nonce) ──────────

  getActivationState(): BridgeActivationStateRecord | null {
    const row = this.db
      .query(
        `SELECT nonce_fingerprint, port, registration_transport, transport_mode,
         canonical_identity, target_path, source_kind, config_hash, revision_id,
         active, updated_at
         FROM bridge_activation_state WHERE id = 1`,
      )
      .get() as Record<string, unknown> | null;
    if (!row) return null;
    return {
      nonceFingerprint: row.nonce_fingerprint != null ? String(row.nonce_fingerprint) : undefined,
      port: row.port != null ? Number(row.port) : undefined,
      registrationTransport: row.registration_transport != null ? (String(row.registration_transport) as "env" | "tuple") : undefined,
      transportMode: row.transport_mode != null ? (String(row.transport_mode) as "loopback-http") : undefined,
      canonicalIdentity: String(row.canonical_identity),
      targetPath: String(row.target_path),
      sourceKind: String(row.source_kind) as ConfigSourceKind,
      configHash: row.config_hash != null ? String(row.config_hash) : undefined,
      revisionId: row.revision_id != null ? String(row.revision_id) : undefined,
      active: Number(row.active) === 1,
      updatedAt: String(row.updated_at),
    };
  }

  /** Authorized roots captured at construction (may be empty). */
  getAuthorizedRoots(): string[] {
    return [...this.authorizedRoots];
  }

  /**
   * INTERNAL ONLY (oracle decision 4/8) — NOT barrel-exported.
   * Narrow callback-based execution boundary for the launch boundary.
   * The raw nonce is never returned as a value; it is supplied exclusively
   * to the provided synchronous callback function during owned launch.
   */
  withCommittedRawNonce(fn: (rawNonce: string) => void): boolean {
    const row = this.db
      .query("SELECT raw_activation_nonce FROM bridge_activation_state WHERE id = 1")
      .get() as Record<string, unknown> | null;
    if (!row || row.raw_activation_nonce == null) return false;
    const rawNonce = String(row.raw_activation_nonce);
    // The callback is synchronous void: any returned value is DISCARDED so
    // the raw nonce can never escape this boundary as a return value.
    fn(rawNonce);
    return true;
  }

  /**
   * Clear the raw nonce from committed state (for disable/remove).
   */
  clearRawCommittedNonce(): void {
    this.db
      .query("UPDATE bridge_activation_state SET raw_activation_nonce = NULL WHERE id = 1")
      .run();
  }

  // ── Probe runs ──────────────────────────────────────────────────────

  recordProbeRun(rec: {
    id: string;
    timestamp: string;
    port: number;
    result: "free" | "in-use" | "error";
    durationMs?: number;
    note?: string;
  }): void {
    this.db
      .query(
        `INSERT INTO bridge_probe_runs (
          id, timestamp, port, result, duration_ms, note
        ) VALUES ($id, $timestamp, $port, $result, $duration_ms, $note)`,
      )
      .run({
        $id: rec.id,
        $timestamp: rec.timestamp,
        $port: rec.port,
        $result: rec.result,
        $duration_ms: rec.durationMs ?? null,
        $note: rec.note ?? null,
      });
  }

  // ── Close (oracle decision 1: clean checkpoint/truncate) ────────────

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

// ── Row mappers ───────────────────────────────────────────────────────

function rowToBridgeRev(row: Record<string, unknown>): BridgeRevisionRecord {
  const base = {
    id: String(row.id),
    timestamp: String(row.timestamp),
    targetPath: String(row.target_path),
    sourceKind: String(row.source_kind) as ConfigSourceKind,
    baselineHash: String(row.baseline_hash),
    postWriteHash: String(row.post_write_hash),
    canonicalIdentity: String(row.canonical_identity),
    port: row.port != null ? Number(row.port) : undefined,
    registrationTransport: row.registration_transport != null ? (String(row.registration_transport) as "env" | "tuple") : undefined,
    transportMode: row.transport_mode != null ? (String(row.transport_mode) as "loopback-http") : undefined,
    nonceFingerprint: row.nonce_fingerprint != null ? String(row.nonce_fingerprint) : undefined,
  };
  const operation = String(row.operation);
  // Strict operation parse: only add|remove|rebase are recognized. Unknown
  // values throw internally; every caller converts this to a stable
  // rejection (never an uncaught exception).
  if (operation !== "add" && operation !== "remove" && operation !== "rebase") {
    throw new Error("unknown bridge revision operation");
  }
  if (operation === "rebase") {
    return {
      ...base,
      operation: "rebase",
      // Surface a corrupt non-null stored patch rather than hiding it.
      bytePatch: row.byte_patch != null ? String(row.byte_patch) : null,
      parentRevisionId: String(row.parent_revision_id ?? ""),
      anchorRevisionId: String(row.anchor_revision_id ?? ""),
      acceptanceIntentId: String(row.acceptance_intent_id ?? ""),
    };
  }
  return {
    ...base,
    operation,
    bytePatch: String(row.byte_patch),
  };
}

function rowToIntent(row: Record<string, unknown>): ActivationIntentRecord {
  const base = {
    id: String(row.id),
    status: String(row.status) as ActivationIntentStatus,
    targetPath: String(row.target_path),
    sourceKind: String(row.source_kind) as ConfigSourceKind,
    baselineHash: String(row.baseline_hash),
    proposedHash: String(row.proposed_hash),
    canonicalIdentity: String(row.canonical_identity),
    port: row.port != null ? Number(row.port) : undefined,
    registrationTransport: row.registration_transport != null ? (String(row.registration_transport) as "env" | "tuple") : undefined,
    transportMode: row.transport_mode != null ? (String(row.transport_mode) as "loopback-http") : undefined,
    nonceFingerprint: row.nonce_fingerprint != null ? String(row.nonce_fingerprint) : undefined,
    createdAt: String(row.created_at),
    committedAt: row.committed_at != null ? String(row.committed_at) : undefined,
  };
  const operation = String(row.operation);
  // Strict operation parse: unknown values throw internally; callers
  // convert to stable rejections (never uncaught).
  if (operation !== "add" && operation !== "remove" && operation !== "rebase") {
    throw new Error("unknown activation intent operation");
  }
  if (operation === "rebase") {
    return {
      ...base,
      operation: "rebase",
      bytePatch: null,
      rawActivationNonce: null,
      expectedRevisionId: String(row.expected_revision_id ?? ""),
      anchorRevisionId: String(row.anchor_revision_id ?? ""),
      auditMetadata: String(row.audit_metadata ?? ""),
    };
  }
  return {
    ...base,
    operation,
    bytePatch: String(row.byte_patch),
    rawActivationNonce: row.raw_activation_nonce != null ? String(row.raw_activation_nonce) : undefined,
  };
}

export function defaultBridgeRevisionDbPath(projectRoot: string): string {
  return join(projectRoot, "data", "control-plane-bridge.db");
}
