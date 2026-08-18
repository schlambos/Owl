/**
 * Unit tests for HTTP routing and GET-only enforcement (Slice 17).
 *
 * Tests the exported `buildBridgeFetchHandler` directly, without binding a
 * server. Covers:
 * - GET /health → 200 with schema v3, bound, capabilities, pluginInstanceId.
 * - GET /telemetry → 200 with full v3 snapshot.
 * - Non-GET on /health and /telemetry → 405 with Allow: GET.
 * - Unknown path → 404.
 * - No CORS headers on any response.
 * - No sensitive fields (raw nonce) in responses.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { buildBridgeFetchHandler } from "./routing";
import { captureBridgeIdentity, computeNonceFingerprint, STORE_SYMBOLS } from "./stores";

const globals = globalThis as unknown as Record<symbol, unknown>;

afterEach(() => {
  for (const symbol of Object.values(STORE_SYMBOLS)) {
    delete globals[symbol];
  }
});

function makeRequest(method: string, pathname: string): Request {
  return new Request(`http://127.0.0.1:8788${pathname}`, { method });
}

async function bodyAsJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("GET /health", () => {
  test("returns 200 with v3 schema, bound, capabilities", async () => {
    const handler = buildBridgeFetchHandler(undefined, true);
    const res = handler(makeRequest("GET", "/health"));

    expect(res.status).toBe(200);
    const body = await bodyAsJson(res);
    expect(body["ok"]).toBe(true);
    expect(body["schemaVersion"]).toBe(3);
    expect(body["bound"]).toBe(true);
    expect(body["capabilities"]).toBeDefined();
  });

  test("includes pluginInstanceId when identity supplied", async () => {
    const id = await captureBridgeIdentity({});
    const handler = buildBridgeFetchHandler(id, true);
    const res = handler(makeRequest("GET", "/health"));
    const body = await bodyAsJson(res);
    expect(body["pluginInstanceId"]).toBe(id.pluginInstanceId);
  });

  test("omits pluginInstanceId when no identity", async () => {
    const handler = buildBridgeFetchHandler(undefined, true);
    const res = handler(makeRequest("GET", "/health"));
    const body = await bodyAsJson(res);
    expect("pluginInstanceId" in body).toBe(false);
  });
});

describe("GET /telemetry", () => {
  test("returns 200 with v3 snapshot including identity and capabilities", async () => {
    const fp = await computeNonceFingerprint("0123456789abcdef");
    const id = await captureBridgeIdentity({
      serverUrl: "http://127.0.0.1:9999",
      nonceFingerprint: fp,
    });
    const handler = buildBridgeFetchHandler(id, true);
    const res = handler(makeRequest("GET", "/telemetry"));

    expect(res.status).toBe(200);
    const body = await bodyAsJson(res);
    expect(body["telemetrySchemaVersion"]).toBe(3);
    expect(body["identity"]).toBeDefined();
    expect(body["capabilities"]).toBeDefined();
    expect(body["stores"]).toBeDefined();
  });

  test("never exposes raw nonce in telemetry response", async () => {
    const fp = await computeNonceFingerprint("do-not-leak-this-value");
    const id = await captureBridgeIdentity({
      nonceFingerprint: fp,
    });
    const handler = buildBridgeFetchHandler(id, true);
    const res = handler(makeRequest("GET", "/telemetry"));
    const text = await res.text();
    // The raw nonce must not appear; only the fingerprint.
    expect(text).not.toContain("do-not-leak-this-value");
  });
});

describe("GET-only enforcement (405)", () => {
  test("POST /health → 405 with Allow: GET", async () => {
    const handler = buildBridgeFetchHandler(undefined, true);
    const res = handler(makeRequest("POST", "/health"));
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
  });

  test("POST /telemetry → 405", async () => {
    const handler = buildBridgeFetchHandler(undefined, true);
    const res = handler(makeRequest("POST", "/telemetry"));
    expect(res.status).toBe(405);
  });

  test("PUT /health → 405", async () => {
    const handler = buildBridgeFetchHandler(undefined, true);
    const res = handler(makeRequest("PUT", "/health"));
    expect(res.status).toBe(405);
  });

  test("DELETE /telemetry → 405", async () => {
    const handler = buildBridgeFetchHandler(undefined, true);
    const res = handler(makeRequest("DELETE", "/telemetry"));
    expect(res.status).toBe(405);
  });

  test("PATCH /health → 405", async () => {
    const handler = buildBridgeFetchHandler(undefined, true);
    const res = handler(makeRequest("PATCH", "/health"));
    expect(res.status).toBe(405);
  });
});

describe("unknown routes → 404", () => {
  test("GET /unknown → 404", () => {
    const handler = buildBridgeFetchHandler(undefined, true);
    const res = handler(makeRequest("GET", "/unknown"));
    expect(res.status).toBe(404);
  });

  test("GET / → 404", () => {
    const handler = buildBridgeFetchHandler(undefined, true);
    const res = handler(makeRequest("GET", "/"));
    expect(res.status).toBe(404);
  });

  test("POST /unknown → 404 (not 405)", () => {
    const handler = buildBridgeFetchHandler(undefined, true);
    const res = handler(makeRequest("POST", "/unknown"));
    expect(res.status).toBe(404);
  });
});

describe("no CORS headers", () => {
  test("GET /health has no CORS headers", () => {
    const handler = buildBridgeFetchHandler(undefined, true);
    const res = handler(makeRequest("GET", "/health"));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Methods")).toBeNull();
  });

  test("GET /telemetry has no CORS headers", () => {
    const handler = buildBridgeFetchHandler(undefined, true);
    const res = handler(makeRequest("GET", "/telemetry"));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("405 has no CORS headers", () => {
    const handler = buildBridgeFetchHandler(undefined, true);
    const res = handler(makeRequest("POST", "/health"));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("no sensitive fields in responses", () => {
  test("health response has no nonce/fingerprint fields", async () => {
    const fp = await computeNonceFingerprint("0123456789abcdef");
    const id = await captureBridgeIdentity({
      nonceFingerprint: fp,
    });
    const handler = buildBridgeFetchHandler(id, true);
    const res = handler(makeRequest("GET", "/health"));
    const body = await bodyAsJson(res);
    expect("nonceFingerprint" in body).toBe(false);
    expect("activationNonce" in body).toBe(false);
    expect("canonicalOrigin" in body).toBe(false);
  });

  test("telemetry identity has fingerprint but never raw nonce", async () => {
    const fp = await computeNonceFingerprint("raw-secret-value-1234");
    const id = await captureBridgeIdentity({
      nonceFingerprint: fp,
    });
    const handler = buildBridgeFetchHandler(id, true);
    const res = handler(makeRequest("GET", "/telemetry"));
    const text = await res.text();
    expect(text).not.toContain("raw-secret-value-1234");
    const body = JSON.parse(text) as Record<string, unknown>;
    const identity = body["identity"] as Record<string, unknown>;
    expect(identity["nonceFingerprint"]).toBeDefined();
    expect("activationNonce" in identity).toBe(false);
  });
});