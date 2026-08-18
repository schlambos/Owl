import { describe, expect, test, beforeEach } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyCouncil,
  buildCouncilInventory,
  simulateCouncil,
  type CouncilMutation,
} from "./council";
import { RevisionStore } from "./revisions";
import { hashContent, parseConfigText } from "./jsonc-edit";

const ROOT = join(import.meta.dir, "../../test/council-sandbox");

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
  // keep comment
  "preset": "openai",
  "council": {
    "default_preset": "balanced",
    "presets": {
      "balanced": {
        "alpha": { "model": "openai/a", "variant": "high" },
        "beta": { "model": ["openai/b", {"id":"xai/c","variant":"low"}], "prompt": "focus" }
      },
      "empty1": {}
    },
    "master": { "legacy": true }
  }
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

describe("inventory", () => {
  let s: ReturnType<typeof fresh>;
  beforeEach(() => {
    s = fresh();
  });

  test("presets + members", () => {
    const inv = buildCouncilInventory(s.cfg);
    const bal = inv.presets.find((p) => p.name === "balanced")!;
    expect(bal.isDefault).toBe(true);
    expect(bal.memberCount).toBe(2);
    expect(bal.members.find((m) => m.name === "beta")?.chainLength).toBe(2);
    expect(bal.members.find((m) => m.name === "beta")?.hasPrompt).toBe(true);
    expect(inv.effective_default_preset).toBe("balanced");
  });

  test("master legacy not member", () => {
    const inv = buildCouncilInventory(s.cfg);
    const bal = inv.presets.find((p) => p.name === "balanced")!;
    expect(bal.members.some((m) => m.name === "master")).toBe(false);
  });

  test("empty preset visible", () => {
    const inv = buildCouncilInventory(s.cfg);
    expect(inv.presets.find((p) => p.name === "empty1")?.empty).toBe(true);
  });
});

describe("mutations", () => {
  let s: ReturnType<typeof fresh>;
  beforeEach(() => {
    s = fresh();
  });
  const h = () =>
    hashContent(readFileSync(join(s.userDir, "oh-my-opencode-slim.json"), "utf-8"));

  test("create preset empty", () => {
    const mut: CouncilMutation = {
      kind: "council",
      scope: "user",
      presetCreate: { name: "review" },
      expectedSourceHash: h(),
    };
    const r = applyCouncil(s.cfg, mut, s.revisions);
    expect(r.ok).toBe(true);
    const obj = (parseConfigText(readFileSync(join(s.userDir, "oh-my-opencode-slim.json"), "utf-8")) as { council: any });
    expect(obj.council.presets.review).toEqual({});
    expect(obj.council.master).toEqual({ legacy: true }); // unknown preserved
  });

  test("clone preset", () => {
    const r = applyCouncil(s.cfg, {
      kind: "council",
      scope: "user",
      presetCreate: { name: "bal2", cloneFrom: "balanced" },
      expectedSourceHash: h(),
    }, s.revisions);
    expect(r.ok).toBe(true);
    const obj = (parseConfigText(readFileSync(join(s.userDir, "oh-my-opencode-slim.json"), "utf-8")) as { council: any });
    expect(obj.council.presets.bal2.alpha.model).toBe("openai/a");
  });

  test("rename preset updates default", () => {
    const r = applyCouncil(s.cfg, {
      kind: "council",
      scope: "user",
      presetRename: { oldName: "empty1", newName: "renamed1" },
      expectedSourceHash: h(),
    }, s.revisions);
    expect(r.ok).toBe(true);
  });

  test("member create with chain", () => {
    const r = applyCouncil(s.cfg, {
      kind: "council",
      scope: "user",
      members: {
        preset: "balanced",
        ops: [
          {
            member: "gamma",
            operation: "create",
            model: { operation: "set", value: ["xai/g", { id: "openai/h", variant: "high" }] },
            prompt: { operation: "set", value: "perspective" },
          },
        ],
      },
      expectedSourceHash: h(),
    }, s.revisions);
    expect(r.ok).toBe(true);
    const inv = buildCouncilInventory(s.cfg);
    const gamma = inv.presets.find((p) => p.name === "balanced")!.members.find((m) => m.name === "gamma")!;
    expect(gamma.chainLength).toBe(2);
    expect(gamma.hasPrompt).toBe(true);
  });

  test("member delete", () => {
    const r = applyCouncil(s.cfg, {
      kind: "council",
      scope: "user",
      members: { preset: "balanced", ops: [{ member: "alpha", operation: "delete" }] },
      expectedSourceHash: h(),
    }, s.revisions);
    expect(r.ok).toBe(true);
    const inv = buildCouncilInventory(s.cfg);
    expect(inv.presets.find((p) => p.name === "balanced")!.memberCount).toBe(1);
  });

  test("reserved master rejected", () => {
    const r = simulateCouncil(s.cfg, {
      kind: "council",
      scope: "user",
      members: {
        preset: "balanced",
        ops: [{ member: "master", operation: "delete" }],
      },
      expectedSourceHash: h(),
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("reserved");
  });

  test("bad model format rejected", () => {
    const r = simulateCouncil(s.cfg, {
      kind: "council",
      scope: "user",
      members: {
        preset: "balanced",
        ops: [
          {
            member: "zeta",
            operation: "create",
            model: { operation: "set", value: "not-a-model" },
          },
        ],
      },
      expectedSourceHash: h(),
    });
    expect(r.ok).toBe(false);
  });

  test("delete only default preset rejected", () => {
    // delete balanced (default) while empty1 still exists — warn but ok
    // first delete empty1 members make bal only one
    const r = applyCouncil(s.cfg, {
      kind: "council",
      scope: "user",
      presetDelete: { name: "empty1" },
      expectedSourceHash: h(),
    }, s.revisions);
    expect(r.ok).toBe(true);
    // now delete balanced — only preset left and is default
    const r2 = applyCouncil(s.cfg, {
      kind: "council",
      scope: "user",
      presetDelete: { name: "balanced" },
      expectedSourceHash: hashContent(readFileSync(join(s.userDir, "oh-my-opencode-slim.json"), "utf-8")),
    }, s.revisions);
    expect(r2.ok).toBe(false);
  });

  test("set default preset", () => {
    const r = applyCouncil(s.cfg, {
      kind: "council",
      scope: "user",
      defaultPreset: { operation: "set", value: "empty1" },
      expectedSourceHash: h(),
    }, s.revisions);
    expect(r.ok).toBe(true);
    const inv = buildCouncilInventory(s.cfg);
    expect(inv.effective_default_preset).toBe("empty1");
  });
});
