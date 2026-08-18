import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProvenance } from "./provenance";
import {
  buildInterviewState,
  INTERVIEW_FIELD_METADATA,
  INTERVIEW_FIELDS,
  normalizeOutputFolder,
  resolveInterviewTypedCapability,
  DEFAULT_DASHBOARD_PORT,
} from "./interview";
import {
  AUDITED_INTERVIEW_FIELD_NAMES,
  AUDITED_INTERVIEW_PACKAGE_VERSION,
  AUDITED_INTERVIEW_SCHEMA_HASH,
} from "../omo-schema/introspect";

const ROOT = join(import.meta.dir, "../../test/interview-sandbox");

const VERIFIED_FIELDS_SORTED = [
  "autoOpenBrowser",
  "dashboard",
  "maxQuestions",
  "outputFolder",
  "port",
];

function setup(
  user?: Record<string, unknown>,
  project?: Record<string, unknown>,
) {
  rmSync(ROOT, { recursive: true, force: true });
  const userDir = join(ROOT, "cfg");
  const projDir = join(ROOT, "proj");
  mkdirSync(userDir, { recursive: true });
  mkdirSync(projDir, { recursive: true });
  mkdirSync(join(projDir, ".opencode"), { recursive: true });
  if (user) {
    writeFileSync(
      join(userDir, "oh-my-opencode-slim.json"),
      JSON.stringify(user, null, 2),
    );
  }
  if (project) {
    writeFileSync(
      join(projDir, ".opencode", "oh-my-opencode-slim.json"),
      JSON.stringify(project, null, 2),
    );
  }
  const bundle = resolveProvenance({
    opencodeConfigDir: userDir,
    projectDirectory: projDir,
    authorizedRoots: [userDir, projDir],
  });
  return { bundle, userDir, projDir };
}

describe("interview field catalog (source authority)", () => {
  test("exact 5-field catalog frozen, in order", () => {
    expect(Object.keys(INTERVIEW_FIELDS)).toEqual([
      "maxQuestions",
      "outputFolder",
      "autoOpenBrowser",
      "port",
      "dashboard",
    ]);
  });

  test("regression guard: exactly the verified installed fields", () => {
    expect([...Object.keys(INTERVIEW_FIELDS)].sort()).toEqual(
      VERIFIED_FIELDS_SORTED,
    );
  });

  test("verified defaults/ranges", () => {
    expect(INTERVIEW_FIELDS.maxQuestions?.defaultValue).toBe(2);
    expect(INTERVIEW_FIELDS.maxQuestions?.minimum).toBe(1);
    expect(INTERVIEW_FIELDS.maxQuestions?.maximum).toBe(10);
    expect(INTERVIEW_FIELDS.outputFolder?.defaultValue).toBe("interview");
    expect(INTERVIEW_FIELDS.autoOpenBrowser?.defaultValue).toBe(true);
    expect(INTERVIEW_FIELDS.port?.defaultValue).toBe(0);
    expect(INTERVIEW_FIELDS.port?.minimum).toBe(0);
    expect(INTERVIEW_FIELDS.port?.maximum).toBe(65535);
    expect(INTERVIEW_FIELDS.dashboard?.defaultValue).toBe(false);
  });

  test("D0 field metadata matches installed 2.2.10 InterviewConfigSchema", () => {
    expect(INTERVIEW_FIELD_METADATA.map((f) => f.name)).toEqual([
      ...AUDITED_INTERVIEW_FIELD_NAMES,
    ]);
    expect(INTERVIEW_FIELD_METADATA[0]).toMatchObject({
      name: "maxQuestions",
      schemaType: "integer",
      defaultValue: 2,
      minimum: 1,
      maximum: 10,
    });
    expect(INTERVIEW_FIELD_METADATA[1]).toMatchObject({
      name: "outputFolder",
      schemaType: "string",
      defaultValue: "interview",
      minLength: 1,
    });
  });
});

