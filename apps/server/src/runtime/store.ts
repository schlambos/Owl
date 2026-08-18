/**
 * Normalized in-memory Live runtime store.
 *
 * REST bootstrap/reconcile → store ← SSE incremental updates
 * Browser never sees raw OpenCode events.
 */

import type {
  ControlPlaneEvent,
  LiveAgent,
  LivePermission,
  LiveProvider,
  LiveSession,
  LiveSnapshot,
  OpenCodeLifecycleState,
  RuntimeConnection,
  RuntimeStateDto,
} from "@omo/shared";
import {
  buildSessionTree,
  emptyConnection,
  normalizeSession,
  OpenCodeClient,
  type OpenCodeRawEvent,
  statusLabel,
} from "../opencode/client";
import { flattenSessions } from "../domain/join";
import { deriveControlPlaneProbe } from "./probe-sessions";

export type StoreListener = (event: ControlPlaneEvent) => void;

/** Read-boundary visibility for control-plane probe sessions. */
export interface SessionReadOptions {
  /** Include control-plane probe sessions (default: excluded). */
  includeControlPlaneProbes?: boolean;
}

const RECONCILE_MS = 45_000;
const SSE_RETRY_BASE_MS = 1_000;
const SSE_RETRY_MAX_MS = 15_000;
/** Debounce high-frequency message.* noise into one UI push */
const EMIT_DEBOUNCE_MS = 75;

export class RuntimeStore {
  private client?: OpenCodeClient;
  private sessions = new Map<string, LiveSession>();
  private agents: LiveAgent[] = [];
  private providers: LiveProvider[] = [];
  private mcp: Record<string, { status: string }> = {};
  private permissions = new Map<string, LivePermission>();
  private health: LiveSnapshot["health"] = { healthy: false };
  private path?: LiveSnapshot["path"];
  private projectCurrent?: unknown;
  private connection: RuntimeConnection;
  private fetchedAt = new Date().toISOString();
  private backendGeneration = 0;

  /** Exposed for config-watch broadcast */
  readonly listeners = new Set<StoreListener>();
  private started = false;
  private sseAbort?: AbortController;
  private reconcileTimer?: ReturnType<typeof setInterval>;
  private emitTimer?: ReturnType<typeof setTimeout>;
  private pendingReason = "update";
  private sseAttempt = 0;
  /** Soft refresh flags set by events */
  private needMcpRefresh = false;
  private needProviderRefresh = false;
  private needAgentRefresh = false;

  /** Optional hook for session-detail cache invalidation */
  onEventReason?: (reason: string) => void;
  /** Lifecycle hook for a canonical backend REST loss. */
  onBackendLost?: (reason: string) => void;
  /** Lifecycle SSE readiness hook (SSE-only failure is degraded, not restart). */
  onConnectionChange?: (connection: RuntimeConnection) => void;

  constructor(
    private readonly projectDirectory?: string,
    private readonly authorizedRoots?: string[],
  ) {
    this.connection = emptyConnection("");
  }

  getClient(): OpenCodeClient {
    if (!this.client) throw new Error("OpenCode backend is not active");
    return this.client;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.reconcileTimer = setInterval(() => {
      if (this.client) void this.reconcile("periodic");
    }, RECONCILE_MS);
  }

  /** Activate exactly one lifecycle generation after readiness. */
  async activateBackend(lifecycle: OpenCodeLifecycleState): Promise<void> {
    if (lifecycle.status !== "connected" || !lifecycle.baseUrl) return;
    if (
      this.client?.baseUrl === lifecycle.baseUrl &&
      this.backendGeneration === lifecycle.generation
    ) return;
    this.sseAbort?.abort();
    this.client = undefined;
    this.clearBackendState("backend-activating", lifecycle.baseUrl);
    this.client = new OpenCodeClient(lifecycle.baseUrl, {
      projectDirectory: lifecycle.projectDirectory || this.projectDirectory,
      authorizedRoots: this.authorizedRoots,
    });
    this.backendGeneration = lifecycle.generation;
    this.sseAttempt = 0;
    const bootGeneration = lifecycle.generation;
    await this.bootstrap();
    if (
      this.started &&
      this.client &&
      this.backendGeneration === bootGeneration &&
      this.connection.rest === "connected"
    ) {
      void this.runSseLoop();
    }
  }

