/**
 * Companion subsystem state (read-only, Slice 13).
 *
 * Verified installed semantics (oh-my-opencode-slim@2.2.10):
 * - CompanionConfigSchema: 8 optional fields; schema not strict (unknown keys
 *   stripped by zod) and never parsed at runtime — loader normalization
 *   applies the effective defaults below.
 * - External native binary `oh-my-opencode-slim-companion`; discovery =
 *   configured binaryPath else ($XDG_DATA_HOME|~/.local/share)/opencode/
 *   storage/oh-my-opencode-slim/bin/…; existsSync check inside OMO.
 * - Launched once per plugin init; config read once at init (restart
 *   required); single-instance PID lock; no auto-restart; file-based state
 *   (companion-state.json), stdio ignored, no IPC socket; graceful no-op if
 *   the binary is missing; enabled !== true prevents all launch.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ProvenanceBundle, ResolvedProperty } from "@omo/shared";
import { isWithinAuthorizedRoots } from "../config";

export interface SubsystemFieldSpec {
  name: string;
  schemaType: string;
  defaultValue?: unknown;
  enumValues?: string[];
  minimum?: number;
  maximum?: number;
  desc?: string;
}

/** Frozen catalog of the 8 verified CompanionConfigSchema fields. */
export const COMPANION_FIELDS: Record<string, SubsystemFieldSpec> = Object.freeze({
  enabled: {
    name: "enabled",
    schemaType: "boolean",
    defaultValue: false,
    desc: "Launch external companion binary at plugin init",
  },
  binaryPath: {
    name: "binaryPath",
    schemaType: "string",
    desc: "Explicit companion binary path (min length 1; no schema default)",
  },
  position: {
    name: "position",
    schemaType: "enum",
    defaultValue: "bottom-right",
    enumValues: ["bottom-right", "bottom-left", "top-right", "top-left"],
  },
  size: {
    name: "size",
    schemaType: "enum",
    defaultValue: "medium",
    enumValues: ["small", "medium", "large"],
  },
  gifPack: {
    name: "gifPack",
    schemaType: "enum",
    defaultValue: "default",
    enumValues: ["default"],
  },
  loopStyle: {
    name: "loopStyle",
    schemaType: "enum",
    defaultValue: "classic",
    enumValues: ["classic", "smooth"],
  },
  speed: {
    name: "speed",
    schemaType: "number",
    defaultValue: 1,
    minimum: 0.25,
    maximum: 4,
  },
  debug: {
    name: "debug",
    schemaType: "boolean",
    defaultValue: false,
  },
});

export interface CompanionEffective {
  enabled: boolean;
  binaryPath?: string;
  position: string;
  size: string;
  gifPack: string;
  loopStyle: string;
  speed: number;
  debug: boolean;
}

export interface CompanionBinaryState {
  configuredPath?: string;
  defaultPath: string;
  resolutionSource: "configured" | "default";
  withinAuthorizedScope: boolean;
  /** true only when withinAuthorizedScope (probe actually ran) */
  inspected: boolean;
  /** null = not inspected (outside authorized scope) */
  exists: boolean | null;
}

export interface CompanionState {
  fields: Record<string, SubsystemFieldSpec>;
  desired: Record<string, unknown> | null;
  effective: CompanionEffective;
  properties: Record<string, ResolvedProperty>;
  raw: { user?: Record<string, unknown>; project?: Record<string, unknown> };
  binary: CompanionBinaryState;
  runtime: { observable: false; reasonUnavailable: string };
  activation: string[];
  warnings: string[];
}

export interface CompanionDeps {
  existsProbe?: (p: string) => boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Reconstruct per-scope raw fragments from leaf provenance candidates
 * (user-config / project-config stages) under a top-level prefix.
 */
export function rawScopeFragments(
  bundle: ProvenanceBundle,
  prefix: string,
): { user?: Record<string, unknown>; project?: Record<string, unknown> } {
  const raw: {
    user?: Record<string, unknown>;
    project?: Record<string, unknown>;
  } = {};
  for (const [path, prop] of Object.entries(bundle.properties)) {
    if (!path.startsWith(prefix + ".")) continue;
    const leaf = path.slice(prefix.length + 1);
    if (leaf.includes(".")) continue;
    for (const c of [prop.winner, ...prop.overridden]) {
      if (c.stage === "user-config") (raw.user ??= {})[leaf] = c.value;
      else if (c.stage === "project-config") (raw.project ??= {})[leaf] = c.value;
    }
  }
  return raw;
}

/** Synthetic provenance leaf for a built-in default (no user/project value). */
export function builtinLeaf(path: string, defaultValue: unknown): ResolvedProperty {
  return {
    path,
    value: defaultValue,
    winner: {
      value: defaultValue,
      sourceId: "builtin",
      sourceLabel: "Built-in OMO default",
      sourcePath: path,
      stage: "builtin",
      order: 0,
    },
    overridden: [],
    reason: "Built-in default (no user/project value)",
  };
}

function enumEffective(
  d: Record<string, unknown>,
  spec: SubsystemFieldSpec,
  warnings: string[],
): string {
  const fallback = String(spec.defaultValue);
  const v = d[spec.name];
  if (v === undefined) return fallback;
  if (typeof v === "string" && spec.enumValues?.includes(v)) return v;
  warnings.push(
    `companion.${spec.name} value ${JSON.stringify(v)} not in [${(spec.enumValues ?? []).join(", ")}]; value ignored (effective: "${fallback}")`,
  );
  return fallback;
}

export function companionDefaultBinaryPath(
  env: Record<string, string | undefined>,
): string {
  const xdg = env.XDG_DATA_HOME;
  const dataHome =
    xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "share");
  const exe = process.platform === "win32" ? ".exe" : "";
  return join(
    dataHome,
    "opencode",
    "storage",
    "oh-my-opencode-slim",
    "bin",
    `oh-my-opencode-slim-companion${exe}`,
  );
}

