import type {
  LiveSession,
  SessionAgentModelCompare,
  SessionDetail,
} from "@omo/shared";
import { OpenCodeClient, normalizeSession, statusLabel } from "../opencode/client";
import type { RuntimeStore } from "../runtime/store";
import type { LoadedOmo } from "../omo/loader";
import { desiredModelForAgent } from "../omo/loader";
import {
  buildActivity,
  diffFromSessionSummary,
  extractInitialInstruction,
  normalizeDiff,
  normalizeMessages,
} from "./normalize";

export interface DetailCacheEntry {
  detail: SessionDetail;
  fetchedAtMs: number;
  messagesFetchedAtMs: number;
  diffFetchedAtMs: number;
}

const CACHE_TTL_MS = 3_000;
const MESSAGE_STALE_MS = 2_000;
const DIFF_STALE_MS = 5_000;

export class SessionDetailService {
  private cache = new Map<string, DetailCacheEntry>();
  private inflight = new Map<string, Promise<SessionDetail>>();

  constructor(
    private runtime: RuntimeStore,
  ) {}

  private get client(): OpenCodeClient {
    return this.runtime.getClient();
  }

  /** Backend generations never share session detail/cache identity. */
  resetForBackendGeneration(): void {
    this.cache.clear();
    this.inflight.clear();
  }

  invalidate(sessionID: string, what: "all" | "messages" | "diff" | "meta" = "all"): void {
    if (what === "all") {
      this.cache.delete(sessionID);
      return;
    }
    const e = this.cache.get(sessionID);
    if (!e) return;
    if (what === "messages") e.messagesFetchedAtMs = 0;
    if (what === "diff") e.diffFetchedAtMs = 0;
    if (what === "meta") e.fetchedAtMs = 0;
  }

  /** Soft invalidation hooks from SSE reasons */
  onRuntimeEvent(reason: string, sessionIDs?: string[]): void {
    const touch = (id: string) => {
      if (reason.includes("message") || reason.includes("session.next") || reason.includes("tool")) {
        this.invalidate(id, "messages");
      }
      if (reason.includes("session.updated") || reason.includes("session.status") || reason.includes("session.idle")) {
        this.invalidate(id, "meta");
      }
      if (reason.includes("session.deleted")) {
        this.invalidate(id, "all");
      }
      if (reason.includes("file") || reason.includes("diff") || reason.includes("step.ended")) {
        this.invalidate(id, "diff");
      }
    };
    if (sessionIDs?.length) sessionIDs.forEach(touch);
    else {
      // Broad soft-stale: only mark messages stale for all cached (cheap)
      if (reason.includes("message") || reason.includes("session.next.tool")) {
        for (const id of this.cache.keys()) this.invalidate(id, "messages");
      }
    }
  }

