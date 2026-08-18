/**
 * Council configuration: presets lifecycle + members.
 *
 * Verified installed semantics (2.2.10):
 * - CouncillorConfigSchema: { model: string|chain, variant?, prompt? }
 * - model single "provider/model" or ordered fallback chain — SAME chain shape as agents
 * - Reserved member key "master" silently ignored
 * - default_preset schema default "default"
 * - Passthrough: unknown fields preserved (council → _deprecated ["master"] diag)
 * - Councillors run through protected `councillor` agent with member model/instance
 */

import { readFileSync } from "node:fs";
import type { ServerConfig } from "../config";
import { applyJsoncPathEdit, getAtPath, parseConfigText } from "./jsonc-edit";
import { resolveWriteTarget } from "./paths";
import type { RevisionStore } from "./revisions";
import type { OmoCandidateProducer, SchemaValidationSummary } from "@omo/shared";
import {
  expectedSourceFromHash,
  fingerprintScope,
  previewOmoCandidate,
  previewThenCommit,
  type OmoTransactionDeps,
} from "./transaction";

export type MemberFieldOp =
  | { operation: "unchanged" }
  | { operation: "set"; value: unknown }
  | { operation: "remove" };

export interface CouncilMemberOp {
  member: string;
  operation: "create" | "update" | "delete" | "rename";
  newName?: string;
  model?: MemberFieldOp;
  variant?: MemberFieldOp;
  prompt?: MemberFieldOp;
}

export interface CouncilMutation {
  kind: "council";
  scope: "user" | "project";
  defaultPreset?: MemberFieldOp; // set string | remove
  presetCreate?: { name: string; cloneFrom?: string };
  presetRename?: { oldName: string; newName: string };
  presetDelete?: { name: string };
  members?: {
    preset: string;
    ops: CouncilMemberOp[];
  };
  expectedSourceHash?: string;
}

export interface CouncilMutationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  revisionId?: string;
  targetPath?: string;
  textDiff?: string;
  /** Installed-schema gate result for the full candidate document. */
  schemaValidation?: SchemaValidationSummary;
}

const RESERVED_MEMBER = "master";

function validateName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name) && name !== "." && name !== "..";
}

function validateModelValue(v: unknown): string | null {
  if (typeof v === "string") {
    return /^[^/\s]+\/[^\s]+$/.test(v)
      ? null
      : 'model must be provider/model format';
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return "model chain cannot be empty";
    for (const e of v) {
      if (typeof e === "string") {
        if (!/^[^/\s]+\/[^\s]+$/.test(e)) return "chain entry bad format";
      } else if (e && typeof e === "object" && "id" in e) {
        const id = (e as { id: string }).id;
        if (typeof id !== "string" || !/^[^/\s]+\/[^\s]+$/.test(id)) {
          return "chain {id} bad format";
        }
      } else return "chain entry must be string or {id, variant?}";
    }
    return null;
  }
  return "model must be string or chain array";
}

/** Deep-get council section with defaults */
function getCouncil(obj: Record<string, unknown>): {
  default_preset: string | undefined;
  presets: Record<string, Record<string, Record<string, unknown>>>;
} {
  const council = (obj.council ?? {}) as Record<string, unknown>;
  const presets = (council.presets ?? {}) as Record<
    string,
    Record<string, Record<string, unknown>>
  >;
  return {
    default_preset:
      typeof council.default_preset === "string"
        ? council.default_preset
        : undefined,
    presets,
  };
}

