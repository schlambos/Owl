/**
 * Field-level OMO configuration provenance + prompt discovery.
 * Merge/prompt rules verified against oh-my-opencode-slim@2.2.10 dist.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import type {
  ConfigSource,
  ConfigSourceInventoryItem,
  ConfigWarning,
  EffectiveAgent,
  EffectivePrompt,
  PropertyCandidate,
  ProvenanceBundle,
  ProvenanceEntry,
  ResolvedProperty,
  ResolveStage,
} from "@omo/shared";
import { BUILTIN_OMO_AGENTS, PROTECTED_AGENTS } from "@omo/shared";
import { assertAuthorizedPath } from "../config";

const BUILTIN_SET = new Set<string>(BUILTIN_OMO_AGENTS);
const PROMPTS_DIR = "oh-my-opencode-slim";

const TOP_LEVEL_KEYS = [
  "preset",
  "setDefaultAgent",
  "compactSidebar",
  "stripOrchestratorModel",
  "autoUpdate",
  "presets",
  "agents",
  "disabled_agents",
  "image_routing",
  "disabled_mcps",
  "disabled_tools",
  "disabled_skills",
  "multiplexer",
  "interview",
  "backgroundJobs",
  "fallback",
  "council",
  "companion",
  "webfetch",
  "acpAgents",
] as const;

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

export interface VirtualOmoSource {
  text: string;
  document: Record<string, unknown>;
  format: "json" | "jsonc";
  path: string;
  exists: boolean;
  hash?: string;
}

export interface ProvenanceOptions {
  opencodeConfigDir: string;
  projectDirectory: string;
  authorizedRoots: string[];
  /** Include full prompt file contents in response */
  includePromptText?: boolean;
  env?: NodeJS.ProcessEnv;
  /**
   * In-memory user/project documents for Preview (Slice 18 D1).
   * When present, that scope is resolved from the overlay instead of disk.
   * Invalid sibling disk sources are skipped with a warning so the selected
   * source can still be repaired.
   */
  virtualSources?: {
    user?: VirtualOmoSource;
    project?: VirtualOmoSource;
  };
}

// ── FS helpers ───────────────────────────────────────────────────────

