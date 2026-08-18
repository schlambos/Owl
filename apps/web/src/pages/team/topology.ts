/**
 * Team topology views — pure derivation layer (doc 34).
 *
 * `docs/architecture/34-team-topology-views-follow-up.md` is the contract.
 * This module owns the data half of the three Team routes (`/agents`,
 * `/models`, `/providers`): eligibility, hard-scoped Effective model groups,
 * provider derivation, deterministic filters/search/sorts, header counts and
 * focus matching. It is UI-free and side-effect-free; the route pages (added
 * in the single @designer integration session) render from these shapes.
 *
 * Layer authority (doc 34 "Layer authority"):
 *  - Effective is the ONLY grouping/counting/filtering/sorting/cross-nav
 *    authority. Desired explains assignment/source; Live only annotates
 *    `Runtime drift`. Drift/overrides/probes are signals on rows, never
 *    group keys — the shapes below keep them as annotations.
 *
 * Reuse over duplication:
 *  - Agent rows are `AgentPresentation` from `../agents/presentation`
 *    (`presentAgent`), so Assigned/Effective/Live, alignment and probe-issue
 *    semantics stay identical to the existing Agents page.
 *  - Model identity uses the canonical `modelKey` encoder from
 *    `../../models/presentation` (`providerId + "/" + modelId`, model ids may
 *    contain slashes, provider ids do not).
 *  - Adverse probe states reuse `isProblemProbe` (the doc-28 adverse set:
 *    unauthorized, model-not-found, rate-limited, timeout, malformed, error,
 *    provider-disconnected, opencode-disconnected; `running`/`healthy`/
 *    `never` are quiet).
 */
import type {
  AgentsDto,
  LiveProvider,
  ModelAvailability,
  ModelInventoryDto,
  ModelProbeState,
  ModelProbeSummary,
  ModelUsageReference,
  ProviderDiagnostics,
  ProvidersDto,
} from "@omo/shared";
import {
  filterAgents,
  presentAgent,
  sortAgentsBy,
  type AgentPresentation,
  type ProbeLookup,
  type SortState,
} from "../agents/presentation";
import {
  catalogNameFor,
  isProblemProbe,
  modelDisplayName,
  modelKey,
} from "../../models/presentation";

// ── Exact filter/sort IDs (doc 34 "Filters and sorts") ────────────────

/** Agents `filter` param IDs — exactly `all|overrides|runtime-drift|model-issues|custom`. */
export type TeamAgentFilterId =
  | "all"
  | "overrides"
  | "runtime-drift"
  | "model-issues"
  | "custom";

export const TEAM_AGENT_FILTER_IDS: readonly TeamAgentFilterId[] = [
  "all",
  "overrides",
  "runtime-drift",
  "model-issues",
  "custom",
];

export const TEAM_AGENT_FILTER_LABELS: Record<TeamAgentFilterId, string> = {
  all: "All",
  overrides: "Overrides",
  "runtime-drift": "Runtime drift",
  "model-issues": "Model issues",
  custom: "Custom",
};

/** Agents `sort` param IDs. Default is team order (null) — omitted from URL. */
export type TeamAgentSortId =
  | "name"
  | "model"
  | "provider"
  | "source"
  | "signals"
  | "kind";

export const TEAM_AGENT_SORT_IDS: readonly TeamAgentSortId[] = [
  "name",
  "model",
  "provider",
  "source",
  "signals",
  "kind",
];

/** Agents default sort: existing Effective team order (no explicit sort). */
export const TEAM_AGENT_DEFAULT_SORT: null = null;

export const TEAM_AGENT_SORT_LABELS: Record<TeamAgentSortId, string> = {
  name: "Name",
  model: "Model",
  provider: "Provider",
  source: "Source",
  signals: "Signals",
  kind: "Kind",
};

/** Models `filter` param IDs. */
export type TeamModelFilterId =
  | "all"
  | "primary"
  | "fallback"
  | "shared"
  | "issues"
  | "never-probed";

export const TEAM_MODEL_FILTER_IDS: readonly TeamModelFilterId[] = [
  "all",
  "primary",
  "fallback",
  "shared",
  "issues",
  "never-probed",
];

export const TEAM_MODEL_FILTER_LABELS: Record<TeamModelFilterId, string> = {
  all: "All",
  primary: "Primary",
  fallback: "Fallback",
  shared: "Shared",
  issues: "Issues",
  "never-probed": "Never probed",
};

/** Models `sort` param IDs; default `model` (provider grouping is display-only). */
export type TeamModelSortId =
  | "model"
  | "provider"
  | "primary"
  | "fallback"
  | "probe"
  | "issues";

export const TEAM_MODEL_SORT_IDS: readonly TeamModelSortId[] = [
  "model",
  "provider",
  "primary",
  "fallback",
  "probe",
  "issues",
];

export const TEAM_MODEL_DEFAULT_SORT: TeamModelSortId = "model";

export const TEAM_MODEL_SORT_LABELS: Record<TeamModelSortId, string> = {
  model: "Model",
  provider: "Provider",
  primary: "Primary",
  fallback: "Fallback",
  probe: "Probe",
  issues: "Issues",
};

/** Providers `filter` param IDs. */
export type TeamProviderFilterId =
  | "all"
  | "connected"
  | "custom-configured"
  | "shared"
  | "issues";

export const TEAM_PROVIDER_FILTER_IDS: readonly TeamProviderFilterId[] = [
  "all",
  "connected",
  "custom-configured",
  "shared",
  "issues",
];

