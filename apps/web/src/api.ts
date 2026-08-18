import type {
  AgentsDto,
  InterviewCommitResponse,
  InterviewMutationRequest,
  InterviewPreviewResponse,
  ModelAvailabilityDetail,
  ModelInventoryDto,
  ModelProbeQueueItem,
  ModelProbeQueueSnapshot,
  ModelProbeRun,
  ModelProbeSummary,
  OverviewDto,
  ProvidersDto,
  RawCommitResponse,
  RawCompareResponse,
  RawMutationRequest,
  RawOmoSourceId,
  RawPreviewResponse,
  RawSourceLoadResponse,
  RuntimeStateDto,
  SessionDetail,
  SessionsDto,
  SourceFingerprint,
  OmoSchemaStatus,
} from "@omo/shared";
import {
  isInterviewCommitResponse,
  isInterviewPreviewResponse,
  isRawCommitResponse,
  isRawPreviewResponse,
} from "@omo/shared";

async function getStatusJson(path: string): Promise<{ status: number; data: unknown }> {
  const res = await fetch(path);
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function postStatusJson(
  path: string,
  body: unknown,
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(path, post(body));
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${path} → ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** Result of POST /api/models/probe for a single model. */
export type ModelProbeEnqueueResult =
  | ModelProbeQueueItem
  | { skipped: "fresh"; latest?: ModelProbeSummary };

export interface ModelProbeBatchResult {
  accepted: Array<{ providerId?: string; modelId?: string; id?: string }>;
  skipped: Array<{ providerId?: string; modelId?: string; reason?: string }>;
  /** Count or list, depending on server shape. */
  deduped?: number | Array<unknown>;
  queue?: ModelProbeQueueSnapshot;
}

export interface ModelProbeHistoryDto {
  providerId: string;
  modelId: string;
  probes: ModelProbeRun[];
}

const modelSeg = (s: string) => encodeURIComponent(s);

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export class RawContractError extends Error {
  readonly name = "RawContractError";
  constructor(kind: "preview" | "apply") {
    super(
      kind === "preview"
        ? "Raw preview response does not match the shared contract."
        : "Raw apply response does not match the shared contract.",
    );
  }
}

export function parseRawSimulateResponse(value: unknown): RawPreviewResponse {
  if (isRawPreviewResponse(value)) return value;
  throw new RawContractError("preview");
}

export function parseRawApplyResponse(value: unknown): RawCommitResponse {
  if (isRawCommitResponse(value)) return value;
  throw new RawContractError("apply");
}

export class InterviewContractError extends Error {
  readonly name = "InterviewContractError";
  constructor(kind: "preview" | "apply") {
    super(
      kind === "preview"
        ? "Interview preview response does not match the shared contract."
        : "Interview apply response does not match the shared contract.",
    );
  }
}

/** Validate/normalize POST /api/config/interview/simulate JSON. */
export function parseInterviewSimulateResponse(
  value: unknown,
): InterviewPreviewResponse {
  if (isInterviewPreviewResponse(value)) return value;
  throw new InterviewContractError("preview");
}

/** Validate/normalize POST /api/config/interview/apply JSON. */
export function parseInterviewApplyResponse(
  value: unknown,
): InterviewCommitResponse {
  if (isInterviewCommitResponse(value)) return value;
  throw new InterviewContractError("apply");
}

async function postInterviewSimulate(
  body: InterviewMutationRequest,
): Promise<{ status: number; data: InterviewPreviewResponse }> {
  const res = await fetch("/api/config/interview/simulate", post(body));
  return {
    status: res.status,
    data: parseInterviewSimulateResponse(await res.json()),
  };
}

async function postInterviewApply(
  body: InterviewMutationRequest,
): Promise<{ status: number; data: InterviewCommitResponse }> {
  const res = await fetch("/api/config/interview/apply", post(body));
  return {
    status: res.status,
    data: parseInterviewApplyResponse(await res.json()),
  };
}

export const api = {
  overview: () => getJson<OverviewDto>("/api/overview"),
  providers: () => getJson<ProvidersDto>("/api/providers"),
  agents: () => getJson<AgentsDto>("/api/agents"),
  sessions: () => getJson<SessionsDto>("/api/sessions"),
  sessionDetail: (id: string, force = false) =>
    getJson<SessionDetail>(
      `/api/sessions/${encodeURIComponent(id)}${force ? "?force=1" : ""}`,
    ),
  runtime: () => getJson<RuntimeStateDto>("/api/runtime"),
  reconcile: () =>
    getJson<{ ok: boolean; state: RuntimeStateDto }>("/api/runtime/reconcile", {
      method: "POST",
    }),
  omoConfig: () => getJson<unknown>("/api/omo/config"),
  omoSchema: () => getJson<OmoSchemaStatus>("/api/omo/schema"),
  interview: () => getJson<unknown>("/api/config/interview"),
  simulateInterview: (body: InterviewMutationRequest) =>
    postInterviewSimulate(body),
  applyInterview: (body: InterviewMutationRequest) => postInterviewApply(body),
  rawSource: (sourceId: RawOmoSourceId) =>
    getStatusJson(`/api/config/raw?sourceId=${sourceId}`),
  simulateRaw: (body: RawMutationRequest) =>
    postStatusJson("/api/config/raw/simulate", body),
  applyRaw: (body: RawMutationRequest) =>
    postStatusJson("/api/config/raw/apply", body),
  compareRaw: (body: { sourceId: RawOmoSourceId; draftText: string }) =>
    postStatusJson("/api/config/raw/compare", body),
  schemaDocument: () => getStatusJson("/api/omo/schema/document"),
  omoRevisions: (sourceId: RawOmoSourceId, limit = 50) =>
    getJson<unknown>(`/api/config/omo-revisions?sourceId=${sourceId}&limit=${limit}`),
  omoRevision: (id: string) =>
    getJson<unknown>(`/api/config/omo-revisions/${encodeURIComponent(id)}`),
  simulateOmoRestore: (
    id: string,
    body: { sourceId: RawOmoSourceId; expectedSource: SourceFingerprint },
  ) =>
    postStatusJson(
      `/api/config/omo-revisions/${encodeURIComponent(id)}/simulate-restore`,
      body,
    ),
  restoreOmoRevision: (
    id: string,
    body: {
      sourceId: RawOmoSourceId;
      expectedSource: SourceFingerprint;
      expectedCandidateSha256: string;
    },
  ) =>
    postStatusJson(
      `/api/config/omo-revisions/${encodeURIComponent(id)}/restore`,
      body,
    ),
  // ── Model inventory & probing (Slice 15) ─────────────────────────
  modelInventory: () => getJson<ModelInventoryDto>("/api/models"),
  modelDetail: (providerId: string, modelId: string) =>
    getJson<ModelAvailabilityDetail>(
      `/api/models/${modelSeg(providerId)}/${modelSeg(modelId)}`,
    ),
  modelProbeHistory: (providerId: string, modelId: string) =>
    getJson<ModelProbeHistoryDto>(
      `/api/models/${modelSeg(providerId)}/${modelSeg(modelId)}/probes`,
    ),
  probeModel: (providerId: string, modelId: string, force = false) =>
    getJson<ModelProbeEnqueueResult>(
      "/api/models/probe",
      post({ providerId, modelId, ...(force ? { force: true } : {}) }),
    ),
  probeBatch: (
    models: Array<{ providerId: string; modelId: string }>,
    opts: {
      force?: boolean;
      skipRecentlyTested?: boolean;
      acknowledgeLargeBatch?: boolean;
    } = {},
  ) => getJson<ModelProbeBatchResult>("/api/models/probe-batch", post({ models, ...opts })),
  cancelProbe: (id: string) =>
    getJson<ModelProbeQueueSnapshot>(
      `/api/models/probes/${encodeURIComponent(id)}/cancel`,
      { method: "POST" },
    ),
};