describe("interview state: no config", () => {
  const { bundle, userDir, projDir } = setup();
  const st = buildInterviewState(bundle, projDir, [userDir, projDir], {});

  test("desired null, effective all defaults", () => {
    expect(st.desired).toBeNull();
    expect(st.effective).toEqual({
      maxQuestions: 2,
      outputFolder: "interview",
      autoOpenBrowser: true,
      port: 0,
      dashboard: false,
    });
    expect(st.warnings).toEqual([]);
  });

  test("per-session server mode with OS-assigned port", () => {
    expect(st.server.mode).toBe("per-session");
    expect(st.server.bindHost).toBe("127.0.0.1");
    expect(st.server.configuredPort).toBe(0);
    expect(st.server.portMeaning).toContain("OS-assigned");
    expect(st.server.defaultDashboardPort).toBe(43211);
    expect(st.server.dashboardDerived).toEqual({ enabled: false, via: "no" });
  });

  test("browser auto-open default, no automated suppression with clean env", () => {
    expect(st.server.browser.autoOpen).toBe(true);
    expect(st.server.browser.autoDisabledInAutomated).toBe(false);
    expect(st.server.notes.some((n) => n.includes("auto-disabled"))).toBe(false);
  });

  test("all 5 properties synthesized as builtin leaves", () => {
    for (const f of VERIFIED_FIELDS_SORTED) {
      const p = st.properties[`interview.${f}`];
      expect(p).toBeDefined();
      expect(p?.winner.stage).toBe("builtin");
      expect(p?.winner.sourceId).toBe("builtin");
      expect(p?.overridden).toEqual([]);
    }
  });

  test("output resolution under project root, never inspected", () => {
    expect(st.output.configuredFolder).toBe("interview");
    expect(st.output.normalizedFolder).toBe("interview");
    expect(st.output.resolvedPath).toBe(join(projDir, "interview"));
    expect(st.output.withinAuthorizedScope).toBe(true);
    expect(st.output.inspected).toBe(false);
    expect(st.output.exists).toBeNull();
  });

  test("runtime not observable; invocation is a command", () => {
    expect(st.runtime.observable).toBe(false);
    expect(st.runtime.reasonUnavailable.length).toBeGreaterThan(0);
    expect(st.invocation.mechanism).toBe("command");
    expect(st.invocation.name).toBe("/interview");
    expect(st.server.notes.some((n) => n.includes("command, not a tool"))).toBe(true);
    expect(st.server.notes.some((n) => n.includes("never closed"))).toBe(true);
    expect(st.server.notes.some((n) => n.includes("under the project root"))).toBe(true);
  });
});

describe("interview validation warnings (zod semantics)", () => {
  test("maxQuestions out of range / non-integer warns and falls back", () => {
    for (const bad of [0, 11, 1.5, "two"]) {
      const { bundle, userDir, projDir } = setup({ interview: { maxQuestions: bad } });
      const st = buildInterviewState(bundle, projDir, [userDir, projDir], {});
      expect(st.effective.maxQuestions).toBe(2);
      expect(st.warnings.some((w) => w.includes("maxQuestions"))).toBe(true);
    }
  });

  test("port out of range / non-integer warns and falls back to 0", () => {
    for (const bad of [-1, 65536, 1.5]) {
      const { bundle, userDir, projDir } = setup({ interview: { port: bad } });
      const st = buildInterviewState(bundle, projDir, [userDir, projDir], {});
      expect(st.effective.port).toBe(0);
      expect(st.warnings.some((w) => w.includes("port"))).toBe(true);
      expect(st.server.mode).toBe("per-session");
    }
  });

  test("outputFolder empty string warns (minLen 1)", () => {
    const { bundle, userDir, projDir } = setup({ interview: { outputFolder: "" } });
    const st = buildInterviewState(bundle, projDir, [userDir, projDir], {});
    expect(st.warnings.some((w) => w.includes("outputFolder"))).toBe(true);
    expect(st.effective.outputFolder).toBe("interview");
  });

  test("valid maxQuestions accepted", () => {
    const { bundle, userDir, projDir } = setup({ interview: { maxQuestions: 7 } });
    const st = buildInterviewState(bundle, projDir, [userDir, projDir], {});
    expect(st.effective.maxQuestions).toBe(7);
    expect(st.warnings).toEqual([]);
  });
});

describe("interview server modes", () => {
  test("port > 0 implies dashboard mode via port", () => {
    const { bundle, userDir, projDir } = setup({ interview: { port: 8080 } });
    const st = buildInterviewState(bundle, projDir, [userDir, projDir], {});
    expect(st.server.mode).toBe("dashboard");
    expect(st.server.dashboardDerived).toEqual({ enabled: true, via: "port" });
    expect(st.server.configuredPort).toBe(8080);
    expect(st.server.portMeaning).toBe("Configured dashboard port (8080)");
  });

  test("dashboard explicit with port 0 reports installed default dashboard port", () => {
    const { bundle, userDir, projDir } = setup({ interview: { dashboard: true } });
    const st = buildInterviewState(bundle, projDir, [userDir, projDir], {});
    expect(st.server.mode).toBe("dashboard");
    expect(st.server.dashboardDerived).toEqual({ enabled: true, via: "explicit" });
    expect(st.server.configuredPort).toBe(0);
    expect(st.server.defaultDashboardPort).toBe(DEFAULT_DASHBOARD_PORT);
    expect(st.server.portMeaning).toBe(
      `Installed default dashboard port (${DEFAULT_DASHBOARD_PORT})`,
    );
    expect(st.server.notes.some((n) => n.includes("43211"))).toBe(true);
  });
});

