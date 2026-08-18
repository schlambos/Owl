/**
 * buildModelUsage + computeEffectiveProbeSet unit tests (Slice 15, Lane 5a).
 * Pure functions over fabricated inventories.
 */

import { describe, expect, test } from "bun:test";
import type { EffectiveAgent } from "@omo/shared";
import type { CouncilInventory } from "../cfgwrite/council";
import type { AcpInventory } from "../cfgwrite/acp";
import { buildModelUsage, computeEffectiveProbeSet } from "./usage";

function agent(over: Partial<EffectiveAgent> & Pick<EffectiveAgent, "name">): EffectiveAgent {
  return {
    kind: "builtin",
    enabled: true,
    modelFallbacks: [],
    skills: [],
    mcps: [],
    hasInlinePrompt: false,
    hasOrchestratorPrompt: false,
    provenance: [],
    fieldProvenance: {},
    ...over,
  };
}

function council(presets: CouncilInventory["presets"]): CouncilInventory {
  return {
    default_preset: presets.find((p) => p.isDefault)?.name,
    effective_default_preset: presets.find((p) => p.isDefault)?.name ?? "default",
    defaultMissing: false,
    presets,
    coordinator: { agent: "council", note: "" },
    deprecated: [],
    warnings: [],
  };
}

function member(name: string, modelPrimary: string, isDefaultPreset = true) {
  return { name, modelPrimary, hasPrompt: false, otherFields: {}, warnings: [], isDefaultPreset };
}

function preset(name: string, isDefault: boolean, members: ReturnType<typeof member>[]) {
  return {
    name,
    sourceScopes: ["user" as const],
    isDefault,
    memberCount: members.length,
    uniqueModels: members.length,
    providers: [],
    members,
    raw: {},
    empty: members.length === 0,
  };
}

function acp(agents: AcpInventory["agents"]): AcpInventory {
  return { agents, note: "" };
}

function wrapper(
  name: string,
  wrapperModel: string | undefined,
  disabled = false,
): AcpInventory["agents"][number] {
  return {
    name,
    sourceScopes: [],
    config: {},
    envMasked: {},
    secretKeyCount: 0,
    wrapperModel,
    permission: "deny",
    disabled,
    warnings: [],
  };
}

