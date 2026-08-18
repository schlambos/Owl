import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { composePrompt, resolveProvenance } from "./provenance";

const FIX = join(import.meta.dir, "../../test/fixtures");

function roots(...paths: string[]) {
  return paths;
}

describe("resolveProvenance user-only", () => {
  const userDir = join(FIX, "user-only");
  const projectDir = join(FIX, "user-only-project-empty");
  mkdirSync(projectDir, { recursive: true });

  const bundle = resolveProvenance({
    opencodeConfigDir: userDir,
    projectDirectory: projectDir,
    authorizedRoots: roots(userDir, projectDir),
    includePromptText: true,
  });

  test("preset from file", () => {
    expect(bundle.preset).toBe("p1");
    expect(bundle.filePreset).toBe("p1");
  });

  test("root agent over preset variant", () => {
    const v = bundle.properties["agents.oracle.variant"];
    expect(v?.value).toBe("high");
    expect(v?.winner.stage).toBe("root-agent");
    expect(v?.overridden.some((o) => o.stage === "preset" && o.value === "medium")).toBe(
      true,
    );
  });

  test("explorer model from preset", () => {
    expect(bundle.agents.explorer?.modelPrimary).toBe("preset/explorer");
    const m = bundle.properties["agents.explorer.model"];
    expect(m?.winner.stage).toBe("preset");
  });

  test("custom agent", () => {
    expect(bundle.agents.researcher?.kind).toBe("custom");
    expect(bundle.agents.researcher?.modelPrimary).toBe("custom/researcher");
  });

  test("unknown fields preserved in raw", () => {
    expect((bundle.rawMerged as { unknownFutureKey?: unknown }).unknownFutureKey).toEqual({
      keep: true,
    });
  });

  test("nested backgroundJobs leaves", () => {
    expect(bundle.properties["backgroundJobs.maxSessionsPerAgent"]?.value).toBe(3);
    expect(bundle.properties["backgroundJobs.maxContextLines"]?.value).toBe(1000);
  });

  test("runtime preset unknown", () => {
    expect(bundle.runtimePreset?.known).toBe(false);
  });
});

describe("project over user", () => {
  const userDir = join(FIX, "project-over-user/user");
  const projectDir = join(FIX, "project-over-user/project");
  const bundle = resolveProvenance({
    opencodeConfigDir: userDir,
    projectDirectory: projectDir,
    authorizedRoots: roots(userDir, projectDir),
  });

  test("array replacement skills", () => {
    const skills = bundle.properties["agents.explorer.skills"];
    expect(skills?.value).toEqual(["project-skill"]);
    expect(skills?.arrayReplaced || skills?.winner.stage === "root-agent" || skills?.winner.stage === "project-config").toBeTruthy();
  });

  test("nested object partial override", () => {
    // maxSessionsPerAgent from user, maxContextLines from project
    expect(bundle.properties["backgroundJobs.maxSessionsPerAgent"]?.value).toBe(2);
    expect(bundle.properties["backgroundJobs.maxContextLines"]?.value).toBe(999);
    expect(
      bundle.properties["backgroundJobs.maxContextLines"]?.winner.stage,
    ).toBe("project-config");
  });

  test("project temperature", () => {
    expect(bundle.properties["agents.explorer.temperature"]?.value).toBe(0.1);
  });
});

describe("environment preset", () => {
  const userDir = join(FIX, "user-only");
  const projectDir = join(FIX, "user-only-project-empty");
  const bundle = resolveProvenance({
    opencodeConfigDir: userDir,
    projectDirectory: projectDir,
    authorizedRoots: roots(userDir, projectDir),
    env: { ...process.env, OH_MY_OPENCODE_SLIM_PRESET: "missing-preset" },
  });

  test("env overrides file preset name", () => {
    expect(bundle.preset).toBe("missing-preset");
    expect(bundle.envPreset).toBe("missing-preset");
    expect(bundle.properties["preset"]?.winner.stage).toBe("env");
    expect(bundle.warnings.some((w) => w.kind === "missing-preset")).toBe(true);
  });
});

describe("project absent", () => {
  const userDir = join(FIX, "user-only");
  const projectDir = join(FIX, "no-such-project-dir-xyz");
  mkdirSync(projectDir, { recursive: true });
  const bundle = resolveProvenance({
    opencodeConfigDir: userDir,
    projectDirectory: projectDir,
    authorizedRoots: roots(userDir, projectDir),
  });
  test("still loads user", () => {
    expect(bundle.agents.explorer?.modelPrimary).toBe("preset/explorer");
    expect(bundle.sources.find((s) => s.kind === "project-omo")?.present).toBe(false);
  });
});

