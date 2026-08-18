/**
 * Model inventory composition unit tests (Slice 15, Lane 5a).
 * Includes the SOURCE-AUTHORITY FREEZE case: invented metadata fields must
 * never surface on the composed DTO.
 */

import { describe, expect, test } from "bun:test";
import type {
  LiveModel,
  LiveProvider,
  ModelProbeQueueItem,
  ModelProbeQueueSnapshot,
  ModelProbeRun,
  ModelUsageReference,
} from "@omo/shared";
import {
  buildModelAvailability,
  buildModelInventory,
  buildModelInventoryDetail,
  isModelKnown,
  unionModels,
  type ModelInventorySources,
} from "./inventory";
import type { ProbeProviderStats } from "./probe-store";

function provider(
  id: string,
  models: Array<Partial<LiveModel> & { id: string }>,
  connected = true,
): LiveProvider {
  return {
    id,
    name: `Name-${id}`,
    connected,
    modelCount: models.length,
    models: models.map((m) => ({ providerID: id, ...m })) as LiveModel[],
  };
}

function ref(over: Partial<ModelUsageReference>): ModelUsageReference {
  return {
    kind: "agent-primary",
    ownerId: "fixer",
    label: "fixer",
    active: true,
    fallback: false,
    ...over,
  };
}

function run(over: Partial<ModelProbeRun> & Pick<ModelProbeRun, "providerId" | "modelId">): ModelProbeRun {
  return {
    id: "r1",
    startedAt: "2026-08-12T00:00:00.000Z",
    state: "healthy",
    completedAt: "2026-08-12T00:00:05.000Z",
    advertisedAtProbe: true,
    providerConnectedAtProbe: true,
    ...over,
  };
}

const emptyQueue: ModelProbeQueueSnapshot = { concurrency: 2, pending: [], running: [] };

function src(over: Partial<ModelInventorySources> = {}): ModelInventorySources {
  return {
    providers: [],
    connected: [],
    authMethods: {},
    usage: new Map(),
    probeLatest: new Map(),
    queue: emptyQueue,
    providerProbeStats: new Map(),
    nowMs: Date.parse("2026-08-12T12:00:00.000Z"),
    ...over,
  };
}

describe("model union", () => {
  test("advertised + referenced + history-only, sorted", () => {
    const s = src({
      providers: [provider("openai", [{ id: "gpt-x" }])],
      usage: new Map([["anthropic\0claude-x", [ref({})]]]),
      probeLatest: new Map([["local\0hist", run({ providerId: "local", modelId: "hist" })]]),
    });
    expect(unionModels(s)).toEqual([
      { providerId: "anthropic", modelId: "claude-x" },
      { providerId: "local", modelId: "hist" },
      { providerId: "openai", modelId: "gpt-x" },
    ]);
    expect(isModelKnown(s, "local", "hist")).toBe(true);
    expect(isModelKnown(s, "nope", "nada")).toBe(false);
  });
});