describe("interview browser automation rule", () => {
  test("NODE_ENV=test reports suppression without flipping effective config", () => {
    const { bundle, userDir, projDir } = setup();
    const st = buildInterviewState(bundle, projDir, [userDir, projDir], {
      NODE_ENV: "test",
    });
    expect(st.effective.autoOpenBrowser).toBe(true);
    expect(st.server.browser.autoOpen).toBe(true);
    expect(st.server.browser.autoDisabledInAutomated).toBe(true);
    expect(st.server.notes.some((n) => n.includes("auto-disabled in automated"))).toBe(true);
  });

  test("truthy CI/BUN_TEST/VITEST/JEST_WORKER_ID each suppress", () => {
    for (const env of [
      { CI: "1" },
      { BUN_TEST: "1" },
      { VITEST: "true" },
      { JEST_WORKER_ID: "2" },
    ]) {
      const { bundle, userDir, projDir } = setup();
      const st = buildInterviewState(bundle, projDir, [userDir, projDir], env);
      expect(st.server.browser.autoDisabledInAutomated).toBe(true);
    }
  });

  test("installed isTruthyEnvFlag: CI/BUN_TEST/VITEST 0/false are not automated", () => {
    for (const env of [
      { CI: "0" },
      { CI: "false" },
      { CI: "FALSE" },
      { BUN_TEST: "0" },
      { BUN_TEST: "False" },
      { VITEST: "0" },
      { VITEST: "false" },
    ]) {
      const { bundle, userDir, projDir } = setup();
      const st = buildInterviewState(bundle, projDir, [userDir, projDir], env);
      expect(st.server.browser.autoDisabledInAutomated).toBe(false);
    }
  });

  test("defined JEST_WORKER_ID including empty string is automated", () => {
    const { bundle, userDir, projDir } = setup();
    const st = buildInterviewState(bundle, projDir, [userDir, projDir], {
      JEST_WORKER_ID: "",
    });
    expect(st.server.browser.autoDisabledInAutomated).toBe(true);
  });

  test("autoOpenBrowser false stays false even in automated env", () => {
    const { bundle, userDir, projDir } = setup({
      interview: { autoOpenBrowser: false },
    });
    const st = buildInterviewState(bundle, projDir, [userDir, projDir], {
      NODE_ENV: "test",
    });
    expect(st.effective.autoOpenBrowser).toBe(false);
    expect(st.server.browser.autoOpen).toBe(false);
    expect(st.server.browser.autoDisabledInAutomated).toBe(true);
  });
});

describe("interview output folder normalization", () => {
  test("strips leading/trailing slashes and trims (installed 28996-28999)", () => {
    expect(normalizeOutputFolder("/reports/")).toBe("reports");
    expect(normalizeOutputFolder("///deep//")).toBe("deep");
    expect(normalizeOutputFolder("plain")).toBe("plain");
    expect(normalizeOutputFolder("")).toBe("interview");
    expect(normalizeOutputFolder("///")).toBe("interview");
    expect(normalizeOutputFolder("  reports  ")).toBe("reports");
  });

  test("absolute configured path neutralized under project root", () => {
    const { bundle, userDir, projDir } = setup({
      interview: { outputFolder: "/etc/interviews/" },
    });
    const st = buildInterviewState(bundle, projDir, [userDir, projDir], {});
    expect(st.output.configuredFolder).toBe("/etc/interviews/");
    expect(st.output.normalizedFolder).toBe("etc/interviews");
    expect(st.output.resolvedPath).toBe(join(projDir, "etc/interviews"));
    expect(st.output.withinAuthorizedScope).toBe(true);
  });
});

describe("interview state: merge + raw", () => {
  const { bundle, userDir, projDir } = setup(
    { interview: { maxQuestions: 5, outputFolder: "a" } },
    { interview: { maxQuestions: 7 } },
  );
  const st = buildInterviewState(bundle, projDir, [userDir, projDir], {});

  test("project overrides user per leaf", () => {
    expect(st.effective.maxQuestions).toBe(7);
    expect(st.effective.outputFolder).toBe("a");
    expect(st.properties["interview.maxQuestions"]?.winner.stage).toBe("project-config");
    expect(st.properties["interview.outputFolder"]?.winner.stage).toBe("user-config");
  });

  test("raw fragments per scope", () => {
    expect(st.raw.user).toEqual({ maxQuestions: 5, outputFolder: "a" });
    expect(st.raw.project).toEqual({ maxQuestions: 7 });
  });

  test("unknown raw field preserved in raw, not effective/fields", () => {
    const s2 = setup({ interview: { magicDashboardMode: true } });
    const st2 = buildInterviewState(
      s2.bundle,
      s2.projDir,
      [s2.userDir, s2.projDir],
      {},
    );
    expect(st2.raw.user?.magicDashboardMode).toBe(true);
    expect("magicDashboardMode" in st2.effective).toBe(false);
    expect("magicDashboardMode" in st2.fields).toBe(false);
    expect(st2.properties["interview.magicDashboardMode"]).toBeUndefined();
  });
});

