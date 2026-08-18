import { describe, expect, test, beforeEach } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildPresetInventory,
  comparePresets,
  createPreset,
  deletePreset,
  renamePreset,
  runtimeSwitchImpact,
  setConfiguredPreset,
} from "./presets";
import { RevisionStore } from "./revisions";
import { resolveProvenance } from "../omo/provenance";
import { hashContent } from "./jsonc-edit";

const ROOT = join(import.meta.dir, "../../test/preset-sandbox");

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
    JSON.stringify(
      {
        preset: "openai",
        presets: {
          openai: {
            explorer: { model: "openai/ex", variant: "low" },
            oracle: { model: "openai/or" },
          },
          "opencode-go": {
            explorer: { model: "ocgo/ex" },
          },
          empty1: {},
        },
        agents: {
          explorer: { model: "root/ex" },
        },
      },
      null,
      2,
    ),
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

function prov(cfg: never) {
  return resolveProvenance({
    opencodeConfigDir: (cfg as { opencodeConfigDir: string }).opencodeConfigDir,
    projectDirectory: (cfg as { projectDirectory: string }).projectDirectory,
    authorizedRoots: (cfg as { authorizedRoots: string[] }).authorizedRoots,
  });
}

describe("preset inventory", () => {
  let s: ReturnType<typeof fresh>;
  beforeEach(() => {
    s = fresh();
  });

  test("lists presets + masking", () => {
    const inv = buildPresetInventory(s.cfg, prov(s.cfg as never), {
      skillNames: [],
      mcpNames: [],
      disabled_skills: [],
      disabled_mcps: [],
    });
    expect(inv.presets.map((p) => p.name)).toContain("openai");
    const openai = inv.presets.find((p) => p.name === "openai")!;
    expect(openai.configuredActive).toBe(true);
    const explorer = openai.agents.find((a) => a.agent === "explorer")!;
    expect(explorer.maskedFields).toContain("model");
    expect(explorer.runtimeSwitchWouldChange).toContain("model");
  });

  test("runtime switch impact", () => {
    const impact = runtimeSwitchImpact(s.cfg, prov(s.cfg as never), "openai");
    const ex = impact.find((r) => r.agent === "explorer" && r.field === "model");
    expect(ex?.before).toBe("root/ex");
    expect(ex?.after).toBe("openai/ex");
  });

  test("compare desired", () => {
    const c = comparePresets(s.cfg, prov(s.cfg as never), "openai", "opencode-go", "desired");
    expect(c.rows.some((r) => r.agent === "explorer")).toBe(true);
  });

  test("compare runtime-switch differs from desired", () => {
    const d = comparePresets(s.cfg, prov(s.cfg as never), "openai", "opencode-go", "desired");
    const r = comparePresets(s.cfg, prov(s.cfg as never), "openai", "opencode-go", "runtime-switch");
    expect(d.rows.length).toBeGreaterThan(0);
    expect(Array.isArray(r.rows)).toBe(true);
  });
});

describe("preset mutations", () => {
  let s: ReturnType<typeof fresh>;
  beforeEach(() => {
    s = fresh();
  });

  const h = (s: ReturnType<typeof fresh>) =>
    hashContent(readFileSync(join(s.userDir, "oh-my-opencode-slim.json"), "utf-8"));

  test("create empty", () => {
    const r = createPreset(s.cfg, s.revisions, {
      scope: "user",
      name: "newp",
      initial: { mode: "empty" },
      expectedSourceHash: h(s),
    });
    expect(r.ok).toBe(true);
    const obj = JSON.parse(readFileSync(join(s.userDir, "oh-my-opencode-slim.json"), "utf-8"));
    expect(obj.presets.newp).toEqual({});
  });

  test("clone desired (not root-effective)", () => {
    const r = createPreset(s.cfg, s.revisions, {
      scope: "user",
      name: "clone1",
      initial: { mode: "clone", sourcePreset: "openai" },
      expectedSourceHash: h(s),
    });
    expect(r.ok).toBe(true);
    const obj = JSON.parse(readFileSync(join(s.userDir, "oh-my-opencode-slim.json"), "utf-8"));
    expect(obj.presets.clone1.explorer.model).toBe("openai/ex"); // NOT root/ex
  });

  test("rename updates configured", () => {
    const r = renamePreset(s.cfg, s.revisions, {
      scope: "user",
      oldName: "empty1",
      newName: "renamed1",
      updateConfigured: false,
      expectedSourceHash: h(s),
    });
    expect(r.ok).toBe(true);
    const obj = JSON.parse(readFileSync(join(s.userDir, "oh-my-opencode-slim.json"), "utf-8"));
    expect(obj.presets.renamed1).toEqual({});
    expect(obj.presets.empty1).toBeUndefined();
  });

  test("delete active rejected", () => {
    const r = deletePreset(s.cfg, s.revisions, {
      scope: "user",
      name: "openai",
      expectedSourceHash: h(s),
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("active");
  });

  test("set configured", () => {
    const r = setConfiguredPreset(s.cfg, s.revisions, {
      scope: "user",
      value: "opencode-go",
      expectedSourceHash: h(s),
    });
    expect(r.ok).toBe(true);
    const obj = JSON.parse(readFileSync(join(s.userDir, "oh-my-opencode-slim.json"), "utf-8"));
    expect(obj.preset).toBe("opencode-go");
  });

  test("invalid name rejected", () => {
    const r = createPreset(s.cfg, s.revisions, {
      scope: "user",
      name: "../bad",
      initial: { mode: "empty" },
    });
    expect(r.ok).toBe(false);
  });
});