export const TEAM_PROVIDER_FILTER_LABELS: Record<TeamProviderFilterId, string> =
  {
    all: "All",
    connected: "Connected",
    "custom-configured": "Custom configured",
    shared: "Shared",
    issues: "Issues",
  };

/**
 * Providers `sort` param IDs. Doc 34 lists the IDs without a named default;
 * `name` (first listed, natural provider ordering) is the default and is
 * omitted from URL/storage like every other default sort.
 */
export type TeamProviderSortId =
  | "name"
  | "connection"
  | "agents"
  | "models"
  | "issues"
  | "source";

export const TEAM_PROVIDER_SORT_IDS: readonly TeamProviderSortId[] = [
  "name",
  "connection",
  "agents",
  "models",
  "issues",
  "source",
];

export const TEAM_PROVIDER_DEFAULT_SORT: TeamProviderSortId = "name";

export const TEAM_PROVIDER_SORT_LABELS: Record<TeamProviderSortId, string> = {
  name: "Name",
  connection: "Connection",
  agents: "Agents",
  models: "Models",
  issues: "Issues",
  source: "Source",
};

export type TeamSortDir = "asc" | "desc";

/** One explicit sort selection; `null` (where allowed) means default order. */
export interface TeamSort<Id extends string = string> {
  id: Id;
  dir: TeamSortDir;
}

/** Catalog/provider display-name maps (same shape the Agents page builds). */
export interface TeamNameMaps {
  /** "provider/model" → OpenCode catalog name (only when it differs). */
  catalogNames?: ReadonlyMap<string, string>;
  /** provider id → display name (only when it differs). */
  providerNames?: ReadonlyMap<string, string>;
}

// ── Agents eligibility (doc 34 "Eligibility (Effective-gated)") ───────

/**
 * Team-eligible agent predicate: OMO built-ins and custom agents only.
 *
 * `AgentPresentation.owner === "self"` is exactly the doc-34 eligible set —
 * `presentAgent` assigns "self" only to rows that are neither:
 *  - `native` (OpenCode-managed),
 *  - ACP wrapper agents (registered in `/api/acp` inventory),
 *  - `councillor` (always Council-owned), nor
 *  - the gating `council` coordinator without a normal Effective assignment
 *    (council WITH a normal Effective assignment is an ordinary row).
 *
 * Enabled/disabled is the presentation `enabled` flag (row/presentation
 * semantics via `presentAgent`); `AgentsDto.effective.enabled` is never read.
 * "unknown"-kind configured rows (desired-only agents) follow the existing
 * roster precedent: non-native enabled rows count as custom agents.
 */
export function isTeamEligibleAgent(p: AgentPresentation): boolean {
  return p.owner === "self";
}

export interface TeamAgentsInput {
  /** AgentsDto from `/api/agents` (useRuntime). Empty eligibility when null. */
  agentsDto?: AgentsDto | null;
  /** Names from the `/api/acp` inventory (case-insensitive). */
  acpAgentNames?: Iterable<string> | null;
  /** Optional probe lookup forwarded to `presentAgent` (model-health issues). */
  probe?: ProbeLookup;
}

export interface TeamAgentSet {
  /** Eligible + enabled rows in default team order (BUILTIN_OMO_AGENTS declared order, then custom A–Z). */
  active: AgentPresentation[];
  /** Eligible + disabled rows in default team order (only shown with Show disabled). */
  disabled: AgentPresentation[];
  /** Active eligible names — the Models/Providers scope gate and the only valid Agents focus targets. */
  activeNames: ReadonlySet<string>;
}

/**
 * Derive the Team-eligible agent sets from the existing AgentsDto via
 * `presentAgent` (no new presentation semantics). Native, ACP wrappers,
 * councillor, and the gating council coordinator are excluded; eligible
 * agents without an Effective assignment stay in the roster but never enter
 * `activeNames`, so they cannot contribute to the Models/Providers scope.
 */
export function buildTeamAgents(input: TeamAgentsInput): TeamAgentSet {
  const dto = input.agentsDto;
  if (!dto) {
    return { active: [], disabled: [], activeNames: new Set<string>() };
  }
  const acpLower = new Set<string>();
  for (const name of input.acpAgentNames ?? []) {
    acpLower.add(name.toLowerCase());
  }
  const presentations = dto.rows.map((row) =>
    presentAgent(row, dto, input.probe, acpLower.has(row.name.toLowerCase())),
  );
  const eligible = presentations.filter(isTeamEligibleAgent);
  const active = sortAgentsBy(
    eligible.filter((p) => p.enabled),
    null,
  );
  const disabled = sortAgentsBy(
    eligible.filter((p) => !p.enabled),
    null,
  );
  return {
    active,
    disabled,
    activeNames: new Set(active.map((p) => p.name)),
  };
}

// ── Models hard scope (doc 34 "Hard scope: active Effective topology only") ──

/** An eligible active OMO agent's usage of one scoped model. */
export interface TeamAgentModelRef {
  kind: "agent-primary" | "agent-fallback";
  /** Agent name (AgentPresentation.name). */
  ownerId: string;
  /** Usage-ref label from the inventory (falls back to ownerId). */
  label: string;
  /** Agent's Effective variant, when configured. */
  variant?: string;
  /** Agent is a custom agent (`agent.kind === "custom"`). */
  custom: boolean;
  /**
   * Runtime drift annotation for this agent (Effective ≠ Live). Display-only
   * signal — never a group key or count.
   */
  liveDrift: boolean;
}

