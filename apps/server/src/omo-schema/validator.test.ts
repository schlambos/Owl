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
import { serializeOmoAgentModel } from "../omo/model-serializer";
import {
  _clearValidatorCache,
  getOmoSchemaStatus,
  getValidator,
  validateCandidateText,
  validateDocument,
} from "./validator";

const REAL_CONFIG_DIR =
  process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), ".config", "opencode");
const REAL_SCHEMA = join(
  REAL_CONFIG_DIR,
  "node_modules",
  "oh-my-opencode-slim",
  "oh-my-opencode-slim.schema.json",
);
const REAL_AVAILABLE = existsSync(REAL_SCHEMA);
const realTest = REAL_AVAILABLE ? test : test.skip;
const RUNTIME_ROOT = join(import.meta.dir, "../../test/schema-sandbox/runtime");

function syntheticPackage(
  root: string,
  version: string,
  schema: Record<string, unknown>,
): string {
  const dir = join(root, "node_modules", "oh-my-opencode-slim");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "synthetic-oh-my-opencode-slim", version }),
  );
  writeFileSync(
    join(dir, "oh-my-opencode-slim.schema.json"),
    JSON.stringify(schema),
  );
  return dir;
}

beforeEach(() => {
  rmSync(RUNTIME_ROOT, { recursive: true, force: true });
  mkdirSync(RUNTIME_ROOT, { recursive: true });
  _clearValidatorCache();
});

afterAll(() => {
  rmSync(RUNTIME_ROOT, { recursive: true, force: true });
});

describe("canonical OMO model serializer", () => {
  test("one-entry object collapses to string and promotes variant", () => {
    expect(
      serializeOmoAgentModel([
        { id: "xai/grok-4.5", variant: "xhigh" },
      ]),
    ).toEqual({ model: "xai/grok-4.5", promotedVariant: "xhigh" });
  });

  test("fallback arrays preserve order and use objects only for variant entries", () => {
    expect(
      serializeOmoAgentModel([
        "xai/grok-4.5",
        { id: "openai/gpt-5.6-sol", variant: "high" },
      ]),
    ).toEqual({
      model: [
        "xai/grok-4.5",
        { id: "openai/gpt-5.6-sol", variant: "high" },
      ],
    });
  });
});

describe("installed 2.2.10 schema correctness", () => {
  realTest("rejects the incident standalone model object with a dot path", () => {
    const result = validateDocument(
      {
        agents: {
          critic: {
            model: { id: "xai/grok-4.5", variant: "xhigh" },
          },
        },
      },
      { opencodeConfigDir: REAL_CONFIG_DIR },
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.path === "agents.critic.model")).toBe(
      true,
    );
  });

  realTest("accepts object, string, and mixed fallback arrays", () => {
    const ctx = { opencodeConfigDir: REAL_CONFIG_DIR };
    for (const model of [
      [
        { id: "xai/grok-4.5", variant: "xhigh" },
        { id: "openai/gpt-5.6-sol" },
      ],
      ["xai/grok-4.5", "openai/gpt-5.6-sol"],
      [
        "xai/grok-4.5",
        { id: "openai/gpt-5.6-sol", variant: "high" },
      ],
    ]) {
      expect(validateDocument({ agents: { critic: { model } } }, ctx).ok).toBe(
        true,
      );
    }
  });

  realTest("validates a rich full document, including council and ACP", () => {
    const rich = {
      preset: "review",
      presets: {
        review: {
          critic: { model: "xai/grok-4.5", variant: "xhigh" },
        },
      },
      agents: {
        critic: { model: "xai/grok-4.5" },
        fixer: { model: ["openai/gpt-5.6-sol", "xai/grok-4.5"] },
      },
      disabled_agents: [],
      backgroundJobs: {},
      fallback: {},
      council: {
        default_preset: "balanced",
        presets: {
          balanced: {
            alpha: { model: "openai/gpt-5.6-sol", variant: "high" },
          },
        },
      },
      acpAgents: {
        bridge: { command: "node", wrapperModel: "openai/gpt-5.6-sol" },
      },
    };
    expect(
      validateDocument(rich, { opencodeConfigDir: REAL_CONFIG_DIR }).ok,
    ).toBe(true);
  });
});

describe("loader mechanics", () => {
  test("missing package is unavailable (fail-closed)", () => {
    const result = validateDocument({}, { opencodeConfigDir: RUNTIME_ROOT });
    expect(result.ok).toBe(false);
    expect(result.unavailable).toBe(true);
    expect(result.issues[0]?.keyword).toBe("unavailable");
  });

  test("version/schema replacement invalidates the compiled cache", () => {
    const schemaPath = join(
      RUNTIME_ROOT,
      "node_modules",
      "oh-my-opencode-slim",
      "oh-my-opencode-slim.schema.json",
    );
    syntheticPackage(RUNTIME_ROOT, "1.0.0-test", {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { flag: { const: "a" } },
      required: ["flag"],
    });
    const first = validateDocument(
      { flag: "a" },
      { opencodeConfigDir: RUNTIME_ROOT },
    );
    const firstHandle = getValidator({ opencodeConfigDir: RUNTIME_ROOT });
    expect(first.ok).toBe(true);
    expect(firstHandle.packageVersion).toBe("1.0.0-test");

    writeFileSync(
      join(RUNTIME_ROOT, "node_modules", "oh-my-opencode-slim", "package.json"),
      JSON.stringify({ version: "2.0.0-test" }),
    );
    writeFileSync(
      schemaPath,
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { flag: { const: "b" } },
        required: ["flag"],
      }),
    );

    const second = validateDocument(
      { flag: "a" },
      { opencodeConfigDir: RUNTIME_ROOT },
    );
    const secondHandle = getValidator({ opencodeConfigDir: RUNTIME_ROOT });
    expect(second.ok).toBe(false);
    expect(secondHandle.packageVersion).toBe("2.0.0-test");
    expect(secondHandle.schemaHash).not.toBe(firstHandle.schemaHash);
  });

  test("status validates current user file and reports absent project file", () => {
    syntheticPackage(RUNTIME_ROOT, "9.9.9-test", {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { enabled: { type: "boolean" } },
      required: ["enabled"],
    });
    writeFileSync(
      join(RUNTIME_ROOT, "oh-my-opencode-slim.json"),
      JSON.stringify({ enabled: true }),
    );
    const project = join(RUNTIME_ROOT, "project");
    mkdirSync(project, { recursive: true });
    const status = getOmoSchemaStatus({
      host: "127.0.0.1",
      port: 0,
      opencodeConfigDir: RUNTIME_ROOT,
      projectDirectory: project,
      owlInstallDirectory: project,
      authorizedRoots: [RUNTIME_ROOT, project],
    });
    expect(status.available).toBe(true);
    expect(status.packageVersion).toBe("9.9.9-test");
    expect(status.userConfig).toEqual({ present: true, valid: true, issues: [] });
    expect(status.projectConfig).toEqual({
      present: false,
      valid: null,
      issues: [],
    });
  });

  test("JSONC parser participates in the same validation pipeline", () => {
    const dir = syntheticPackage(RUNTIME_ROOT, "1.0.0-test", {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
    });
    const schemaPath = join(dir, "oh-my-opencode-slim.schema.json");
    expect(
      validateCandidateText('{ // retained by writers\n "value": 1,\n}', {
        schemaPath,
        authorizedRoots: [RUNTIME_ROOT],
      }).ok,
    ).toBe(true);
    expect(readFileSync(schemaPath, "utf-8")).toContain("required");
  });
});