  /** Remove all backend-derived state while lifecycle selects/restarts a target. */
  deactivateBackend(reason = "backend-unavailable"): void {
    this.sseAbort?.abort();
    const baseUrl = this.client?.baseUrl ?? this.connection.opencodeBaseUrl;
    this.client = undefined;
    this.clearBackendState(reason, baseUrl);
  }

  getBackendGeneration(): number {
    return this.backendGeneration;
  }

  stop(): void {
    this.started = false;
    this.sseAbort?.abort();
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.emitTimer) clearTimeout(this.emitTimer);
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getConnection(): RuntimeConnection {
    return { ...this.connection };
  }

  getSnapshot(opts: SessionReadOptions = {}): LiveSnapshot {
    return {
      health: this.health,
      path: this.path,
      projectCurrent: this.projectCurrent,
      providers: this.providers,
      agents: this.agents,
      sessions: this.sessionTree(opts.includeControlPlaneProbes === true),
      mcp: this.mcp,
      permissions: [...this.permissions.values()],
      connection: this.getConnection(),
      fetchedAt: this.fetchedAt,
      baseUrl: this.client?.baseUrl ?? this.connection.opencodeBaseUrl,
      backendGeneration: this.backendGeneration,
    };
  }

  getRuntimeState(opts: SessionReadOptions = {}): RuntimeStateDto {
    const roots = this.sessionTree(opts.includeControlPlaneProbes === true);
    const flat = flattenSessions(roots).map((s) => {
      const { children: _c, ...rest } = s;
      return rest;
    });
    const byStatus: Record<string, number> = {};
    for (const s of flat) {
      const k = s.status ?? "idle";
      byStatus[k] = (byStatus[k] ?? 0) + 1;
    }
    return {
      health: this.health,
      path: this.path,
      projectCurrent: this.projectCurrent,
      providers: this.providers,
      agents: this.agents,
      sessions: {
        roots,
        flat,
        total: flat.length,
        byStatus,
      },
      mcp: this.mcp,
      permissions: [...this.permissions.values()],
      connection: this.getConnection(),
      fetchedAt: this.fetchedAt,
      baseUrl: this.client?.baseUrl ?? this.connection.opencodeBaseUrl,
      backendGeneration: this.backendGeneration,
    };
  }

  /** Immediate full state push to a single subscriber (SSE connect). */
  pushSnapshotTo(listener: StoreListener): void {
    const at = new Date().toISOString();
    listener({ type: "hello", version: "0.1.0", at });
    listener({ type: "snapshot", state: this.getRuntimeState(), at });
  }

  // ── bootstrap / reconcile ──────────────────────────────────────────

  async bootstrap(): Promise<void> {
    await this.reconcile("bootstrap");
  }