/** An active Council/ACP dependency usage of one scoped model. */
export interface TeamDependencyModelRef {
  kind: "council-member" | "acp-wrapper";
  /** `council.<preset>.<member>` or `acp.<wrapper>` ownerId from the inventory. */
  ownerId: string;
  label: string;
}

/** One hard-scoped Effective model group (compact-row data). */
export interface TeamScopedModel {
  /** Canonical `providerId + "/" + modelId` (modelKey encoder). */
  key: string;
  providerId: string;
  modelId: string;
  /** The inventory record (probe/capabilities/advertised/usage) — referenced, never mutated. */
  availability: ModelAvailability;
  /** Probe summary convenience (`availability.probe`). */
  probe: ModelProbeSummary;
  /** Active eligible agent primary refs (deduped per owner, team order). */
  agentPrimary: TeamAgentModelRef[];
  /** Active eligible agent fallback refs (deduped per owner, team order). */
  agentFallback: TeamAgentModelRef[];
  /** Active council-member refs (default/effective preset members only). */
  council: TeamDependencyModelRef[];
  /** Active acp-wrapper refs (enabled wrappers only). */
  acp: TeamDependencyModelRef[];
  counts: {
    /** Primary-role refs: agent primary + council + acp (the `primary` filter). */
    primary: number;
    /** Agent fallback refs (the `fallback` filter). */
    fallback: number;
    /** Distinct scoped owner ids across agents, Council and ACP (deduped). */
    owners: number;
  };
  /** `shared` filter: 2+ distinct scoped owner ids. */
  shared: boolean;
  hasPrimary: boolean;
  hasAgentFallback: boolean;
  /** Any adverse probe state for the model (doc-28 adverse set). */
  hasIssues: boolean;
  /** No probe record for the model (`probe.state === "never"`). */
  neverProbed: boolean;
  advertised: boolean;
  /** ProviderDiagnostics.connected; null when no diagnostics record exists. */
  providerConnected: boolean | null;
  /**
   * Runtime-drift annotation: eligible active agents using this model
   * effectively whose Live model differs. Annotation only — never a group key.
   */
  driftOwners: Array<{ ownerId: string; liveModel?: string }>;
}

export interface TeamModelsInput {
  /** ModelInventoryDto from `/api/models`. Empty scope when null. */
  inventory?: ModelInventoryDto | null;
  /** Team agent set (from `buildTeamAgents`) — the eligibility gate. */
  agents: TeamAgentSet;
}

/**
 * Hard-scope the Effective model universe (doc 34 Models route).
 *
 * In scope ONLY (may cause a group to exist):
 *  - active agent-primary / agent-fallback refs whose owner is an ACTIVE
 *    ELIGIBLE agent (native/ACP-wrapper/councillor/gating-council/disabled
 *    agents are out — usage refs from those owners are dropped), and
 *  - active `council-member` refs (default/effective council preset), and
 *  - active `acp-wrapper` refs (enabled wrappers).
 *
 * Excluded by construction: advertised-only catalog models, probe-history-only
 * models, Desired-only/Live-only models (usage is Effective-computed
 * server-side), inactive Council refs, disabled ACP wrapper refs, and refs
 * from disabled-agent eligibility. Primary/fallback/Council/ACP stay distinct
 * lists so the view can badge them separately. Deterministic output order:
 * providerId, then modelId.
 */
export function buildScopedTeamModels(input: TeamModelsInput): TeamScopedModel[] {
  const inventory = input.inventory;
  if (!inventory) return [];
  const presentations = new Map(
    input.agents.active.map((p) => [p.name, p] as const),
  );
  const diagByProvider = new Map(
    inventory.providers.map((d) => [d.providerId, d] as const),
  );

  const out: TeamScopedModel[] = [];
  for (const m of inventory.models) {
    const agentPrimary: TeamAgentModelRef[] = [];
    const agentFallback: TeamAgentModelRef[] = [];
    const council: TeamDependencyModelRef[] = [];
    const acp: TeamDependencyModelRef[] = [];
    const seenPrimary = new Set<string>();
    const seenFallback = new Set<string>();
    const seenCouncil = new Set<string>();
    const seenAcp = new Set<string>();

    for (const u of m.usage) {
      if (!u.active) continue;
      switch (u.kind) {
        case "agent-primary": {
          const p = presentations.get(u.ownerId);
          if (!p || seenPrimary.has(u.ownerId)) break;
          seenPrimary.add(u.ownerId);
          agentPrimary.push({
            kind: "agent-primary",
            ownerId: u.ownerId,
            label: u.label || u.ownerId,
            variant: p.effective.variant,
            custom: p.isCustom,
            liveDrift:
              p.alignment === "runtime-drift" || p.alignment === "both",
          });
          break;
        }
        case "agent-fallback": {
          const p = presentations.get(u.ownerId);
          if (!p || seenFallback.has(u.ownerId)) break;
          seenFallback.add(u.ownerId);
          agentFallback.push({
            kind: "agent-fallback",
            ownerId: u.ownerId,
            label: u.label || u.ownerId,
            variant: p.effective.variant,
            custom: p.isCustom,
            liveDrift:
              p.alignment === "runtime-drift" || p.alignment === "both",
          });
          break;
        }
        case "council-member": {
          if (seenCouncil.has(u.ownerId)) break;
          seenCouncil.add(u.ownerId);
          council.push({
            kind: "council-member",
            ownerId: u.ownerId,
            label: u.label || u.ownerId,
          });
          break;
        }
        case "acp-wrapper": {
          if (seenAcp.has(u.ownerId)) break;
          seenAcp.add(u.ownerId);
          acp.push({
            kind: "acp-wrapper",
            ownerId: u.ownerId,
            label: u.label || u.ownerId,
          });
          break;
        }
      }
    }

    if (
      agentPrimary.length === 0 &&
      agentFallback.length === 0 &&
      council.length === 0 &&
      acp.length === 0
    ) {
      continue; // advertised/history/Desired-only/Live-only/inactive/disabled
    }

    const owners = new Set<string>();
    for (const r of agentPrimary) owners.add(r.ownerId);
    for (const r of agentFallback) owners.add(r.ownerId);
    for (const r of council) owners.add(r.ownerId);
    for (const r of acp) owners.add(r.ownerId);

    const driftSeen = new Set<string>();
    const driftOwners: TeamScopedModel["driftOwners"] = [];
    for (const r of [...agentPrimary, ...agentFallback]) {
      if (!r.liveDrift || driftSeen.has(r.ownerId)) continue;
      driftSeen.add(r.ownerId);
      const p = presentations.get(r.ownerId);
      driftOwners.push({ ownerId: r.ownerId, liveModel: p?.live.model });
    }

    const diag = diagByProvider.get(m.providerId);
    const primaryCount = agentPrimary.length + council.length + acp.length;
    out.push({
      key: modelKey(m.providerId, m.modelId),
      providerId: m.providerId,
      modelId: m.modelId,
      availability: m,
      probe: m.probe,
      agentPrimary,
      agentFallback,
      council,
      acp,
      counts: {
        primary: primaryCount,
        fallback: agentFallback.length,
        owners: owners.size,
      },
      shared: owners.size >= 2,
      hasPrimary: primaryCount > 0,
      hasAgentFallback: agentFallback.length > 0,
      hasIssues: isProblemProbe(m.probe.state),
      neverProbed: m.probe.state === "never",
      advertised: m.advertised,
      providerConnected: diag ? diag.connected : null,
      driftOwners,
    });
  }

  out.sort(
    (a, b) =>
      a.providerId.localeCompare(b.providerId) ||
      a.modelId.localeCompare(b.modelId),
  );
  return out;
}

