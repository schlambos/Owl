/**
 * Slice 18 D0 — installed schema authority.
 *
 * Proves: authorized-root discovery, package version + full schema hash,
 * public cache key, no remote `$schema` fetch, fail-closed write capability,
 * and document/status generation identity.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  _clearAuthorityCache,
  getInstalledSchemaDocument,
  loadInstalledSchema,
  publicSchemaCacheKey,
  schemaGenerationFor,
} from "./authority";
import { _clearValidatorCache, getOmoSchemaStatus, getValidator } from "./validator";
import {
  AUDITED_INTERVIEW_FIELD_NAMES,
  AUDITED_INTERVIEW_PACKAGE_VERSION,
  AUDITED_INTERVIEW_SCHEMA_HASH,
  extractInterviewSchemaFields,
  interviewFieldsMatchAudited,
} from "./introspect";

const REAL_CONFIG_DIR =
  process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), ".config", "opencode");
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

const RUNTIME_ROOT = join(import.meta.dir, "../../test/schema-sandbox/authority");

const originalFetch = globalThis.fetch;

function syntheticPackage(
  root: string,
  version: string,
  schema: Record<string, unknown>,
): string {
  const dir = join(root, "node_modules", "oh-my-opencode-slim");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "oh-my-opencode-slim", version }),
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
  _clearAuthorityCache();
  _clearValidatorCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  rmSync(RUNTIME_ROOT, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
});

describe("installed authority — authorized roots only", () => {
  test("missing package is unavailable (fail-closed write capability)", () => {
    const snap = loadInstalledSchema({
      opencodeConfigDir: RUNTIME_ROOT,
      authorizedRoots: [RUNTIME_ROOT],
    });
    expect(snap.available).toBe(false);
    if (snap.available) return;
    expect(snap.error).toMatch(/not found/i);

    const status = getOmoSchemaStatus({
      host: "127.0.0.1",
      port: 0,
      opencodeConfigDir: RUNTIME_ROOT,
      projectDirectory: join(RUNTIME_ROOT, "project"),
      owlInstallDirectory: join(RUNTIME_ROOT, "project"),
      authorizedRoots: [RUNTIME_ROOT, join(RUNTIME_ROOT, "project")],
    });
    expect(status.available).toBe(false);
    expect(status.writeCapability).toBe("closed");
    expect(status.current).toBe(true);
    expect(status.userConfig.present).toBe(false);
  });

  test("discovered package outside authorized roots is rejected before read", () => {
    const snap = loadInstalledSchema({
      opencodeConfigDir: "/tmp/omo-d0-unauthorized-opencode",
      authorizedRoots: [RUNTIME_ROOT],
    });
    expect(snap.available).toBe(false);
    if (snap.available) return;
    expect(snap.error).toMatch(/authorized scope/i);
    expect(existsSync("/tmp/omo-d0-unauthorized-opencode")).toBe(false);
  });

  test("explicit schemaPath outside authorized roots is rejected before read", () => {
    const previous = process.env.OMO_SCHEMA_PATH;
    delete process.env.OMO_SCHEMA_PATH;
    try {
      const snap = loadInstalledSchema({
        schemaPath: "/tmp/omo-d0-unauthorized-schema.json",
        authorizedRoots: [RUNTIME_ROOT],
      });
      expect(snap.available).toBe(false);
      if (snap.available) return;
      expect(snap.error).toMatch(/authorized scope/i);
      expect(existsSync("/tmp/omo-d0-unauthorized-schema.json")).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OMO_SCHEMA_PATH;
      else process.env.OMO_SCHEMA_PATH = previous;
    }
  });

  test("OMO_SCHEMA_PATH outside authorized roots is rejected before read", () => {
    const previous = process.env.OMO_SCHEMA_PATH;
    process.env.OMO_SCHEMA_PATH = "/tmp/omo-d0-unauthorized-env-schema.json";
    try {
      const snap = loadInstalledSchema({
        opencodeConfigDir: RUNTIME_ROOT,
        authorizedRoots: [RUNTIME_ROOT],
      });
      expect(snap.available).toBe(false);
      if (snap.available) return;
      expect(snap.error).toMatch(/authorized scope/i);
      expect(existsSync("/tmp/omo-d0-unauthorized-env-schema.json")).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OMO_SCHEMA_PATH;
      else process.env.OMO_SCHEMA_PATH = previous;
    }
  });

  test("version/schema change changes cache key and recompiles", () => {
    syntheticPackage(RUNTIME_ROOT, "1.0.0-test", {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { flag: { const: "a" } },
      required: ["flag"],
    });
    const first = loadInstalledSchema({
      opencodeConfigDir: RUNTIME_ROOT,
      authorizedRoots: [RUNTIME_ROOT],
    });
    expect(first.available).toBe(true);
    if (!first.available) return;
    expect(first.packageVersion).toBe("1.0.0-test");
    expect(first.cacheKey).toBe(
      publicSchemaCacheKey("1.0.0-test", first.schemaHash),
    );
    const firstGen = schemaGenerationFor(first.cacheKey);

    writeFileSync(
      join(RUNTIME_ROOT, "node_modules", "oh-my-opencode-slim", "package.json"),
      JSON.stringify({ version: "2.0.0-test" }),
    );
    writeFileSync(
      join(
        RUNTIME_ROOT,
        "node_modules",
        "oh-my-opencode-slim",
        "oh-my-opencode-slim.schema.json",
      ),
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { flag: { const: "b" } },
        required: ["flag"],
      }),
    );

    const second = loadInstalledSchema({
      opencodeConfigDir: RUNTIME_ROOT,
      authorizedRoots: [RUNTIME_ROOT],
    });
    expect(second.available).toBe(true);
    if (!second.available) return;
    expect(second.packageVersion).toBe("2.0.0-test");
    expect(second.schemaHash).not.toBe(first.schemaHash);
    expect(second.cacheKey).not.toBe(first.cacheKey);
    expect(schemaGenerationFor(second.cacheKey)).not.toBe(firstGen);

    const handle = getValidator({
      opencodeConfigDir: RUNTIME_ROOT,
      authorizedRoots: [RUNTIME_ROOT],
    });
    expect(handle.available).toBe(true);
    expect(handle.cacheKey).toBe(second.cacheKey);
  });

  test("document endpoint payload never fetches remote $schema", () => {
    syntheticPackage(RUNTIME_ROOT, "9.9.9-test", {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { enabled: { type: "boolean" } },
    });
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("unexpected remote fetch");
    }) as unknown as typeof fetch;

    const doc = getInstalledSchemaDocument({
      opencodeConfigDir: RUNTIME_ROOT,
      authorizedRoots: [RUNTIME_ROOT],
    });
    expect(doc.available).toBe(true);
    if (!doc.available) return;
    expect(doc.packageVersion).toBe("9.9.9-test");
    expect(doc.schemaHash).toMatch(/^[a-f0-9]{64}$/);
    expect(doc.cacheKey).toBe(
      publicSchemaCacheKey("9.9.9-test", doc.schemaHash),
    );
    expect(doc.schema.type).toBe("object");
    expect(fetchCalls).toBe(0);
  });

  test("unavailable document is fail-closed without remote fetch", () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const doc = getInstalledSchemaDocument({
      opencodeConfigDir: RUNTIME_ROOT,
      authorizedRoots: [RUNTIME_ROOT],
    });
    expect(doc.available).toBe(false);
    expect(fetchCalls).toBe(0);
  });
});

describe("installed 2.2.10 Interview authority (live package)", () => {
  realTest("package version, full schema hash, and interview field set", () => {
    const snap = loadInstalledSchema({
      opencodeConfigDir: REAL_CONFIG_DIR,
      authorizedRoots: [REAL_CONFIG_DIR],
    });
    expect(snap.available).toBe(true);
    if (!snap.available) return;

    const pkg = JSON.parse(readFileSync(REAL_PKG, "utf-8")) as { version: string };
    const bytes = readFileSync(REAL_SCHEMA, "utf-8");
    const hash = createHash("sha256").update(bytes).digest("hex");

    expect(snap.packageVersion).toBe(pkg.version);
    expect(snap.packageVersion).toBe(AUDITED_INTERVIEW_PACKAGE_VERSION);
    expect(snap.schemaHash).toBe(hash);
    expect(snap.schemaHash).toBe(AUDITED_INTERVIEW_SCHEMA_HASH);
    expect(snap.cacheKey).toBe(
      publicSchemaCacheKey(AUDITED_INTERVIEW_PACKAGE_VERSION, hash),
    );
    expect(snap.schemaPath.startsWith(REAL_CONFIG_DIR)).toBe(true);
    expect(snap.packageManifestPath.startsWith(REAL_CONFIG_DIR)).toBe(true);

    const extracted = extractInterviewSchemaFields(snap.schema);
    expect(extracted.ok).toBe(true);
    expect(extracted.fieldNames).toEqual([...AUDITED_INTERVIEW_FIELD_NAMES]);
    expect(interviewFieldsMatchAudited(extracted).ok).toBe(true);

    const byName = new Map(extracted.fields.map((f) => [f.name, f]));
    expect(byName.get("maxQuestions")).toMatchObject({
      schemaType: "integer",
      defaultValue: 2,
      minimum: 1,
      maximum: 10,
    });
    expect(byName.get("outputFolder")).toMatchObject({
      schemaType: "string",
      defaultValue: "interview",
      minLength: 1,
    });
    expect(byName.get("autoOpenBrowser")).toMatchObject({
      schemaType: "boolean",
      defaultValue: true,
    });
    expect(byName.get("port")).toMatchObject({
      schemaType: "integer",
      defaultValue: 0,
      minimum: 0,
      maximum: 65535,
    });
    expect(byName.get("dashboard")).toMatchObject({
      schemaType: "boolean",
      defaultValue: false,
    });
  });

  realTest("zero remote fetch against the live installed schema", () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("remote $schema fetch is forbidden");
    }) as unknown as typeof fetch;
    const doc = getInstalledSchemaDocument({
      opencodeConfigDir: REAL_CONFIG_DIR,
      authorizedRoots: [REAL_CONFIG_DIR],
    });
    expect(doc.available).toBe(true);
    expect(fetchCalls).toBe(0);
  });
});
