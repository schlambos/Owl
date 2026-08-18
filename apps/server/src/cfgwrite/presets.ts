/**
 * Preset domain: inventory, comparison, runtime-switch simulation,
 * lifecycle mutations.
 *
 * Verified OMO behavior:
 *  - Load-time: agents = deepMerge(presetAgents, rootAgents) → root wins
 *  - Runtime /preset: agents = deepMerge(currentAgents, presetAgents) → preset wins
 *  - Runtime preset singleton is server-side in-memory, NOT exposed via API.
 *  - switchPresetOnDisk only persists preset name (applies on restart).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentCapabilitySummary,
  OmoCandidateProducer,
  ProvenanceBundle,
  ResolvedProperty,
  SchemaValidationSummary,
} from "@omo/shared";
import type { ServerConfig } from "../config";
import { assertAuthorizedPath } from "../config";
import {
  applyJsoncPathEdit,
  getAtPath,
  parseConfigText,
} from "./jsonc-edit";
import { assertSafeWritePath, resolveWriteTarget } from "./paths";
import type { RevisionStore } from "./revisions";
import {
  expectedSourceFromHash,
  fingerprintScope,
  previewThenCommit,
  type OmoTransactionDeps,
} from "./transaction";
import {
  buildAgentCapabilitySummary,
  KNOWN_TOOLS,
} from "../omo/capabilities";

const AGENT_FIELDS = [
  "model",
  "temperature",
  "variant",
  "skills",
  "mcps",
  "prompt",
  "orchestratorPrompt",
  "options",
  "displayName",
  "description",
  "permission",
] as const;

type AgentField = (typeof AGENT_FIELDS)[number];

export interface PresetAgentRow {
  agent: string;
  presetValue: Record<string, unknown>;
  rootOverride?: Record<string, unknown>;
  maskedFields: string[];
  /** Fields runtime switch would force to preset value */
  runtimeSwitchWouldChange: string[];
  capabilities: AgentCapabilitySummary;
}

export interface PresetSummary {
  name: string;
  sourceScopes: Array<"user" | "project">;
  configuredActive: boolean;
  runtimeActive: boolean | null;
  runtimeStateKnown: boolean;
  agentCount: number;
  customAgents: string[];
  definedAgents: string[];
  maskedFieldCount: number;
  warnings: string[];
  agents: PresetAgentRow[];
  raw: Record<string, unknown>;
}

export interface PresetInventory {
  presets: PresetSummary[];
  configuredPreset?: string;
  envPreset?: string;
  effectiveStartupPreset?: string;
  runtimePreset: {
    known: boolean;
    name: string | null;
    mechanism: string;
  };
  warnings: string[];
}

export interface PresetCompareResult {
  a: string;
  b: string;
  mode: "desired" | "load-effective" | "runtime-switch";
  rows: Array<{
    agent: string;
    field: string;
    aValue: unknown;
    bValue: unknown;
    equal: boolean;
  }>;
  changedCount: number;
  sameCount: number;
  capabilityChanges: string[];
  promptChanges: string[];
}