// ── Providers derivation (doc 34 Providers route) ─────────────────────

/** Unique ACTIVE ELIGIBLE OMO agent depending on a provider via scoped models. */
export interface TeamProviderAgentDependency {
  ownerId: string;
  /** Usages across this provider's scoped models, deduped, primary first. */
  roles: Array<"primary" | "fallback">;
  variant?: string;
  custom: boolean;
  /** Runtime drift annotation for the agent (Effective ≠ Live). */
  liveDrift: boolean;
}

/** One provider group — derived only from the scoped Models set. */
export interface TeamProviderGroup {
  providerId: string;
  /** LiveProvider.name → ProviderDiagnostics.name → providerId. Never invented. */
  displayName: string;
  /** Display connected state; false when neither source reports connected. */
  connected: boolean;
  /** Exact `connected` filter authority: `LiveProvider.connected === true`. */
  connectedPerLive: boolean;
  /** LiveProvider.source only; undefined when not reported ("Not reported"). */
  source: string | undefined;
  sourceLabel: string;
  /** ProviderDiagnostics.known; true when no diagnostics record exists. */
  known: boolean;
  /** Unique active eligible OMO agents only (disabled agents excluded). */
  agents: TeamProviderAgentDependency[];
  agentCount: number;
  /** Scoped models of this provider, canonical order. */
  models: TeamScopedModel[];
  modelCount: number;
  /** Active Council dependency refs across the provider's scoped models. */
  council: TeamDependencyModelRef[];
  /** Active ACP dependency refs across the provider's scoped models. */
  acp: TeamDependencyModelRef[];
  /** Adverse-issue scoped-model count (probe roll-up). */
  issueCount: number;
  hasIssues: boolean;
  /** 2+ distinct scoped owner ids across OMO agents, Council and ACP (deduped). */
  shared: boolean;
  /** Evidence-based `custom-configured` (see doc 34 — no heuristics, no secrets). */
  customConfigured: boolean;
  /** Human-readable evidence labels for the disclosure (one per reason). */
  customConfiguredEvidence: string[];
  diagnostics: ProviderDiagnostics | undefined;
  live: LiveProvider | undefined;
}

export interface TeamProvidersInput {
  /** Scoped models from `buildScopedTeamModels` — providers derive ONLY from these. */
  models: TeamScopedModel[];
  /** ModelInventoryDto — ProviderDiagnostics join (`known`, provider connectivity). */
  inventory?: ModelInventoryDto | null;
  /** ProvidersDto from `/api/providers` — LiveProvider join (`source`, connected). */
  providersDto?: ProvidersDto | null;
}

/**
 * Derive provider groups from the scoped Models set only. A provider with no
 * scoped model never appears. `custom-configured` is evidence-based only:
 * active eligible custom agent usage, `ProviderDiagnostics.known === false`,
 * or an unadvertised scoped model. No secrets, tokens, raw config or paths
 * are read or exposed — `LiveProvider.source` is the sole source string.
 */
