/**
 * Global OMO mutations (Slice 9): disabled lists, backgroundJobs, fallback,
 * image_routing, stripOrchestratorModel, UI/startup booleans, webfetch.
 */

import type { ServerConfig } from "../config";
import { applyJsoncPathEdit, getAtPath, hashContent } from "./jsonc-edit";
import type { RevisionStore } from "./revisions";
import type { OmoCandidateProducer, SchemaValidationSummary } from "@omo/shared";
import {
  BACKGROUND_JOBS_FIELDS,
  FALLBACK_FIELDS,
  PROTECTED_AGENTS,
} from "../omo/catalog";
import { MULTIPLEXER_FIELDS } from "../omo/multiplexer";
import {
  expectedSourceFromHash,
  fingerprintScope,
  previewOmoCandidate,
  previewThenCommit,
  type OmoTransactionDeps,
} from "./transaction";

export type FieldOp =
  | { operation: "unchanged" }
  | { operation: "set"; value: unknown }
  | { operation: "remove" };

export interface GlobalMutation {
  kind: "global-settings";
  scope: "user" | "project";
  disabled_agents?: FieldOp & { value?: string[] };
  disabled_skills?: FieldOp & { value?: string[] };
  disabled_mcps?: FieldOp & { value?: string[] };
  disabled_tools?: FieldOp & { value?: string[] };
  backgroundJobs?: Record<string, FieldOp>;
  fallback?: Record<string, FieldOp>;
  image_routing?: FieldOp;
  stripOrchestratorModel?: FieldOp;
  compactSidebar?: FieldOp;
  setDefaultAgent?: FieldOp;
  autoUpdate?: FieldOp;
  webfetch?: Record<string, FieldOp>;
  /**
   * Multiplexer config (Slice 16). Exactly four FieldOps keyed by the schema
   * field names: type, layout, main_pane_size, zellij_pane_mode.
   */
  multiplexer?: Record<string, FieldOp>;
  expectedSourceHash?: string;
}

export interface GlobalMutationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  revisionId?: string;
  targetPath?: string;
  oldHash?: string;
  newHash?: string;
  textDiff?: string;
  effectiveChanges?: Array<{ path: string; before: unknown; after: unknown }>;
  /** Installed-schema gate result for the full candidate document. */
  schemaValidation?: SchemaValidationSummary;
}

const LIST_KEYS = [
  "disabled_agents",
  "disabled_skills",
  "disabled_mcps",
  "disabled_tools",
] as const;

const BOOL_KEYS = [
  "stripOrchestratorModel",
  "compactSidebar",
  "setDefaultAgent",
  "autoUpdate",
] as const;

function expandEdits(m: GlobalMutation): Array<{ path: string[]; value: unknown }> {
  const edits: Array<{ path: string[]; value: unknown }> = [];

  for (const key of LIST_KEYS) {
    const op = m[key];
    if (!op || op.operation === "unchanged") continue;
    edits.push({
      path: [key],
      value: op.operation === "remove" ? undefined : op.value ?? [],
    });
  }

  for (const key of BOOL_KEYS) {
    const op = m[key];
    if (!op || op.operation === "unchanged") continue;
    edits.push({
      path: [key],
      value: op.operation === "remove" ? undefined : op.value,
    });
  }

  if (m.image_routing && m.image_routing.operation !== "unchanged") {
    edits.push({
      path: ["image_routing"],
      value:
        m.image_routing.operation === "remove"
          ? undefined
          : m.image_routing.value,
    });
  }

  if (m.backgroundJobs) {
    for (const [k, op] of Object.entries(m.backgroundJobs)) {
      if (!op || op.operation === "unchanged") continue;
      edits.push({
        path: ["backgroundJobs", k],
        value: op.operation === "remove" ? undefined : op.value,
      });
    }
  }

  if (m.fallback) {
    for (const [k, op] of Object.entries(m.fallback)) {
      if (!op || op.operation === "unchanged") continue;
      edits.push({
        path: ["fallback", k],
        value: op.operation === "remove" ? undefined : op.value,
      });
    }
  }

  if (m.webfetch) {
    for (const [k, op] of Object.entries(m.webfetch)) {
      if (!op || op.operation === "unchanged") continue;
      edits.push({
        path: ["webfetch", k],
        value: op.operation === "remove" ? undefined : op.value,
      });
    }
  }

  if (m.multiplexer) {
    for (const [k, op] of Object.entries(m.multiplexer)) {
      if (!op || op.operation === "unchanged") continue;
      edits.push({
        path: ["multiplexer", k],
        value: op.operation === "remove" ? undefined : op.value,
      });
    }
  }

  return edits;
}

