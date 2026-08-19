/**
 * DTO freeze tests (named test 2).
 *
 * The serialized catalog/manage DTOs must NEVER contain `apiKey`, `key`,
 * or a planted secret value — even when the raw live payloads and the raw
 * filesystem config carry them.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCatalog, buildManage } from "./catalog";
import { findSecretLeaks } from "../opencode-config/sanitizer";
import { OpenCodeClient } from "../opencode/client";

const PLANTED = "sk-planted-secret-7f3a";

let sandbox: string;
let configDir: string;
let projectDir: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "omo-freeze-"));
  configDir = join(sandbox, "config");
  projectDir = join(sandbox, "project");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* */ }
});

/** Live client whose /config/providers payloads carry planted secrets. */
function secretBearingClient(): OpenCodeClient {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/config/providers")) {
      return new Response(JSON.stringify({
        providers: [
          {
            id: "openai",
            name: "OpenAI",
            source: "env",
            key: PLANTED,
            env: "OPENAI_API_KEY",
            models: [{ id: "gpt-4o", name: "GPT-4o" }],
          },
          {
            id: "anthropic",
            name: "Anthropic",
            source: "api",
            key: PLANTED,
            options: { apiKey: PLANTED },
            models: { "claude-sonnet-4": { name: "Sonnet" } },
          },
        ],
        default: { openai: "gpt-4o" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/provider")) {
      return new Response(JSON.stringify({
        all: [] ,
        connected: ["openai"],
        default: { openai: "gpt-4o" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return new OpenCodeClient("http://127.0.0.1:4096", {
    projectDirectory: projectDir,
    authorizedRoots: [sandbox],
    fetchImpl,
  });
}

describe("provider-management DTO freeze", () => {
  test("catalog JSON never contains apiKey, key, or a planted secret", async () => {
    const dto = await buildCatalog(() => secretBearingClient());
    const serialized = JSON.stringify(dto);
    const leaks = findSecretLeaks(serialized, [PLANTED]);
    expect(leaks).toEqual([]);
    // Structural check: only declared allowlist keys may appear.
    const entry = dto.providers.find((p) => p.id === "openai");
    expect(entry).toBeDefined();
    expect(Object.keys(entry!).sort()).toEqual(["connected", "id", "modelCount", "name", "source"].sort());
    // Connected came from the /provider authority.
    expect(entry!.connected).toBe(true);
    expect(dto.connected).toEqual(["openai"]);
  });

  test("manage JSON never contains apiKey, key, or a planted secret", async () => {
    // Filesystem Desired carries a planted apiKey + whitelist + raw options.
    writeFileSync(join(configDir, "opencode.jsonc"), `{
      "plugin": ["npm-pkg-a"],
      "enabled_providers": ["litellm"],
      "disabled_providers": ["litellm"],
      "provider": {
        "litellm": {
          "npm": "@ai-sdk/openai-compatible",
          "name": "LiteLLM",
          "options": { "baseURL": "http://127.0.0.1:4000/v1", "apiKey": "${PLANTED}", "headers": { "x-a": "b" } },
          "whitelist": ["gpt-4o"],
          "api": "internal",
          "env": "LITELLM_KEY",
          "models": { "gpt-4o": {} },
          "blacklist": ["old-model"]
        }
      }
    }`, "utf-8");

    const dto = await buildManage(
      {
        opencodeConfigDir: configDir,
        projectDirectory: projectDir,
        owlInstallDirectory: projectDir,
        authorizedRoots: [sandbox],
      },
      () => secretBearingClient(),
    );
    const serialized = JSON.stringify(dto);
    const leaks = findSecretLeaks(serialized, [PLANTED]);
    expect(leaks).toEqual([]);

    // Secret-free desired allowlist retains only the declared fields.
    const desired = dto.desired.find((p) => p.id === "litellm");
    expect(desired).toBeDefined();
    expect(desired!.baseURL).toBe("http://127.0.0.1:4000/v1");
    expect(desired!.blacklist).toEqual(["old-model"]);
    expect(desired!.enableDisableConflict).toBe(true);
    for (const k of Object.keys(desired!)) {
      expect(["apiKey", "whitelist", "api", "env", "options", "headers", "key"]).not.toContain(k);
    }
  });
});