export function buildTeamProviderGroups(
  input: TeamProvidersInput,
): TeamProviderGroup[] {
  const { models } = input;
  if (models.length === 0) return [];
  const diagByProvider = new Map(
    (input.inventory?.providers ?? []).map((d) => [d.providerId, d] as const),
  );
  const liveById = new Map(
    (input.providersDto?.providers ?? []).map((p) => [p.id, p] as const),
  );

  const byProvider = new Map<string, TeamScopedModel[]>();
  for (const m of models) {
    const arr = byProvider.get(m.providerId);
    if (arr) arr.push(m);
    else byProvider.set(m.providerId, [m]);
  }

  const groups: TeamProviderGroup[] = [];
  for (const [providerId, scopedModels] of byProvider) {
    const live = liveById.get(providerId);
    const diag = diagByProvider.get(providerId);

    // Unique active eligible OMO agents (deduped across the provider's
    // models; primary+fallback for one agent collapse into roles on one dep).
    const depMap = new Map<string, TeamProviderAgentDependency>();
    const addDep = (r: TeamAgentModelRef, role: "primary" | "fallback") => {
      const existing = depMap.get(r.ownerId);
      if (existing) {
        if (!existing.roles.includes(role)) existing.roles.push(role);
        if (existing.variant == null && r.variant != null) {
          existing.variant = r.variant;
        }
        existing.liveDrift = existing.liveDrift || r.liveDrift;
        return;
      }
      depMap.set(r.ownerId, {
        ownerId: r.ownerId,
        roles: [role],
        variant: r.variant,
        custom: r.custom,
        liveDrift: r.liveDrift,
      });
    };
    for (const m of scopedModels) {
      for (const r of m.agentPrimary) addDep(r, "primary");
      for (const r of m.agentFallback) addDep(r, "fallback");
    }
    const agents = [...depMap.values()].sort((a, b) =>
      a.ownerId.localeCompare(b.ownerId),
    );

    const council = new Map<string, TeamDependencyModelRef>();
    const acp = new Map<string, TeamDependencyModelRef>();
    for (const m of scopedModels) {
      for (const r of m.council) council.set(r.ownerId, r);
      for (const r of m.acp) acp.set(r.ownerId, r);
    }

    const ownerIds = new Set<string>([
      ...depMap.keys(),
      ...council.keys(),
      ...acp.keys(),
    ]);
    const issueCount = scopedModels.filter((m) => m.hasIssues).length;

    // Evidence-based custom-configured (exact doc-34 definition).
    const evidence: string[] = [];
    for (const a of agents) {
      if (a.custom) evidence.push(`Custom agent: ${a.ownerId}`);
    }
    if (diag?.known === false) {
      evidence.push("Provider not recognized by OpenCode");
    }
    for (const m of scopedModels) {
      if (!m.advertised) evidence.push(`Unadvertised model: ${m.key}`);
    }

    const source = live?.source?.trim() || undefined;
    groups.push({
      providerId,
      displayName: live?.name?.trim() || diag?.name?.trim() || providerId,
      connected: live ? live.connected : (diag?.connected ?? false),
      connectedPerLive: live?.connected === true,
      source,
      sourceLabel: source ?? "Not reported",
      known: diag ? diag.known : true,
      agents,
      agentCount: agents.length,
      models: scopedModels,
      modelCount: scopedModels.length,
      council: [...council.values()],
      acp: [...acp.values()],
      issueCount,
      hasIssues: issueCount > 0,
      shared: ownerIds.size >= 2,
      customConfigured: evidence.length > 0,
      customConfiguredEvidence: evidence,
      diagnostics: diag,
      live,
    });
  }

  groups.sort((a, b) => a.providerId.localeCompare(b.providerId));
  return groups;
}

// ── Topology bundle + TeamHeader counts ───────────────────────────────

export interface TeamTopologyInput extends TeamAgentsInput {
  inventory?: ModelInventoryDto | null;
  providersDto?: ProvidersDto | null;
}

export interface TeamTopology {
  agents: TeamAgentSet;
  models: TeamScopedModel[];
  providers: TeamProviderGroup[];
  /**
   * TeamHeader active-Effective counts (doc 34: `Team · 9 agents · 7 models ·
   * 4 providers`, active Effective eligible topology only). Never changes
   * with the Agents Show-disabled toggle — that gate is view-local.
   */
  header: { agents: number; models: number; providers: number };
}

/** Build the whole Team topology in one pass (memoize once per route tree). */
export function buildTeamTopology(input: TeamTopologyInput): TeamTopology {
  const agents = buildTeamAgents(input);
  const models = buildScopedTeamModels({
    inventory: input.inventory ?? null,
    agents,
  });
  const providers = buildTeamProviderGroups({
    models,
    inventory: input.inventory ?? null,
    providersDto: input.providersDto ?? null,
  });
  return {
    agents,
    models,
    providers,
    header: {
      agents: agents.active.length,
      models: models.length,
      providers: providers.length,
    },
  };
}

/** `9 agents · 7 models · 4 providers` — the counts segment of the header. */
export function formatTeamHeaderCounts(header: {
  agents: number;
  models: number;
  providers: number;
}): string {
  return `${header.agents} agent${header.agents === 1 ? "" : "s"} · ${header.models} model${header.models === 1 ? "" : "s"} · ${header.providers} provider${header.providers === 1 ? "" : "s"}`;
}

// ── Focus matching / canonical model keys ─────────────────────────────

/**
 * Split a canonical `provider/model` key. Provider ids contain no slash;
 * model ids may contain slashes, so the FIRST slash is the separator.
 * Returns undefined for keys without a separable provider/model pair.
 */
export function parseTeamModelKey(
  key: string,
): { providerId: string; modelId: string } | undefined {
  const i = key.indexOf("/");
  if (i <= 0 || i >= key.length - 1) return undefined;
  return { providerId: key.slice(0, i), modelId: key.slice(i + 1) };
}