  async reconcile(reason: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.setRest(
      this.connection.rest === "connected" ? "connected" : "connecting",
    );
    // Refresh the /provider connected-provider authority ONLY on bootstrap,
    // reconnect after OpenCode-down/instode-dispose. Provider-catalog /
    // integration SSE events refresh it via refreshProviders(). Routine
    // periodic reconciles reuse the cached authority (merge semantics).
    if (
      reason === "bootstrap" ||
      reason === "sse-connected" ||
      reason === "instance-disposed" ||
      this.connection.rest === "disconnected"
    ) {
      await client.refreshProviderAuthority().catch(() => {
        /* keep prior authority; providers() will fall back to /provider */
      });
    }
    try {
      const [health, path, projectCurrent, agents, sessions, statusMap, mcp, prov, perms] =
        await Promise.all([
          client.health(),
          client.path().catch(() => undefined),
          client.projectCurrent().catch(() => undefined),
          client.agents(),
          client.sessions(),
          client.sessionStatus(),
          client.mcp().catch(() => ({}) as Record<string, { status: string }>),
          client.providers(),
          client.permissions(),
        ]);

      this.health = health;
      this.path = path;
      this.projectCurrent = projectCurrent;
      this.agents = agents;
      this.providers = prov.providers;
      this.mcp = mcp;
      this.fetchedAt = new Date().toISOString();

      // Replace session map from REST (authoritative)
      this.sessions.clear();
      for (const s of sessions) {
        const st = statusMap[s.id];
        this.sessions.set(s.id, {
          ...s,
          status: statusLabel(st),
          statusDetail: st,
        });
      }

      this.permissions.clear();
      for (const p of perms) this.permissions.set(p.id, p);

      this.connection = {
        ...this.connection,
        rest: "connected",
        restError: undefined,
        lastReconcileAt: this.fetchedAt,
        stale: this.connection.sse !== "connected",
      };
      this.needMcpRefresh = false;
      this.needProviderRefresh = false;
      this.needAgentRefresh = false;
      this.emitNow(reason);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.health = { healthy: false, error: msg };
      this.connection = {
        ...this.connection,
        rest: "disconnected",
        restError: msg,
        stale: true,
      };
      this.emitNow(`reconcile-failed:${reason}`);
      if (reason !== "bootstrap") {
        try {
          this.onBackendLost?.(msg);
        } catch {
          /* lifecycle callback isolation */
        }
      }
    }
  }

  // ── SSE loop ───────────────────────────────────────────────────────

  private async runSseLoop(): Promise<void> {
    const client = this.client;
    if (!client) return;
    while (this.started && this.client === client) {
      this.sseAbort = new AbortController();
      const connecting =
        this.sseAttempt === 0 ? "connecting" : "reconnecting";
      this.setSse(connecting);
      this.emitConnection();

      try {
        const stream = client.streamEvents(this.sseAbort.signal);
        let first = true;
        for await (const evt of stream) {
          if (!this.started || this.client !== client) break;
          if (first) {
            first = false;
            this.sseAttempt = 0;
            this.setSse("connected");
            // Fresh REST after (re)connect to catch anything missed
            void this.reconcile("sse-connected");
          }
          this.applyOpenCodeEvent(evt);
        }
        if (this.client !== client) return;
        // clean end
        this.setSse("disconnected", "SSE stream ended");
      } catch (err) {
        if (!this.started || this.client !== client) break;
        const msg = err instanceof Error ? err.message : String(err);
        this.setSse("disconnected", msg);
      }

      this.connection = { ...this.connection, stale: true };
      this.emitConnection();

      // backoff
      this.sseAttempt += 1;
      const delay = Math.min(
        SSE_RETRY_MAX_MS,
        SSE_RETRY_BASE_MS * 2 ** Math.min(this.sseAttempt - 1, 4),
      );
      await sleep(delay);
    }
  }

  // ── event application ──────────────────────────────────────────────