  async getDetail(
    sessionID: string,
    opts: {
      omo?: LoadedOmo;
      force?: boolean;
      includeMessages?: boolean;
      includeDiff?: boolean;
    } = {},
  ): Promise<SessionDetail> {
    const includeMessages = opts.includeMessages !== false;
    const includeDiff = opts.includeDiff !== false;
    const now = Date.now();
    const cached = this.cache.get(sessionID);

    if (
      !opts.force &&
      cached &&
      now - cached.fetchedAtMs < CACHE_TTL_MS &&
      (!includeMessages || now - cached.messagesFetchedAtMs < MESSAGE_STALE_MS) &&
      (!includeDiff || now - cached.diffFetchedAtMs < DIFF_STALE_MS)
    ) {
      return this.enrichFromRuntime(cached.detail, opts.omo);
    }

    const key = `${sessionID}:${includeMessages}:${includeDiff}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const p = this.fetchDetail(sessionID, opts).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, p);
    return p;
  }

  private async fetchDetail(
    sessionID: string,
    opts: {
      omo?: LoadedOmo;
      includeMessages?: boolean;
      includeDiff?: boolean;
    },
  ): Promise<SessionDetail> {
    const includeMessages = opts.includeMessages !== false;
    const includeDiff = opts.includeDiff !== false;
    const errors: string[] = [];
    const fetchedAt = new Date().toISOString();
    const rt = this.runtime.getRuntimeState();
    const liveFlat = rt.sessions.flat;
    const liveNode = liveFlat.find((s) => s.id === sessionID);

    let metaRaw: unknown;
    let exists = true;
    try {
      metaRaw = await this.client.session(sessionID);
    } catch (e) {
      exists = false;
      errors.push(
        e instanceof Error ? e.message : `session fetch failed: ${String(e)}`,
      );
      if (liveNode) {
        // Stale last-known from runtime store
        const detail = this.buildFromLiveOnly(liveNode, rt, opts.omo, errors, fetchedAt);
        this.cache.set(sessionID, {
          detail,
          fetchedAtMs: Date.now(),
          messagesFetchedAtMs: 0,
          diffFetchedAtMs: 0,
        });
        return detail;
      }
      return {
        id: sessionID,
        exists: false,
        messages: [],
        activity: [],
        diff: { files: [], totalAdditions: 0, totalDeletions: 0, empty: true },
        permissions: [],
        children: [],
        siblings: [],
        initialInstructionLabel: "Initial user/delegation message",
        errors,
        fetchedAt,
        stale: rt.connection.stale,
      };
    }

    const session = normalizeSession(metaRaw);
    const meta = (metaRaw ?? {}) as Record<string, unknown>;
    const tokensRaw = meta.tokens as
      | {
          input?: number;
          output?: number;
          reasoning?: number;
          cache?: { read?: number; write?: number };
        }
      | undefined;

    let messages = cachedMessages(this.cache.get(sessionID));
    let messagesFetchedAtMs = this.cache.get(sessionID)?.messagesFetchedAtMs ?? 0;
    if (includeMessages) {
      try {
        const raw = await this.client.sessionMessages(sessionID);
        messages = normalizeMessages(raw);
        messagesFetchedAtMs = Date.now();
      } catch (e) {
        errors.push(
          e instanceof Error ? e.message : `messages: ${String(e)}`,
        );
      }
    }

    let diff = this.cache.get(sessionID)?.detail.diff ?? {
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      empty: true,
    };
    let diffFetchedAtMs = this.cache.get(sessionID)?.diffFetchedAtMs ?? 0;
    if (includeDiff) {
      try {
        const rawDiff = await this.client.sessionDiff(sessionID);
        diff = normalizeDiff(rawDiff);
        if (diff.empty) {
          const fromSum = diffFromSessionSummary(meta.summary);
          if (fromSum) diff = fromSum;
        }
        diffFetchedAtMs = Date.now();
      } catch (e) {
        errors.push(e instanceof Error ? e.message : `diff: ${String(e)}`);
        diff = {
          ...diff,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }

    let children: LiveSession[] = [];
    try {
      children = (await this.client.sessionChildren(sessionID)).map((c) => {
        const live = liveFlat.find((s) => s.id === c.id);
        return { ...c, status: live?.status ?? c.status };
      });
    } catch {
      children = (liveNode?.children ?? []).map((c) => {
        const { children: _x, ...rest } = c;
        return rest;
      });
    }

    const parentID = session.parentID ?? liveNode?.parentID;
    const parent = parentID
      ? liveFlat.find((s) => s.id === parentID)
      : undefined;
    const siblings = parentID
      ? liveFlat.filter((s) => s.parentID === parentID && s.id !== sessionID)
      : [];

    const permissions = rt.permissions.filter((p) => p.sessionID === sessionID);
    const status =
      liveNode?.status ??
      statusLabel(undefined);
    const { text: initialInstruction, label } =
      extractInitialInstruction(messages);
    const activity = buildActivity(messages);

    const directory =
      session.directory ??
      (typeof meta.directory === "string" ? meta.directory : undefined);

    const detail: SessionDetail = {
      id: sessionID,
      parentID,
      title: session.title ?? (typeof meta.title === "string" ? meta.title : undefined),
      agent: session.agent ?? (typeof meta.agent === "string" ? meta.agent : undefined),
      model: session.model
        ? {
            providerID: session.model.providerID,
            modelID: session.model.id,
            variant: session.model.variant,
          }
        : undefined,
      status,
      statusDetail: liveNode?.statusDetail,
      createdAt: session.time?.created,
      updatedAt: session.time?.updated,
      directory,
      directoryNote:
        "Directory is runtime metadata only; control plane does not open paths outside authorized roots.",
      version: typeof meta.version === "string" ? meta.version : undefined,
      cost: typeof meta.cost === "number" ? meta.cost : undefined,
      tokens: tokensRaw
        ? {
            input: tokensRaw.input,
            output: tokensRaw.output,
            reasoning: tokensRaw.reasoning,
            cacheRead: tokensRaw.cache?.read,
            cacheWrite: tokensRaw.cache?.write,
          }
        : undefined,
      summary:
        meta.summary && typeof meta.summary === "object"
          ? {
              additions: (meta.summary as { additions?: number }).additions,
              deletions: (meta.summary as { deletions?: number }).deletions,
              files: (meta.summary as { files?: number }).files,
            }
          : undefined,
      initialInstruction,
      initialInstructionLabel: label,
      messages,
      activity,
      diff,
      permissions,
      children,
      parent,
      siblings,
      agentCompare: buildAgentCompare(
        session.agent ?? liveNode?.agent,
        session.model
          ? {
              providerID: session.model.providerID,
              modelID: session.model.id,
              variant: session.model.variant,
            }
          : undefined,
        opts.omo,
      ),
      exists: true,
      stale: rt.connection.stale,
      errors,
      fetchedAt,
    };

    this.cache.set(sessionID, {
      detail,
      fetchedAtMs: Date.now(),
      messagesFetchedAtMs,
      diffFetchedAtMs,
    });
    return detail;
  }

  private enrichFromRuntime(detail: SessionDetail, omo?: LoadedOmo): SessionDetail {
    const rt = this.runtime.getRuntimeState();
    const live = rt.sessions.flat.find((s) => s.id === detail.id);
    const permissions = rt.permissions.filter((p) => p.sessionID === detail.id);
    return {
      ...detail,
      status: live?.status ?? detail.status,
      statusDetail: live?.statusDetail ?? detail.statusDetail,
      updatedAt: live?.time?.updated ?? detail.updatedAt,
      permissions,
      stale: rt.connection.stale,
      exists: live ? true : detail.exists,
      agentCompare: buildAgentCompare(detail.agent, detail.model, omo) ?? detail.agentCompare,
    };
  }

  private buildFromLiveOnly(
    live: LiveSession,
    rt: ReturnType<RuntimeStore["getRuntimeState"]>,
    omo: LoadedOmo | undefined,
    errors: string[],
    fetchedAt: string,
  ): SessionDetail {
    const parent = live.parentID
      ? rt.sessions.flat.find((s) => s.id === live.parentID)
      : undefined;
    const siblings = live.parentID
      ? rt.sessions.flat.filter(
          (s) => s.parentID === live.parentID && s.id !== live.id,
        )
      : [];
    const children = (live.children ?? []).map((c) => {
      const { children: _c, ...rest } = c;
      return rest;
    });
    return {
      id: live.id,
      parentID: live.parentID,
      title: live.title,
      agent: live.agent,
      model: live.model
        ? {
            providerID: live.model.providerID,
            modelID: live.model.id,
            variant: live.model.variant,
          }
        : undefined,
      status: live.status,
      statusDetail: live.statusDetail,
      createdAt: live.time?.created,
      updatedAt: live.time?.updated,
      directory: live.directory,
      directoryNote:
        "Directory is runtime metadata only; control plane does not open paths outside authorized roots.",
      initialInstructionLabel: "Initial user/delegation message",
      messages: [],
      activity: [],
      diff: { files: [], totalAdditions: 0, totalDeletions: 0, empty: true },
      permissions: rt.permissions.filter((p) => p.sessionID === live.id),
      children,
      parent,
      siblings,
      agentCompare: buildAgentCompare(
        live.agent,
        live.model
          ? {
              providerID: live.model.providerID,
              modelID: live.model.id,
              variant: live.model.variant,
            }
          : undefined,
        omo,
      ),
      exists: false,
      stale: true,
      errors: [
        ...errors,
        "Session no longer exists in the current OpenCode runtime (or fetch failed). Showing last known metadata.",
      ],
      fetchedAt,
    };
  }
}

function cachedMessages(entry?: DetailCacheEntry) {
  return entry?.detail.messages ?? [];
}

function buildAgentCompare(
  agent: string | undefined,
  sessionModel:
    | { providerID: string; modelID: string; variant?: string }
    | undefined,
  omo?: LoadedOmo,
): SessionAgentModelCompare | undefined {
  if (!agent && !sessionModel) return undefined;
  const sessionModelStr = sessionModel
    ? `${sessionModel.providerID}/${sessionModel.modelID}`
    : undefined;
  const desired = agent && omo
    ? desiredModelForAgent(omo.desired, omo.effective.preset, agent)
    : undefined;
  const eff = agent && omo ? omo.effective.agents[agent] : undefined;
  const effectiveModel = eff?.modelPrimary;
  const differs =
    !!sessionModelStr &&
    !!effectiveModel &&
    sessionModelStr !== effectiveModel;
  return {
    agent,
    desiredModel: desired,
    effectiveModel,
    effectiveVariant: eff?.variant,
    sessionModel: sessionModelStr,
    sessionVariant: sessionModel?.variant,
    differsFromEffective: differs,
    note: differs
      ? "Live differs from current effective configuration. Possible causes are not determined by OpenCode session data alone."
      : undefined,
  };
}