function validateGlobal(m: GlobalMutation): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (m.disabled_agents?.operation === "set") {
    const list = m.disabled_agents.value ?? [];
    for (const a of list) {
      if (PROTECTED_AGENTS.has(a)) {
        errors.push(`Agent "${a}" is protected and cannot be disabled`);
      }
    }
  }

  const bj = m.backgroundJobs ?? {};
  for (const [k, op] of Object.entries(bj)) {
    if (!op || op.operation !== "set") continue;
    const spec = BACKGROUND_JOBS_FIELDS.find((f) => f.key === k);
    if (!spec) {
      errors.push(`Unknown backgroundJobs field: ${k}`);
      continue;
    }
    const v = op.value;
    if (spec.type === "int" || spec.type === "wallclock") {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        errors.push(`backgroundJobs.${k} must be a number`);
        continue;
      }
      if (spec.type === "wallclock" && v === 0) {
        // allowed = disabled
      } else {
        if (spec.min !== undefined && v < spec.min) {
          errors.push(`backgroundJobs.${k} minimum ${spec.min}`);
        }
        if (spec.max !== undefined && v > spec.max) {
          errors.push(`backgroundJobs.${k} maximum ${spec.max}`);
        }
      }
    }
    if (spec.type === "bool" && typeof v !== "boolean") {
      errors.push(`backgroundJobs.${k} must be boolean`);
    }
    if (spec.type === "enum" && !spec.enum?.includes(String(v))) {
      errors.push(`backgroundJobs.${k} must be one of ${spec.enum?.join(", ")}`);
    }
  }

  const fb = m.fallback ?? {};
  for (const [k, op] of Object.entries(fb)) {
    if (!op || op.operation !== "set") continue;
    const spec = FALLBACK_FIELDS.find((f) => f.key === k);
    if (!spec) {
      errors.push(`Unknown fallback field: ${k}`);
      continue;
    }
    const v = op.value;
    if (spec.type === "bool" && typeof v !== "boolean") {
      errors.push(`fallback.${k} must be boolean`);
    }
    if ((spec.type === "int" || spec.type === "num") && typeof v !== "number") {
      errors.push(`fallback.${k} must be number`);
    }
    if ((spec.type === "int" || spec.type === "num") && typeof v === "number") {
      if (spec.min !== undefined && v < spec.min)
        errors.push(`fallback.${k} minimum ${spec.min}`);
    }
  }

  if (m.image_routing?.operation === "set") {
    const v = m.image_routing.value;
    if (v !== "auto" && v !== "direct") {
      errors.push(`image_routing must be "auto" or "direct"`);
    }
  }

  for (const key of BOOL_KEYS) {
    const op = m[key];
    if (op?.operation === "set" && typeof op.value !== "boolean") {
      errors.push(`${key} must be boolean`);
    }
  }

  // Multiplexer (Slice 16): exactly four fields with enum/range validation.
  if (m.multiplexer) {
    const allowedKeys = new Set([
      "type",
      "layout",
      "main_pane_size",
      "zellij_pane_mode",
    ]);
    for (const [k, op] of Object.entries(m.multiplexer)) {
      if (!allowedKeys.has(k)) {
        errors.push(`Unknown multiplexer field: ${k}`);
        continue;
      }
      if (!op || op.operation !== "set") continue;
      const spec = MULTIPLEXER_FIELDS[k as keyof typeof MULTIPLEXER_FIELDS];
      if (!spec) {
        errors.push(`Unknown multiplexer field: ${k}`);
        continue;
      }
      const v = op.value;
      if (spec.enumValues) {
        if (typeof v !== "string" || !(spec.enumValues as readonly string[]).includes(v)) {
          errors.push(`multiplexer.${k} must be one of ${(spec.enumValues as readonly string[]).join(", ")}`);
        }
      } else if (typeof spec.minimum === "number" && typeof spec.maximum === "number") {
        if (typeof v !== "number" || !Number.isFinite(v)) {
          errors.push(`multiplexer.${k} must be a number`);
        } else {
          if (v < spec.minimum) errors.push(`multiplexer.${k} minimum ${spec.minimum}`);
          if (v > spec.maximum) errors.push(`multiplexer.${k} maximum ${spec.maximum}`);
        }
      }
    }
  }

  return { errors, warnings };
}

