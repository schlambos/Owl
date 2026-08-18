/**
 * Team topology follow-up (doc 34) — pure derivation + state layer tests.
 *
 * Covers eligibility, the hard-scoped Effective model universe, provider
 * derivation, per-route filters/sorts, focus matching, and the URL +
 * sessionStorage contract (precedence, migration, cleanup, commit/clear).
 * No React; the rendered views are covered by team-topology-views.test.tsx.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { AgentsDto, DesiredAgent } from "@omo/shared";
import {
  applyTeamAgentsView,
  applyTeamModelsView,
  applyTeamProvidersView,
  buildScopedTeamModels,
  buildTeamAgents,
  buildTeamProviderGroups,
  buildTeamTopology,
  findScopedTeamModel,
  findTeamProviderGroup,
  isTeamAgentFocusTarget,
  matchesTeamAgentFilter,
  parseTeamModelKey,
  sortTeamAgents,
  sortTeamModels,
  sortTeamProviders,
  teamModelFocusValue,
} from "../src/pages/team/topology";
import {
  clearTeamFocus,
  commitTeamControls,
  hydrateTeamView,
  loadTeamControls,
  saveTeamControls,
  TEAM_STORAGE_KEYS,
} from "../src/pages/team/session-state";
import {
  makeAgentsDto,
  makeModelAvailability,
  makeModelInventoryDto,
  makeProvider,
  makeProviderDiagnostics,
  makeProvidersDto,
  makeRow,
  makeUsageRef,
  probeSummary,
} from "./helpers";

function desiredAgent(model: string | undefined): DesiredAgent {
  return { name: "x", kind: "builtin", model, sourceIds: ["fixture"] };
}

function dtoWith(
  rows: AgentsDto["rows"],
  opts?: {
    presetAgents?: Record<string, DesiredAgent>;
    rootAgents?: Record<string, DesiredAgent>;
  },
): AgentsDto {
  const dto = makeAgentsDto(rows, "openai");
  dto.desired.presets = opts?.presetAgents ? { openai: opts.presetAgents } : {};
  dto.desired.agents = opts?.rootAgents ?? {};
  return dto;
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("team topology — eligibility (doc 34 §Agents)", () => {
  test("excludes native, ACP wrappers, councillor, and gating council; includes council with Effective assignment", () => {
    const dto = dtoWith(
      [
        makeRow({ name: "explorer", kind: "builtin", effectiveModel: "openai/gpt-5" }),
        makeRow({ name: "scribe", kind: "custom", effectiveModel: "openai/gpt-5" }),
        makeRow({ name: "build", kind: "native", liveModel: "openai/gpt-5" }),
        makeRow({ name: "wrapper", kind: "custom", effectiveModel: "openai/gpt-5" }),
        makeRow({ name: "councillor", kind: "builtin", liveModel: "openai/gpt-5" }),
        makeRow({ name: "council", kind: "builtin", liveModel: "openai/gpt-5" }),
        makeRow({ name: "council-set", kind: "builtin", effectiveModel: "xai/grok-4.5" }),
        makeRow({ name: "observer", kind: "builtin", enabled: false }),
      ],
      { presetAgents: { explorer: desiredAgent("openai/gpt-5") } },
    );
    const set = buildTeamAgents({
      agentsDto: dto,
      acpAgentNames: ["wrapper"],
    });

    const activeNames = [...set.activeNames];
    expect(activeNames).toContain("explorer");
    expect(activeNames).toContain("scribe");
    expect(activeNames).toContain("council-set");
    for (const gone of ["build", "wrapper", "councillor", "council", "observer"]) {
      expect(activeNames).not.toContain(gone);
    }
    // Disabled eligible agents are gated separately, not dropped.
    expect(set.disabled.map((p) => p.name)).toEqual(["observer"]);
  });

  test("eligible agent without Effective assignment stays rostered but out of activeNames scope", () => {
    const dto = dtoWith([
      makeRow({ name: "explorer", kind: "builtin", effectiveModel: "openai/gpt-5" }),
      // Unconfigured custom agent: rostered, but contributes no model scope.
      makeRow({ name: "ghost", kind: "custom" }),
    ]);
    const set = buildTeamAgents({ agentsDto: dto });
    expect(set.active.map((p) => p.name)).toContain("ghost");
    expect(set.activeNames.has("ghost")).toBe(true); // roster target
    // …but with no Effective model it never enters the scoped model set.
    const models = buildScopedTeamModels({ inventory: makeModelInventoryDto(), agents: set });
    expect(models).toHaveLength(0);
  });
});

describe("team topology — header counts stay active-scoped", () => {
  test("Show disabled never changes TeamHeader counts", () => {
    const dto = dtoWith(
      [
        makeRow({ name: "explorer", kind: "builtin", effectiveModel: "openai/gpt-5" }),
        makeRow({ name: "observer", kind: "builtin", enabled: false }),
      ],
      { presetAgents: { explorer: desiredAgent("openai/gpt-5") } },
    );
    const topology = buildTeamTopology({
      agentsDto: dto,
      inventory: makeModelInventoryDto({
        models: [
          makeModelAvailability({
            providerId: "openai",
            modelId: "gpt-5",
            usage: [makeUsageRef({ ownerId: "explorer" })],
          }),
        ],
        providers: [makeProviderDiagnostics({ providerId: "openai" })],
      }),
      providersDto: makeProvidersDto([
        makeProvider("openai", "OpenAI", true, []),
      ]),
    });
    expect(topology.header).toEqual({ agents: 1, models: 1, providers: 1 });

    const off = applyTeamAgentsView(topology.agents, {
      showDisabled: false,
      filter: "all",
      q: "",
      sort: null,
    });
    const on = applyTeamAgentsView(topology.agents, {
      showDisabled: true,
      filter: "all",
      q: "",
      sort: null,
    });
    expect(off.rows.map((r) => r.name)).toEqual(["explorer"]);
    expect(on.rows.map((r) => r.name)).toEqual(["explorer", "observer"]);
    expect(on.disabledShown).toBe(1);
    expect(off.disabledShown).toBe(0);
    // Header is untouched by the gate either way.
    expect(topology.header.agents).toBe(1);
  });
});

describe("team topology — hard-scoped models (doc 34 §Models)", () => {
  const dto = dtoWith(
    [
      makeRow({ name: "explorer", kind: "builtin", effectiveModel: "openai/gpt-5" }),
      makeRow({ name: "fixer", kind: "builtin", effectiveModel: "ollama/llama", liveModel: "other/drift" }),
      makeRow({ name: "sleeper", kind: "builtin", enabled: false, effectiveModel: "openai/gpt-5" }),
    ],
    { presetAgents: { explorer: desiredAgent("openai/gpt-5") } },
  );

  function scoped() {
    const agents = buildTeamAgents({ agentsDto: dto });
    const inventory = makeModelInventoryDto({
      models: [
        // In scope: active primary of an eligible agent.
        makeModelAvailability({
          providerId: "openai",
          modelId: "gpt-5",
          usage: [
            makeUsageRef({ ownerId: "explorer" }),
            // Disabled agent's ref is dropped.
            makeUsageRef({ ownerId: "sleeper" }),
          ],
        }),
        // In scope: active fallback of an eligible (drifted) agent.
        makeModelAvailability({
          providerId: "ollama",
          modelId: "llama",
          usage: [
            makeUsageRef({ kind: "agent-fallback", ownerId: "fixer", fallback: true }),
          ],
        }),
        // In scope via Council dependency only.
        makeModelAvailability({
          providerId: "xai",
          modelId: "grok",
          usage: [makeUsageRef({ kind: "council-member", ownerId: "trio" })],
        }),
        // Excluded: advertised-only.
        makeModelAvailability({ providerId: "google", modelId: "gemini" }),
        // Excluded: inactive council ref.
        makeModelAvailability({
          providerId: "anthropic",
          modelId: "opus",
          usage: [
            makeUsageRef({ kind: "council-member", ownerId: "duo", active: false }),
          ],
        }),
      ],
    });
    return buildScopedTeamModels({ inventory, agents });
  }

  test("scope admits active primary/fallback/Council refs only", () => {
    const models = scoped();
    expect(models.map((m) => m.key).sort()).toEqual([
      "ollama/llama",
      "openai/gpt-5",
      "xai/grok",
    ]);
    const gpt = models.find((m) => m.key === "openai/gpt-5")!;
    expect(gpt.agentPrimary.map((r) => r.ownerId)).toEqual(["explorer"]);
    // Disabled agent ref dropped from both lists and owner counts.
    expect(gpt.counts.owners).toBe(1);
  });

  test("drift is an annotation on the Effective ref, never a group key", () => {
    const models = scoped();
    const llama = models.find((m) => m.key === "ollama/llama")!;
    expect(llama.agentFallback[0]!.liveDrift).toBe(true);
    expect(llama.driftOwners.map((d) => d.ownerId)).toEqual(["fixer"]);
    expect(llama.hasAgentFallback).toBe(true);
    expect(llama.hasPrimary).toBe(false);
  });

  test("filters and sorts apply within the scoped set", () => {
    const agents = buildTeamAgents({ agentsDto: dto });
    const models = scoped();
    const view = applyTeamModelsView(models, {
      filter: "fallback",
      q: "",
      sort: { id: "fallback", dir: "desc" },
    });
    expect(view.rows.map((m) => m.key)).toEqual(["ollama/llama"]);
    expect(view.filterCounts.fallback).toBe(1);
    expect(view.filterCounts.primary).toBe(2); // gpt-5 (agent) + grok (council)

    const sorted = sortTeamModels(models, { id: "provider", dir: "asc" });
    expect(sorted.map((m) => m.providerId)).toEqual(["ollama", "openai", "xai"]);
  });
});

describe("team topology — providers derive only from scoped models", () => {
  function world() {
    const dto = dtoWith(
      [
        makeRow({ name: "explorer", kind: "builtin", effectiveModel: "openai/gpt-5" }),
        makeRow({ name: "critic", kind: "custom", effectiveModel: "local/fine-1" }),
      ],
      { presetAgents: { explorer: desiredAgent("openai/gpt-5") } },
    );
    const agents = buildTeamAgents({ agentsDto: dto });
    const inventory = makeModelInventoryDto({
      models: [
        makeModelAvailability({
          providerId: "openai",
          modelId: "gpt-5",
          usage: [
            makeUsageRef({ ownerId: "explorer" }),
            makeUsageRef({ kind: "agent-fallback", ownerId: "explorer", fallback: true }),
            makeUsageRef({ kind: "council-member", ownerId: "trio" }),
          ],
        }),
        makeModelAvailability({
          providerId: "local",
          modelId: "fine-1",
          advertised: false,
          probe: probeSummary({ state: "timeout", freshness: "fresh" }),
          usage: [makeUsageRef({ ownerId: "critic" })],
        }),
        // Advertised-only model of a provider that must NOT appear.
        makeModelAvailability({ providerId: "google", modelId: "gemini" }),
      ],
      providers: [
        makeProviderDiagnostics({ providerId: "openai", known: true }),
        makeProviderDiagnostics({ providerId: "local", known: false }),
        makeProviderDiagnostics({ providerId: "google" }),
      ],
    });
    const models = buildScopedTeamModels({ inventory, agents });
    const providers = buildTeamProviderGroups({
      models,
      inventory,
      providersDto: makeProvidersDto([
        makeProvider("openai", "OpenAI", true, []),
        // local has no LiveProvider record at all.
      ]),
    });
    return { models, providers };
  }

  test("provider without scoped model never appears; source is LiveProvider-only", () => {
    const { providers } = world();
    expect(providers.map((g) => g.providerId).sort()).toEqual(["local", "openai"]);
    const openai = providers.find((g) => g.providerId === "openai")!;
    expect(openai.sourceLabel).toBe("Not reported"); // LiveProvider.source absent
    expect(openai.connectedPerLive).toBe(true);
    const local = providers.find((g) => g.providerId === "local")!;
    expect(local.sourceLabel).toBe("Not reported");
    // No LiveProvider record: the `connected` filter authority is false even
    // though diagnostics report connected (display-only fallback).
    expect(local.connectedPerLive).toBe(false);
    expect(local.connected).toBe(true);
  });

  test("one agent using primary+fallback counts once (shared dedupe)", () => {
    const { providers } = world();
    const openai = providers.find((g) => g.providerId === "openai")!;
    // explorer (primary+fallback deduped) + council trio = 2 owners → shared.
    expect(openai.shared).toBe(true);
    expect(openai.agentCount).toBe(1);
    expect(openai.agents[0]!.roles.sort()).toEqual(["fallback", "primary"]);
    expect(openai.council.map((c) => c.ownerId)).toEqual(["trio"]);
  });

  test("custom-configured is evidence-based (custom agent, known=false, unadvertised)", () => {
    const { providers } = world();
    const local = providers.find((g) => g.providerId === "local")!;
    expect(local.customConfigured).toBe(true);
    expect(local.customConfiguredEvidence).toContain("Custom agent: critic");
    expect(local.customConfiguredEvidence).toContain(
      "Provider not recognized by OpenCode",
    );
    expect(local.customConfiguredEvidence).toContain("Unadvertised model: local/fine-1");
    expect(local.hasIssues).toBe(true);
    const openai = providers.find((g) => g.providerId === "openai")!;
    expect(openai.customConfigured).toBe(false);
  });

  test("provider filters and sorts (connection missing-last both directions)", () => {
    const { providers } = world();
    const connected = applyTeamProvidersView(providers, {
      filter: "connected",
      q: "",
      sort: { id: "name", dir: "asc" },
    });
    expect(connected.rows.map((g) => g.providerId)).toEqual(["openai"]);

    const asc = sortTeamProviders(providers, { id: "source", dir: "asc" });
    const desc = sortTeamProviders(providers, { id: "source", dir: "desc" });
    // Both sources missing → tie; order stable, no missing-first flip.
    expect(asc.map((g) => g.providerId).sort()).toEqual(
      desc.map((g) => g.providerId).sort(),
    );
    const issues = sortTeamProviders(providers, { id: "issues", dir: "asc" });
    expect(issues[0]!.providerId).toBe("local"); // worst first on asc
  });
});

describe("team topology — agents filters/sorts/focus", () => {
  const dto = dtoWith(
    [
      makeRow({ name: "explorer", kind: "builtin", effectiveModel: "openai/gpt-5", liveModel: "other/x" }),
      makeRow({ name: "critic", kind: "custom", effectiveModel: "xai/grok" }),
      makeRow({ name: "orchestrator", kind: "builtin", effectiveModel: "openai/gpt-5" }),
    ],
    {
      presetAgents: {
        explorer: desiredAgent("openai/gpt-4"), // Assigned ≠ Effective
        orchestrator: desiredAgent("openai/gpt-5"),
      },
      rootAgents: { critic: desiredAgent("xai/grok") },
    },
  );
  const set = buildTeamAgents({ agentsDto: dto });

  test("overrides requires non-null Assigned ≠ Effective", () => {
    const byName = new Map(set.active.map((p) => [p.name, p]));
    expect(matchesTeamAgentFilter(byName.get("explorer")!, "overrides")).toBe(true);
    expect(matchesTeamAgentFilter(byName.get("critic")!, "overrides")).toBe(false);
    expect(matchesTeamAgentFilter(byName.get("explorer")!, "runtime-drift")).toBe(true);
    expect(matchesTeamAgentFilter(byName.get("orchestrator")!, "runtime-drift")).toBe(false);
  });

  test("kind sort orders builtin < custom; team order ties stable", () => {
    const sorted = sortTeamAgents(set.active, { id: "kind", dir: "asc" });
    expect(sorted.map((p) => p.name)).toEqual(["orchestrator", "explorer", "critic"]);
    const desc = sortTeamAgents(set.active, { id: "kind", dir: "desc" });
    expect(desc[0]!.name).toBe("critic");
  });

  test("default sort is team order and omitted (null)", () => {
    const def = sortTeamAgents(set.active, null);
    expect(def.map((p) => p.name)).toEqual(["orchestrator", "explorer", "critic"]);
  });

  test("focus helpers: canonical key parse + scoped match + eligible targets", () => {
    expect(parseTeamModelKey("openai/gpt-5")).toEqual({
      providerId: "openai",
      modelId: "gpt-5",
    });
    expect(parseTeamModelKey("ollama-cloud/deepseek/v2")).toEqual({
      providerId: "ollama-cloud",
      modelId: "deepseek/v2",
    });
    expect(parseTeamModelKey("noslash")).toBeUndefined();
    expect(
      teamModelFocusValue({ providerId: "openai", modelId: "gpt-5" }),
    ).toBe("openai/gpt-5");

    const models = [
      { key: "openai/gpt-5" },
    ] as unknown as Parameters<typeof findScopedTeamModel>[0];
    expect(findScopedTeamModel(models, "openai/gpt-5")?.key).toBe("openai/gpt-5");
    expect(findScopedTeamModel(models, "openai/gpt-4")).toBeUndefined();

    expect(isTeamAgentFocusTarget(set, "explorer")).toBe(true);
    expect(isTeamAgentFocusTarget(set, "ghost")).toBe(false);
    expect(isTeamAgentFocusTarget(set, "")).toBe(false);

    const groups = buildTeamProviderGroups({ models: [], inventory: null });
    expect(findTeamProviderGroup(groups, "openai")).toBeUndefined();
  });
});

describe("team session-state — URL/storage contract (doc 34 §Persistence)", () => {
  test("URL wins over storage; storage fills gaps without focus", () => {
    saveTeamControls("agents", {
      filter: "custom",
      q: "stored",
      sort: { id: "name", dir: "desc" },
      showDisabled: true,
    });
    const h = hydrateTeamView("agents", "?filter=overrides");
    expect(h.controls.filter).toBe("overrides"); // URL wins
    expect(h.controls.q).toBe("stored"); // storage fills
    expect(h.controls.sort).toEqual({ id: "name", dir: "desc" });
    expect(h.controls.showDisabled).toBe(true);
    expect(h.hasFocus).toBe(false);
  });

  test("valid focus uses transient defaults and never overwrites storage", () => {
    saveTeamControls("models", {
      filter: "issues",
      q: "",
      sort: { id: "probe", dir: "asc" },
      showDisabled: false,
    });
    const h = hydrateTeamView("models", "?model=openai/gpt-5");
    expect(h.hasFocus).toBe(true);
    expect(h.focus.model).toBe("openai/gpt-5");
    expect(h.controls.filter).toBe("all"); // default, not stored
    expect(h.controls.sort).toEqual({ id: "model", dir: "asc" });
    // Storage untouched.
    expect(loadTeamControls("models")?.filter).toBe("issues");
  });

  test("migration: filter=disabled → disabled=1; native=1 removed (replace set)", () => {
    const h = hydrateTeamView("agents", "?filter=disabled&native=1&foo=bar");
    expect(h.cleanedParams).not.toBeNull();
    expect(h.cleanedParams!.get("disabled")).toBe("1");
    expect(h.cleanedParams!.has("filter")).toBe(false);
    expect(h.cleanedParams!.has("native")).toBe(false);
    expect(h.cleanedParams!.get("foo")).toBe("bar"); // unknown preserved
    expect(h.controls.showDisabled).toBe(true);
  });

  test("invalid known values cleaned; unknown params preserved", () => {
    const h = hydrateTeamView("providers", "?filter=bogus&sort=nope:asc&q=%20&keep=1");
    expect(h.cleanedParams).not.toBeNull();
    expect(h.cleanedParams!.has("filter")).toBe(false);
    expect(h.cleanedParams!.has("sort")).toBe(false);
    expect(h.cleanedParams!.has("q")).toBe(false);
    expect(h.cleanedParams!.get("keep")).toBe("1");
  });

  test("invalid agent focus removed once validation is available", () => {
    const pending = hydrateTeamView("agents", "?agent=ghost");
    expect(pending.focus.agent).toBe("ghost"); // kept while loading
    const ready = hydrateTeamView("agents", "?agent=ghost", {
      isAgentFocusValid: (n) => n === "explorer",
    });
    expect(ready.focus.agent).toBeUndefined();
    expect(ready.cleanedParams!.has("agent")).toBe(false);
  });

  test("commit clears focus, persists deliberate state, omits defaults", () => {
    const { params, controls } = commitTeamControls(
      "agents",
      "?model=openai/gpt-5&agent=explorer&foo=bar",
      { filter: "all", q: "", sort: null, showDisabled: false },
      { filter: "custom", showDisabled: true },
    );
    expect(params.has("model")).toBe(false);
    expect(params.has("agent")).toBe(false);
    expect(params.has("provider")).toBe(false);
    expect(params.get("filter")).toBe("custom");
    expect(params.get("disabled")).toBe("1");
    expect(params.get("foo")).toBe("bar");
    expect(controls.filter).toBe("custom");
    expect(controls.showDisabled).toBe(true);

    const stored = loadTeamControls("agents")!;
    expect(stored.filter).toBe("custom");
    expect(stored.showDisabled).toBe(true);
    expect(stored.q).toBe("");
  });

  test("all-default commit removes the storage key entirely", () => {
    commitTeamControls("providers", "", {
      filter: "issues",
      q: "x",
      sort: { id: "name", dir: "desc" },
      showDisabled: false,
    }, { filter: "all", q: "", sort: { id: "name", dir: "asc" } });
    expect(window.sessionStorage.getItem(TEAM_STORAGE_KEYS.providers)).toBeNull();
  });

  test("clear focus removes focus params via provided params, preserves the rest", () => {
    const p = clearTeamFocus("?model=a/b&provider=a&agent=x&filter=custom&keep=2");
    expect(p.has("model")).toBe(false);
    expect(p.has("provider")).toBe(false);
    expect(p.has("agent")).toBe(false);
    expect(p.get("filter")).toBe("custom");
    expect(p.get("keep")).toBe("2");
  });
});
