/**
 * Agent config mutation adapters. Physical OMO JSON I/O lives in transaction.ts.
 */

import type {
  ApplyResult,
  ConfigMutation,
  ConfigValidationIssue,
  ModelChainEntry,
  OmoCandidateProducer,
  SimulationResult,
} from "@omo/shared";
import type { ServerConfig } from "../config";
import { applyJsoncPathEdit, getAtPath, hashContent } from "./jsonc-edit";
import type { RevisionStore } from "./revisions";
import { serializeOmoAgentModel } from "../omo/model-serializer";
import {
  commitOmoRevisionRestore,
  expectedSourceFromHash,
  fingerprintScope,
  previewOmoCandidate,
  previewThenCommit,
  type OmoTransactionDeps,
  type OmoTransactionPreviewInternal,
} from "./transaction";

/**
 * Backward-tolerant boundary normalization: the DTO type is
 * `ModelChainEntry[]` (always a chain) but legacy clients (and the pre-fix
 * UI) may send a bare string or standalone {id, variant} object. Normalize
 * into a one-element chain — NEVER propagate the standalone object form into
 * persisted JSON (the installed oh-my-opencode-slim schema rejects it; that
 * is the incident this pipeline guards against).
 */
function normalizeChainInput(model: unknown): ModelChainEntry[] {
  if (Array.isArray(model)) return model as ModelChainEntry[];
  if (typeof model === "string") return [model];
  if (model && typeof model === "object" && "id" in model) {
    return [model as ModelChainEntry];
  }
  return [];
}

function agentBasePath(m: ConfigMutation): string[] {
  if (m.kind === "prompt-file") {
    throw new Error("prompt-file not handled by config mutate pipeline");
  }
  if (m.destination.kind === "preset") {
    return ["presets", m.destination.preset, m.agent];
  }
  return ["agents", m.agent];
}

/** Expand mutation into ordered path edits (undefined value = remove key). */
export function mutationToEdits(
  m: ConfigMutation,
): Array<{ path: string[]; value: unknown }> {
  const base = agentBasePath(m);
  switch (m.kind) {
    case "agent-model": {
      const chain = normalizeChainInput(m.model);
      if (chain.length === 0) return []; // structural validation reports the empty chain
      const serialized = serializeOmoAgentModel(chain);
      const edits: Array<{ path: string[]; value: unknown }> = [
        { path: [...base, "model"], value: serialized.model },
      ];
      // Single entry with variant → promote to the independent sibling
      // `variant` property (canonical single-model form; see model-serializer).
      if (serialized.promotedVariant !== undefined) {
        edits.push({
          path: [...base, "variant"],
          value: serialized.promotedVariant,
        });
      }
      return edits;
    }
    case "agent-variant":
      return [
        {
          path: [...base, "variant"],
          value: m.variant === null ? undefined : m.variant,
        },
      ];
    case "agent-temperature":
      return [
        {
          path: [...base, "temperature"],
          value: m.temperature === null ? undefined : m.temperature,
        },
      ];
    case "agent-skills":
      return [
        {
          path: [...base, "skills"],
          value: m.skills === null ? undefined : m.skills,
        },
      ];
    case "agent-mcps":
      return [
        {
          path: [...base, "mcps"],
          value: m.mcps === null ? undefined : m.mcps,
        },
      ];
    case "agent-permission":
      return [
        {
          path: [...base, "permission"],
          value: m.permission === null ? undefined : m.permission,
        },
      ];
    case "agent-inline-prompt":
      return [
        {
          path: [...base, "prompt"],
          value: m.prompt === null ? undefined : m.prompt,
        },
      ];
    case "agent-orchestrator-prompt":
      return [
        {
          path: [...base, "orchestratorPrompt"],
          value: m.prompt === null ? undefined : m.prompt,
        },
      ];
    case "agent-capabilities": {
      const edits: Array<{ path: string[]; value: unknown }> = [];
      if (m.temperature) {
        edits.push({
          path: [...base, "temperature"],
          value: m.temperature.op === "remove" ? undefined : m.temperature.value,
        });
      }
      if (m.skills) {
        edits.push({
          path: [...base, "skills"],
          value: m.skills.op === "remove" ? undefined : m.skills.value,
        });
      }
      if (m.mcps) {
        edits.push({
          path: [...base, "mcps"],
          value: m.mcps.op === "remove" ? undefined : m.mcps.value,
        });
      }
      if (m.permission) {
        edits.push({
          path: [...base, "permission"],
          value:
            m.permission.op === "remove" ? undefined : m.permission.value,
        });
      }
      return edits;
    }
    default:
      return [];
  }
}