describe("availability composition", () => {
  test("advertised + referenced → configured true; provider known/connected", () => {
    const s = src({
      providers: [provider("openai", [{ id: "gpt-x", status: "preferred", limit: { context: 128000, output: 4096 } }])],
      connected: ["openai"],
      usage: new Map([["openai\0gpt-x", [ref({})]]]),
    });
    const a = buildModelAvailability(s, "openai", "gpt-x");
    expect(a.configured).toBe(true);
    expect(a.advertised).toBe(true);
    expect(a.provider).toEqual({ known: true, connected: true });
    expect(a.limit).toEqual({ context: 128000, output: 4096 });
    expect(a.status).toBe("preferred");
    expect(a.probe.state).toBe("never");
    expect(a.probe.freshness).toBe("never");
  });

  test("history-only model: configured false, advertised false, provider unknown", () => {
    const s = src({
      probeLatest: new Map([["gone\0m", run({ providerId: "gone", modelId: "m", state: "error" })]]),
    });
    const a = buildModelAvailability(s, "gone", "m");
    expect(a.configured).toBe(false);
    expect(a.advertised).toBe(false);
    expect(a.provider).toEqual({ known: false, connected: false });
    expect(a.probe.state).toBe("error");
  });

  test("probe summary from latest run; freshness stale beyond 24h", () => {
    const s = src({
      probeLatest: new Map([
        ["p\0m", run({
          providerId: "p", modelId: "m", state: "unauthorized",
          statusCode: 401, errorCode: "http-401", errorMessage: "sanitized",
          latencyMs: 321, responseModel: "m2",
          startedAt: "2026-08-01T00:00:00.000Z", completedAt: "2026-08-01T00:00:01.000Z",
        })],
      ]),
      usage: new Map([["p\0m", [ref({})]]]),
    });
    const a = buildModelAvailability(s, "p", "m");
    expect(a.probe).toMatchObject({
      state: "unauthorized",
      freshness: "stale",
      lastCompletedAt: "2026-08-01T00:00:01.000Z",
      latencyMs: 321,
      statusCode: 401,
      errorCode: "http-401",
      errorMessage: "sanitized",
      responseModel: "m2",
    });
    expect(a.lastUpdatedAt).toBe("2026-08-01T00:00:01.000Z");
  });

  test("queue overlay: pending/running item → probe.state 'running' (freshness from latest run)", () => {
    const item: ModelProbeQueueItem = {
      id: "q1", providerId: "p", modelId: "m", state: "running",
      enqueuedAt: "2026-08-12T11:59:00.000Z", startedAt: "2026-08-12T11:59:30.000Z",
    };
    const s = src({
      queue: { ...emptyQueue, running: [item] },
      usage: new Map([["p\0m", [ref({})]]]),
      probeLatest: new Map([["p\0m", run({ providerId: "p", modelId: "m", state: "healthy", completedAt: "2026-08-12T11:00:00.000Z" })]]),
    });
    const a = buildModelAvailability(s, "p", "m");
    expect(a.probe.state).toBe("running");
    expect(a.probe.freshness).toBe("fresh"); // still measures latest completed run
    const sPend = src({ ...s, queue: { ...emptyQueue, pending: [item] } });
    expect(buildModelAvailability(sPend, "p", "m").probe.state).toBe("running");
    const sNone = src({ ...s, queue: emptyQueue });
    expect(buildModelAvailability(sNone, "p", "m").probe.state).toBe("healthy");
  });
});

describe("capabilities deterministic rule + SOURCE-AUTHORITY FREEZE", () => {
  test("known ← advertised w/ capabilities; tools←toolcall, vision←input.image, reasoning←reasoning", () => {
    const s = src({
      providers: [provider("p", [{
        id: "m",
        metadataSource: "opencode:/config/providers",
        capabilities: { toolcall: true, reasoning: false, input: { image: true, text: true } },
      }])],
    });
    const a = buildModelAvailability(s, "p", "m");
    expect(a.capabilities).toEqual({
      state: "known",
      tools: true,
      vision: true,
      reasoning: false,
      source: "opencode:/config/providers",
    });
    // structuredOutput / toolIds are ALWAYS undefined — never composed.
    expect(a.capabilities.structuredOutput).toBeUndefined();
    expect(a.capabilities.toolIds).toBeUndefined();
  });

  test("invented raw fields (performanceClass/codingScore/reasoningTier) never surface", () => {
    const s = src({
      providers: [provider("p", [{
        id: "m",
        metadataSource: "opencode:/config/providers",
        capabilities: {
          toolcall: false,
          input: { image: false },
          // invented junk smuggled into the whitelisted container shape
          performanceClass: "S-tier",
          codingScore: 99,
          reasoningTier: "deep",
        } as unknown as LiveModel["capabilities"],
        performanceClass: "S-tier",
        codingScore: 99,
        reasoningTier: "deep",
        vendorQualityNotes: "trustme",
      } as unknown as Partial<LiveModel> & { id: string }])],
    });
    const a = buildModelAvailability(s, "p", "m");
    const flat = JSON.stringify(a);
    expect(flat).not.toContain("performanceClass");
    expect(flat).not.toContain("codingScore");
    expect(flat).not.toContain("reasoningTier");
    expect(flat).not.toContain("vendorQualityNotes");
    expect(flat).not.toContain("S-tier");
    expect(flat).not.toContain("trustme");
    expect(a.capabilities.state).toBe("known");
    expect(a.capabilities.tools).toBe(false);
    expect(a.capabilities.vision).toBe(false);
    expect(a.capabilities.reasoning).toBeUndefined();
  });

  test("partial ← advertised without capabilities; unknown ← unadvertised", () => {
    const s = src({
      providers: [provider("p", [{ id: "m" }], true)],
    });
    expect(buildModelAvailability(s, "p", "m").capabilities.state).toBe("partial");
    expect(buildModelAvailability(s, "p", "m").capabilities.source).toBeDefined();
    const ghost = buildModelAvailability(s, "p", "ghost");
    expect(ghost.capabilities).toEqual({ state: "unknown", source: "none" });
  });
});

