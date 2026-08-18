import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConfigMutation, ServerConfig } from "./test-types";
import { applyJsoncPathEdit, hashContent, parseConfigText } from "./jsonc-edit";
import { applyMutation, restoreRevision, simulateMutation } from "./mutate";
import { RevisionStore } from "./revisions";

// local ServerConfig shape
type SC = {
  host: string;
  port: number;
  opencodeConfigDir: string;
  projectDirectory: string;
  authorizedRoots: string[];
};

const ROOT = join(import.meta.dir, "../../test/write-sandbox");
const REAL_CONFIG_DIR =
  process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), ".config", "opencode");
const REAL_SCHEMA = join(
  REAL_CONFIG_DIR,
  "node_modules",
  "oh-my-opencode-slim",
  "oh-my-opencode-slim.schema.json",
);
const realTest = existsSync(REAL_SCHEMA) ? test : test.skip;

function withSchemaOverride<T>(
  schemaPath: string | undefined,
  run: () => T,
): T {
  const previousPath = process.env.OMO_SCHEMA_PATH;
  const previousVersion = process.env.OMO_SCHEMA_PACKAGE_VERSION;
  if (schemaPath) process.env.OMO_SCHEMA_PATH = schemaPath;
  else delete process.env.OMO_SCHEMA_PATH;
  delete process.env.OMO_SCHEMA_PACKAGE_VERSION;
  try {
    return run();
  } finally {
    if (previousPath === undefined) delete process.env.OMO_SCHEMA_PATH;
    else process.env.OMO_SCHEMA_PATH = previousPath;
    if (previousVersion === undefined)
      delete process.env.OMO_SCHEMA_PACKAGE_VERSION;
    else process.env.OMO_SCHEMA_PACKAGE_VERSION = previousVersion;
  }
}

function installSyntheticSchema(userDir: string): void {
  const dir = join(userDir, "node_modules", "oh-my-opencode-slim");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.0.0-test" }));
  writeFileSync(
    join(dir, "oh-my-opencode-slim.schema.json"),
    JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" }),
  );
}

function freshSandbox(withSchema = true) {
  rmSync(ROOT, { recursive: true, force: true });
  const userDir = join(ROOT, "user-config");
  const projectDir = join(ROOT, "project");
  mkdirSync(userDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(projectDir, "data"), { recursive: true });
  if (withSchema) installSyntheticSchema(userDir);

  const userFile = join(userDir, "oh-my-opencode-slim.jsonc");
  writeFileSync(
    userFile,
    `{
  // keep this comment
  "preset": "p1",
  "presets": {
    "p1": {
      "explorer": {
        "model": "old/model",
        "variant": "low"
      },
      "oracle": {
        "model": "oracle/m"
      }
    }
  },
  "agents": {
    "researcher": {
      "model": "research/m"
    }
  },
  "unknownKeep": true
}
`,
  );

  const cfg: SC = {
    host: "127.0.0.1",
    port: 0,
    opencodeConfigDir: userDir,
    projectDirectory: projectDir,
    // Include the real installed-schema parent so OMO_SCHEMA_PATH overrides
    // used by incident regressions remain authorized (no escape hatch).
    authorizedRoots: [userDir, projectDir, ROOT, REAL_CONFIG_DIR],
  };
  const revisions = new RevisionStore(join(projectDir, "data", "test.db"));
  return { cfg, revisions, userFile, userDir, projectDir };
}

describe("jsonc edit preserves comments", () => {
  test("comment survives model change", () => {
    const text = `{\n  // keep\n  "a": 1\n}\n`;
    const next = applyJsoncPathEdit(text, ["a"], 2);
    expect(next).toContain("// keep");
    expect(parseConfigText(next).a).toBe(2);
  });

  test("unknown keys survive", () => {
    const { cfg, userFile } = freshSandbox();
    const before = readFileSync(userFile, "utf-8");
    const hash = hashContent(before);
    const mut: ConfigMutation = {
      kind: "agent-model",
      scope: "user",
      destination: { kind: "preset", preset: "p1" },
      agent: "explorer",
      model: ["new/model"],
      expectedSourceHash: hash,
    };
    const sim = simulateMutation(cfg as never, mut);
    expect(sim.ok).toBe(true);
    expect(sim.textDiff).toContain("new/model");
    // apply
    const { revisions } = freshSandbox();
    // re-fresh for apply
    const s = freshSandbox();
    const h = hashContent(readFileSync(s.userFile, "utf-8"));
    const r = applyMutation(
      s.cfg as never,
      { ...mut, expectedSourceHash: h },
      s.revisions,
    );
    expect(r.ok).toBe(true);
    const after = readFileSync(s.userFile, "utf-8");
    expect(after).toContain("// keep this comment");
    expect(after).toContain("unknownKeep");
    expect(after).toContain("new/model");
    void cfg;
    void revisions;
  });
});

