/**
 * OpenCode provider-management writer unit tests (named test 1).
 *
 * Assertions:
 *  - path-edit of provider.<id> + blacklist preserves the plugin array and
 *    unknown keys (and comments);
 *  - refuses options.apiKey (and any rogue options);
 *  - refuses whitelist;
 *  - 409 on hash mismatch (no write);
 *  - refuses when the resolver is unproven or the lifecycle is
 *    bridge-reconciliation-dirty.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeConfigWriter } from "./writer";
import { applyProviderMutationText } from "./mutations";
import { ProviderRevisionStore } from "./revisions";
import { parseConfigText } from "../cfgwrite/jsonc-edit";
import type { EffectivePluginView, EffectivePluginEntry } from "../opencode-bridge/types";

let sandbox: string;
let configDir: string;
let projectDir: string;
let store: ProviderRevisionStore;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "omo-pcfg-"));
  configDir = join(sandbox, "config");
  projectDir = join(sandbox, "project");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  store = new ProviderRevisionStore(join(sandbox, "data", "providers.db"), [sandbox]);
});

afterEach(() => {
  try { store.close(); } catch { /* */ }
  try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* */ }
});

const BASE_CONFIG = `{
  // keep me
  "plugin": ["npm-pkg-a"],
  "theme": "dark",
  "provider": {
    "existing": { "name": "Existing" }
  }
}
`;

function matchingView(text: string): EffectivePluginView {
  const parsed = parseConfigText(text);
  const plugin = (parsed.plugin ?? []) as string[];
  const entries: EffectivePluginEntry[] = plugin.map((p) => ({
    form: "string",
    effectiveIdentity: p,
    identityKind: "npm",
  }));
  return { entries };
}

function makeWriter(overrides: {
  view?: EffectivePluginView;
  isReconciliationClean?: () => boolean;
} = {}): OpenCodeConfigWriter {
  const text = readFileSync(join(configDir, "opencode.jsonc"), "utf-8");
  return new OpenCodeConfigWriter({
    opencodeConfigDir: configDir,
    projectDirectory: projectDir,
    owlInstallDirectory: projectDir,
    authorizedRoots: [sandbox],
    revisions: store,
    effectiveViewProvider: async () => overrides.view ?? matchingView(text),
    ...(overrides.isReconciliationClean !== undefined
      ? { isReconciliationClean: overrides.isReconciliationClean }
      : {}),
  });
}