describe("inventory + provider diagnostics", () => {
  test("counts: advertisedCount, referencedCount, authMethods, probe stats; union includes referenced-only providers", () => {
    const stats: ProbeProviderStats = {
      recentFailureCounts: { unauthorized: 2 },
      recentRateLimitCount: 1,
      lastSuccessfulProbeAt: "2026-08-11T00:00:00.000Z",
    };
    const s = src({
      providers: [provider("openai", [{ id: "gpt-x" }, { id: "gpt-y" }]), provider("ollama", [])],
      connected: ["openai"],
      authMethods: { openai: [{ type: "api", label: "API key" }] },
      usage: new Map([
        ["openai\0gpt-x", [ref({})]],
        ["openai\0ext", [ref({ kind: "agent-fallback", fallback: true })]],
        ["acp-prov\0m1", [ref({ kind: "acp-wrapper", ownerId: "acp.ext" })]],
      ]),
      providerProbeStats: new Map([["openai", stats]]),
    });
    const inv = buildModelInventory(s);
    expect(inv.generatedAt).toBe("2026-08-12T12:00:00.000Z");
    expect(inv.queue).toBe(emptyQueue);

    const openai = inv.providers.find((p) => p.providerId === "openai");
    expect(openai).toMatchObject({
      name: "Name-openai",
      known: true,
      connected: true,
      advertisedCount: 2,
      referencedCount: 2,
      authMethods: [{ type: "api", label: "API key" }],
      lastSuccessfulProbeAt: "2026-08-11T00:00:00.000Z",
      recentFailureCounts: { unauthorized: 2 },
      recentRateLimitCount: 1,
    });
    const ollama = inv.providers.find((p) => p.providerId === "ollama");
    expect(ollama?.connected).toBe(false);
    expect(ollama?.recentRateLimitCount).toBe(0);
    // Referenced-only provider surfaces with known:false.
    const acpProv = inv.providers.find((p) => p.providerId === "acp-prov");
    expect(acpProv).toMatchObject({ known: false, connected: false, advertisedCount: 0, referencedCount: 1, authMethods: [] });
  });

  test("detail: unknown model → undefined; known → availability + history", () => {
    const s = src({
      providers: [provider("p", [{ id: "m" }])],
      usage: new Map([["p\0m", [ref({})]]]),
    });
    expect(buildModelInventoryDetail(s, "p", "ghost", [])).toBeUndefined();
    const d = buildModelInventoryDetail(s, "p", "m", [run({ providerId: "p", modelId: "m" })]);
    expect(d?.availability.providerId).toBe("p");
    expect(d?.history).toHaveLength(1);
  });
});