function deepMerge(
  base?: Record<string, unknown>,
  override?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!base) return override;
  if (!override) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const bv = base[k];
    if (
      v && typeof v === "object" && !Array.isArray(v) &&
      bv && typeof bv === "object" && !Array.isArray(bv)
    ) {
      out[k] = deepMerge(
        bv as Record<string, unknown>,
        v as Record<string, unknown>,
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}

function loadRawConfig(cfg: ServerConfig, scope: "user" | "project"): {
  obj: Record<string, unknown>;
  path: string | null;
} {
  const t = resolveWriteTarget(cfg, scope);
  if (!t.exists) return { obj: {}, path: null };
  try {
    assertSafeWritePath(t.path, cfg.authorizedRoots);
    return { obj: parseConfigText(readFileSync(t.path, "utf-8")), path: t.path };
  } catch {
    return { obj: {}, path: t.path };
  }
}

function mergedDesiredPreset(
  userObj: Record<string, unknown>,
  projectObj: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  const userPresets = (userObj.presets ?? {}) as Record<string, unknown>;
  const projectPresets = (projectObj.presets ?? {}) as Record<string, unknown>;
  const u = userPresets[name] as Record<string, unknown> | undefined;
  const p = projectPresets[name] as Record<string, unknown> | undefined;
  if (!u && !p) return {};
  return (deepMerge(u ?? {}, p ?? {}) ?? {}) as Record<string, unknown>;
}

function presetSourceScopes(
  userObj: Record<string, unknown>,
  projectObj: Record<string, unknown>,
  name: string,
): Array<"user" | "project"> {
  const out: Array<"user" | "project"> = [];
  const u = (userObj.presets as Record<string, unknown> | undefined)?.[name];
  const p = (projectObj.presets as Record<string, unknown> | undefined)?.[name];
  if (u !== undefined) out.push("user");
  if (p !== undefined) out.push("project");
  return out;
}

function rootAgentsMerged(
  userObj: Record<string, unknown>,
  projectObj: Record<string, unknown>,
): Record<string, unknown> {
  const u = (userObj.agents ?? {}) as Record<string, unknown>;
  const p = (projectObj.agents ?? {}) as Record<string, unknown>;
  return (deepMerge(u, p) ?? {}) as Record<string, unknown>;
}

const DEFAULT_SKILL_NAMES: string[] = [];

export function buildPresetInventory(
  cfg: ServerConfig,
  provenance: ProvenanceBundle,
  inventory: {
    skillNames: string[];
    mcpNames: string[];
    disabled_skills: string[];
    disabled_mcps: string[];
  },
): PresetInventory {
  const { obj: userObj } = loadRawConfig(cfg, "user");
  const { obj: projectObj } = loadRawConfig(cfg, "project");
  const warnings: string[] = [];

  const presetNames = new Set<string>([
    ...Object.keys((userObj.presets as Record<string, unknown>) ?? {}),
    ...Object.keys((projectObj.presets as Record<string, unknown>) ?? {}),
  ]);

  const filePreset =
    typeof userObj.preset === "string"
      ? (userObj.preset as string)
      : typeof projectObj.preset === "string"
        ? (projectObj.preset as string)
        : undefined;
  const configuredPreset = provenance.filePreset ?? filePreset;
  const envPreset = provenance.envPreset;
  const effectiveStartupPreset = provenance.preset;
  const rootMerged = rootAgentsMerged(userObj, projectObj);

  if (envPreset && configuredPreset && envPreset !== configuredPreset) {
    warnings.push(
      `OH_MY_OPENCODE_SLIM_PRESET="${envPreset}" overrides configured preset "${configuredPreset}"`,
    );
  }

  const presets: PresetSummary[] = [...presetNames].sort().map((name) => {
    const rawPreset = mergedDesiredPreset(userObj, projectObj, name);
    const scopes = presetSourceScopes(userObj, projectObj, name);
    const agents = Object.keys(rawPreset).sort();
    const customAgents = agents.filter(
      (a) => !provenance.agents[a] || provenance.agents[a]!.kind === "custom",
    );

    const rows: PresetAgentRow[] = agents.map((agent) => {
      const presetValue = (rawPreset[agent] ?? {}) as Record<string, unknown>;
      const rootOverride = rootMerged[agent] as
        | Record<string, unknown>
        | undefined;

      const maskedFields: string[] = [];
      const runtimeSwitchWouldChange: string[] = [];
      for (const f of AGENT_FIELDS) {
        const pv = presetValue[f];
        const rv = rootOverride?.[f];
        if (pv === undefined) continue;
        if (rv !== undefined && JSON.stringify(rv) !== JSON.stringify(pv)) {
          // load-time root wins
          maskedFields.push(f);
          // runtime preset wins → change
          runtimeSwitchWouldChange.push(f);
        }
      }

      const capabilities = buildAgentCapabilitySummary(
        agent,
        {
          temperature:
            typeof presetValue.temperature === "number"
              ? presetValue.temperature
              : undefined,
          skills: Array.isArray(presetValue.skills)
            ? (presetValue.skills as string[])
            : undefined,
          mcps: Array.isArray(presetValue.mcps)
            ? (presetValue.mcps as string[])
            : undefined,
          permission: presetValue.permission as never,
        },
        {
          skillNames: inventory.skillNames,
          mcpNames: inventory.mcpNames,
          disabled_skills: inventory.disabled_skills,
          disabled_mcps: inventory.disabled_mcps,
        },
      );

      return {
        agent,
        presetValue,
        rootOverride,
        maskedFields,
        runtimeSwitchWouldChange,
        capabilities,
      };
    });

    const maskedFieldCount = rows.reduce(
      (acc, r) => acc + r.maskedFields.length,
      0,
    );

    return {
      name,
      sourceScopes: scopes,
      configuredActive: configuredPreset === name,
      runtimeActive: null,
      runtimeStateKnown: false,
      agentCount: agents.length,
      customAgents,
      definedAgents: agents,
      maskedFieldCount,
      warnings:
        maskedFieldCount > 0
          ? [`${maskedFieldCount} field(s) masked by root overrides`]
          : [],
      agents: rows,
      raw: rawPreset,
    };
  });

  return {
    presets,
    configuredPreset,
    envPreset,
    effectiveStartupPreset,
    runtimePreset: {
      known: false,
      name: null,
      mechanism:
        "OMO runtime preset is server-side in-memory (setActiveRuntimePreset) and not exposed via OpenCode API. TUI /preset writes preset name to disk via switchPresetOnDisk; applies on restart. No programmatic runtime activation endpoint exists.",
    },
    warnings,
  };
}

// ── Comparison ───────────────────────────────────────────────────────

function presetAgentMap(preset: Record<string, unknown>) {
  return preset;
}

export function comparePresets(
  cfg: ServerConfig,
  provenance: ProvenanceBundle,
  a: string,
  b: string,
  mode: PresetCompareResult["mode"] = "desired",
): PresetCompareResult {
  const { obj: userObj } = loadRawConfig(cfg, "user");
  const { obj: projectObj } = loadRawConfig(cfg, "project");
  const rootMerged = rootAgentsMerged(userObj, projectObj);

  const presetA = mergedDesiredPreset(userObj, projectObj, a);
  const presetB = mergedDesiredPreset(userObj, projectObj, b);

  const resolveForMode = (
    preset: Record<string, unknown>,
  ): Record<string, Record<string, unknown>> => {
    if (mode === "desired") {
      return preset as Record<string, Record<string, unknown>>;
    }
    if (mode === "load-effective") {
      return (deepMerge(preset, rootMerged) ?? {}) as Record<
        string,
        Record<string, unknown>
      >;
    }
    // runtime-switch: deepMerge(currentAgents≈rootMerged-as-current, preset)
    return (deepMerge(rootMerged, preset) ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
  };

  const effA = resolveForMode(presetA);
  const effB = resolveForMode(presetB);

  const agents = new Set<string>([
    ...Object.keys(effA),
    ...Object.keys(effB),
    ...Object.keys(rootMerged),
  ]);

  const rows: PresetCompareResult["rows"] = [];
  for (const agent of agents) {
    for (const f of AGENT_FIELDS) {
      const av = effA[agent]?.[f];
      const bv = effB[agent]?.[f];
      if (av === undefined && bv === undefined) continue;
      const equal = JSON.stringify(av) === JSON.stringify(bv);
      if (!equal) {
        rows.push({
          agent,
          field: f,
          aValue: av,
          bValue: bv,
          equal,
        });
      }
    }
  }

  const capabilityChanges: string[] = [];
  const promptChanges: string[] = [];

  const changedCount = rows.length;
  const allFields = agents.size * AGENT_FIELDS.length;
  const sameCount = Math.max(0, allFields - changedCount);

  return {
    a,
    b,
    mode,
    rows,
    changedCount,
    sameCount,
    capabilityChanges,
    promptChanges,
  };
}

/** Runtime switch impact: deepMerge(rootMerged, preset) vs load-effective */
export function runtimeSwitchImpact(
  cfg: ServerConfig,
  provenance: ProvenanceBundle,
  presetName: string,
): Array<{ agent: string; field: string; before: unknown; after: unknown }> {
  const { obj: userObj } = loadRawConfig(cfg, "user");
  const { obj: projectObj } = loadRawConfig(cfg, "project");
  const rootMerged = rootAgentsMerged(userObj, projectObj);
  const preset = mergedDesiredPreset(userObj, projectObj, presetName);

  const loadEffective = (deepMerge(preset, rootMerged) ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const runtimeEffective = (deepMerge(rootMerged, preset) ?? {}) as Record<
    string,
    Record<string, unknown>
  >;

  const agents = new Set([
    ...Object.keys(loadEffective),
    ...Object.keys(runtimeEffective),
  ]);
  const out: Array<{
    agent: string;
    field: string;
    before: unknown;
    after: unknown;
  }> = [];
  for (const agent of agents) {
    for (const f of AGENT_FIELDS) {
      const before = loadEffective[agent]?.[f];
      const after = runtimeEffective[agent]?.[f];
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        out.push({ agent, field: f, before, after });
      }
    }
  }
  return out;
}

// ── Lifecycle mutations ──────────────────────────────────────────────

export interface PresetMutationResult {
  ok: boolean;
  errors: string[];
  revisionId?: string;
  targetPath?: string;
  textDiff?: string;
  warnings?: string[];
  /** Installed-schema gate result for the full candidate document. */
  schemaValidation?: SchemaValidationSummary;
}

function validPresetName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name) && name !== "." && name !== "..";
}

