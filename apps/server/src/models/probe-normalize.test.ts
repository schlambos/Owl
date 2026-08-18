/**
 * probe-normalize unit tests (Slice 15, Lane 5a; plan §72).
 * Pure functions: no OpenCode, no DB, no timers.
 */

import { describe, expect, test } from "bun:test";
import {
  classifyFreshness,
  normalizeProbeOutcome,
  sanitizeErrorMessage,
  usableEnvelope,
} from "./probe-normalize";
import { PROBE_FRESHNESS_MS, PROBE_TIMEOUT_MS } from "./constants";

const HEALTHY_BODY = {
  info: { role: "assistant", modelID: "echo-model" },
  parts: [{ type: "text", text: "OK" }],
};

describe("normalizeProbeOutcome — healthy envelope", () => {
  test("success: valid assistant envelope → healthy, responseModel from info.modelID", () => {
    const o = normalizeProbeOutcome({ response: HEALTHY_BODY });
    expect(o.state).toBe("healthy");
    expect(o.responseModel).toBe("echo-model");
    expect(o.statusCode).toBe(200);
  });

  test("healthy without modelID → responseModel undefined", () => {
    const o = normalizeProbeOutcome({
      response: { info: { role: "assistant" }, parts: [{ type: "text" }] },
    });
    expect(o.state).toBe("healthy");
    expect(o.responseModel).toBeUndefined();
  });
});

describe("normalizeProbeOutcome — true non-2xx (requestError)", () => {
  test("401 → unauthorized", () => {
    const o = normalizeProbeOutcome({ requestError: { status: 401 } });
    expect(o.state).toBe("unauthorized");
    expect(o.statusCode).toBe(401);
  });
  test("403 → unauthorized", () => {
    expect(normalizeProbeOutcome({ requestError: { status: 403 } }).state).toBe(
      "unauthorized",
    );
  });
  test("404 → model-not-found", () => {
    expect(normalizeProbeOutcome({ requestError: { status: 404 } }).state).toBe(
      "model-not-found",
    );
  });
  test("429 → rate-limited", () => {
    const o = normalizeProbeOutcome({ requestError: { status: 429 } });
    expect(o.state).toBe("rate-limited");
    expect(o.statusCode).toBe(429);
  });
  test("400 → error", () => {
    expect(normalizeProbeOutcome({ requestError: { status: 400 } }).state).toBe(
      "error",
    );
  });
  test("500 body summary is sanitized before persisting", () => {
    const o = normalizeProbeOutcome({
      requestError: { status: 500, message: "Bearer sk-abcdefgh12345678 exploded" },
    });
    expect(o.state).toBe("error");
    expect(o.errorMessage).not.toContain("sk-abcdefgh12345678");
  });
});