describe("buildModelUsage", () => {
  test("agent primary → agent-primary active=fallback:false; fallbacks → agent-fallback fallback:true", () => {
    const usage = buildModelUsage({
      agents: {
        fixer: agent({
          name: "fixer",
          modelPrimary: "openai/gpt-x",
          modelFallbacks: ["ollama/qwen:coder", "ollama/qwen2"],
        }),
      },
    });
    const prim = usage.get("openai\0gpt-x");
    expect(prim).toHaveLength(1);
    expect(prim?.[0]).toMatchObject({
      kind: "agent-primary",
      ownerId: "fixer",
      active: true,
      fallback: false,
    });
    expect(usage.get("ollama\0qwen:coder")?.[0]).toMatchObject({
      kind: "agent-fallback",
      ownerId: "fixer",
      active: true,
      fallback: true,
    });
    expect(usage.get("ollama\0qwen2")?.[0]?.kind).toBe("agent-fallback");
  });

  test("disabled agent → refs recorded with active:false", () => {
    const usage = buildModelUsage({
      agents: {
        dead: agent({ name: "dead", enabled: false, modelPrimary: "openai/gpt-y", modelFallbacks: ["a/b"] }),
      },
    });
    expect(usage.get("openai\0gpt-y")?.[0]?.active).toBe(false);
    expect(usage.get("a\0b")?.[0]?.active).toBe(false);
  });

  test("council members: active ONLY for the default/effective preset", () => {
    const usage = buildModelUsage({
      agents: {},
      council: council([
        preset("quality", true, [member("a", "anthropic/claude-x"), member("b", "openai/gpt-x")]),
        preset("cheap", false, [member("a", "ollama/qwen")]),
      ]),
    });
    expect(usage.get("anthropic\0claude-x")?.[0]).toMatchObject({
      kind: "council-member",
      ownerId: "council.quality.a",
      active: true,
    });
    expect(usage.get("ollama\0qwen")?.[0]).toMatchObject({
      kind: "council-member",
      ownerId: "council.cheap.a",
      active: false,
    });
  });

  test("acp wrappers: active = !disabled; missing wrapperModel → no ref", () => {
    const usage = buildModelUsage({
      agents: {},
      acp: acp([
        wrapper("ext1", "openai/gpt-x"),
        wrapper("ext2", "a/b", true),
        wrapper("ext3", undefined),
      ]),
    });
    expect(usage.get("openai\0gpt-x")?.[0]).toMatchObject({
      kind: "acp-wrapper",
      ownerId: "acp.ext1",
      active: true,
    });
    expect(usage.get("a\0b")?.[0]?.active).toBe(false);
    expect([...usage.keys()].some((k) => k.includes("ext3"))).toBe(false);
    expect(usage.size).toBe(2);
  });

  test("model refs without '/' are skipped", () => {
    const usage = buildModelUsage({
      agents: { a: agent({ name: "a", modelPrimary: "providerless", modelFallbacks: [""] }) },
      council: council([preset("d", true, [member("m", "noSlashHere")])]),
      acp: acp([wrapper("w", "nope")]),
    });
    expect(usage.size).toBe(0);
  });

  test("model ids containing slashes keep the remainder as modelId", () => {
    const usage = buildModelUsage({
      agents: { a: agent({ name: "a", modelPrimary: "acp/nested/path-model" }) },
    });
    expect(usage.get("acp\0nested/path-model")?.[0]?.kind).toBe("agent-primary");
  });
});

describe("computeEffectiveProbeSet", () => {
  const usage = buildModelUsage({
    agents: {
      fixer: agent({ name: "fixer", modelPrimary: "openai/gpt-x", modelFallbacks: ["ollama/qwen"] }),
      dead: agent({ name: "dead", enabled: false, modelPrimary: "openai/gpt-y" }),
    },
    council: council([
      preset("quality", true, [member("a", "anthropic/claude-x")]),
      preset("cheap", false, [member("a", "google/gemini")]),
    ]),
    acp: acp([wrapper("ext", "acp-prov/m1"), wrapper("off", "acp-prov/off", true)]),
  });

  test("enabled agents' primary+fallbacks + default preset + active wrappers; inactive preset EXCLUDED", () => {
    const set = computeEffectiveProbeSet(usage, {
      enabledAgents: ["fixer"],
      defaultCouncilPreset: "quality",
      activeAcpWrappers: ["ext"],
    });
    const keys = set.map((m) => `${m.providerId}/${m.modelId}`).sort();
    expect(keys).toEqual([
      "acp-prov/m1",
      "anthropic/claude-x",
      "ollama/qwen",
      "openai/gpt-x",
    ]);
    expect(keys).not.toContain("google/gemini"); // inactive preset
    expect(keys).not.toContain("openai/gpt-y"); // disabled agent
    expect(keys).not.toContain("acp-prov/off"); // disabled wrapper
  });

  test("deterministic order + dedupe (same model referenced by two owners → once)", () => {
    const shared = buildModelUsage({
      agents: {
        a: agent({ name: "a", modelPrimary: "p/dup" }),
        b: agent({ name: "b", modelPrimary: "p/dup", modelFallbacks: ["p/z"] }),
      },
    });
    const set = computeEffectiveProbeSet(shared, {
      enabledAgents: ["a", "b"],
      defaultCouncilPreset: undefined,
      activeAcpWrappers: [],
    });
    expect(set).toEqual([
      { providerId: "p", modelId: "dup" },
      { providerId: "p", modelId: "z" },
    ]);
  });
});
