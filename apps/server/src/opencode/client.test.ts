import { afterEach, describe, expect, test } from "bun:test";
import { OpenCodeClient } from "./client";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenCodeClient canonical request context", () => {
  test("applies exact project directory and Basic auth to REST and SSE", async () => {
    const requests: Request[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request
        ? new Request(input, init)
        : new Request(input.toString(), init);
      requests.push(req);
      if (new URL(req.url).pathname === "/event") {
        return new Response("", { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new OpenCodeClient("http://opencode.local", {
      projectDirectory: "/Users/matt/Repos/omo-slim",
      auth: { username: "operator", password: "secret" },
    });
    await client.agents();
    for await (const _event of client.streamEvents()) {
      void _event;
    }

    expect(new URL(requests[0]!.url).searchParams.get("directory"))
      .toBe("/Users/matt/Repos/omo-slim");
    expect(new URL(requests[1]!.url).searchParams.get("directory"))
      .toBe("/Users/matt/Repos/omo-slim");
    for (const request of requests) {
      expect(request.headers.get("authorization"))
        .toBe(`Basic ${Buffer.from("operator:secret").toString("base64")}`);
    }
  });

  test("redacts server response credentials from outward request errors", async () => {
    globalThis.fetch = (async () =>
      new Response("password=hunter-secret-123 token=token-abcdefghijk", {
        status: 401,
      })) as unknown as typeof fetch;
    const client = new OpenCodeClient("http://opencode.local", {
      auth: { username: "opencode", password: "hunter-secret-123" },
    });
    try {
      await client.health();
      throw new Error("expected health to reject");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("hunter-secret-123");
      expect(message).not.toContain("token-abcdefghijk");
      expect(message).toContain("[redacted]");
    }
  });
});

// ── Slice 17: effectivePluginView ──────────────────────────────────────

describe("OpenCodeClient.effectivePluginView", () => {
  test("fetches GET /config through authenticated path and returns sanitized view", async () => {
    let fetchedUrl: string | undefined;
    let fetchedHeaders: Headers | undefined;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input.toString(), init);
      fetchedUrl = req.url;
      fetchedHeaders = req.headers;
      return new Response(
        JSON.stringify({
          plugin: [
            "/Users/matt/Repos/omo-slim/packages/omo-telemetry-bridge",
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new OpenCodeClient("http://opencode.local", {
      projectDirectory: "/Users/matt/Repos/omo-slim",
      authorizedRoots: ["/Users/matt/Repos/omo-slim"],
      auth: { username: "operator", password: "secret" },
    });
    const view = await client.effectivePluginView();

    // Fetch went through the authenticated path.
    expect(fetchedUrl).toContain("/config");
    expect(fetchedHeaders?.get("authorization")).toContain("Basic ");

    // Sanitized view: entries present, not unavailable, not invalid.
    expect(view.unavailable).toBeFalsy();
    expect(view.invalid).toBeFalsy();
    expect(view.entries.length).toBe(1);
    expect(view.entries[0]?.form).toBe("string");
  });

  test("raw config never cached/logged/thrown — only sanitized view returned", async () => {
    const rawConfig = {
      plugin: ["some-plugin"],
      provider: { openai: { apiKey: "sk-super-secret-key-12345" } },
      secret_field: "password=hunter2",
    };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(rawConfig), { status: 200 })) as unknown as typeof fetch;

    const client = new OpenCodeClient("http://opencode.local", {
      projectDirectory: "/Users/matt/Repos/omo-slim",
      authorizedRoots: ["/Users/matt/Repos/omo-slim"],
    });
    const view = await client.effectivePluginView();

    // The returned view must NOT contain raw config, provider keys, or secrets.
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("sk-super-secret-key-12345");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("provider");
    expect(serialized).not.toContain("secret_field");

    // Only plugin entries are in the view.
    expect(view.entries.length).toBe(1);
  });

  test("endpoint unavailable returns redacted unavailable state", async () => {
    globalThis.fetch = (async () =>
      new Response("Internal Server Error", { status: 500 })) as unknown as typeof fetch;

    const client = new OpenCodeClient("http://opencode.local", {
      projectDirectory: "/Users/matt/Repos/omo-slim",
      authorizedRoots: ["/Users/matt/Repos/omo-slim"],
    });
    const view = await client.effectivePluginView();

    expect(view.unavailable).toBe(true);
    expect(view.invalid).toBe(true);
    expect(view.entries).toEqual([]);
  });

  test("malformed payload returns redacted invalid state", async () => {
    globalThis.fetch = (async () =>
      new Response("not json at all", { status: 200 })) as unknown as typeof fetch;

    const client = new OpenCodeClient("http://opencode.local", {
      projectDirectory: "/Users/matt/Repos/omo-slim",
      authorizedRoots: ["/Users/matt/Repos/omo-slim"],
    });
    const view = await client.effectivePluginView();

    expect(view.unavailable).toBe(true);
    expect(view.invalid).toBe(true);
    expect(view.entries).toEqual([]);
  });

  test("no plugin property returns clean empty view", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ agents: {} }), { status: 200 })) as unknown as typeof fetch;

    const client = new OpenCodeClient("http://opencode.local", {
      projectDirectory: "/Users/matt/Repos/omo-slim",
      authorizedRoots: ["/Users/matt/Repos/omo-slim"],
    });
    const view = await client.effectivePluginView();

    expect(view.unavailable).toBeFalsy();
    expect(view.invalid).toBeFalsy();
    expect(view.entries).toEqual([]);
  });

  test("auth failure returns redacted unavailable state without throwing raw", async () => {
    globalThis.fetch = (async () =>
      new Response("Unauthorized", { status: 401 })) as unknown as typeof fetch;

    const client = new OpenCodeClient("http://opencode.local", {
      projectDirectory: "/Users/matt/Repos/omo-slim",
      authorizedRoots: ["/Users/matt/Repos/omo-slim"],
      auth: { username: "opencode", password: "server-secret-pw" },
    });
    const view = await client.effectivePluginView();

    expect(view.unavailable).toBe(true);
    expect(view.invalid).toBe(true);
    // No raw error or secret in the view.
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("server-secret-pw");
    expect(serialized).not.toContain("Unauthorized");
  });
});