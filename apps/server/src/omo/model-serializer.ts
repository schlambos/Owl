/**
 * Canonical OMO agent-model serializer.
 *
 * This is the SINGLE place that turns a control-plane model fallback chain
 * into the JSON the installed oh-my-opencode-slim plugin accepts.
 *
 * Semantics (verified against installed oh-my-opencode-slim@2.2.10,
 * dist/index.js):
 *
 * - The runtime validator (AgentOverrideConfigSchema, dist:18731-18752)
 *   accepts `model` as a string OR an array (min 1) of
 *   string | { id: string, variant?: string }. A standalone
 *   { id, variant } OBJECT (outside an array) is rejected — this is the
 *   exact incident root cause (`"model": {"id": "xai/grok-4.5", ...}`).
 *
 * - Agent-level `variant` is an INDEPENDENT sibling property. It is NOT a
 *   default fall-through for chain entries: applyOverrides (dist:20001-20026)
 *   sets `agent.config.variant` only for primary-model dispatch; variants on
 *   individual array entries live inside the array and are untouched by the
 *   sibling. (Contrast with council members, where the member-level variant
 *   IS used as the default for chain entries missing one —
 *   normalizeCouncillorModels, dist:18550-18553, council-only behavior.)
 *
 * Therefore:
 * - Exactly one chain entry  → `"model": "<id>"` (plain string; NEVER an
 *   object, NEVER a one-element array) and the entry's variant is PROMOTED to
 *   the sibling `variant` property (returned as `promotedVariant`).
 * - Two or more entries      → ordered array; entries without a variant as
 *   plain `"<id>"` strings, entries with a variant as { id, variant }.
 *   `promotedVariant` is undefined: on single→multi transitions any existing
 *   sibling variant is left untouched (it is an independent property), and on
 *   multi→single transitions the surviving entry's variant is promoted.
 */

import type { ModelChainEntry } from "@omo/shared";

export interface SerializedOmoAgentModel {
  model: string | Array<string | { id: string; variant: string }>;
  /**
   * Variant promoted to the agent-level sibling `variant` property. Only set
   * for a single-entry chain whose entry carries a variant; callers must then
   * also write the sibling `variant` key. Undefined means "do not touch the
   * sibling variant key" (either bare single entry, or a multi-entry chain).
   */
  promotedVariant?: string;
}

export function serializeOmoAgentModel(
  chain: ModelChainEntry[],
): SerializedOmoAgentModel {
  if (!Array.isArray(chain)) {
    throw new Error("Model chain must be an array of entries");
  }
  const entries = chain.map((e) =>
    typeof e === "string" ? { id: e } : { id: e.id, variant: e.variant },
  );
  if (entries.length === 0) {
    // Structural validation (empty-chain rejection) is owned by the mutation
    // pipeline; keep this guard as the serializer invariant.
    throw new Error("Model chain cannot be empty");
  }
  if (entries.length === 1) {
    const only = entries[0]!;
    return { model: only.id, promotedVariant: only.variant };
  }
  return {
    model: entries.map((e) =>
      e.variant ? { id: e.id, variant: e.variant } : e.id,
    ),
  };
}
