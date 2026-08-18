/**
 * Slice 18 D2 — typed Interview mutation backend tests.
 *
 * Write-path tests install a byte-exact copy of the real installed
 * oh-my-opencode-slim@2.2.10 schema inside a repository sandbox so the
 * typed-capability version/hash gate opens exactly as in production;
 * they skip gracefully when the installed schema is absent. The live
 * configuration directory is never mutated.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  InterviewCommitResponse,
  InterviewField,
  InterviewMutationOperation,
  InterviewPreviewResponse,
} from "@omo/shared";
import {
  INTERVIEW_COMMIT_CONTRACT_FIXTURE,
  INTERVIEW_PREVIEW_CONTRACT_FIXTURE,
  isInterviewCommitResponse,
  isInterviewPreviewResponse,
} from "@omo/shared";
import type { ServerConfig } from "../config";
import { restoreRevision } from "./mutate";
import {
  applyInterviewMutation,
  interviewHttpStatus,
  simulateInterviewMutation,
  validateInterviewOperations,
} from "./interview";
import {
  handleInterviewConfigRoutes,
  parseInterviewMutationBody,
  type InterviewConfigRouteDeps,
} from "./interview-routes";
import { RevisionStore } from "./revisions";
import { hashContent } from "./jsonc-edit";
import { resolveProvenance } from "../omo/provenance";
import {
  AUDITED_INTERVIEW_FIELD_NAMES,
  AUDITED_INTERVIEW_PACKAGE_VERSION,
  AUDITED_INTERVIEW_SCHEMA_HASH,
} from "../omo-schema/introspect";
import { fingerprintAuthorizedSource } from "../omo-schema/fingerprint";

const ROOT = join(import.meta.dir, "../../test/interview-d2-sandbox");
const REAL_SCHEMA_PATH = join(
  process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), ".config", "opencode"),
  "node_modules",
  "oh-my-opencode-slim",
  "oh-my-opencode-slim.schema.json",
);
const REAL_SCHEMA_TEXT = existsSync(REAL_SCHEMA_PATH)
  ? readFileSync(REAL_SCHEMA_PATH, "utf-8")
  : null;
const realTest = REAL_SCHEMA_TEXT ? test : test.skip;

const USER_TEXT = `{
  // keep me
  "preset": "openai",
  "unknownGlobalKeep": true
}
`;

const USER_TEXT_WITH_INTERVIEW = `{
  // keep me
  "preset": "openai",
  "interview": {
    "maxQuestions": 5,
    "outputFolder": "a",
    "magicDashboardMode": true
  },
  "unknownGlobalKeep": true
}
`;

const EXACT_SET_DIFF = `--- a/oh-my-opencode-slim.jsonc
+++ b/oh-my-opencode-slim.jsonc
@@
 {
+  "unknownGlobalKeep": true,
+  "interview": {
+    "maxQuestions": 7
+  }
-  "unknownGlobalKeep": true
 }`;

function installVerifiedSchema(userDir: string): void {
  const dir = join(userDir, "node_modules", "oh-my-opencode-slim");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ version: AUDITED_INTERVIEW_PACKAGE_VERSION }),
  );
  writeFileSync(join(dir, "oh-my-opencode-slim.schema.json"), REAL_SCHEMA_TEXT!);
}

function installSkewSchema(userDir: string): void {
  const dir = join(userDir, "node_modules", "oh-my-opencode-slim");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ version: "9.9.9-skew" }),
  );
  writeFileSync(
    join(dir, "oh-my-opencode-slim.schema.json"),
    JSON.stringify({
      type: "object",
      properties: {
        interview: {
          type: "object",
          properties: {
            maxQuestions: { type: "integer", default: 2, minimum: 1, maximum: 10 },
            extraField: { type: "boolean", default: false },
          },
        },
      },
    }),
  );
}

function fresh(opts?: {
  schema?: "verified" | "skew" | "none";
  userText?: string;
  projectText?: string;
}) {
  rmSync(ROOT, { recursive: true, force: true });
  const userDir = join(ROOT, "cfg");
  const projDir = join(ROOT, "proj");
  mkdirSync(userDir, { recursive: true });
  mkdirSync(join(projDir, "data"), { recursive: true });
  const schema = opts?.schema ?? "verified";
  if (schema === "verified") installVerifiedSchema(userDir);
  if (schema === "skew") installSkewSchema(userDir);
  const userFile = join(userDir, "oh-my-opencode-slim.jsonc");
  if (opts?.userText !== undefined) writeFileSync(userFile, opts.userText);
  else writeFileSync(userFile, USER_TEXT);
  if (opts?.projectText !== undefined) {
    mkdirSync(join(projDir, ".opencode"), { recursive: true });
    writeFileSync(
      join(projDir, ".opencode", "oh-my-opencode-slim.jsonc"),
      opts.projectText,
    );
  }
  const cfg = {
    host: "127.0.0.1",
    port: 0,
    opencodeConfigDir: userDir,
    projectDirectory: projDir,
    authorizedRoots: [userDir, projDir, ROOT],
  } as ServerConfig;
  const revisions = new RevisionStore(join(projDir, "data", "test.db"));
  return { cfg, revisions, userDir, projDir, userFile };
}

function userHash(s: ReturnType<typeof fresh>): string {
  return hashContent(readFileSync(s.userFile, "utf-8"));
}

const set = (
  field: InterviewField,
  value: unknown,
): InterviewMutationOperation =>
  ({ field, op: "set", value }) as InterviewMutationOperation;

function previewOf(
  r: InterviewPreviewResponse | InterviewCommitResponse,
): InterviewPreviewResponse {
  return "preview" in r ? r.preview : r;
}

function applyOps(
  s: ReturnType<typeof fresh>,
  operations: InterviewMutationOperation[],
  extra: Partial<Parameters<typeof applyInterviewMutation>[1]> = {},
) {
  const scope = extra.scope ?? "user";
  const expectedSourceHash =
    extra.expectedSourceHash ??
    (scope === "user"
      ? userHash(s)
      : hashContent(
          readFileSync(
            join(s.projDir, ".opencode", "oh-my-opencode-slim.jsonc"),
            "utf-8",
          ),
        ));
  const preview = simulateInterviewMutation(s.cfg, {
    scope,
    expectedSource: extra.expectedSource,
    expectedSourceHash: extra.expectedSource ? undefined : expectedSourceHash,
    operations,
  });
  return applyInterviewMutation(
    s.cfg,
    {
      scope,
      expectedSource: extra.expectedSource,
      expectedSourceHash: extra.expectedSource ? undefined : expectedSourceHash,
      operations,
      expectedCandidateSha256:
        extra.expectedCandidateSha256 ??
        preview.candidateSha256 ??
        "unused-preview-failed",
    },
    s.revisions,
  );
}

const remove = (field: InterviewField): InterviewMutationOperation => ({
  field,
  op: "remove",
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

// ── Pure operation validation (audited installed metadata) ─────────────

describe("interview operation validation (exact metadata)", () => {
  test("unknown field rejected", () => {
    const r = validateInterviewOperations([
      set("magicDashboardMode" as InterviewField, true),
    ]);
    expect(r.errors.join(" ")).toContain("Unknown interview field");
  });

  test("empty operations rejected", () => {
    expect(validateInterviewOperations([]).errors[0]).toContain("non-empty");
  });

  test("duplicate per-field operations rejected", () => {
    const r = validateInterviewOperations([
      set("maxQuestions", 3),
      set("maxQuestions", 4),
    ]);
    expect(r.errors.join(" ")).toContain("Duplicate operation for interview.maxQuestions");
  });

  test("maxQuestions range/type: 0, 11, 1.5, non-number rejected; 1 and 10 accepted", () => {
    for (const bad of [0, 11, 1.5, "two", true]) {
      expect(
        validateInterviewOperations([set("maxQuestions", bad)]).errors.length,
      ).toBeGreaterThan(0);
    }
    expect(validateInterviewOperations([set("maxQuestions", 1)]).errors).toEqual([]);
    expect(validateInterviewOperations([set("maxQuestions", 10)]).errors).toEqual([]);
  });

  test("port range/type: -1, 65536, 1.5 rejected; 0 and 65535 accepted", () => {
    for (const bad of [-1, 65536, 1.5, "8080"]) {
      expect(validateInterviewOperations([set("port", bad)]).errors.length).toBeGreaterThan(0);
    }
    expect(validateInterviewOperations([set("port", 0)]).errors).toEqual([]);
    expect(validateInterviewOperations([set("port", 65535)]).errors).toEqual([]);
  });

  test("outputFolder minLength 1: empty and non-string rejected", () => {
    expect(validateInterviewOperations([set("outputFolder", "")]).errors[0]).toContain(
      "minLength 1",
    );
    expect(validateInterviewOperations([set("outputFolder", 42)]).errors.length).toBeGreaterThan(0);
    expect(validateInterviewOperations([set("outputFolder", "reports")]).errors).toEqual([]);
  });

  test("booleans: non-boolean rejected for autoOpenBrowser/dashboard", () => {
    for (const field of ["autoOpenBrowser", "dashboard"] as const) {
      expect(
        validateInterviewOperations([set(field, "yes")]).errors.length,
      ).toBeGreaterThan(0);
      expect(validateInterviewOperations([set(field, false)]).errors).toEqual([]);
    }
  });

  test("remove must not carry a value; set requires one", () => {
    expect(
      validateInterviewOperations([{ field: "port", op: "remove", value: 1 }]).errors[0],
    ).toContain("remove must not carry a value");
    expect(
      validateInterviewOperations([{ field: "port", op: "set" } as never]).errors[0],
    ).toContain("requires a value");
  });

  test("all five verified fields are the complete writable set", () => {
    const r = validateInterviewOperations([
      set("maxQuestions", 2),
      set("outputFolder", "interview"),
      set("autoOpenBrowser", true),
      set("port", 0),
      set("dashboard", false),
    ]);
    expect(r.errors).toEqual([]);
  });
});

// ── Typed-capability fail-closed gates ─────────────────────────────────

describe("interview typed capability gate (fail-closed)", () => {
  test("schema unavailable: simulate 422 schema-unavailable, no write, reads still fine", () => {
    const s = fresh({ schema: "none" });
    const r = simulateInterviewMutation(s.cfg, {
      scope: "user",
      expectedSourceHash: userHash(s),
      operations: [set("maxQuestions", 7)],
    });
    expect(r.ok).toBe(false);
    expect(r.canApply).toBe(false);
    expect(r.code).toBe("schema-unavailable");
    expect(r.typedCapability.available).toBe(false);
    expect(readFileSync(s.userFile, "utf-8")).toBe(USER_TEXT);
    expect(r.runtimeAction).toBe("none");
  });

  test("version/field skew: apply 400 policy, reason recorded, no write", () => {
    const s = fresh({ schema: "skew" });
    const r = applyInterviewMutation(
      s.cfg,
      {
        scope: "user",
        expectedSourceHash: userHash(s),
        operations: [set("maxQuestions", 7)],
        expectedCandidateSha256: "unused-gate-closed",
      },
      s.revisions,
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.preview.canApply).toBe(false);
    expect(r.typedCapability.available).toBe(false);
    expect(r.typedCapability.installedFields).toContain("extraField");
    expect(r.errors.join(" ")).toContain("mismatch");
    expect(readFileSync(s.userFile, "utf-8")).toBe(USER_TEXT);
    expect(s.revisions.list().length).toBe(0);
  });
});

// ── Simulate / Apply through the D1 transaction ────────────────────────

describe("interview simulate/apply (verified schema, repository sandbox)", () => {
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  realTest("typed capability opens with exact installed schema copy", () => {
    const s = fresh();
    const r = simulateInterviewMutation(s.cfg, {
      scope: "user",
      expectedSourceHash: userHash(s),
      operations: [set("maxQuestions", 7)],
    });
    expect(r.typedCapability.available).toBe(true);
    expect(r.typedCapability.packageVersion).toBe(AUDITED_INTERVIEW_PACKAGE_VERSION);
    expect(r.typedCapability.schemaHash).toBe(AUDITED_INTERVIEW_SCHEMA_HASH);
    expect(r.typedCapability.installedFields).toEqual([
      ...AUDITED_INTERVIEW_FIELD_NAMES,
    ]);
  });

  realTest("simulate is no-write and reports exact bounded diffs", () => {
    const s = fresh();
    const r = simulateInterviewMutation(s.cfg, {
      scope: "user",
      expectedSourceHash: userHash(s),
      operations: [set("maxQuestions", 7)],
    });
    expect(r.ok).toBe(true);
    expect(r.canApply).toBe(true);
    expect(isInterviewPreviewResponse(r)).toBe(true);
    expect(readFileSync(s.userFile, "utf-8")).toBe(USER_TEXT);
    expect(existsSync(join(s.projDir, "data", "sim"))).toBe(false);
    expect(s.revisions.list().length).toBe(0);
    expect(r.textDiff?.text).toBe(EXACT_SET_DIFF);
    expect(r.textDiff?.truncated).toBe(false);
    expect(r.target.path).toBe(s.userFile);
    expect(r.semanticValidation.ok).toBe(true);
    expect(r.sourceChanges).toEqual([
      { path: "interview.maxQuestions", op: "add", after: 7 },
    ]);
    expect(r.desiredChanges.some((c) => c.path === "interview.maxQuestions")).toBe(true);
    expect(r.effectiveChanges.some((c) => c.path === "interview.maxQuestions")).toBe(true);
    expect(r.provenanceChanges.some((c) => c.path === "interview.maxQuestions")).toBe(true);
    expect(r.candidateSha256).toBeDefined();
    expect(r.schemaValidation?.ok).toBe(true);
    expect(r.restartRequired).toBe(true);
    expect(r.runtimeAction).toBe("none");
    expect(r.interview?.before?.effective.maxQuestions).toBe(2);
    expect(r.interview?.after?.effective.maxQuestions).toBe(7);
    expect(r.interview?.before?.server.mode).toBe("per-session");
  });

  realTest("apply writes leaf, preserves comments/unknown keys, journals interview revision", () => {
    const s = fresh();
    const preview = simulateInterviewMutation(s.cfg, {
      scope: "user",
      expectedSourceHash: userHash(s),
      operations: [set("maxQuestions", 7)],
    });
    const r = applyInterviewMutation(
      s.cfg,
      {
        scope: "user",
        expectedSourceHash: userHash(s),
        operations: [set("maxQuestions", 7)],
        expectedCandidateSha256: preview.candidateSha256,
      },
      s.revisions,
    );
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(isInterviewCommitResponse(r)).toBe(true);
    expect(r.preview.canApply).toBe(true);
    expect(r.revisionId).toBeDefined();
    const t = readFileSync(s.userFile, "utf-8");
    expect(t).toContain("// keep me");
    expect(t).toContain("unknownGlobalKeep");
    expect(t).toContain("maxQuestions");
    const rev = s.revisions.get(r.revisionId!);
    expect(rev?.mutationKind).toBe("interview");
    expect(rev?.property).toBe("interview.maxQuestions");
    expect(rev?.state).toBe("committed");
    expect(r.source?.sha256).toBe(hashContent(t));
  });

  realTest("revision restore returns exact baseline bytes", () => {
    const s = fresh();
    const r = applyOps(s, [set("port", 8080)]);
    expect(r.ok).toBe(true);
    const after = readFileSync(s.userFile, "utf-8");
    const restored = restoreRevision(s.cfg, r.revisionId!, s.revisions, hashContent(after));
    expect(restored.ok).toBe(true);
    expect(readFileSync(s.userFile, "utf-8")).toBe(USER_TEXT);
  });

  realTest("compound unique operations set multiple leaves", () => {
    const s = fresh();
    const r = applyOps(s, [set("maxQuestions", 7), set("dashboard", true)]);
    expect(r.ok).toBe(true);
    const t = readFileSync(s.userFile, "utf-8");
    expect(t).toContain("maxQuestions");
    expect(t).toContain("dashboard");
    const rev = s.revisions.get(r.revisionId!);
    expect(rev?.property).toBe("interview.maxQuestions,interview.dashboard");
  });

  realTest("port 0 accepted; port>0 flips derived server mode via port", () => {
    const s = fresh();
    const zero = simulateInterviewMutation(s.cfg, {
      scope: "user",
      expectedSourceHash: userHash(s),
      operations: [set("port", 0)],
    });
    expect(zero.ok).toBe(true);
    expect(zero.interview?.after?.effective.port).toBe(0);
    expect(zero.interview?.after?.server.mode).toBe("per-session");
    expect(zero.interview?.after?.server.dashboardDerived).toEqual({
      enabled: false,
      via: "no",
    });

    const p = simulateInterviewMutation(s.cfg, {
      scope: "user",
      expectedSourceHash: userHash(s),
      operations: [set("port", 8080)],
    });
    expect(p.ok).toBe(true);
    expect(p.interview?.after?.server.mode).toBe("dashboard");
    expect(p.interview?.after?.server.dashboardDerived).toEqual({
      enabled: true,
      via: "port",
    });
    expect(p.interview?.after?.server.portMeaning).toBe(
      "Configured dashboard port (8080)",
    );
  });

  realTest("dashboard true + port 0 reports installed default dashboard port 43211", () => {
    const s = fresh();
    const r = simulateInterviewMutation(s.cfg, {
      scope: "user",
      expectedSourceHash: userHash(s),
      operations: [set("dashboard", true)],
    });
    expect(r.ok).toBe(true);
    expect(r.interview?.after?.server.dashboardDerived).toEqual({
      enabled: true,
      via: "explicit",
    });
    expect(r.interview?.after?.server.defaultDashboardPort).toBe(43211);
    expect(r.interview?.after?.server.portMeaning).toContain("43211");
    expect(
      r.interview?.after?.server.notes.some((n) => n.includes("43211")),
    ).toBe(true);
  });

  realTest("autoOpenBrowser is config-only: no runtime action in response", () => {
    const s = fresh();
    const r = applyOps(s, [set("autoOpenBrowser", false)]);
    expect(r.ok).toBe(true);
    expect(r.runtimeAction).toBe("none");
    expect(previewOf(r).interview?.after?.effective.autoOpenBrowser).toBe(false);
    expect(previewOf(r).interview?.after?.server.browser.autoOpen).toBe(false);
  });

  realTest("outputFolder normalization is metadata-only; destination never inspected", () => {
    const s = fresh();
    const r = simulateInterviewMutation(s.cfg, {
      scope: "user",
      expectedSourceHash: userHash(s),
      operations: [set("outputFolder", "/reports/")],
    });
    expect(r.ok).toBe(true);
    // Raw configured value survives in the candidate (no silent rewrite).
    expect(r.textDiff?.text).toContain("/reports/");
    const out = r.interview?.after?.output;
    expect(out?.configuredFolder).toBe("/reports/");
    expect(out?.normalizedFolder).toBe("reports");
    expect(out?.resolvedPath).toBe(join(s.projDir, "reports"));
    expect(out?.inspected).toBe(false);
    expect(out?.exists).toBeNull();
    expect(existsSync(join(s.projDir, "reports"))).toBe(false);
  });

  realTest("remove deletes only that source leaf; unknown interview keys survive", () => {
    const s = fresh({ userText: USER_TEXT_WITH_INTERVIEW });
    const r = applyOps(s, [remove("maxQuestions")]);
    expect(r.ok).toBe(true);
    const t = readFileSync(s.userFile, "utf-8");
    expect(t).not.toContain("maxQuestions");
    expect(t).toContain('"outputFolder": "a"');
    expect(t).toContain("magicDashboardMode");
    expect(t).toContain("// keep me");
    expect(previewOf(r).interview?.after?.effective.maxQuestions).toBe(2);
    expect(
      previewOf(r).interview?.after?.effective !== undefined &&
        previewOf(r).desiredChanges.some((c) => c.path === "interview.maxQuestions" && c.op === "remove"),
    ).toBe(true);
  });

  realTest("remove of absent leaf is a no-op", () => {
    const s = fresh();
    const r = simulateInterviewMutation(s.cfg, {
      scope: "user",
      expectedSourceHash: userHash(s),
      operations: [remove("maxQuestions")],
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("no-op");
    expect(interviewHttpStatus(r.code)).toBe(400);
    expect(readFileSync(s.userFile, "utf-8")).toBe(USER_TEXT);
  });

  realTest("set to the current value is a no-op", () => {
    const s = fresh({ userText: USER_TEXT_WITH_INTERVIEW });
    const r = simulateInterviewMutation(s.cfg, {
      scope: "user",
      expectedSourceHash: userHash(s),
      operations: [set("maxQuestions", 5)],
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("no-op");
  });

  realTest("project set overrides user leaf; desired/provenance reflect project stage", () => {
    const s = fresh({
      projectText: `{
  "interview": { "maxQuestions": 9 }
}
`,
    });
    const r = applyOps(s, [set("maxQuestions", 8), set("port", 3000)], {
      scope: "project",
    });
    expect(r.ok).toBe(true);
    expect(r.preview.target.path).toContain(join(s.projDir, ".opencode"));
    expect(previewOf(r).interview?.after?.effective.maxQuestions).toBe(8);
    const prov = previewOf(r).provenanceChanges.find(
      (c) => c.path === "interview.maxQuestions",
    );
    expect(prov?.after?.stage).toBe("project-config");
  });

  realTest("remove project leaf restores user inheritance (not a written default)", () => {
    const s = fresh({
      userText: `{
  "interview": { "maxQuestions": 5 }
}
`,
      projectText: `{
  "interview": { "maxQuestions": 9 }
}
`,
    });
    expect(
      simulateInterviewMutation(s.cfg, {
        scope: "project",
        expectedSourceHash: hashContent(
          readFileSync(join(s.projDir, ".opencode", "oh-my-opencode-slim.jsonc"), "utf-8"),
        ),
        operations: [set("maxQuestions", 9)],
      }).interview?.before?.effective.maxQuestions,
    ).toBe(9);
    const r = applyOps(s, [remove("maxQuestions")], { scope: "project" });
    expect(r.ok).toBe(true);
    const projText = readFileSync(
      join(s.projDir, ".opencode", "oh-my-opencode-slim.jsonc"),
      "utf-8",
    );
    expect(projText).not.toContain("maxQuestions");
    // User value now wins again.
    expect(previewOf(r).interview?.after?.effective.maxQuestions).toBe(5);
  });

  realTest("apply to missing project source creates it (create-on-apply only)", async () => {
    const s = fresh();
    const fingerprint = fingerprintAuthorizedSource(s.cfg, "project", 0);
    expect(fingerprint.exists).toBe(false);
    const preview = simulateInterviewMutation(s.cfg, {
      scope: "project",
      expectedSource: fingerprint,
      operations: [set("maxQuestions", 4)],
    });
    expect(preview.ok).toBe(true);
    expect(preview.desiredChanges.some((c) => c.path === "interview.maxQuestions")).toBe(true);
    expect(preview.effectiveChanges.some((c) => c.path === "interview.maxQuestions")).toBe(true);
    expect(preview.provenanceChanges.some((c) => c.path === "interview.maxQuestions")).toBe(true);
    expect(preview.interview?.after?.effective.maxQuestions).toBe(4);
    const r = applyInterviewMutation(
      s.cfg,
      {
        scope: "project",
        expectedSource: fingerprint,
        operations: [set("maxQuestions", 4)],
        expectedCandidateSha256: preview.candidateSha256,
      },
      s.revisions,
    );
    expect(r.ok).toBe(true);
    expect(r.preview.target.createOnApplyOnly).toBe(true);
    const t = readFileSync(
      join(s.projDir, ".opencode", "oh-my-opencode-slim.jsonc"),
      "utf-8",
    );
    expect(t).toContain("maxQuestions");
    // Source-level diff proves the leaf was added to the created source.
    expect(previewOf(r).sourceChanges).toEqual([
      { path: "interview.maxQuestions", op: "add", after: 4 },
    ]);
    const deps = routeDeps(s);
    const res = await handleInterviewConfigRoutes(
      deps,
      new Request("http://localhost/api/config/interview"),
      urlOf("/api/config/interview"),
    );
    const state = (await res!.json()) as {
      effective: { maxQuestions: number };
      raw: { project?: Record<string, unknown> };
    };
    expect(state.effective.maxQuestions).toBe(4);
    expect(state.raw.project).toEqual({ maxQuestions: 4 });
  });

  realTest("stale expected hash: simulate and apply 409, bytes unchanged", () => {
    const s = fresh();
    const sim = simulateInterviewMutation(s.cfg, {
      scope: "user",
      expectedSourceHash: "deadbeef",
      operations: [set("maxQuestions", 7)],
    });
    expect(sim.ok).toBe(false);
    expect(interviewHttpStatus(sim.code)).toBe(409);
    expect(sim.errors.join(" ")).toContain("EXTERNALLY");
    const app = applyInterviewMutation(
      s.cfg,
      {
        scope: "user",
        expectedSourceHash: "deadbeef",
        operations: [set("maxQuestions", 7)],
        expectedCandidateSha256: "deadbeef",
      },
      s.revisions,
    );
    expect(app.ok).toBe(false);
    expect(app.status).toBe(409);
    expect(app.errors.join(" ")).toContain("EXTERNALLY");
    expect(readFileSync(s.userFile, "utf-8")).toBe(USER_TEXT);
  });

  realTest("full fingerprint with exists mismatch conflicts 409", () => {
    const s = fresh();
    const live = fingerprintAuthorizedSource(s.cfg, "user", 0);
    const r = simulateInterviewMutation(s.cfg, {
      scope: "user",
      expectedSource: { ...live, exists: !live.exists },
      operations: [set("maxQuestions", 7)],
    });
    expect(r.ok).toBe(false);
    expect(interviewHttpStatus(r.code)).toBe(409);
  });

  realTest("wrong preview candidate SHA on apply: 409, bytes unchanged", () => {
    const s = fresh();
    const r = applyInterviewMutation(
      s.cfg,
      {
        scope: "user",
        expectedSourceHash: userHash(s),
        operations: [set("maxQuestions", 7)],
        expectedCandidateSha256: "deadbeef",
      },
      s.revisions,
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    expect(readFileSync(s.userFile, "utf-8")).toBe(USER_TEXT);
    expect(s.revisions.list().length).toBe(0);
  });

  realTest("producer validation errors surface as policy 400 through simulate", () => {
    const s = fresh();
    const r = simulateInterviewMutation(s.cfg, {
      scope: "user",
      expectedSourceHash: userHash(s),
      operations: [set("port", 70000)],
    });
    expect(r.ok).toBe(false);
    expect(interviewHttpStatus(r.code)).toBe(400);
    expect(r.errors.join(" ")).toContain("interview.port maximum 65535");
  });

  realTest("unrelated whole-schema invalid current config blocks with raw-repair guidance", () => {
    const s = fresh({
      userText: `{
  // keep me
  "agents": { "critic": { "model": { "id": "x/y", "variant": "high" } } }
}
`,
    });
    const r = applyOps(s, [set("port", 8080)]);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(422);
    expect(r.code).toBe("schema-invalid");
    expect(r.rawRepair?.needed).toBe(true);
    expect(r.preview.schemaValidation?.ok).toBe(false);
    expect(readFileSync(s.userFile, "utf-8")).toContain("critic");
    expect(s.revisions.list().length).toBe(0);
  });

  realTest("invalid current syntax: 422 syntax-invalid with raw-repair, no runtime action", () => {
    const s = fresh({
      userText: `{
  // keep me
  "preset": "openai",
  broken
}
`,
    });
    const r = applyOps(s, [set("maxQuestions", 7)]);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(422);
    expect(r.code).toBe("syntax-invalid");
    expect(r.rawRepair?.needed).toBe(true);
    expect(r.runtimeAction).toBe("none");
  });

  realTest("missing user Preview reports Desired/Effective/provenance", () => {
    const s = fresh();
    rmSync(s.userFile, { force: true });
    const fingerprint = fingerprintAuthorizedSource(s.cfg, "user", 0);
    const r = simulateInterviewMutation(s.cfg, {
      scope: "user",
      expectedSource: fingerprint,
      operations: [set("maxQuestions", 6)],
    });
    expect(r.ok).toBe(true);
    expect(r.desiredChanges.some((c) => c.path === "interview.maxQuestions")).toBe(true);
    expect(r.effectiveChanges.some((c) => c.path === "interview.maxQuestions")).toBe(true);
    expect(r.provenanceChanges.some((c) => c.path === "interview.maxQuestions")).toBe(true);
    expect(r.interview?.after?.effective.maxQuestions).toBe(6);
  });

  realTest("client fingerprint generation is preserved for stale compare", () => {
    const s = fresh();
    const live = fingerprintAuthorizedSource(s.cfg, "user", 0);
    const r = simulateInterviewMutation(s.cfg, {
      scope: "user",
      expectedSource: { ...live, generation: live.generation + 9 },
      operations: [set("maxQuestions", 7)],
    });
    expect(r.ok).toBe(false);
    expect(interviewHttpStatus(r.code)).toBe(409);
  });

  realTest("apply without expectedCandidateSha256 is 400 and writes nothing", () => {
    const s = fresh();
    const r = applyInterviewMutation(
      s.cfg,
      {
        scope: "user",
        expectedSourceHash: userHash(s),
        operations: [set("maxQuestions", 7)],
      },
      s.revisions,
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.errors.join(" ")).toContain("expectedCandidateSha256");
    expect(readFileSync(s.userFile, "utf-8")).toBe(USER_TEXT);
  });
});

// ── HTTP route handler ─────────────────────────────────────────────────

function routeDeps(s: ReturnType<typeof fresh>): InterviewConfigRouteDeps {
  return {
    cfg: s.cfg,
    revisions: s.revisions,
    loadBundle: () =>
      resolveProvenance({
        opencodeConfigDir: s.userDir,
        projectDirectory: s.projDir,
        authorizedRoots: [s.userDir, s.projDir, ROOT],
      }),
    sourceGeneration: () => 7,
    env: {},
  };
}

function post(body: unknown): Request {
  return new Request("http://localhost/api/config/interview/simulate", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function urlOf(pathname: string): URL {
  return new URL(`http://localhost${pathname}`);
}

describe("interview config routes (handler-level)", () => {
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  realTest("GET /api/config/interview returns exact flat state payload", async () => {
    const s = fresh();
    const res = await handleInterviewConfigRoutes(
      routeDeps(s),
      new Request("http://localhost/api/config/interview"),
      urlOf("/api/config/interview"),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const state = (await res!.json()) as Record<string, unknown> & {
      fieldMetadata: Array<Record<string, unknown>>;
      typedCapability: { available: boolean; packageVersion?: string; schemaHash?: string };
      fingerprints: { user: { sha256: string | null }; project: { sha256: string | null } };
      restartRequired: boolean;
      runtimeAction: string;
    };
    expect(state.fieldMetadata.map((f) => f.name)).toEqual([
      ...AUDITED_INTERVIEW_FIELD_NAMES,
    ]);
    expect(state.typedCapability.available).toBe(true);
    expect(state.typedCapability.packageVersion).toBe(AUDITED_INTERVIEW_PACKAGE_VERSION);
    expect(state.typedCapability.schemaHash).toBe(AUDITED_INTERVIEW_SCHEMA_HASH);
    expect(state.fingerprints.user.sha256).toBe(hashContent(USER_TEXT));
    expect(state.fingerprints.project.sha256).toBeNull();
    expect(state.restartRequired).toBe(true);
    expect(state.runtimeAction).toBe("none");
    expect(state.raw).toEqual({});
    expect((state.effective as Record<string, unknown>).maxQuestions).toBe(2);
    // Read model carries schema identity + capability + provenance.
    expect(state.server).toBeDefined();
    expect(state.output).toBeDefined();
    expect(state.properties).toBeDefined();
  });

  test("GET still 200 with typed capability closed when schema missing", async () => {
    const s = fresh({ schema: "none" });
    const res = await handleInterviewConfigRoutes(
      routeDeps(s),
      new Request("http://localhost/api/config/interview"),
      urlOf("/api/config/interview"),
    );
    expect(res!.status).toBe(200);
    const state = (await res!.json()) as {
      typedCapability: { available: boolean; reason?: string };
      effective: Record<string, unknown>;
    };
    expect(state.typedCapability.available).toBe(false);
    expect(state.typedCapability.reason).toBeDefined();
    expect(state.effective.maxQuestions).toBe(2);
  });

  test("unmatched paths return null (caller continues dispatch)", async () => {
    const s = fresh();
    const res = await handleInterviewConfigRoutes(
      routeDeps(s),
      new Request("http://localhost/api/system/interview"),
      urlOf("/api/system/interview"),
    );
    expect(res).toBeNull();
  });

  test("malformed bodies rejected 400", async () => {
    const s = fresh();
    for (const body of [
      {},
      { scope: "bogus", operations: [] },
      { scope: "user" },
      { scope: "user", operations: [{ field: "port", op: "toggle" }] },
      { scope: "user", operations: [{ field: "port", op: "set", value: {} }] },
    ]) {
      const res = await handleInterviewConfigRoutes(
        routeDeps(s),
        post(body),
        urlOf("/api/config/interview/simulate"),
      );
      expect(res!.status).toBe(400);
      const j = (await res!.json()) as { ok: boolean; errors: string[] };
      expect(j.ok).toBe(false);
      expect(j.errors.length).toBeGreaterThan(0);
    }
  });

  test("malformed JSON body rejected 400", async () => {
    const s = fresh();
    const req = new Request("http://localhost/api/config/interview/simulate", {
      method: "POST",
      body: "{not json",
    });
    const res = await handleInterviewConfigRoutes(
      routeDeps(s),
      req,
      urlOf("/api/config/interview/simulate"),
    );
    expect(res!.status).toBe(400);
  });

  realTest("simulate route: 200 ok and 409 stale mapping", async () => {
    const s = fresh();
    const okRes = await handleInterviewConfigRoutes(
      routeDeps(s),
      post({
        scope: "user",
        expectedSourceHash: userHash(s),
        operations: [set("maxQuestions", 7)],
      }),
      urlOf("/api/config/interview/simulate"),
    );
    expect(okRes!.status).toBe(200);
    const j = (await okRes!.json()) as unknown;
    expect(isInterviewPreviewResponse(j)).toBe(true);
    expect(isInterviewPreviewResponse(INTERVIEW_PREVIEW_CONTRACT_FIXTURE)).toBe(true);
    if (isInterviewPreviewResponse(j)) {
      expect(j.ok).toBe(true);
      expect(j.canApply).toBe(true);
      expect(j.candidateSha256).toBeDefined();
      expect(j.target.path).toBeDefined();
      expect(j.semanticValidation).toBeDefined();
      expect(typeof j.textDiff?.text).toBe("string");
    }

    const staleRes = await handleInterviewConfigRoutes(
      routeDeps(s),
      post({
        scope: "user",
        expectedSourceHash: "deadbeef",
        operations: [set("maxQuestions", 7)],
      }),
      urlOf("/api/config/interview/simulate"),
    );
    expect(staleRes!.status).toBe(409);
  });

  realTest("apply route: 200 commit, revision journaled, no write on validation failure", async () => {
    const s = fresh();
    const simRes = await handleInterviewConfigRoutes(
      routeDeps(s),
      post({
        scope: "user",
        expectedSourceHash: userHash(s),
        operations: [set("port", 8080)],
      }),
      urlOf("/api/config/interview/simulate"),
    );
    const sim = (await simRes!.json()) as InterviewPreviewResponse;
    const res = await handleInterviewConfigRoutes(
      routeDeps(s),
      new Request("http://localhost/api/config/interview/apply", {
        method: "POST",
        body: JSON.stringify({
          scope: "user",
          expectedSourceHash: userHash(s),
          operations: [set("port", 8080)],
          expectedCandidateSha256: sim.candidateSha256,
        }),
      }),
      urlOf("/api/config/interview/apply"),
    );
    expect(res!.status).toBe(200);
    const j = (await res!.json()) as unknown;
    expect(isInterviewCommitResponse(j)).toBe(true);
    expect(isInterviewCommitResponse(INTERVIEW_COMMIT_CONTRACT_FIXTURE)).toBe(true);
    if (isInterviewCommitResponse(j)) {
      expect(j.ok).toBe(true);
      expect(j.preview.canApply).toBe(true);
      expect(j.revisionId).toBeDefined();
    }
    expect(readFileSync(s.userFile, "utf-8")).toContain("8080");

    const missingSha = await handleInterviewConfigRoutes(
      routeDeps(s),
      new Request("http://localhost/api/config/interview/apply", {
        method: "POST",
        body: JSON.stringify({
          scope: "user",
          expectedSourceHash: userHash(s),
          operations: [set("maxQuestions", 7)],
        }),
      }),
      urlOf("/api/config/interview/apply"),
    );
    expect(missingSha!.status).toBe(400);

    const badRes = await handleInterviewConfigRoutes(
      routeDeps(s),
      new Request("http://localhost/api/config/interview/apply", {
        method: "POST",
        body: JSON.stringify({
          scope: "user",
          expectedSourceHash: userHash(s),
          operations: [set("maxQuestions", 99)],
          expectedCandidateSha256: "deadbeef",
        }),
      }),
      urlOf("/api/config/interview/apply"),
    );
    expect(badRes!.status).toBe(400);
    expect(readFileSync(s.userFile, "utf-8")).toContain("8080");
    expect(readFileSync(s.userFile, "utf-8")).not.toContain("99");
  });

  test("parseInterviewMutationBody accepts shared DTO fingerprint form", () => {
    const parsed = parseInterviewMutationBody({
      scope: "project",
      expectedSource: {
        exists: false,
        sha256: null,
        format: "jsonc",
        mtimeMs: null,
        generation: 3,
      },
      operations: [{ field: "dashboard", op: "set", value: true }],
      expectedCandidateSha256: "abc",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.request.expectedSource?.exists).toBe(false);
      expect(parsed.request.expectedCandidateSha256).toBe("abc");
    }
  });
});

// ── Forbidden-action / dependency boundary ─────────────────────────────

describe("interview backend forbidden-action boundary", () => {
  const FORBIDDEN_FS = [
    /from ["']node:fs["']/,
    /\b(statSync|readdirSync|readFileSync|writeFileSync|renameSync|unlinkSync|mkdirSync|existsSync)\b/,
    /child_process/,
    /Bun\.spawn/,
    /\bspawnSync\b/,
    /\bexecSync\b/,
    /window\.open/,
    /\bfetch\s*\(/,
    /\breconcile\b/,
    /opencode\/lifecycle/,
    /runtime\/store/,
    /models\/probe/,
  ];

  test("cfgwrite/interview.ts has no runtime/fs/network action surface", () => {
    const src = readFileSync(join(import.meta.dir, "interview.ts"), "utf-8");
    for (const re of FORBIDDEN_FS) {
      expect(re.test(src), `interview.ts must not match ${re}`).toBe(false);
    }
    expect(src).toMatch(/previewOmoCandidate/);
    expect(src).toMatch(/previewThenCommit/);
  });

  test("cfgwrite/interview-routes.ts has no runtime/lifecycle/network ports", () => {
    const src = readFileSync(
      join(import.meta.dir, "interview-routes.ts"),
      "utf-8",
    );
    for (const re of FORBIDDEN_FS) {
      expect(re.test(src), `interview-routes.ts must not match ${re}`).toBe(false);
    }
    expect(src).toContain("/api/config/interview");
  });

  test("index.ts wiring delegates to the route module without runtime actions", () => {
    const src = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf-8");
    // Compatibility route preserved.
    expect(src).toContain('"/api/system/interview"');
    // New typed routes wired exactly once through the handler.
    expect(src.match(/handleInterviewConfigRoutes\(/g)?.length).toBe(1);
    const wiring = src.match(
      /const handled = await handleInterviewConfigRoutes\([\s\S]{0,600}?if \(handled\) return handled;/,
    )?.[0];
    expect(wiring).toBeDefined();
    expect(wiring!.includes("reconcile")).toBe(false);
    expect(wiring!.includes("lifecycle")).toBe(false);
  });

  test("route deps interface exposes no lifecycle/runtime members", () => {
    const src = readFileSync(
      join(import.meta.dir, "interview-routes.ts"),
      "utf-8",
    );
    const iface = src.match(
      /export interface InterviewConfigRouteDeps \{[\s\S]*?\n\}/,
    )?.[0];
    expect(iface).toBeDefined();
    for (const word of ["lifecycle", "runtime", "probe", "reconcile", "port"]) {
      expect(
        new RegExp(`\\b${word}\\b`, "i").test(iface!),
        `deps interface must not expose "${word}"`,
      ).toBe(false);
    }
  });
});
