/**
 * Model inventory composition (Slice 15, Lane 1).
 *
 * Composes ModelInventoryDto / ModelAvailabilityDetail from:
 *  - runtime snapshot provider catalog (advertised models)
 *  - connected-provider authority
 *  - usage reference map (configured models)
 *  - probe store latest-per-model (persisted + overlay, merged upstream)
 *  - live queue snapshot
 *
 * Model union: advertised + referenced + history-only. Capability and
 * metadata fields are whitelisted only (never provider keys/options).
 * Deterministic, pure, side-effect free.
 */

import type {
  LiveModel,
  LiveProvider,
  ModelAvailability,
  ModelAvailabilityCapabilities,
  ModelAvailabilityDetail,
  ModelInventoryDto,
  ModelProbeQueueSnapshot,
  ModelProbeRun,
  ModelProbeState,
  ModelUsageReference,
  ProviderDiagnostics,
} from "@omo/shared";
import { modelKey, splitModelKey } from "./constants";
import { classifyFreshness } from "./probe-normalize";
import type { ProbeProviderStats } from "./probe-store";

export interface ModelInventorySources {
  /** Runtime snapshot provider catalog. */
  providers: LiveProvider[];
  /** Connected-provider authority ids. */
  connected: string[];
  /** Auth-method metadata per provider (client providerAuth, soft-fail {}). */
  authMethods: Record<string, Array<{ type: string; label: string }>>;
  /** Referenced-model usage map from buildModelUsage(). */
  usage: Map<string, ModelUsageReference[]>;
  /** Latest probe per model — persisted rows + overlay already merged. */
  probeLatest: Map<string, ModelProbeRun>;
  queue: ModelProbeQueueSnapshot;
  providerProbeStats: Map<string, ProbeProviderStats>;
  nowMs?: number;
}

const NONE_SOURCE = "none" as const;

function capabilitiesOf(
  advertised: LiveModel | undefined,
): ModelAvailabilityCapabilities {
  if (!advertised) {
    return { state: "unknown", source: NONE_SOURCE };
  }
  const source = advertised.metadataSource ?? "opencode:/config/providers";
  if (!advertised.capabilities) {
    return { state: "partial", source };
  }
  const c = advertised.capabilities;
  // Deterministic rule (Slice 15): tools←toolcall, vision←input.image,
  // reasoning←reasoning. structuredOutput/toolIds stay undefined.
  return {
    state: "known",
    ...(c.toolcall !== undefined ? { tools: c.toolcall } : {}),
    ...(c.input?.image !== undefined ? { vision: c.input.image } : {}),
    ...(c.reasoning !== undefined ? { reasoning: c.reasoning } : {}),
    source,
  };
}

export function buildModelAvailability(
  src: ModelInventorySources,
  providerId: string,
  modelId: string,
): ModelAvailability {
  const nowMs = src.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  const catalog = src.providers.find((p) => p.id === providerId);
  const advertisedModel = catalog?.models.find((m) => m.id === modelId);
  const connected = src.connected.includes(providerId);
  const key = modelKey(providerId, modelId);
  const latest = src.probeLatest.get(key);
  const inQueue =
    src.queue.pending.some(
      (i) => i.providerId === providerId && i.modelId === modelId,
    ) ||
    src.queue.running.some(
      (i) => i.providerId === providerId && i.modelId === modelId,
    );

  const state: ModelProbeState = inQueue
    ? "running"
    : (latest?.state ?? "never");
  const probe: ModelAvailability["probe"] = {
    state,
    freshness: classifyFreshness(latest?.completedAt, nowMs),
    ...(latest?.startedAt ? { lastStartedAt: latest.startedAt } : {}),
    ...(latest?.completedAt ? { lastCompletedAt: latest.completedAt } : {}),
    ...(latest?.latencyMs !== undefined ? { latencyMs: latest.latencyMs } : {}),
    ...(latest?.statusCode !== undefined ? { statusCode: latest.statusCode } : {}),
    ...(latest?.errorCode !== undefined ? { errorCode: latest.errorCode } : {}),
    ...(latest?.errorMessage !== undefined
      ? { errorMessage: latest.errorMessage }
      : {}),
    ...(latest?.responseModel !== undefined
      ? { responseModel: latest.responseModel }
      : {}),
  };

  const usage = src.usage.get(key) ?? [];
  return {
    providerId,
    modelId,
    configured: usage.length > 0,
    provider: { known: catalog !== undefined, connected },
    advertised: advertisedModel !== undefined,
    probe,
    capabilities: capabilitiesOf(advertisedModel),
    lastUpdatedAt: latest?.completedAt ?? latest?.startedAt ?? generatedAt,
    usage: usage.map((u) => ({ ...u })),
    ...(advertisedModel?.limit
      ? {
          limit: {
            ...(advertisedModel.limit.context !== undefined
              ? { context: advertisedModel.limit.context }
              : {}),
            ...(advertisedModel.limit.output !== undefined
              ? { output: advertisedModel.limit.output }
              : {}),
          },
        }
      : {}),
    ...(typeof advertisedModel?.status === "string"
      ? { status: advertisedModel.status }
      : {}),
  };
}