function expandEdits(
  m: CouncilMutation,
  beforeObj: Record<string, unknown>,
  warnings: string[],
  errors: string[],
): Array<{ path: string[]; value: unknown }> {
  const edits: Array<{ path: string[]; value: unknown }> = [];
  const council = getCouncil(beforeObj);

  // preset lifecycle first
  if (m.presetCreate) {
    const { name, cloneFrom } = m.presetCreate;
    if (!validateName(name)) errors.push(`Invalid preset name: ${name}`);
    if (council.presets[name] !== undefined)
      errors.push(`Preset exists: ${name}`);
    let value: Record<string, unknown> = {};
    if (cloneFrom) {
      const src = council.presets[cloneFrom];
      if (!src) errors.push(`Clone source not found: ${cloneFrom}`);
      else value = JSON.parse(JSON.stringify(src));
    }
    edits.push({ path: ["council", "presets", name], value });
  }

  if (m.presetRename) {
    const { oldName, newName } = m.presetRename;
    if (!validateName(newName)) errors.push(`Invalid preset name: ${newName}`);
    const existing = council.presets[oldName];
    if (existing === undefined)
      errors.push(`Preset not found: ${oldName}`);
    else {
      if (council.presets[newName] !== undefined)
        errors.push(`Target preset exists: ${newName}`);
      edits.push({
        path: ["council", "presets", newName],
        value: JSON.parse(JSON.stringify(existing)),
      });
      edits.push({ path: ["council", "presets", oldName], value: undefined });
      if (council.default_preset === oldName) {
        edits.push({ path: ["council", "default_preset"], value: newName });
        warnings.push(
          `default_preset updated ${oldName} → ${newName}`,
        );
      }
    }
  }

  if (m.presetDelete) {
    const { name } = m.presetDelete;
    if (council.presets[name] === undefined) {
      errors.push(`Preset not found: ${name}`);
    } else {
      if (council.default_preset === name) {
        const others = Object.keys(council.presets).filter((k) => k !== name);
        if (others.length === 0) {
          errors.push(
            `Cannot delete only councillor preset while it is configured default. Change or remove default_preset first.`,
          );
        } else {
          warnings.push(
            `Deleting configured default preset "${name}". Effective default will reference a missing preset unless user/project lower layer defines another.`,
          );
        }
      }
      edits.push({ path: ["council", "presets", name], value: undefined });
    }
  }

  // default preset
  if (m.defaultPreset && m.defaultPreset.operation !== "unchanged") {
    if (m.defaultPreset.operation === "remove") {
      edits.push({ path: ["council", "default_preset"], value: undefined });
      warnings.push(`Removed default_preset; OMO schema default "default" applies`);
    } else {
      const v = String(m.defaultPreset.value);
      if (!validateName(v)) errors.push(`Invalid default preset name: ${v}`);
      const presets = new Set([
        ...Object.keys(council.presets),
        ...(m.presetCreate ? [m.presetCreate.name] : []),
      ]);
      if (!presets.has(v)) {
        warnings.push(`default_preset "${v}" does not match an existing configured preset`);
      }
      edits.push({ path: ["council", "default_preset"], value: v });
    }
  }

  // members
  if (m.members) {
    const preset = m.members.preset;
    const presetExists =
      council.presets[preset] !== undefined ||
      m.presetCreate?.name === preset;
    if (!presetExists) {
      errors.push(`Member target preset does not exist: ${preset}`);
    } else {
      const currentMembers: Record<string, Record<string, unknown>> = {};
      const existingPreset = council.presets[preset] ?? {};
      Object.assign(currentMembers, JSON.parse(JSON.stringify(existingPreset)));
      // presetCreate clone may have set base
      if (m.presetCreate?.name === preset) {
        Object.assign(
          currentMembers,
          council.presets[m.presetCreate.cloneFrom ?? ""] ?? {},
        );
      }

      for (const op of m.members.ops) {
        const name = op.member;
        if (!validateName(name)) {
          errors.push(`Invalid member name: ${name}`);
          continue;
        }
        if (name === RESERVED_MEMBER) {
          errors.push(`"master" is a reserved legacy key and cannot be used`);
          continue;
        }
        const memberPath = ["council", "presets", preset, name];

        if (op.operation === "create") {
          if (currentMembers[name] !== undefined) {
            errors.push(`Member exists: ${name}`);
            continue;
          }
          const model = op.model?.operation === "set" ? op.model.value : undefined;
          if (model === undefined) {
            errors.push(`create requires model for member ${name}`);
            continue;
          }
          const err = validateModelValue(model);
          if (err) {
            errors.push(`${name}.model: ${err}`);
            continue;
          }
          const value: Record<string, unknown> = { model };
          if (op.variant?.operation === "set" && op.variant.value != null)
            value.variant = op.variant.value;
          if (op.prompt?.operation === "set" && op.prompt.value != null)
            value.prompt = op.prompt.value;
          edits.push({ path: memberPath, value });
          currentMembers[name] = value;
          continue;
        }

        if (op.operation === "delete") {
          if (currentMembers[name] === undefined) {
            warnings.push(`delete skipped: member ${name} not present`);
            continue;
          }
          edits.push({ path: memberPath, value: undefined });
          delete currentMembers[name];
          continue;
        }

        if (op.operation === "rename") {
          const nn = op.newName ?? "";
          if (!validateName(nn)) {
            errors.push(`Invalid new member name: ${nn}`);
            continue;
          }
          if (nn === RESERVED_MEMBER) {
            errors.push(`Cannot rename to reserved "master"`);
            continue;
          }
          if (currentMembers[name] === undefined) {
            errors.push(`Member not found: ${name}`);
            continue;
          }
          if (currentMembers[nn] !== undefined) {
            errors.push(`Target member exists: ${nn}`);
            continue;
          }
          edits.push({ path: ["council", "presets", preset, nn], value: currentMembers[name] });
          edits.push({ path: memberPath, value: undefined });
          continue;
        }

        // update
        if (op.operation === "update") {
          if (currentMembers[name] === undefined) {
            // merge against project overlay potential — treat as create-with-fields if absent
            const base: Record<string, unknown> = {};
            currentMembers[name] = base;
          }
          if (op.model?.operation === "set") {
            const err = validateModelValue(op.model.value);
            if (err) {
              errors.push(`${name}.model: ${err}`);
              continue;
            }
            edits.push({ path: [...memberPath, "model"], value: op.model.value });
          } else if (op.model?.operation === "remove") {
            errors.push(`${name}.model is required (remove not allowed)`);
          }
          if (op.variant) {
            if (op.variant.operation === "remove") {
              edits.push({ path: [...memberPath, "variant"], value: undefined });
            } else if (op.variant.operation === "set") {
              edits.push({ path: [...memberPath, "variant"], value: op.variant.value });
            }
          }
          if (op.prompt) {
            if (op.prompt.operation === "remove") {
              edits.push({ path: [...memberPath, "prompt"], value: undefined });
            } else if (op.prompt.operation === "set") {
              edits.push({ path: [...memberPath, "prompt"], value: op.prompt.value });
            }
          }
        }
      }
    }
  }

  return edits;
}

