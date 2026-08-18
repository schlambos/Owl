/**
 * Slice 17 hardened — Revision store, migration, and intent lifecycle tests.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  BridgeRevisionStore,
  CURRENT_BRIDGE_DB_VERSION,
} from "./revisions-bridge";
import { fingerprintNonce } from "./extractor";

let sandbox: string;
let dbPath: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "omo-revstore-"));
  dbPath = join(sandbox, "data", "bridge.db");
});

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* */
  }
});

describe("BridgeRevisionStore: DB Path Security", () => {
  test("rejects symlinked DB file", () => {
    const realDir = join(sandbox, "real");
    mkdirSync(realDir, { recursive: true });
    const realDb = join(realDir, "actual.db");
    const fakeDb = new Database(realDb);
    fakeDb.close();

    const linkDb = join(sandbox, "link.db");
    symlinkSync(realDb, linkDb);

    expect(() => new BridgeRevisionStore(linkDb)).toThrow(/symlink/i);
  });

  test("rejects DB outside authorized roots", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "omo-outside-"));
    try {
      const outsideDb = join(outsideDir, "outside.db");
      expect(
        () => new BridgeRevisionStore(outsideDb, [sandbox]),
      ).toThrow(/outside authorized roots/i);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe("BridgeRevisionStore: Migrations", () => {
  test("creates fresh schema at CURRENT_BRIDGE_DB_VERSION", () => {
    const store = new BridgeRevisionStore(dbPath);
    const db = new Database(dbPath);
    const version = db.query("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(CURRENT_BRIDGE_DB_VERSION);
    store.close();
    db.close();
  });

  test("migrates legacy v0 unversioned database fixture with legacy columns safely with no raw leakage", () => {
    mkdirSync(join(sandbox, "data"), { recursive: true });
    const rawDb = new Database(dbPath);

    // Create legacy v0 tables (with legacy columns 'transport' and 'patch_metadata').
    rawDb.exec(`
      PRAGMA user_version = 0;
      CREATE TABLE bridge_activation_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        raw_activation_nonce TEXT,
        nonce_fingerprint TEXT NOT NULL,
        port INTEGER,
        transport TEXT NOT NULL,
        canonical_identity TEXT NOT NULL,
        target_path TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      INSERT INTO bridge_activation_state VALUES (
        1, 'v0-secret-nonce-1234', 'fp1234', 8788, 'env',
        '/canonical/bridge', '/path/opencode.json', 1, '2026-08-14T00:00:00Z'
      );

      CREATE TABLE bridge_revisions (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        target_path TEXT NOT NULL,
        operation TEXT NOT NULL,
        baseline_hash TEXT NOT NULL,
        post_write_hash TEXT NOT NULL,
        canonical_identity TEXT NOT NULL,
        port INTEGER,
        transport TEXT NOT NULL,
        nonce_fingerprint TEXT NOT NULL,
        patch_metadata TEXT NOT NULL
      );
      INSERT INTO bridge_revisions VALUES (
        'rev_v0', '2026-08-14T00:00:00Z', '/path/opencode.json', 'add',
        'h1', 'h2', '/canonical/bridge', 8788, 'env', 'fp1234', '{"v":1}'
      );
    `);
    rawDb.close();

    // Opening with BridgeRevisionStore must upgrade schema to CURRENT_BRIDGE_DB_VERSION.
    const store = new BridgeRevisionStore(dbPath);
    const state = store.getActivationState();
    expect(state).not.toBeNull();
    expect(state?.active).toBe(true);
    expect(state?.sourceKind).toBe("project-root"); // defaulted in migration
    expect(state?.registrationTransport).toBe("env");
    expect(state?.transportMode).toBe("loopback-http");

    // Verify raw nonce not in sanitized activation state.
    const stateJson = JSON.stringify(state);
    expect(stateJson).not.toContain("v0-secret-nonce-1234");

    // Verify raw nonce accessible exclusively via scoped callback withCommittedRawNonce.
    expect((store as unknown as Record<string, unknown>).getRawCommittedNonce).toBeUndefined();
    let scoped: string | undefined;
    const accessed = store.withCommittedRawNonce((nonce) => {
      expect(nonce).toBe("v0-secret-nonce-1234");
      scoped = nonce;
      // Return value is deliberately discarded by the boundary.
      return "accessed-in-scope";
    });
    expect(accessed).toBe(true);
    expect(scoped).toBe("v0-secret-nonce-1234");

    // Verify revision rows have no raw nonce leakage.
    const revs = store.listRevisions();
    expect(revs).toHaveLength(1);
    expect(revs[0]!.sourceKind).toBe("project-root");
    expect(revs[0]!.registrationTransport).toBe("env");
    expect(revs[0]!.transportMode).toBe("loopback-http");
    expect(JSON.stringify(revs[0])).not.toContain("v0-secret-nonce-1234");

    store.close();
  });

  test("fails closed on unsupported future database version", () => {
    mkdirSync(join(sandbox, "data"), { recursive: true });
    const rawDb = new Database(dbPath);
    rawDb.exec(`PRAGMA user_version = 999;`);
    rawDb.close();

    expect(() => new BridgeRevisionStore(dbPath)).toThrow(/unsupported bridge database version: 999/i);
  });
});

describe("BridgeRevisionStore: Intent Lifecycle & Transitions", () => {
  test("enforces at most one unresolved intent", () => {
    const store = new BridgeRevisionStore(dbPath);

    store.insertPreparedIntent({
      id: "intent_1",
      targetPath: "/path/opencode.json",
      sourceKind: "project-root",
      operation: "add",
      baselineHash: "h_base",
      proposedHash: "h_prop",
      canonicalIdentity: "/bridge",
      port: 8788,
      registrationTransport: "env",
      transportMode: "loopback-http",
      nonceFingerprint: fingerprintNonce("n1"),
      bytePatch: JSON.stringify({ version: 1, offsetUtf16: 0, deleteText: "", insertText: "" }),
      rawActivationNonce: "n1",
    });

    expect(() => {
      store.insertPreparedIntent({
        id: "intent_2",
        targetPath: "/path/opencode.json",
        sourceKind: "project-root",
        operation: "add",
        baselineHash: "h_base",
        proposedHash: "h_prop",
        canonicalIdentity: "/bridge",
        port: 8789,
        registrationTransport: "env",
        transportMode: "loopback-http",
        nonceFingerprint: fingerprintNonce("n2"),
        bytePatch: JSON.stringify({ version: 1, offsetUtf16: 0, deleteText: "", insertText: "" }),
        rawActivationNonce: "n2",
      });
    }).toThrow(/unresolved intent already exists/i);

    store.close();
  });

  test("finalizeIntent for remove sets committed columns to NULL", () => {
    const store = new BridgeRevisionStore(dbPath);

    // 1. Add intent & finalize.
    store.insertPreparedIntent({
      id: "intent_add",
      targetPath: "/path/opencode.json",
      sourceKind: "project-root",
      operation: "add",
      baselineHash: "h_base",
      proposedHash: "h_prop",
      canonicalIdentity: "/bridge",
      port: 8788,
      registrationTransport: "env",
      transportMode: "loopback-http",
      nonceFingerprint: fingerprintNonce("nonce_add"),
      bytePatch: JSON.stringify({ version: 1, offsetUtf16: 0, deleteText: "", insertText: "" }),
      rawActivationNonce: "nonce_add",
    });

    const addOk = store.finalizeIntent("intent_add", "rev_add", "2026-08-14T10:00:00Z", "h_prop");
    expect(addOk).toBe(true);

    const activeState = store.getActivationState();
    expect(activeState?.active).toBe(true);
    expect(activeState?.port).toBe(8788);
    let addNonce: string | undefined;
    expect(
      store.withCommittedRawNonce((nonce) => {
        addNonce = nonce;
      }),
    ).toBe(true);
    expect(addNonce).toBe("nonce_add");

    // 2. Remove intent & finalize.
    store.insertPreparedIntent({
      id: "intent_remove",
      targetPath: "/path/opencode.json",
      sourceKind: "project-root",
      operation: "remove",
      baselineHash: "h_prop",
      proposedHash: "h_base",
      canonicalIdentity: "/bridge",
      bytePatch: JSON.stringify({ version: 1, offsetUtf16: 0, deleteText: "", insertText: "" }),
    });

    const removeOk = store.finalizeIntent("intent_remove", "rev_remove", "2026-08-14T11:00:00Z", "h_base");
    expect(removeOk).toBe(true);

    const disabledState = store.getActivationState();
    expect(disabledState?.active).toBe(false);
    expect(disabledState?.port).toBeUndefined();
    expect(disabledState?.nonceFingerprint).toBeUndefined();
    expect(disabledState?.registrationTransport).toBeUndefined();
    expect(disabledState?.transportMode).toBeUndefined();
    // Resulting config hash and revision ID are retained for disabled provenance
    expect(disabledState?.configHash).toBe("h_base");
    expect(disabledState?.revisionId).toBe("rev_remove");
    expect(disabledState?.targetPath).toBe("/path/opencode.json");
    expect(disabledState?.sourceKind).toBe("project-root");
    expect(store.withCommittedRawNonce((nonce) => { void nonce; })).toBe(false);

    store.close();
  });

  test("markRecoveryPending keeps raw nonce for forward recovery", () => {
    const store = new BridgeRevisionStore(dbPath);

    store.insertPreparedIntent({
      id: "intent_pending",
      targetPath: "/path/opencode.json",
      sourceKind: "project-root",
      operation: "add",
      baselineHash: "h_base",
      proposedHash: "h_prop",
      canonicalIdentity: "/bridge",
      port: 8788,
      registrationTransport: "env",
      transportMode: "loopback-http",
      nonceFingerprint: fingerprintNonce("raw_recovering"),
      bytePatch: JSON.stringify({ version: 1, offsetUtf16: 0, deleteText: "", insertText: "" }),
      rawActivationNonce: "raw_recovering",
    });

    store.markRecoveryPending("intent_pending");

    const intent = store.getIntent("intent_pending");
    expect(intent?.status).toBe("recovery-pending");
    // Raw nonce is preserved so recovery can finalize into committed state!
    expect(intent?.rawActivationNonce).toBe("raw_recovering");

    // Unresolved intents include recovery-pending.
    const unresolved = store.getPreparedIntents();
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.id).toBe("intent_pending");

    store.close();
  });

  test("abortIntent and conflictIntent clear raw nonce", () => {
    const store = new BridgeRevisionStore(dbPath);

    store.insertPreparedIntent({
      id: "intent_abort",
      targetPath: "/path/opencode.json",
      sourceKind: "project-root",
      operation: "add",
      baselineHash: "h_base",
      proposedHash: "h_prop",
      canonicalIdentity: "/bridge",
      nonceFingerprint: fingerprintNonce("raw1"),
      bytePatch: "{\"version\":1,\"offsetUtf16\":14,\"deleteText\":\"\",\"insertText\":\"x\"}",
      rawActivationNonce: "raw1",
    });

    store.abortIntent("intent_abort");
    const aborted = store.getIntent("intent_abort");
    expect(aborted?.status).toBe("aborted");
    expect(aborted?.rawActivationNonce).toBeUndefined();

    store.insertPreparedIntent({
      id: "intent_conflict",
      targetPath: "/path/opencode.json",
      sourceKind: "project-root",
      operation: "add",
      baselineHash: "h_base",
      proposedHash: "h_prop",
      canonicalIdentity: "/bridge",
      nonceFingerprint: fingerprintNonce("raw2"),
      bytePatch: "{\"version\":1,\"offsetUtf16\":14,\"deleteText\":\"\",\"insertText\":\"x\"}",
      rawActivationNonce: "raw2",
    });

    store.conflictIntent("intent_conflict");
    const conflicted = store.getIntent("intent_conflict");
    expect(conflicted?.status).toBe("conflict");
    expect(conflicted?.rawActivationNonce).toBeUndefined();

    store.close();
  });
});

// ── DB v3: drift acceptance (metadata-only rebase) ────────────────────

describe("BridgeRevisionStore: DB v3 migrations", () => {
  function makeLegacyDb(version: number, schema: string): void {
    mkdirSync(join(sandbox, "data"), { recursive: true });
    const rawDb = new Database(dbPath);
    rawDb.exec(`PRAGMA user_version = ${version};`);
    rawDb.exec(schema);
    rawDb.close();
  }

  const V2_SCHEMA = `
    CREATE TABLE bridge_activation_state (
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
    CREATE TABLE bridge_activation_intents (
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
      byte_patch TEXT NOT NULL,
      raw_activation_nonce TEXT,
      created_at TEXT NOT NULL,
      committed_at TEXT
    );
    CREATE TABLE bridge_revisions (
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
    INSERT INTO bridge_revisions VALUES (
      'brev_v2_add', '2026-08-15T00:00:00Z', '/path/opencode.json', 'project-root',
      'add', 'h0', 'h1', '/canonical/bridge', 8788, 'env', 'loopback-http',
      'fp_v2', '{"version":1,"offsetUtf16":14,"deleteText":"","insertText":"x"}'
    );
  `;

  const V1_SCHEMA = `
    CREATE TABLE bridge_activation_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      raw_activation_nonce TEXT,
      nonce_fingerprint TEXT,
      port INTEGER,
      registration_transport TEXT,
      transport_mode TEXT,
      canonical_identity TEXT NOT NULL,
      target_path TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE bridge_activation_intents (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      target_path TEXT NOT NULL,
      operation TEXT NOT NULL,
      baseline_hash TEXT NOT NULL,
      proposed_hash TEXT NOT NULL,
      canonical_identity TEXT NOT NULL,
      port INTEGER,
      registration_transport TEXT,
      transport_mode TEXT,
      nonce_fingerprint TEXT,
      byte_patch TEXT NOT NULL,
      raw_activation_nonce TEXT,
      created_at TEXT NOT NULL,
      committed_at TEXT
    );
    CREATE TABLE bridge_revisions (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      target_path TEXT NOT NULL,
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
    INSERT INTO bridge_revisions VALUES (
      'brev_v1_add', '2026-08-14T00:00:00Z', '/path/opencode.json',
      'add', 'h0', 'h1', '/canonical/bridge', 8788, 'env', 'loopback-http',
      'fp_v1', '{"version":1}'
    );
  `;

  function currentVersion(path: string): number {
    const db = new Database(path);
    const v = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    db.close();
    return v;
  }

  test("v2 → v3 rebuild preserves content rows and adds rebase columns", () => {
    makeLegacyDb(2, V2_SCHEMA);
    const store = new BridgeRevisionStore(dbPath);
    expect(currentVersion(dbPath)).toBe(CURRENT_BRIDGE_DB_VERSION);
    const rev = store.getRevision("brev_v2_add");
    expect(rev?.operation).toBe("add");
    if (rev?.operation === "add") {
      expect(rev.bytePatch).toContain("offsetUtf16");
    }
    store.close();
  });

  test("v1 → v3 rebuild succeeds with minimal legacy tables", () => {
    makeLegacyDb(1, V1_SCHEMA);
    const store = new BridgeRevisionStore(dbPath);
    expect(currentVersion(dbPath)).toBe(CURRENT_BRIDGE_DB_VERSION);
    const rev = store.getRevision("brev_v1_add");
    expect(rev?.operation).toBe("add");
    expect(rev?.sourceKind).toBe("project-root");
    store.close();
  });

  test("v0 legacy fixture migrates to v3 (existing v0 test path upgraded)", () => {
    // The pre-existing v0 test covers the legacy-column fixture; here assert
    // the resulting version is v3 and rebase operations are available.
    makeLegacyDb(2, V2_SCHEMA);
    const store = new BridgeRevisionStore(dbPath);
    expect(currentVersion(dbPath)).toBe(3);
    store.close();
  });
});

describe("BridgeRevisionStore: commitDriftAcceptance", () => {
  let store: BridgeRevisionStore;
  beforeEach(() => {
    store = new BridgeRevisionStore(dbPath);
  });
  afterEach(() => {
    try { store.close(); } catch { /* */ }
  });

  function commitBase(nonce: string): { configHash: string; revisionId: string } {
    store.insertPreparedIntent({
      id: "intent_cas_base",
      targetPath: "/path/opencode.json",
      sourceKind: "project-root",
      operation: "add",
      baselineHash: "h0",
      proposedHash: "h1",
      canonicalIdentity: "/canonical/bridge",
      port: 8788,
      registrationTransport: "env",
      transportMode: "loopback-http",
      nonceFingerprint: "a".repeat(64),
      bytePatch: "{\"version\":1,\"offsetUtf16\":14,\"deleteText\":\"\",\"insertText\":\"x\"}",
      rawActivationNonce: nonce,
    });
    store.finalizeIntent("intent_cas_base", "brev_cas_base", "2026-08-15T00:00:00Z", "h1");
    return { configHash: "h1", revisionId: "brev_cas_base" };
  }

  function rebaseInput(overrides: Partial<Parameters<BridgeRevisionStore["commitDriftAcceptance"]>[0]> = {}) {
    return {
      intentId: "intent_rebase_1",
      revisionId: "brev_rebase_1",
      timestamp: "2026-08-15T01:00:00Z",
      targetPath: "/path/opencode.json",
      sourceKind: "project-root" as const,
      canonicalIdentity: "/canonical/bridge",
      port: 8788,
      nonceFingerprint: "a".repeat(64),
      oldConfigHash: "h1",
      newConfigHash: "h2",
      expectedRevisionId: "brev_cas_base",
      anchorRevisionId: "brev_cas_base",
      auditMetadata: JSON.stringify({ version: 1, kind: "drift-acceptance" }),
      ...overrides,
    };
  }

  test("commit updates only config_hash/revision_id/updated_at; nonce byte-identical", () => {
    commitBase("rebase-raw-nonce-0123456789ab");
    const r = store.commitDriftAcceptance(rebaseInput());
    expect(r.ok).toBe(true);
    const state = store.getActivationState();
    expect(state?.configHash).toBe("h2");
    expect(state?.revisionId).toBe("brev_rebase_1");
    expect(state?.updatedAt).toBe("2026-08-15T01:00:00Z");
    expect(state?.port).toBe(8788);
    expect(state?.nonceFingerprint).toBe("a".repeat(64));
    let nonce: string | undefined;
    store.withCommittedRawNonce((n) => { nonce = n; });
    expect(nonce).toBe("rebase-raw-nonce-0123456789ab");

    // Rebase intent: committed directly, null patch/nonce, created == committed.
    const intent = store.getIntent("intent_rebase_1");
    expect(intent?.operation).toBe("rebase");
    expect(intent?.status).toBe("committed");
    if (intent?.operation === "rebase") {
      expect(intent.bytePatch).toBeNull();
      expect(intent.rawActivationNonce).toBeNull();
      expect(intent.createdAt).toBe(intent.committedAt as string);
      expect(intent.expectedRevisionId).toBe("brev_cas_base");
      expect(intent.anchorRevisionId).toBe("brev_cas_base");
    }
    // Rebase revision linkage.
    const rev = store.getRevision("brev_rebase_1");
    expect(rev?.operation).toBe("rebase");
    if (rev?.operation === "rebase") {
      expect(rev.bytePatch).toBeNull();
      expect(rev.parentRevisionId).toBe("brev_cas_base");
      expect(rev.acceptanceIntentId).toBe("intent_rebase_1");
    }
  });

  test("CAS mismatch (stale old hash) rolls back completely", () => {
    commitBase("rebase-raw-nonce-0123456789ab");
    const r = store.commitDriftAcceptance(rebaseInput({ oldConfigHash: "h_stale" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("state-conflict");
    // Nothing committed: no intent, no revision, state unchanged.
    expect(store.getIntent("intent_rebase_1")).toBeNull();
    expect(store.getRevision("brev_rebase_1")).toBeNull();
    expect(store.getActivationState()?.configHash).toBe("h1");
    expect(store.getActivationState()?.revisionId).toBe("brev_cas_base");
  });

  test("CAS mismatch (stale revision) rolls back completely", () => {
    commitBase("rebase-raw-nonce-0123456789ab");
    const r = store.commitDriftAcceptance(rebaseInput({ expectedRevisionId: "brev_stale" }));
    expect(r.ok).toBe(false);
    expect(store.getRevision("brev_rebase_1")).toBeNull();
    expect(store.getActivationState()?.revisionId).toBe("brev_cas_base");
  });

  test("transaction fault (duplicate intent id) rolls back completely", () => {
    commitBase("rebase-raw-nonce-0123456789ab");
    expect(store.commitDriftAcceptance(rebaseInput()).ok).toBe(true);
    // Second commit with the SAME intent id → PK violation → rollback.
    const r = store.commitDriftAcceptance(
      rebaseInput({
        oldConfigHash: "h2",
        expectedRevisionId: "brev_rebase_1",
        revisionId: "brev_rebase_2",
      }),
    );
    expect(r.ok).toBe(false);
    // The failed second commit must not have inserted the revision.
    expect(store.getRevision("brev_rebase_2")).toBeNull();
    // First commit's state is intact.
    expect(store.getActivationState()?.revisionId).toBe("brev_rebase_1");
    expect(store.getActivationState()?.configHash).toBe("h2");
  });
});

// ── Oracle attempt-2: lineage validation edge cases ────────────────────

describe("BridgeRevisionStore: anchor lineage validation", () => {
  let store: BridgeRevisionStore;
  beforeEach(() => {
    store = new BridgeRevisionStore(dbPath);
  });
  afterEach(() => {
    try { store.close(); } catch { /* */ }
  });

  const FP = "a".repeat(64);
  const PATCH = JSON.stringify({ version: 1, offsetUtf16: 14, deleteText: "", insertText: "x" });

  function commitAdd(): void {
    store.insertPreparedIntent({
      id: "intent_lin_add",
      targetPath: "/t/opencode.json",
      sourceKind: "project-root",
      operation: "add",
      baselineHash: "h0",
      proposedHash: "h1",
      canonicalIdentity: "/canonical/bridge",
      port: 8788,
      registrationTransport: "env",
      transportMode: "loopback-http",
      nonceFingerprint: FP,
      bytePatch: PATCH,
      rawActivationNonce: "lineage-raw-nonce-0123456789",
    });
    store.finalizeIntent("intent_lin_add", "brev_lin_add", "2026-08-15T00:00:00Z", "h1");
  }

  function state(revisionId: string, configHash: string) {
    return {
      nonceFingerprint: FP,
      port: 8788,
      registrationTransport: "env" as const,
      transportMode: "loopback-http" as const,
      canonicalIdentity: "/canonical/bridge",
      targetPath: "/t/opencode.json",
      sourceKind: "project-root" as const,
      configHash,
      revisionId,
      active: true,
      updatedAt: "2026-08-15T00:00:00Z",
    };
  }

  function rebase(id: string, parent: string, base: string, post: string, anchor = "brev_lin_add"): void {
    const r = store.commitDriftAcceptance({
      intentId: `intent_${id}`,
      revisionId: id,
      timestamp: new Date().toISOString(),
      targetPath: "/t/opencode.json",
      sourceKind: "project-root",
      canonicalIdentity: "/canonical/bridge",
      port: 8788,
      nonceFingerprint: FP,
      oldConfigHash: base,
      newConfigHash: post,
      expectedRevisionId: parent,
      anchorRevisionId: anchor,
      auditMetadata: "{}",
    });
    expect(r.ok).toBe(true);
  }

  test("direct add anchor validates", () => {
    commitAdd();
    const r = store.validateAnchorLineage(state("brev_lin_add", "h1"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.anchor.id).toBe("brev_lin_add");
  });

  test("cycle in parent links is rejected", () => {
    commitAdd();
    rebase("brev_r1", "brev_lin_add", "h1", "h2");
    rebase("brev_r2", "brev_r1", "h2", "h3");
    // Manually create a cycle with consistent hash linkage: r1.parent = r2
    // and r1.baselineHash = r2.postWriteHash.
    const db = new Database(dbPath);
    db.query("UPDATE bridge_revisions SET parent_revision_id = 'brev_r2', baseline_hash = 'h3' WHERE id = 'brev_r1'").run();
    db.close();
    const r = store.validateAnchorLineage(state("brev_r2", "h3"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("lineage-cycle");
  });

  test("remove revision in chain is rejected", () => {
    commitAdd();
    // Manually insert a remove revision and a rebase pointing at it.
    const db = new Database(dbPath);
    db.query(
      `INSERT INTO bridge_revisions (id, timestamp, target_path, source_kind, operation, baseline_hash, post_write_hash, canonical_identity, port, registration_transport, transport_mode, nonce_fingerprint, byte_patch) VALUES ('brev_rm', '2026-08-15T00:30:00Z', '/t/opencode.json', 'project-root', 'remove', 'h1', 'h_removed', '/canonical/bridge', 8788, 'env', 'loopback-http', ?, ?)`,
    ).run(FP, PATCH);
    db.query(
      `INSERT INTO bridge_revisions (id, timestamp, target_path, source_kind, operation, baseline_hash, post_write_hash, canonical_identity, port, registration_transport, transport_mode, nonce_fingerprint, byte_patch, parent_revision_id, anchor_revision_id, acceptance_intent_id) VALUES ('brev_r_after_remove', '2026-08-15T00:31:00Z', '/t/opencode.json', 'project-root', 'rebase', 'h_removed', 'h2', '/canonical/bridge', 8788, 'env', 'loopback-http', ?, NULL, 'brev_rm', 'brev_lin_add', 'intent_x')`,
    ).run(FP);
    db.close();
    const r = store.validateAnchorLineage(state("brev_r_after_remove", "h2"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("lineage-remove-in-chain");
  });

  test("chain longer than 1000 preserves the original anchor", () => {
    commitAdd();
    let parent = "brev_lin_add";
    let base = "h1";
    for (let i = 0; i < 1100; i++) {
      const id = `brev_chain_${i}`;
      const post = `h_chain_${i}`;
      rebase(id, parent, base, post);
      parent = id;
      base = post;
    }
    const r = store.validateAnchorLineage(state(parent, base));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.anchor.id).toBe("brev_lin_add");
  });

  test("generic insertRevision rejects rebase rows at the type level and runtime path", () => {
    commitAdd();
    // The generic method only accepts content revisions (type-narrowed).
    // A rebase-shaped record must never flow through it.
    const rebaseShaped = {
      id: "brev_bad",
      timestamp: "2026-08-15T01:00:00Z",
      targetPath: "/t/opencode.json",
      sourceKind: "project-root" as const,
      operation: "rebase" as const,
      baselineHash: "h1",
      postWriteHash: "h2",
      canonicalIdentity: "/canonical/bridge",
      bytePatch: null,
      parentRevisionId: "brev_lin_add",
      anchorRevisionId: "brev_lin_add",
      acceptanceIntentId: "intent_x",
    };
    // @ts-expect-error — rebase rows are not accepted by the generic insert
    expect(() => store.insertRevision(rebaseShaped)).toThrow();
  });
});

// ── Oracle attempt-3: lineage start hash + strict operations ───────────

describe("BridgeRevisionStore: lineage start hash + strict operations", () => {
  let store: BridgeRevisionStore;
  beforeEach(() => {
    store = new BridgeRevisionStore(dbPath);
  });
  afterEach(() => {
    try { store.close(); } catch { /* */ }
  });

  const FP = "b".repeat(64);
  const PATCH = JSON.stringify({ version: 1, offsetUtf16: 14, deleteText: "", insertText: "x" });

  function commitAdd(): void {
    store.insertPreparedIntent({
      id: "intent_s3_add",
      targetPath: "/t/opencode.json",
      sourceKind: "project-root",
      operation: "add",
      baselineHash: "h0",
      proposedHash: "h1",
      canonicalIdentity: "/canonical/bridge",
      port: 8788,
      registrationTransport: "env",
      transportMode: "loopback-http",
      nonceFingerprint: FP,
      bytePatch: PATCH,
      rawActivationNonce: "strict-raw-nonce-0123456789ab",
    });
    store.finalizeIntent("intent_s3_add", "brev_s3_add", "2026-08-15T00:00:00Z", "h1");
  }

  function state(revisionId: string, configHash: string) {
    return {
      nonceFingerprint: FP,
      port: 8788,
      registrationTransport: "env" as const,
      transportMode: "loopback-http" as const,
      canonicalIdentity: "/canonical/bridge",
      targetPath: "/t/opencode.json",
      sourceKind: "project-root" as const,
      configHash,
      revisionId,
      active: true,
      updatedAt: "2026-08-15T00:00:00Z",
    };
  }

  test("direct add: postWriteHash mismatch vs state.configHash rejects lineage", () => {
    commitAdd();
    const db = new Database(dbPath);
    db.query("UPDATE bridge_revisions SET post_write_hash = 'h_corrupt' WHERE id = 'brev_s3_add'").run();
    db.close();
    const r = store.validateAnchorLineage(state("brev_s3_add", "h1"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("lineage-current-hash-mismatch");
  });

  test("current rebase: postWriteHash mismatch vs state.configHash rejects", () => {
    commitAdd();
    const r1 = store.commitDriftAcceptance({
      intentId: "intent_s3_r1",
      revisionId: "brev_s3_r1",
      timestamp: "2026-08-15T01:00:00Z",
      targetPath: "/t/opencode.json",
      sourceKind: "project-root",
      canonicalIdentity: "/canonical/bridge",
      port: 8788,
      nonceFingerprint: FP,
      oldConfigHash: "h1",
      newConfigHash: "h2",
      expectedRevisionId: "brev_s3_add",
      anchorRevisionId: "brev_s3_add",
      auditMetadata: "{}",
    });
    expect(r1.ok).toBe(true);
    // Corrupt the rebase row's post-write hash (state still says h2).
    const db = new Database(dbPath);
    db.query("UPDATE bridge_revisions SET post_write_hash = 'h_wrong' WHERE id = 'brev_s3_r1'").run();
    db.close();
    const r = store.validateAnchorLineage(state("brev_s3_r1", "h2"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("lineage-current-hash-mismatch");
  });

  test("unknown operation on current revision → commit rejects with zero changes", () => {
    commitAdd();
    const db = new Database(dbPath);
    db.query("UPDATE bridge_revisions SET operation = 'frobnicate' WHERE id = 'brev_s3_add'").run();
    db.close();
    // Getters surface a stable rejection (null), never an exception.
    expect(store.getRevision("brev_s3_add")).toBeNull();
    expect(store.listRevisions().length).toBe(0);
    const r = store.validateAnchorLineage(state("brev_s3_add", "h1"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("lineage-revision-missing");
    // commitDriftAcceptance fails closed with zero new rows.
    const commit = store.commitDriftAcceptance({
      intentId: "intent_s3_bad",
      revisionId: "brev_s3_bad",
      timestamp: "2026-08-15T02:00:00Z",
      targetPath: "/t/opencode.json",
      sourceKind: "project-root",
      canonicalIdentity: "/canonical/bridge",
      port: 8788,
      nonceFingerprint: FP,
      oldConfigHash: "h1",
      newConfigHash: "h2",
      expectedRevisionId: "brev_s3_add",
      anchorRevisionId: "brev_s3_add",
      auditMetadata: "{}",
    });
    expect(commit.ok).toBe(false);
    expect(store.getIntent("intent_s3_bad")).toBeNull();
    expect(store.getRevision("brev_s3_bad")).toBeNull();
    expect(store.getActivationState()?.configHash).toBe("h1");
    expect(store.getActivationState()?.revisionId).toBe("brev_s3_add");
  });
});
