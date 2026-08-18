/**
 * Pure scanners for OMO task surfaces in OpenCode message parts. No I/O.
 *
 * Every hardcoded OMO format cites installed oh-my-opencode-slim@2.2.10
 * dist/index.js line numbers (verified 2026-08-11).
 */

import type { OmoJobState } from "./types";

// ── Installed-format regexes (exact copies) ──────────────────────────────

/** parseTaskIdFromTaskOutput XML branch — dist/index.js:24937-24938. */
const TASK_ID_XML = /<task\s+[^>]*\bid=["']([^"']+)["'][^>]*>/i;
/** parseTaskIdFromTaskOutput header branch — dist/index.js:24945. */
const TASK_ID_HEADER = /^task_id:\s*([^\s()]+)(?:\s*\(.*)?$/;
/** parseTaskStateFromOutput XML branch — dist/index.js:24977. */
const TASK_STATE_XML =
  /<task\s+[^>]*\bstate=["'](running|completed|error|cancelled)["'][^>]*>/i;
/** parseTaskStateFromOutput header branch — dist/index.js:24981. */
const TASK_STATE_HEADER = /^state:\s*(running|completed|error|cancelled)\s*$/i;
/** parseTaskResultFromOutput — dist/index.js:24988-24990 (trimmed; empty → undefined). */
const TASK_RESULT_BODY = /<task_(result|error)>\s*([\s\S]*?)\s*<\/task_\1>/m;
/** getTaskHeader boundary — dist/index.js:24992-24997. */
const TASK_BODY_START = /<task_(?:result|error)>/;
/** timedOut marker — dist/index.js:24972. */
const TIMED_OUT = /Timed out after \d+ms/i;

/**
 * Alias shape: AGENT_PREFIX (dist/index.js:25005-25013: cou/des/exp/fix/lib/
 * obs/ora) or agent.slice(0,3) fallback + "-N" counter (nextAlias,
 * dist/index.js:25496-25503). Board rows render "- alias / taskID / agent /
 * state" (dist/index.js:25487).
 */
const ALIAS_SHAPE = /^[a-z]{2,4}-\d+$/;
const BOARD_ROW = /(^|[\s(])([a-z]{2,4}-\d+)\s*\/\s*([^\s/,)]+)/g;

export interface ParsedTaskStatus {
  taskID: string;
  state: OmoJobState;
  timedOut: boolean;
  result?: string;
}

/** Header lines are only scanned before the first <task_result|task_error>. */
function taskHeader(output: string): string {
  const idx = output.search(TASK_BODY_START);
  return idx === -1 ? output : output.slice(0, idx);
}

/**
 * Mirror of parseTaskStatusOutput (dist/index.js:24964-24974):
 * requires BOTH taskID and state; timedOut only for running + timeout text.
 */
export function parseTaskStatusOutput(output: string): ParsedTaskStatus | undefined {
  if (typeof output !== "string" || output.length === 0) return undefined;

  let taskID: string | undefined;
  const xmlId = TASK_ID_XML.exec(output);
  if (xmlId) {
    taskID = xmlId[1];
  } else {
    for (const line of output.split(/\r?\n/)) {
      const m = TASK_ID_HEADER.exec(line.trim());
      if (m) {
        taskID = m[1];
        break;
      }
    }
  }

  let state: OmoJobState | undefined;
  const xmlState = TASK_STATE_XML.exec(output);
  if (xmlState) {
    state = xmlState[1]!.toLowerCase() as OmoJobState;
  } else {
    for (const line of taskHeader(output).split(/\r?\n/)) {
      const m = TASK_STATE_HEADER.exec(line.trim());
      if (m) {
        state = m[1]!.toLowerCase() as OmoJobState;
        break;
      }
    }
  }

  if (!taskID || !state) return undefined;

  const body = TASK_RESULT_BODY.exec(output);
  const result = body?.[2]?.trim() || undefined;

  return {
    taskID,
    state,
    timedOut: state === "running" && TIMED_OUT.test(output),
    result,
  };
}

/** Extract alias (exp-1 style) from result text/metadata when present. */
export function extractAlias(
  text: string | undefined,
  meta?: { alias?: unknown },
  taskId?: string,
): string | undefined {
  if (meta && typeof meta.alias === "string" && ALIAS_SHAPE.test(meta.alias)) {
    return meta.alias;
  }
  if (!text) return undefined;
  BOARD_ROW.lastIndex = 0;
  let m: RegExpExecArray | null;
  let fallback: string | undefined;
  while ((m = BOARD_ROW.exec(text)) !== null) {
    const alias = m[2]!;
    const ref = m[3]!;
    if (!ALIAS_SHAPE.test(alias)) continue;
    if (taskId && ref === taskId) return alias;
    fallback ??= alias;
  }
  // Only return unanchored alias when no specific taskId was requested.
  return taskId ? undefined : fallback;
}

// ── OpenCode message-part scanning ───────────────────────────────────────

/** Minimal structural view of an OpenCode message (live-verified 2026-08-11). */
export interface RawMessage {
  info?: { role?: string; id?: string; time?: { created?: number } };
  parts?: RawPart[];
}

export interface RawPart {
  type?: string;
  tool?: string;
  id?: string;
  state?: {
    input?: Record<string, unknown>;
    output?: unknown;
    metadata?: Record<string, unknown>;
    status?: string;
    time?: { start?: number; end?: number };
    title?: string;
  };
  metadata?: Record<string, unknown>;
  synthetic?: boolean;
}

export type TaskEvidenceKind = "launch" | "resume-request" | "status";

/** Partial job evidence from one `task` tool part. */
export interface TaskCallEvidence {
  kind: TaskEvidenceKind;
  /** Session containing the part. */
  parentSessionId: string;
  partId?: string;
  /** input.task_id — reuse/resume request surface (dist/index.js:19352-19353). */
  requestedTaskId?: string;
  subagentType?: string;
  /** input.description ONLY — never input.prompt (security.ts). */
  description?: string;
  /** state.metadata.sessionId (persisted, live-verified) or parsed from output. */
  childSessionId?: string;
  /** Parsed taskID from output text. */
  outputTaskId?: string;
  /** Parsed state from output; falls back to part state.status when it maps. */
  state?: OmoJobState;
  timedOut?: boolean;
  /** Trimmed <task_result|task_error> body (uncapped here; capped in store). */
  result?: string;
  alias?: string;
  startedAt?: number;
  endedAt?: number;
}

/** Other OMO-relevant tools observed (no job semantics attached). */
export interface OtherOmoToolEvidence {
  tool: "cancelTask" | "waitForUser";
  parentSessionId: string;
  partId?: string;
  status?: string;
}

export interface ScanResult {
  calls: TaskCallEvidence[];
  otherTools: OtherOmoToolEvidence[];
}

const STATE_FROM_PART_STATUS: Record<string, OmoJobState> = {
  running: "running",
  completed: "completed",
  error: "error",
  cancelled: "cancelled",
};

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Scan one session's messages for OMO task evidence.
 * Persisted parts only (live-verified): board snapshots / internal-initiator
 * prompt-transform parts do NOT persist, so they are never expected here.
 */
export function scanMessagesForJobs(
  messages: unknown,
  parentSessionId: string,
): ScanResult {
  const out: ScanResult = { calls: [], otherTools: [] };
  if (!Array.isArray(messages)) return out;
  for (const msg of messages as RawMessage[]) {
    if (!msg || !Array.isArray(msg.parts)) continue;
    for (const part of msg.parts) {
      if (!part || part.type !== "tool" || typeof part.tool !== "string") {
        continue;
      }
      if (part.tool === "cancelTask" || part.tool === "waitForUser") {
        out.otherTools.push({
          tool: part.tool,
          parentSessionId,
          partId: asString(part.id),
          status: asString(part.state?.status),
        });
        continue;
      }
      if (part.tool !== "task") continue;
      const ev = taskPartEvidence(part, parentSessionId);
      if (ev) out.calls.push(ev);
    }
  }
  return out;
}

function taskPartEvidence(
  part: RawPart,
  parentSessionId: string,
): TaskCallEvidence | undefined {
  const st = part.state;
  if (!st) return undefined;
  const input = st.input ?? {};
  const meta = st.metadata ?? {};

  const requestedTaskId = asString(input.task_id);
  const subagentType = asString(input.subagent_type);
  const description = asString(input.description);
  const metaChild = asString(meta.sessionId);
  const output = typeof st.output === "string" ? st.output : undefined;

  const parsed = output ? parseTaskStatusOutput(output) : undefined;
  const childSessionId = metaChild ?? parsed?.taskID;
  const state = parsed?.state ?? STATE_FROM_PART_STATUS[st.status ?? ""];
  const alias = extractAlias(output, meta as { alias?: unknown }, parsed?.taskID);

  const kind: TaskEvidenceKind = requestedTaskId
    ? "resume-request"
    : parsed || state
      ? "status"
      : "launch";

  return {
    kind,
    parentSessionId,
    partId: asString(part.id),
    requestedTaskId,
    subagentType,
    description,
    childSessionId,
    outputTaskId: parsed?.taskID,
    state,
    timedOut: parsed?.timedOut,
    result: parsed?.result,
    alias,
    startedAt: st.time?.start,
    endedAt: st.time?.end,
  };
}

/**
 * Build/merge job evidence into launch/resume/completion buckets keyed by
 * task identity. Pure helper used by the store (kept here for testability).
 */
export function scanToolParts(
  results: ScanResult[],
): {
  launches: TaskCallEvidence[];
  resumeRequests: TaskCallEvidence[];
  completions: TaskCallEvidence[];
  otherTools: OtherOmoToolEvidence[];
} {
  const launches: TaskCallEvidence[] = [];
  const resumeRequests: TaskCallEvidence[] = [];
  const completions: TaskCallEvidence[] = [];
  const otherTools: OtherOmoToolEvidence[] = [];
  for (const r of results) {
    for (const c of r.calls) {
      if (c.kind === "resume-request") resumeRequests.push(c);
      else if (c.state && c.state !== "running") completions.push(c);
      else launches.push(c);
    }
    otherTools.push(...r.otherTools);
  }
  return { launches, resumeRequests, completions, otherTools };
}
