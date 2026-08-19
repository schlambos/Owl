/**
 * Client method contract tests (named test 3).
 *
 *  - auth.set: PUT /auth/{id} body { type: "api", key }.
 *  - provider.oauth.authorize: POST body { method, inputs }.
 *  - provider.oauth.callback: POST body { method, code }.
 */

import { describe, expect, test } from "bun:test";
import { OpenCodeClient } from "./client";

interface CapturedRequest {
  url: string;
  method: string;
  body?: unknown;
}

function capturingClient(): { client: OpenCodeClient; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requests.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response("true", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const client = new OpenCodeClient("http://127.0.0.1:4096", { fetchImpl });
  return { client, requests };
}

describe("OpenCodeClient provider auth/oauth", () => {
  test("authSet: PUT /auth/{providerID} body { type: 'api', key }", async () => {
    const { client, requests } = capturingClient();
    await client.authSet("openai", "sk-test");
    expect(requests).toHaveLength(1);
    const r = requests[0]!;
    expect(new URL(r.url).pathname).toBe("/auth/openai");
    expect(r.method).toBe("PUT");
    expect(r.body).toEqual({ type: "api", key: "sk-test" });
  });

  test("authRemove: DELETE /auth/{providerID}", async () => {
    const { client, requests } = capturingClient();
    await client.authRemove("openai");
    expect(requests).toHaveLength(1);
    const r = requests[0]!;
    expect(new URL(r.url).pathname).toBe("/auth/openai");
    expect(r.method).toBe("DELETE");
  });

  test("providerOauthAuthorize: POST body { method, inputs }", async () => {
    const { client, requests } = capturingClient();
    await client.providerOauthAuthorize("google", { method: 0, inputs: { region: "us" } });
    expect(requests).toHaveLength(1);
    const r = requests[0]!;
    expect(new URL(r.url).pathname).toBe("/provider/google/oauth/authorize");
    expect(r.method).toBe("POST");
    expect(r.body).toEqual({ method: 0, inputs: { region: "us" } });

    // inputs omitted → absent from the body.
    const { client: c2, requests: r2 } = capturingClient();
    await c2.providerOauthAuthorize("google", { method: 1 });
    expect(r2[0]!.body).toEqual({ method: 1 });
  });

  test("providerOauthCallback: POST body { method, code }", async () => {
    const { client, requests } = capturingClient();
    await client.providerOauthCallback("github-copilot", { method: 0, code: "abc-123" });
    expect(requests).toHaveLength(1);
    const r = requests[0]!;
    expect(new URL(r.url).pathname).toBe("/provider/github-copilot/oauth/callback");
    expect(r.method).toBe("POST");
    expect(r.body).toEqual({ method: 0, code: "abc-123" });

    // code omitted → absent from the body.
    const { client: c2, requests: r2 } = capturingClient();
    await c2.providerOauthCallback("github-copilot", { method: 0 });
    expect(r2[0]!.body).toEqual({ method: 0 });
  });
});