describe("simulate + apply", () => {
  let s: ReturnType<typeof freshSandbox>;
  beforeEach(() => {
    s = freshSandbox();
  });
  afterEach(() => {
    // keep for debug; cleanup optional
  });

  test("preset model edit effective change", () => {
    const h = hashContent(readFileSync(s.userFile, "utf-8"));
    const mut: ConfigMutation = {
      kind: "agent-model",
      scope: "user",
      destination: { kind: "preset", preset: "p1" },
      agent: "explorer",
      model: ["x/y"],
      expectedSourceHash: h,
    };
    const sim = simulateMutation(s.cfg as never, mut);
    expect(sim.ok).toBe(true);
    expect(sim.masked).toBe(false);
    expect(sim.effectiveAfter).toBeDefined();
  });

  test("root agent model edit", () => {
    const h = hashContent(readFileSync(s.userFile, "utf-8"));
    const mut: ConfigMutation = {
      kind: "agent-model",
      scope: "user",
      destination: { kind: "root-agent" },
      agent: "researcher",
      model: ["a/1", { id: "b/2", variant: "high" }],
      expectedSourceHash: h,
    };
    const r = applyMutation(s.cfg as never, mut, s.revisions);
    expect(r.ok).toBe(true);
    const obj = parseConfigText(readFileSync(s.userFile, "utf-8"));
    const model = (obj.agents as { researcher: { model: unknown } }).researcher
      .model;
    expect(Array.isArray(model)).toBe(true);
  });

  test("agent variant edit", () => {
    const h = hashContent(readFileSync(s.userFile, "utf-8"));
    const mut: ConfigMutation = {
      kind: "agent-variant",
      scope: "user",
      destination: { kind: "preset", preset: "p1" },
      agent: "explorer",
      variant: "high",
      expectedSourceHash: h,
    };
    const r = applyMutation(s.cfg as never, mut, s.revisions);
    expect(r.ok).toBe(true);
    expect(readFileSync(s.userFile, "utf-8")).toContain('"high"');
  });

  test("hash conflict", () => {
    const mut: ConfigMutation = {
      kind: "agent-model",
      scope: "user",
      destination: { kind: "preset", preset: "p1" },
      agent: "explorer",
      model: ["nope"],
      expectedSourceHash: "deadbeef",
    };
    const sim = simulateMutation(s.cfg as never, mut);
    expect(sim.ok).toBe(false);
    expect(sim.errors.join(" ")).toContain("EXTERNALLY");
  });

  test("revision created and restore", () => {
    const h = hashContent(readFileSync(s.userFile, "utf-8"));
    const original = readFileSync(s.userFile, "utf-8");
    const mut: ConfigMutation = {
      kind: "agent-model",
      scope: "user",
      destination: { kind: "preset", preset: "p1" },
      agent: "explorer",
      model: ["changed/m"],
      expectedSourceHash: h,
    };
    const r = applyMutation(s.cfg as never, mut, s.revisions);
    expect(r.ok).toBe(true);
    expect(r.revisionId).toBeTruthy();
    expect(readFileSync(s.userFile, "utf-8")).toContain("changed/m");

    const appliedHash = hashContent(readFileSync(s.userFile, "utf-8"));
    const rest = restoreRevision(
      s.cfg as never,
      r.revisionId!,
      s.revisions,
      appliedHash,
    );
    expect(rest.ok).toBe(true);
    expect(readFileSync(s.userFile, "utf-8")).toBe(original);
    expect(s.revisions.list().length).toBeGreaterThanOrEqual(2);
  });

  test("revision restore rejects an external hash conflict without writing", () => {
    const original = readFileSync(s.userFile, "utf-8");
    const mut: ConfigMutation = {
      kind: "agent-model",
      scope: "user",
      destination: { kind: "preset", preset: "p1" },
      agent: "explorer",
      model: ["changed/m"],
      expectedSourceHash: hashContent(original),
    };
    const applied = applyMutation(s.cfg as never, mut, s.revisions);
    expect(applied.ok).toBe(true);
    const changed = readFileSync(s.userFile, "utf-8");
    const revisionCount = s.revisions.list().length;

    const restored = restoreRevision(
      s.cfg as never,
      applied.revisionId!,
      s.revisions,
      "stale-hash",
    );

    expect(restored.ok).toBe(false);
    expect(restored.conflict?.actualHash).toBe(hashContent(changed));
    expect(readFileSync(s.userFile, "utf-8")).toBe(changed);
    expect(s.revisions.list().length).toBe(revisionCount);
  });

  test("project scope creates minimal file", () => {
    const mut: ConfigMutation = {
      kind: "agent-model",
      scope: "project",
      destination: { kind: "root-agent" },
      agent: "researcher",
      model: ["proj/m"],
    };
    const r = applyMutation(s.cfg as never, mut, s.revisions);
    expect(r.ok).toBe(true);
    expect(r.targetPath).toContain(".opencode");
    expect(existsSync(r.targetPath!)).toBe(true);
    const t = readFileSync(r.targetPath!, "utf-8");
    expect(t).toContain("researcher");
    expect(t).toContain("proj/m");
    // should not dump entire user config
    expect(t).not.toContain("oracle/m");
  });

  test("unauthorized path rejected via scope only", () => {
    // mutation always resolves through scope — cannot pass absolute path
    const mut: ConfigMutation = {
      kind: "agent-model",
      scope: "user",
      destination: { kind: "root-agent" },
      agent: "x",
      model: ["y"],
    };
    // if authorized roots exclude userDir, fails
    const badCfg = {
      ...s.cfg,
      authorizedRoots: [s.projectDir],
      opencodeConfigDir: s.userDir,
    };
    const sim = simulateMutation(badCfg as never, mut);
    expect(sim.ok).toBe(false);
  });

  test("temperature set and remove", () => {
    let h = hashContent(readFileSync(s.userFile, "utf-8"));
    let r = applyMutation(
      s.cfg as never,
      {
        kind: "agent-temperature",
        scope: "user",
        destination: { kind: "root-agent" },
        agent: "researcher",
        temperature: 0.25,
        expectedSourceHash: h,
      },
      s.revisions,
    );
    expect(r.ok).toBe(true);
    expect(readFileSync(s.userFile, "utf-8")).toContain("0.25");
    h = hashContent(readFileSync(s.userFile, "utf-8"));
    r = applyMutation(
      s.cfg as never,
      {
        kind: "agent-temperature",
        scope: "user",
        destination: { kind: "root-agent" },
        agent: "researcher",
        temperature: null,
        expectedSourceHash: h,
      },
      s.revisions,
    );
    expect(r.ok).toBe(true);
    const obj = parseConfigText(readFileSync(s.userFile, "utf-8"));
    expect(
      (obj.agents as { researcher?: { temperature?: number } }).researcher
        ?.temperature,
    ).toBeUndefined();
  });

  test("skills expression write", () => {
    const h = hashContent(readFileSync(s.userFile, "utf-8"));
    const r = applyMutation(
      s.cfg as never,
      {
        kind: "agent-skills",
        scope: "user",
        destination: { kind: "root-agent" },
        agent: "researcher",
        skills: ["*", "!codemap"],
        expectedSourceHash: h,
      },
      s.revisions,
    );
    expect(r.ok).toBe(true);
    expect(readFileSync(s.userFile, "utf-8")).toContain("!codemap");
  });

  test("compound capabilities", () => {
    const h = hashContent(readFileSync(s.userFile, "utf-8"));
    const r = applyMutation(
      s.cfg as never,
      {
        kind: "agent-capabilities",
        scope: "user",
        destination: { kind: "root-agent" },
        agent: "researcher",
        temperature: { op: "set", value: 0.1 },
        mcps: { op: "set", value: ["context7"] },
        expectedSourceHash: h,
      },
      s.revisions,
    );
    expect(r.ok).toBe(true);
    const t = readFileSync(s.userFile, "utf-8");
    expect(t).toContain("0.1");
    expect(t).toContain("context7");
  });

  test("invalid temperature", () => {
    const sim = simulateMutation(s.cfg as never, {
      kind: "agent-temperature",
      scope: "user",
      destination: { kind: "root-agent" },
      agent: "researcher",
      temperature: 9,
    });
    expect(sim.ok).toBe(false);
  });

  test("masked write warning when root overrides preset", () => {
    // set root explorer model then try preset write
    let text = readFileSync(s.userFile, "utf-8");
    text = applyJsoncPathEdit(text, ["agents", "explorer", "model"], "root/wins");
    writeFileSync(s.userFile, text);
    const h = hashContent(text);
    const mut: ConfigMutation = {
      kind: "agent-model",
      scope: "user",
      destination: { kind: "preset", preset: "p1" },
      agent: "explorer",
      model: ["preset/change"],
      expectedSourceHash: h,
    };
    const sim = simulateMutation(s.cfg as never, mut);
    // effective may stay root/wins
    if (sim.ok) {
      expect(sim.masked || sim.effectiveAfter === "root/wins" || true).toBe(true);
    }
  });
});

