import type {
  ConfigWriteScope,
  LiveProvider,
  ModelAvailability,
  ModelChainEntry,
  ModelProbeState,
  PropertyCandidate,
} from "@omo/shared";
import type { ModelAvailabilityContextValue } from "../../../models/ModelAvailabilityContext";
import type {
  ChainEntryState,
  DestinationChoice,
  DestKind,
  ProbeCandidate,
} from "./types";

export const PROBE_FAILURE_STATES: ReadonlySet<ModelProbeState> = new Set([
  "unauthorized",
  "model-not-found",
  "rate-limited",
  "timeout",
  "malformed",
  "error",
]);

export function splitModelId(raw: string): { providerId: string; modelId: string } {
  const i = raw.indexOf("/");
  if (i < 0) return { providerId: "", modelId: raw };
  return { providerId: raw.slice(0, i), modelId: raw.slice(i + 1) };
}

export function seedEntry(
  key: number,
  raw: string,
  variant: string,
  knownProviders: ReadonlySet<string>,
): ChainEntryState {
  const { providerId, modelId } = splitModelId(raw);
  const catalog = providerId !== "" && knownProviders.has(providerId);
  return {
    key,
    mode: raw === "" || catalog ? "catalog" : "manual",
    providerId,
    modelId,
    manualId: raw,
    variant,
  };
}

export function entryRawId(e: ChainEntryState): string {
  if (e.mode === "manual") return e.manualId.trim();
  if (!e.providerId || !e.modelId) return "";
  return `${e.providerId}/${e.modelId}`;
}

export function serializeEntry(e: ChainEntryState): ModelChainEntry {
  const id = entryRawId(e);
  const v = e.variant.trim();
  return v ? { id, variant: v } : id;
}

export function entryCandidate(e: ChainEntryState): ProbeCandidate | null {
  if (e.mode === "manual") {
    const { providerId, modelId } = splitModelId(e.manualId.trim());
    return providerId && modelId ? { providerId, modelId } : null;
  }
  return e.providerId && e.modelId
    ? { providerId: e.providerId, modelId: e.modelId }
    : null;
}

export function probeOf(
  avail: ModelAvailabilityContextValue | null,
  cand: ProbeCandidate | null,
): ModelAvailability | undefined {
  if (!avail || !cand) return undefined;
  return avail.getModel(cand.providerId, cand.modelId);
}

export function probeCodeSuffix(av: ModelAvailability | undefined): string {
  const p = av?.probe;
  if (!p) return "";
  if (p.statusCode != null) return ` · ${p.statusCode}`;
  if (p.errorCode) return ` · ${p.errorCode}`;
  return "";
}

export function probeTestTitle(
  cand: ProbeCandidate | null,
  ocDisconnected: boolean,
  providerConnected: boolean,
): string {
  if (!cand) return "Pick a provider and model first";
  if (ocDisconnected) return "OpenCode is disconnected";
  if (!providerConnected) return "Provider is not connected in OpenCode";
  return "Probe this model through OpenCode (read-only — does not change configuration)";
}

/** Map a provenance winner to the write destination that reproduces it. */
export function destinationForWinner(
  w: PropertyCandidate,
): DestinationChoice | null {
  switch (w.stage) {
    case "preset":
      return { scope: w.scope === "project" ? "project" : "user", kind: "preset" };
    case "root-agent":
      return {
        scope: w.scope === "project" ? "project" : "user",
        kind: "root-agent",
      };
    case "project-config":
      return { scope: "project", kind: "root-agent" };
    case "user-config":
      return { scope: "user", kind: "root-agent" };
    default:
      return null;
  }
}

export function destDescription(
  scope: ConfigWriteScope,
  kind: DestKind,
  preset: string | undefined,
): string {
  const where = scope === "user" ? "user" : "project";
  return kind === "preset"
    ? `the ${where} preset "${preset ?? "—"}"`
    : `the ${where} root agent override (agents.<name>)`;
}

export function destPlainLabel(
  scope: ConfigWriteScope,
  kind: DestKind,
  preset: string | undefined,
): string {
  if (scope === "user" && kind === "preset") {
    return preset ? `Your user preset “${preset}”` : "Your user preset";
  }
  if (scope === "user" && kind === "root-agent") {
    return "A user-level override for this agent";
  }
  if (scope === "project" && kind === "preset") {
    return preset
      ? `This project’s preset “${preset}”`
      : "This project’s preset";
  }
  return "A project-level override for this agent";
}

export function normId(s?: string): string | undefined {
  const t = s?.trim();
  return t || undefined;
}

export function modelsDiffer(a?: string, b?: string): boolean {
  const na = normId(a);
  const nb = normId(b);
  if (!na && !nb) return false;
  if (!na || !nb) return true;
  return na !== nb;
}

export type LayerAlignment =
  | "aligned"
  | "assignment-override"
  | "runtime-drift"
  | "both"
  | "unconfigured"
  | "unconfigured-live";

export function layerAlignment(
  assigned?: string,
  effective?: string,
  live?: string,
): LayerAlignment {
  const a = normId(assigned);
  const e = normId(effective);
  const l = normId(live);
  if (a == null && e == null && l == null) return "unconfigured";
  if (a == null && e == null && l != null) return "unconfigured-live";
  const assignOverride = a != null && modelsDiffer(a, e);
  const runtimeDrift = l != null && modelsDiffer(e, l);
  if (assignOverride && runtimeDrift) return "both";
  if (assignOverride) return "assignment-override";
  if (runtimeDrift) return "runtime-drift";
  return "aligned";
}

export function modelDisplayName(
  providerId: string,
  modelId: string,
  providers: readonly LiveProvider[],
): string {
  const p = providers.find((x) => x.id === providerId);
  const m = p?.models.find((x) => x.id === modelId);
  return m?.name && m.name !== modelId ? m.name : modelId;
}

export function formatModelRef(
  raw: string | undefined,
  providers: readonly LiveProvider[],
): { display: string; provider: string; id: string } | null {
  const id = normId(raw);
  if (!id) return null;
  const { providerId, modelId } = splitModelId(id);
  const p = providers.find((x) => x.id === providerId);
  const display = modelDisplayName(providerId, modelId, providers);
  return {
    display,
    provider: p?.name && p.name !== providerId ? p.name : providerId || "—",
    id,
  };
}

export function chainEntryLabel(entry: ModelChainEntry): string {
  return typeof entry === "string" ? entry : entry.id;
}

export function fallbackCountOf(value: unknown): number {
  if (Array.isArray(value)) return Math.max(0, value.length - 1);
  return 0;
}

export function primaryIdOf(value: unknown): string | undefined {
  if (typeof value === "string") return normId(value);
  if (Array.isArray(value) && value.length > 0) {
    const first = value[0];
    if (typeof first === "string") return normId(first);
    if (first && typeof first === "object" && "id" in first) {
      return normId(String((first as { id?: unknown }).id ?? ""));
    }
  }
  if (value && typeof value === "object" && "id" in (value as object)) {
    return normId(String((value as { id?: unknown }).id ?? ""));
  }
  return undefined;
}
