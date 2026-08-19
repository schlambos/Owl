/**
 * Client-side normalization + formatting for the provider-management
 * surfaces against the real manage/catalog DTOs (`@omo/shared`). The server
 * contract is already landed; unknown/missing fields degrade to honest
 * "Not reported" text while HTTP errors surface plainly, never masked.
 */
import type {
  OpenCodeProviderDesiredEntry,
  OpenCodeProviderLiveOverlay,
  OpenCodeProviderMutationError,
  OpenCodeProviderSourceKind,
  OpenCodeProvidersManageDto,
  OpenCodeProviderWriteTarget,
} from "@omo/shared";
import type { ManagedProviderRow } from "./types";

export function providerDisplayName(p: {
  id: string;
  name?: string;
}): string {
  return p.name && p.name !== p.id ? p.name : p.id;
}

export function sourceLabel(
  source: OpenCodeProviderSourceKind | undefined,
): string {
  switch (source) {
    case "env":
      return "Environment";
    case "config":
      return "Config";
    case "custom":
      return "Custom";
    case "api":
      return "API";
    default:
      return "Not reported";
  }
}

/**
 * Join the manage DTO's desired[] and live[] by provider id. Desired entries
 * come first (source of truth for user-level config); live-only rows
 * (running but undeclared) are appended after.
 */
export function joinManage(dto: OpenCodeProvidersManageDto): ManagedProviderRow[] {
  const rows: ManagedProviderRow[] = [];
  const seen = new Set<string>();
  const liveById = new Map<string, OpenCodeProviderLiveOverlay>(
    dto.live.map((l) => [l.id, l]),
  );
  for (const d of dto.desired) {
    const live = liveById.get(d.id) ?? null;
    const row: ManagedProviderRow = {
      id: d.id,
      ...(d.name ?? live?.name ? { name: (d.name ?? live?.name) as string } : {}),
      desired: d,
      live,
    };
    rows.push(row);
    seen.add(d.id);
  }
  for (const l of dto.live) {
    if (seen.has(l.id)) continue;
    if (!l.present) continue;
    const row: ManagedProviderRow = {
      id: l.id,
      ...(l.name ? { name: l.name } : {}),
      desired: null,
      live: l,
    };
    rows.push(row);
  }
  return rows;
}

/**
 * Effective enablement shown by the UI. Absent from both arrays means on by
 * default (OpenCode has the provider); presence in disabled (or the
 * disabled side of a conflict) wins.
 */
export function effectiveEnabled(
  desired: OpenCodeProviderDesiredEntry | null | undefined,
): boolean {
  if (!desired) return true;
  if (desired.disabled) return false;
  return true;
}

/** "Key on file" signal — never reveals values, only presence. */
export function credentialState(row: ManagedProviderRow): {
  tone: "ok" | "muted";
  label: string;
  title: string;
} {
  if (row.live?.connected) {
    return {
      tone: "ok",
      label: "Key on file",
      title: "Connected — OpenCode has accepted a credential for this provider.",
    };
  }
  if (row.desired?.inConfig || row.live?.present) {
    return {
      tone: "muted",
      label: "Not connected",
      title: "Provider is declared but OpenCode reports no working credential.",
    };
  }
  return {
    tone: "muted",
    label: "No credential reported",
    title: "Provider is neither declared in the user-level config nor running.",
  };
}

/** Format a mutation error list into one plain string. */
export function mutationErrorText(
  label: string,
  status: number,
  errors: OpenCodeProviderMutationError[] | undefined,
): string {
  if (errors && errors.length > 0) {
    const detail = errors
      .map((e) => (e.code ? `[${e.code}] ${e.message}` : e.message))
      .join("; ");
    return `${label} failed (HTTP ${status}): ${detail}`;
  }
  return `${label} failed (HTTP ${status}).`;
}

/** Extract a plain message from a server envelope of unknown shape. */
export function extractErrorText(data: unknown): string {
  if (data && typeof data === "object") {
    const d = data as {
      errors?: unknown;
      error?: unknown;
      message?: unknown;
    };
    if (Array.isArray(d.errors) && d.errors.length > 0) {
      return d.errors
        .map((e) => {
          if (e && typeof e === "object") {
            const o = e as { code?: unknown; message?: unknown };
            if (typeof o.message === "string") {
              return typeof o.code === "string" && o.code
                ? `[${o.code}] ${o.message}`
                : o.message;
            }
          }
          return String(e);
        })
        .join("; ");
    }
    if (d.error && typeof d.error === "object") {
      const o = d.error as { code?: unknown; message?: unknown };
      if (typeof o.message === "string") {
        return typeof o.code === "string" && o.code
          ? `[${o.code}] ${o.message}`
          : o.message;
      }
    }
    if (typeof d.error === "string" && d.error.trim()) return d.error;
    if (typeof d.message === "string" && d.message.trim()) return d.message;
  }
  if (typeof data === "string") return data.slice(0, 200);
  return "";
}

export function statusErrorMessage(
  label: string,
  status: number,
  data: unknown,
): string {
  const detail = extractErrorText(data);
  return `${label} failed (HTTP ${status})${detail ? `: ${detail}` : ""}`;
}

/** True when apply is admissible against this write target. */
export function writeTargetBindsApply(
  wt: OpenCodeProviderWriteTarget | null | undefined,
): boolean {
  return wt?.kind === "opencode-config-dir" || wt?.kind === "create";
}

/**
 * Hash to accompany apply, or undefined. Only the opencode-config-dir
 * target carries a baseline hash; create targets apply without one.
 */
export function expectedSourceHashFor(
  wt: OpenCodeProviderWriteTarget | null | undefined,
): string | undefined {
  return wt?.kind === "opencode-config-dir" ? wt.sourceHash : undefined;
}

/** Human description of the write target for quiet page meta. */
export function writeTargetMeta(
  wt: OpenCodeProviderWriteTarget | null | undefined,
): string {
  if (!wt) return "Write target not reported";
  switch (wt.kind) {
    case "opencode-config-dir":
      return `Writes to ${wt.path}`;
    case "create":
      return `Creates ${wt.path}`;
    case "project-masked":
      return "Writes masked by project config";
    case "blocked":
      return "Writes unavailable";
    default:
      return "Write target not reported";
  }
}

/** Reason text when apply must be blocked, else null. */
export function writeTargetBlockReason(
  wt: OpenCodeProviderWriteTarget | null | undefined,
): string | null {
  if (!wt) return "Write target not reported.";
  if (wt.kind === "project-masked") return `Masked by project config. ${wt.reason}`;
  if (wt.kind === "blocked") return wt.reason;
  return null;
}

/** Provider id rule (must match the server's /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/). */
export function providerIdError(id: string): string | null {
  if (!id) return "Provider id is required.";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) {
    return "Use letters, digits, '.', '_' or '-', starting with a letter or digit (max 128 chars).";
  }
  return null;
}

/** Copy text to clipboard; returns true on success. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