export const produceGlobalCandidate: OmoCandidateProducer<GlobalMutation> = (
  input,
) => {
  const { errors, warnings } = validateGlobal(input.input);
  const edits = expandEdits(input.input);
  if (!edits.length) errors.push("No changes requested");
  let afterText = input.beforeText;
  if (!errors.length) {
    for (const e of edits) afterText = applyJsoncPathEdit(afterText, e.path, e.value);
  }
  return {
    candidateText: afterText,
    featureErrors: errors,
    featureWarnings: warnings,
    intent: {
      kind: "global-settings",
      summary: "global-settings",
      propertyPaths: edits.map((e) => e.path.join(".")),
      mutationJson: JSON.stringify(input.input),
      property: edits.map((e) => e.path.join(".")).join(","),
    },
  };
};

function globalDeps(cfg: ServerConfig, revisions?: RevisionStore): OmoTransactionDeps {
  return {
    cfg,
    revisions: revisions ?? ({
      available: true,
      isScopeWriteBlocked: () => false,
      recoverPendingOmo: () => [],
    } as unknown as RevisionStore),
  };
}

export function simulateGlobal(
  cfg: ServerConfig,
  m: GlobalMutation,
): GlobalMutationResult & {
  currentHash?: string;
  createsFile?: boolean;
  beforeObj?: Record<string, unknown>;
  afterObj?: Record<string, unknown>;
} {
  const deps = globalDeps(cfg);
  const live = fingerprintScope(deps, m.scope);
  const preview = previewOmoCandidate(
    deps,
    {
      scope: m.scope,
      expectedSource: expectedSourceFromHash(live, m.expectedSourceHash),
      input: m,
    },
    produceGlobalCandidate,
  );
  const { warnings } = validateGlobal(m);
  const edits = expandEdits(m);
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
    targetPath: preview.target.path,
    currentHash: preview.source.sha256 ?? undefined,
    createsFile: !preview.target.exists,
    beforeObj: preview.beforeDocument,
    afterObj: preview.afterDocument,
    textDiff: preview.textDiff?.text,
    effectiveChanges,
    schemaValidation: preview.schemaValidation,
  };
}

export function applyGlobal(
  cfg: ServerConfig,
  m: GlobalMutation,
  revisions: RevisionStore,
): GlobalMutationResult {
  const deps = globalDeps(cfg, revisions);
  const live = fingerprintScope(deps, m.scope);
  const commit = previewThenCommit(
    deps,
    {
      scope: m.scope,
      expectedSource: expectedSourceFromHash(live, m.expectedSourceHash),
      input: m,
    },
    produceGlobalCandidate,
  );
  const edits = expandEdits(m);
  const effectiveChanges = edits
    .map((e) => ({
      path: e.path.join("."),
      before: commit.preview.beforeDocument
        ? getAtPath(commit.preview.beforeDocument, e.path)
        : undefined,
      after: commit.preview.afterDocument
        ? getAtPath(commit.preview.afterDocument, e.path)
        : undefined,
    }))
    .filter((c) => JSON.stringify(c.before) !== JSON.stringify(c.after));
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
    oldHash: hashContent(commit.preview.beforeText),
    newHash: commit.source?.sha256 ?? undefined,
    textDiff: commit.preview.textDiff?.text,
    effectiveChanges,
    schemaValidation: commit.preview.schemaValidation,
  };
}