describe("normalizeProbeOutcome — HTTP 200 in-body error union", () => {
  const bodyWithError = (error: unknown) => ({
    info: { role: "assistant", error },
    parts: [],
  });

  test("ProviderAuthError → unauthorized", () => {
    const o = normalizeProbeOutcome({
      response: bodyWithError({
        name: "ProviderAuthError",
        data: { providerID: "p", message: "missing credentials" },
      }),
    });
    expect(o.state).toBe("unauthorized");
    expect(o.errorMessage).toBe("missing credentials");
  });

  test("APIError statusCode 401 → unauthorized", () => {
    const o = normalizeProbeOutcome({
      response: bodyWithError({
        name: "APIError",
        data: { message: "no", statusCode: 401, isRetryable: false },
      }),
    });
    expect(o.state).toBe("unauthorized");
    expect(o.statusCode).toBe(401);
  });

  test("APIError statusCode 403 → unauthorized", () => {
    const o = normalizeProbeOutcome({
      response: bodyWithError({
        name: "APIError",
        data: { message: "no", statusCode: 403, isRetryable: false },
      }),
    });
    expect(o.state).toBe("unauthorized");
  });

  test("APIError statusCode 404 → model-not-found", () => {
    const o = normalizeProbeOutcome({
      response: bodyWithError({
        name: "APIError",
        data: { message: "unknown model", statusCode: 404, isRetryable: false },
      }),
    });
    expect(o.state).toBe("model-not-found");
  });

  test("APIError statusCode 429 → rate-limited", () => {
    const o = normalizeProbeOutcome({
      response: bodyWithError({
        name: "APIError",
        data: { message: "slow down", statusCode: 429, isRetryable: true },
      }),
    });
    expect(o.state).toBe("rate-limited");
  });

  test("APIError other statusCode → error", () => {
    const o = normalizeProbeOutcome({
      response: bodyWithError({
        name: "APIError",
        data: { message: "boom", statusCode: 503, isRetryable: true },
      }),
    });
    expect(o.state).toBe("error");
    expect(o.statusCode).toBe(503);
  });

  test("APIError without statusCode → error", () => {
    const o = normalizeProbeOutcome({
      response: bodyWithError({
        name: "APIError",
        data: { message: "boom", isRetryable: false },
      }),
    });
    expect(o.state).toBe("error");
    expect(o.errorCode).toBe("api-error");
  });

  test("MessageAbortedError → error with code aborted", () => {
    const o = normalizeProbeOutcome({
      response: bodyWithError({
        name: "MessageAbortedError",
        data: { message: "aborted upstream" },
      }),
    });
    expect(o.state).toBe("error");
    expect(o.errorCode).toBe("aborted");
  });

  test("unparseable info.error (no name) → error, raw payload NOT embedded", () => {
    const o = normalizeProbeOutcome({
      response: bodyWithError({ weird: { stuff: "secret-material" } }),
    });
    expect(o.state).toBe("error");
    expect(o.errorMessage).not.toContain("secret-material");
  });

  test("unknown error name → error with the name as code", () => {
    const o = normalizeProbeOutcome({
      response: bodyWithError({
        name: "UnknownError",
        data: { message: "mystery" },
      }),
    });
    expect(o.state).toBe("error");
    expect(o.errorCode).toBe("UnknownError");
    expect(o.errorMessage).toBe("mystery");
  });
});

describe("normalizeProbeOutcome — malformed / else", () => {
  test("200 missing info → malformed", () => {
    expect(normalizeProbeOutcome({ response: { parts: [{ t: 1 }] } }).state).toBe(
      "malformed",
    );
  });
  test("200 non-assistant role → malformed", () => {
    expect(
      normalizeProbeOutcome({
        response: { info: { role: "user" }, parts: [{ t: 1 }] },
      }).state,
    ).toBe("malformed");
  });
  test("200 assistant role + empty parts → malformed", () => {
    expect(
      normalizeProbeOutcome({
        response: { info: { role: "assistant" }, parts: [] },
      }).state,
    ).toBe("malformed");
  });
  test("no response, no errors → error", () => {
    expect(normalizeProbeOutcome({}).state).toBe("error");
  });
});

describe("normalizeProbeOutcome — authoritative ordering", () => {
  test("1. deadline fired → timeout (beats cancel + everything)", () => {
    const o = normalizeProbeOutcome({
      deadlineFired: true,
      cancelled: true,
      transportError: new Error("x"),
      requestError: { status: 500 },
      response: HEALTHY_BODY,
    });
    expect(o.state).toBe("timeout");
    expect(o.errorMessage).toContain(String(PROBE_TIMEOUT_MS));
  });

  test("2. user cancel → error/aborted with exact message", () => {
    const o = normalizeProbeOutcome({
      cancelled: true,
      transportError: new Error("closed"),
    });
    expect(o.state).toBe("error");
    expect(o.errorCode).toBe("aborted");
    expect(o.errorMessage).toBe("Probe aborted by user");
  });

  test("3. transport failure → opencode-disconnected", () => {
    const o = normalizeProbeOutcome({
      transportError: new Error("ECONNREFUSED 127.0.0.1:4096"),
      requestError: { status: 500 },
    });
    expect(o.state).toBe("opencode-disconnected");
    expect(o.errorCode).toBe("transport");
    expect(o.errorMessage).toContain("ECONNREFUSED");
  });

  test("4. provider preflight disconnected → provider-disconnected (beats requestError)", () => {
    const o = normalizeProbeOutcome({
      providerPreflightDisconnected: true,
      requestError: { status: 404 },
    });
    expect(o.state).toBe("provider-disconnected");
  });
});

