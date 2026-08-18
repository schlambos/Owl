/**
 * Agents page presentation model.
 *
 * Computes Assigned / Effective / Live + alignment state + source label +
 * fallback chain + model-health issues from the AgentsDto. The page MUST NOT
 * trust `row.desiredModel` as Assigned — that field is computed by
 * `desiredModelForAgent`, which prefers root over preset and so almost
 * never shows the actual preset assignment. We derive Assigned client-side
 * from the desired config so the user sees what they actually configured.
 *
 * Model health is issue-first: healthy and never-probed are quiet; only the
 * eight adverse states surface, for the effective primary AND each fallback.
 */
import type {
  AgentRow,
  AgentsDto,
  DesiredAgent,
  ModelProbeState,
  ResolveStage,
} from "@omo/shared";
import { BUILTIN_OMO_AGENTS } from "@omo/shared";

export type AlignmentState =
  /** All three layers agree (or live missing & assigned==effective). */
  | "aligned"
  /** Preset masked by root/project (Assigned ≠ Effective). */
  | "assignment-override"
  /** Effective ≠ Live, live present. */
  | "runtime-drift"
  /** Both assignment-override and runtime-drift. */
  | "both"
  /** No Assigned, no Effective, but a Live agent exists (council/councillor). */
  | "unconfigured-live"
  /** No Assigned, no Effective, no Live (disabled Observer). */
  | "unconfigured";

/** One adverse model-health finding for the effective primary or a fallback. */
export interface ProbeIssue {
  /** Canonical "provider/model" id. */
  model: string;
  role: "primary" | "fallback";
  state: ModelProbeState;
  /** Human label, e.g. "Timeout". */
  label: string;
  class: "warn" | "bad";
}

/**
 * Who owns this agent's model configuration.
 *  - "self"    — editable here (ordinary builtin/custom, incl. disabled).
 *  - "council" — councillor, or council with no effective assignment.
 *  - "acp"     — registered ACP wrapper; model managed in the ACP workspace.
 *  - "native"  — native OpenCode agent; managed by OpenCode configuration.
 */
export type OwnerKind = "self" | "council" | "acp" | "native";

export interface AgentPresentation {
  /** Identity. */
  name: string;
  kind: AgentRow["kind"];
  enabled: boolean;
  /** Built-in OMO agent from BUILTIN_OMO_AGENTS. */
  isBuiltinOmo: boolean;
  isCustom: boolean;
  isDisabled: boolean;

  /** The three layers — null/undefined when absent. */
  assigned: {
    model?: string;
    variant?: string;
    sourcePath?: string;
  };
  effective: {
    model?: string;
    variant?: string;
    sourcePath?: string;
    fallbacks: string[];
  };
  live: {
    model?: string;
    variant?: string;
  };

  /** First-class alignment state. */
  alignment: AlignmentState;

  /** Human source label (e.g. "Preset: openai", "Root override"). */
  sourceLabel: string;
  /** Exact provenance path for tooltip / disclosure (e.g. "presets.openai.explorer.model"). */
  sourceDetail: string;
  /** Raw resolve stage from provenance winner. */
  sourceStage: ResolveStage | undefined;

  /** Fallback count (number of configured fallbacks). */
  fallbackCount: number;

  /** Session count from runtime (drawer only — not a table column). */
  sessionCount: number;

  /** Adverse model-health issues (primary first, then fallbacks in order). */
  probeIssues: ProbeIssue[];
  probeIssueCount: number;
  /** True when any adverse primary/fallback probe issue exists. */
  hasModelIssue: boolean;
  /** Primary probe is currently running — shown as quiet "Testing", never adverse. */
  primaryProbeRunning: boolean;

  /** Ownership / edit affordance. */
  owner: OwnerKind;
  canEdit: boolean;
  isAcp: boolean;
  editHint?: string;
}

export interface ProbeLookup {
  /** Returns the probe state for a "provider/model" string. */
  getProbe: (model?: string) => {
    state: ModelProbeState;
    freshness?: string;
    statusCode?: number;
    errorCode?: string;
  } | undefined;
}

/**
 * The exact adverse probe states. Running is NOT adverse (quiet "Testing");
 * healthy and never are quiet. Disconnected states are adverse warnings.
 */
const ADVERSE_PROBE_STATES: ReadonlySet<ModelProbeState> = new Set([
  "unauthorized",
  "model-not-found",
  "rate-limited",
  "timeout",
  "malformed",
  "error",
  "provider-disconnected",
  "opencode-disconnected",
]);

