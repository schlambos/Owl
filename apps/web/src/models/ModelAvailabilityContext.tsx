import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  ModelAvailability,
  ModelInventoryDto,
  ModelProbeQueueSnapshot,
} from "@omo/shared";
import { api } from "../api";
import { useRuntime } from "../runtime/RuntimeContext";

export interface ModelAvailabilityContextValue {
  /** Full inventory DTO from GET /api/models (null until first success). */
  inventory: ModelInventoryDto | null;
  /** True only until the first fetch settles; refetches keep old data. */
  loading: boolean;
  /** True while any fetch (initial or refetch) is in flight. */
  refreshing: boolean;
  error: string | null;
  /** Live queue: SSE snapshot when available, else inventory snapshot. */
  queue: ModelProbeQueueSnapshot | null;
  refresh: () => Promise<void>;
  /** Inventory lookup keyed `providerId` + `modelId` (model ids may contain slashes). */
  getModel: (
    providerId: string,
    modelId: string,
  ) => ModelAvailability | undefined;
}

const ModelAvailabilityContext =
  createContext<ModelAvailabilityContextValue | null>(null);

// Separator-safe lookup key (model ids contain slashes; provider ids do not).
const keyOf = (providerId: string, modelId: string) =>
  JSON.stringify([providerId, modelId]);

export function ModelAvailabilityProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { probeGeneration, probeQueue } = useRuntime();
  const [inventory, setInventory] = useState<ModelInventoryDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setRefreshing(true);
    try {
      const dto = await api.modelInventory();
      if (seq !== fetchSeq.current) return; // superseded by a later fetch
      setInventory(dto);
      setError(null);
    } catch (e) {
      if (seq !== fetchSeq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === fetchSeq.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  // Initial fetch on mount, then refetch only when a model-probes.updated
  // SSE event bumps probeGeneration. Other runtime events do not re-fetch.
  useEffect(() => {
    void refresh();
  }, [refresh, probeGeneration]);

  const index = useMemo(() => {
    const map = new Map<string, ModelAvailability>();
    for (const m of inventory?.models ?? []) {
      map.set(keyOf(m.providerId, m.modelId), m);
    }
    return map;
  }, [inventory]);

  const getModel = useCallback(
    (providerId: string, modelId: string) =>
      index.get(keyOf(providerId, modelId)),
    [index],
  );

  const value = useMemo<ModelAvailabilityContextValue>(
    () => ({
      inventory,
      loading,
      refreshing,
      error,
      queue: probeQueue ?? inventory?.queue ?? null,
      refresh,
      getModel,
    }),
    [inventory, loading, refreshing, error, probeQueue, refresh, getModel],
  );

  return (
    <ModelAvailabilityContext.Provider value={value}>
      {children}
    </ModelAvailabilityContext.Provider>
  );
}

export function useModelAvailability(): ModelAvailabilityContextValue {
  const ctx = useContext(ModelAvailabilityContext);
  if (!ctx)
    throw new Error("useModelAvailability outside ModelAvailabilityProvider");
  return ctx;
}

/**
 * Same context, but returns null instead of throwing when the provider is
 * absent (e.g. unit tests, or surfaces rendered standalone). Surfaces using
 * this must degrade to "—"/hidden probe affordances when null.
 */
export function useModelAvailabilityOptional(): ModelAvailabilityContextValue | null {
  return useContext(ModelAvailabilityContext);
}