describe("prompts", () => {
  const userDir = join(FIX, "prompts-user");
  // config file is oh-my-opencode-slim.json in userDir; prompts in oh-my-opencode-slim/
  const projectDir = join(FIX, "user-only-project-empty");
  mkdirSync(projectDir, { recursive: true });

  test("inline overrides replacement; append applies", () => {
    const bundle = resolveProvenance({
      opencodeConfigDir: userDir,
      projectDirectory: projectDir,
      authorizedRoots: roots(userDir, projectDir),
      includePromptText: true,
    });
    const p = bundle.prompts.explorer!;
    expect(p.baseSource.kind).toBe("inline");
    expect(p.appendSources.length).toBe(1);
    expect(p.effectiveText).toContain("INLINE explorer");
    expect(p.effectiveText).toContain("APPEND explorer");
    expect(p.warnings.some((w) => w.includes("overrides replacement"))).toBe(true);
  });

  test("orchestrator append discovered", () => {
    const bundle = resolveProvenance({
      opencodeConfigDir: userDir,
      projectDirectory: projectDir,
      authorizedRoots: roots(userDir, projectDir),
      includePromptText: true,
    });
    const o = bundle.prompts.orchestrator!;
    expect(o.appendSources.some((s) => s.path?.endsWith("orchestrator_append.md"))).toBe(
      true,
    );
  });

  test("composePrompt pure", () => {
    const r = composePrompt({
      agent: "x",
      inline: undefined,
      fileReplacement: {
        path: "/a/x.md",
        scope: "user",
        kind: "replacement-file",
        rank: 0,
        content: "FILE",
      },
      fileAppend: {
        path: "/a/x_append.md",
        scope: "user",
        kind: "append-file",
        rank: 0,
        content: "APP",
      },
      allHits: [],
      includeText: true,
    });
    expect(r.effectiveText).toBe("FILE\n\nAPP");
    expect(r.baseSource.kind).toBe("replacement-file");
  });
});

describe("out of scope project", () => {
  const userDir = join(FIX, "user-only");
  const outside = "/var/empty-not-authorized";
  const bundle = resolveProvenance({
    opencodeConfigDir: userDir,
    projectDirectory: outside,
    authorizedRoots: roots(userDir), // project not authorized
  });
  test("warns project out of scope", () => {
    expect(bundle.warnings.some((w) => w.kind === "project-out-of-scope")).toBe(true);
  });
});

describe("virtual source merge without disk path", () => {
  test("exists:true virtual project is merged even when no disk file exists", () => {
    const userDir = join(FIX, "user-only");
    const projectDir = join(FIX, "user-only-project-empty");
    mkdirSync(projectDir, { recursive: true });
    const bundle = resolveProvenance({
      opencodeConfigDir: userDir,
      projectDirectory: projectDir,
      authorizedRoots: roots(userDir, projectDir),
      virtualSources: {
        project: {
          exists: true,
          format: "jsonc",
          path: join(projectDir, ".opencode", "oh-my-opencode-slim.jsonc"),
          text: `{"interview":{"maxQuestions":4}}`,
          document: { interview: { maxQuestions: 4 } },
        },
      },
    });
    expect((bundle.rawMerged.interview as { maxQuestions?: number })?.maxQuestions).toBe(4);
    expect(bundle.properties["interview.maxQuestions"]?.value).toBe(4);
    expect(bundle.properties["interview.maxQuestions"]?.winner.stage).toBe("project-config");
  });

  test("exists:true virtual user is merged even when no disk file exists", () => {
    const userDir = join(FIX, "missing-user-virtual");
    const projectDir = join(FIX, "user-only-project-empty");
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    const bundle = resolveProvenance({
      opencodeConfigDir: userDir,
      projectDirectory: projectDir,
      authorizedRoots: roots(userDir, projectDir),
      virtualSources: {
        user: {
          exists: true,
          format: "jsonc",
          path: join(userDir, "oh-my-opencode-slim.jsonc"),
          text: `{"interview":{"maxQuestions":6}}`,
          document: { interview: { maxQuestions: 6 } },
        },
      },
    });
    expect((bundle.rawMerged.interview as { maxQuestions?: number })?.maxQuestions).toBe(6);
    expect(bundle.properties["interview.maxQuestions"]?.winner.stage).toBe("user-config");
  });
});

describe("fallback array provenance", () => {
  test("model string from preset", () => {
    const userDir = join(FIX, "user-only");
    const projectDir = join(FIX, "user-only-project-empty");
    const b = resolveProvenance({
      opencodeConfigDir: userDir,
      projectDirectory: projectDir,
      authorizedRoots: roots(userDir, projectDir),
    });
    expect(b.agents.explorer?.modelFallbacks).toEqual([]);
  });
});