function norm(s?: string): string | undefined {
  return s?.trim() || undefined;
}

function modelsDiffer(a?: string, b?: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na && !nb) return false;
  if (!na || !nb) return true;
  return na !== nb;
}

/**
 * Compute Assigned from the desired config:
 *  - If the active preset has `desired.presets[preset][agent].model`, Assigned = that.
 *  - Else if `desired.agents[agent].model` exists, Assigned = that.
 *  - Else undefined.
 *
 * NOTE: This is the *base intentional source*, NOT the winning effective.
 * A root override that wins does NOT change Assigned.
 */
function computeAssigned(
  desired: AgentsDto["desired"],
  preset: string | undefined,
  name: string,
): { model?: string; variant?: string; sourcePath?: string } {
  const fromPreset =
    preset && desired.presets[preset]?.[name]?.model != null
      ? desired.presets[preset]![name]!
      : undefined;
  const fromRoot = desired.agents[name];
  const chosen: DesiredAgent | undefined = fromPreset ?? fromRoot;
  if (!chosen || chosen.model == null) return {};
  const model = normalizeModel(chosen.model);
  return {
    model,
    variant: chosen.variant,
    sourcePath: fromPreset
      ? `presets.${preset}.${name}.model`
      : `agents.${name}.model`,
  };
}

function normalizeModel(
  m: string | Array<string | { id?: string; variant?: string }>,
): string | undefined {
  if (typeof m === "string") return norm(m);
  if (Array.isArray(m) && m.length > 0) {
    const first = m[0]!;
    if (typeof first === "string") return norm(first);
    if (first && typeof first === "object") return norm(first.id);
  }
  return undefined;
}

function alignment(
  assigned: string | undefined,
  effective: string | undefined,
  live: string | undefined,
): AlignmentState {
  const a = norm(assigned);
  const e = norm(effective);
  const l = norm(live);
  // Unconfigured states must win before drift: missing Effective + present
  // Live is "no assignment (live only)", not runtime drift.
  if (a == null && e == null && l == null) return "unconfigured";
  if (a == null && e == null && l != null) return "unconfigured-live";
  // No Assigned at all (e.g. builtin-default resolution) is NOT an
  // assignment override — an override requires an intentional assignment
  // that diverges from the effective winner.
  const assignOverride = a != null && modelsDiffer(a, e);
  const runtimeDrift = l != null && modelsDiffer(e, l);
  if (assignOverride && runtimeDrift) return "both";
  if (assignOverride) return "assignment-override";
  if (runtimeDrift) return "runtime-drift";
  return "aligned";
}

/**
 * Human source label. Click reveals exact provenance path (independent
 * inline disclosure — never opens the drawer).
 * Council/councillor (no effective model assignment, but live exists)
 * surface as "Council built-in" — distinct from "Built-in default".
 */
function sourceLabel(
  stage: ResolveStage | undefined,
  preset: string | undefined,
  hasPresetModel: boolean,
  hasRootModel: boolean,
  isCustom: boolean,
  isBuiltinOmo: boolean,
  isCouncilLike: boolean,
  name: string,
): { label: string; detail: string } {
  if (isCouncilLike) {
    return {
      label: "Council built-in",
      detail: "no model assignment — coordinator/councillor model comes from runtime",
    };
  }
  switch (stage) {
    case "preset":
      return {
        label: preset ? `Preset: ${preset}` : "Preset",
        detail: `presets.${preset ?? "—"}.${name}.model`,
      };
    case "root-agent": {
      if (isCustom && !hasPresetModel) {
        return {
          label: "Custom / root",
          detail: `agents.${name}.model (custom agent, no preset entry)`,
        };
      }
      if (hasPresetModel) {
        return {
          label: "Root override",
          detail: `agents.${name}.model overrides active preset`,
        };
      }
      return {
        label: "Root override",
        detail: `agents.${name}.model`,
      };
    }
    case "project-config":
      return {
        label: "Project override",
        detail: `project agents.${name}.model`,
      };
    case "user-config":
      return {
        label: "User config",
        detail: `user agents.${name}.model`,
      };
    case "runtime-preset":
      return {
        label: "Runtime preset",
        detail: "active preset switched at runtime",
      };
    case "builtin":
      return {
        label: "Built-in default",
        detail: "no configuration override",
      };
    case "merged":
    case "env":
    case "prompt-file":
      return {
        label: stage,
        detail: "",
      };
    default:
      return {
        label: "—",
        detail: "",
      };
  }
}

