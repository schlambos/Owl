import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenCodeLifecycleState } from "@omo/shared";
import { RuntimeStore } from "./store";

function lifecycle(
  generation: number,
  baseUrl: string,
): OpenCodeLifecycleState {
  return {
    mode: "attach",
    ownership: "external",
    status: "connected",
    baseUrl,
    generation,
    projectDirectory: "/tmp/owl-fixture/project",
    configDirectory: "/tmp/owl-fixture/opencode",
    authConfigured: false,
    ready: {
      health: true,
      configProviders: true,
      providers: true,
      agents: true,
      omo: true,
      omoExpected: true,
      rest: true,
      sse: false,
    },
    updatedAt: "2026-08-13T00:00:00Z",
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("RuntimeStore backend generations", () => {
  test("activation bootstraps only the canonical target and replacement clears old sessions", async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      urls.push(url);
      const path = new URL(url).pathname;
      if (path === "/global/health") return json({ healthy: true, version: "1.18.14" });
      if (path === "/path") return json({ directory: "/tmp/owl-fixture/project" });
      if (path === "/project/current") return json({ id: "project" });
      if (path === "/agent") return json([{ name: "orchestrator" }]);
      if (path === "/session") return json([{ id: url.includes("second") ? "new" : "old" }]);
      if (path === "/session/status" || path === "/mcp") return json({});
      if (path === "/provider") return json({ all: [], connected: [] });
      if (path === "/config/providers") return json({ providers: [] });
      if (path === "/permission") return json([]);
      return json({});
    }) as unknown as typeof fetch;
    try {
      const store = new RuntimeStore("/tmp/owl-fixture/project");
      await store.activateBackend(lifecycle(1, "http://first"));
      expect(store.getRuntimeState().sessions.flat.map((s) => s.id)).toEqual(["old"]);
      await store.activateBackend(lifecycle(2, "http://second"));
      expect(store.getRuntimeState().sessions.flat.map((s) => s.id)).toEqual(["new"]);
      expect(store.getBackendGeneration()).toBe(2);
      expect(urls.some((url) => url.startsWith("http://first"))).toBe(true);
      expect(urls.some((url) => url.startsWith("http://second"))).toBe(true);
      store.deactivateBackend();
      expect(store.getRuntimeState().sessions.total).toBe(0);
      expect(store.getRuntimeState().providers).toEqual([]);
      expect(store.getRuntimeState().agents).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("RuntimeStore effectivePluginView roots plumbing", () => {
  test("RuntimeStore plumbed with authorizedRoots extracts canonical file:// bridge metadata from live-shaped /config", async () => {
    const originalFetch = globalThis.fetch;
    const testProjectDir = mkdtempSync(join(tmpdir(), "omo-store-roots-"));
    const bridgeDir = join(testProjectDir, "packages", "omo-telemetry-bridge");
    mkdirSync(bridgeDir, { recursive: true });
    writeFileSync(join(bridgeDir, "package.json"), "{}");

    const rawConfig = {
      plugin: [`file://${bridgeDir}`],
    };

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      const path = new URL(url).pathname;
      if (path === "/global/health") return json({ healthy: true, version: "1.18.14" });
      if (path === "/path") return json({ directory: testProjectDir });
      if (path === "/project/current") return json({ id: "project" });
      if (path === "/agent") return json([{ name: "orchestrator" }]);
      if (path === "/session") return json([]);
      if (path === "/session/status" || path === "/mcp") return json({});
      if (path === "/provider") return json({ all: [], connected: [] });
      if (path === "/config/providers") return json({ providers: [] });
      if (path === "/permission") return json([]);
      if (path === "/config") return json(rawConfig);
      return json({});
    }) as unknown as typeof fetch;

    try {
      // 1. Instantiating RuntimeStore WITH authorizedRoots passes them down to OpenCodeClient
      const storeWithRoots = new RuntimeStore(testProjectDir, [testProjectDir]);
      await storeWithRoots.activateBackend({
        ...lifecycle(1, "http://live-backend"),
        projectDirectory: testProjectDir,
      });
      const client = storeWithRoots.getClient();
      const view = await client.effectivePluginView();
      expect(view.unavailable).toBe(false);
      expect(view.invalid).toBe(false);
      expect(view.entries).toHaveLength(1);
      const entry = view.entries[0]!;
      expect(entry.form).toBe("string");
      expect(entry.identityKind).toBe("file-url");
      expect(entry.effectiveIdentity).toBe(`file://${bridgeDir}`);
      expect(entry.bridge).toBeDefined();
      expect(entry.bridge?.pluginForm).toBe("string");
      expect(entry.bridge?.transportMode).toBe("loopback-http");
      expect(entry.bridge?.registrationTransport).toBe("env");
      storeWithRoots.deactivateBackend();

      // 2. Negative proof: if authorizedRoots is outside roots, bridge metadata is NOT extracted (fails closed)
      const outsideDir = mkdtempSync(join(tmpdir(), "omo-outside-"));
      try {
        const storeOutside = new RuntimeStore(testProjectDir, [outsideDir]); // roots do NOT include testProjectDir
        await storeOutside.activateBackend({
          ...lifecycle(2, "http://live-backend-2"),
          projectDirectory: testProjectDir,
        });
        const clientOutside = storeOutside.getClient();
        const viewOutside = await clientOutside.effectivePluginView();
        expect(viewOutside.entries).toHaveLength(1);
        expect(viewOutside.entries[0]!.bridge).toBeUndefined();
        storeOutside.deactivateBackend();
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(testProjectDir, { recursive: true, force: true });
    }
  });
});