/** True when the model exists in ANY source (advertised/referenced/history). */
export function isModelKnown(
  src: ModelInventorySources,
  providerId: string,
  modelId: string,
): boolean {
  const key = modelKey(providerId, modelId);
  if (src.usage.has(key)) return true;
  if (src.probeLatest.has(key)) return true;
  const catalog = src.providers.find((p) => p.id === providerId);
  return catalog?.models.some((m) => m.id === modelId) ?? false;
}

/**
 * Model union (advertised + referenced + history-only) as sorted
 * provider/model pairs.
 */
export function unionModels(
  src: ModelInventorySources,
): Array<{ providerId: string; modelId: string }> {
  const keys = new Set<string>();
  for (const p of src.providers) {
    for (const m of p.models) keys.add(modelKey(p.id, m.id));
  }
  for (const k of src.usage.keys()) keys.add(k);
  for (const k of src.probeLatest.keys()) keys.add(k);
  return [...keys].map(splitModelKey).sort(
    (a, b) =>
      a.providerId.localeCompare(b.providerId) ||
      a.modelId.localeCompare(b.modelId),
  );
}

function buildProviderDiagnostics(
  src: ModelInventorySources,
  models: Array<{ providerId: string; modelId: string }>,
): ProviderDiagnostics[] {
  const ids = new Set<string>();
  for (const p of src.providers) ids.add(p.id);
  for (const k of src.usage.keys()) ids.add(splitModelKey(k).providerId);
  for (const k of src.probeLatest.keys()) ids.add(splitModelKey(k).providerId);

  const referenced = new Map<string, number>();
  for (const k of src.usage.keys()) {
    const pid = splitModelKey(k).providerId;
    referenced.set(pid, (referenced.get(pid) ?? 0) + 1);
  }

  return [...ids].sort().map((providerId) => {
    const catalog = src.providers.find((p) => p.id === providerId);
    const stats = src.providerProbeStats.get(providerId);
    return {
      providerId,
      ...(catalog?.name ? { name: catalog.name } : {}),
      known: catalog !== undefined,
      connected: src.connected.includes(providerId),
      advertisedCount: catalog?.modelCount ?? 0,
      referencedCount: referenced.get(providerId) ?? 0,
      authMethods: src.authMethods[providerId] ?? [],
      ...(stats?.lastSuccessfulProbeAt
        ? { lastSuccessfulProbeAt: stats.lastSuccessfulProbeAt }
        : {}),
      recentFailureCounts: stats?.recentFailureCounts ?? {},
      recentRateLimitCount: stats?.recentRateLimitCount ?? 0,
    };
  });
}

export function buildModelInventory(
  src: ModelInventorySources,
): ModelInventoryDto {
  const nowMs = src.nowMs ?? Date.now();
  const models = unionModels(src).map(({ providerId, modelId }) =>
    buildModelAvailability({ ...src, nowMs }, providerId, modelId),
  );
  return {
    generatedAt: new Date(nowMs).toISOString(),
    models,
    providers: buildProviderDiagnostics(src, models),
    queue: src.queue,
  };
}

/**
 * Detail for one model: availability + probe history (newest-first).
 * Undefined when the model is unknown in every source.
 */
export function buildModelInventoryDetail(
  src: ModelInventorySources,
  providerId: string,
  modelId: string,
  history: ModelProbeRun[],
): ModelAvailabilityDetail | undefined {
  if (!isModelKnown(src, providerId, modelId)) return undefined;
  return {
    availability: buildModelAvailability(src, providerId, modelId),
    history,
  };
}
