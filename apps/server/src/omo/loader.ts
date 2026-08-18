/**
 * OMO-Slim config loader — wraps provenance resolver for Desired/Effective.
 * Field-level provenance: ./provenance.ts
 */

import type {
  ConfigSource,
  DesiredAgent,
  DesiredOmoConfig,
  EffectiveConfig,
  ModelRef,
} from "@omo/shared";
import { BUILTIN_OMO_AGENTS } from "@omo/shared";
import {
  resolveProvenance,
  type ProvenanceOptions,
} from "./provenance";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { assertAuthorizedPath } from "../config";
import { parse as parseJsonc } from "jsonc-parser";
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";

const BUILTIN_SET = new Set<string>(BUILTIN_OMO_AGENTS);

export interface LoadOmoOptions {
  opencodeConfigDir: string;
  projectDirectory: string;
  authorizedRoots: string[];
  includePromptText?: boolean;
}

export interface LoadedOmo {
  desired: DesiredOmoConfig;
  effective: EffectiveConfig;
  userConfigPath: string | null;
  projectConfigPath: string | null;
  provenance: ReturnType<typeof resolveProvenance>;
}

function findConfigPath(basePath: string, roots: string[]): string | null {
  for (const c of [`${basePath}.jsonc`, `${basePath}.json`]) {
    try {
      assertAuthorizedPath(c, roots);
    } catch {
      continue;
    }
    if (existsSync(c)) return c;
  }
  return null;
}

export function findPluginConfigPaths(
  opencodeConfigDir: string,
  projectDirectory: string,
  roots: string[],
): { userConfigPath: string | null; projectConfigPath: string | null } {
  return {
    userConfigPath: findConfigPath(
      join(opencodeConfigDir, "oh-my-opencode-slim"),
      roots,
    ),
    projectConfigPath: findConfigPath(
      join(projectDirectory, ".opencode", "oh-my-opencode-slim"),
      roots,
    ),
  };
}

function readRaw(
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

function asAgentMap(
  raw: unknown,
  sourceId: string,
): Record<string, DesiredAgent> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, DesiredAgent> = {};
  for (const [name, cfg] of Object.entries(raw as Record<string, unknown>)) {
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) continue;
    const c = cfg as Record<string, unknown>;
    out[name] = {
      name,
      kind: BUILTIN_SET.has(name) ? "builtin" : "custom",
      model: c.model as DesiredAgent["model"],
      variant: typeof c.variant === "string" ? c.variant : undefined,
      temperature: typeof c.temperature === "number" ? c.temperature : undefined,
      skills: Array.isArray(c.skills) ? (c.skills as string[]) : undefined,
      mcps: Array.isArray(c.mcps) ? (c.mcps as string[]) : undefined,
      prompt: typeof c.prompt === "string" ? c.prompt : undefined,
      orchestratorPrompt:
        typeof c.orchestratorPrompt === "string"
          ? c.orchestratorPrompt
          : undefined,
      options:
        c.options && typeof c.options === "object"
          ? (c.options as Record<string, unknown>)
          : undefined,
      displayName: typeof c.displayName === "string" ? c.displayName : undefined,
      description: typeof c.description === "string" ? c.description : undefined,
      permission: c.permission,
      sourceIds: [sourceId],
    };
  }
  return out;
}

export function normalizeModelField(model: DesiredAgent["model"]): {
  primary?: string;
  fallbacks: string[];
} {
  if (model == null) return { fallbacks: [] };
  if (typeof model === "string") return { primary: model, fallbacks: [] };
  if (Array.isArray(model)) {
    const parts = model.map((m) =>
      typeof m === "string"
        ? m
        : m && typeof m === "object" && "id" in m
          ? (m as ModelRef).variant
            ? `${(m as ModelRef).id} (${(m as ModelRef).variant})`
            : (m as ModelRef).id
          : String(m),
    );
    return { primary: parts[0], fallbacks: parts.slice(1) };
  }
  if (typeof model === "object" && "id" in model) {
    const m = model as ModelRef;
    return {
      primary: m.variant ? `${m.id} (${m.variant})` : m.id,
      fallbacks: [],
    };
  }
  return { fallbacks: [] };
}

