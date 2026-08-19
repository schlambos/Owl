/**
 * Lifecycle owned config-apply restart tests (named test 4).
 *
 *  - apply restart never calls restartForTelemetryBridge;
 *  - attach and managed+external are rejected WITHOUT closing/touching the
 *    backend (no process action, Desired stands);
 *  - owned performs ONE explicit attempt and increments generation exactly
 *    once, without consuming MANAGED_RESTART_DELAYS_MS.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import type { ServerConfig } from "../config";
import {
  OpenCodeLifecycleManager,
  MANAGED_RESTART_DELAYS_MS,
  type LifecycleProbeResult,
} from "./lifecycle";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ready: LifecycleProbeResult["readiness"] = {
  health: true,
  configProviders: true,
  providers: true,
  agents: true,
  omo: true,
  omoExpected: true,
  rest: true,
  sse: false,
};

const fullReady = (): LifecycleProbeResult => ({
  kind: "ready",
  version: "1.18.14",
  readiness: { ...ready },
});

let lifecycleCfgRoot: string;
let TEST_INSTALL_DIR: string;
let TEST_PROJECT_DIR: string;
let TEST_CONFIG_DIR: string;

beforeAll(() => {
  lifecycleCfgRoot = mkdtempSync(join(tmpdir(), "omo-lifecycle-cfgapply-"));
  const installDir = join(lifecycleCfgRoot, "install");
  const projDir = join(lifecycleCfgRoot, "proj");
  const cfgDir = join(lifecycleCfgRoot, "cfg");
  mkdirSync(installDir, { recursive: true });
  mkdirSync(projDir, { recursive: true });
  mkdirSync(cfgDir, { recursive: true });
  TEST_INSTALL_DIR = realpathSync(installDir);
  TEST_PROJECT_DIR = realpathSync(projDir);
  TEST_CONFIG_DIR = realpathSync(cfgDir);
});

afterAll(() => {
  try { rmSync(lifecycleCfgRoot, { recursive: true, force: true }); } catch { /* */ }
});

function cfg(mode: "managed" | "attach", url?: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    opencodeMode: mode,
    ...(mode === "attach" ? { opencodeAttachBaseUrl: url } : {}),
    opencodeConfigDir: TEST_CONFIG_DIR,
    projectDirectory: TEST_PROJECT_DIR,
    owlInstallDirectory: TEST_INSTALL_DIR,
    authorizedRoots: [TEST_INSTALL_DIR, TEST_PROJECT_DIR, TEST_CONFIG_DIR],
  };
}

describe("OpenCodeLifecycleManager.restartForOwnedConfigApply", () => {
  test("rejects attach mode without touching the backend", async () => {
    let startSdkCalls = 0;
    const manager = new OpenCodeLifecycleManager(
      cfg("attach", "http://127.0.0.1:9000"),
      {
        probe: async () => fullReady(),
        startSdk: async () => {
          startSdkCalls++;
          return { url: "http://127.0.0.1:1", close() {} };
        },
      },
    );
    await manager.start();
    expect(manager.getState().status).toBe("connected");
    expect(manager.getState().ownership).toBe("external");
    const baseUrlBefore = manager.getState().baseUrl;

    const result = await manager.restartForOwnedConfigApply();
    expect(result.ok).toBe(false);
    expect(result.code).toBe("mode-not-managed");
    // No process action: backend untouched.
    expect(startSdkCalls).toBe(0);
    expect(manager.getState().status).toBe("connected");
    expect(manager.getState().baseUrl).toBe(baseUrlBefore);
  });

  test("rejects managed+external without closing/touching the backend", async () => {
    let startSdkCalls = 0;
    const manager = new OpenCodeLifecycleManager(cfg("managed"), {
      probe: async () => fullReady(), // preferred port ready → external reuse
      startSdk: async () => {
        startSdkCalls++;
        return { url: "http://127.0.0.1:1", close() {} };
      },
    });
    await manager.start();
    expect(manager.getState().ownership).toBe("external");
    expect(manager.getState().status).toBe("connected");
    const baseUrlBefore = manager.getState().baseUrl;

    const result = await manager.restartForOwnedConfigApply();
    expect(result.ok).toBe(false);
    expect(result.code).toBe("ownership-not-control-plane");
    // No process action and no owned start.
    expect(startSdkCalls).toBe(0);
    expect(manager.getState().status).toBe("connected");
    expect(manager.getState().baseUrl).toBe(baseUrlBefore);
  });

  test("owned: one explicit attempt, generation +1, never restartForTelemetryBridge", async () => {
    let startSdkCalls = 0;
    let probeCount = 0;
    const manager = new OpenCodeLifecycleManager(cfg("managed"), {
      probe: async () => {
        probeCount++;
        if (probeCount === 1) {
          return { kind: "refused", readiness: { ...ready, health: false, rest: false } };
        }
        return fullReady();
      },
      startSdk: async () => {
        startSdkCalls++;
        return {
          url: `http://127.0.0.1:${5000 + startSdkCalls}`,
          close() {},
        };
      },
      sleep: async () => {},
      portBindable: async () => true,
    });

    // Spy: the config-apply restart must never delegate to the telemetry path.
    let telemetryBridgeCalls = 0;
    const original = manager.restartForTelemetryBridge.bind(manager);
    manager.restartForTelemetryBridge = (async (...args: unknown[]) => {
      telemetryBridgeCalls++;
      return (original as (...a: unknown[]) => unknown)(...args);
    }) as never;

    await manager.start();
    expect(manager.getState().ownership).toBe("control-plane");
    expect(manager.getState().status).toBe("connected");
    expect(startSdkCalls).toBe(1);
    const genBefore = manager.getState().generation;
    const delaysBefore = [...MANAGED_RESTART_DELAYS_MS];

    const result = await manager.restartForOwnedConfigApply();
    expect(result.ok).toBe(true);
    // One explicit attempt, generation incremented exactly once.
    expect(startSdkCalls).toBe(2);
    expect(manager.getState().generation).toBe(genBefore + 1);
    expect(manager.getState().status).toBe("connected");
    // Never the telemetry bridge path, and the backoff schedule untouched.
    expect(telemetryBridgeCalls).toBe(0);
    expect([...MANAGED_RESTART_DELAYS_MS]).toEqual(delaysBefore);
    // Not a scheduled backoff restart: no restart metadata.
    expect(manager.getState().restart).toBeUndefined();
  });
});