/** Canonical single `model` focus param value (URLSearchParams-encoded as one value). */
export function teamModelFocusValue(m: {
  providerId: string;
  modelId: string;
}): string {
  return modelKey(m.providerId, m.modelId);
}

/** Exact key match for a `?model=` focus value (trimmed). */
export function findScopedTeamModel(
  models: readonly TeamScopedModel[],
  focusKey: string | null | undefined,
): TeamScopedModel | undefined {
  const k = focusKey?.trim();
  if (!k) return undefined;
  return models.find((m) => m.key === k);
}

/** Exact provider-id match for a `?provider=` focus value (trimmed). */
export function findTeamProviderGroup(
  groups: readonly TeamProviderGroup[],
  providerId: string | null | undefined,
): TeamProviderGroup | undefined {
  const k = providerId?.trim();
  if (!k) return undefined;
  return groups.find((g) => g.providerId === k);
}

/**
 * Valid Agents focus targets: ACTIVE ELIGIBLE agents only. Disabled agents
 * are not link targets, and Council/ACP refs navigate to `/council`//`/acp`
 * instead (their owner ids never appear here).
 */
export function isTeamAgentFocusTarget(
  agents: TeamAgentSet,
  name: string | null | undefined,
): boolean {
  if (!name) return false;
  return agents.activeNames.has(name);
}

// ── Agents view: gate → filter → search → sort (doc 34 Agents route) ──

/**
 * `overrides` is Assigned ≠ Effective with non-null Assigned (built-in
 * defaults do not count) — exactly `alignment === "assignment-override" |
 * "both"` from `presentAgent`. `runtime-drift` is Effective ≠ Live.
 */
export function matchesTeamAgentFilter(
  row: AgentPresentation,
  filter: TeamAgentFilterId,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "overrides":
      return (
        row.alignment === "assignment-override" || row.alignment === "both"
      );
    case "runtime-drift":
      return row.alignment === "runtime-drift" || row.alignment === "both";
    case "model-issues":
      return row.hasModelIssue;
    case "custom":
      return row.isCustom;
  }
}

/** Chip counts on the gated working set ("what would match if I clicked"). */
export function countTeamAgentFilters(
  rows: readonly AgentPresentation[],
): Record<TeamAgentFilterId, number> {
  const c: Record<TeamAgentFilterId, number> = {
    all: rows.length,
    overrides: 0,
    "runtime-drift": 0,
    "model-issues": 0,
    custom: 0,
  };
  for (const r of rows) {
    if (matchesTeamAgentFilter(r, "overrides")) c.overrides++;
    if (matchesTeamAgentFilter(r, "runtime-drift")) c["runtime-drift"]++;
    if (matchesTeamAgentFilter(r, "model-issues")) c["model-issues"]++;
    if (matchesTeamAgentFilter(r, "custom")) c.custom++;
  }
  return c;
}

/**
 * Filter + search over already-gated rows. Search reuses the existing
 * `filterAgents` haystack (agent name, model id/provider, catalog names,
 * source label/path, fallback ids — the doc-28 family) by applying its
 * pass-through `"all"` filter with the query.
 */
export function filterTeamAgents(
  rows: readonly AgentPresentation[],
  filter: TeamAgentFilterId,
  q: string,
  names?: TeamNameMaps,
): AgentPresentation[] {
  const gated = rows.filter((r) => matchesTeamAgentFilter(r, filter));
  if (!q.trim()) return gated;
  return filterAgents(
    gated,
    "all",
    q,
    names?.catalogNames,
    names?.providerNames,
  );
}

/**
 * Sort already-filtered rows. `null` = default team order (Effective team
 * order: BUILTIN_OMO_AGENTS declared order, then custom A–Z). Explicit sorts
 * reuse `sortAgentsBy` (stable, missing-last in BOTH directions); `kind`
 * (not an existing sort key) orders builtin < custom < unknown alphabetically.
 * Ties keep team order via stable sort over team-ordered input.
 */
export function sortTeamAgents(
  rows: readonly AgentPresentation[],
  sort: TeamSort<TeamAgentSortId> | null,
  names?: TeamNameMaps,
): AgentPresentation[] {
  const teamOrder = sortAgentsBy(
    [...rows],
    null,
    names?.catalogNames,
    names?.providerNames,
  );
  if (sort == null) return teamOrder;
  if (sort.id !== "kind") {
    const s: SortState = { key: sort.id, dir: sort.dir };
    return sortAgentsBy(
      teamOrder,
      s,
      names?.catalogNames,
      names?.providerNames,
    );
  }
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...teamOrder].sort((a, b) => {
    const primary = a.kind.localeCompare(b.kind);
    if (primary === 0) return 0;
    return sign * primary;
  });
}

export interface TeamAgentsViewQuery {
  /** Show-disabled eligibility gate — runs BEFORE facet filters/search/sort. */
  showDisabled: boolean;
  filter: TeamAgentFilterId;
  q: string;
  /** null = default team order. */
  sort: TeamSort<TeamAgentSortId> | null;
}

export interface TeamAgentsViewResult {
  rows: AgentPresentation[];
  /** Chip counts computed on the gated working set (pre-filter). */
  filterCounts: Record<TeamAgentFilterId, number>;
  activeShown: number;
  /** `disabled shown: N` — separate from the header active count. */
  disabledShown: number;
}

/**
 * Full Agents pipeline: show-disabled gate first, then facets/search, then
 * sort. Toggling `showDisabled` only changes this result — never the
 * Models/Providers universes or TeamHeader counts (those come from
 * `buildTeamTopology`, which is always active-scoped).
 */
