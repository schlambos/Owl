/**
 * Pure probe-outcome normalization (Slice 15, Lane 1).
 *
 * Authoritative classification order (see PLAN/Slice 15 design):
 *   1. control-plane deadline fired          → timeout
 *   2. user cancel                            → error ("aborted")
 *   3. transport failure mid-probe            → opencode-disconnected
 *   4. provider preflight disconnected        → provider-disconnected
 *   5. true non-200 from create/prompt        → status-driven
 *   6. HTTP 200 + usable envelope             → healthy
 *   7. HTTP 200 + info.error present          → AssistantMessage error union
 *   8. HTTP 200 failing predicate, no error   → malformed
 *   9. else                                   → error
 *
 * AssistantMessage error union verified against .opencode-openapi.json:
 * discriminators: ProviderAuthError | UnknownError | MessageOutputLengthError |
 * MessageAbortedError | StructuredOutputError | ContextOverflowError |
 * ContentFilterError | APIError. APIError.data.statusCode is an OPTIONAL
 * integer. AssistantMessage carries `modelID` (used for responseModel) and
 * `error` is OPTIONAL (`"error" in info` is the presence test).
 *
 * No prompt text, response text, tokens, or credentials ever flow out of
 * this module. All error messages pass through sanitizeErrorMessage().
 */

import type { ModelProbeFreshness, ModelProbeTerminalState } from "@omo/shared";
import { PROBE_FRESHNESS_MS, PROBE_TIMEOUT_MS } from "./constants";

const MESSAGE_CAP = 240;

/**
 * Sanitize an error message for persistence: strip bearer tokens, common
 * credential patterns, auth-header values, and URL query strings; collapse
 * whitespace; cap at 240 chars. Returns undefined for empty/non-renderable
 * input. Never throws.
 */