function applyEditsToText(
  text: string,
  edits: Array<{ path: string[]; value: unknown }>,
): string {
  let t = text;
  for (const e of edits) {
    t = applyJsoncPathEdit(t, e.path, e.value);
  }
  return t;
}

function jsonPathForMutation(m: ConfigMutation): string[] {
  const edits = mutationToEdits(m);
  return edits[0]?.path ?? agentBasePath(m);
}

function validateMutation(
  mutation: ConfigMutation,
): { errors: string[]; issues: ConfigValidationIssue[] } {
  const errors: string[] = [];
  const issues: ConfigValidationIssue[] = [];
  if (!mutation.agent || !/^[a-zA-Z0-9_-]+$/.test(mutation.agent)) {
    errors.push("Invalid agent name");
  }
  if (mutation.kind !== "prompt-file" && mutation.destination.kind === "preset") {
    if (!mutation.destination.preset) errors.push("Preset name required");
  }
  if (mutation.kind === "agent-model") {
    const chain = normalizeChainInput(mutation.model);
    if (chain.length === 0) {
      errors.push("Model chain cannot be empty");
    } else {
      const ids = chain.map((e) => (typeof e === "string" ? e : e.id));
      if (new Set(ids).size !== ids.length) {
        issues.push({
          level: "warning",
          code: "duplicate-fallback",
          message: "Fallback chain contains duplicate model ids",
        });
      }
    }
  }
  if (mutation.kind === "agent-temperature" && mutation.temperature != null) {
    if (mutation.temperature < 0 || mutation.temperature > 2) {
      errors.push("temperature must be between 0 and 2");
    }
  }
  if (mutation.kind === "agent-capabilities" && mutation.temperature?.op === "set") {
    if (mutation.temperature.value < 0 || mutation.temperature.value > 2) {
      errors.push("temperature must be between 0 and 2");
    }
  }
  if (
    mutation.kind === "agent-inline-prompt" ||
    mutation.kind === "agent-orchestrator-prompt"
  ) {
    if (mutation.prompt != null && mutation.prompt.length > 200_000) {
      errors.push("Prompt too large (>200KB)");
    }
  }
  if (mutation.kind === "prompt-file") {
    errors.push("prompt-file mutations use /api/config/prompt routes");
  }
  if (
    mutation.kind === "agent-capabilities" &&
    !mutation.temperature &&
    !mutation.skills &&
    !mutation.mcps &&
    !mutation.permission
  ) {
    errors.push("agent-capabilities mutation has no field operations");
  }
  if (
    (mutation.kind === "agent-inline-prompt" ||
      mutation.kind === "agent-orchestrator-prompt") &&
    mutation.prompt === ""
  ) {
    errors.push("Empty prompt string; use null to remove");
  }
  return { errors, issues };
}

export const produceAgentCandidate: OmoCandidateProducer<ConfigMutation> = (
  input,
) => {
  const { errors, issues } = validateMutation(input.input);
  const edits = mutationToEdits(input.input);
  if (edits.length === 0) errors.push("No edits produced");
  if (errors.length) {
    return {
      candidateText: input.beforeText,
      featureErrors: errors,
      featureWarnings: issues
        .filter((i) => i.level === "warning")
        .map((i) => i.message),
      intent: {
        kind: input.input.kind,
        summary: `${input.input.kind} ${input.input.agent}`,
        propertyPaths: edits.map((e) => e.path.join(".")),
        mutationJson: JSON.stringify(input.input),
        agent: input.input.agent,
        property: input.input.kind,
      },
    };
  }
  return {
    candidateText: applyEditsToText(input.beforeText, edits),
    featureErrors: [],
    featureWarnings: issues
      .filter((i) => i.level === "warning")
      .map((i) => i.message),
    intent: {
      kind: input.input.kind,
      summary: `${input.input.kind} ${input.input.agent}`,
      propertyPaths: edits.map((e) => e.path.join(".")),
      mutationJson: JSON.stringify(input.input),
      agent: input.input.agent,
      property: input.input.kind,
    },
  };
};

function depsOf(cfg: ServerConfig, revisions?: RevisionStore): OmoTransactionDeps {
  if (!revisions) {
    return {
      cfg,
      revisions: {
        available: true,
        isScopeWriteBlocked: () => false,
        recoverPendingOmo: () => [],
        get: () => null,
        list: () => [],
        preparePending() {},
        markCommitted() {},
        markAbandoned() {},
        markConflict() {},
        isOmoRevisionTarget: () => true,
        isRestoreEligible: () => true,
      } as unknown as RevisionStore,
    };
  }
  return { cfg, revisions };
}

