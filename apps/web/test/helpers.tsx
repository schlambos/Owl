/**
 * Test-local harness for the Slice 14.5 agent-edit component tests.
 *
 * - Stubs globalThis.EventSource: happy-dom does not implement it, and
 *   RuntimeProvider opens an SSE connection to /api/events after its initial
 *   REST fill. The stub is a silent no-op (no events are ever emitted).
 * - Installs a fetch mock with a route table keyed by method + path prefix,
 *   recording every call (url, method, parsed JSON body).
 * - Fixture builders shaped after the real DTOs in packages/shared.
 */
import { afterEach } from "bun:test";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import type {
  AgentRow,
  AgentsDto,
  ConfigMutation,
  ConfigScope,
  LiveModel,
  LiveProvider,
  ModelAvailability,
  ModelInventoryDto,
  ModelProbeQueueItem,
  ModelProbeQueueSnapshot,
  ModelProbeRun,
  ModelProbeSummary,
  ModelUsageReference,
  MultiplexerSystemDto,
  OpenCodeLifecycleState,
  OverviewDto,
  ProviderDiagnostics,
  ProvidersDto,
  ResolvedProperty,
  ResolveStage,
  RuntimeConnection,
  RuntimeStateDto,
  SimulationResult,
  TelemetryBridgeStatusDto,
} from "@omo/shared";
import { RuntimeProvider } from "../src/runtime/RuntimeContext";
import type { OmoRuntimeSnapshot } from "../src/pages/omo-runtime-types";
import type { OmoSchemaStatus } from "@omo/shared";

// ── EventSource stub (happy-dom lacks it) ────────────────────────────

class NoopEventSource {
  static instances: NoopEventSource[] = [];
  readonly url: string;
  readyState = 0; // CONNECTING
  onopen: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev?: unknown) => void) | null = null;
  /** Recorded per-type listeners so tests can dispatch synthetic events. */
  private readonly listeners = new Map<
    string,
    Set<(ev: MessageEvent) => void>
  >();

  constructor(url: string | URL) {
    this.url = String(url);
    NoopEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (ev: MessageEvent) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return true;
  }
  close(): void {
    this.readyState = 2; // CLOSED
  }
  /** Test-only: deliver a typed event with a JSON-serializable payload. */
  emit(type: string, payload: unknown): void {
    const raw = { data: JSON.stringify(payload) } as MessageEvent;
    for (const fn of this.listeners.get(type) ?? []) fn(raw);
  }
}

(globalThis as unknown as { EventSource: unknown }).EventSource =
  NoopEventSource;

/** Most recently opened control-plane EventSource (RuntimeProvider). */
export function lastEventSource(): NoopEventSource {
  const es = NoopEventSource.instances[NoopEventSource.instances.length - 1];
  if (!es) throw new Error("No EventSource has been opened");
  return es;
}

/**
 * Dispatch a synthetic control-plane SSE event to the open stream.
 * `type` must match an `addEventListener` registration in RuntimeContext.
 */
export function dispatchCpEvent(type: string, payload: unknown): void {
  lastEventSource().emit(type, payload);
}

// ── Polling helper ───────────────────────────────────────────────────
//
// Prefer this over RTL's findBy*/waitFor: under bun + happy-dom, RTL's
// asyncWrapper drains with a zero-delay setTimeout whose scheduled flush
// timer can sporadically never fire, permanently hanging the test; and while
// a waitFor is actively polling, pending React updates visibly stall.
// `poll` runs a synchronous expectation (e.g. screen.getBy*) and retries on
// a plain timer sleep, which is the pattern verified reliable here.
export interface PollOptions {
  /** Overall deadline; defaults to 3000ms. */
  timeoutMs?: number;
  /** Sleep between attempts; defaults to 25ms. */
  intervalMs?: number;
}