export const produceCouncilCandidate: OmoCandidateProducer<CouncilMutation> = (
  input,
) => {
  const warnings: string[] = [];
  const errors: string[] = [];
  const edits = expandEdits(input.input, input.beforeDocument, warnings, errors);
  if (!errors.length && !edits.length) errors.push("No changes");
  let afterText = input.beforeText;
  if (!errors.length) {
    for (const e of edits) afterText = applyJsoncPathEdit(afterText, e.path, e.value);
  }
  return {
    candidateText: afterText,
    featureErrors: errors,
    featureWarnings: warnings,
    intent: {
      kind: "council",
      summary: "council",
      propertyPaths: edits.map((e) => e.path.join(".")),
      mutationJson: JSON.stringify(input.input),
      property: edits.map((e) => e.path.join(".")).slice(0, 3).join(","),
    },
  };
};

function councilDeps(cfg: ServerConfig, revisions?: RevisionStore): OmoTransactionDeps {
  return {
    cfg,
    revisions: revisions ?? ({
      available: true,
      isScopeWriteBlocked: () => false,
      recoverPendingOmo: () => [],
    } as unknown as RevisionStore),
  };
}

export function simulateCouncil(
  cfg: ServerConfig,
  m: CouncilMutation,
): CouncilMutationResult & {
  currentHash?: string;
  beforeCouncil?: Record<string, unknown>;
  afterCouncil?: Record<string, unknown>;
  effectiveChanges?: Array<{ path: string; before: unknown; after: unknown }>;
} {
  const deps = councilDeps(cfg);
  const live = fingerprintScope(deps, m.scope);
  const preview = previewOmoCandidate(
    deps,
    {
      scope: m.scope,
      expectedSource: expectedSourceFromHash(live, m.expectedSourceHash),
      input: m,
    },
    produceCouncilCandidate,
  );
  const warnings: string[] = [];
  const errors: string[] = [];
  const edits = preview.beforeDocument
    ? expandEdits(m, preview.beforeDocument, warnings, errors)
    : [];
  const effectiveChanges = edits
    .map((e) => ({
      path: e.path.join("."),
      before: preview.beforeDocument
        ? getAtPath(preview.beforeDocument, e.path)
        : undefined,
      after: preview.afterDocument
        ? getAtPath(preview.afterDocument, e.path)
        : undefined,
    }))
    .filter((c) => JSON.stringify(c.before) !== JSON.stringify(c.after));
  if (!preview.ok) {
    return {
      ok: false,
      errors:
        preview.code === "stale-source"
          ? ["CONFIGURATION CHANGED EXTERNALLY"]
          : preview.errors,
      warnings: [...warnings, ...preview.warnings],
      currentHash: preview.source.sha256 ?? undefined,
      targetPath: preview.target.path,
      textDiff: preview.textDiff?.text,
      schemaValidation: preview.schemaValidation,
    };
  }
  return {
    ok: true,
    errors: [],
    warnings: [...warnings, ...preview.warnings],
    currentHash: preview.source.sha256 ?? undefined,
    targetPath: preview.target.path,
    textDiff: preview.textDiff?.text,
    beforeCouncil: preview.beforeDocument
      ? (getCouncil(preview.beforeDocument) as unknown as Record<string, unknown>)
      : undefined,
    afterCouncil: preview.afterDocument
      ? (getCouncil(preview.afterDocument) as unknown as Record<string, unknown>)
      : undefined,
    effectiveChanges,
    schemaValidation: preview.schemaValidation,
  };
}