function findConfigPath(basePath: string, roots: string[]): string | null {
  for (const candidate of [`${basePath}.jsonc`, `${basePath}.json`]) {
    try {
      assertAuthorizedPath(candidate, roots);
    } catch {
      continue;
    }
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function readJsoncFile(
  path: string,
  scope: ConfigSource["scope"],
  roots: string[],
): { source: ConfigSource; data: Record<string, unknown> } | null {
  assertAuthorizedPath(path, roots);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf-8");
  const errors: unknown[] = [];
  const data = parseJsonc(content, errors as never, { allowTrailingComma: true });
  if (errors.length || !data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`Failed to parse ${path}`);
  }
  const st = statSync(path);
  return {
    source: {
      id: `${scope}:${path}`,
      scope,
      path,
      format: path.endsWith(".jsonc") ? "jsonc" : "json",
      hash: createHash("sha256").update(content).digest("hex").slice(0, 16),
      mtimeMs: st.mtimeMs,
    },
    data: data as Record<string, unknown>,
  };
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
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      bv &&
      typeof bv === "object" &&
      !Array.isArray(bv)
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

function mergePluginConfigs(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...base,
    ...override,
    agents: deepMerge(
      base.agents as Record<string, unknown> | undefined,
      override.agents as Record<string, unknown> | undefined,
    ),
    presets: deepMerge(
      base.presets as Record<string, unknown> | undefined,
      override.presets as Record<string, unknown> | undefined,
    ),
    multiplexer: deepMerge(
      base.multiplexer as Record<string, unknown> | undefined,
      override.multiplexer as Record<string, unknown> | undefined,
    ),
    interview: deepMerge(
      base.interview as Record<string, unknown> | undefined,
      override.interview as Record<string, unknown> | undefined,
    ),
    backgroundJobs: deepMerge(
      base.backgroundJobs as Record<string, unknown> | undefined,
      override.backgroundJobs as Record<string, unknown> | undefined,
    ),
    fallback: deepMerge(
      base.fallback as Record<string, unknown> | undefined,
      override.fallback as Record<string, unknown> | undefined,
    ),
    council: deepMerge(
      base.council as Record<string, unknown> | undefined,
      override.council as Record<string, unknown> | undefined,
    ),
    webfetch: deepMerge(
      base.webfetch as Record<string, unknown> | undefined,
      override.webfetch as Record<string, unknown> | undefined,
    ),
    acpAgents: deepMerge(
      base.acpAgents as Record<string, unknown> | undefined,
      override.acpAgents as Record<string, unknown> | undefined,
    ),
    companion: deepMerge(
      base.companion as Record<string, unknown> | undefined,
      override.companion as Record<string, unknown> | undefined,
    ),
  };
}

// ── Leaf provenance tracking during merge ────────────────────────────

type LeafMap = Map<string, PropertyCandidate[]>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Collect all leaf paths from an object with a candidate at each leaf. */
function collectLeaves(
  obj: unknown,
  prefix: string,
  candidateBase: Omit<PropertyCandidate, "value" | "sourcePath"> & {
    sourcePathPrefix?: string;
  },
  out: LeafMap,
): void {
  const sp = candidateBase.sourcePathPrefix
    ? candidateBase.sourcePathPrefix + (prefix ? "." + prefix : "")
    : prefix;

  if (obj === undefined) return;

  if (Array.isArray(obj) || !isPlainObject(obj)) {
    const path = prefix;
    if (!path) return;
    const c: PropertyCandidate = {
      value: obj,
      sourceId: candidateBase.sourceId,
      sourceLabel: candidateBase.sourceLabel,
      sourcePath: sp || path,
      stage: candidateBase.stage,
      order: candidateBase.order,
      scope: candidateBase.scope,
      filePath: candidateBase.filePath,
    };
    const list = out.get(path) ?? [];
    list.push(c);
    out.set(path, list);
    return;
  }

  for (const [k, v] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v) || !isPlainObject(v)) {
      const c: PropertyCandidate = {
        value: v,
        sourceId: candidateBase.sourceId,
        sourceLabel: candidateBase.sourceLabel,
        sourcePath: candidateBase.sourcePathPrefix
          ? `${candidateBase.sourcePathPrefix}.${next}`
          : next,
        stage: candidateBase.stage,
        order: candidateBase.order,
        scope: candidateBase.scope,
        filePath: candidateBase.filePath,
      };
      const list = out.get(next) ?? [];
      list.push(c);
      out.set(next, list);
    } else {
      collectLeaves(v, next, candidateBase, out);
    }
  }
}

function resolveLeaves(leaves: LeafMap): Record<string, ResolvedProperty> {
  const props: Record<string, ResolvedProperty> = {};
  for (const [path, candidates] of leaves) {
    // Higher order wins (later stages)
    const sorted = [...candidates].sort((a, b) => a.order - b.order);
    const winner = sorted[sorted.length - 1]!;
    const overridden = sorted.slice(0, -1).reverse();
    const arrayReplaced =
      Array.isArray(winner.value) &&
      overridden.some((o) => Array.isArray(o.value));

    let reason = `${winner.stage} wins`;
    if (overridden.length === 0) {
      reason = `Only source: ${winner.stage} (${winner.sourcePath})`;
    } else if (winner.stage === "root-agent" && overridden.some((o) => o.stage === "preset")) {
      reason =
        "Root agents.<name> overrides preset during load-time deepMerge(preset, rootAgents)";
    } else if (winner.stage === "project-config") {
      reason = "Project config deep-merges over user (nested objects merge; arrays replace)";
    } else if (winner.stage === "env") {
      reason = "Environment variable overrides file value";
    } else if (arrayReplaced) {
      reason = `Array replaced by ${winner.stage} (OMO does not element-merge arrays)`;
    } else {
      reason = `${winner.stage} overrides prior candidates at load-time merge`;
    }

    props[path] = {
      path,
      value: winner.value,
      winner,
      overridden,
      reason,
      arrayReplaced,
    };
  }
  return props;
}

// ── Prompt discovery ─────────────────────────────────────────────────