/** Label + severity class for one adverse probe state. */
function adverseIssue(
  model: string,
  role: "primary" | "fallback",
  state: ModelProbeState,
): ProbeIssue | null {
  switch (state) {
    case "unauthorized":
      return { model, role, state, label: "Unauthorized", class: "bad" };
    case "model-not-found":
      return { model, role, state, label: "Model not found", class: "bad" };
    case "rate-limited":
      return { model, role, state, label: "Rate limited", class: "warn" };
    case "timeout":
      return { model, role, state, label: "Timeout", class: "bad" };
    case "malformed":
      return { model, role, state, label: "Malformed response", class: "bad" };
    case "error":
      return { model, role, state, label: "Unavailable", class: "bad" };
    case "provider-disconnected":
      return { model, role, state, label: "Provider disconnected", class: "warn" };
    case "opencode-disconnected":
      return { model, role, state, label: "OpenCode disconnected", class: "warn" };
    default:
      return null;
  }
}

/** Catalog display name when OpenCode supplies one that differs from the id. */
export function catalogDisplayName(
  id: string | undefined,
  names: ReadonlyMap<string, string> | undefined,
): string | undefined {
  if (!id || !names) return undefined;
  const n = names.get(id);
  return n && n !== id ? n : undefined;
}

/**
 * Human model label: live catalog name when OpenCode supplies one, otherwise
 * the last path segment when it is the informative tail. Never invents names.
 */
export function humanModelName(
  id: string | undefined,
  names?: ReadonlyMap<string, string>,
): string {
  if (!id) return "—";
  const catalog = catalogDisplayName(id, names);
  if (catalog) return catalog;
  const i = id.lastIndexOf("/");
  if (i < 0) return id;
  const tail = id.slice(i + 1);
  return tail.length >= id.length / 2 ? tail : id;
}

/** Provider display name from the live catalog, else the provider id. */
export function providerLabel(
  model: string | undefined,
  providerNames?: ReadonlyMap<string, string>,
): string | undefined {
  if (!model) return undefined;
  const i = model.indexOf("/");
  const id = i < 0 ? model : model.slice(0, i);
  const display = providerNames?.get(id);
  return display && display !== id ? display : id;
}

export function isAdverseProbeState(state: ModelProbeState | undefined): boolean {
  if (!state) return false;
  return ADVERSE_PROBE_STATES.has(state);
}

/**
 * Build a presentation model for one agent row.
 *
 * @param row The AgentRow from the DTO.
 * @param dto The full AgentsDto (needed for desired.presets/agents).
 * @param probe Optional probe lookup (provider/model → probe summary).
 * @param isAcp True if the agent is registered in ACP inventory.
 */
