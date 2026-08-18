/**
 * Slice 18 D1 — transaction preview/commit/recovery evidence.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { applyMutation, restoreRevision, simulateMutation } from "./mutate";
import { applyGlobal, produceGlobalCandidate } from "./globals";
import { RevisionStore } from "./revisions";
import {
  commitOmoCandidate,
  commitOmoRevisionRestore,
  previewOmoCandidate,
  previewThenCommit,
  type OmoTransactionDeps,
} from "./transaction";
import { hashContent } from "./jsonc-edit";
import { MAX_OMO_CANDIDATE_BYTES } from "@omo/shared";
import { fingerprintAuthorizedSource } from "../omo-schema/fingerprint";

const ROOT = join(import.meta.dir, "../../test/transaction-sandbox");

function installSchema(userDir: string, extra: Record<string, unknown> = {}): void {
  const dir = join(userDir, "node_modules", "oh-my-opencode-slim");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.0.0-test" }));
  writeFileSync(
    join(dir, "oh-my-opencode-slim.schema.json"),
    JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: true,
      ...extra,
    }),
  );
}

function sandbox(opts?: { schema?: boolean; jsonc?: boolean }) {
  rmSync(ROOT, { recursive: true, force: true });
  const userDir = join(ROOT, "cfg");
  const projDir = join(ROOT, "proj");
  mkdirSync(userDir, { recursive: true });
  mkdirSync(projDir, { recursive: true });
  mkdirSync(join(projDir, "data"), { recursive: true });
  if (opts?.schema !== false) installSchema(userDir);
  const userFile = join(
    userDir,
    opts?.jsonc === false ? "oh-my-opencode-slim.json" : "oh-my-opencode-slim.jsonc",
  );
  const text =
    opts?.jsonc === false
      ? `{"compactSidebar":true,"companion":{"enabled":false}}\n`
      : `{\n  // keep\n  "compactSidebar": true,\n  "companion": { "enabled": false }\n}\n`;
  writeFileSync(userFile, text);
  const cfg = {
    host: "127.0.0.1",
    port: 0,
    opencodeConfigDir: userDir,
    projectDirectory: projDir,
    authorizedRoots: [userDir, projDir, ROOT],
  };
  const revisions = new RevisionStore(join(projDir, "data", "test.db"));
  return { cfg: cfg as never, revisions, userDir, projDir, userFile };
}

function deps(s: ReturnType<typeof sandbox>, hooks?: OmoTransactionDeps["hooks"]): OmoTransactionDeps {
  return { cfg: s.cfg, revisions: s.revisions, hooks };
}

const setSidebar = {
  kind: "global-settings" as const,
  scope: "user" as const,
  compactSidebar: { operation: "set" as const, value: false },
};

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("transaction preview is no-write", () => {
  test("Preview creates no source/temp/dir/revision", () => {
    const s = sandbox();
    const before = readFileSync(s.userFile, "utf-8");
    const live = fingerprintAuthorizedSource(s.cfg, "user", 0);
    const preview = previewOmoCandidate(
      deps(s),
      { scope: "user", expectedSource: live, input: setSidebar },
      produceGlobalCandidate,
    );
    expect(preview.ok).toBe(true);
    expect(readFileSync(s.userFile, "utf-8")).toBe(before);
    expect(existsSync(join(s.projDir, "data", "sim"))).toBe(false);
    expect(s.revisions.list().length).toBe(0);
  });

  test("missing project source is not created in Preview", () => {
    const s = sandbox();
    const live = fingerprintAuthorizedSource(s.cfg, "project", 0);
    expect(live.exists).toBe(false);
    const preview = previewOmoCandidate(
      deps(s),
      {
        scope: "project",
        expectedSource: live,
        input: { ...setSidebar, scope: "project" },
      },
      produceGlobalCandidate,
    );
    expect(preview.ok).toBe(true);
    expect(preview.target.exists).toBe(false);
    expect(existsSync(join(s.projDir, ".opencode"))).toBe(false);
  });
});

describe("transaction apply gates", () => {
  test("stale Preview/Apply is 409 and original bytes unchanged", async () => {
    const s = sandbox();
    const live = fingerprintAuthorizedSource(s.cfg, "user", 0);
    const stale = { ...live, sha256: "deadbeef" };
    const preview = previewOmoCandidate(
      deps(s),
      { scope: "user", expectedSource: stale, input: setSidebar },
      produceGlobalCandidate,
    );
    expect(preview.ok).toBe(false);
    expect(preview.code).toBe("stale-source");
    const before = readFileSync(s.userFile, "utf-8");
    const commit = previewThenCommit(
      deps(s),
      { scope: "user", expectedSource: stale, input: setSidebar },
      produceGlobalCandidate,
    );
    expect(commit.status).toBe(409);
    expect(readFileSync(s.userFile, "utf-8")).toBe(before);
  });

  test("schema unavailable/invalid never reaches temp", async () => {
    const s = sandbox({ schema: false });
    const live = fingerprintAuthorizedSource(s.cfg, "user", 0);
    let tempSeen = false;
    const commit = previewThenCommit(
      deps(s, {
        afterTempWrite() {
          tempSeen = true;
        },
      }),
      { scope: "user", expectedSource: live, input: setSidebar },
      produceGlobalCandidate,
    );
    expect(commit.ok).toBe(false);
    expect(commit.code).toBe("schema-unavailable");
    expect(tempSeen).toBe(false);
    expect(s.revisions.list().length).toBe(0);
  });

  test("temp mismatch preserves original bytes", async () => {
    const s = sandbox();
    const live = fingerprintAuthorizedSource(s.cfg, "user", 0);
    const before = readFileSync(s.userFile, "utf-8");
    const commit = previewThenCommit(
      deps(s, {
        afterTempWrite(tmp) {
          writeFileSync(tmp, "{}\n");
        },
      }),
      { scope: "user", expectedSource: live, input: setSidebar },
      produceGlobalCandidate,
    );
    expect(commit.ok).toBe(false);
    expect(readFileSync(s.userFile, "utf-8")).toBe(before);
    expect(s.revisions.list().every((r) => r.state !== "committed" || r.mutationKind !== "global-settings")).toBe(true);
  });

  test("rename failure preserves original bytes", async () => {
    const s = sandbox();
    const live = fingerprintAuthorizedSource(s.cfg, "user", 0);
    const before = readFileSync(s.userFile, "utf-8");
    const commit = previewThenCommit(
      deps(s, {
        beforeRename(tmp) {
          rmSync(tmp, { force: true });
        },
      }),
      { scope: "user", expectedSource: live, input: setSidebar },
      produceGlobalCandidate,
    );
    expect(commit.ok).toBe(false);
    expect(readFileSync(s.userFile, "utf-8")).toBe(before);
  });

  test("JSONC comments and format preserved; exact-byte restore", () => {
    const s = sandbox();
    const before = readFileSync(s.userFile, "utf-8");
    const r = applyGlobal(s.cfg, { ...setSidebar, expectedSourceHash: hashContent(before) }, s.revisions);
    expect(r.ok).toBe(true);
    const after = readFileSync(s.userFile, "utf-8");
    expect(after).toContain("// keep");
    const restored = restoreRevision(
      s.cfg,
      r.revisionId!,
      s.revisions,
      hashContent(after),
    );
    expect(restored.ok).toBe(true);
    expect(readFileSync(s.userFile, "utf-8")).toBe(before);
  });

  test("strict JSON format preserved", () => {
    const s = sandbox({ jsonc: false });
    const before = readFileSync(s.userFile, "utf-8");
    const r = applyGlobal(
      s.cfg,
      { ...setSidebar, expectedSourceHash: hashContent(before) },
      s.revisions,
    );
    expect(r.ok).toBe(true);
    const after = readFileSync(s.userFile, "utf-8");
    expect(after.includes("//")).toBe(false);
    expect(s.userFile.endsWith(".json")).toBe(true);
  });

  test("candidate oversize cannot commit", async () => {
    const s = sandbox();
    const live = fingerprintAuthorizedSource(s.cfg, "user", 0);
    const producer = () => ({
      candidateText: "x".repeat(MAX_OMO_CANDIDATE_BYTES + 1),
      featureErrors: [] as string[],
      featureWarnings: [] as string[],
      intent: {
        kind: "raw",
        summary: "huge",
        propertyPaths: [],
        mutationJson: "{}",
      },
    });
    const commit = previewThenCommit(
      deps(s),
      { scope: "user", expectedSource: live, input: setSidebar },
      producer,
    );
    expect(commit.ok).toBe(false);
    expect(commit.code).toBe("oversize");
  });

  test("Companion mutation rejected before temp/revision", async () => {
    const s = sandbox();
    const live = fingerprintAuthorizedSource(s.cfg, "user", 0);
    let tempSeen = false;
    const commit = previewThenCommit(
      deps(s, {
        afterTempWrite() {
          tempSeen = true;
        },
      }),
      { scope: "user", expectedSource: live, input: {} },
      () => ({
        candidateText: `{\n  "companion": { "enabled": true }\n}\n`,
        featureErrors: [],
        featureWarnings: [],
        intent: {
          kind: "raw",
          summary: "companion",
          propertyPaths: ["companion.enabled"],
          mutationJson: "{}",
        },
      }),
    );
    expect(commit.ok).toBe(false);
    expect(commit.code).toBe("companion-read-only");
    expect(tempSeen).toBe(false);
    expect(s.revisions.list().length).toBe(0);
  });

  test("invalid sibling source does not block selected-source repair", () => {
    const s = sandbox();
    mkdirSync(join(s.projDir, ".opencode"), { recursive: true });
    writeFileSync(
      join(s.projDir, ".opencode", "oh-my-opencode-slim.json"),
      "{ not-json",
    );
    const before = readFileSync(s.userFile, "utf-8");
    const r = applyGlobal(
      s.cfg,
      { ...setSidebar, expectedSourceHash: hashContent(before) },
      s.revisions,
    );
    expect(r.ok).toBe(true);
  });

  test("afterRename throw leaves pending 503 and later recovery commits", () => {
    const s = sandbox();
    const live = fingerprintAuthorizedSource(s.cfg, "user", 0);
    const commit = previewThenCommit(
      deps(s, {
        afterRename() {
          throw new Error("post-rename observer failed");
        },
      }),
      { scope: "user", expectedSource: live, input: setSidebar },
      produceGlobalCandidate,
    );
    expect(commit.status).toBe(503);
    expect(commit.code).toBe("recovery-pending");
    expect(commit.revisionId).toBeTruthy();
    expect(s.revisions.get(commit.revisionId!)?.state).toBe("pending");
    const recovered = s.revisions.recoverPendingOmo(s.cfg, "user");
    expect(recovered[0]?.action).toBe("committed");
    expect(s.revisions.get(commit.revisionId!)?.state).toBe("committed");
  });

  test("ordinary commit candidate SHA mismatch is 409", () => {
    const s = sandbox();
    const live = fingerprintAuthorizedSource(s.cfg, "user", 0);
    const preview = previewOmoCandidate(
      deps(s),
      { scope: "user", expectedSource: live, input: setSidebar },
      produceGlobalCandidate,
    );
    expect(preview.ok).toBe(true);
    const commit = commitOmoCandidate(
      deps(s),
      {
        scope: "user",
        expectedSource: live,
        input: setSidebar,
        expectedCandidateSha256: "deadbeef",
      },
      produceGlobalCandidate,
    );
    expect(commit.status).toBe(409);
    expect(commit.code).toBe("stale-source");
    expect(readFileSync(s.userFile, "utf-8")).toBe(preview.beforeText);
  });

  test("restore candidate SHA mismatch is 409", () => {
    const s = sandbox();
    const before = readFileSync(s.userFile, "utf-8");
    const applied = applyGlobal(
      s.cfg,
      { ...setSidebar, expectedSourceHash: hashContent(before) },
      s.revisions,
    );
    expect(applied.ok).toBe(true);
    const live = fingerprintAuthorizedSource(s.cfg, "user", 0);
    const commit = commitOmoRevisionRestore(deps(s), {
      scope: "user",
      revisionId: applied.revisionId!,
      expectedSource: live,
      expectedCandidateSha256: "deadbeef",
    });
    expect(commit.status).toBe(409);
    expect(commit.code).toBe("stale-source");
  });

  test("legacy commented .json structured write preserves comments and extension", () => {
    const s = sandbox({ jsonc: false });
    writeFileSync(
      s.userFile,
      `{\n  // legacy comment\n  "compactSidebar": true,\n  "companion": { "enabled": false }\n}\n`,
    );
    const before = readFileSync(s.userFile, "utf-8");
    const r = applyGlobal(
      s.cfg,
      { ...setSidebar, expectedSourceHash: hashContent(before) },
      s.revisions,
    );
    expect(r.ok).toBe(true);
    const after = readFileSync(s.userFile, "utf-8");
    expect(s.userFile.endsWith(".json")).toBe(true);
    expect(after).toContain("// legacy comment");
    expect(after).toContain('"compactSidebar": false');
  });

  test("unparseable-even-as-JSONC current source does not write", () => {
    const s = sandbox({ jsonc: false });
    writeFileSync(s.userFile, "{ not-json even as jsonc");
    const live = fingerprintAuthorizedSource(s.cfg, "user", 0);
    const commit = previewThenCommit(
      deps(s),
      { scope: "user", expectedSource: live, input: setSidebar },
      produceGlobalCandidate,
    );
    expect(commit.ok).toBe(false);
    expect(commit.code === "syntax-invalid" || commit.code === "root-not-object").toBe(
      true,
    );
    expect(readFileSync(s.userFile, "utf-8")).toBe("{ not-json even as jsonc");
    expect(s.revisions.list().length).toBe(0);
  });

  test("target-extension parse rejects commented candidate on .json", () => {
    const s = sandbox({ jsonc: false });
    writeFileSync(
      s.userFile,
      `{\n  // legacy\n  "compactSidebar": true,\n  "companion": { "enabled": false }\n}\n`,
    );
    const live = fingerprintAuthorizedSource(s.cfg, "user", 0);
    const preview = previewOmoCandidate(
      deps(s),
      {
        scope: "user",
        expectedSource: live,
        input: setSidebar,
        candidateParse: "target-extension",
      },
      () => ({
        candidateText: `{\n  // still commented\n  "compactSidebar": false\n}\n`,
        featureErrors: [],
        featureWarnings: [],
        intent: {
          kind: "raw",
          summary: "strict json",
          propertyPaths: [],
          mutationJson: "{}",
        },
      }),
    );
    expect(preview.ok).toBe(false);
    expect(preview.code).toBe("syntax-invalid");
  });

  test("allowInvalidCurrent repairs unparseable source when Companion is proven", () => {
    const s = sandbox();
    writeFileSync(
      s.userFile,
      `{\n  "companion": { "enabled": false },\n  broken\n}\n`,
    );
    const live = fingerprintAuthorizedSource(s.cfg, "user", 0);
    const candidate = `{\n  "compactSidebar": false,\n  "companion": { "enabled": false }\n}\n`;
    const preview = previewOmoCandidate(
      deps(s),
      {
        scope: "user",
        expectedSource: live,
        input: { candidateText: candidate },
        candidateParse: "target-extension",
        allowInvalidCurrent: true,
      },
      () => ({
        candidateText: candidate,
        featureErrors: [],
        featureWarnings: [],
        intent: {
          kind: "raw",
          summary: "repair",
          propertyPaths: [],
          mutationJson: "{}",
        },
      }),
    );
    expect(preview.ok).toBe(true);
    expect(preview.canApply).toBe(true);
  });
});

describe("existing producer wrappers still work through transaction", () => {
  test("simulateMutation is in-memory", () => {
    const s = sandbox();
    const before = readFileSync(s.userFile, "utf-8");
    const sim = simulateMutation(s.cfg, {
      kind: "agent-model",
      scope: "user",
      destination: { kind: "root-agent" },
      agent: "explorer",
      model: ["a/b"],
      expectedSourceHash: hashContent(before),
    });
    expect(sim.ok).toBe(true);
    expect(readFileSync(s.userFile, "utf-8")).toBe(before);
    expect(existsSync(join(s.projDir, "data", "sim"))).toBe(false);
  });

  test("applyMutation writes via transaction and records revision", () => {
    const s = sandbox();
    const before = readFileSync(s.userFile, "utf-8");
    const r = applyMutation(
      s.cfg,
      {
        kind: "agent-model",
        scope: "user",
        destination: { kind: "root-agent" },
        agent: "explorer",
        model: ["a/b"],
        expectedSourceHash: hashContent(before),
      },
      s.revisions,
    );
    expect(r.ok).toBe(true);
    expect(s.revisions.list()[0]?.state).toBe("committed");
    expect(readFileSync(s.userFile, "utf-8")).toContain("a/b");
  });
});