  applyOpenCodeEvent(evt: OpenCodeRawEvent): void {
    const now = new Date().toISOString();
    this.connection = {
      ...this.connection,
      lastEventAt: now,
      lastEventType: evt.type,
      sse: "connected",
      sseError: undefined,
      stale: this.connection.rest !== "connected",
    };

    const t = evt.type;
    const p = evt.properties;

    // High-frequency message traffic: only bump activity, debounced emit
    if (
      t.startsWith("message.") ||
      t.startsWith("session.next.text.") ||
      t.startsWith("session.next.reasoning.") ||
      t.startsWith("session.next.tool.") ||
      t === "session.next.tool.progress" ||
      t.endsWith(".delta")
    ) {
      const sessionID = stringProp(p, "sessionID");
      if (sessionID) this.touchSession(sessionID, now);
      this.emitDebounced(`oc:${t}`);
      return;
    }

    switch (t) {
      case "server.connected":
        this.emitDebounced("oc:server.connected");
        return;

      case "server.instance.disposed":
        // Instance context gone — full reconcile
        void this.reconcile("instance-disposed");
        return;

      case "session.created":
      case "session.updated": {
        const info = p.info ?? p.session;
        const sessionID = stringProp(p, "sessionID") ?? (info as { id?: string })?.id;
        if (info && typeof info === "object") {
          this.upsertSession(normalizeSession(info));
        } else if (sessionID && this.sessions.has(sessionID)) {
          this.touchSession(sessionID, now);
        }
        this.emitDebounced(`oc:${t}`);
        return;
      }

      case "session.deleted": {
        const sessionID =
          stringProp(p, "sessionID") ??
          (p.info && typeof p.info === "object"
            ? String((p.info as { id?: string }).id ?? "")
            : "");
        if (sessionID) this.sessions.delete(sessionID);
        this.emitDebounced("oc:session.deleted");
        return;
      }

      case "session.status": {
        const sessionID = stringProp(p, "sessionID");
        const status = p.status;
        if (sessionID) {
          const cur = this.sessions.get(sessionID);
          if (cur) {
            this.sessions.set(sessionID, {
              ...cur,
              status: statusLabel(status),
              statusDetail: status,
              time: {
                ...cur.time,
                updated: Date.now(),
              },
            });
          } else {
            // Unknown session — soft fetch not available; mark need reconcile lightly
            void this.reconcile("session-status-unknown");
            return;
          }
        }
        this.emitDebounced("oc:session.status");
        return;
      }

      case "session.idle": {
        const sessionID = stringProp(p, "sessionID");
        if (sessionID) {
          const cur = this.sessions.get(sessionID);
          if (cur) {
            this.sessions.set(sessionID, {
              ...cur,
              status: "idle",
              statusDetail: { type: "idle" },
            });
          }
        }
        this.emitDebounced("oc:session.idle");
        return;
      }

      case "session.error": {
        const sessionID = stringProp(p, "sessionID");
        if (sessionID) {
          const cur = this.sessions.get(sessionID);
          if (cur) {
            this.sessions.set(sessionID, {
              ...cur,
              status: "error",
              statusDetail: p.error ?? { type: "error" },
            });
          }
        }
        this.emitDebounced("oc:session.error");
        return;
      }

      case "session.next.step.started":
      case "session.next.prompted":
      case "session.next.prompt.admitted": {
        const sessionID = stringProp(p, "sessionID");
        if (sessionID) {
          const cur = this.sessions.get(sessionID);
          if (cur) {
            this.sessions.set(sessionID, {
              ...cur,
              status: "busy",
              statusDetail: { type: "busy", via: t },
              time: { ...cur.time, updated: Date.now() },
            });
          }
        }
        this.emitDebounced(`oc:${t}`);
        return;
      }

      case "session.next.step.ended":
      case "session.next.step.failed": {
        const sessionID = stringProp(p, "sessionID");
        if (sessionID) {
          const cur = this.sessions.get(sessionID);
          if (cur && cur.status === "busy") {
            // Prefer waiting for session.status/idle; soft mark
            this.sessions.set(sessionID, {
              ...cur,
              time: { ...cur.time, updated: Date.now() },
            });
          }
        }
        this.emitDebounced(`oc:${t}`);
        return;
      }

      case "session.next.agent.switched": {
        const sessionID = stringProp(p, "sessionID");
        const agent = stringProp(p, "agent");
        if (sessionID && agent) {
          const cur = this.sessions.get(sessionID);
          if (cur) {
            this.sessions.set(sessionID, { ...cur, agent });
          }
        }
        this.emitDebounced("oc:session.next.agent.switched");
        return;
      }

      case "session.next.model.switched": {
        const sessionID = stringProp(p, "sessionID");
        const model = p.model as
          | { id?: string; providerID?: string; variant?: string }
          | undefined;
        if (sessionID && model) {
          const cur = this.sessions.get(sessionID);
          if (cur) {
            this.sessions.set(sessionID, {
              ...cur,
              model: {
                id: String(model.id ?? ""),
                providerID: String(model.providerID ?? ""),
                variant: model.variant,
              },
            });
          }
        }
        this.emitDebounced("oc:session.next.model.switched");
        return;
      }

      case "permission.asked":
      case "permission.v2.asked": {
        const id = stringProp(p, "id") ?? stringProp(p, "requestID");
        if (id) {
          this.permissions.set(id, {
            id,
            sessionID: stringProp(p, "sessionID"),
            permission: stringProp(p, "permission"),
            patterns: Array.isArray(p.patterns)
              ? (p.patterns as string[])
              : undefined,
            tool: p.tool,
            metadata: p.metadata,
            askedAt: now,
            source: t === "permission.v2.asked" ? "permission.v2.asked" : "permission.asked",
          });
        }
        this.emitDebounced(`oc:${t}`);
        return;
      }

      case "permission.replied":
      case "permission.v2.replied": {
        const id = stringProp(p, "requestID") ?? stringProp(p, "id");
        if (id) this.permissions.delete(id);
        this.emitDebounced(`oc:${t}`);
        return;
      }

      case "mcp.tools.changed":
      case "mcp.browser.open.failed":
        this.needMcpRefresh = true;
        void this.refreshMcp();
        this.emitDebounced(`oc:${t}`);
        return;

      case "models-dev.refreshed":
      case "catalog.updated":
      case "integration.updated":
      case "integration.connection.updated":
        this.needProviderRefresh = true;
        void this.refreshProviders();
        this.emitDebounced(`oc:${t}`);
        return;

      case "lsp.updated":
        // no store field yet
        return;

      // Intentionally ignored (noise / out of slice)
      case "todo.updated":
      case "file.edited":
      case "file.watcher.updated":
      case "tui.prompt.append":
      case "tui.command.execute":
      case "tui.toast.show":
      case "tui.session.select":
      case "pty.created":
      case "pty.updated":
      case "pty.exited":
      case "pty.deleted":
      case "command.executed":
      case "question.asked":
      case "question.replied":
      case "question.rejected":
      case "question.v2.asked":
      case "question.v2.replied":
      case "question.v2.rejected":
      case "installation.updated":
      case "installation.update-available":
      case "project.updated":
      case "project.directories.updated":
      case "vcs.branch.updated":
      case "workspace.ready":
      case "workspace.failed":
      case "workspace.status":
      case "worktree.ready":
      case "worktree.failed":
      case "plugin.added":
      case "reference.updated":
      case "global.disposed":
      case "session.diff":
      case "session.compacted":
        return;

      default:
        // Unknown — record type only
        this.emitDebounced(`oc:other:${t}`);
        return;
    }
  }

