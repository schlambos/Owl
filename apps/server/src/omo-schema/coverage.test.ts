/**
 * Slice 18 D4 — installed-schema coverage + source-authority freeze.
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
import { OPTION_CATALOG } from "../omo/catalog";
import {
  _clearAuthorityCache,
  loadInstalledSchema,
} from "./authority";
import {
  AUDITED_INTERVIEW_FIELD_NAMES,
  AUDITED_INTERVIEW_PACKAGE_VERSION,
  AUDITED_INTERVIEW_SCHEMA_HASH,
} from "./introspect";
import {
  auditInputIdentity,
  auditInstalledSchemaCoverage,
  classifyCoveragePath,
  walkInstalledSchemaLeaves,
} from "./coverage";

const REAL_CONFIG_DIR = "/Users/matt/.config/opencode";
const REAL_PKG = join(
  REAL_CONFIG_DIR,
  "node_modules",
  "oh-my-opencode-slim",
  "package.json",
);
const REAL_SCHEMA = join(
  REAL_CONFIG_DIR,
  "node_modules",
  "oh-my-opencode-slim",
  "oh-my-opencode-slim.schema.json",
);
const REAL_AVAILABLE = existsSync(REAL_SCHEMA) && existsSync(REAL_PKG);
const realTest = REAL_AVAILABLE ? test : test.skip;

const ROOT = join(import.meta.dir, "../../test/schema-sandbox/coverage");

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  _clearAuthorityCache();
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("installed coverage walk (live authority)", () => {
  realTest("current 2.2.10 schema classifies every current leaf", () => {
    const snap = loadInstalledSchema({
      opencodeConfigDir: REAL_CONFIG_DIR,
      authorizedRoots: [REAL_CONFIG_DIR, "/Users/matt/Repos/omo-slim"],
    });
    expect(snap.available).toBe(true);
    if (!snap.available) return;
    expect(snap.packageVersion).toBe(AUDITED_INTERVIEW_PACKAGE_VERSION);
    expect(snap.schemaHash).toBe(AUDITED_INTERVIEW_SCHEMA_HASH);
    const audit = auditInstalledSchemaCoverage(snap);
    expect(audit.ok).toBe(true);
    expect(audit.unclassified).toEqual([]);
    expect(audit.topLevel).toEqual([
      "preset",
      "setDefaultAgent",
      "compactSidebar",
      "stripOrchestratorModel",
      "autoUpdate",
      "presets",
      "agents",
      "disabled_agents",
      "image_routing",
      "disabled_mcps",
      "disabled_tools",
      "disabled_skills",
      "multiplexer",
      "interview",
      "backgroundJobs",
      "fallback",
      "council",
      "companion",
      "webfetch",
      "acpAgents",
    ]);
    const paths = audit.entries.map((e) => e.path);
    for (const f of AUDITED_INTERVIEW_FIELD_NAMES) {
      expect(paths).toContain(`interview.${f}`);
    }
    for (const e of audit.entries.filter((x) => x.path.startsWith("companion."))) {
      expect(e.classification).toBe("read-only-companion");
      expect(e.matrix).toBe("Read-only intentionally");
    }
    for (const e of audit.entries.filter((x) => x.path.startsWith("interview."))) {
      expect(e.classification).toBe("typed-editable");
    }
    expect(paths.some((p) => p.includes("opencode.json"))).toBe(false);
    expect(paths.some((p) => p.startsWith("prompt"))).toBe(false);
    expect(audit.entries.find((e) => e.path === "fallback.runtimeOverride")?.classification).toBe(
      "deprecated",
    );
  });

  realTest("catalog Interview/Companion rows stay aligned with installed coverage", () => {
    const snap = loadInstalledSchema({
      opencodeConfigDir: REAL_CONFIG_DIR,
      authorizedRoots: [REAL_CONFIG_DIR, "/Users/matt/Repos/omo-slim"],
    });
    expect(snap.available).toBe(true);
    if (!snap.available) return;
    const audit = auditInstalledSchemaCoverage(snap);
    const interviewCatalog = OPTION_CATALOG.filter((c) =>
      c.path.startsWith("interview."),
    );
    expect(interviewCatalog.map((c) => c.path).sort()).toEqual(
      audit.entries
        .filter((e) => e.path.startsWith("interview."))
        .map((e) => e.path)
        .sort(),
    );
    for (const c of interviewCatalog) {
      expect(c.capabilities.editable).toBe(true);
      expect(c.support).toBe("typed-capable-slice-18");
    }
    const companionCatalog = OPTION_CATALOG.filter((c) =>
      c.path.startsWith("companion."),
    );
    for (const c of companionCatalog) {
      expect(c.capabilities.editable).toBe(false);
      expect(c.support).toBe("read-only-slice-13");
    }
  });
});

describe("source-authority freeze", () => {
  test("version/schema change changes audit input hash; no hardcoded editor schema", () => {
    const dir = join(ROOT, "node_modules", "oh-my-opencode-slim");
    mkdirSync(dir, { recursive: true });
    const schemaA = {
      type: "object",
      properties: {
        compactSidebar: { type: "boolean" },
        interview: {
          type: "object",
          properties: {
            maxQuestions: { type: "integer", default: 2, minimum: 1, maximum: 10 },
            outputFolder: { type: "string", default: "interview", minLength: 1 },
            autoOpenBrowser: { type: "boolean", default: true },
            port: { type: "integer", default: 0, minimum: 0, maximum: 65535 },
            dashboard: { type: "boolean", default: false },
          },
        },
        companion: {
          type: "object",
          properties: { enabled: { type: "boolean" } },
        },
      },
    };
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "2.2.10" }));
    writeFileSync(join(dir, "oh-my-opencode-slim.schema.json"), JSON.stringify(schemaA));
    const a = loadInstalledSchema({
      opencodeConfigDir: ROOT,
      authorizedRoots: [ROOT],
    });
    expect(a.available).toBe(true);
    if (!a.available) return;
    const hashA = auditInputIdentity(a);

    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "2.2.11" }));
    _clearAuthorityCache();
    const b = loadInstalledSchema({
      opencodeConfigDir: ROOT,
      authorizedRoots: [ROOT],
    });
    expect(b.available).toBe(true);
    if (!b.available) return;
    expect(auditInputIdentity(b)).not.toBe(hashA);

    writeFileSync(
      join(dir, "oh-my-opencode-slim.schema.json"),
      JSON.stringify({ ...schemaA, title: "changed" }),
    );
    _clearAuthorityCache();
    const c = loadInstalledSchema({
      opencodeConfigDir: ROOT,
      authorizedRoots: [ROOT],
    });
    expect(c.available).toBe(true);
    if (!c.available) return;
    expect(auditInputIdentity(c)).not.toBe(auditInputIdentity(b));
    expect(c.schemaHash).not.toBe(a.schemaHash);

    const src = readFileSync(
      join(import.meta.dir, "../../../../scripts/audit-installed-omo-schema.ts"),
      "utf-8",
    );
    expect(src).toContain("loadInstalledSchema");
    expect(src).not.toMatch(/https:\/\/json-schema\.org/);
    expect(src.includes("fetch(")).toBe(false);
  });

  test("Companion cannot be classified editable", () => {
    const c = classifyCoveragePath("companion.enabled", true);
    expect(c.classification).toBe("read-only-companion");
    expect(() =>
      classifyCoveragePath("opencode.json.plugin", true),
    ).toThrow(/excluded domain/);
  });

  test("walker emits templates rather than invented keys", () => {
    const leaves = walkInstalledSchemaLeaves({
      type: "object",
      properties: {
        agents: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: { model: { type: "string" } },
          },
        },
      },
    });
    expect(leaves.map((l) => l.path)).toContain("agents.<name>.model");
    expect(leaves.map((l) => l.path)).not.toContain("agents.explorer.model");
  });
});