function previewToSimulation(
  cfg: ServerConfig,
  mutation: ConfigMutation,
  preview: OmoTransactionPreviewInternal,
): SimulationResult {
  const edits = mutationToEdits(mutation);
  const jsonPath = jsonPathForMutation(mutation);
  const currentValue =
    preview.beforeDocument && edits.length === 1
      ? getAtPath(preview.beforeDocument, edits[0]!.path)
      : preview.beforeDocument
        ? Object.fromEntries(
            edits.map((e) => [
              e.path.join("."),
              getAtPath(preview.beforeDocument, e.path),
            ]),
          )
        : undefined;
  const proposedValue =
    preview.afterDocument && edits.length === 1
      ? getAtPath(preview.afterDocument, edits[0]!.path)
      : preview.afterDocument
        ? Object.fromEntries(
            edits.map((e) => [
              e.path.join("."),
              getAtPath(preview.afterDocument, e.path),
            ]),
          )
        : undefined;
  const agent = mutation.agent;
  const primaryField =
    mutation.kind === "agent-model"
      ? "model"
      : mutation.kind === "agent-variant"
        ? "variant"
        : mutation.kind === "agent-temperature"
          ? "temperature"
          : mutation.kind === "agent-skills"
            ? "skills"
            : mutation.kind === "agent-mcps"
              ? "mcps"
              : mutation.kind === "agent-permission"
                ? "permission"
                : mutation.kind === "agent-inline-prompt"
                  ? "prompt"
                  : mutation.kind === "agent-orchestrator-prompt"
                    ? "orchestratorPrompt"
                    : "capabilities";
  const pathKey = `agents.${agent}.${primaryField}`;
  const effectiveBefore = preview.beforeBundle?.properties[pathKey]?.value;
  const effectiveAfter = preview.afterBundle?.properties[pathKey]?.value;
  const interestSuffixes = [
    ".model",
    ".variant",
    ".temperature",
    ".skills",
    ".mcps",
    ".permission",
    ".prompt",
    ".orchestratorPrompt",
  ];
  const effectiveChanged = preview.provenanceChanges
    .filter(
      (c) =>
        c.path.startsWith("agents.") &&
        interestSuffixes.some((s) => c.path.endsWith(s) || c.path.includes(s + ".")),
    )
    .map((c) => ({
      path: c.path,
      before: c.before?.value,
      after: c.after?.value,
    }));
  const masked =
    JSON.stringify(currentValue) !== JSON.stringify(proposedValue) &&
    JSON.stringify(effectiveBefore) === JSON.stringify(effectiveAfter) &&
    effectiveChanged.length === 0;
  const issues: ConfigValidationIssue[] = [
    ...preview.semanticValidation.issues,
    ...(masked
      ? [
          {
            level: "warning" as const,
            code: "masked-write",
            message: `This write may not change the effective ${agent}.${primaryField}. Another higher-priority source may still win after load-time resolution.`,
            path: pathKey,
          },
        ]
      : []),
  ];
  const warnings = [...preview.warnings];
  if (masked) warnings.push(issues[issues.length - 1]!.message);
  const ok =
    preview.ok &&
    preview.errors.length === 0 &&
    !issues.some((i) => i.level === "error");
  return {
    ok,
    mutation,
    targetPath: preview.target.path,
    jsonPath,
    scope: mutation.scope,
    createsFile: !preview.target.exists,
    currentHash: preview.source.sha256 ?? undefined,
    currentValue,
    proposedValue,
    textDiff: preview.textDiff?.text,
    effectiveBefore,
    effectiveAfter,
    effectiveChanged,
    masked,
    validation: { ok, issues },
    schemaValidation: preview.schemaValidation,
    warnings,
    errors: preview.errors,
    liveNote:
      preview.code === "schema-invalid" || preview.code === "schema-unavailable"
        ? "No write performed. Candidate rejected by the installed oh-my-opencode-slim schema (fail-closed)."
        : "Live OpenCode agent state is independent. It may remain unchanged until OpenCode/OMO reloads configuration. New sessions may pick up changes depending on host behavior.",
  };
  void cfg;
}