export function loadOmoConfig(opts: LoadOmoOptions): LoadedOmo {
  const provOpts: ProvenanceOptions = {
    opencodeConfigDir: opts.opencodeConfigDir,
    projectDirectory: opts.projectDirectory,
    authorizedRoots: opts.authorizedRoots,
    includePromptText: opts.includePromptText,
  };
  const provenance = resolveProvenance(provOpts);
  const { userConfigPath, projectConfigPath } = findPluginConfigPaths(
    opts.opencodeConfigDir,
    opts.projectDirectory,
    opts.authorizedRoots,
  );

  const sources: ConfigSource[] = [];
  let userData: Record<string, unknown> = {};
  if (userConfigPath) {
    const u = readRaw(userConfigPath, "user", opts.authorizedRoots);
    if (u) {
      sources.push(u.source);
      userData = u.data;
    }
  }
  if (projectConfigPath) {
    const p = readRaw(projectConfigPath, "project", opts.authorizedRoots);
    if (p) sources.push(p.source);
  }

  const presetsRaw =
    (userData.presets as Record<string, Record<string, unknown>>) ??
    (provenance.rawMerged.presets as Record<string, Record<string, unknown>>) ??
    {};
  const desiredPresets: DesiredOmoConfig["presets"] = {};
  const sid = sources[0]?.id ?? "user";
  for (const [pname, agents] of Object.entries(presetsRaw)) {
    desiredPresets[pname] = asAgentMap(agents, sid);
  }
  // Prefer raw merged agents for desired root (file-level)
  const rootAgents =
    (provenance.rawMerged.agents as Record<string, unknown>) ?? {};
  // Desired root should be pre-preset-merge root agents only from files
  let desiredRoot: Record<string, DesiredAgent> = {};
  if (userConfigPath) {
    const u = readRaw(userConfigPath, "user", opts.authorizedRoots);
    if (u?.data.agents) desiredRoot = asAgentMap(u.data.agents, u.source.id);
  }
  if (projectConfigPath) {
    const p = readRaw(projectConfigPath, "project", opts.authorizedRoots);
    if (p?.data.agents) {
      desiredRoot = {
        ...desiredRoot,
        ...asAgentMap(p.data.agents, p.source.id),
      };
    }
  }

  const desired: DesiredOmoConfig = {
    sources,
    activePresetName: provenance.filePreset,
    agents: desiredRoot,
    presets: desiredPresets,
    globals: {
      disabled_agents: provenance.globals.disabled_agents as string[] | undefined,
      disabled_mcps: provenance.globals.disabled_mcps as string[] | undefined,
      disabled_tools: provenance.globals.disabled_tools as string[] | undefined,
      disabled_skills: provenance.globals.disabled_skills as string[] | undefined,
      backgroundJobs: provenance.globals.backgroundJobs as
        | Record<string, unknown>
        | undefined,
      fallback: provenance.globals.fallback as Record<string, unknown> | undefined,
      companion: provenance.globals.companion as Record<string, unknown> | undefined,
      council: provenance.globals.council as Record<string, unknown> | undefined,
      stripOrchestratorModel:
        typeof provenance.globals.stripOrchestratorModel === "boolean"
          ? provenance.globals.stripOrchestratorModel
          : undefined,
    },
    raw: provenance.rawMerged,
  };

  const effective: EffectiveConfig = {
    preset: provenance.preset,
    agents: provenance.agents,
    disabledAgents: Object.values(provenance.agents)
      .filter((a) => !a.enabled)
      .map((a) => a.name),
    backgroundJobs:
      (provenance.globals.backgroundJobs as Record<string, unknown>) ?? {},
    fallback: (provenance.globals.fallback as Record<string, unknown>) ?? {},
    warnings: provenance.warnings.map((w) => ({
      kind: w.kind,
      message: w.message,
      path: w.path,
    })),
    sources,
    properties: provenance.properties,
    globals: provenance.globals,
    runtimePreset: provenance.runtimePreset,
  };

  void rootAgents;

  return {
    desired,
    effective,
    userConfigPath,
    projectConfigPath,
    provenance,
  };
}

export function desiredModelForAgent(
  desired: DesiredOmoConfig,
  effectivePreset: string | undefined,
  name: string,
): string | undefined {
  const root = desired.agents[name];
  if (root?.model != null) {
    return normalizeModelField(root.model).primary;
  }
  if (
    effectivePreset &&
    desired.presets[effectivePreset]?.[name]?.model != null
  ) {
    return normalizeModelField(
      desired.presets[effectivePreset]![name]!.model,
    ).primary;
  }
  return undefined;
}

// re-export for tests
export { resolveProvenance } from "./provenance";