interface PresetProducerInput {
  edits: Array<{ path: (string | number)[]; value: unknown }>;
  revision: { kind: string; agent?: string; property?: string };
}

export const producePresetCandidate: OmoCandidateProducer<PresetProducerInput> = (
  input,
) => {
  let afterText = input.beforeText;
  const errors: string[] = [];
  try {
    for (const e of input.input.edits) {
      afterText = applyJsoncPathEdit(afterText, e.path, e.value);
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
  return {
    candidateText: afterText,
    featureErrors: errors,
    featureWarnings: [],
    intent: {
      kind: input.input.revision.kind,
      summary: input.input.revision.kind,
      propertyPaths: input.input.edits.map((e) => e.path.join(".")),
      mutationJson: JSON.stringify(
        input.input.edits.map((e) => ({ path: e.path, value: e.value })),
      ),
      agent: input.input.revision.agent,
      property: input.input.revision.property,
    },
  };
};

function applyPresetEdit(
  cfg: ServerConfig,
  scope: "user" | "project",
  edits: Array<{ path: (string | number)[]; value: unknown }>,
  revision: {
    kind: string;
    agent?: string;
    property?: string;
  },
  revisions: RevisionStore,
  expectedHash?: string,
): PresetMutationResult {
  const deps: OmoTransactionDeps = { cfg, revisions };
  const live = fingerprintScope(deps, scope);
  const commit = previewThenCommit(
    deps,
    {
      scope,
      expectedSource: expectedSourceFromHash(live, expectedHash),
      input: { edits, revision },
    },
    producePresetCandidate,
  );
  if (!commit.ok) {
    return {
      ok: false,
      errors:
        commit.code === "stale-source"
          ? ["CONFIGURATION CHANGED EXTERNALLY"]
          : commit.errors,
      schemaValidation: commit.preview.schemaValidation,
    };
  }
  return {
    ok: true,
    errors: [],
    revisionId: commit.revisionId,
    targetPath: commit.preview.target.path,
    textDiff: commit.preview.textDiff?.text,
    schemaValidation: commit.preview.schemaValidation,
  };
}

export function createPreset(
  cfg: ServerConfig,
  revisions: RevisionStore,
  opts: {
    scope: "user" | "project";
    name: string;
    initial:
      | { mode: "empty" }
      | { mode: "clone"; sourcePreset: string; sourceScope?: "user" | "project" };
    expectedSourceHash?: string;
  },
): PresetMutationResult {
  if (!validPresetName(opts.name)) {
    return { ok: false, errors: [`Invalid preset name: ${opts.name}`] };
  }

  let value: Record<string, unknown> = {};
  if (opts.initial.mode === "clone") {
    // Desired preset content only (not effective)
    const srcScope = opts.initial.sourceScope ?? opts.scope;
    const { obj } = loadRawConfig(cfg, srcScope);
    const src = ((obj.presets as Record<string, unknown> | undefined) ?? {})[
      opts.initial.sourcePreset
    ] as Record<string, unknown> | undefined;
    if (!src) {
      return {
        ok: false,
        errors: [`Source preset not found in ${srcScope}: ${opts.initial.sourcePreset}`],
      };
    }
    value = JSON.parse(JSON.stringify(src)) as Record<string, unknown>;
  }

  const current = loadRawConfig(cfg, opts.scope);
  if (
    ((current.obj.presets as Record<string, unknown> | undefined) ?? {})[
      opts.name
    ] !== undefined
  ) {
    return { ok: false, errors: [`Preset already exists: ${opts.name}`] };
  }

  return applyPresetEdit(
    cfg,
    opts.scope,
    [{ path: ["presets", opts.name], value }],
    { kind: opts.initial.mode === "clone" ? "preset-clone" : "preset-create", property: opts.name },
    revisions,
    opts.expectedSourceHash,
  );
}

export function renamePreset(
  cfg: ServerConfig,
  revisions: RevisionStore,
  opts: {
    scope: "user" | "project";
    oldName: string;
    newName: string;
    updateConfigured: boolean;
    expectedSourceHash?: string;
  },
): PresetMutationResult {
  if (!validPresetName(opts.newName)) {
    return { ok: false, errors: [`Invalid new preset name: ${opts.newName}`] };
  }
  const { obj } = loadRawConfig(cfg, opts.scope);
  const presets = (obj.presets as Record<string, unknown> | undefined) ?? {};
  const existing = presets[opts.oldName];
  if (existing === undefined) {
    return { ok: false, errors: [`Preset not found: ${opts.oldName}`] };
  }
  if (presets[opts.newName] !== undefined) {
    return { ok: false, errors: [`Target preset exists: ${opts.newName}`] };
  }

  // Prompt directory awareness: rename only allowed when no preset prompt dir exists
  const promptDirCandidates = [
    join(cfg.opencodeConfigDir, "oh-my-opencode-slim", opts.oldName),
    join(cfg.projectDirectory, ".opencode", "oh-my-opencode-slim", opts.oldName),
  ];
  for (const dir of promptDirCandidates) {
    try {
      assertAuthorizedPath(dir, cfg.authorizedRoots);
      if (existsSync(dir)) {
        return {
          ok: false,
          errors: [
            `Prompt directory exists for preset "${opts.oldName}": ${dir}. ` +
              "Rename with prompt-dir rename is deferred in Slice 8 (transactional multi-resource).",
          ],
        };
      }
    } catch {
      /* out of scope or missing */
    }
  }

  const edits: Array<{ path: (string | number)[]; value: unknown }> = [
    { path: ["presets", opts.newName], value: existing },
    { path: ["presets", opts.oldName], value: undefined },
  ];
  if (opts.updateConfigured && obj.preset === opts.oldName) {
    edits.push({ path: ["preset"], value: opts.newName });
  }

  return applyPresetEdit(
    cfg,
    opts.scope,
    edits,
    { kind: "preset-rename", property: `${opts.oldName}→${opts.newName}` },
    revisions,
    opts.expectedSourceHash,
  );
}

export function deletePreset(
  cfg: ServerConfig,
  revisions: RevisionStore,
  opts: {
    scope: "user" | "project";
    name: string;
    expectedSourceHash?: string;
    forceActive?: boolean;
  },
): PresetMutationResult {
  const { obj } = loadRawConfig(cfg, opts.scope);
  const presets = (obj.presets as Record<string, unknown> | undefined) ?? {};
  if (presets[opts.name] === undefined) {
    return { ok: false, errors: [`Preset not found in ${opts.scope}: ${opts.name}`] };
  }
  const configured = obj.preset;
  if (configured === opts.name && !opts.forceActive) {
    return {
      ok: false,
      errors: [
        `Preset "${opts.name}" is the configured active preset in ${opts.scope}. Change preset or pass forceActive.`,
      ],
    };
  }

  return applyPresetEdit(
    cfg,
    opts.scope,
    [{ path: ["presets", opts.name], value: undefined }],
    { kind: "preset-delete", property: opts.name },
    revisions,
    opts.expectedSourceHash,
  );
}

export function setConfiguredPreset(
  cfg: ServerConfig,
  revisions: RevisionStore,
  opts: {
    scope: "user" | "project";
    value: string | null;
    expectedSourceHash?: string;
  },
): PresetMutationResult {
  if (opts.value !== null && !validPresetName(opts.value)) {
    return { ok: false, errors: [`Invalid preset name: ${opts.value}`] };
  }
  return applyPresetEdit(
    cfg,
    opts.scope,
    [{ path: ["preset"], value: opts.value === null ? undefined : opts.value }],
    { kind: "configured-preset", property: opts.value ?? "(removed)" },
    revisions,
    opts.expectedSourceHash,
  );
}