export function presentAgent(
  row: AgentRow,
  dto: AgentsDto,
  probe: ProbeLookup | undefined,
  isAcp: boolean,
): AgentPresentation {
  const preset = dto.effective.preset;
  const eff = dto.effective.agents[row.name];
  const liveModel = norm(row.liveModel);
  const liveVariant = row.liveVariant;
  const effectiveModel = norm(row.effectiveModel);
  const effectiveVariant = row.effectiveVariant;
  const fallbacks = eff?.modelFallbacks ?? [];
  const fallbackCount = fallbacks.length;

  const assigned = computeAssigned(dto.desired, preset, row.name);
  const hasPresetModel =
    preset != null &&
    dto.desired.presets[preset]?.[row.name]?.model != null;
  const hasRootModel = dto.desired.agents[row.name]?.model != null;

  const isBuiltinOmo =
    row.kind === "builtin" &&
    (BUILTIN_OMO_AGENTS as readonly string[]).includes(row.name);
  const isCouncilAgent =
    isBuiltinOmo && (row.name === "council" || row.name === "councillor");
  const isCouncilLike = isCouncilAgent && effectiveModel == null;

  const stage = row.modelSourceStage as ResolveStage | undefined;
  const src = sourceLabel(
    stage,
    preset,
    !!hasPresetModel,
    !!hasRootModel,
    row.kind === "custom",
    isBuiltinOmo,
    isCouncilLike,
    row.name,
  );

  const state = alignment(assigned.model, effectiveModel, liveModel);

  // Model health: effective primary + ordered fallbacks. Adverse states
  // only; primary "running" is reported separately as quiet "Testing".
  const probeIssues: ProbeIssue[] = [];
  const primaryProbe = probe?.getProbe(effectiveModel);
  if (effectiveModel && primaryProbe) {
    const issue = adverseIssue(effectiveModel, "primary", primaryProbe.state);
    if (issue) probeIssues.push(issue);
  }
  for (const f of fallbacks) {
    const fp = probe?.getProbe(f);
    if (!fp) continue;
    const issue = adverseIssue(f, "fallback", fp.state);
    if (issue) probeIssues.push(issue);
  }
  const primaryProbeRunning =
    effectiveModel != null && primaryProbe?.state === "running";

  // Ownership: councillor and live-only/unconfigured council belong to the
  // Council workspace; council WITH a normal effective assignment is an
  // ordinary editable row. ACP wrappers and native agents link away.
  const owner: OwnerKind =
    row.kind === "native"
      ? "native"
      : isAcp
        ? "acp"
        : isCouncilAgent && (row.name === "councillor" || effectiveModel == null)
          ? "council"
          : "self";
  const canEdit = owner === "self";

  return {
    name: row.name,
    kind: row.kind,
    enabled: row.enabled,
    isBuiltinOmo,
    isCustom: row.kind === "custom",
    isDisabled: !row.enabled,
    assigned,
    effective: {
      model: effectiveModel,
      variant: effectiveVariant,
      sourcePath: row.provenanceSummary
        ? row.provenanceSummary.replace(/^[^:]+:\s*/, "")
        : undefined,
      fallbacks,
    },
    live: {
      model: liveModel,
      variant: liveVariant,
    },
    alignment: state,
    sourceLabel: src.label,
    sourceDetail: src.detail,
    sourceStage: stage,
    fallbackCount,
    sessionCount: row.sessionCount,
    probeIssues,
    probeIssueCount: probeIssues.length,
    hasModelIssue: probeIssues.length > 0,
    primaryProbeRunning,
    owner,
    canEdit,
    isAcp,
    editHint:
      owner === "acp"
        ? "Model managed in the ACP workspace — edit the wrapper there."
        : owner === "native"
          ? "Managed by OpenCode configuration."
          : owner === "council"
            ? "Council built-in — model is managed in the Council workspace."
            : undefined,
  };
}

/** Sort: BUILTIN_OMO_AGENTS first (declared order), then custom A–Z, then native A–Z. */
export function sortAgents(
  rows: AgentPresentation[],
  includeNative: boolean,
): AgentPresentation[] {
  const builtinOrder = new Map<string, number>();
  BUILTIN_OMO_AGENTS.forEach((n, i) => builtinOrder.set(n, i));
  return [...rows]
    .filter((r) => includeNative || r.kind !== "native")
    .sort((a, b) => {
      const ai = builtinOrder.has(a.name) ? builtinOrder.get(a.name)! : 1e9;
      const bi = builtinOrder.has(b.name) ? builtinOrder.get(b.name)! : 1e9;
      if (ai !== bi) return ai - bi;
      return a.name.localeCompare(b.name);
    });
}

// ── Sortable columns ─────────────────────────────────────────────
//
// The header click cycle is: none → asc → desc → none (third click on the
// active key, OR clicking a different key resets to that key's asc).
// Missing values sort last in BOTH directions (no asc-flip).
//
// Sort keys used by the compact sort control and (where present) headers.
// `provider` has no dedicated column — it is a comparison-mode option only.
// `signals` ranks adverse probe issues (the Status column / Issues First).

export type SortKey = "name" | "model" | "source" | "signals" | "provider";

export type SortDir = "asc" | "desc";

export interface SortState {
  key: SortKey;
  dir: SortDir;
}

/** Display name used for sort + on-screen rendering of the effective model. */
export function modelDisplayName(
  id: string | undefined,
  names: ReadonlyMap<string, string> | undefined,
): string {
  if (!id) return "";
  const catalog = catalogDisplayName(id, names);
  if (catalog) return catalog.toLowerCase();
  const i = id.lastIndexOf("/");
  const tail = i < 0 ? id : id.slice(i + 1);
  return tail.toLowerCase();
}

/**
 * Signals severity rank. Lower = more urgent (worst first when asc).
 * Adverse "bad" issues rank 0, "warn" issues rank 1, a running primary
 * probe ("Testing", not adverse) ranks 2. Quiet rows (healthy/never/
 * unprobed) are MISSING — they sort last in both directions.
 */