interface PromptFileHit {
  path: string;
  scope: "user" | "project";
  preset?: string;
  kind: "replacement-file" | "append-file";
  rank: number;
  content: string;
}

/**
 * Search order matches loadAgentPrompt (first existing file wins per kind):
 * 1. project/.opencode/oh-my-opencode-slim/{preset}/
 * 2. project/.opencode/oh-my-opencode-slim/
 * 3. user/{preset}/
 * 4. user/
 */
function promptSearchDirs(
  opencodeConfigDir: string,
  projectDirectory: string,
  preset: string | undefined,
  roots: string[],
): Array<{ dir: string; scope: "user" | "project"; preset?: string; rank: number }> {
  const dirs: Array<{
    dir: string;
    scope: "user" | "project";
    preset?: string;
    rank: number;
  }> = [];
  let rank = 0;
  const safePreset =
    preset && /^[a-zA-Z0-9_-]+$/.test(preset) ? preset : undefined;

  const tryAdd = (dir: string, scope: "user" | "project", p?: string) => {
    try {
      assertAuthorizedPath(dir, roots);
      dirs.push({ dir, scope, preset: p, rank: rank++ });
    } catch {
      /* out of scope */
    }
  };

  if (safePreset) {
    tryAdd(
      join(projectDirectory, ".opencode", PROMPTS_DIR, safePreset),
      "project",
      safePreset,
    );
  }
  tryAdd(join(projectDirectory, ".opencode", PROMPTS_DIR), "project");
  if (safePreset) {
    tryAdd(join(opencodeConfigDir, PROMPTS_DIR, safePreset), "user", safePreset);
  }
  tryAdd(join(opencodeConfigDir, PROMPTS_DIR), "user");
  return dirs;
}

function discoverPromptFiles(
  agentName: string,
  dirs: ReturnType<typeof promptSearchDirs>,
  roots: string[],
  includeText: boolean,
): { replacement?: PromptFileHit; append?: PromptFileHit; all: PromptFileHit[] } {
  const all: PromptFileHit[] = [];
  let replacement: PromptFileHit | undefined;
  let append: PromptFileHit | undefined;

  for (const d of dirs) {
    for (const [file, kind] of [
      [`${agentName}.md`, "replacement-file"],
      [`${agentName}_append.md`, "append-file"],
    ] as const) {
      const path = join(d.dir, file);
      try {
        assertAuthorizedPath(path, roots);
      } catch {
        continue;
      }
      if (!existsSync(path)) continue;
      let content = "";
      try {
        content = readFileSync(path, "utf-8");
      } catch {
        continue;
      }
      const hit: PromptFileHit = {
        path,
        scope: d.scope,
        preset: d.preset,
        kind,
        rank: d.rank,
        content: includeText ? content : "",
      };
      // store length even without full text
      if (!includeText) {
        hit.content = content; // still need for composition; strip later if needed
      }
      all.push(hit);
      if (kind === "replacement-file" && !replacement) replacement = hit;
      if (kind === "append-file" && !append) append = hit;
    }
  }
  return { replacement, append, all };
}

/**
 * Verified resolvePrompt(agent, inline, filePrompt, fallback, append):
 * effectiveBase = inline ?? filePrompt ?? fallback
 * result = append ? base + "\n\n" + append : base
 * Inline OVERRIDES file replacement (with console warn in OMO).
 */