export function applyCouncil(
  cfg: ServerConfig,
  m: CouncilMutation,
  revisions: RevisionStore,
): CouncilMutationResult {
  const deps = councilDeps(cfg, revisions);
  const live = fingerprintScope(deps, m.scope);
  const commit = previewThenCommit(
    deps,
    {
      scope: m.scope,
      expectedSource: expectedSourceFromHash(live, m.expectedSourceHash),
      input: m,
    },
    produceCouncilCandidate,
  );
  if (!commit.ok) {
    return {
      ok: false,
      errors:
        commit.code === "stale-source"
          ? ["CONFIGURATION CHANGED EXTERNALLY"]
          : commit.errors,
      warnings: commit.preview.warnings,
      schemaValidation: commit.preview.schemaValidation,
    };
  }
  return {
    ok: true,
    errors: [],
    warnings: commit.preview.warnings,
    revisionId: commit.revisionId,
    targetPath: commit.preview.target.path,
    textDiff: commit.preview.textDiff?.text,
    schemaValidation: commit.preview.schemaValidation,
  };
}

// ── Inventory ─────────────────────────────────────────────────────────

export interface CouncilMemberView {
  name: string;
  model?: unknown;
  modelPrimary?: string;
  chainLength?: number;
  variant?: string;
  prompt?: string;
  hasPrompt: boolean;
  promptChars?: number;
  otherFields: Record<string, unknown>;
  warnings: string[];
}

export interface CouncilPresetView {
  name: string;
  sourceScopes: Array<"user" | "project">;
  isDefault: boolean;
  memberCount: number;
  uniqueModels: number;
  providers: string[];
  members: CouncilMemberView[];
  raw: Record<string, unknown>;
  empty: boolean;
}

export interface CouncilInventory {
  default_preset?: string;
  effective_default_preset: string;
  defaultMissing: boolean;
  presets: CouncilPresetView[];
  coordinator: {
    agent: string;
    note: string;
  };
  deprecated: string[];
  warnings: string[];
}

function providerOf(model: unknown): string | undefined {
  if (typeof model === "string") return model.split("/")[0];
  if (Array.isArray(model) && model.length) {
    const first = model[0];
    if (typeof first === "string") return first.split("/")[0];
    if (first && typeof first === "object" && "id" in first) {
      return String((first as { id: string }).id).split("/")[0];
    }
  }
  return undefined;
}