export function signalsRank(row: AgentPresentation): number | null {
  if (row.probeIssues.length > 0) {
    return Math.min(...row.probeIssues.map((i) => (i.class === "bad" ? 0 : 1)));
  }
  if (row.primaryProbeRunning) return 2;
  return null;
}

/**
 * Sort a list by the given sort state. If `sort` is null, returns the
 * default role order (BUILTIN_OMO_AGENTS first, then custom A–Z, then
 * native A–Z) — this is the "none" / third-click state.
 *
 * `catalogNames` is used to derive the human display name for the
 * model-name sort key (catalog name → last path segment → full id).
 *
 * Missing values sort last in BOTH directions (no inversion).
 */
export function sortAgentsBy(
  rows: AgentPresentation[],
  sort: SortState | null,
  catalogNames?: ReadonlyMap<string, string>,
  providerNames?: ReadonlyMap<string, string>,
): AgentPresentation[] {
  if (sort === null) {
    return sortAgents(rows, /* includeNative */ true);
  }
  const { key, dir } = sort;
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    let aMissing = false;
    let bMissing = false;
    let primary = 0;
    switch (key) {
      case "name": {
        const an = a.name.toLowerCase();
        const bn = b.name.toLowerCase();
        aMissing = an === "";
        bMissing = bn === "";
        primary = an.localeCompare(bn);
        break;
      }
      case "model": {
        const aId = a.effective.model ?? a.assigned.model;
        const bId = b.effective.model ?? b.assigned.model;
        aMissing = aId == null;
        bMissing = bId == null;
        primary = modelDisplayName(aId, catalogNames).localeCompare(
          modelDisplayName(bId, catalogNames),
        );
        break;
      }
      case "provider": {
        const aId = a.effective.model ?? a.assigned.model;
        const bId = b.effective.model ?? b.assigned.model;
        const ap = providerLabel(aId, providerNames)?.toLowerCase() ?? "";
        const bp = providerLabel(bId, providerNames)?.toLowerCase() ?? "";
        aMissing = aId == null || ap === "";
        bMissing = bId == null || bp === "";
        primary = ap.localeCompare(bp);
        break;
      }
      case "source": {
        const an = a.sourceLabel.toLowerCase();
        const bn = b.sourceLabel.toLowerCase();
        aMissing = an === "";
        bMissing = bn === "";
        primary = an.localeCompare(bn);
        break;
      }
      case "signals": {
        const ar = signalsRank(a);
        const br = signalsRank(b);
        aMissing = ar == null;
        bMissing = br == null;
        primary = (ar ?? 0) - (br ?? 0);
        break;
      }
    }
    // Missing-last in BOTH directions: aMissing or bMissing → missing sorts
    // after non-missing; ties among missing or among non-missing → use the
    // direction-flipped primary.
    if (aMissing !== bMissing) {
      return aMissing ? 1 : -1;
    }
    if (primary === 0) return 0;
    return sign * primary;
  });
}

/** Cycle the sort state for a header click. */
export function cycleSort(
  current: SortState | null,
  key: SortKey,
): SortState | null {
  if (current === null || current.key !== key) {
    return { key, dir: "asc" };
  }
  if (current.dir === "asc") {
    return { key, dir: "desc" };
  }
  // current.dir === "desc" → restore default (none).
  return null;
}

/**
 * Filter a presentation list by a filter id + free-text search.
 *
 * Search matches: agent name, model display/id, provider id (part of the
 * canonical model ids), source label/path, and configured fallback ids.
 */
export type FilterId =
  | "all"
  | "overrides"
  | "runtime-drift"
  | "model-issues"
  | "disabled"
  | "custom";

export const FILTER_IDS: readonly FilterId[] = [
  "all",
  "overrides",
  "runtime-drift",
  "model-issues",
  "disabled",
  "custom",
];

