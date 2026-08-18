import type {
  ModelAvailability,
  ModelProbeState,
  ModelUsageReference,
} from "@omo/shared";
import type { ModelProbeBatchResult } from "../api";
import { probeAgo } from "./ProbeBadge";

export const PROBE_FILTERS: Array<{
  key: string;
  label: string;
  states: ModelProbeState[];
}> = [
  { key: "healthy", label: "Healthy", states: ["healthy"] },
  { key: "unauthorized", label: "Unauthorized", states: ["unauthorized"] },
  { key: "model-not-found", label: "Model not found", states: ["model-not-found"] },
  { key: "rate-limited", label: "Rate limited", states: ["rate-limited"] },
  { key: "timeout", label: "Timeout", states: ["timeout"] },
  { key: "never-tested", label: "Not tested", states: ["never"] },
  {
    key: "error-states",
    label: "Errors",
    states: [
      "provider-disconnected",
      "opencode-disconnected",
      "malformed",
      "error",
    ],
  },
  { key: "running", label: "Running", states: ["running"] },
];

export const LARGE_BATCH_THRESHOLD = 25;

export const MODEL_DRAWER_TITLE_ID = "model-detail-drawer-title";
export const MODEL_BATCH_TITLE_ID = "model-batch-dialog-title";

export interface ModelRefId {
  providerId: string;
  modelId: string;
}

export function ago(iso?: string): string {
  return probeAgo(iso) ?? "—";
}

export function modelKey(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

export function dedupeModels(models: ModelRefId[]): ModelRefId[] {
  const seen = new Set<string>();
  const out: ModelRefId[] = [];
  for (const m of models) {
    const k = modelKey(m.providerId, m.modelId);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  return out;
}

export function dedupedCount(res: ModelProbeBatchResult): number {
  const d = res.deduped;
  if (Array.isArray(d)) return d.length;
  return typeof d === "number" ? d : 0;
}

/** Compact usage cell labels: "Explorer", "Fallback · Oracle", "Council", "ACP". */
export function usageLabel(u: ModelUsageReference): string {
  const label = u.label || u.ownerId;
  switch (u.kind) {
    case "agent-primary":
      return label;
    case "agent-fallback":
      return `Fallback · ${label}`;
    case "council-member":
      return label.startsWith("Council") ? label : `Council · ${label}`;
    case "acp-wrapper":
      return label.startsWith("ACP") ? label : `ACP · ${label}`;
  }
}

export function capabilityCell(v: boolean | undefined): string {
  return v === true ? "Yes" : v === false ? "No" : "Unknown";
}

/**
 * Readable label when OpenCode supplies a catalog name that differs from the
 * technical id. Never invents a pretty-name — falls back to the model id.
 */
export function modelDisplayName(
  modelId: string,
  catalogName?: string,
): string {
  const name = catalogName?.trim();
  if (name && name !== modelId) return name;
  return modelId;
}

export function catalogNameFor(
  providerId: string,
  modelId: string,
  names: ReadonlyMap<string, string> | undefined,
): string | undefined {
  if (!names) return undefined;
  const n = names.get(modelKey(providerId, modelId));
  return n && n !== modelId ? n : undefined;
}

export function probeDisabledReason(
  ocDisconnected: boolean,
  providerConnected: boolean,
): string | undefined {
  if (ocDisconnected) return "OpenCode is disconnected";
  if (!providerConnected) return "Provider is not connected in OpenCode";
  return undefined;
}

export function isProblemProbe(state: ModelProbeState): boolean {
  return (
    state === "unauthorized" ||
    state === "model-not-found" ||
    state === "rate-limited" ||
    state === "timeout" ||
    state === "provider-disconnected" ||
    state === "opencode-disconnected" ||
    state === "malformed" ||
    state === "error"
  );
}

export function findModelTrigger(
  providerId: string,
  modelId: string,
): HTMLElement | null {
  const els = document.querySelectorAll<HTMLElement>("[data-model-trigger]");
  for (const el of Array.from(els)) {
    if (
      el.getAttribute("data-provider-id") === providerId &&
      el.getAttribute("data-model-id") === modelId
    ) {
      return el;
    }
  }
  return null;
}

export function referencedModels(models: ModelAvailability[]): ModelRefId[] {
  return dedupeModels(models.filter((m) => m.usage.length > 0));
}

/** Effective set: active agent primaries, fallbacks, council, ACP wrappers. */
export function effectiveModels(models: ModelAvailability[]): ModelRefId[] {
  return dedupeModels(
    models.filter((m) =>
      m.usage.some(
        (u) =>
          u.active &&
          (u.kind === "agent-primary" ||
            u.kind === "agent-fallback" ||
            u.kind === "council-member" ||
            u.kind === "acp-wrapper"),
      ),
    ),
  );
}