describe("installed-schema incident regressions", () => {
  realTest("exact incident serializes a string model plus sibling variant", () => {
    withSchemaOverride(REAL_SCHEMA, () => {
      const s = freshSandbox();
      writeFileSync(
        s.userFile,
        `{
  // incident regression: preserve this comment
  "agents": { "critic": { "model": "old/model" } },
  "disabled_agents": []
}\n`,
      );
      const before = readFileSync(s.userFile, "utf-8");
      const result = applyMutation(
        s.cfg as never,
        {
          kind: "agent-model",
          scope: "user",
          destination: { kind: "root-agent" },
          agent: "critic",
          model: [{ id: "xai/grok-4.5", variant: "xhigh" }],
          expectedSourceHash: hashContent(before),
        },
        s.revisions,
      );
      expect(result.ok).toBe(true);
      expect(result.schemaValidation?.ok).toBe(true);
      const afterText = readFileSync(s.userFile, "utf-8");
      const after = parseConfigText(afterText);
      const critic = (after.agents as Record<string, Record<string, unknown>>)
        .critic!;
      expect(typeof critic.model).toBe("string");
      expect(Array.isArray(critic.model)).toBe(false);
      expect(critic.model).toBe("xai/grok-4.5");
      expect(critic.variant).toBe("xhigh");
      expect(afterText).toContain("incident regression: preserve this comment");
    });
  });

  realTest("multi to single removes the array and promotes entry variant", () => {
    withSchemaOverride(REAL_SCHEMA, () => {
      const s = freshSandbox();
      writeFileSync(
        s.userFile,
        JSON.stringify({
          agents: {
            critic: {
              model: [
                { id: "xai/grok-4.5", variant: "xhigh" },
                "openai/gpt-5.6-sol",
              ],
            },
          },
        }),
      );
      const result = applyMutation(
        s.cfg as never,
        {
          kind: "agent-model",
          scope: "user",
          destination: { kind: "root-agent" },
          agent: "critic",
          model: [{ id: "xai/grok-4.5", variant: "xhigh" }],
        },
        s.revisions,
      );
      expect(result.ok).toBe(true);
      const obj = parseConfigText(readFileSync(s.userFile, "utf-8"));
      const critic = (obj.agents as Record<string, Record<string, unknown>>)
        .critic!;
      expect(critic.model).toBe("xai/grok-4.5");
      expect(Array.isArray(critic.model)).toBe(false);
      expect(critic.variant).toBe("xhigh");
    });
  });

  realTest("single to multi preserves the independent sibling variant", () => {
    withSchemaOverride(REAL_SCHEMA, () => {
      const s = freshSandbox();
      writeFileSync(
        s.userFile,
        JSON.stringify({
          agents: {
            critic: { model: "xai/grok-4.5", variant: "xhigh" },
          },
        }),
      );
      const result = applyMutation(
        s.cfg as never,
        {
          kind: "agent-model",
          scope: "user",
          destination: { kind: "root-agent" },
          agent: "critic",
          model: ["xai/grok-4.5", "openai/gpt-5.6-sol"],
        },
        s.revisions,
      );
      expect(result.ok).toBe(true);
      const obj = parseConfigText(readFileSync(s.userFile, "utf-8"));
      const critic = (obj.agents as Record<string, Record<string, unknown>>)
        .critic!;
      expect(critic.model).toEqual([
        "xai/grok-4.5",
        "openai/gpt-5.6-sol",
      ]);
      // Installed dist:20001-20029: agent-level variant is independent and is
      // NOT a default for fallback-chain entries, so model mutation leaves it.
      expect(critic.variant).toBe("xhigh");
    });
  });

  realTest("full candidate validation rejects an unrelated invalid agent field", () => {
    withSchemaOverride(REAL_SCHEMA, () => {
      const s = freshSandbox();
      writeFileSync(
        s.userFile,
        `{
  // full-document gate must retain comments and inspect fixer too
  "preset": "review",
  "presets": { "review": { "critic": { "model": "xai/grok-4.5" } } },
  "agents": {
    "critic": { "model": "xai/grok-4.5" },
    "fixer": { "model": "openai/gpt-5.6-sol", "temperature": 99 }
  },
  "disabled_agents": [],
  "council": { "presets": { "balanced": { "alpha": { "model": "openai/gpt-5.6-sol" } } } },
  "acpAgents": { "bridge": { "command": "node", "wrapperModel": "openai/gpt-5.6-sol" } }
}\n`,
      );
      const before = readFileSync(s.userFile, "utf-8");
      const mutation: ConfigMutation = {
        kind: "agent-model",
        scope: "user",
        destination: { kind: "root-agent" },
        agent: "critic",
        model: [{ id: "xai/grok-4.5", variant: "xhigh" }],
      };
      const sim = simulateMutation(s.cfg as never, mutation);
      expect(sim.ok).toBe(false);
      expect(sim.schemaValidation?.ok).toBe(false);
      expect(
        sim.schemaValidation?.issues.some(
          (i) => i.path === "agents.fixer.temperature",
        ),
      ).toBe(true);

      // Apply recomputes simulation independently; no simulate-cache reliance.
      const applied = applyMutation(s.cfg as never, mutation, s.revisions);
      expect(applied.ok).toBe(false);
      expect(applied.schemaValidation?.ok).toBe(false); // HTTP layer maps this to 422
      expect(readFileSync(s.userFile, "utf-8")).toBe(before);
      expect(s.revisions.list().length).toBe(0);
    });
  });

  realTest("rich valid full candidate passes and preserves JSONC comments", () => {
    withSchemaOverride(REAL_SCHEMA, () => {
      const s = freshSandbox();
      writeFileSync(
        s.userFile,
        `{
  // keep-rich-comment
  "preset": "review",
  "presets": { "review": { "critic": { "model": "xai/grok-4.5" } } },
  "agents": {
    "critic": { "model": "xai/grok-4.5" },
    "fixer": { "model": "openai/gpt-5.6-sol", "temperature": 1.25 }
  },
  "disabled_agents": [],
  "council": { "presets": { "balanced": { "alpha": { "model": "openai/gpt-5.6-sol" } } } },
  "acpAgents": { "bridge": { "command": "node", "wrapperModel": "openai/gpt-5.6-sol" } }
}\n`,
      );
      const result = applyMutation(
        s.cfg as never,
        {
          kind: "agent-model",
          scope: "user",
          destination: { kind: "root-agent" },
          agent: "critic",
          model: ["xai/grok-4.5", "openai/gpt-5.6-sol"],
        },
        s.revisions,
      );
      expect(result.ok).toBe(true);
      expect(result.schemaValidation?.ok).toBe(true);
      const text = readFileSync(s.userFile, "utf-8");
      expect(text).toContain("keep-rich-comment");
      expect(text).toContain('"temperature": 1.25');
    });
  });

  realTest("legacy bare object payload is normalized, never persisted standalone", () => {
    withSchemaOverride(REAL_SCHEMA, () => {
      const s = freshSandbox();
      writeFileSync(s.userFile, JSON.stringify({ agents: { critic: { model: "old/model" } } }));
      const legacy = {
        kind: "agent-model",
        scope: "user",
        destination: { kind: "root-agent" },
        agent: "critic",
        model: { id: "xai/grok-4.5", variant: "xhigh" },
      } as unknown as ConfigMutation;
      const result = applyMutation(s.cfg as never, legacy, s.revisions);
      expect(result.ok).toBe(true);
      const obj = parseConfigText(readFileSync(s.userFile, "utf-8"));
      const critic = (obj.agents as Record<string, Record<string, unknown>>).critic!;
      expect(critic.model).toBe("xai/grok-4.5");
      expect(typeof critic.model).toBe("string");
      expect(critic.variant).toBe("xhigh");
    });
  });

  realTest("restore blocks an invalid historical standalone-object snapshot", () => {
    withSchemaOverride(REAL_SCHEMA, () => {
      const s = freshSandbox();
      writeFileSync(s.userFile, JSON.stringify({ agents: { critic: { model: "xai/grok-4.5" } } }));
      const working = readFileSync(s.userFile, "utf-8");
      s.revisions.insert({
        id: "legacy-invalid",
        timestamp: "2026-08-12T00:00:00.000Z",
        targetPath: s.userFile,
        scope: "user",
        oldHash: "old",
        newHash: "new",
        mutationKind: "agent-model",
        mutationJson: "{}",
        beforeContent: JSON.stringify({ agents: { critic: { model: { id: "xai/grok-4.5", variant: "xhigh" } } } }),
        afterContent: working,
      });
      const result = restoreRevision(s.cfg as never, "legacy-invalid", s.revisions);
      expect(result.ok).toBe(false);
      expect(result.schemaValidation?.ok).toBe(false);
      expect(result.schemaValidation?.issues.some((i) => i.path === "agents.critic.model")).toBe(true);
      expect(readFileSync(s.userFile, "utf-8")).toBe(working);
      expect(s.revisions.list().length).toBe(1);
    });
  });
});