export function filterAgents(
  rows: AgentPresentation[],
  filter: FilterId,
  search: string,
  catalogNames?: ReadonlyMap<string, string>,
  providerNames?: ReadonlyMap<string, string>,
): AgentPresentation[] {
  const needle = search.trim().toLowerCase();
  const modelTerms = (id?: string): string[] => {
    if (!id) return [];
    const terms = [id];
    const catalog = catalogDisplayName(id, catalogNames);
    if (catalog) terms.push(catalog);
    const provider = providerLabel(id, providerNames);
    if (provider) terms.push(provider);
    return terms;
  };
  const matchesSearch = (r: AgentPresentation): boolean => {
    if (!needle) return true;
    const hay = [
      r.name,
      r.assigned.model,
      r.effective.model,
      r.live.model,
      ...r.effective.fallbacks,
      ...modelTerms(r.assigned.model),
      ...modelTerms(r.effective.model),
      ...modelTerms(r.live.model),
      ...r.effective.fallbacks.flatMap((id) => modelTerms(id)),
      r.sourceLabel,
      r.sourceDetail,
      r.assigned.sourcePath,
      r.effective.sourcePath,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(needle);
  };
  const matchesFilter = (r: AgentPresentation): boolean => {
    switch (filter) {
      case "all":
        return true;
      case "overrides":
        // Winning source is NOT the active preset.
        return (
          r.sourceStage === "root-agent" ||
          r.sourceStage === "project-config" ||
          r.sourceStage === "user-config"
        );
      case "runtime-drift":
        return (
          r.alignment === "runtime-drift" || r.alignment === "both"
        );
      case "model-issues":
        return r.hasModelIssue;
      case "disabled":
        return r.isDisabled;
      case "custom":
        return r.isCustom;
      default:
        return true;
    }
  };
  return rows.filter((r) => matchesFilter(r) && matchesSearch(r));
}

/** Compact summary line: "14 agents · 6 outside preset · 4 runtime drift · 1 model issue". */
export function summarize(rows: AgentPresentation[]): {
  total: number;
  overrides: number;
  runtimeDrift: number;
  modelIssues: number;
} {
  let overrides = 0;
  let runtimeDrift = 0;
  let modelIssues = 0;
  for (const r of rows) {
    if (
      r.sourceStage === "root-agent" ||
      r.sourceStage === "project-config" ||
      r.sourceStage === "user-config"
    ) {
      overrides++;
    }
    if (r.alignment === "runtime-drift" || r.alignment === "both") {
      runtimeDrift++;
    }
    if (r.hasModelIssue) {
      modelIssues++;
    }
  }
  return { total: rows.length, overrides, runtimeDrift, modelIssues };
}

// ── Default roster grouping ────────────────────────────────────────
//
// Default view (no explicit sort) groups from authoritative metadata only:
// Built-in Team, Custom Agents, Disabled, Native. Disabled wins over kind.
// Unknown non-native enabled rows join Custom Agents — they are already in
// the DTO; this does not invent membership. Empty groups are omitted.

export type RosterGroupId = "builtin" | "custom" | "disabled" | "native";

export const ROSTER_GROUP_ORDER: readonly RosterGroupId[] = [
  "builtin",
  "custom",
  "disabled",
  "native",
];

export const ROSTER_GROUP_LABELS: Record<RosterGroupId, string> = {
  builtin: "Built-in Team",
  custom: "Custom Agents",
  disabled: "Disabled",
  native: "Native",
};

export interface RosterGroup {
  id: RosterGroupId;
  label: string;
  rows: AgentPresentation[];
  /** Shared source label when one value dominates the group; else undefined. */
  defaultSource?: string;
}

export function rosterGroupOf(row: AgentPresentation): RosterGroupId {
  if (row.isDisabled) return "disabled";
  if (row.kind === "native") return "native";
  if (row.isBuiltinOmo) return "builtin";
  return "custom";
}

/** Modal source label when it is shared or a clear majority. Never invented. */
export function groupDefaultSource(
  rows: readonly AgentPresentation[],
): string | undefined {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!r.sourceLabel || r.sourceLabel === "—") continue;
    counts.set(r.sourceLabel, (counts.get(r.sourceLabel) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestN = 0;
  for (const [label, n] of counts) {
    if (n > bestN) {
      best = label;
      bestN = n;
    }
  }
  if (!best || bestN < 1) return undefined;
  if (bestN === rows.length) return best;
  if (bestN >= 2 && bestN > rows.length / 2) return best;
  return undefined;
}

export function groupRoster(rows: AgentPresentation[]): RosterGroup[] {
  const buckets = new Map<RosterGroupId, AgentPresentation[]>();
  for (const id of ROSTER_GROUP_ORDER) buckets.set(id, []);
  for (const r of rows) {
    buckets.get(rosterGroupOf(r))!.push(r);
  }
  const groups: RosterGroup[] = [];
  for (const id of ROSTER_GROUP_ORDER) {
    const members = buckets.get(id)!;
    if (members.length === 0) continue;
    groups.push({
      id,
      label: ROSTER_GROUP_LABELS[id],
      rows: members,
      defaultSource: groupDefaultSource(members),
    });
  }
  return groups;
}