export function composePrompt(opts: {
  agent: string;
  inline?: string;
  fileReplacement?: PromptFileHit;
  fileAppend?: PromptFileHit;
  allHits: PromptFileHit[];
  includeText: boolean;
}): EffectivePrompt {
  const warnings: string[] = [];
  const sources: EffectivePrompt["sources"] = [];

  // Document all found files
  for (const h of opts.allHits) {
    const isWinner =
      (h.kind === "replacement-file" && h.path === opts.fileReplacement?.path) ||
      (h.kind === "append-file" && h.path === opts.fileAppend?.path);
    let applied = isWinner;
    let reason: string | undefined;
    if (h.kind === "replacement-file") {
      if (opts.inline !== undefined) {
        applied = false;
        reason =
          "Not applied as base: inline agents.<name>.prompt overrides file replacement (resolvePrompt)";
        if (isWinner) {
          warnings.push(
            `Inline prompt overrides replacement file ${h.path}`,
          );
        }
      } else if (isWinner) {
        reason = "First matching replacement file in OMO search order";
        applied = true;
      } else {
        reason = "Shadowed by higher-priority replacement file in search order";
        applied = false;
      }
    } else {
      // append
      if (isWinner) {
        reason = "First matching append file; always concatenated after base";
        applied = true;
      } else {
        reason = "Shadowed by higher-priority append file in search order";
        applied = false;
      }
    }
    sources.push({
      kind: h.kind,
      scope: h.scope,
      preset: h.preset,
      path: h.path,
      content: opts.includeText ? h.content : undefined,
      contentLength: h.content.length,
      applied,
      reason,
      rank: h.rank,
    });
  }

  let baseSource: EffectivePrompt["baseSource"];
  if (opts.inline !== undefined) {
    baseSource = {
      kind: "inline",
      scope: "inline",
      content: opts.includeText ? opts.inline : undefined,
      contentLength: opts.inline.length,
      applied: true,
      reason: "Inline agents.<name>.prompt (wins over file replacement)",
    };
    sources.unshift(baseSource);
  } else if (opts.fileReplacement) {
    baseSource = {
      kind: "replacement-file",
      scope: opts.fileReplacement.scope,
      preset: opts.fileReplacement.preset,
      path: opts.fileReplacement.path,
      content: opts.includeText ? opts.fileReplacement.content : undefined,
      contentLength: opts.fileReplacement.content.length,
      applied: true,
      reason: "File replacement selected as base (no inline prompt)",
    };
  } else {
    baseSource = {
      kind: "builtin",
      scope: "builtin",
      applied: true,
      reason: "Built-in OMO agent prompt (not inlined in control plane)",
    };
    sources.unshift(baseSource);
  }

  const appendSources = sources.filter(
    (s) => s.kind === "append-file" && s.applied,
  );

  let effectiveText: string | undefined;
  if (opts.includeText) {
    const baseText =
      opts.inline ??
      opts.fileReplacement?.content ??
      "[built-in OMO prompt — not extracted from package in this slice]";
    effectiveText = opts.fileAppend
      ? `${baseText}\n\n${opts.fileAppend.content}`
      : baseText;
  }

  return {
    agent: opts.agent,
    sources,
    baseSource,
    appendSources,
    effectiveText,
    compositionRule:
      "resolvePrompt: base = inline ?? fileReplacement ?? builtin; then if append: base + '\\n\\n' + append. Inline overrides file.",
    warnings,
  };
}

// ── Main resolve ─────────────────────────────────────────────────────

