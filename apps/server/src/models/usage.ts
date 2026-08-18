/**
 * Model → usage reference map (Slice 15, Lane 1).
 *
 * Enumerates every model referenced by the effective configuration,
 * mirroring the enumeration in doctor/rules-core.ts providerModelRules
 * (agents' primary/fallbacks, ALL council presets' members, ACP wrapper
 * models). Pure + side-effect free; callers assemble the inventories.
 *
 * Key format: "provider\0model" (modelKey from ./constants).
 */

import type { EffectiveAgent, ModelUsageReference } from "@omo/shared";
import type { AcpInventory } from "../cfgwrite/acp";
import type { CouncilInventory } from "../cfgwrite/council";
import { modelKey, splitModelKey, splitModelRef } from "./constants";

export interface ModelUsageSources {
  /** Effective agents (omo.effective.agents). */
  agents: Record<string, EffectiveAgent> | EffectiveAgent[];
  council?: CouncilInventory;
  acp?: AcpInventory;
}

/**
 * Build the referenced-model usage map.
 *
 *  - agent primary   → agent-primary,   fallback: false
 *  - agent fallbacks → agent-fallback,  fallback: true
 *      active = effective-enabled (disabled agents → active: false)
 *  - council members (ALL presets) → council-member
 *      active = member of the default/effective preset; inactive otherwise
 *  - ACP wrapperModel → acp-wrapper
 *      active = wrapper enabled (not disabled)
 */
export function buildModelUsage(
  src: ModelUsageSources,
): Map<string, ModelUsageReference[]> {
  const out = new Map<string, ModelUsageReference[]>();
  const add = (modelRef: string, ref: ModelUsageReference) => {
    const parsed = splitModelRef(modelRef);
    if (!parsed) return;
    const key = modelKey(parsed.providerId, parsed.modelId);
    const list = out.get(key);
    if (list) list.push(ref);
    else out.set(key, [ref]);
  };

  const agents = Array.isArray(src.agents)
    ? src.agents
    : Object.values(src.agents);
  for (const a of agents) {
    if (a.modelPrimary) {
      add(a.modelPrimary, {
        kind: "agent-primary",
        ownerId: a.name,
        label: a.displayName ?? a.name,
        active: a.enabled,
        fallback: false,
      });
    }
    for (const fb of a.modelFallbacks) {
      add(fb, {
        kind: "agent-fallback",
        ownerId: a.name,
        label: `${a.displayName ?? a.name} (fallback)`,
        active: a.enabled,
        fallback: true,
      });
    }
  }

  if (src.council) {
    for (const preset of src.council.presets) {
      for (const m of preset.members) {
        if (!m.modelPrimary) continue;
        add(m.modelPrimary, {
          kind: "council-member",
          ownerId: `council.${preset.name}.${m.name}`,
          label: `Council ${preset.name} / ${m.name}`,
          active: preset.isDefault,
          fallback: false,
        });
      }
    }
  }

  if (src.acp) {
    for (const a of src.acp.agents) {
      if (!a.wrapperModel) continue;
      add(a.wrapperModel, {
        kind: "acp-wrapper",
        ownerId: `acp.${a.name}`,
        label: `ACP ${a.name}`,
        active: a.disabled !== true,
        fallback: false,
      });
    }
  }

  return out;
}

export interface EffectiveProbeSetContext {
  /** Names of effective agents that are enabled. */
  enabledAgents: string[];
  /** Effective/default council preset name (council inventory). */
  defaultCouncilPreset?: string;
  /** Names of ACP wrappers that are enabled. */
  activeAcpWrappers: string[];
}

/**
 * Unique model list for "Probe Effective Models": enabled effective agents'
 * primary + fallbacks, default council preset members, active ACP wrappers.
 * Inactive presets are EXCLUDED. Deterministic order (provider, then model).
 */
export function computeEffectiveProbeSet(
  usage: Map<string, ModelUsageReference[]>,
  ctx: EffectiveProbeSetContext,
): Array<{ providerId: string; modelId: string }> {
  const enabledAgents = new Set(ctx.enabledAgents);
  const activeWrappers = new Set(ctx.activeAcpWrappers);
  const councilPrefix =
    ctx.defaultCouncilPreset !== undefined
      ? `council.${ctx.defaultCouncilPreset}.`
      : undefined;

  const out: Array<{ providerId: string; modelId: string }> = [];
  for (const [key, refs] of usage) {
    const include = refs.some((ref) => {
      if (!ref.active) return false;
      switch (ref.kind) {
        case "agent-primary":
        case "agent-fallback":
          return enabledAgents.has(ref.ownerId);
        case "council-member":
          return councilPrefix !== undefined && ref.ownerId.startsWith(councilPrefix);
        case "acp-wrapper":
          return activeWrappers.has(ref.ownerId.slice("acp.".length));
      }
    });
    if (include) out.push(splitModelKey(key));
  }
  out.sort(
    (a, b) =>
      a.providerId.localeCompare(b.providerId) ||
      a.modelId.localeCompare(b.modelId),
  );
  return out;
}