export function applyTeamAgentsView(
  agents: TeamAgentSet,
  query: TeamAgentsViewQuery,
  names?: TeamNameMaps,
): TeamAgentsViewResult {
  const working = query.showDisabled
    ? sortTeamAgents([...agents.active, ...agents.disabled], null, names)
    : agents.active;
  const filterCounts = countTeamAgentFilters(working);
  const filtered = filterTeamAgents(working, query.filter, query.q, names);
  const rows = sortTeamAgents(filtered, query.sort, names);
  const disabledShown = rows.filter((r) => r.isDisabled).length;
  return {
    rows,
    filterCounts,
    activeShown: rows.length - disabledShown,
    disabledShown,
  };
}

// ── Models view: filter/search/sort within the scoped set ─────────────

export function matchesTeamModelFilter(
  m: TeamScopedModel,
  filter: TeamModelFilterId,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "primary":
      return m.hasPrimary;
    case "fallback":
      return m.hasAgentFallback;
    case "shared":
      return m.shared;
    case "issues":
      return m.hasIssues;
    case "never-probed":
      return m.neverProbed;
  }
}

export function countTeamModelFilters(
  models: readonly TeamScopedModel[],
): Record<TeamModelFilterId, number> {
  const c: Record<TeamModelFilterId, number> = {
    all: models.length,
    primary: 0,
    fallback: 0,
    shared: 0,
    issues: 0,
    "never-probed": 0,
  };
  for (const m of models) {
    if (m.hasPrimary) c.primary++;
    if (m.hasAgentFallback) c.fallback++;
    if (m.shared) c.shared++;
    if (m.hasIssues) c.issues++;
    if (m.neverProbed) c["never-probed"]++;
  }
  return c;
}

/**
 * Deterministic search over scoped models: provider/model ids, canonical
 * key, catalog display name, provider display name, and usage owner
 * ids/labels (agents, Council, ACP). Doc 34 persists `q` for all three
 * routes; match fields follow the Agents search family.
 */
export function matchesTeamModelSearch(
  m: TeamScopedModel,
  q: string,
  names?: TeamNameMaps,
): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const catalog = catalogNameFor(m.providerId, m.modelId, names?.catalogNames);
  const providerDisplay = names?.providerNames?.get(m.providerId);
  const hay = [
    m.key,
    m.providerId,
    m.modelId,
    catalog ?? "",
    providerDisplay ?? "",
    ...m.agentPrimary.flatMap((r) => [r.ownerId, r.label]),
    ...m.agentFallback.flatMap((r) => [r.ownerId, r.label]),
    ...m.council.flatMap((r) => [r.ownerId, r.label]),
    ...m.acp.flatMap((r) => [r.ownerId, r.label]),
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes(needle);
}

export function filterTeamModels(
  models: readonly TeamScopedModel[],
  filter: TeamModelFilterId,
  q: string,
  names?: TeamNameMaps,
): TeamScopedModel[] {
  return models.filter(
    (m) => matchesTeamModelFilter(m, filter) && matchesTeamModelSearch(m, q, names),
  );
}

/** Probe-state severity for the `probe` sort (lower = worse). */
function modelProbeSeverityRank(state: ModelProbeState): number {
  if (isProblemProbe(state)) {
    // Warn-class states (per the existing adverse-issue labels) after bad.
    return state === "rate-limited" ||
      state === "provider-disconnected" ||
      state === "opencode-disconnected"
      ? 1
      : 0;
  }
  if (state === "running") return 2;
  if (state === "never") return 3;
  return 4; // healthy
}

function modelDisplayKey(
  m: TeamScopedModel,
  names?: TeamNameMaps,
): string {
  const catalog = catalogNameFor(m.providerId, m.modelId, names?.catalogNames);
  return modelDisplayName(m.modelId, catalog).toLowerCase();
}

/**
 * Sort scoped models. `model` (default) orders by catalog display name →
 * model id (provider grouping stays display-only). `primary`/`fallback` are
 * volume counts (asc = ascending). `probe`/`issues` are severity keys:
 * asc = WORST first (mirrors the Agents `signals` rank precedent), missing
 * values sort last in both directions for text keys.
 */
export function sortTeamModels(
  models: readonly TeamScopedModel[],
  sort: TeamSort<TeamModelSortId>,
  names?: TeamNameMaps,
): TeamScopedModel[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...models].sort((a, b) => {
    let primary = 0;
    switch (sort.id) {
      case "model":
        primary = modelDisplayKey(a, names).localeCompare(
          modelDisplayKey(b, names),
        );
        break;
      case "provider": {
        const ap = names?.providerNames?.get(a.providerId) ?? a.providerId;
        const bp = names?.providerNames?.get(b.providerId) ?? b.providerId;
        primary = ap.toLowerCase().localeCompare(bp.toLowerCase());
        break;
      }
      case "primary":
        primary = a.counts.primary - b.counts.primary;
        break;
      case "fallback":
        primary = a.counts.fallback - b.counts.fallback;
        break;
      case "probe":
        primary =
          modelProbeSeverityRank(a.probe.state) -
          modelProbeSeverityRank(b.probe.state);
        if (primary === 0) {
          primary = a.key.localeCompare(b.key);
        }
        break;
      case "issues":
        primary = (a.hasIssues ? 0 : 1) - (b.hasIssues ? 0 : 1);
        if (primary === 0) {
          primary =
            modelProbeSeverityRank(a.probe.state) -
            modelProbeSeverityRank(b.probe.state);
          if (primary === 0) primary = a.key.localeCompare(b.key);
        }
        break;
    }
    if (primary === 0) return 0;
    return sign * primary;
  });
}