  // ── helpers ────────────────────────────────────────────────────────

  private upsertSession(s: LiveSession): void {
    if (!s.id) return;
    const prev = this.sessions.get(s.id);
    // Classify control-plane probe sessions on upsert and RETAIN the tag in
    // the internal map — filtering happens at read boundaries only. The
    // client-side normalizer already classified from raw title+metadata;
    // re-derive here defensively for flagless/hand-built sessions.
    const probe = deriveControlPlaneProbe({
      title: s.title ?? prev?.title,
      controlPlaneProbe: s.controlPlaneProbe ?? prev?.controlPlaneProbe,
    });
    const merged: LiveSession = {
      ...prev,
      ...s,
      status: s.status ?? prev?.status ?? "idle",
      statusDetail: s.statusDetail ?? prev?.statusDetail,
      children: undefined,
    };
    if (probe) merged.controlPlaneProbe = true;
    else delete merged.controlPlaneProbe;
    this.sessions.set(s.id, merged);
  }

  private touchSession(sessionID: string, iso: string): void {
    const cur = this.sessions.get(sessionID);
    if (!cur) return;
    const ms = Date.parse(iso) || Date.now();
    this.sessions.set(sessionID, {
      ...cur,
      time: { ...cur.time, updated: ms },
    });
  }