export function simulateMutation(
  cfg: ServerConfig,
  mutation: ConfigMutation,
): SimulationResult {
  let live;
  try {
    live = fingerprintScope(depsStub(cfg), mutation.scope);
  } catch (e) {
    return {
      ok: false,
      mutation,
      targetPath: "",
      jsonPath: jsonPathForMutation(mutation),
      scope: mutation.scope,
      createsFile: false,
      effectiveChanged: [],
      masked: false,
      validation: { ok: false, issues: [] },
      warnings: [],
      errors: [e instanceof Error ? e.message : String(e)],
      liveNote: "Simulation failed.",
    };
  }
  const preview = previewOmoCandidate(
    depsStub(cfg),
    {
      scope: mutation.scope,
      expectedSource: expectedSourceFromHash(live, mutation.expectedSourceHash),
      input: mutation,
    },
    produceAgentCandidate,
  );
  return previewToSimulation(cfg, mutation, preview);
}

function depsStub(cfg: ServerConfig): OmoTransactionDeps {
  return depsOf(cfg);
}

export function applyMutation(
  cfg: ServerConfig,
  mutation: ConfigMutation,
  revisions: RevisionStore,
): ApplyResult {
  const deps = depsOf(cfg, revisions);
  let live;
  try {
    live = fingerprintScope(deps, mutation.scope);
  } catch (e) {
    return {
      ok: false,
      errors: [e instanceof Error ? e.message : String(e)],
    };
  }
  const commit = previewThenCommit(
    deps,
    {
      scope: mutation.scope,
      expectedSource: expectedSourceFromHash(live, mutation.expectedSourceHash),
      input: mutation,
    },
    produceAgentCandidate,
  );
  const simulation = previewToSimulation(cfg, mutation, commit.preview);
  if (!commit.ok) {
    return {
      ok: false,
      simulation,
      schemaValidation: commit.preview.schemaValidation,
      errors: commit.errors.length ? commit.errors : ["Simulation failed"],
      conflict:
        commit.code === "stale-source"
          ? {
              path: commit.preview.target.path,
              expectedHash: mutation.expectedSourceHash,
              actualHash: commit.preview.source.sha256 ?? "",
              message: commit.errors.join("; "),
            }
          : undefined,
    };
  }
  return {
    ok: true,
    revisionId: commit.revisionId,
    targetPath: commit.preview.target.path,
    oldHash: hashContent(commit.preview.beforeText),
    newHash: commit.source?.sha256 ?? undefined,
    simulation: {
      ...simulation,
      currentHash: hashContent(commit.preview.beforeText),
    },
    schemaValidation: commit.preview.schemaValidation,
    errors: [],
    effectiveChanged: simulation.effectiveChanged,
  };
}

export function restoreRevision(
  cfg: ServerConfig,
  revisionId: string,
  revisions: RevisionStore,
  expectedSourceHash?: string,
): ApplyResult {
  const deps = depsOf(cfg, revisions);
  const rev = revisions.get(revisionId);
  if (!rev) return { ok: false, errors: [`Revision not found: ${revisionId}`] };
  const live = fingerprintScope(deps, rev.scope);
  const expectedSource = expectedSourceFromHash(live, expectedSourceHash);
  const preview = previewOmoCandidate(
    deps,
    {
      scope: rev.scope,
      expectedSource,
      input: { revisionId },
    },
    () => ({
      candidateText: rev.beforeContent,
      featureErrors: [],
      featureWarnings: [],
      intent: {
        kind: "restore",
        summary: `Restore of ${revisionId}`,
        propertyPaths: [],
        mutationJson: JSON.stringify({ kind: "restore", restoredFrom: revisionId }),
        agent: rev.agent,
        property: rev.property,
      },
    }),
  );
  const commit = commitOmoRevisionRestore(deps, {
    scope: rev.scope,
    revisionId,
    expectedSource,
    expectedCandidateSha256: preview.candidateSha256 ?? hashContent(rev.beforeContent),
  });
  if (!commit.ok) {
    return {
      ok: false,
      schemaValidation: commit.preview.schemaValidation,
      errors:
        commit.code === "stale-source"
          ? ["CONFIGURATION CHANGED EXTERNALLY"]
          : commit.errors,
      conflict:
        commit.code === "stale-source"
          ? {
              path: commit.preview.target.path,
              expectedHash: expectedSourceHash,
              actualHash: live.sha256 ?? "",
              message: "CONFIGURATION CHANGED EXTERNALLY",
            }
          : undefined,
    };
  }
  return {
    ok: true,
    revisionId: commit.revisionId,
    targetPath: commit.preview.target.path,
    oldHash: hashContent(commit.preview.beforeText),
    newHash: commit.source?.sha256 ?? undefined,
    errors: [],
  };
}