export interface TeamModelsViewQuery {
  filter: TeamModelFilterId;
  q: string;
  sort: TeamSort<TeamModelSortId>;
}

export interface TeamModelsViewResult {
  rows: TeamScopedModel[];
  filterCounts: Record<TeamModelFilterId, number>;
}

export function applyTeamModelsView(
  models: readonly TeamScopedModel[],
  query: TeamModelsViewQuery,
  names?: TeamNameMaps,
): TeamModelsViewResult {
  return {
    rows: sortTeamModels(
      filterTeamModels(models, query.filter, query.q, names),
      query.sort,
      names,
    ),
    filterCounts: countTeamModelFilters(models),
  };
}

// ── Providers view: filter/search/sort ────────────────────────────────

export function matchesTeamProviderFilter(
  g: TeamProviderGroup,
  filter: TeamProviderFilterId,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "connected":
      return g.connectedPerLive;
    case "custom-configured":
      return g.customConfigured;
    case "shared":
      return g.shared;
    case "issues":
      return g.hasIssues;
  }
}

export function countTeamProviderFilters(
  groups: readonly TeamProviderGroup[],
): Record<TeamProviderFilterId, number> {
  const c: Record<TeamProviderFilterId, number> = {
    all: groups.length,
    connected: 0,
    "custom-configured": 0,
    shared: 0,
    issues: 0,
  };
  for (const g of groups) {
    if (g.connectedPerLive) c.connected++;
    if (g.customConfigured) c["custom-configured"]++;
    if (g.shared) c.shared++;
    if (g.hasIssues) c.issues++;
  }
  return c;
}

/**
 * Deterministic search over provider groups: provider id/display name,
 * source, scoped model ids/keys/display names, and dependent owner
 * ids/labels (eligible agents, Council, ACP).
 */
export function matchesTeamProviderSearch(
  g: TeamProviderGroup,
  q: string,
  names?: TeamNameMaps,
): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const hay = [
    g.providerId,
    g.displayName,
    g.diagnostics?.name ?? "",
    g.source ?? "",
    ...g.models.flatMap((m) => [
      m.key,
      m.modelId,
      catalogNameFor(m.providerId, m.modelId, names?.catalogNames) ?? "",
    ]),
    ...g.agents.flatMap((a) => [a.ownerId]),
    ...g.council.flatMap((r) => [r.ownerId, r.label]),
    ...g.acp.flatMap((r) => [r.ownerId, r.label]),
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes(needle);
}

export function filterTeamProviders(
  groups: readonly TeamProviderGroup[],
  filter: TeamProviderFilterId,
  q: string,
  names?: TeamNameMaps,
): TeamProviderGroup[] {
  return groups.filter(
    (g) =>
      matchesTeamProviderFilter(g, filter) &&
      matchesTeamProviderSearch(g, q, names),
  );
}

/**
 * Sort provider groups. `name` (default) by display name; `connection` uses
 * the LiveProvider authority (connected first on asc); `agents`/`models` are
 * volume counts (asc = ascending); `issues` is a severity key (asc = worst
 * first); `source` compares `LiveProvider.source` with missing ("Not
 * reported") last in both directions.
 */
export function sortTeamProviders(
  groups: readonly TeamProviderGroup[],
  sort: TeamSort<TeamProviderSortId>,
  names?: TeamNameMaps,
): TeamProviderGroup[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...groups].sort((a, b) => {
    let aMissing = false;
    let bMissing = false;
    let primary = 0;
    switch (sort.id) {
      case "name":
        primary = a.displayName
          .toLowerCase()
          .localeCompare(b.displayName.toLowerCase());
        if (primary === 0) {
          primary = a.providerId.localeCompare(b.providerId);
        }
        break;
      case "connection":
        primary = (a.connectedPerLive ? 0 : 1) - (b.connectedPerLive ? 0 : 1);
        break;
      case "agents":
        primary = a.agentCount - b.agentCount;
        break;
      case "models":
        primary = a.modelCount - b.modelCount;
        break;
      case "issues":
        primary = b.issueCount - a.issueCount; // asc = worst first
        if (primary === 0) {
          primary = a.providerId.localeCompare(b.providerId);
        }
        break;
      case "source": {
        aMissing = a.source == null;
        bMissing = b.source == null;
        primary = (a.source ?? "").localeCompare(b.source ?? "");
        break;
      }
    }
    // Missing-last in BOTH directions (no asc-flip), matching the existing
    // Agents sort convention.
    if (aMissing !== bMissing) {
      return aMissing ? 1 : -1;
    }
    if (primary === 0) return 0;
    return sign * primary;
  });
}

export interface TeamProvidersViewQuery {
  filter: TeamProviderFilterId;
  q: string;
  sort: TeamSort<TeamProviderSortId>;
}

export interface TeamProvidersViewResult {
  rows: TeamProviderGroup[];
  filterCounts: Record<TeamProviderFilterId, number>;
}

export function applyTeamProvidersView(
  groups: readonly TeamProviderGroup[],
  query: TeamProvidersViewQuery,
  names?: TeamNameMaps,
): TeamProvidersViewResult {
  return {
    rows: sortTeamProviders(
      filterTeamProviders(groups, query.filter, query.q, names),
      query.sort,
      names,
    ),
    filterCounts: countTeamProviderFilters(groups),
  };
}