describe("interview output filesystem boundary", () => {
  test("authorizedRoots excluding project → outside scope, never inspected", () => {
    const { bundle, userDir, projDir } = setup({
      interview: { outputFolder: "reports" },
    });
    const st = buildInterviewState(bundle, projDir, [userDir], {});
    expect(st.output.resolvedPath).toBe(join(projDir, "reports"));
    expect(st.output.withinAuthorizedScope).toBe(false);
    expect(st.output.inspected).toBe(false);
    expect(st.output.exists).toBeNull();
  });

  test("output path is metadata only: injected project dir, zero FS calls", () => {
    const { bundle, userDir } = setup({
      interview: { outputFolder: "injected-out" },
    });
    const injected = "/Users/matt/Repos/omo-slim/__d0-uninspected-interview__";
    const st = buildInterviewState(bundle, injected, [userDir, injected], {});
    expect(st.output.configuredFolder).toBe("injected-out");
    expect(st.output.normalizedFolder).toBe("injected-out");
    expect(st.output.resolvedPath).toBe(join(injected, "injected-out"));
    expect(st.output.inspected).toBe(false);
    expect(st.output.exists).toBeNull();
    expect(existsSync(st.output.resolvedPath)).toBe(false);
    expect(st.restartRequired).toBe(true);
    expect(st.runtimeAction).toBe("none");
    const src = readFileSync(join(import.meta.dir, "interview.ts"), "utf-8");
    expect(src).not.toMatch(/from ["']node:fs["']/);
    expect(src).not.toMatch(/\b(existsSync|statSync|readdirSync|readFileSync)\b/);
  });
});

const REAL_CONFIG_DIR = "/Users/matt/.config/opencode";
const REAL_SCHEMA = join(
  REAL_CONFIG_DIR,
  "node_modules",
  "oh-my-opencode-slim",
  "oh-my-opencode-slim.schema.json",
);
const realTest = existsSync(REAL_SCHEMA) ? test : test.skip;
const SKEW_ROOT = join(import.meta.dir, "../../test/interview-schema-skew");

afterEach(() => {
  rmSync(SKEW_ROOT, { recursive: true, force: true });
});

describe("interview typed capability (version/hash scoped)", () => {
  realTest("current installed 2.2.10 schema enables typed capability", () => {
    const cap = resolveInterviewTypedCapability({
      opencodeConfigDir: REAL_CONFIG_DIR,
      authorizedRoots: [REAL_CONFIG_DIR],
    });
    expect(cap.available).toBe(true);
    expect(cap.packageVersion).toBe(AUDITED_INTERVIEW_PACKAGE_VERSION);
    expect(cap.schemaHash).toBe(AUDITED_INTERVIEW_SCHEMA_HASH);
    expect(cap.installedFields).toEqual([...AUDITED_INTERVIEW_FIELD_NAMES]);
    expect(cap.auditedFields).toEqual([...AUDITED_INTERVIEW_FIELD_NAMES]);
  });

  test("schema unavailable closes typed writes; reads still construct", () => {
    const { bundle, userDir, projDir } = setup();
    const cap = resolveInterviewTypedCapability({
      opencodeConfigDir: userDir,
      authorizedRoots: [userDir, projDir],
    });
    expect(cap.available).toBe(false);
    expect(cap.reason).toBeDefined();

    const st = buildInterviewState(bundle, projDir, [userDir, projDir], {}, {
      cfg: { opencodeConfigDir: userDir, authorizedRoots: [userDir, projDir] },
    });
    expect(st.typedCapability.available).toBe(false);
    expect(st.effective.maxQuestions).toBe(2);
    expect(st.output.inspected).toBe(false);
    expect(st.runtimeAction).toBe("none");
  });

  test("version/hash/field-set skew disables typed writes", () => {
    rmSync(SKEW_ROOT, { recursive: true, force: true });
    const dir = join(SKEW_ROOT, "node_modules", "oh-my-opencode-slim");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "9.9.9-skew" }));
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
    const cap = resolveInterviewTypedCapability({
      opencodeConfigDir: SKEW_ROOT,
      authorizedRoots: [SKEW_ROOT],
    });
    expect(cap.available).toBe(false);
    expect(cap.packageVersion).toBe("9.9.9-skew");
    expect(cap.reason).toMatch(/mismatch/);
    expect(cap.installedFields).toContain("extraField");
  });
});