function primaryModel(model: unknown): string | undefined {
  if (typeof model === "string") return model;
  if (Array.isArray(model) && model.length) {
    const first = model[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object" && "id" in first)
      return String((first as { id: string }).id);
  }
  return undefined;
}

export function buildCouncilInventory(
  cfg: ServerConfig,
): CouncilInventory {
  const warnings: string[] = [];
  const deprecated: string[] = [];

  const loadScope = (scope: "user" | "project") => {
    const t = resolveWriteTarget(cfg, scope);
    if (!t.exists) return { obj: {} as Record<string, unknown>, exists: false };
    try {
      return {
        obj: parseConfigText(readFileSync(t.path, "utf-8")),
        exists: true,
      };
    } catch {
      return { obj: {} as Record<string, unknown>, exists: false };
    }
  };

  const user = loadScope("user");
  const project = loadScope("project");

  const userCouncil = getCouncil(user.obj);
  const projectCouncil = getCouncil(project.obj);

  if (user.obj.council && typeof user.obj.council === "object" && "master" in (user.obj.council as Record<string, unknown>)) {
    deprecated.push("user council.master present — ignored by installed OMO, preserved in file");
  }

  const presetNames = new Set([
    ...Object.keys(userCouncil.presets),
    ...Object.keys(projectCouncil.presets),
  ]);

  // project deep merges over user per nesting? For presets record, deepMerge merges
  const mergedPresets: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const name of presetNames) {
    const u = userCouncil.presets[name] ?? {};
    const p = projectCouncil.presets[name] ?? {};
    mergedPresets[name] = { ...u };
    // member-level: project member object replaces user member object (deep merge for objects)
    for (const [mk, mv] of Object.entries(p)) {
      const um = u[mk];
      if (mv && typeof mv === "object" && um && typeof um === "object") {
        mergedPresets[name][mk] = { ...um, ...mv };
      } else {
        mergedPresets[name][mk] = mv;
      }
    }
  }

  const default_preset =
    projectCouncil.default_preset ?? userCouncil.default_preset;
  const effectiveDefault = default_preset ?? "default";

  const presets: CouncilPresetView[] = [...presetNames].sort().map((name) => {
    const raw = mergedPresets[name] ?? {};
    const members = Object.entries(raw)
      .filter(([k]) => k !== RESERVED_MEMBER)
      .map(([memberName, cfg] ) => {
        const c = (cfg ?? {}) as Record<string, unknown>;
        const other = { ...c } as Record<string, unknown>;
        delete other.model;
        delete other.variant;
        delete other.prompt;
        const modelPrimary = primaryModel(c.model);
        return {
          name: memberName,
          model: c.model,
          modelPrimary,
          chainLength: Array.isArray(c.model) ? (c.model as unknown[]).length : c.model ? 1 : 0,
          variant: typeof c.variant === "string" ? c.variant : undefined,
          prompt: typeof c.prompt === "string" ? c.prompt : undefined,
          hasPrompt: typeof c.prompt === "string",
          promptChars: typeof c.prompt === "string" ? c.prompt.length : 0,
          otherFields: other,
          warnings:
            typeof c.model === "undefined"
              ? [`member ${memberName} missing required model`]
              : [],
        } satisfies CouncilMemberView;
      });

    const models = new Set(
      members.map((m) => m.modelPrimary).filter(Boolean) as string[],
    );
    const providers = [
      ...new Set(
        members.map((m) => providerOf(m.model)).filter(Boolean) as string[],
      ),
    ];

    return {
      name,
      sourceScopes: [
        ...(userCouncil.presets[name] ? ["user" as const] : []),
        ...(projectCouncil.presets[name] ? ["project" as const] : []),
      ],
      isDefault: effectiveDefault === name,
      memberCount: members.length,
      uniqueModels: models.size,
      providers,
      members,
      raw,
      empty: members.length === 0,
    };
  });

  if (default_preset && !presetNames.has(default_preset)) {
    warnings.push(`default_preset "${default_preset}" references no configured preset (OMO schema default "default" would apply if no match)`);
  }
  if (!default_preset && !presetNames.has("default") && presetNames.size === 0) {
    // fine - no council
  }
  const defPreset = presets.find((p) => p.name === effectiveDefault);
  if (defPreset?.empty) {
    warnings.push(`Effective default councillor preset "${effectiveDefault}" is empty (OMO council will have no councillors)`);
  }

  return {
    default_preset,
    effective_default_preset: effectiveDefault,
    defaultMissing: !!default_preset && !presetNames.has(default_preset),
    presets,
    coordinator: {
      agent: "council",
      note:
        "Coordinator/synthesis runs as the normal OMO 'council' agent (configured via agent systems). Councillors run through protected 'councillor' agent instances with each member's model.",
    },
    deprecated,
    warnings,
  };
}
