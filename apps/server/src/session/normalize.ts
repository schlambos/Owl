/**
 * Normalize OpenCode session messages / parts / diffs into control-plane DTOs.
 * Behavior derived from OpenAPI + live /session/{id}/message samples.
 */

import type {
  MessagePartKind,
  NormalizedMessagePart,
  SessionActivityItem,
  SessionDiffSummary,
  SessionFileDiff,
  SessionMessageSummary,
} from "@omo/shared";

const MAX_TEXT_INLINE = 8_000;
const MAX_OUTPUT_INLINE = 6_000;

export function truncate(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max) + "\n…[truncated]", truncated: true };
}

export function summarizeToolInput(input: unknown): string | undefined {
  if (input == null) return undefined;
  if (typeof input === "string") return truncate(input, 200).text;
  if (typeof input !== "object") return String(input);
  const o = input as Record<string, unknown>;
  const keys = [
    "filePath",
    "path",
    "pattern",
    "glob",
    "command",
    "cmd",
    "query",
    "url",
    "description",
    "prompt",
    "content",
    "oldString",
    "newString",
    "name",
    "task",
    "subagent_type",
  ];
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) {
      const t = truncate(v.trim(), 160).text;
      return `${k}: ${t}`;
    }
  }
  try {
    return truncate(JSON.stringify(input), 160).text;
  } catch {
    return undefined;
  }
}

function partKind(type: string): MessagePartKind {
  switch (type) {
    case "text":
    case "reasoning":
    case "tool":
    case "file":
    case "subtask":
    case "step-start":
    case "step-finish":
    case "snapshot":
    case "patch":
    case "agent":
    case "retry":
    case "compaction":
      return type;
    default:
      return "unknown";
  }
}

export function normalizePart(raw: unknown): NormalizedMessagePart {
  const p = (raw ?? {}) as Record<string, unknown>;
  const rawType = String(p.type ?? "unknown");
  const kind = partKind(rawType);
  const id = String(p.id ?? crypto.randomUUID());
  const base: NormalizedMessagePart = {
    id,
    kind,
    rawType,
    synthetic: typeof p.synthetic === "boolean" ? p.synthetic : undefined,
  };

  if (kind === "text" || kind === "reasoning") {
    const full = String(p.text ?? "");
    const { text, truncated } = truncate(full, MAX_TEXT_INLINE);
    return { ...base, text, truncated };
  }

  if (kind === "tool") {
    const state = (p.state ?? {}) as Record<string, unknown>;
    const status = String(state.status ?? "unknown");
    const input = state.input;
    const output =
      typeof state.output === "string" ? state.output : undefined;
    const error = typeof state.error === "string" ? state.error : undefined;
    const outT = output ? truncate(output, MAX_OUTPUT_INLINE) : undefined;
    const time = state.time as { start?: number; end?: number } | undefined;
    return {
      ...base,
      truncated: outT?.truncated,
      tool: {
        name: String(p.tool ?? "unknown"),
        callID: typeof p.callID === "string" ? p.callID : undefined,
        status,
        title: typeof state.title === "string" ? state.title : undefined,
        inputSummary: summarizeToolInput(input),
        input,
        output: outT?.text,
        error,
        time,
      },
    };
  }

  if (kind === "file") {
    return {
      ...base,
      file: {
        filename: typeof p.filename === "string" ? p.filename : undefined,
        mime: typeof p.mime === "string" ? p.mime : undefined,
        url: typeof p.url === "string" ? p.url : undefined,
      },
    };
  }

  if (kind === "subtask") {
    return {
      ...base,
      text: typeof p.prompt === "string" ? truncate(p.prompt, MAX_TEXT_INLINE).text : undefined,
      subtask: {
        agent: typeof p.agent === "string" ? p.agent : undefined,
        description: typeof p.description === "string" ? p.description : undefined,
        prompt: typeof p.prompt === "string" ? p.prompt : undefined,
      },
    };
  }

  // Preserve unknown structure lightly
  return {
    ...base,
    meta: {
      keys: Object.keys(p).filter((k) => !["id", "sessionID", "messageID", "type"].includes(k)),
    },
  };
}