export function sanitizeErrorMessage(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  let s: string;
  if (typeof raw === "string") {
    s = raw;
  } else if (raw instanceof Error) {
    s = raw.message;
  } else {
    try {
      s = JSON.stringify(raw) ?? String(raw);
    } catch {
      s = String(raw);
    }
  }
  if (!s) return undefined;
  s = s
    // URL query strings / fragments (whole query can carry credentials)
    .replace(/(https?:\/\/[^\s?"'()[\]]*)[?#][^\s"'()[\]]*/gi, "$1")
    // bearer / token-shaped secrets
    .replace(/bearer\s+[^\s"']+/gi, "bearer [redacted]")
    .replace(/basic\s+[A-Za-z0-9+/=._~-]+/gi, "basic [redacted]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/\b(?:sk|pk|api|key|token|secret|password)-[A-Za-z0-9_-]{8,}\b/gi, "[redacted]")
    // key/value credential material
    .replace(
      /(authorization|api[-_]?key|access[-_]?token|x-api-key|client[-_]?secret|password)\s*[:=]\s*[^\s,;"']+/gi,
      "$1: [redacted]",
    )
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return undefined;
  return s.length > MESSAGE_CAP ? `${s.slice(0, MESSAGE_CAP - 3)}...` : s;
}

/**
 * Healthy-envelope predicate: body.info.role === "assistant" AND
 * !("error" in body.info) AND Array.isArray(body.parts) AND
 * body.parts.length > 0.
 */
export function usableEnvelope(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  const info = b.info;
  if (!info || typeof info !== "object" || Array.isArray(info)) return false;
  const i = info as Record<string, unknown>;
  if (i.role !== "assistant") return false;
  if ("error" in i) return false;
  return Array.isArray(b.parts) && b.parts.length > 0;
}

export interface ProbeOutcomeInput {
  /** Control-plane deadline fired (PROBE_TIMEOUT_MS). */
  deadlineFired?: boolean;
  /** User-initiated cancel. */
  cancelled?: boolean;
  /** Transport failure / connection refusal / loss mid-probe. */
  transportError?: unknown;
  /** Provider not in the connected set BEFORE session creation. */
  providerPreflightDisconnected?: boolean;
  /** True non-2xx from session create or message (OpenCodeRequestError). */
  requestError?: { status: number; message?: unknown };
  /** Parsed HTTP 200 body from promptProbe ({ info, parts, … }). */
  response?: unknown;
}

export interface ProbeOutcome {
  state: ModelProbeTerminalState;
  statusCode?: number;
  errorCode?: string;
  /** Sanitized — safe to persist. */
  errorMessage?: string;
  responseModel?: string;
}

function infoOf(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const info = (body as Record<string, unknown>).info;
  if (!info || typeof info !== "object" || Array.isArray(info)) return undefined;
  return info as Record<string, unknown>;
}

function messageOf(errorData: unknown): unknown {
  if (errorData && typeof errorData === "object" && !Array.isArray(errorData)) {
    return (errorData as Record<string, unknown>).message;
  }
  return undefined;
}

/** AUTHORITATIVE ordering — see file header. Pure. */
export function normalizeProbeOutcome(input: ProbeOutcomeInput): ProbeOutcome {
  // 1. control-plane deadline fired
  if (input.deadlineFired === true) {
    return {
      state: "timeout",
      errorCode: "timeout",
      errorMessage: `Probe exceeded the ${PROBE_TIMEOUT_MS}ms control-plane deadline`,
    };
  }
  // 2. user cancel
  if (input.cancelled === true) {
    return {
      state: "error",
      errorCode: "aborted",
      errorMessage: "Probe aborted by user",
    };
  }
  // 3. transport failure / connection loss mid-probe
  if (input.transportError !== undefined) {
    return {
      state: "opencode-disconnected",
      errorCode: "transport",
      errorMessage: sanitizeErrorMessage(input.transportError),
    };
  }
  // 4. provider preflight disconnected (before session creation)
  if (input.providerPreflightDisconnected === true) {
    return {
      state: "provider-disconnected",
      errorCode: "provider-disconnected",
      errorMessage:
        "Provider is not in the OpenCode connected set; probe not attempted",
    };
  }
  // 5. true non-200 from session create / message
  if (input.requestError) {
    const status = input.requestError.status;
    const errorMessage = sanitizeErrorMessage(input.requestError.message);
    const base = { statusCode: status, errorMessage };
    if (status === 404) {
      return { state: "model-not-found", ...base, errorCode: "http-404" };
    }
    if (status === 401 || status === 403) {
      return { state: "unauthorized", ...base, errorCode: `http-${status}` };
    }
    if (status === 429) {
      return { state: "rate-limited", ...base, errorCode: "http-429" };
    }
    return { state: "error", ...base, errorCode: `http-${status}` };
  }

  const body = input.response;
  const info = infoOf(body);

  // 6. HTTP 200 + usable envelope → healthy
  if (usableEnvelope(body)) {
    const responseModel =
      info && typeof info.modelID === "string" ? info.modelID : undefined;
    return { state: "healthy", statusCode: 200, responseModel };
  }

  // 7. HTTP 200 + info.error present → AssistantMessage error union
  const errorValue = info ? info.error : undefined;
  if (info && "error" in info && errorValue != null) {
    const err =
      errorValue && typeof errorValue === "object" && !Array.isArray(errorValue)
        ? (errorValue as Record<string, unknown>)
        : undefined;
    const name = err && typeof err.name === "string" ? err.name : undefined;
    const data = err ? err.data : undefined;
    const dataRec =
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : undefined;
    const message = sanitizeErrorMessage(messageOf(data));
    const statusCode =
      dataRec && typeof dataRec.statusCode === "number"
        ? dataRec.statusCode
        : undefined;
    const withStatus = (o: ProbeOutcome): ProbeOutcome =>
      statusCode !== undefined ? { ...o, statusCode } : { ...o, statusCode: 200 };

    switch (name) {
      case "ProviderAuthError":
        return withStatus({
          state: "unauthorized",
          errorCode: "provider-auth",
          errorMessage: message,
        });
      case "APIError": {
        if (statusCode === 401 || statusCode === 403) {
          return withStatus({ state: "unauthorized", errorCode: "api-error", errorMessage: message });
        }
        if (statusCode === 404) {
          return withStatus({ state: "model-not-found", errorCode: "api-error", errorMessage: message });
        }
        if (statusCode === 429) {
          return withStatus({ state: "rate-limited", errorCode: "api-error", errorMessage: message });
        }
        return withStatus({ state: "error", errorCode: "api-error", errorMessage: message });
      }
      case "MessageAbortedError":
        return withStatus({ state: "error", errorCode: "aborted", errorMessage: message });
      case "UnknownError":
      case "MessageOutputLengthError":
      case "StructuredOutputError":
      case "ContextOverflowError":
      case "ContentFilterError":
        return withStatus({ state: "error", errorCode: name, errorMessage: message });
      default:
        // Unparseable / unexpected shape — never embed the raw payload.
        return withStatus({
          state: "error",
          errorCode: "unparseable-error",
          errorMessage: "Unparseable assistant error envelope",
        });
    }
  }
  // 8. HTTP 200 failing the healthy predicate without an error → malformed
  if (body !== undefined) {
    return {
      state: "malformed",
      statusCode: 200,
      errorCode: "unusable-envelope",
      errorMessage: "HTTP 200 envelope failed the probe usability predicate",
    };
  }
  // 9. else
  return { state: "error", errorCode: "unknown", errorMessage: "Unclassified probe failure" };
}

/** UX-only freshness classification against PROBE_FRESHNESS_MS (24h). */
export function classifyFreshness(
  lastCompletedAt: string | undefined,
  nowMs: number,
): ModelProbeFreshness {
  if (!lastCompletedAt) return "never";
  const t = Date.parse(lastCompletedAt);
  if (Number.isNaN(t)) return "never";
  return nowMs - t <= PROBE_FRESHNESS_MS ? "fresh" : "stale";
}
