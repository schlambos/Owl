/**
 * Slice 18 D1 — pre-Slice-18 database-shape fixture + pending recovery.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashContent } from "./jsonc-edit";
import { RevisionStore } from "./revisions";
import {
  ensureRecoveredOmoScope,
  previewThenCommit,
} from "./transaction";
import { produceGlobalCandidate } from "./globals";
import { fingerprintAuthorizedSource } from "../omo-schema/fingerprint";

const ROOT = join(import.meta.dir, "../../test/revision-migration-sandbox");

function installSchema(userDir: string): void {
  const dir = join(userDir, "node_modules", "oh-my-opencode-slim");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.0.0-test" }));
  writeFileSync(
    join(dir, "oh-my-opencode-slim.schema.json"),
    JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" }),
  );
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("RevisionStore open-path migration", () => {
  test("pre-Slice-18 columns/defaults/index/backfill", () => {
    const dbPath = join(ROOT, "legacy.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE config_revisions (
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
    `);
    db.query(
      `INSERT INTO config_revisions (
        id, timestamp, target_path, scope, old_hash, new_hash,
        mutation_kind, mutation_json, before_content, after_content
      ) VALUES (
        'legacy-1', '2026-01-01T00:00:00.000Z', '/tmp/x.json', 'user',
        'aaa', 'bbb', 'agent-model', '{}', '{}', '{}'
      )`,
    ).run();
    db.close();

    const store = new RevisionStore(dbPath);
    expect(store.available).toBe(true);
    const migrated = new Database(dbPath);
    const cols = migrated
      .query(`PRAGMA table_info(config_revisions)`)
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    for (const required of [
      "state",
      "prepared_at",
      "committed_at",
      "recovery_note",
      "before_exists",
      "after_exists",
      "target_format",
      "schema_package_version",
      "schema_hash",
    ]) {
      expect(names).toContain(required);
    }
    const indexes = migrated
      .query(`PRAGMA index_list(config_revisions)`)
      .all() as Array<{ name: string }>;
    expect(indexes.some((i) => i.name === "idx_rev_state_target")).toBe(true);
    migrated.close();

    const rev = store.get("legacy-1");
    expect(rev?.state).toBe("committed");
    expect(rev?.beforeExists).toBe(true);
    expect(rev?.afterExists).toBe(true);
    expect(store.list().map((r) => r.id)).toContain("legacy-1");
  });

  test("pending recovery: new_hash match commits without retry", () => {
    const userDir = join(ROOT, "cfg");
    const projDir = join(ROOT, "proj");
    mkdirSync(userDir, { recursive: true });
    mkdirSync(join(projDir, "data"), { recursive: true });
    installSchema(userDir);
    const userFile = join(userDir, "oh-my-opencode-slim.jsonc");
    const after = `{\n  "compactSidebar": false\n}\n`;
    writeFileSync(userFile, after);
    const cfg = {
      host: "127.0.0.1",
      port: 0,
      opencodeConfigDir: userDir,
      projectDirectory: projDir,
      authorizedRoots: [userDir, projDir, ROOT],
    };
    const store = new RevisionStore(join(projDir, "data", "test.db"));
    store.preparePending({
      id: "pending-match",
      timestamp: new Date().toISOString(),
      targetPath: userFile,
      scope: "user",
      oldHash: "old",
      newHash: hashContent(after),
      mutationKind: "global-settings",
      mutationJson: "{}",
      beforeContent: "{}",
      afterContent: after,
      state: "pending",
      beforeExists: true,
      afterExists: true,
    });
    const outcomes = store.recoverPendingOmo(cfg as never, "user");
    expect(outcomes[0]?.action).toBe("committed");
    expect(store.get("pending-match")?.state).toBe("committed");
  });

  test("pending recovery: old_hash match abandons; other state conflicts and blocks", () => {
    const userDir = join(ROOT, "cfg2");
    const projDir = join(ROOT, "proj2");
    mkdirSync(userDir, { recursive: true });
    mkdirSync(join(projDir, "data"), { recursive: true });
    installSchema(userDir);
    const userFile = join(userDir, "oh-my-opencode-slim.jsonc");
    const current = `{\n  "compactSidebar": true\n}\n`;
    writeFileSync(userFile, current);
    const cfg = {
      host: "127.0.0.1",
      port: 0,
      opencodeConfigDir: userDir,
      projectDirectory: projDir,
      authorizedRoots: [userDir, projDir, ROOT],
    };
    const store = new RevisionStore(join(projDir, "data", "test.db"));
    store.preparePending({
      id: "pending-old",
      timestamp: new Date().toISOString(),
      targetPath: userFile,
      scope: "user",
      oldHash: hashContent(current),
      newHash: "new",
      mutationKind: "global-settings",
      mutationJson: "{}",
      beforeContent: current,
      afterContent: "{}",
      state: "pending",
      beforeExists: true,
      afterExists: true,
    });
    expect(store.recoverPendingOmo(cfg as never, "user")[0]?.action).toBe("abandoned");

    store.preparePending({
      id: "pending-divergent",
      timestamp: new Date().toISOString(),
      targetPath: userFile,
      scope: "user",
      oldHash: "aaa",
      newHash: "bbb",
      mutationKind: "global-settings",
      mutationJson: "{}",
      beforeContent: "{}",
      afterContent: "{}",
      state: "pending",
      beforeExists: true,
      afterExists: true,
    });
    expect(store.recoverPendingOmo(cfg as never, "user")[0]?.action).toBe("conflict");
    expect(store.isScopeWriteBlocked(cfg as never, "user")).toBe(true);
  });

  test("post-rename pending finalizes on later recovery without retry", () => {
    const userDir = join(ROOT, "cfg3");
    const projDir = join(ROOT, "proj3");
    mkdirSync(userDir, { recursive: true });
    mkdirSync(join(projDir, "data"), { recursive: true });
    installSchema(userDir);
    const userFile = join(userDir, "oh-my-opencode-slim.jsonc");
    writeFileSync(userFile, `{\n  "compactSidebar": true\n}\n`);
    const cfg = {
      host: "127.0.0.1",
      port: 0,
      opencodeConfigDir: userDir,
      projectDirectory: projDir,
      authorizedRoots: [userDir, projDir, ROOT],
    };
    const store = new RevisionStore(join(projDir, "data", "test.db"));
    const live = fingerprintAuthorizedSource(cfg as never, "user", 0);
    const commit = previewThenCommit(
      {
        cfg: cfg as never,
        revisions: store,
        hooks: { failMarkCommitted: true },
      },
      {
        scope: "user",
        expectedSource: live,
        input: {
          kind: "global-settings",
          scope: "user",
          compactSidebar: { operation: "set", value: false },
        },
      },
      produceGlobalCandidate,
    );
    expect(commit.status).toBe(503);
    expect(commit.revisionId).toBeTruthy();
    expect(store.get(commit.revisionId!)?.state).toBe("pending");
    ensureRecoveredOmoScope({ cfg: cfg as never, revisions: store }, "user");
    expect(store.get(commit.revisionId!)?.state).toBe("committed");
  });
});