export function buildCompanionState(
  bundle: ProvenanceBundle,
  _ctxDirectory: string,
  authorizedRoots: string[],
  env: Record<string, string | undefined> = process.env,
  deps: CompanionDeps = {},
): CompanionState {
  const warnings: string[] = [];
  const merged = bundle.rawMerged.companion;
  const desired = isPlainObject(merged) ? merged : null;
  const d = desired ?? {};

  const effective: CompanionEffective = {
    enabled: d.enabled === true,
    position: enumEffective(d, COMPANION_FIELDS.position!, warnings),
    size: enumEffective(d, COMPANION_FIELDS.size!, warnings),
    gifPack: enumEffective(d, COMPANION_FIELDS.gifPack!, warnings),
    loopStyle: enumEffective(d, COMPANION_FIELDS.loopStyle!, warnings),
    speed: 1,
    debug: false,
  };

  if (d.enabled !== undefined && typeof d.enabled !== "boolean") {
    warnings.push(
      "companion.enabled must be a boolean; value ignored (effective: false)",
    );
  }

  if (d.binaryPath !== undefined) {
    if (typeof d.binaryPath === "string" && d.binaryPath.length >= 1) {
      effective.binaryPath = d.binaryPath;
    } else {
      warnings.push(
        "companion.binaryPath must be a non-empty string; value ignored",
      );
    }
  }

  if (d.speed !== undefined) {
    if (
      typeof d.speed === "number" &&
      Number.isFinite(d.speed) &&
      d.speed >= 0.25 &&
      d.speed <= 4
    ) {
      effective.speed = d.speed;
    } else {
      warnings.push(
        "companion.speed must be a number 0.25–4; value ignored (effective: 1)",
      );
    }
  }

  if (d.debug !== undefined) {
    if (d.debug === true || d.debug === false) effective.debug = d.debug;
    else {
      warnings.push(
        "companion.debug must be a boolean; value ignored (effective: false)",
      );
    }
  }

  const properties: Record<string, ResolvedProperty> = {};
  for (const spec of Object.values(COMPANION_FIELDS)) {
    const path = `companion.${spec.name}`;
    properties[path] =
      bundle.properties[path] ?? builtinLeaf(path, spec.defaultValue ?? null);
  }

  const defaultPath = companionDefaultBinaryPath(env);
  const probeTarget = effective.binaryPath ?? defaultPath;
  const withinAuthorizedScope = isWithinAuthorizedRoots(
    probeTarget,
    authorizedRoots,
  );
  const inspected = withinAuthorizedScope;
  const probe = deps.existsProbe ?? existsSync;

  return {
    fields: COMPANION_FIELDS,
    desired,
    effective,
    properties,
    raw: rawScopeFragments(bundle, "companion"),
    binary: {
      configuredPath: effective.binaryPath,
      defaultPath,
      resolutionSource: effective.binaryPath ? "configured" : "default",
      withinAuthorizedScope,
      inspected,
      exists: inspected ? probe(probeTarget) : null,
    },
    runtime: {
      observable: false,
      reasonUnavailable:
        "OMO does not expose Companion process state via OpenCode server APIs (installed source: file-based state + detached process only)",
    },
    activation: [
      "Companion binary launched at most once per plugin init; OpenCode restart required for config changes (config read once at init)",
      "enabled !== true prevents all launch attempts",
      "Missing binary is a graceful no-op (OMO logs, no launch, no error)",
      "Single-instance PID lock prevents duplicate companion processes",
      "No IPC: file-based state (companion-state.json), stdio ignored, no socket",
      "No auto-restart if the companion process exits",
    ],
    warnings,
  };
}
