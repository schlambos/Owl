import type {
  LiveAgent,
  LiveModel,
  LivePermission,
  LiveProvider,
  LiveSession,
  LiveSnapshot,
  RuntimeConnection,
} from "@omo/shared";
import {
  isControlPlaneProbeSession,
  PROBE_METADATA_KEY,
} from "../runtime/probe-sessions";
import { extractEffectivePluginView } from "../opencode-bridge/extractor";
import type { EffectivePluginView } from "../opencode-bridge/types";
import {
  basicAuthHeader,
  openCodeAuthFromEnv,
  sanitizeOpenCodeError,
  type OpenCodeBasicAuth,
} from "./security";

const PROJECT_RELEVANT_PATHS = [
  "/path",
  "/project",
  "/agent",
  "/session",
  "/mcp",
  "/permission",
  "/config",
  "/provider",
  "/skill",
  "/event",
] as const;

export interface OpenCodeClientOptions {
  projectDirectory?: string;
  /** Authorized filesystem roots for effective-plugin extraction. */
  authorizedRoots?: string[];
  auth?: OpenCodeBasicAuth;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

/**
 * Typed HTTP error thrown by the client's fetch wrapper on non-2xx.
 * Carries status + an in-memory body summary (first 200 chars) so callers
 * (e.g. the probe engine) can classify failures. Never logged raw; the
 * summary is bounded and in-memory only.
 */
export class OpenCodeRequestError extends Error {
  override readonly name = "OpenCodeRequestError";
  constructor(
    readonly path: string,
    readonly status: number,
    readonly bodySummary: string,
  ) {
    super(`OpenCode ${path} → ${status}: ${bodySummary}`);
  }
}

/** Cached connected-provider authority extracted from GET /provider. */
export interface ConnectedProviderAuthority {
  connected: string[];
  defaults: Record<string, string>;
  fetchedAt: string;
}

export class OpenCodeClient {
  private providerAuthority?: ConnectedProviderAuthority;
  private readonly projectDirectory?: string;
  private readonly authorizedRoots: string[];
  private readonly auth?: OpenCodeBasicAuth;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(
    public readonly baseUrl: string,
    options: OpenCodeClientOptions = {},
  ) {
    this.projectDirectory = options.projectDirectory;
    this.authorizedRoots =
      options.authorizedRoots && options.authorizedRoots.length > 0
        ? options.authorizedRoots
        : options.projectDirectory
          ? [options.projectDirectory]
          : [];
    this.auth = options.auth ?? openCodeAuthFromEnv();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private projectPath(path: string): string {
    if (!this.projectDirectory) return path;
    const pathname = path.split("?", 1)[0] ?? path;
    if (!PROJECT_RELEVANT_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
      return path;
    }
    const url = new URL(path, "http://opencode.local");
    if (!url.searchParams.has("directory")) {
      url.searchParams.set("directory", this.projectDirectory);
    }
    return `${url.pathname}${url.search}`;
  }

  private headers(init?: RequestInit): Headers {
    const headers = new Headers(init?.headers);
    headers.set("Accept", "application/json");
    const authorization = basicAuthHeader(this.auth);
    if (authorization) headers.set("Authorization", authorization);
    return headers;
  }

  private async getJson<T>(path: string, init?: RequestInit): Promise<T> {
    const requestPath = this.projectPath(path);
    const timeout = init?.signal ? undefined : AbortSignal.timeout(this.requestTimeoutMs);
    const res = await this.fetchImpl(this.url(requestPath), {
      ...init,
      signal: init?.signal ?? timeout,
      headers: this.headers(init),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new OpenCodeRequestError(
        requestPath,
        res.status,
        sanitizeOpenCodeError(body, [this.auth?.password]),
      );
    }
    return (await res.json()) as T;
  }

  async health(): Promise<{ healthy: boolean; version?: string }> {
    return this.getJson("/global/health");
  }

  async healthWithSignal(
    signal: AbortSignal,
  ): Promise<{ healthy: boolean; version?: string }> {
    return this.getJson("/global/health", { signal });
  }

  async configProvidersReady(): Promise<boolean> {
    await this.getJson("/config/providers");
    return true;
  }

  async providerReady(): Promise<boolean> {
    await this.getJson("/provider");
    return true;
  }

  /** Readiness endpoint; exposed for lifecycle and capabilities without raw fetch. */
  async skills(): Promise<unknown> {
    return this.getJson("/skill");
  }

  async readiness(): Promise<{
    health: { healthy: boolean; version?: string };
    configProviders: boolean;
    providers: boolean;
    agents: LiveAgent[];
  }> {
    const health = await this.health();
    const [configProviders, providers, agents] = await Promise.all([
      this.getJson("/config/providers").then(() => true),
      this.getJson("/provider").then(() => true),
      this.agents(),
    ]);
    return { health, configProviders, providers, agents };
  }

  /**
   * Specialized read-only effective config/plugin view.
   *
   * Fetches GET /config through the existing authenticated SDK/client path.
   * Raw config exists ONLY inside this method — it is immediately passed to
   * `extractEffectivePluginView(raw, authorizedRoots, projectDirectory)`
   * from opencode-bridge and the sanitized view is returned. Never caches,
   * logs, or throws raw config or option values. If the endpoint is
   * unavailable or the payload is malformed, returns an unavailable/invalid
   * redacted state.
   *
   * Does NOT add a second runtime — this is a read-only view over the
   * canonical OpenCode backend's effective config.
   */
  async effectivePluginView(): Promise<EffectivePluginView> {
    const projectRoot = this.projectDirectory ?? "";
    const roots = this.authorizedRoots;
    let raw: unknown;
    try {
      raw = await this.getJson<unknown>("/config");
    } catch {
      // Endpoint unavailable or auth rejected: redacted unavailable state.
      return {
        entries: [],
        unavailable: true,
        invalid: true,
      };
    }
    // Raw config exists ONLY in this scope. Immediately extract the
    // sanitized view; never cache/log/throw the raw payload or option values.
    try {
      const view = extractEffectivePluginView(raw, roots, projectRoot);
      // Strip errors from the returned view — they may carry redacted
      // messages but we keep the boundary strict by not propagating them.
      const { entries, unavailable, invalid } = view;
      return { entries, unavailable, invalid };
    } catch {
      // Malformed payload: redacted invalid state.
      return {
        entries: [],
        unavailable: true,
        invalid: true,
      };
    }
  }


  async path(): Promise<LiveSnapshot["path"]> {
    return this.getJson("/path");
  }

  async projectCurrent(): Promise<unknown> {
    return this.getJson("/project/current");
  }

  async agents(): Promise<LiveAgent[]> {
    const raw = await this.getJson<unknown[]>("/agent");
    if (!Array.isArray(raw)) return [];
    return raw.map((a) => normalizeAgent(a));
  }

  async sessions(): Promise<LiveSession[]> {
    const raw = await this.getJson<unknown[]>("/session");
    if (!Array.isArray(raw)) return [];
    return raw.map((s) => normalizeSession(s));
  }

  async sessionChildren(sessionId: string): Promise<LiveSession[]> {
    const raw = await this.getJson<unknown[]>(
      `/session/${encodeURIComponent(sessionId)}/children`,
    );
    if (!Array.isArray(raw)) return [];
    return raw.map((s) => normalizeSession(s));
  }

  async session(sessionId: string): Promise<unknown> {
    return this.getJson(`/session/${encodeURIComponent(sessionId)}`);
  }

  async sessionMessages(sessionId: string): Promise<unknown> {
    return this.getJson(
      `/session/${encodeURIComponent(sessionId)}/message`,
    );
  }

  async sessionDiff(sessionId: string): Promise<unknown> {
    return this.getJson(`/session/${encodeURIComponent(sessionId)}/diff`);
  }

  /** Map of sessionID → status object (often empty when idle). */
  async sessionStatus(): Promise<Record<string, unknown>> {
    try {
      const raw = await this.getJson<unknown>("/session/status");
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        return raw as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }

  async mcp(): Promise<Record<string, { status: string }>> {
    const raw = await this.getJson<Record<string, { status?: string }>>("/mcp");
    const out: Record<string, { status: string }> = {};
    for (const [k, v] of Object.entries(raw ?? {})) {
      out[k] = { status: v?.status ?? "unknown" };
    }
    return out;
  }

  async permissions(): Promise<LivePermission[]> {
    try {
      const raw = await this.getJson<unknown>("/permission");
      if (!Array.isArray(raw)) return [];
      const at = new Date().toISOString();
      return raw.map((p) => normalizePermission(p, at));
    } catch {
      return [];
    }
  }

  /**
   * Connected-provider authority: GET /provider is the ONLY authoritative
   * source of the connected set (`connected: string[]`) plus the `default`
   * model map. The raw payload is never retained — only the extracted
   * connected ids and defaults are cached.
   *
   * Refresh policy (enforced by the runtime store callers): bootstrap,
   * reconnect after OpenCode-down, and provider-catalog/integration SSE
   * events only. Routine /config/providers refreshes MERGE against this
   * cached connected set instead of assuming configured ⇒ connected.
   */
  async refreshProviderAuthority(): Promise<ConnectedProviderAuthority> {
    const full = await this.getJson<{
      connected?: unknown;
      default?: unknown;
    }>("/provider");
    const authority: ConnectedProviderAuthority = {
      connected: Array.isArray(full.connected)
        ? full.connected.filter((x): x is string => typeof x === "string")
        : [],
      defaults: pickStringMap(full.default),
      fetchedAt: new Date().toISOString(),
    };
    this.providerAuthority = authority;
    return authority;
  }

  /** Last-known connected-provider authority (undefined until first fetch). */
  getProviderAuthority(): ConnectedProviderAuthority | undefined {
    const a = this.providerAuthority;
    if (!a) return undefined;
    return { connected: [...a.connected], defaults: { ...a.defaults }, fetchedAt: a.fetchedAt };
  }

  /**
   * Provider catalog for DTOs. Prefers GET /config/providers (smaller) and
   * marks `connected` from the cached /provider authority (configured ≠
   * connected). When no authority has been established yet, or
   * /config/providers fails, falls back to GET /provider, which also
   * (re)establishes the authority cache.
   */
  async providers(): Promise<{ providers: LiveProvider[]; connected: string[] }> {
    try {
      const cp = await this.getJson<{
        providers?: unknown[];
        default?: Record<string, string>;
      }>("/config/providers");
      let authority = this.providerAuthority;
      if (!authority) authority = await this.refreshProviderAuthority();
      const connectedSet = new Set(authority.connected);
      const list = Array.isArray(cp.providers) ? cp.providers : [];
      const providers = list.map((p) =>
        normalizeProvider(
          p,
          connectedSet.has(getId(p) ?? ""),
          "opencode:/config/providers",
        ),
      );
      return { providers, connected: [...connectedSet] };
    } catch {
      const full = await this.getJson<{
        all?: unknown[];
        connected?: string[];
        default?: Record<string, string>;
      }>("/provider");
      const connected = new Set(full.connected ?? []);
      const all = Array.isArray(full.all) ? full.all : [];
      this.providerAuthority = {
        connected: [...connected],
        defaults: pickStringMap(full.default),
        fetchedAt: new Date().toISOString(),
      };
      const providers = all.map((p) =>
        normalizeProvider(p, connected.has(getId(p) ?? ""), "opencode:/provider"),
      );
      return { providers, connected: [...connected] };
    }
  }

  /**
   * GET /provider/auth — sanitized auth-method metadata only
   * (never credentials). Soft-fails to {}.
   */
  async providerAuth(): Promise<
    Record<string, Array<{ type: string; label: string }>>
  > {
    try {
      const raw = await this.getJson<Record<string, unknown>>("/provider/auth");
      const out: Record<string, Array<{ type: string; label: string }>> = {};
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [providerId, methods] of Object.entries(raw)) {
          if (!Array.isArray(methods)) continue;
          out[providerId] = methods
            .filter((m): m is Record<string, unknown> =>
              !!m && typeof m === "object" && !Array.isArray(m),
            )
            .map((m) => {
              const type = typeof m.type === "string" ? m.type : "unknown";
              return {
                type,
                label: typeof m.label === "string" ? m.label : type,
              };
            });
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  // ── Probe session primitives (Slice 15; driven by the probe engine) ──

  /**
   * Create a control-plane probe session. Permission ruleset denies all
   * tool execution: `[{ permission: "*", pattern: "*", action: "deny" }]`
   * (PermissionRuleset per .opencode-openapi.json).
   */
  async createProbeSession(opts: {
    directory: string;
    title: string;
    providerID: string;
    modelID: string;
    signal?: AbortSignal;
  }): Promise<{ id: string } & Record<string, unknown>> {
    const q = new URLSearchParams({ directory: opts.directory });
    const raw = await this.getJson<Record<string, unknown>>(
      `/session?${q.toString()}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: opts.title,
          model: { providerID: opts.providerID, id: opts.modelID },
          metadata: { [PROBE_METADATA_KEY]: true },
          permission: [{ permission: "*", pattern: "*", action: "deny" }],
        }),
        signal: opts.signal,
      },
    );
    return raw as { id: string } & Record<string, unknown>;
  }

  /**
   * Send the fixed probe prompt to a probe session. Returns the full parsed
   * 200 body ({ info, parts, … }); the probe engine normalizes it.
   */
  async promptProbe(opts: {
    directory: string;
    sessionId: string;
    providerID: string;
    modelID: string;
    signal?: AbortSignal;
  }): Promise<{ info?: unknown; parts?: unknown } & Record<string, unknown>> {
    const q = new URLSearchParams({ directory: opts.directory });
    return this.getJson<
      { info?: unknown; parts?: unknown } & Record<string, unknown>
    >(`/session/${encodeURIComponent(opts.sessionId)}/message?${q.toString()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: { providerID: opts.providerID, modelID: opts.modelID },
        tools: {},
        parts: [{ type: "text", text: "Respond with: OK" }],
      }),
      signal: opts.signal,
    });
  }

  /** Abort a session (best-effort — callers wrap in try/catch). */
  async abortSession(
    sessionId: string,
    directory?: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const q = directory
      ? `?${new URLSearchParams({ directory }).toString()}`
      : "";
    return this.getJson<boolean>(
      `/session/${encodeURIComponent(sessionId)}/abort${q}`,
      { method: "POST", signal },
    );
  }

  /** Delete a session (best-effort — callers wrap in try/catch). */
  async deleteSession(
    sessionId: string,
    directory?: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const q = directory
      ? `?${new URLSearchParams({ directory }).toString()}`
      : "";
    return this.getJson<boolean>(
      `/session/${encodeURIComponent(sessionId)}${q}`,
      { method: "DELETE", signal },
    );
  }

  /**
   * Subscribe to instance SSE stream GET /event.
   * Yields parsed OpenCode events: { id?, type, properties }.
   * Throws/ends on disconnect — caller reconnects.
   */
  async *streamEvents(signal?: AbortSignal): AsyncGenerator<OpenCodeRawEvent> {
    const headers = this.headers();
    headers.set("Accept", "text/event-stream");
    const res = await this.fetchImpl(this.url(this.projectPath("/event")), {
      headers,
      signal,
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new Error(
        sanitizeOpenCodeError(
          `OpenCode /event → ${res.status}: ${body}`,
          [this.auth?.password],
        ),
      );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        if (signal?.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE events separated by blank line
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const chunk = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const evt = parseSseChunk(chunk);
          if (evt) yield evt;
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }
}

export interface OpenCodeRawEvent {
  id?: string;
  type: string;
  properties: Record<string, unknown>;
}

function parseSseChunk(chunk: string): OpenCodeRawEvent | null {
  const lines = chunk.split(/\r?\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue; // comment / heartbeat
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join("\n");
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Classic /event: { id, type, properties }
    if (typeof parsed.type === "string") {
      const props =
        parsed.properties && typeof parsed.properties === "object"
          ? (parsed.properties as Record<string, unknown>)
          : parsed.data && typeof parsed.data === "object"
            ? (parsed.data as Record<string, unknown>)
            : {};
      return {
        id: typeof parsed.id === "string" ? parsed.id : undefined,
        type: parsed.type,
        properties: props,
      };
    }
    // /global/event wrap: { payload: { id, type, properties }, directory? }
    if (parsed.payload && typeof parsed.payload === "object") {
      const p = parsed.payload as Record<string, unknown>;
      if (typeof p.type === "string") {
        return {
          id: typeof p.id === "string" ? p.id : undefined,
          type: p.type,
          properties:
            p.properties && typeof p.properties === "object"
              ? (p.properties as Record<string, unknown>)
              : {},
        };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function getId(p: unknown): string | undefined {
  if (p && typeof p === "object" && "id" in p) {
    const id = (p as { id: unknown }).id;
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
}

export function normalizeAgent(raw: unknown): LiveAgent {
  const a = (raw ?? {}) as Record<string, unknown>;
  const modelRaw = a.model as
    | { providerID?: string; modelID?: string; id?: string }
    | string
    | undefined;
  let model: LiveAgent["model"];
  if (modelRaw && typeof modelRaw === "object") {
    const providerID = modelRaw.providerID ?? "";
    const modelID = modelRaw.modelID ?? modelRaw.id ?? "";
    if (providerID || modelID) model = { providerID, modelID };
  } else if (typeof modelRaw === "string" && modelRaw.includes("/")) {
    const [providerID, ...rest] = modelRaw.split("/");
    model = { providerID: providerID ?? "", modelID: rest.join("/") };
  }
  return {
    name: String(a.name ?? a.id ?? "unknown"),
    mode: typeof a.mode === "string" ? a.mode : undefined,
    native: typeof a.native === "boolean" ? a.native : undefined,
    hidden: typeof a.hidden === "boolean" ? a.hidden : undefined,
    description: typeof a.description === "string" ? a.description : undefined,
    model,
    variant: typeof a.variant === "string" ? a.variant : undefined,
    temperature: typeof a.temperature === "number" ? a.temperature : undefined,
  };
}

export function normalizeSession(raw: unknown): LiveSession {
  const s = (raw ?? {}) as Record<string, unknown>;
  const modelRaw = s.model as
    | { id?: string; providerID?: string; variant?: string }
    | undefined;
  const time = s.time as { created?: number; updated?: number } | undefined;
  const title = typeof s.title === "string" ? s.title : undefined;
  return {
    id: String(s.id ?? ""),
    parentID: typeof s.parentID === "string" ? s.parentID : undefined,
    title,
    agent: typeof s.agent === "string" ? s.agent : undefined,
    model: modelRaw
      ? {
          id: String(modelRaw.id ?? ""),
          providerID: String(modelRaw.providerID ?? ""),
          variant: modelRaw.variant,
        }
      : undefined,
    directory: typeof s.directory === "string" ? s.directory : undefined,
    projectID: typeof s.projectID === "string" ? s.projectID : undefined,
    time,
    // Classify control-plane probe sessions now — raw `metadata` does not
    // survive normalization into LiveSession.
    ...(isControlPlaneProbeSession({ title, metadata: s.metadata })
      ? { controlPlaneProbe: true as const }
      : {}),
  };
}

export function normalizePermission(
  raw: unknown,
  askedAt: string,
): LivePermission {
  const p = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(p.id ?? p.requestID ?? crypto.randomUUID()),
    sessionID: typeof p.sessionID === "string" ? p.sessionID : undefined,
    permission: typeof p.permission === "string" ? p.permission : undefined,
    patterns: Array.isArray(p.patterns) ? (p.patterns as string[]) : undefined,
    tool: p.tool,
    metadata: p.metadata,
    askedAt,
    source: "rest",
  };
}

function pickStringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "string") out[k] = val;
    }
  }
  return out;
}

function pickBoolMap(
  v: unknown,
  keys: readonly string[],
): Record<string, boolean> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const src = v as Record<string, unknown>;
  const out: Record<string, boolean> = {};
  for (const k of keys) {
    if (typeof src[k] === "boolean") out[k] = src[k] as boolean;
  }
  return Object.keys(out).length ? out : undefined;
}

function pickNumMap(
  v: unknown,
  keys: readonly string[],
): Record<string, number> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const src = v as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const k of keys) {
    if (typeof src[k] === "number" && Number.isFinite(src[k] as number)) {
      out[k] = src[k] as number;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

const MODEL_MODALITY_KEYS = ["text", "audio", "image", "video", "pdf"] as const;
const MODEL_CAPABILITY_KEYS = [
  "temperature",
  "reasoning",
  "attachment",
  "toolcall",
] as const;

/**
 * Whitelisted model metadata extraction. STRICTLY emits only the fields
 * declared on LiveModel — never provider `key`, model `headers` / `options`,
 * or any other raw payload (the live /config/providers response carries a
 * credential `key` field on providers which must never leak into DTOs).
 */
function pickModelMetadata(
  mm: Record<string, unknown>,
  source: LiveModel["metadataSource"],
): Pick<LiveModel, "capabilities" | "limit" | "cost" | "status" | "metadataSource"> {
  const out: Pick<
    LiveModel,
    "capabilities" | "limit" | "cost" | "status" | "metadataSource"
  > = {};
  if (mm.capabilities && typeof mm.capabilities === "object") {
    const c = mm.capabilities as Record<string, unknown>;
    const input = pickBoolMap(c.input, MODEL_MODALITY_KEYS);
    const output = pickBoolMap(c.output, MODEL_MODALITY_KEYS);
    const capabilities: NonNullable<LiveModel["capabilities"]> = {
      ...(pickBoolMap(c, MODEL_CAPABILITY_KEYS) ?? {}),
      ...(input ? { input } : {}),
      ...(output ? { output } : {}),
    };
    if (Object.keys(capabilities).length) out.capabilities = capabilities;
  }
  const limit = pickNumMap(mm.limit, ["context", "output"]);
  if (limit) out.limit = limit;
  const cost = pickNumMap(mm.cost, ["input", "output"]);
  if (cost) out.cost = cost;
  if (typeof mm.status === "string") out.status = mm.status;
  if (source) out.metadataSource = source;
  return out;
}

function normalizeProvider(
  raw: unknown,
  connected: boolean,
  metadataSource?: LiveModel["metadataSource"],
): LiveProvider {
  const p = (raw ?? {}) as Record<string, unknown>;
  const id = String(p.id ?? "unknown");
  const modelsRaw = p.models;
  const models: LiveModel[] = [];
  if (Array.isArray(modelsRaw)) {
    for (const m of modelsRaw) {
      const mm = m as Record<string, unknown>;
      models.push({
        id: String(mm.id ?? mm.name ?? ""),
        name: typeof mm.name === "string" ? mm.name : undefined,
        providerID: id,
        ...pickModelMetadata(mm, metadataSource),
      });
    }
  } else if (modelsRaw && typeof modelsRaw === "object") {
    for (const [mid, mv] of Object.entries(
      modelsRaw as Record<string, unknown>,
    )) {
      const mm = (mv ?? {}) as Record<string, unknown>;
      models.push({
        id: mid,
        name: typeof mm.name === "string" ? mm.name : mid,
        providerID: id,
        ...pickModelMetadata(mm, metadataSource),
      });
    }
  }
  // Whitelist: provider `key`, `env`, `options` etc. are never read.
  return {
    id,
    name: String(p.name ?? id),
    connected,
    source: typeof p.source === "string" ? p.source : undefined,
    modelCount: models.length,
    models,
  };
}

/** Attach children arrays from flat parentID links. */
export function buildSessionTree(flat: LiveSession[]): LiveSession[] {
  const byId = new Map<string, LiveSession>();
  for (const s of flat) {
    byId.set(s.id, { ...s, children: [] });
  }
  const roots: LiveSession[] = [];
  for (const s of byId.values()) {
    if (s.parentID && byId.has(s.parentID)) {
      byId.get(s.parentID)!.children!.push(s);
    } else {
      roots.push(s);
    }
  }
  const sortFn = (a: LiveSession, b: LiveSession) =>
    (b.time?.updated ?? b.time?.created ?? 0) -
    (a.time?.updated ?? a.time?.created ?? 0);
  const sortTree = (nodes: LiveSession[]) => {
    nodes.sort(sortFn);
    for (const n of nodes) if (n.children?.length) sortTree(n.children);
  };
  sortTree(roots);
  return roots;
}

export function statusLabel(detail: unknown): string {
  if (detail == null) return "idle";
  if (typeof detail === "string") return detail;
  if (typeof detail === "object" && detail && "type" in detail) {
    return String((detail as { type: unknown }).type);
  }
  return "unknown";
}

export function emptyConnection(baseUrl: string): RuntimeConnection {
  return {
    rest: "disconnected",
    sse: "disconnected",
    stale: true,
    opencodeBaseUrl: baseUrl,
  };
}
