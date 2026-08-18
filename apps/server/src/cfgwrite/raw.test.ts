/**
 * Slice 18 D3 — raw OMO source / revision / watcher backend tests.
 * Sandbox only. The live configuration directory is never mutated.
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
import {
  isRawCommitResponse,
  isRawPreviewResponse,
  MAX_OMO_CANDIDATE_BYTES,
  MAX_OMO_REQUEST_BYTES,
  MISSING_PROJECT_EDITOR_TEXT,
  RAW_COMMIT_CONTRACT_FIXTURE,
  RAW_OMO_MUTATION_KIND,
  RAW_PREVIEW_CONTRACT_FIXTURE,
} from "@omo/shared";
import type { ServerConfig } from "../config";
import { fingerprintAuthorizedSource } from "../omo-schema/fingerprint";
import { RevisionStore } from "./revisions";
import { hashContent } from "./jsonc-edit";
import {
  applyRawMutation,
  compareRawSource,
  getOmoRevisionDetail,
  listOmoRevisions,
  loadRawSource,
  schemaIdentityFor,
  simulateRawMutation,
} from "./raw";
import {
  handleRawConfigRoutes,
  parseRawMutationBody,
  readBoundedJson,
  type RawConfigRouteDeps,
} from "./raw-routes";
import { createSourceWatcher } from "./source-watcher";

const ROOT = join(import.meta.dir, "../../test/raw-d3-sandbox");
const REAL_CONFIG_DIR =
  process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), ".config", "opencode");
const REAL_SCHEMA_PATH = join(
  REAL_CONFIG_DIR,
  "node_modules",
  "oh-my-opencode-slim",
  "oh-my-opencode-slim.schema.json",
);
const REAL_PKG_PATH = join(
  REAL_CONFIG_DIR,
  "node_modules",
  "oh-my-opencode-slim",
  "package.json",
);
const REAL_SCHEMA_TEXT = existsSync(REAL_SCHEMA_PATH)
  ? readFileSync(REAL_SCHEMA_PATH, "utf-8")
  : null;
const REAL_PKG_TEXT = existsSync(REAL_PKG_PATH)
  ? readFileSync(REAL_PKG_PATH, "utf-8")
  : '{"version":"2.2.10"}';
const realTest = REAL_SCHEMA_TEXT ? test : test.skip;

const USER_TEXT = `{
  // keep me
  "preset": "openai",
  "compactSidebar": true,
  "unknownGlobalKeep": true,
  "companion": { "enabled": false }
}
`;

function installVerifiedSchema(userDir: string): void {
  const dir = join(userDir, "node_modules", "oh-my-opencode-slim");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), REAL_PKG_TEXT);
  writeFileSync(join(dir, "oh-my-opencode-slim.schema.json"), REAL_SCHEMA_TEXT!);
}

function fresh(opts?: {
  schema?: "verified" | "none";
  userText?: string;
  projectText?: string;
  json?: boolean;
}) {
  rmSync(ROOT, { recursive: true, force: true });
  const userDir = join(ROOT, "cfg");
  const projDir = join(ROOT, "proj");
  mkdirSync(userDir, { recursive: true });
  mkdirSync(join(projDir, "data"), { recursive: true });
  if ((opts?.schema ?? "verified") === "verified" && REAL_SCHEMA_TEXT) {
    installVerifiedSchema(userDir);
  }
  const userFile = join(
    userDir,
    opts?.json ? "oh-my-opencode-slim.json" : "oh-my-opencode-slim.jsonc",
  );
  writeFileSync(userFile, opts?.userText ?? USER_TEXT);
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

function routeDeps(s: ReturnType<typeof fresh>): RawConfigRouteDeps {
  return {
    cfg: s.cfg,
    revisions: s.revisions,
    sourceGeneration: () => 3,
  };
}

function urlOf(pathname: string, query = ""): URL {
  return new URL(`http://localhost${pathname}${query}`);
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("raw load", () => {
  realTest("returns exact UTF-8 text, fingerprint, schema key, diagnostics", () => {
    const s = fresh();
    const r = loadRawSource(s.cfg, "user-omo", s.revisions, 4);
    expect(r.ok).toBe(true);
    expect(r.sourceId).toBe("user-omo");
    expect(r.text).toBe(USER_TEXT);
    expect(r.fingerprint.exists).toBe(true);
    expect(r.fingerprint.sha256).toBe(hashContent(USER_TEXT));
    expect(r.fingerprint.format).toBe("jsonc");
    expect(r.fingerprint.generation).toBe(4);
    expect(r.syntax.ok).toBe(true);
    expect(r.schema.available).toBe(true);
    expect(r.schema.cacheKey).toBeDefined();
    expect(r.path).toBe(s.userFile);
    expect(existsSync(join(s.projDir, "data", "sim"))).toBe(false);
  });

  realTest("invalid current still 200 with exact text and diagnostics", () => {
    const s = fresh({
      userText: `{
  // keep
  broken
}
`,
    });
    const r = loadRawSource(s.cfg, "user-omo", s.revisions);
    expect(r.ok).toBe(true);
    expect(r.text).toContain("broken");
    expect(r.syntax.ok).toBe(false);
    expect(r.effectiveResolutionAvailable).toBe(false);
  });

  realTest("missing project source is absent + {}\\n and creates nothing", () => {
    const s = fresh();
    const r = loadRawSource(s.cfg, "project-omo", s.revisions);
    expect(r.exists).toBe(false);
    expect(r.format).toBe("jsonc");
    expect(r.text).toBe(MISSING_PROJECT_EDITOR_TEXT);
    expect(r.createOnApplyOnly).toBe(true);
    expect(existsSync(join(s.projDir, ".opencode"))).toBe(false);
  });

  test("schema unavailable still reads and closes write capability", () => {
    const s = fresh({ schema: "none" });
    const r = loadRawSource(s.cfg, "user-omo", s.revisions);
    expect(r.ok).toBe(true);
    expect(r.text).toBe(USER_TEXT);
    expect(r.schema.available).toBe(false);
    expect(r.writeCapability).toBe("closed");
  });
});

describe("raw simulate/apply", () => {
  realTest("valid candidate Preview/Apply preserves exact supplied bytes", () => {
    const s = fresh();
    const candidate = `{
  // keep me
  "preset": "openai",
  "compactSidebar": false,
  "unknownGlobalKeep": true,
  "companion": { "enabled": false }
}
`;
    const fp = fingerprintAuthorizedSource(s.cfg, "user", 0);
    const preview = simulateRawMutation(
      s.cfg,
      { sourceId: "user-omo", expectedSource: fp, candidateText: candidate },
      s.revisions,
    );
    expect(isRawPreviewResponse(preview)).toBe(true);
    expect(isRawPreviewResponse(RAW_PREVIEW_CONTRACT_FIXTURE)).toBe(true);
    expect(preview.ok).toBe(true);
    expect(preview.canApply).toBe(true);
    expect(preview.liveUnchangedNote.length).toBeGreaterThan(0);
    expect(preview.effectiveChanges.some((c) => c.path === "compactSidebar")).toBe(
      true,
    );
    expect(readFileSync(s.userFile, "utf-8")).toBe(USER_TEXT);
    const commit = applyRawMutation(
      s.cfg,
      {
        sourceId: "user-omo",
        expectedSource: fp,
        candidateText: candidate,
        expectedCandidateSha256: preview.candidateSha256,
      },
      s.revisions,
    );
    expect(isRawCommitResponse(commit)).toBe(true);
    expect(isRawCommitResponse(RAW_COMMIT_CONTRACT_FIXTURE)).toBe(true);
    expect(commit.ok).toBe(true);
    expect(readFileSync(s.userFile, "utf-8")).toBe(candidate);
    expect(s.revisions.list()[0]?.mutationKind).toBe(RAW_OMO_MUTATION_KIND);
  });

  realTest("jsonc comments are valid; json comments are invalid", () => {
    const jsonc = fresh();
    const commented = `{
  // comment stays
  "compactSidebar": false,
  "companion": { "enabled": false }
}
`;
    const p = simulateRawMutation(
      jsonc.cfg,
      {
        sourceId: "user-omo",
        expectedSource: fingerprintAuthorizedSource(jsonc.cfg, "user", 0),
        candidateText: commented,
      },
      jsonc.revisions,
    );
    expect(p.ok).toBe(true);

    const json = fresh({
      json: true,
      userText: `{"compactSidebar":true,"companion":{"enabled":false}}\n`,
    });
    const bad = simulateRawMutation(
      json.cfg,
      {
        sourceId: "user-omo",
        expectedSource: fingerprintAuthorizedSource(json.cfg, "user", 0),
        candidateText: commented,
      },
      json.revisions,
    );
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe("syntax-invalid");
  });

  realTest("unrelated schema-invalid current can be repaired by valid candidate", () => {
    const s = fresh({
      userText: `{
  "agents": { "critic": { "model": { "id": "x/y", "variant": "high" } } },
  "companion": { "enabled": false }
}
`,
    });
    const candidate = `{
  "compactSidebar": true,
  "companion": { "enabled": false }
}
`;
    const fp = fingerprintAuthorizedSource(s.cfg, "user", 0);
    const preview = simulateRawMutation(
      s.cfg,
      { sourceId: "user-omo", expectedSource: fp, candidateText: candidate },
      s.revisions,
    );
    expect(preview.ok).toBe(true);
    const commit = applyRawMutation(
      s.cfg,
      {
        sourceId: "user-omo",
        expectedSource: fp,
        candidateText: candidate,
        expectedCandidateSha256: preview.candidateSha256,
      },
      s.revisions,
    );
    expect(commit.ok).toBe(true);
    expect(readFileSync(s.userFile, "utf-8")).toBe(candidate);
  });

  realTest("unparseable current with unproven Companion is rejected", () => {
    const s = fresh({ userText: `{ broken` });
    const candidate = `{
  "compactSidebar": true
}
`;
    const preview = simulateRawMutation(
      s.cfg,
      {
        sourceId: "user-omo",
        expectedSource: fingerprintAuthorizedSource(s.cfg, "user", 0),
        candidateText: candidate,
      },
      s.revisions,
    );
    expect(preview.ok).toBe(false);
    expect(preview.code).toBe("companion-read-only");
    expect(readFileSync(s.userFile, "utf-8")).toBe(`{ broken`);
    expect(s.revisions.list().length).toBe(0);
  });

  realTest("unparseable current with proven unchanged Companion can repair", () => {
    const s = fresh({
      userText: `{
  "companion": { "enabled": false },
  broken
}
`,
    });
    const candidate = `{
  "compactSidebar": true,
  "companion": { "enabled": false }
}
`;
    const fp = fingerprintAuthorizedSource(s.cfg, "user", 0);
    const preview = simulateRawMutation(
      s.cfg,
      { sourceId: "user-omo", expectedSource: fp, candidateText: candidate },
      s.revisions,
    );
    expect(preview.ok).toBe(true);
    const commit = applyRawMutation(
      s.cfg,
      {
        sourceId: "user-omo",
        expectedSource: fp,
        candidateText: candidate,
        expectedCandidateSha256: preview.candidateSha256,
      },
      s.revisions,
    );
    expect(commit.ok).toBe(true);
    expect(readFileSync(s.userFile, "utf-8")).toBe(candidate);
  });

  realTest("invalid candidate never writes temp/rename", () => {
    const s = fresh();
    const preview = simulateRawMutation(
      s.cfg,
      {
        sourceId: "user-omo",
        expectedSource: fingerprintAuthorizedSource(s.cfg, "user", 0),
        candidateText: `{ "compactSidebar": "nope", "companion": { "enabled": false } }`,
      },
      s.revisions,
    );
    expect(preview.ok).toBe(false);
    expect(preview.code).toBe("schema-invalid");
    expect(readFileSync(s.userFile, "utf-8")).toBe(USER_TEXT);
    expect(s.revisions.list().length).toBe(0);
  });

  realTest("stale fingerprint and schema-key conflict 409, no write", () => {
    const s = fresh();
    const live = fingerprintAuthorizedSource(s.cfg, "user", 0);
    const stale = simulateRawMutation(
      s.cfg,
      {
        sourceId: "user-omo",
        expectedSource: { ...live, sha256: "deadbeef" },
        candidateText: USER_TEXT.replace("true", "false"),
      },
      s.revisions,
    );
    expect(stale.code).toBe("stale-source");
    const schema = schemaIdentityFor(s.cfg);
    const key = simulateRawMutation(
      s.cfg,
      {
        sourceId: "user-omo",
        expectedSource: live,
        candidateText: USER_TEXT.replace("true", "false"),
        expectedSchemaCacheKey: `${schema.cacheKey}-old`,
      },
      s.revisions,
    );
    expect(key.code).toBe("stale-source");
    expect(readFileSync(s.userFile, "utf-8")).toBe(USER_TEXT);
  });

  realTest("schema unavailable disables simulate/apply", () => {
    const s = fresh({ schema: "none" });
    const preview = simulateRawMutation(
      s.cfg,
      {
        sourceId: "user-omo",
        expectedSource: fingerprintAuthorizedSource(s.cfg, "user", 0),
        candidateText: USER_TEXT,
      },
      s.revisions,
    );
    expect(preview.ok).toBe(false);
    expect(preview.code).toBe("schema-unavailable");
    expect(preview.canApply).toBe(false);
  });

  realTest("project create-on-apply only; Preview creates nothing", () => {
    const s = fresh();
    const fp = fingerprintAuthorizedSource(s.cfg, "project", 0);
    const candidate = `{
  "interview": { "maxQuestions": 4 }
}
`;
    const preview = simulateRawMutation(
      s.cfg,
      { sourceId: "project-omo", expectedSource: fp, candidateText: candidate },
      s.revisions,
    );
    expect(preview.ok).toBe(true);
    expect(preview.target.createOnApplyOnly).toBe(true);
    expect(preview.effectiveChanges.some((c) => c.path === "interview.maxQuestions")).toBe(
      true,
    );
    expect(existsSync(join(s.projDir, ".opencode"))).toBe(false);
    const commit = applyRawMutation(
      s.cfg,
      {
        sourceId: "project-omo",
        expectedSource: fp,
        candidateText: candidate,
        expectedCandidateSha256: preview.candidateSha256,
      },
      s.revisions,
    );
    expect(commit.ok).toBe(true);
    expect(
      readFileSync(
        join(s.projDir, ".opencode", "oh-my-opencode-slim.jsonc"),
        "utf-8",
      ),
    ).toBe(candidate);
  });

  realTest("direct/override/project/array/preset/capability/Council/Interview/custom-agent impacts", () => {
    const s = fresh({
      userText: `{
  "preset": "openai",
  "presets": {
    "openai": { "explorer": { "model": "openai/ex" } }
  },
  "agents": {
    "explorer": { "model": "root/ex" },
    "my-specialist": { "model": "x/y", "description": "custom" }
  },
  "disabled_skills": ["old"],
  "council": { "presets": { "default": { "alpha": { "model": "x/y" } } } },
  "acpAgents": { "claude": { "command": "claude" } },
  "interview": { "maxQuestions": 2 },
  "companion": { "enabled": false }
}
`,
    });
    const candidate = `{
  "preset": "openai",
  "presets": {
    "openai": { "explorer": { "model": "openai/ex2" } }
  },
  "agents": {
    "explorer": { "model": ["root/ex", "root/fb"] },
    "my-specialist": { "model": "x/z", "description": "custom" }
  },
  "disabled_skills": ["new"],
  "council": { "presets": { "default": { "alpha": { "model": "x/z" } } } },
  "acpAgents": { "claude": { "command": "claude2" } },
  "interview": { "maxQuestions": 6 },
  "companion": { "enabled": false }
}
`;
    const preview = simulateRawMutation(
      s.cfg,
      {
        sourceId: "user-omo",
        expectedSource: fingerprintAuthorizedSource(s.cfg, "user", 0),
        candidateText: candidate,
      },
      s.revisions,
    );
    if (!preview.ok) {
      throw new Error(`semantic preview failed: ${preview.code} ${preview.errors.join(" | ")}`);
    }
    expect(preview.ok).toBe(true);
    expect(preview.semanticSummaries.presets.changed).toBe(true);
    expect(preview.semanticSummaries.capabilities.changed).toBe(true);
    expect(preview.semanticSummaries.council.changed).toBe(true);
    expect(preview.semanticSummaries.acp.changed).toBe(true);
    expect(preview.semanticSummaries.interview.changed).toBe(true);
    expect(preview.semanticSummaries.customAgents.changed).toBe(true);
    expect(
      preview.effectiveChanges.some((c) => c.path.includes("agents.explorer.model")),
    ).toBe(true);
    expect(preview.provenanceChanges.length).toBeGreaterThan(0);
  });
});

describe("raw routes", () => {
  realTest("handler serialize + contract + SHA + path rejection + size cap", async () => {
    const s = fresh();
    const loadRes = await handleRawConfigRoutes(
      routeDeps(s),
      new Request("http://localhost/api/config/raw?sourceId=user-omo"),
      urlOf("/api/config/raw", "?sourceId=user-omo"),
    );
    expect(loadRes!.status).toBe(200);
    const loaded = (await loadRes!.json()) as { text: string; fingerprint: never };

    const pathRes = await handleRawConfigRoutes(
      routeDeps(s),
      new Request("http://localhost/api/config/raw/simulate", {
        method: "POST",
        body: JSON.stringify({
          sourceId: "user-omo",
          path: "/etc/passwd",
          expectedSource: loaded.fingerprint,
          candidateText: USER_TEXT,
        }),
      }),
      urlOf("/api/config/raw/simulate"),
    );
    expect(pathRes!.status).toBe(400);

    const parsed = parseRawMutationBody({
      sourceId: "user-omo",
      expectedSource: loaded.fingerprint,
      candidateText: USER_TEXT.replace("true", "false"),
    });
    expect(parsed.ok).toBe(true);

    const simRes = await handleRawConfigRoutes(
      routeDeps(s),
      new Request("http://localhost/api/config/raw/simulate", {
        method: "POST",
        body: JSON.stringify({
          sourceId: "user-omo",
          expectedSource: loaded.fingerprint,
          candidateText: USER_TEXT.replace("true", "false"),
        }),
      }),
      urlOf("/api/config/raw/simulate"),
    );
    const sim = (await simRes!.json()) as unknown;
    expect(isRawPreviewResponse(sim)).toBe(true);

    const missing = await handleRawConfigRoutes(
      routeDeps(s),
      new Request("http://localhost/api/config/raw/apply", {
        method: "POST",
        body: JSON.stringify({
          sourceId: "user-omo",
          expectedSource: loaded.fingerprint,
          candidateText: USER_TEXT.replace("true", "false"),
        }),
      }),
      urlOf("/api/config/raw/apply"),
    );
    expect(missing!.status).toBe(400);
    const missingJson = (await missing!.json()) as unknown;
    expect(isRawCommitResponse(missingJson)).toBe(true);

    const huge = "x".repeat(MAX_OMO_CANDIDATE_BYTES + 8);
    const over = await handleRawConfigRoutes(
      routeDeps(s),
      new Request("http://localhost/api/config/raw/compare", {
        method: "POST",
        body: JSON.stringify({ sourceId: "user-omo", draftText: huge }),
      }),
      urlOf("/api/config/raw/compare"),
    );
    expect(over!.status).toBe(413);
  });

  test("oversized Content-Length is 413 without consuming the body", async () => {
    let bodyAccessed = 0;
    const req = {
      headers: new Headers({
        "content-length": String(MAX_OMO_REQUEST_BYTES + 1),
      }),
      get body() {
        bodyAccessed += 1;
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
          },
        });
      },
    } as Request;
    const parsed = await readBoundedJson(req);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.status).toBe(413);
      expect(parsed.code).toBe("oversize");
    }
    expect(bodyAccessed).toBe(0);

    const s = fresh();
    const before = readFileSync(s.userFile, "utf-8");
    const res = await handleRawConfigRoutes(
      routeDeps(s),
      new Request("http://localhost/api/config/raw/apply", {
        method: "POST",
        headers: { "content-length": String(MAX_OMO_REQUEST_BYTES + 1) },
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
          },
        }),
      }),
      urlOf("/api/config/raw/apply"),
    );
    expect(res!.status).toBe(413);
    const j = (await res!.json()) as unknown;
    expect(isRawCommitResponse(j)).toBe(true);
    expect(readFileSync(s.userFile, "utf-8")).toBe(before);
  });

  test("chunked body crossing the request cap is 413 and writes nothing", async () => {
    const s = fresh();
    const before = readFileSync(s.userFile, "utf-8");
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    let remaining = MAX_OMO_REQUEST_BYTES + chunk.byteLength;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining <= 0) {
          controller.close();
          return;
        }
        const next = remaining > chunk.byteLength ? chunk : chunk.subarray(0, remaining);
        remaining -= next.byteLength;
        controller.enqueue(next);
      },
    });
    const res = await handleRawConfigRoutes(
      routeDeps(s),
      new Request("http://localhost/api/config/raw/simulate", {
        method: "POST",
        body,
      }),
      urlOf("/api/config/raw/simulate"),
    );
    expect(res!.status).toBe(413);
    const j = (await res!.json()) as unknown;
    expect(isRawPreviewResponse(j)).toBe(true);
    expect(readFileSync(s.userFile, "utf-8")).toBe(before);
  });

  test("exact-at-limit request body is accepted then JSON-parsed", async () => {
    const exact = `{${" ".repeat(MAX_OMO_REQUEST_BYTES - 2)}}`;
    expect(Buffer.byteLength(exact, "utf-8")).toBe(MAX_OMO_REQUEST_BYTES);
    const parsed = await readBoundedJson(
      new Request("http://localhost/api/config/raw/compare", {
        method: "POST",
        body: exact,
      }),
    );
    expect(parsed.ok).toBe(true);
  });

  test("malformed JSON under the byte cap is 400 and client-readable", async () => {
    const s = fresh();
    const before = readFileSync(s.userFile, "utf-8");
    const sim = await handleRawConfigRoutes(
      routeDeps(s),
      new Request("http://localhost/api/config/raw/simulate", {
        method: "POST",
        body: "{not json",
      }),
      urlOf("/api/config/raw/simulate"),
    );
    expect(sim!.status).toBe(400);
    expect(isRawPreviewResponse(await sim!.json())).toBe(true);
    const apply = await handleRawConfigRoutes(
      routeDeps(s),
      new Request("http://localhost/api/config/raw/apply", {
        method: "POST",
        body: "{not json",
      }),
      urlOf("/api/config/raw/apply"),
    );
    expect(apply!.status).toBe(400);
    expect(isRawCommitResponse(await apply!.json())).toBe(true);
    expect(readFileSync(s.userFile, "utf-8")).toBe(before);
  });

  realTest("compare is read-only", async () => {
    const s = fresh();
    const before = readFileSync(s.userFile, "utf-8");
    const res = await handleRawConfigRoutes(
      routeDeps(s),
      new Request("http://localhost/api/config/raw/compare", {
        method: "POST",
        body: JSON.stringify({ sourceId: "user-omo", draftText: "{}\n" }),
      }),
      urlOf("/api/config/raw/compare"),
    );
    expect(res!.status).toBe(200);
    expect(readFileSync(s.userFile, "utf-8")).toBe(before);
  });
});

describe("OMO revisions", () => {
  realTest("list/detail/restore through transaction; historical invalid inspectable", async () => {
    const s = fresh();
    const fp = fingerprintAuthorizedSource(s.cfg, "user", 0);
    const candidate = USER_TEXT.replace("true", "false");
    const preview = simulateRawMutation(
      s.cfg,
      { sourceId: "user-omo", expectedSource: fp, candidateText: candidate },
      s.revisions,
    );
    const commit = applyRawMutation(
      s.cfg,
      {
        sourceId: "user-omo",
        expectedSource: fp,
        candidateText: candidate,
        expectedCandidateSha256: preview.candidateSha256,
      },
      s.revisions,
    );
    expect(commit.ok).toBe(true);
    const listed = listOmoRevisions(s.cfg, "user-omo", s.revisions);
    expect(listed[0]?.kindLabel).toBe(RAW_OMO_MUTATION_KIND);
    const detail = getOmoRevisionDetail(s.cfg, listed[0]!.id, s.revisions);
    expect(detail.ok).toBe(true);
    if (detail.ok) {
      expect(detail.detail.beforeContent).toBe(USER_TEXT);
      expect(detail.detail.afterContent).toBe(candidate);
      expect(detail.detail.restoreEligible).toBe(true);
    }

    s.revisions.insert({
      id: "rev_hist_invalid",
      timestamp: new Date().toISOString(),
      targetPath: s.userFile,
      scope: "user",
      oldHash: "a",
      newHash: "b",
      mutationKind: RAW_OMO_MUTATION_KIND,
      mutationJson: "{}",
      beforeContent: `{ "agents": { "critic": { "model": { "id": "x/y" } } } }`,
      afterContent: `{ "agents": { "critic": { "model": { "id": "x/y" } } } }`,
      state: "committed",
    });
    const hist = getOmoRevisionDetail(s.cfg, "rev_hist_invalid", s.revisions);
    expect(hist.ok).toBe(true);
    if (hist.ok) {
      expect(hist.detail.currentSchemaCompatible).toBe(false);
      expect(hist.detail.restoreEligible).toBe(false);
    }

    const afterFp = fingerprintAuthorizedSource(s.cfg, "user", 3);
    const restoreSim = await handleRawConfigRoutes(
      routeDeps(s),
      new Request(
        `http://localhost/api/config/omo-revisions/${listed[0]!.id}/simulate-restore`,
        {
          method: "POST",
          body: JSON.stringify({ expectedSource: afterFp }),
        },
      ),
      urlOf(`/api/config/omo-revisions/${listed[0]!.id}/simulate-restore`),
    );
    const restorePreview = (await restoreSim!.json()) as {
      ok: boolean;
      candidateSha256?: string;
    };
    expect(restorePreview.ok).toBe(true);
    const restoreRes = await handleRawConfigRoutes(
      routeDeps(s),
      new Request(
        `http://localhost/api/config/omo-revisions/${listed[0]!.id}/restore`,
        {
          method: "POST",
          body: JSON.stringify({
            expectedSource: afterFp,
            expectedCandidateSha256: restorePreview.candidateSha256,
          }),
        },
      ),
      urlOf(`/api/config/omo-revisions/${listed[0]!.id}/restore`),
    );
    expect(restoreRes!.status).toBe(200);
    expect(readFileSync(s.userFile, "utf-8")).toBe(USER_TEXT);
  });
});

describe("source watcher", () => {
  realTest("emits coalesced config.sources.changed and marks own apply", async () => {
    const s = fresh();
    const events: Array<{ type: string; ownApply?: boolean }> = [];
    const watcher = createSourceWatcher({
      cfg: s.cfg,
      coalesceMs: 10,
      emit(e) {
        events.push(e);
      },
    });
    watcher.start();
    writeFileSync(s.userFile, USER_TEXT.replace("true", "false"));
    await Bun.sleep(40);
    expect(events.some((e) => e.type === "config.sources.changed")).toBe(true);
    const after = fingerprintAuthorizedSource(s.cfg, "user", 0);
    watcher.noteOwnApply("user-omo", after.sha256);
    writeFileSync(s.userFile, USER_TEXT.replace("true", "false"));
    await Bun.sleep(40);
    expect(events.some((e) => e.ownApply === true)).toBe(true);
    watcher.stop();
  });

  realTest("own user apply does not mask a simultaneous project change", async () => {
    const s = fresh({
      projectText: `{
  "interview": { "maxQuestions": 3 }
}
`,
    });
    const events: Array<{
      ownApply?: boolean;
      ownApplyBySource?: Record<string, boolean>;
    }> = [];
    const watcher = createSourceWatcher({
      cfg: s.cfg,
      coalesceMs: 10,
      emit(e) {
        events.push(e);
      },
    });
    watcher.start();
    const userAfter = USER_TEXT.replace("true", "false");
    writeFileSync(s.userFile, userAfter);
    watcher.noteOwnApply("user-omo", hashContent(userAfter));
    writeFileSync(
      join(s.projDir, ".opencode", "oh-my-opencode-slim.jsonc"),
      `{
  "interview": { "maxQuestions": 8 }
}
`,
    );
    await Bun.sleep(40);
    const mixed = events.find(
      (e) => e.ownApplyBySource?.["user-omo"] === true,
    );
    expect(mixed).toBeDefined();
    expect(mixed!.ownApplyBySource?.["user-omo"]).toBe(true);
    expect(mixed!.ownApplyBySource?.["project-omo"]).toBe(false);
    expect(mixed!.ownApply).toBe(false);
    watcher.stop();
  });
});

describe("raw writer boundary", () => {
  test("raw.ts does not physically write", () => {
    const src = readFileSync(join(import.meta.dir, "raw.ts"), "utf-8");
    for (const token of [
      "writeFileSync",
      "renameSync",
      "unlinkSync",
      "mkdirSync",
    ]) {
      expect(src.includes(token)).toBe(false);
    }
    expect(src).toMatch(/previewOmoCandidate|previewThenCommit/);
  });
});
