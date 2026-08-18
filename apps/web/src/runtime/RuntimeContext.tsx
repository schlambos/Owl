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
  AgentsDto,
  ConfigSourcesChangedEvent,
  ControlPlaneEvent,
  ModelProbeQueueSnapshot,
  OpenCodeLifecycleState,
  OverviewDto,
  ProvidersDto,
  RuntimeConnection,
  RuntimeStateDto,
  SessionsDto,
  TelemetryBridgeStatusSummary,
} from "@omo/shared";
import { api } from "../api";

interface RuntimeContextValue {
  connection: RuntimeConnection;
  runtime: RuntimeStateDto | null;
  /** Control-plane browser SSE link */
  cpSse: "connecting" | "live" | "reconnecting" | "disconnected";
  lastCpEventAt?: string;
  /** Increments on each "model-probes.updated" SSE event (0 = none yet). */
  probeGeneration: number;
  /** Latest model probe queue snapshot from SSE (null until first event). */
  probeQueue: ModelProbeQueueSnapshot | null;
  lastProbeEventAt?: string;
  /** Latest canonical OpenCode backend lifecycle state (GET /api/opencode/lifecycle). */
  lifecycle: OpenCodeLifecycleState | null;
  /** Increments on each "opencode.backend.generation" SSE event (0 = none yet). */
  lifecycleGeneration: number;
  /**
   * Increments on each "telemetry-bridge.updated" SSE event (0 = none yet).
   * Consumers refetch GET /api/opencode/bridge/status when this bumps — the
   * SSE payload is a sanitized summary only, the full DTO must be re-read.
   * No duplicate polling: the single /api/events EventSource drives refresh.
   */
  bridgeGeneration: number;
  /** Latest sanitized bridge status summary from SSE (null until first event). */
  bridgeSummary: TelemetryBridgeStatusSummary | null;
  lastBridgeEventAt?: string;
  /** Latest config.sources.changed event from the single /api/events stream. */
  configSourcesEvent: ConfigSourcesChangedEvent | null;
  /** Increments on each config.sources.changed SSE event (0 = none yet). */
  configSourcesGeneration: number;
  overview: OverviewDto | null;
  agents: AgentsDto | null;
  providers: ProvidersDto | null;
  sessions: SessionsDto | null;
  error: string | null;
  loading: boolean;
  refreshAll: () => Promise<void>;
  reconcile: () => Promise<void>;
  /**
   * POST /api/opencode/lifecycle/retry. The server is the single source of
   * truth for whether retry is allowed; the lifecycle.error.retryable flag
   * is what callers should consult before invoking this. Returns the
   * resulting lifecycle snapshot or throws on transport failure.
   */
  retryLifecycle: () => Promise<OpenCodeLifecycleState>;
}

const RuntimeContext = createContext<RuntimeContextValue | null>(null);