  private sessionTree(includeControlPlaneProbes = false): LiveSession[] {
    const all = [...this.sessions.values()];
    const visible = includeControlPlaneProbes
      ? all
      : all.filter((s) => s.controlPlaneProbe !== true);
    return buildSessionTree(visible);
  }

  /** Probe-tagged sessions retained in the internal map (flat, unfiltered). */
  getProbeSessions(): LiveSession[] {
    return [...this.sessions.values()].filter(
      (s) => s.controlPlaneProbe === true,
    );
  }

  private async refreshMcp(): Promise<void> {
    if (!this.needMcpRefresh) return;
    try {
      const client = this.client;
      if (!client) return;
      this.mcp = await client.mcp();
      this.needMcpRefresh = false;
      this.emitDebounced("mcp-refresh");
    } catch {
      /* keep prior */
    }
  }

  private async refreshProviders(): Promise<void> {
    if (!this.needProviderRefresh) return;
    try {
      // Provider-catalog / integration SSE event: the connected set may have
      // changed — re-establish the /provider authority before the catalog
      // merge. /provider is fetched NOWHERE else routinely.
      const client = this.client;
      if (!client) return;
      await client.refreshProviderAuthority();
      const p = await client.providers();
      this.providers = p.providers;
      this.needProviderRefresh = false;
      this.emitDebounced("providers-refresh");
    } catch {
      /* keep prior */
    }
  }

  private setRest(state: RuntimeConnection["rest"], error?: string): void {
    this.connection = {
      ...this.connection,
      rest: state,
      restError: error,
      stale:
        state !== "connected" || this.connection.sse !== "connected",
    };
    try {
      this.onConnectionChange?.(this.getConnection());
    } catch {
      /* lifecycle callback isolation */
    }
  }

  private setSse(state: RuntimeConnection["sse"], error?: string): void {
    this.connection = {
      ...this.connection,
      sse: state,
      sseError: error,
      stale:
        this.connection.rest !== "connected" || state !== "connected",
    };
    try {
      this.onConnectionChange?.(this.getConnection());
    } catch {
      /* lifecycle callback isolation */
    }
  }

  private emitConnection(): void {
    const at = new Date().toISOString();
    this.broadcast({
      type: "connection",
      connection: this.getConnection(),
      at,
    });
  }

  private emitDebounced(reason: string): void {
    this.pendingReason = reason;
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      this.emitNow(this.pendingReason);
    }, EMIT_DEBOUNCE_MS);
  }

  private emitNow(reason: string): void {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = undefined;
    }
    const at = new Date().toISOString();
    this.fetchedAt = at;
    try {
      this.onEventReason?.(reason);
    } catch {
      /* ignore */
    }
    this.broadcast({
      type: "runtime.updated",
      reason,
      state: this.getRuntimeState(),
      at,
    });
  }

  private broadcast(event: ControlPlaneEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (e) {
        console.error("[runtime] listener error", e);
      }
    }
  }

  private clearBackendState(reason: string, baseUrl: string): void {
    this.sessions.clear();
    this.agents = [];
    this.providers = [];
    this.mcp = {};
    this.permissions.clear();
    this.health = { healthy: false, error: "OpenCode backend unavailable" };
    this.path = undefined;
    this.projectCurrent = undefined;
    this.needMcpRefresh = false;
    this.needProviderRefresh = false;
    this.needAgentRefresh = false;
    this.connection = {
      ...emptyConnection(baseUrl),
      restError: "OpenCode backend unavailable",
      sseError: "OpenCode backend unavailable",
    };
    this.emitNow(reason);
  }
}

function stringProp(
  p: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = p[key];
  return typeof v === "string" ? v : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