describe("usableEnvelope", () => {
  test("healthy predicate true", () => {
    expect(usableEnvelope(HEALTHY_BODY)).toBe(true);
  });
  test("error key present (even null-safe shapes) → false", () => {
    expect(
      usableEnvelope({
        info: { role: "assistant", error: { name: "APIError", data: {} } },
        parts: [{ t: 1 }],
      }),
    ).toBe(false);
  });
  test("non-object inputs → false", () => {
    expect(usableEnvelope(null)).toBe(false);
    expect(usableEnvelope("ok")).toBe(false);
    expect(usableEnvelope([{ t: 1 }])).toBe(false);
  });
});

describe("sanitizeErrorMessage", () => {
  test("bearer token redacted", () => {
    const out = sanitizeErrorMessage("Authorization: Bearer abcDEF123._~+/=" );
    expect(out?.includes("[redacted]")).toBe(true);
    expect(out).not.toContain("abcDEF123");
    expect(out).not.toContain("._~+");
  });

  test("basic auth and URL userinfo are redacted", () => {
    const out = sanitizeErrorMessage(
      "Basic dXNlcjpwYXNz http://user:pass@127.0.0.1:4096/x",
    );
    expect(out).not.toContain("dXNlcjpwYXNz");
    expect(out).not.toContain("user:pass");
  });

  test("token-shaped secret redacted", () => {
    const out = sanitizeErrorMessage("invalid key sk-1234567890abcdef");
    expect(out).not.toContain("sk-1234567890abcdef");
  });

  test("credential-looking key=value pairs redacted", () => {
    for (const raw of [
      "api_key=sup3rs3cretvalue",
      "x-api-key: sup3rs3cretvalue",
      "password=hunter2hunter2",
    ]) {
      const out = sanitizeErrorMessage(raw);
      expect(out).toContain("[redacted]");
      expect(out).not.toMatch(/sup3rs3cretvalue|hunter2hunter2/);
    }
  });

  test("URL query string stripped (may carry credentials)", () => {
    const out = sanitizeErrorMessage(
      "GET https://api.example.com/v1/chat?key=sekret&other=1 failed",
    );
    expect(out).toContain("https://api.example.com/v1/chat");
    expect(out).not.toContain("sekret");
    expect(out).not.toContain("other=1");
  });

  test("240-char cap with ellipsis", () => {
    const out = sanitizeErrorMessage("x".repeat(999));
    expect(out?.length).toBe(240);
    expect(out?.endsWith("...")).toBe(true);
  });

  test("undefined for empty/nullish input", () => {
    expect(sanitizeErrorMessage(undefined)).toBeUndefined();
    expect(sanitizeErrorMessage(null)).toBeUndefined();
    expect(sanitizeErrorMessage("")).toBeUndefined();
  });

  test("Error instances serialize to message (never stack-persisted raw)", () => {
    const out = sanitizeErrorMessage(new Error("boom happened"));
    expect(out).toBe("boom happened");
  });
});

describe("classifyFreshness", () => {
  const NOW = 1_800_000_000_000;
  test("never without timestamp", () => {
    expect(classifyFreshness(undefined, NOW)).toBe("never");
    expect(classifyFreshness("not-a-date", NOW)).toBe("never");
  });
  test("fresh within PROBE_FRESHNESS_MS, stale beyond, boundary inclusive", () => {
    const at = new Date(NOW).toISOString();
    expect(classifyFreshness(at, NOW)).toBe("fresh");
    const boundary = new Date(NOW - PROBE_FRESHNESS_MS).toISOString();
    expect(classifyFreshness(boundary, NOW)).toBe("fresh");
    const past = new Date(NOW - PROBE_FRESHNESS_MS - 1).toISOString();
    expect(classifyFreshness(past, NOW)).toBe("stale");
  });
});