const emptyConn = (base = ""): RuntimeConnection => ({
  rest: "disconnected",
  sse: "disconnected",
  stale: true,
  opencodeBaseUrl: base,
});

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${path} → ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export function RuntimeProvider({ children }: { children: ReactNode }) {
  const [runtime, setRuntime] = useState<RuntimeStateDto | null>(null);
  const [connection, setConnection] = useState<RuntimeConnection | null>(null);
  const [cpSse, setCpSse] = useState<RuntimeContextValue["cpSse"]>("connecting");
  const [lastCpEventAt, setLastCpEventAt] = useState<string | undefined>();
  const [probeGeneration, setProbeGeneration] = useState(0);
  const [probeQueue, setProbeQueue] = useState<ModelProbeQueueSnapshot | null>(
    null,
  );
  const [lastProbeEventAt, setLastProbeEventAt] = useState<
    string | undefined
  >();
  const [lifecycle, setLifecycle] = useState<OpenCodeLifecycleState | null>(
    null,
  );
  const [lifecycleGeneration, setLifecycleGeneration] = useState(0);
  const [bridgeGeneration, setBridgeGeneration] = useState(0);
  const [bridgeSummary, setBridgeSummary] =
    useState<TelemetryBridgeStatusSummary | null>(null);
  const [lastBridgeEventAt, setLastBridgeEventAt] = useState<
    string | undefined
  >();
  const [configSourcesEvent, setConfigSourcesEvent] =
    useState<ConfigSourcesChangedEvent | null>(null);
  const [configSourcesGeneration, setConfigSourcesGeneration] = useState(0);
  const [overview, setOverview] = useState<OverviewDto | null>(null);
  const [agents, setAgents] = useState<AgentsDto | null>(null);
  const [providers, setProviders] = useState<ProvidersDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const esRef = useRef<EventSource | null>(null);
  const retryRef = useRef(0);

  const applyRuntime = useCallback((state: RuntimeStateDto) => {
    setRuntime(state);
    setConnection(state.connection);
  }, []);

  const refreshDerived = useCallback(async () => {
    // Desired/Effective still come from REST (config layer, not SSE)
    const [ov, ag, pr] = await Promise.all([
      api.overview(),
      api.agents(),
      api.providers(),
    ]);
    setOverview(ov);
    setAgents(ag);
    setProviders(pr);
    if (ov.connection) setConnection(ov.connection);
  }, []);

  /**
   * Refresh live runtime + derived state after a backend generation change
   * (opencode.backend.generation event). The live model inventory is
   * refetched through the existing ModelAvailabilityProvider mechanism by
   * bumping probeGeneration — desired/effective configuration is never
   * cleared, so configured model selectors keep their values.
   */
  const refreshLive = useCallback(async () => {
    try {
      const rt = await api.runtime();
      applyRuntime(rt);
    } catch {
      /* keep previous snapshot */
    }
    setProbeGeneration((g) => g + 1);
    void refreshDerived().catch(() => {
      /* keep previous derived state */
    });
  }, [applyRuntime, refreshDerived]);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [rt, lc] = await Promise.all([
        api.runtime(),
        getJson<OpenCodeLifecycleState>("/api/opencode/lifecycle").catch(
          () => null,
        ),
      ]);
      applyRuntime(rt);
      if (lc) setLifecycle(lc);
      await refreshDerived();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [applyRuntime, refreshDerived]);

  const reconcile = useCallback(async () => {
    try {
      await api.reconcile();
      await refreshAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [refreshAll]);

  const retryLifecycle = useCallback(async () => {
    const res = await fetch("/api/opencode/lifecycle/retry", {
      method: "POST",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `/api/opencode/lifecycle/retry → ${res.status} ${text.slice(0, 200)}`,
      );
    }
    const body = (await res.json()) as { ok: boolean; lifecycle: OpenCodeLifecycleState };
    setLifecycle(body.lifecycle);
    return body.lifecycle;
  }, []);

  // Browser ← control-plane SSE
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (stopped) return;
      setCpSse(retryRef.current === 0 ? "connecting" : "reconnecting");
      const es = new EventSource("/api/events");
      esRef.current = es;

      const onPayload = (raw: MessageEvent) => {
        try {
          const evt = JSON.parse(String(raw.data)) as ControlPlaneEvent;
          setLastCpEventAt(new Date().toISOString());
          retryRef.current = 0;
          setCpSse("live");
          setError(null);

          if (evt.type === "snapshot" || evt.type === "runtime.updated") {
            applyRuntime(evt.state);
            // Keep overview/agents lightly in sync for session counts etc.
            void refreshDerived().catch(() => {
              /* ignore transient */
            });
          } else if (evt.type === "connection") {
            setConnection(evt.connection);
          } else if (evt.type === "model-probes.updated") {
            // Probe queue events carry their own snapshot; do NOT refetch
            // overview/agents here — consumers re-read the model inventory.
            setProbeQueue(evt.queue);
            setProbeGeneration((g) => g + 1);
            setLastProbeEventAt(evt.at);
          } else if (evt.type === "opencode.lifecycle.updated") {
            // Authoritative lifecycle state. Preserve the previous lifecycle
            // until the new one arrives so a connected→restarting transition
            // never flashes "no URL" momentarily.
            setLifecycle(evt.lifecycle);
          } else if (evt.type === "opencode.backend.generation") {
            // Backend URL may have changed (e.g. restart onto a new port).
            // Refetch the live runtime + model inventory WITHOUT touching
            // desired/effective config in local caches; the configured
            // model selectors remain intact across generations.
            setLifecycleGeneration((g) => g + 1);
            void refreshLive().catch(() => {
              /* ignore transient */
            });
          } else if (evt.type === "config.sources.changed") {
            setConfigSourcesEvent(evt);
            setConfigSourcesGeneration((g) => g + 1);
          } else if (evt.type === "telemetry-bridge.updated") {
            // Sanitized summary only — the full status DTO must be re-read
            // via GET /api/opencode/bridge/status. Bumping bridgeGeneration
            // drives the refetch; no duplicate polling is added.
            setBridgeSummary(evt.bridge);
            setBridgeGeneration((g) => g + 1);
            setLastBridgeEventAt(evt.at);
          }
        } catch {
          /* ignore malformed */
        }
      };

      es.addEventListener("hello", onPayload);
      es.addEventListener("snapshot", onPayload);
      es.addEventListener("runtime.updated", onPayload);
      es.addEventListener("connection", onPayload);
      es.addEventListener("model-probes.updated", onPayload);
      es.addEventListener("opencode.lifecycle.updated", onPayload);
      es.addEventListener("opencode.backend.generation", onPayload);
      es.addEventListener("telemetry-bridge.updated", onPayload);
      es.addEventListener("config.sources.changed", onPayload);
      es.onmessage = onPayload;

      es.onerror = () => {
        es.close();
        esRef.current = null;
        if (stopped) return;
        setCpSse("reconnecting");
        retryRef.current += 1;
        const delay = Math.min(10_000, 800 * 2 ** Math.min(retryRef.current, 4));
        timer = setTimeout(connect, delay);
      };

      es.onopen = () => {
        setCpSse("live");
        retryRef.current = 0;
      };
    };

    // Initial REST fill then SSE
    void refreshAll().finally(() => {
      if (!stopped) connect();
    });

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      esRef.current?.close();
      esRef.current = null;
    };
  }, [applyRuntime, refreshAll, refreshDerived, refreshLive]);

  const sessions: SessionsDto | null = useMemo(() => {
    if (!runtime) return null;
    return {
      roots: runtime.sessions.roots,
      flat: runtime.sessions.flat,
      total: runtime.sessions.total,
    };
  }, [runtime]);

  const value: RuntimeContextValue = {
    connection: connection ?? emptyConn(),
    runtime,
    cpSse,
    lastCpEventAt,
    probeGeneration,
    probeQueue,
    lastProbeEventAt,
    lifecycle,
    lifecycleGeneration,
    bridgeGeneration,
    bridgeSummary,
    lastBridgeEventAt,
    configSourcesEvent,
    configSourcesGeneration,
    overview,
    agents,
    providers,
    sessions,
    error,
    loading,
    refreshAll,
    reconcile,
    retryLifecycle,
  };

  return (
    <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>
  );
}

export function useRuntime(): RuntimeContextValue {
  const ctx = useContext(RuntimeContext);
  if (!ctx) throw new Error("useRuntime outside RuntimeProvider");
  return ctx;
}