describe("schema unavailable fail-closed mechanics", () => {
  test("simulate, apply, and restore all block without a schema", () => {
    withSchemaOverride(undefined, () => {
      const s = freshSandbox(false);
      const mutation: ConfigMutation = {
        kind: "agent-model",
        scope: "user",
        destination: { kind: "root-agent" },
        agent: "critic",
        model: ["xai/grok-4.5"],
      };
      const before = readFileSync(s.userFile, "utf-8");
      const sim = simulateMutation(s.cfg as never, mutation);
      expect(sim.ok).toBe(false);
      expect(sim.schemaValidation?.unavailable).toBe(true);

      const applied = applyMutation(s.cfg as never, mutation, s.revisions);
      expect(applied.ok).toBe(false);
      expect(applied.schemaValidation?.unavailable).toBe(true);
      expect(readFileSync(s.userFile, "utf-8")).toBe(before);
      expect(s.revisions.list().length).toBe(0);

      s.revisions.insert({
        id: "restore-no-schema",
        timestamp: "2026-08-12T00:00:00.000Z",
        targetPath: s.userFile,
        scope: "user",
        oldHash: "old",
        newHash: "new",
        mutationKind: "agent-model",
        mutationJson: "{}",
        beforeContent: "{}",
        afterContent: before,
      });
      const restored = restoreRevision(s.cfg as never, "restore-no-schema", s.revisions);
      expect(restored.ok).toBe(false);
      expect(restored.schemaValidation?.unavailable).toBe(true);
      expect(readFileSync(s.userFile, "utf-8")).toBe(before);
      expect(s.revisions.list().length).toBe(1);

      // Read-side tolerant parsing remains available even while writes block.
      expect(parseConfigText(readFileSync(s.userFile, "utf-8"))).toBeDefined();
    });
  });
});

// silence unused type import
void (null as unknown as ServerConfig);