export function resolveProvenance(opts: ProvenanceOptions): ProvenanceBundle {
  const env = opts.env ?? process.env;
  const roots = opts.authorizedRoots;
  const warnings: ConfigWarning[] = [];
  const leaves: LeafMap = new Map();

  const userPath = findConfigPath(
    join(opts.opencodeConfigDir, "oh-my-opencode-slim"),
    roots,
  );
  const projectPath = findConfigPath(
    join(opts.projectDirectory, ".opencode", "oh-my-opencode-slim"),
    roots,
  );

  // Project path may be "authorized" but missing — also detect out-of-scope project
  let projectOutOfScope = false;
  try {
    assertAuthorizedPath(
      join(opts.projectDirectory, ".opencode"),
      roots,
    );
  } catch {
    projectOutOfScope = true;
    warnings.push({
      level: "warning",
      kind: "project-out-of-scope",
      message:
        "Project directory is outside authorized filesystem roots; project OMO config cannot be read.",
      path: opts.projectDirectory,
    });
  }

  let userData: Record<string, unknown> = {};
  let projectData: Record<string, unknown> = {};
  let userSource: ConfigSource | null = null;
  let projectSource: ConfigSource | null = null;

  const loadScope = (
    scope: "user" | "project",
    diskPath: string | null,
    virtual: VirtualOmoSource | undefined,
    order: number,
    stage: ResolveStage,
  ): { source: ConfigSource | null; data: Record<string, unknown> } => {
    if (virtual) {
      if (!virtual.exists) return { source: null, data: {} };
      const source: ConfigSource = {
        id: `${scope}:${virtual.path}`,
        scope,
        path: virtual.path,
        format: virtual.format,
        hash: (virtual.hash ?? createHash("sha256").update(virtual.text).digest("hex")).slice(0, 16),
      };
      collectLeaves(virtual.document, "", {
        sourceId: source.id,
        sourceLabel: source.path ?? source.id,
        stage,
        order,
        scope,
        filePath: source.path,
        sourcePathPrefix: "",
      }, leaves);
      return { source, data: virtual.document };
    }
    if (!diskPath) return { source: null, data: {} };
    try {
      const loaded = readJsoncFile(diskPath, scope, roots);
      if (!loaded) return { source: null, data: {} };
      collectLeaves(loaded.data, "", {
        sourceId: loaded.source.id,
        sourceLabel: loaded.source.path ?? loaded.source.id,
        stage,
        order,
        scope,
        filePath: loaded.source.path,
        sourcePathPrefix: "",
      }, leaves);
      return { source: loaded.source, data: loaded.data };
    } catch (e) {
      warnings.push({
        level: "warning",
        kind: "source-unreadable",
        message: `Could not parse ${scope} OMO source for virtual resolution: ${
          e instanceof Error ? e.message : String(e)
        }`,
        path: diskPath,
      });
      return { source: null, data: {} };
    }
  };

  const userLoaded = loadScope(
    "user",
    userPath,
    opts.virtualSources?.user,
    10,
    "user-config",
  );
  userSource = userLoaded.source;
  userData = userLoaded.data;

  if (!projectOutOfScope) {
    const projectLoaded = loadScope(
      "project",
      projectPath,
      opts.virtualSources?.project,
      20,
      "project-config",
    );
    projectSource = projectLoaded.source;
    projectData = projectLoaded.data;
  }

  const virtualUserExists = opts.virtualSources?.user?.exists === true;
  const virtualProjectExists = opts.virtualSources?.project?.exists === true;
  let merged = userPath || virtualUserExists ? { ...userData } : {};
  if ((projectPath || virtualProjectExists) && Object.keys(projectData).length) {
    merged = mergePluginConfigs(merged, projectData);
  }

  const filePreset =
    typeof merged.preset === "string" ? merged.preset : undefined;
  const envPreset = env.OH_MY_OPENCODE_SLIM_PRESET?.trim() || undefined;
  let activePreset = filePreset;

  if (envPreset) {
    activePreset = envPreset;
    const list = leaves.get("preset") ?? [];
    list.push({
      value: envPreset,
      sourceId: "env:OH_MY_OPENCODE_SLIM_PRESET",
      sourceLabel: "OH_MY_OPENCODE_SLIM_PRESET",
      sourcePath: "OH_MY_OPENCODE_SLIM_PRESET",
      stage: "env",
      order: 30,
      scope: "env",
      filePath: null,
    });
    leaves.set("preset", list);
    merged = { ...merged, preset: envPreset };
    if (filePreset && filePreset !== envPreset) {
      warnings.push({
        level: "info",
        kind: "env-preset-masks-file",
        message: `Environment OH_MY_OPENCODE_SLIM_PRESET="${envPreset}" overrides file preset "${filePreset}"`,
        path: "preset",
      });
    }
  }

  if (env.OH_MY_OPENCODE_SLIM_DISABLE === "1" || env.OH_MY_OPENCODE_SLIM_DISABLE === "true") {
    warnings.push({
      level: "warning",
      kind: "omo-disabled-env",
      message: "OH_MY_OPENCODE_SLIM_DISABLE is set — plugin may be disabled at runtime",
    });
  }

  // Preset → agents merge: deepMerge(preset, rootAgents) — root wins
  const presetsRaw = (merged.presets as Record<string, Record<string, unknown>>) ?? {};
  const rootAgentsRaw = (merged.agents as Record<string, unknown>) ?? {};
  let effectiveAgentsRaw: Record<string, unknown> = { ...rootAgentsRaw };

  if (activePreset) {
    const presetBlock = presetsRaw[activePreset];
    if (presetBlock) {
      // Record preset agent leaves
      for (const [agentName, cfg] of Object.entries(presetBlock)) {
        collectLeaves(cfg, `agents.${agentName}`, {
          sourceId: userSource?.id ?? `preset:${activePreset}`,
          sourceLabel: userSource?.path ?? `presets.${activePreset}`,
          stage: "preset",
          order: 40,
          scope: "user",
          filePath: userSource?.path,
          sourcePathPrefix: `presets.${activePreset}.${agentName}`,
        }, leaves);
        // Fix paths: collectLeaves used agents.X but sourcePathPrefix already has full path
      }
      // Re-collect with correct path mapping for agents.*
      for (const [agentName, cfg] of Object.entries(presetBlock)) {
        if (!isPlainObject(cfg) && !Array.isArray(cfg)) continue;
        const agentLeaves: LeafMap = new Map();
        collectLeaves(cfg, "", {
          sourceId: userSource?.id ?? `preset:${activePreset}`,
          sourceLabel: userSource?.path ?? `presets.${activePreset}`,
          stage: "preset",
          order: 40,
          scope: "user",
          filePath: userSource?.path,
          sourcePathPrefix: `presets.${activePreset}.${agentName}`,
        }, agentLeaves);
        for (const [rel, cands] of agentLeaves) {
          const full = `agents.${agentName}${rel ? "." + rel : ""}`;
          // Remove wrongly-pathed entries from first collect if any
          const existing = leaves.get(full) ?? [];
          // filter out duplicate preset entries we'll re-add
          const filtered = existing.filter((c) => c.stage !== "preset" || c.order !== 40);
          leaves.set(full, [...filtered, ...cands]);
        }
      }

      effectiveAgentsRaw = deepMerge(presetBlock, rootAgentsRaw) ?? {};

      // Root agent leaves at higher order
      for (const [agentName, cfg] of Object.entries(rootAgentsRaw)) {
        const agentLeaves: LeafMap = new Map();
        collectLeaves(cfg, "", {
          sourceId:
            projectSource && projectData.agents
              ? projectSource.id
              : userSource?.id ?? "root-agents",
          sourceLabel:
            projectSource?.path ?? userSource?.path ?? "agents",
          stage: "root-agent",
          order: 50,
          scope: projectSource && (projectData.agents as Record<string, unknown>)?.[agentName]
            ? "project"
            : "user",
          filePath: projectSource?.path ?? userSource?.path,
          sourcePathPrefix: `agents.${agentName}`,
        }, agentLeaves);
        for (const [rel, cands] of agentLeaves) {
          const full = `agents.${agentName}${rel ? "." + rel : ""}`;
          const existing = leaves.get(full) ?? [];
          // drop prior root-agent dups from generic collect of agents.*
          const filtered = existing.filter(
            (c) => !(c.stage === "root-agent" && c.order === 50),
          );
          // Also if user-config collected agents.X from full file walk, keep those as lower
          leaves.set(full, [...filtered, ...cands]);
        }
      }
    } else {
      warnings.push({
        level: "error",
        kind: "missing-preset",
        message: `Preset "${activePreset}" not found. Available: ${Object.keys(presetsRaw).join(", ") || "none"}`,
        path: "preset",
      });
    }
  }

  // Clean up: remove raw "agents.foo" object-level noise from initial full-file collect
  // Keep only leaf paths under agents that we care about
  const properties = resolveLeaves(leaves);

  // Build agent views
  const disabledSource = Array.isArray(merged.disabled_agents)
    ? (merged.disabled_agents as string[])
    : ["observer"];
  const disabledAgents = disabledSource.filter((n) => !PROTECTED_AGENTS.has(n));
  const disabledSet = new Set(disabledAgents);

  const agents: Record<string, EffectiveAgent> = {};
  const agentNames = new Set([
    ...Object.keys(effectiveAgentsRaw),
    ...BUILTIN_OMO_AGENTS,
  ]);

  for (const name of agentNames) {
    const cfg = (effectiveAgentsRaw[name] ?? {}) as Record<string, unknown>;
    const fieldProvenance: Record<string, ResolvedProperty> = {};
    for (const f of AGENT_FIELDS) {
      const p = properties[`agents.${name}.${f}`];
      if (p) fieldProvenance[f] = p;
    }
    // model array entries
    for (const [path, prop] of Object.entries(properties)) {
      if (path.startsWith(`agents.${name}.`) && !(path.split(".").pop()! in fieldProvenance)) {
        const rel = path.slice(`agents.${name}.`.length);
        fieldProvenance[rel] = prop;
      }
    }

    const model = cfg.model;
    let modelPrimary: string | undefined;
    let modelFallbacks: string[] = [];
    if (typeof model === "string") modelPrimary = model;
    else if (Array.isArray(model)) {
      modelPrimary =
        typeof model[0] === "string"
          ? model[0]
          : model[0] && typeof model[0] === "object"
            ? String((model[0] as { id?: string }).id ?? "")
            : undefined;
      modelFallbacks = model.slice(1).map((m) =>
        typeof m === "string"
          ? m
          : m && typeof m === "object"
            ? String((m as { id?: string }).id ?? "")
            : String(m),
      );
    } else if (model && typeof model === "object" && "id" in model) {
      modelPrimary = String((model as { id: string }).id);
    }

    // legacy provenance array
    const provenance: ProvenanceEntry[] = Object.values(fieldProvenance).map(
      (rp) => ({
        path: rp.path,
        effectiveValue: rp.value,
        winner: {
          id: rp.winner.sourceId,
          scope: (rp.winner.scope ?? "user") as ConfigSource["scope"],
          path: rp.winner.filePath ?? null,
          format: "json" as const,
        },
        reason: rp.reason,
        overridden: rp.overridden.map((o) => ({
          source: {
            id: o.sourceId,
            scope: (o.scope ?? "user") as ConfigSource["scope"],
            path: o.filePath ?? null,
            format: "json" as const,
          },
          value: o.value,
        })),
      }),
    );

    if (
      fieldProvenance.model &&
      fieldProvenance.model.overridden.some((o) => o.stage === "preset")
    ) {
      warnings.push({
        level: "info",
        kind: "root-masks-preset",
        message: `agents.${name}.model root override masks preset value`,
        path: `agents.${name}.model`,
      });
    }

    agents[name] = {
      name,
      kind: BUILTIN_SET.has(name) ? "builtin" : "custom",
      enabled: !disabledSet.has(name),
      modelPrimary,
      modelFallbacks,
      variant: typeof cfg.variant === "string" ? cfg.variant : undefined,
      temperature: typeof cfg.temperature === "number" ? cfg.temperature : undefined,
      skills: Array.isArray(cfg.skills) ? (cfg.skills as string[]) : [],
      mcps: Array.isArray(cfg.mcps) ? (cfg.mcps as string[]) : [],
      displayName: typeof cfg.displayName === "string" ? cfg.displayName : undefined,
      description: typeof cfg.description === "string" ? cfg.description : undefined,
      hasInlinePrompt: typeof cfg.prompt === "string",
      hasOrchestratorPrompt: typeof cfg.orchestratorPrompt === "string",
      provenance,
      fieldProvenance,
      permission: cfg.permission,
      options:
        cfg.options && typeof cfg.options === "object"
          ? (cfg.options as Record<string, unknown>)
          : undefined,
      prompt: typeof cfg.prompt === "string" ? cfg.prompt : undefined,
      orchestratorPrompt:
        typeof cfg.orchestratorPrompt === "string"
          ? cfg.orchestratorPrompt
          : undefined,
    };
  }

  // Prompts
  const dirs = promptSearchDirs(
    opts.opencodeConfigDir,
    opts.projectDirectory,
    activePreset,
    roots,
  );
  const prompts: Record<string, EffectivePrompt> = {};
  const promptAgentNames = new Set([
    ...Object.keys(agents),
    ...BUILTIN_OMO_AGENTS,
  ]);
  for (const name of promptAgentNames) {
    const { replacement, append, all } = discoverPromptFiles(
      name,
      dirs,
      roots,
      !!opts.includePromptText,
    );
    const inline = agents[name]?.prompt;
    prompts[name] = composePrompt({
      agent: name,
      inline,
      fileReplacement: replacement,
      fileAppend: append,
      allHits: all,
      includeText: !!opts.includePromptText,
    });
    for (const w of prompts[name]!.warnings) {
      warnings.push({
        level: "info",
        kind: "prompt-mask",
        message: w,
        path: `agents.${name}.prompt`,
      });
    }
  }

  // Inventory
  const promptDir = join(opts.opencodeConfigDir, PROMPTS_DIR);
  let promptDirPresent = false;
  try {
    assertAuthorizedPath(promptDir, roots);
    promptDirPresent = existsSync(promptDir);
  } catch {
    /* */
  }

  const inventory: ConfigSourceInventoryItem[] = [
    {
      id: "user-omo",
      label: "User OMO config",
      kind: "user-omo",
      path: userPath ?? opts.virtualSources?.user?.path ?? null,
      present: !!userPath || virtualUserExists,
      detail:
        userPath || virtualUserExists
          ? virtualUserExists && !userPath
            ? "Virtual candidate"
            : "Loaded"
          : "Not found",
    },
    {
      id: "project-omo",
      label: "Project OMO config",
      kind: "project-omo",
      path: projectOutOfScope
        ? join(opts.projectDirectory, ".opencode/oh-my-opencode-slim.json")
        : projectPath ?? opts.virtualSources?.project?.path ?? null,
      present: !!projectPath || virtualProjectExists,
      detail: projectOutOfScope
        ? "Out of authorized scope"
        : projectPath || virtualProjectExists
          ? virtualProjectExists && !projectPath
            ? "Virtual candidate"
            : "Loaded"
          : "Not present",
    },
    {
      id: "env-preset",
      label: "OH_MY_OPENCODE_SLIM_PRESET",
      kind: "env",
      path: null,
      present: !!envPreset,
      detail: envPreset ?? "Not set",
    },
    {
      id: "prompt-dir",
      label: "Prompt directory",
      kind: "prompt-dir",
      path: promptDir,
      present: promptDirPresent,
      detail: promptDirPresent
        ? listPromptFilesSafe(promptDir, roots)
        : "Not present",
    },
  ];

  const opencodeJson = findConfigPath(
    join(opts.opencodeConfigDir, "opencode"),
    roots,
  );
  inventory.push({
    id: "opencode-json",
    label: "OpenCode config",
    kind: "opencode-json",
    path: opencodeJson,
    present: !!opencodeJson,
    detail: opencodeJson ? "Present (plugin registration)" : "Not found",
  });

  // Globals snapshot
  const globals: Record<string, unknown> = {};
  for (const k of TOP_LEVEL_KEYS) {
    if (k === "presets" || k === "agents") continue;
    if (merged[k] !== undefined) globals[k] = merged[k];
  }

  return {
    sources: inventory,
    properties,
    agents,
    preset: activePreset,
    filePreset,
    envPreset,
    warnings,
    runtimePreset: {
      known: false,
      name: null,
      note:
        "Runtime /preset selection is not exposed via OpenCode API. File-effective uses load-time deepMerge(preset, rootAgents). Runtime preset uses opposite merge order and is unknown here.",
    },
    prompts,
    globals,
    rawMerged: merged,
  };
}

function listPromptFilesSafe(dir: string, roots: string[]): string {
  try {
    assertAuthorizedPath(dir, roots);
    const names: string[] = [];
    const walk = (d: string, prefix: string) => {
      for (const ent of readdirSync(d, { withFileTypes: true })) {
        if (ent.name.startsWith(".")) continue;
        const p = join(d, ent.name);
        if (ent.isDirectory()) walk(p, prefix + ent.name + "/");
        else if (ent.name.endsWith(".md")) names.push(prefix + ent.name);
      }
    };
    walk(dir, "");
    return names.length ? names.join(", ") : "Empty";
  } catch {
    return "Unreadable";
  }
}

export function getProperty(
  bundle: ProvenanceBundle,
  path: string,
): ResolvedProperty | undefined {
  return bundle.properties[path];
}

export { TOP_LEVEL_KEYS, AGENT_FIELDS };