describe("opencode-config mutations + writer", () => {
  test("path-edit of provider.<id> + blacklist preserves plugin and unknown keys", () => {
    const result = applyProviderMutationText(BASE_CONFIG, {
      kind: "add-custom",
      provider: {
        id: "litellm",
        name: "LiteLLM",
        baseURL: "http://127.0.0.1:4000/v1",
        models: [{ id: "gpt-4o" }, { id: "claude-via-proxy", name: "Claude" }],
        blacklist: ["claude-via-proxy"],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Comments preserved (jsonc path edit, not a whole-document rewrite).
    expect(result.text).toContain("// keep me");
    const doc = parseConfigText(result.text);
    // plugin array + unknown keys preserved byte-for-byte semantically.
    expect(doc.plugin).toEqual(["npm-pkg-a"]);
    expect(doc.theme).toBe("dark");
    const provider = doc.provider as Record<string, unknown>;
    expect(provider.existing).toEqual({ name: "Existing" });

    // Exact custom shape.
    expect(provider.litellm).toEqual({
      npm: "@ai-sdk/openai-compatible",
      name: "LiteLLM",
      options: { baseURL: "http://127.0.0.1:4000/v1" },
      models: { "gpt-4o": {}, "claude-via-proxy": { id: "claude-via-proxy", name: "Claude" } },
      blacklist: ["claude-via-proxy"],
    });

    // blacklist omitted/[] → key omitted.
    const noBlacklist = applyProviderMutationText(BASE_CONFIG, {
      kind: "add-custom",
      provider: {
        id: "litellm",
        name: "LiteLLM",
        baseURL: "http://127.0.0.1:4000/v1",
        models: [{ id: "gpt-4o" }],
        blacklist: [],
      },
    });
    expect(noBlacklist.ok).toBe(true);
    if (!noBlacklist.ok) return;
    const p2 = (parseConfigText(noBlacklist.text).provider as Record<string, Record<string, unknown>>).litellm!;
    expect("blacklist" in p2).toBe(false);
    expect(Object.keys(p2.options as Record<string, unknown>)).toEqual(["baseURL"]);
    expect(p2.npm).toBe("@ai-sdk/openai-compatible");
  });

  test("refuses options.apiKey", () => {
    const result = applyProviderMutationText(BASE_CONFIG, {
      kind: "add-custom",
      provider: {
        id: "litellm",
        name: "LiteLLM",
        baseURL: "http://127.0.0.1:4000/v1",
        models: [{ id: "gpt-4o" }],
        // adversarial: secret-bearing / rogue options must never be written
        apiKey: "sk-planted",
        options: { baseURL: "http://x", apiKey: "sk-planted" },
      } as never,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("shape-invalid");
  });

  test("refuses whitelist", () => {
    const result = applyProviderMutationText(BASE_CONFIG, {
      kind: "add-custom",
      provider: {
        id: "litellm",
        name: "LiteLLM",
        baseURL: "http://127.0.0.1:4000/v1",
        models: [{ id: "gpt-4o" }],
        whitelist: ["gpt-4o"],
      } as never,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("shape-invalid");
  });

  test("409 on hash mismatch — no write", async () => {
    writeFileSync(join(configDir, "opencode.jsonc"), BASE_CONFIG, "utf-8");
    const writer = makeWriter();
    const mutation = {
      kind: "set-blacklist" as const,
      providerId: "existing",
      blacklist: ["m1"],
    };
    const before = readFileSync(join(configDir, "opencode.jsonc"), "utf-8");

    const result = await writer.apply({ mutation, expectedSourceHash: "0".repeat(64) });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(result.errors[0]?.code).toBe("hash-conflict");
    // No write occurred.
    expect(readFileSync(join(configDir, "opencode.jsonc"), "utf-8")).toBe(before);
    expect(store.count()).toBe(0);

    // And a matching expected hash applies cleanly.
    const { hashContent } = await import("../cfgwrite/jsonc-edit");
    const good = await writer.apply({ mutation, expectedSourceHash: hashContent(before) });
    expect(good.ok).toBe(true);
    expect(store.count()).toBe(1);
  });

  test("refuses when resolver unproven", async () => {
    writeFileSync(join(configDir, "opencode.jsonc"), BASE_CONFIG, "utf-8");
    // Effective view does not match the file's plugin array → blocked.
    const badView: EffectivePluginView = {
      entries: [{ form: "string", effectiveIdentity: "other-plugin", identityKind: "npm" }],
    };
    const writer = makeWriter({ view: badView });
    const before = readFileSync(join(configDir, "opencode.jsonc"), "utf-8");
    const result = await writer.apply({
      mutation: { kind: "set-blacklist", providerId: "existing", blacklist: ["m1"] },
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("source-unproven");
    expect(readFileSync(join(configDir, "opencode.jsonc"), "utf-8")).toBe(before);
  });

  test("refuses when lifecycle is bridge-reconciliation-dirty", async () => {
    writeFileSync(join(configDir, "opencode.jsonc"), BASE_CONFIG, "utf-8");
    const writer = makeWriter({ isReconciliationClean: () => false });
    const before = readFileSync(join(configDir, "opencode.jsonc"), "utf-8");
    const result = await writer.apply({
      mutation: { kind: "set-blacklist", providerId: "existing", blacklist: ["m1"] },
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("bridge-reconciliation-dirty");
    expect(readFileSync(join(configDir, "opencode.jsonc"), "utf-8")).toBe(before);
  });

  test("first create: no candidates anywhere creates config-dir opencode.jsonc", async () => {
    // No config file on disk; effective view unavailable (proven NOT required).
    const writer = new OpenCodeConfigWriter({
      opencodeConfigDir: configDir,
      projectDirectory: projectDir,
      owlInstallDirectory: projectDir,
      authorizedRoots: [sandbox],
      revisions: store,
      effectiveViewProvider: async () => ({ entries: [], unavailable: true, invalid: true }),
    });
    const result = await writer.apply({
      mutation: {
        kind: "add-custom",
        provider: {
          id: "litellm",
          name: "LiteLLM",
          baseURL: "http://127.0.0.1:4000/v1",
          models: [{ id: "gpt-4o" }],
        },
      },
    });
    expect(result.ok).toBe(true);
    const doc = parseConfigText(readFileSync(join(configDir, "opencode.jsonc"), "utf-8"));
    expect((doc.provider as Record<string, unknown>).litellm).toBeDefined();
    expect(store.count()).toBe(1);
  });

  test("collision: rejects id matching slim catalog id or existing provider key", () => {
    const existing = applyProviderMutationText(BASE_CONFIG, {
      kind: "add-custom",
      provider: {
        id: "existing",
        name: "X",
        baseURL: "http://127.0.0.1:4000/v1",
        models: [{ id: "m" }],
      },
    });
    expect(existing.ok).toBe(false);
    if (!existing.ok) expect(existing.error.code).toBe("provider-id-collision");

    const catalog = applyProviderMutationText(
      BASE_CONFIG,
      {
        kind: "add-custom",
        provider: {
          id: "openai",
          name: "X",
          baseURL: "http://127.0.0.1:4000/v1",
          models: [{ id: "m" }],
        },
      },
      new Set(["openai"]),
    );
    expect(catalog.ok).toBe(false);
    if (!catalog.ok) expect(catalog.error.code).toBe("provider-id-collision");
  });
});