export async function poll(
  expectation: () => void,
  opts?: PollOptions,
): Promise<void> {
  const deadline = Date.now() + (opts?.timeoutMs ?? 3000);
  const interval = opts?.intervalMs ?? 25;
  let lastErr: unknown;
  for (;;) {
    // Flush React's queued work each attempt: with IS_REACT_ACT_ENVIRONMENT
    // true, updates arriving outside act() are queued, not applied.
    await act(async () => {});
    try {
      expectation();
      return;
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() > deadline) {
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

// ── Route-table fetch mock ───────────────────────────────────────────

export interface FetchCall {
  url: string;
  method: string;
  /** Parsed JSON body when the request carried one. */
  body: unknown;
  init?: RequestInit;
}

export interface Route {
  /** HTTP method; defaults to GET. */
  method?: string;
  /** URL prefix match (query string included). */
  prefix: string;
  /** Static JSON body. */
  body?: unknown;
  /** Status code; defaults to 200. */
  status?: number;
  /** Dynamic response builder; takes precedence over `body`. */
  respond?: (
    url: string,
    init: RequestInit | undefined,
    call: FetchCall,
  ) => unknown;
}

export interface FetchMock {
  calls: FetchCall[];
  callsTo(prefix: string, method?: string): FetchCall[];
  restore(): void;
}

let activeMock: FetchMock | null = null;

afterEach(() => {
  activeMock?.restore();
  activeMock = null;
});

export function mockFetch(routes: Route[]): FetchMock {
  activeMock?.restore();
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;

  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: FetchCall = { url, method, body, init };
    calls.push(call);

    const route = routes.find(
      (r) =>
        (r.method ?? "GET").toUpperCase() === method &&
        url.startsWith(r.prefix),
    );
    if (!route) {
      return new Response(JSON.stringify({ error: `unmocked ${method} ${url}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const payload = route.respond ? route.respond(url, init, call) : route.body;
    return new Response(JSON.stringify(payload ?? null), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  globalThis.fetch = impl;

  const mock: FetchMock = {
    calls,
    callsTo: (prefix, method = "GET") =>
      calls.filter(
        (c) => c.method === method.toUpperCase() && c.url.startsWith(prefix),
      ),
    restore: () => {
      globalThis.fetch = original;
    },
  };
  activeMock = mock;
  return mock;
}

// ── Fixtures (derived from packages/shared DTO shapes) ───────────────

const NOW = "2026-01-01T00:00:00.000Z";

const CONNECTION: RuntimeConnection = {
  rest: "connected",
  sse: "connected",
  stale: false,
  opencodeBaseUrl: "http://127.0.0.1:4096",
};

export function makeModel(
  providerID: string,
  id: string,
  name?: string,
): LiveModel {
  return { id, name, providerID };
}

export function makeProvider(
  id: string,
  name: string,
  connected: boolean,
  models: LiveModel[],
): LiveProvider {
  return { id, name, connected, modelCount: models.length, models };
}

export function makeProvidersDto(providers: LiveProvider[]): ProvidersDto {
  return {
    providers,
    connected: providers.filter((p) => p.connected).map((p) => p.id),
    fetchedAt: NOW,
  };
}

// ── Slice 15 model inventory / probing fixtures (additive) ─────────
// NOTE: probe timestamps are generated relative to Date.now() (probeAgo
// renders real relative labels like "2m ago"), unlike the static NOW above.

export function probeSummary(
  overrides: Partial<ModelProbeSummary> = {},
): ModelProbeSummary {
  return {
    state: "never",
    freshness: "never",
    ...overrides,
  };
}

export function makeProbeSummary(
  overrides: Partial<ModelProbeSummary> = {},
): ModelProbeSummary {
  return probeSummary(overrides);
}

export function makeUsageRef(
  overrides: Partial<ModelUsageReference> = {},
): ModelUsageReference {
  return {
    kind: "agent-primary",
    ownerId: "explorer",
    label: "Explorer",
    active: true,
    fallback: false,
    ...overrides,
  };
}

export function makeModelAvailability(
  overrides: Partial<ModelAvailability> = {},
): ModelAvailability {
  return {
    providerId: "anthropic",
    modelId: "claude-sonnet-4-5",
    configured: true,
    provider: { known: true, connected: true },
    advertised: true,
    probe: probeSummary(),
    capabilities: { state: "unknown", source: "none" },
    lastUpdatedAt: NOW,
    usage: [],
    ...overrides,
  };
}

export function makeProviderDiagnostics(
  overrides: Partial<ProviderDiagnostics> = {},
): ProviderDiagnostics {
  return {
    providerId: "anthropic",
    name: "Anthropic",
    known: true,
    connected: true,
    advertisedCount: 0,
    referencedCount: 0,
    authMethods: [],
    recentFailureCounts: {},
    recentRateLimitCount: 0,
    ...overrides,
  };
}

export function makeProbeRun(
  overrides: Partial<ModelProbeRun> = {},
): ModelProbeRun {
  const startedAt =
    overrides.startedAt ?? new Date(Date.now() - 120_000).toISOString();
  return {
    id: "run-1",
    providerId: "anthropic",
    modelId: "claude-sonnet-4-5",
    startedAt,
    completedAt: new Date(Date.parse(startedAt) + 812).toISOString(),
    state: "healthy",
    latencyMs: 812,
    advertisedAtProbe: true,
    providerConnectedAtProbe: true,
    ...overrides,
    startedAt,
  };
}

export function makeQueueItem(
  overrides: Partial<ModelProbeQueueItem> = {},
): ModelProbeQueueItem {
  return {
    id: "q-1",
    providerId: "anthropic",
    modelId: "claude-sonnet-4-5",
    state: "pending",
    enqueuedAt: new Date(Date.now() - 30_000).toISOString(),
    ...overrides,
  };
}

export function makeQueueSnapshot(
  overrides: Partial<ModelProbeQueueSnapshot> = {},
): ModelProbeQueueSnapshot {
  return {
    concurrency: 2,
    pending: [],
    running: [],
    ...overrides,
  };
}

export function makeModelInventoryDto(
  overrides: Partial<ModelInventoryDto> = {},
): ModelInventoryDto {
  return {
    generatedAt: NOW,
    models: [],
    providers: [],
    queue: makeQueueSnapshot(),
    ...overrides,
  };
}

export const EMPTY_MODEL_INVENTORY: ModelInventoryDto = makeModelInventoryDto();

export function makeRow(
  p: Pick<AgentRow, "name" | "kind"> & Partial<AgentRow>,
): AgentRow {
  return {
    enabled: true,
    sessionCount: 0,
    drift: { desiredVsEffective: false, effectiveVsLive: false },
    ...p,
  };
}

export function makeAgentsDto(rows: AgentRow[], preset = "openai"): AgentsDto {
  return {
    rows,
    desired: { sources: [], agents: {}, presets: {}, globals: {}, raw: {} },
    effective: {
      preset,
      agents: {},
      disabledAgents: [],
      backgroundJobs: {},
      fallback: {},
      warnings: [],
      sources: [],
    },
    liveAgents: [],
  };
}

export function makeOverview(): OverviewDto {
  return {
    controlPlane: { name: "omo-control-plane", version: "0.1.0" },
    opencode: { healthy: true, baseUrl: CONNECTION.opencodeBaseUrl },
    connection: CONNECTION,
    omo: { agentCount: 3, customAgentCount: 1, presetCount: 1, warnings: [] },
    providers: { connected: [], connectedCount: 0, totalKnown: 0 },
    sessions: { total: 0, roots: 0, children: 0 },
    mcp: {},
    permissions: [],
    fetchedAt: NOW,
  };
}

export function makeRuntimeState(): RuntimeStateDto {
  return {
    health: { healthy: true },
    providers: [],
    agents: [],
    sessions: { roots: [], flat: [], total: 0, byStatus: {} },
    mcp: {},
    permissions: [],
    connection: CONNECTION,
    fetchedAt: NOW,
    baseUrl: CONNECTION.opencodeBaseUrl,
  };
}

/** Default GET /api/omo/schema payload — installed schema, valid configs. */
export const OMO_SCHEMA_OK: OmoSchemaStatus = {
  available: true,
  packageVersion: "2.3.4",
  schemaPath: "/node_modules/oh-my-opencode-slim/dist/schema.json",
  schemaHash: "sha256:fixture",
  userConfig: { present: true, valid: true, issues: [] },
  projectConfig: { present: false, valid: null, issues: [] },
};

export const OMO_RUNTIME_SNAPSHOT: OmoRuntimeSnapshot = {
  telemetrySchemaVersion: 1,
  generatedAt: 0,
  stale: false,
  availability: { opencodeJobs: false, bridge: false, runtimePreset: false },
  jobs: [],
  workers: [],
  notes: [],
};

/** Default GET /api/opencode/lifecycle payload — fully connected Managed. */
export function makeLifecycle(
  overrides: Partial<OpenCodeLifecycleState> = {},
): OpenCodeLifecycleState {
  return {
    mode: "managed",
    ownership: "control-plane",
    status: "connected",
    baseUrl: "http://127.0.0.1:4096",
    version: "1.18.14",
    generation: 1,
    projectDirectory: "/tmp/owl-fixture/project",
    configDirectory: "/tmp/owl-fixture/opencode",
    authConfigured: false,
    ready: {
      health: true,
      configProviders: true,
      providers: true,
      agents: true,
      omo: true,
      omoExpected: true,
      rest: true,
      sse: true,
    },
    updatedAt: NOW,
    ...overrides,
  };
}

/** Shape of GET /api/config/edit-state (mirrors AgentEditModal's local type). */
export const EDIT_STATE = {
  preset: "openai",
  user: { path: "~/.config/omo/omo.json", exists: true, hash: "user-hash-1" },
  project: {
    path: ".omo/omo.json",
    exists: false,
    hash: null as string | null,
  },
};

/** Shape of GET /api/omo/provenance?path=... replies (AgentEditModal local type). */
export type ProvenanceReply =
  | { found: true; property: ResolvedProperty }
  | { found: false; suggestions?: string[] };

export const PROVENANCE_NOT_FOUND: ProvenanceReply = { found: false };

export function resolvedModel(opts: {
  agent: string;
  value: string;
  stage: ResolveStage;
  scope?: ConfigScope;
  sourcePath?: string;
  reason?: string;
}): ResolvedProperty {
  const sourcePath = opts.sourcePath ?? `presets.openai.${opts.agent}.model`;
  return {
    path: `agents.${opts.agent}.model`,
    value: opts.value,
    winner: {
      value: opts.value,
      sourceId: "fixture-source",
      sourceLabel: sourcePath,
      sourcePath,
      stage: opts.stage,
      order: 1,
      scope: opts.scope,
    },
    overridden: [],
    reason: opts.reason ?? "fixture: highest-precedence configured source wins",
  };
}

export function makeSimulation(
  patch: Partial<SimulationResult> & Pick<SimulationResult, "mutation">,
): SimulationResult {
  return {
    ok: true,
    targetPath: "~/.config/omo/presets/openai.json",
    jsonPath: ["presets", "openai", "explorer", "model"],
    scope: "user",
    createsFile: false,
    currentValue: "anthropic/claude-sonnet-4-5",
    proposedValue: "openai/gpt-5",
    textDiff: '- "anthropic/claude-sonnet-4-5"\n+ "openai/gpt-5"',
    effectiveBefore: "anthropic/claude-sonnet-4-5",
    effectiveAfter: "openai/gpt-5",
    effectiveChanged: [],
    masked: false,
    validation: { ok: true, issues: [] },
    warnings: [],
    errors: [],
    liveNote: "Live stays authoritative until reload/session lifecycle.",
    ...patch,
  };
}

// ── Slice 16 multiplexer fixtures ────────────────────────────────────

/**
 * Default GET /api/system/multiplexer payload: multiplexer disabled
 * (type none), runtime unobservable (bridge not connected). Neutral —
 * no records, no mappings, no warnings.
 */
export function makeMultiplexerSystem(
  overrides: Partial<MultiplexerSystemDto> = {},
): MultiplexerSystemDto {
  const cmd = (command: string) => ({
    command,
    status: "not-resolved" as const,
  });
  return {
    builtinDefaults: {
      type: "none",
      layout: "main-vertical",
      main_pane_size: 60,
      zellij_pane_mode: "agent-tab",
    },
    configured: {},
    effective: {
      type: "none",
      layout: "main-vertical",
      main_pane_size: 60,
      zellij_pane_mode: "agent-tab",
    },
    provenance: {
      properties: {},
      builtinDefaults: [
        "multiplexer.type",
        "multiplexer.layout",
        "multiplexer.main_pane_size",
        "multiplexer.zellij_pane_mode",
      ],
    },
    legacy: {
      tmuxPresent: false,
      ignored: true,
      note: "Legacy top-level tmux key is ignored by OMO.",
    },
    availability: {
      tmux: cmd("tmux"),
      zellij: cmd("zellij"),
      herdr: cmd("herdr"),
      kitten: cmd("kitten"),
      kitty: cmd("kitty"),
      cmux: cmd("cmux"),
      opencode: { command: "opencode", status: "resolved", path: "/usr/local/bin/opencode" },
    },
    detection: {
      signals: {},
      resolvedType: null,
      insideSession: false,
      order: [{ match: "none", type: null }],
    },
    runtime: {
      stores: { sessions: [], cmux: [], counts: {} },
      mapping: {
        bySessionId: {},
        mappedJobs: [],
        unmappedJobs: [],
        unavailable: true,
        stale: false,
      },
      bridgeConnected: false,
    },
    activation: {
      configReadAt: "plugin-load",
      availabilityCheckAt: "plugin-init-if-in-session",
      hotReload: false,
      legacyTmuxIgnored: true,
      note: "Multiplexer configuration is read once at plugin load.",
    },
    capabilities: {
      readable: true,
      resolved: true,
      provenance: true,
      editable: true,
      runtimeObservable: "partial",
      runtimeControllable: false,
      doctor: true,
    },
    warnings: [],
    generatedAt: NOW,
    ...overrides,
  };
}

export const MUX_UNAVAILABLE: MultiplexerSystemDto = makeMultiplexerSystem();

// ── Slice 17 telemetry-bridge fixtures ────────────────────────────────

/**
 * Default GET /api/opencode/bridge/status payload: bridge not registered,
 * runtime unavailable, no committed desired state, override absent. Neutral
 * — no actions eligible, no secrets.
 */
export function makeBridgeStatus(
  overrides: Partial<TelemetryBridgeStatusDto> = {},
): TelemetryBridgeStatusDto {
  return {
    source: null,
    effective: null,
    desired: null,
    duplicates: { inSource: false, inEffective: false },
    override: { present: false, invalid: false, optsOutOfManagement: false },
    registration: "unknown",
    runtime: "unavailable",
    compatibility: "unknown",
    localPackageAvailable: "unknown",
    endpointSource: "unavailable",
    overrideActive: false,
    overrideInvalid: false,
    verificationEpoch: 0,
    generation: 1,
    omoReady: false,
    backendConnected: false,
    lifecycleStatus: "stale",
    mode: "managed",
    ownership: "control-plane",
    restartControllable: true,
    restartRequired: false,
    actions: {
      canRegister: false,
      canRemove: false,
      canRestore: false,
      canRestart: false,
      canProbe: false,
      reasons: ["source-not-proven", "effective-state-not-cached"],
    },
    updatedAt: NOW,
    ...overrides,
  };
}

/** Wrap a status DTO in the { ok, status } envelope the server returns. */
export function bridgeStatusResponse(status: TelemetryBridgeStatusDto) {
  return { ok: true, status };
}

// ── World / route assembly ───────────────────────────────────────────

export interface World {
  agents: AgentsDto;
  providers: ProvidersDto;
  /** Names registered in the ACP inventory (GET /api/acp). */
  acpAgents?: string[];
  editState?: typeof EDIT_STATE;
  /** Override for GET /api/omo/schema (defaults to a valid, available schema). */
  omoSchema?: OmoSchemaStatus;
  provenanceModel?: ProvenanceReply;
  provenanceVariant?: ProvenanceReply;
  simulate?: (call: FetchCall) => SimulationResult;
  apply?: (call: FetchCall) => unknown;
  /**
   * Slice 15: model inventory served by GET /api/models. Tests can hold a
   * reference and reassign this field to swap the next fetch's payload
   * (e.g. after a probe POST moves a model running → healthy).
   */
  models?: ModelInventoryDto;
  /** History served by GET /api/models/:provider/:model. */
  modelHistory?: (providerId: string, modelId: string) => ModelProbeRun[];
  /** Override for POST /api/models/probe single-enqueue responses. */
  probeSingle?: (call: FetchCall) => unknown;
  /** Override for POST /api/models/probe-batch responses. */
  probeBatch?: (call: FetchCall) => unknown;
  /** Override for POST /api/models/probes/:id/cancel responses. */
  probeCancel?: (call: FetchCall) => unknown;
  /**
   * Slice 16: GET /api/opencode/lifecycle payload (defaults to a connected
   * Managed lifecycle so existing tests keep working).
   */
  lifecycle?: OpenCodeLifecycleState;
  /** Override POST /api/opencode/lifecycle/retry response. */
  retryLifecycle?: (call: FetchCall) => unknown;
  /** Slice 16: GET /api/system/multiplexer payload (defaults to unavailable). */
  multiplexer?: MultiplexerSystemDto;
  /** Slice 16: OMO runtime snapshot (jobs) served by GET /api/omo/runtime. */
  omoRuntime?: OmoRuntimeSnapshot;
  /** Slice 17: GET /api/opencode/bridge/status payload (defaults to neutral). */
  bridgeStatus?: TelemetryBridgeStatusDto;
  /** Slice 17: POST /api/opencode/bridge/preview response builder. */
  bridgePreview?: (call: FetchCall) => unknown;
  /** Slice 17: POST /api/opencode/bridge/apply response builder. */
  bridgeApply?: (call: FetchCall) => unknown;
  /** Slice 17: POST /api/opencode/bridge/restart response builder. */
  bridgeRestart?: (call: FetchCall) => unknown;
  /** Slice 17: POST /api/opencode/bridge/restore response builder. */
  bridgeRestore?: (call: FetchCall) => unknown;
}

/**
 * Standard route table covering everything AgentsPage + RuntimeProvider +
 * AgentEditModal fetch. First match wins.
 */
export function baseRoutes(world: World): Route[] {
  return [
    {
      prefix: "/api/runtime/reconcile",
      method: "POST",
      body: { ok: true, state: makeRuntimeState() },
    },
    { prefix: "/api/runtime", body: makeRuntimeState() },
    { prefix: "/api/overview", body: makeOverview() },
    { prefix: "/api/agents", body: world.agents },
    { prefix: "/api/providers", body: world.providers },
    {
      prefix: "/api/acp",
      body: { agents: (world.acpAgents ?? []).map((name) => ({ name })) },
    },
    // ── Slice 15: model inventory / probing (additive) ──────────────
    // Order matters: prefixes are first-match-wins.
    {
      prefix: "/api/models/probe-batch",
      method: "POST",
      respond: (_url, _init, call) => {
        if (world.probeBatch) return world.probeBatch(call);
        const body = call.body as {
          models?: Array<{ providerId: string; modelId: string }>;
        };
        const inv = world.models ?? EMPTY_MODEL_INVENTORY;
        return {
          accepted: body.models ?? [],
          skipped: [],
          deduped: 0,
          queue: inv.queue,
        };
      },
    },
    {
      prefix: "/api/models/probes/",
      method: "POST",
      respond: (_url, _init, call) => {
        if (world.probeCancel) return world.probeCancel(call);
        const inv = world.models ?? EMPTY_MODEL_INVENTORY;
        return inv.queue;
      },
    },
    {
      prefix: "/api/models/probe",
      method: "POST",
      respond: (_url, _init, call) => {
        if (world.probeSingle) return world.probeSingle(call);
        const body = (call.body ?? {}) as {
          providerId?: string;
          modelId?: string;
        };
        return makeQueueItem({
          id: "q-probe-1",
          providerId: body.providerId ?? "",
          modelId: body.modelId ?? "",
        });
      },
    },
    {
      prefix: "/api/models",
      respond: (url) => {
        const inv = world.models ?? EMPTY_MODEL_INVENTORY;
        // GET /api/models → inventory
        const path = url.split("?")[0] ?? url;
        if (path === "/api/models") return inv;
        // GET /api/models/:provider/:model[/probes] → detail / history
        const rest = path.slice("/api/models/".length).split("/");
        const providerId = decodeURIComponent(rest[0] ?? "");
        const modelId = decodeURIComponent(rest[1] ?? "");
        const history = world.modelHistory?.(providerId, modelId) ?? [];
        if (rest[2] === "probes") return { providerId, modelId, probes: history };
        const availability =
          inv.models.find(
            (m) => m.providerId === providerId && m.modelId === modelId,
          ) ?? makeModelAvailability({ providerId, modelId });
        return { availability, history };
      },
    },
    { prefix: "/api/opencode/lifecycle/retry", method: "POST",
      respond: (_url, _init, call) =>
        world.retryLifecycle
          ? world.retryLifecycle(call)
          : { ok: true, lifecycle: world.lifecycle ?? makeLifecycle() },
    },
    { prefix: "/api/opencode/lifecycle", body: world.lifecycle ?? makeLifecycle() },
    // ── Slice 17: telemetry-bridge management (additive) ──────────────
    // /api/opencode/bridge/* does not collide with /api/opencode/lifecycle
    // (distinct string prefixes). First-match-wins still applies within
    // the bridge block, so the more-specific POST routes are listed before
    // the GET status route.
    { prefix: "/api/opencode/bridge/preview", method: "POST",
      respond: (_u, _i, call) =>
        world.bridgePreview ? world.bridgePreview(call) : { ok: false, error: { code: "preview-failed", message: "no fixture" } },
    },
    { prefix: "/api/opencode/bridge/apply", method: "POST",
      respond: (_u, _i, call) =>
        world.bridgeApply ? world.bridgeApply(call) : { ok: false, error: { code: "apply-failed", message: "no fixture" } },
    },
    { prefix: "/api/opencode/bridge/restart", method: "POST",
      respond: (_u, _i, call) =>
        world.bridgeRestart ? world.bridgeRestart(call) : { ok: false, error: { code: "restart-failed", message: "no fixture" } },
    },
    { prefix: "/api/opencode/bridge/restore", method: "POST",
      respond: (_u, _i, call) =>
        world.bridgeRestore ? world.bridgeRestore(call) : { ok: false, error: { code: "restore-failed", message: "no fixture" } },
    },
    { prefix: "/api/opencode/bridge/status", body: bridgeStatusResponse(world.bridgeStatus ?? makeBridgeStatus()) },
    { prefix: "/api/opencode/bridge/probe", method: "POST",
      body: { ok: false, error: { code: "bridge-probe-inapplicable", message: "Probe is not implemented.", action: "Use the bridge status endpoint." } },
      status: 501,
    },
    { prefix: "/api/omo/runtime", body: world.omoRuntime ?? OMO_RUNTIME_SNAPSHOT },
    { prefix: "/api/system/multiplexer", body: world.multiplexer ?? MUX_UNAVAILABLE },
    { prefix: "/api/doctor/summary", body: { generatedAt: NOW, overall: "healthy", counts: { healthy: 0, info: 0, warning: 0, error: 0, unknown: 0 }, top: [], system: { runtimeStale: false, runtimePresetKnown: false, configGeneration: 1 } } },
    { prefix: "/api/doctor", body: { generatedAt: NOW, overall: "healthy", counts: { healthy: 0, info: 0, warning: 0, error: 0, unknown: 0 }, categories: [], diagnostics: [], system: { runtimeStale: false, runtimePresetKnown: false, configGeneration: 1 } } },
    { prefix: "/api/doctor/", body: { generatedAt: NOW, overall: "healthy", counts: { healthy: 0, info: 0, warning: 0, error: 0, unknown: 0 }, categories: [], diagnostics: [], system: { runtimeStale: false, runtimePresetKnown: false, configGeneration: 1 } } },
    { prefix: "/api/omo/schema", body: world.omoSchema ?? OMO_SCHEMA_OK },
    {
      prefix: "/api/omo/provenance",
      respond: (url) => {
        const qs = url.split("?")[1] ?? "";
        const path = new URLSearchParams(qs).get("path") ?? "";
        if (path.endsWith(".model"))
          return world.provenanceModel ?? PROVENANCE_NOT_FOUND;
        if (path.endsWith(".variant"))
          return world.provenanceVariant ?? PROVENANCE_NOT_FOUND;
        // Bare provenance map (AgentDetailPanel) — empty is fine.
        return { properties: {} };
      },
    },
    { prefix: "/api/config/edit-state", body: world.editState ?? EDIT_STATE },
    {
      prefix: "/api/config/simulate",
      method: "POST",
      respond: (_url, _init, call) =>
        world.simulate
          ? world.simulate(call)
          : makeSimulation({ mutation: call.body as ConfigMutation }),
    },
    {
      prefix: "/api/config/apply",
      method: "POST",
      respond: (_url, _init, call) =>
        world.apply
          ? world.apply(call)
          : { ok: true, revisionId: "rev-test-1", errors: [] },
    },
    { prefix: "/api/config/revisions", body: { revisions: [] } },
  ];
}

// ── Render helpers ───────────────────────────────────────────────────

export function renderWithRuntime(ui: ReactNode) {
  return render(<RuntimeProvider>{ui}</RuntimeProvider>);
}

/**
 * Render inside a MemoryRouter (AgentsPage drives filter/q/sort/agent/native
 * via useSearchParams) + RuntimeProvider. `initialEntries` seeds the URL —
 * e.g. ["/agents?filter=overrides"] for URL-state hydration tests.
 */
export function renderWithRouter(
  ui: ReactNode,
  initialEntries: string[] = ["/agents"],
) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <RuntimeProvider>{ui}</RuntimeProvider>
    </MemoryRouter>,
  );
}

/** Locate a table row (<tr>) whose text contains the agent name. */
export function findRowByName(name: string): HTMLElement {
  const row = screen
    .getAllByRole("row")
    .find((r) => r.textContent?.includes(name));
  if (!row) throw new Error(`No table row containing "${name}"`);
  return row;
}
