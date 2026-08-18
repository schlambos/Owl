import { describe, expect, test, beforeEach } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyGlobal,
  simulateGlobal,
  type GlobalMutation,
} from "./globals";
import { RevisionStore } from "./revisions";
import { hashContent } from "./jsonc-edit";
import { OPTION_CATALOG, BACKGROUND_JOBS_FIELDS } from "../omo/catalog";

const ROOT = join(import.meta.dir, "../../test/global-sandbox");

function installSyntheticSchema(userDir: string): void {
  const dir = join(userDir, "node_modules", "oh-my-opencode-slim");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.0.0-test" }));
  writeFileSync(join(dir, "oh-my-opencode-slim.schema.json"), JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" }));
}

function fresh() {
  rmSync(ROOT, { recursive: true, force: true });
  const userDir = join(ROOT, "cfg");
  const projDir = join(ROOT, "proj");
  mkdirSync(userDir, { recursive: true });
  mkdirSync(projDir, { recursive: true });
  mkdirSync(join(projDir, "data"), { recursive: true });
  installSyntheticSchema(userDir);
  writeFileSync(
    join(userDir, "oh-my-opencode-slim.json"),
    `{
  // comment keep
  "preset": "openai",
  "presets": { "openai": { "explorer": { "model": "m" } } },
  "unknownGlobalKeep": true,
  "fallback": { "enabled": true }
}
`,
  );
  const cfg = {
    host: "127.0.0.1",
    port: 0,
    opencodeConfigDir: userDir,
    projectDirectory: projDir,
    authorizedRoots: [userDir, projDir, ROOT],
  };
  const revisions = new RevisionStore(join(projDir, "data", "test.db"));
  return { cfg: cfg as never, revisions, userDir, projDir };
}

describe("option catalog", () => {
  test("showStartupToast unsupported", () => {
    expect(
      OPTION_CATALOG.find((c) => c.path === "showStartupToast")?.support,
    ).toBe("unsupported-installed-version");
  });
  test("backgroundJobs fields complete", () => {
    expect(BACKGROUND_JOBS_FIELDS.map((f) => f.key)).toContain(
      "wallClockTimeoutMs",
    );
  });

  test("slice-13: generic companion/interview object entries removed", () => {
    const paths = OPTION_CATALOG.map((c) => c.path);
    expect(paths).not.toContain("companion");
    expect(paths).not.toContain("interview");
  });

  test("slice-13/18: exactly the 13 verified field entries (source authority)", () => {
    const subsys = OPTION_CATALOG.filter(
      (c) => c.path.startsWith("companion.") || c.path.startsWith("interview."),
    );
    expect(subsys.map((c) => c.path).sort()).toEqual([
      "companion.binaryPath",
      "companion.debug",
      "companion.enabled",
      "companion.gifPack",
      "companion.loopStyle",
      "companion.position",
      "companion.size",
      "companion.speed",
      "interview.autoOpenBrowser",
      "interview.dashboard",
      "interview.maxQuestions",
      "interview.outputFolder",
      "interview.port",
    ]);
    const paths = OPTION_CATALOG.map((c) => c.path);
    expect(paths).not.toContain("companion.fooBar");
    expect(paths).not.toContain("interview.magicDashboardMode");
    const companions = subsys.filter((c) => c.path.startsWith("companion."));
    const interviews = subsys.filter((c) => c.path.startsWith("interview."));
    for (const c of companions) {
      expect(c.support).toBe("read-only-slice-13");
      expect(c.effect).toBe("plugin-load");
      expect(c.capabilities.readable).toBe(true);
      expect(c.capabilities.resolved).toBe(true);
      expect(c.capabilities.provenance).toBe(true);
      expect(c.capabilities.doctor).toBe(true);
      expect(c.capabilities.editable).toBe(false);
      expect(c.capabilities.runtimeObservable).toBe(false);
      expect(c.capabilities.runtimeControllable).toBe(false);
    }
    for (const c of interviews) {
      expect(c.support).toBe("typed-capable-slice-18");
      expect(c.effect).toBe("plugin-load");
      expect(c.capabilities.readable).toBe(true);
      expect(c.capabilities.resolved).toBe(true);
      expect(c.capabilities.provenance).toBe(true);
      expect(c.capabilities.doctor).toBe(true);
      expect(c.capabilities.editable).toBe(true);
      expect(c.capabilities.runtimeObservable).toBe(false);
      expect(c.capabilities.runtimeControllable).toBe(false);
    }
  });

  test("slice-13: verified defaults/enums/ranges in catalog", () => {
    const byPath = new Map(OPTION_CATALOG.map((c) => [c.path, c]));
    expect(byPath.get("companion.enabled")?.defaultValue).toBe(false);
    expect(byPath.get("companion.binaryPath")?.defaultValue).toBeUndefined();
    expect(byPath.get("companion.position")?.enumValues).toEqual([
      "bottom-right",
      "bottom-left",
      "top-right",
      "top-left",
    ]);
    expect(byPath.get("companion.speed")?.minimum).toBe(0.25);
    expect(byPath.get("companion.speed")?.maximum).toBe(4);
    expect(byPath.get("interview.maxQuestions")?.defaultValue).toBe(2);
    expect(byPath.get("interview.maxQuestions")?.minimum).toBe(1);
    expect(byPath.get("interview.maxQuestions")?.maximum).toBe(10);
    expect(byPath.get("interview.outputFolder")?.defaultValue).toBe("interview");
    expect(byPath.get("interview.autoOpenBrowser")?.defaultValue).toBe(true);
    expect(byPath.get("interview.port")?.defaultValue).toBe(0);
    expect(byPath.get("interview.port")?.maximum).toBe(65535);
    expect(byPath.get("interview.dashboard")?.defaultValue).toBe(false);
  });

  test("catalog Interview is typed-editable and Companion is never editable", () => {
    for (const c of OPTION_CATALOG.filter((x) => x.path.startsWith("interview."))) {
      expect(c.support).toBe("typed-capable-slice-18");
      expect(c.capabilities.editable).toBe(true);
      expect(c.capabilities.runtimeControllable).toBe(false);
    }
    for (const c of OPTION_CATALOG.filter((x) => x.path.startsWith("companion."))) {
      expect(c.support).toBe("read-only-slice-13");
      expect(c.capabilities.editable).toBe(false);
    }
  });

  test("every catalog entry declares a capabilities block", () => {
    for (const c of OPTION_CATALOG) {
      expect(c.capabilities).toBeDefined();
      expect(typeof c.capabilities.readable).toBe("boolean");
      expect(typeof c.capabilities.resolved).toBe("boolean");
      expect(typeof c.capabilities.provenance).toBe("boolean");
      expect(typeof c.capabilities.editable).toBe("boolean");
      expect(
        typeof c.capabilities.runtimeObservable === "boolean" ||
          c.capabilities.runtimeObservable === "partial",
      ).toBe(true);
      expect(typeof c.capabilities.runtimeControllable).toBe("boolean");
      expect(typeof c.capabilities.doctor).toBe("boolean");
    }
  });
});

describe("global mutations", () => {
  let s: ReturnType<typeof fresh>;
  beforeEach(() => {
    s = fresh();
  });
  const h = () =>
    hashContent(
      readFileSync(join(s.userDir, "oh-my-opencode-slim.json"), "utf-8"),
    );

  test("set disabled_skills", () => {
    const r = applyGlobal(
      s.cfg,
      {
        kind: "global-settings",
        scope: "user",
        disabled_skills: { operation: "set", value: ["deepwork"] },
        expectedSourceHash: h(),
      },
      s.revisions,
    );
    expect(r.ok).toBe(true);
    const t = readFileSync(join(s.userDir, "oh-my-opencode-slim.json"), "utf-8");
    expect(t).toContain("deepwork");
    expect(t).toContain("unknownGlobalKeep");
    expect(t).toContain("// comment keep");
  });

  test("protected agent rejected", () => {
    const r = simulateGlobal(s.cfg, {
      kind: "global-settings",
      scope: "user",
      disabled_agents: { operation: "set", value: ["orchestrator"] },
      expectedSourceHash: h(),
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("protected");
  });

  test("backgroundJobs targeted nested edit", () => {
    const r = applyGlobal(
      s.cfg,
      {
        kind: "global-settings",
        scope: "user",
        backgroundJobs: {
          maxSessionsPerAgent: { operation: "set", value: 3 },
        },
        expectedSourceHash: h(),
      },
      s.revisions,
    );
    expect(r.ok).toBe(true);
    const t = readFileSync(join(s.userDir, "oh-my-opencode-slim.json"), "utf-8");
    expect(t).toContain("maxSessionsPerAgent");
  });

  test("backgroundJobs range validation", () => {
    const r = simulateGlobal(s.cfg, {
      kind: "global-settings",
      scope: "user",
      backgroundJobs: {
        maxSessionsPerAgent: { operation: "set", value: 99 },
      },
      expectedSourceHash: h(),
    });
    expect(r.ok).toBe(false);
  });

  test("fallback retry_on_empty exact name", () => {
    const r = applyGlobal(
      s.cfg,
      {
        kind: "global-settings",
        scope: "user",
        fallback: { retry_on_empty: { operation: "set", value: false } },
        expectedSourceHash: h(),
      },
      s.revisions,
    );
    expect(r.ok).toBe(true);
    expect(
      readFileSync(join(s.userDir, "oh-my-opencode-slim.json"), "utf-8"),
    ).toContain("retry_on_empty");
  });

  test("image_routing invalid", () => {
    const r = simulateGlobal(s.cfg, {
      kind: "global-settings",
      scope: "user",
      image_routing: { operation: "set", value: "bogus" },
      expectedSourceHash: h(),
    });
    expect(r.ok).toBe(false);
  });

  test("compactSidebar set + remove", () => {
    let r = applyGlobal(
      s.cfg,
      {
        kind: "global-settings",
        scope: "user",
        compactSidebar: { operation: "set", value: false },
        expectedSourceHash: h(),
      },
      s.revisions,
    );
    expect(r.ok).toBe(true);
    expect(r.effectiveChanges?.some((c) => c.path === "compactSidebar")).toBe(true);
    r = applyGlobal(
      s.cfg,
      {
        kind: "global-settings",
        scope: "user",
        compactSidebar: { operation: "remove" },
        expectedSourceHash: hashContent(
          readFileSync(join(s.userDir, "oh-my-opencode-slim.json"), "utf-8"),
        ),
      },
      s.revisions,
    );
    expect(r.ok).toBe(true);
    expect(
      readFileSync(join(s.userDir, "oh-my-opencode-slim.json"), "utf-8"),
    ).not.toContain("compactSidebar");
  });

  test("hash conflict", () => {
    const r = simulateGlobal(s.cfg, {
      kind: "global-settings",
      scope: "user",
      autoUpdate: { operation: "set", value: false },
      expectedSourceHash: "deadbeef",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("EXTERNALLY");
  });
});

// ── Multiplexer mutations (Slice 16) ─────────────────────────────────────

describe("multiplexer mutations (Slice 16)", () => {
  let s: ReturnType<typeof fresh>;
  beforeEach(() => {
    s = fresh();
  });
  const h = () =>
    hashContent(
      readFileSync(join(s.userDir, "oh-my-opencode-slim.json"), "utf-8"),
    );

  test("catalog: exactly four implemented-slice-16 multiplexer rows", () => {
    const muxRows = OPTION_CATALOG.filter((c) =>
      c.path.startsWith("multiplexer."),
    );
    expect(muxRows.map((r) => r.path)).toEqual([
      "multiplexer.type",
      "multiplexer.layout",
      "multiplexer.main_pane_size",
      "multiplexer.zellij_pane_mode",
    ]);
    for (const r of muxRows) {
      expect(r.support).toBe("implemented-slice-16");
      expect(r.effect).toBe("plugin-load");
      expect(r.capabilities.editable).toBe(true);
      expect(r.capabilities.runtimeControllable).toBe(false);
      expect(r.capabilities.runtimeObservable).toBe("partial");
    }
  });

  test("catalog: no deferred multiplexer row remains", () => {
    const deferred = OPTION_CATALOG.find(
      (c) => c.path === "multiplexer" && c.support === "deferred",
    );
    expect(deferred).toBeUndefined();
  });

  test("set multiplexer.type", () => {
    const r = applyGlobal(
      s.cfg,
      {
        kind: "global-settings",
        scope: "user",
        multiplexer: { type: { operation: "set", value: "tmux" } },
        expectedSourceHash: h(),
      },
      s.revisions,
    );
    expect(r.ok).toBe(true);
    const t = readFileSync(join(s.userDir, "oh-my-opencode-slim.json"), "utf-8");
    expect(t).toContain("multiplexer");
    expect(t).toContain("tmux");
    // Comments and unknown keys preserved
    expect(t).toContain("// comment keep");
    expect(t).toContain("unknownGlobalKeep");
  });

  test("set all four multiplexer fields (compound)", () => {
    const r = applyGlobal(
      s.cfg,
      {
        kind: "global-settings",
        scope: "user",
        multiplexer: {
          type: { operation: "set", value: "zellij" },
          layout: { operation: "set", value: "tiled" },
          main_pane_size: { operation: "set", value: 50 },
          zellij_pane_mode: { operation: "set", value: "current-tab" },
        },
        expectedSourceHash: h(),
      },
      s.revisions,
    );
    expect(r.ok).toBe(true);
    const t = readFileSync(join(s.userDir, "oh-my-opencode-slim.json"), "utf-8");
    expect(t).toContain("zellij");
    expect(t).toContain("tiled");
    expect(t).toContain("50");
    expect(t).toContain("current-tab");
  });

  test("remove multiplexer.type", () => {
    // First set
    applyGlobal(
      s.cfg,
      {
        kind: "global-settings",
        scope: "user",
        multiplexer: { type: { operation: "set", value: "tmux" } },
        expectedSourceHash: h(),
      },
      s.revisions,
    );
    // Then remove
    const r = applyGlobal(
      s.cfg,
      {
        kind: "global-settings",
        scope: "user",
        multiplexer: { type: { operation: "remove" } },
        expectedSourceHash: hashContent(
          readFileSync(join(s.userDir, "oh-my-opencode-slim.json"), "utf-8"),
        ),
      },
      s.revisions,
    );
    expect(r.ok).toBe(true);
    const t = readFileSync(join(s.userDir, "oh-my-opencode-slim.json"), "utf-8");
    // multiplexer object may still exist but type should be gone
    expect(t).not.toContain("tmux");
  });

  test("invalid type enum rejected", () => {
    const r = simulateGlobal(s.cfg, {
      kind: "global-settings",
      scope: "user",
      multiplexer: { type: { operation: "set", value: "bogus" } },
      expectedSourceHash: h(),
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("multiplexer.type");
  });

  test("invalid layout enum rejected", () => {
    const r = simulateGlobal(s.cfg, {
      kind: "global-settings",
      scope: "user",
      multiplexer: { layout: { operation: "set", value: "bogus" } },
      expectedSourceHash: h(),
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("multiplexer.layout");
  });

  test("main_pane_size below minimum rejected", () => {
    const r = simulateGlobal(s.cfg, {
      kind: "global-settings",
      scope: "user",
      multiplexer: { main_pane_size: { operation: "set", value: 10 } },
      expectedSourceHash: h(),
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("minimum");
  });

  test("main_pane_size above maximum rejected", () => {
    const r = simulateGlobal(s.cfg, {
      kind: "global-settings",
      scope: "user",
      multiplexer: { main_pane_size: { operation: "set", value: 90 } },
      expectedSourceHash: h(),
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("maximum");
  });

  test("main_pane_size non-number rejected", () => {
    const r = simulateGlobal(s.cfg, {
      kind: "global-settings",
      scope: "user",
      multiplexer: { main_pane_size: { operation: "set", value: "big" } },
      expectedSourceHash: h(),
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("number");
  });

  test("invalid zellij_pane_mode enum rejected", () => {
    const r = simulateGlobal(s.cfg, {
      kind: "global-settings",
      scope: "user",
      multiplexer: { zellij_pane_mode: { operation: "set", value: "bogus" } },
      expectedSourceHash: h(),
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("zellij_pane_mode");
  });

  test("unknown multiplexer field rejected", () => {
    const r = simulateGlobal(s.cfg, {
      kind: "global-settings",
      scope: "user",
      multiplexer: { bogusField: { operation: "set", value: "x" } },
      expectedSourceHash: h(),
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("Unknown multiplexer field");
  });

  test("hash conflict on multiplexer", () => {
    const r = simulateGlobal(s.cfg, {
      kind: "global-settings",
      scope: "user",
      multiplexer: { type: { operation: "set", value: "tmux" } },
      expectedSourceHash: "deadbeef",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("EXTERNALLY");
  });

  test("revision recorded for multiplexer write", () => {
    const r = applyGlobal(
      s.cfg,
      {
        kind: "global-settings",
        scope: "user",
        multiplexer: { type: { operation: "set", value: "tmux" } },
        expectedSourceHash: h(),
      },
      s.revisions,
    );
    expect(r.ok).toBe(true);
    expect(r.revisionId).toBeDefined();
    const revs = s.revisions.list(10);
    expect(revs.length).toBeGreaterThan(0);
    expect(revs[0]!.mutationKind).toBe("global-settings");
    expect(revs[0]!.property).toContain("multiplexer.type");
  });

  test("schema validation on multiplexer write (synthetic permissive schema)", () => {
    // The synthetic schema is permissive (type: object) so writes pass.
    const r = applyGlobal(
      s.cfg,
      {
        kind: "global-settings",
        scope: "user",
        multiplexer: { type: { operation: "set", value: "none" } },
        expectedSourceHash: h(),
      },
      s.revisions,
    );
    expect(r.ok).toBe(true);
    // schemaValidation should be present and ok
    expect(r.schemaValidation?.ok).toBe(true);
  });
});