export function normalizeMessage(raw: unknown): SessionMessageSummary {
  // Live shape: { info, parts } — OpenAPI Message is the info object
  const envelope = (raw ?? {}) as Record<string, unknown>;
  const info = (
    envelope.info && typeof envelope.info === "object"
      ? envelope.info
      : envelope
  ) as Record<string, unknown>;
  const partsRaw = Array.isArray(envelope.parts)
    ? envelope.parts
    : Array.isArray(info.parts)
      ? info.parts
      : [];

  const roleRaw = String(info.role ?? "unknown");
  const role =
    roleRaw === "user" || roleRaw === "assistant"
      ? roleRaw
      : ("unknown" as const);

  const parts = partsRaw.map(normalizePart);
  const previewPart = parts.find(
    (p) =>
      (p.kind === "text" || p.kind === "reasoning") &&
      p.text &&
      !p.synthetic,
  );
  const model =
    info.model && typeof info.model === "object"
      ? (info.model as {
          providerID?: string;
          modelID?: string;
          variant?: string;
        })
      : info.providerID || info.modelID
        ? {
            providerID: typeof info.providerID === "string" ? info.providerID : undefined,
            modelID: typeof info.modelID === "string" ? info.modelID : undefined,
          }
        : undefined;

  const time = info.time as { created?: number; completed?: number } | undefined;

  return {
    id: String(info.id ?? envelope.id ?? crypto.randomUUID()),
    role,
    agent: typeof info.agent === "string" ? info.agent : undefined,
    model,
    createdAt: time?.created,
    completedAt: time?.completed,
    cost: typeof info.cost === "number" ? info.cost : undefined,
    error: info.error,
    preview: previewPart?.text
      ? truncate(previewPart.text, 280).text
      : undefined,
    parts,
  };
}

export function normalizeMessages(raw: unknown): SessionMessageSummary[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeMessage);
}

/** First non-synthetic user text — best-effort delegation/task body. */
export function extractInitialInstruction(
  messages: SessionMessageSummary[],
): { text?: string; label: string } {
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const p of m.parts) {
      if (p.kind === "text" && p.text && !p.synthetic) {
        return {
          text: p.text,
          label: "Initial user/delegation message",
        };
      }
    }
  }
  return { label: "Initial user/delegation message" };
}

export function buildActivity(
  messages: SessionMessageSummary[],
): SessionActivityItem[] {
  const items: SessionActivityItem[] = [];
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.kind === "tool" && p.tool) {
        items.push({
          id: p.id,
          at: p.tool.time?.start ?? m.createdAt,
          kind: "tool",
          label: p.tool.name,
          detail: p.tool.inputSummary ?? p.tool.title,
          status: p.tool.status,
          messageID: m.id,
        });
      } else if (p.kind === "step-start") {
        items.push({
          id: p.id,
          at: m.createdAt,
          kind: "step",
          label: "step-start",
          messageID: m.id,
        });
      } else if (p.kind === "step-finish") {
        items.push({
          id: p.id,
          at: m.completedAt ?? m.createdAt,
          kind: "step",
          label: "step-finish",
          messageID: m.id,
        });
      } else if (m.error && p === m.parts[0]) {
        items.push({
          id: `${m.id}-err`,
          at: m.createdAt,
          kind: "error",
          label: "message error",
          detail: typeof m.error === "string" ? m.error : "error",
          messageID: m.id,
        });
      }
    }
  }
  items.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  return items;
}

export function normalizeDiff(raw: unknown): SessionDiffSummary {
  try {
    if (raw == null) {
      return { files: [], totalAdditions: 0, totalDeletions: 0, empty: true };
    }
    // Endpoint returns SnapshotFileDiff[] directly (observed live)
    let list: unknown[] = [];
    if (Array.isArray(raw)) list = raw;
    else if (typeof raw === "object") {
      const o = raw as Record<string, unknown>;
      if (Array.isArray(o.diff)) list = o.diff;
      else if (o.data && typeof o.data === "object") {
        const d = o.data as Record<string, unknown>;
        if (Array.isArray(d.diff)) list = d.diff;
      }
    }

    const files: SessionFileDiff[] = list.map((item) => {
      const f = (item ?? {}) as Record<string, unknown>;
      return {
        file: typeof f.file === "string" ? f.file : undefined,
        patch: typeof f.patch === "string" ? f.patch : undefined,
        additions: typeof f.additions === "number" ? f.additions : 0,
        deletions: typeof f.deletions === "number" ? f.deletions : 0,
        status: typeof f.status === "string" ? f.status : undefined,
      };
    });

    const totalAdditions = files.reduce((s, f) => s + f.additions, 0);
    const totalDeletions = files.reduce((s, f) => s + f.deletions, 0);
    return {
      files,
      totalAdditions,
      totalDeletions,
      empty: files.length === 0,
    };
  } catch (e) {
    return {
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      empty: true,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export function diffFromSessionSummary(summary: unknown): SessionDiffSummary | null {
  if (!summary || typeof summary !== "object") return null;
  const s = summary as Record<string, unknown>;
  const additions = typeof s.additions === "number" ? s.additions : 0;
  const deletions = typeof s.deletions === "number" ? s.deletions : 0;
  const filesCount = typeof s.files === "number" ? s.files : 0;
  const diffs = Array.isArray(s.diffs) ? s.diffs : [];
  if (diffs.length > 0) {
    const n = normalizeDiff(diffs);
    return { ...n, fromSummary: true };
  }
  if (additions === 0 && deletions === 0 && filesCount === 0) return null;
  return {
    files: [],
    totalAdditions: additions,
    totalDeletions: deletions,
    empty: filesCount === 0,
    fromSummary: true,
  };
}
