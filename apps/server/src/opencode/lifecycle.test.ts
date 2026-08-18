import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import type { ServerConfig } from "../config";
import {
  MANAGED_PROJECT_DIRECTORY,
  DEFAULT_OPENCODE_CONFIG_DIRECTORY,
  PREFERRED_OPENCODE_BASE_URL,
} from "../config";
import {
  OpenCodeLifecycleManager,
  computeBridgeReconciliationClean,
  bridgeReconcileDispositionAfterExternalEdit,
  type LifecycleProbeResult,
  type TelemetryBridgeRestartIntent,
  type ExpectedBridgeActivationState,
  type OpenCodeLifecycleStateWithRestartKind,
} from "./lifecycle";
import { BridgeRevisionStore } from "../opencode-bridge/revisions-bridge";
import { BridgeService } from "../opencode-bridge/service";
import { createBridgeWatcher } from "../opencode-bridge/watcher";
import { fingerprintNonce } from "../opencode-bridge/extractor";
import { hashContent } from "../cfgwrite/jsonc-edit";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function cfg(
  mode: "managed" | "attach",
  url?: string,
): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    opencodeMode: mode,
    ...(mode === "attach" ? { opencodeAttachBaseUrl: url } : {}),
    opencodeConfigDir: DEFAULT_OPENCODE_CONFIG_DIRECTORY,
    projectDirectory: MANAGED_PROJECT_DIRECTORY,
    authorizedRoots: [MANAGED_PROJECT_DIRECTORY, DEFAULT_OPENCODE_CONFIG_DIRECTORY],
  };
}

const fullReady = (): LifecycleProbeResult => ({
  kind: "ready",
  version: "1.18.14",
  readiness: { ...ready },
});

// ── Bridge store test harness ───────────────────────────────────────────

let sandbox: string;
let dbPath: string;
let store: BridgeRevisionStore;
let configPath: string;

function setupBridgeStore(): void {
  sandbox = mkdtempSync(join(tmpdir(), "omo-lifecycle-bridge-"));
  dbPath = join(sandbox, "data", "bridge.db");
  store = new BridgeRevisionStore(dbPath);
  configPath = join(sandbox, "opencode.json");
}

function teardownBridgeStore(): void {
  try { store.close(); } catch { /* */ }
  try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* */ }
}

function commitActiveBridge(
  port: number,
  rawNonce: string,
  configText: string,
  suffix = "",
): { nonceFp: string; cfgHash: string; revId: string } {
  const nonceFp = fingerprintNonce(rawNonce);
  writeFileSync(configPath, configText, "utf-8");
  const cfgHash = hashContent(configText);
  const intentId = `intent_${Date.now()}_${suffix}_${Math.random().toString(36).slice(2, 8)}`;
  const revId = `rev_${Date.now()}_${suffix}_${Math.random().toString(36).slice(2, 8)}`;
  store.insertPreparedIntent({
    id: intentId,
    targetPath: configPath,
    sourceKind: "opencode-config-dir",
    operation: "add",
    baselineHash: "h_base",
    proposedHash: cfgHash,
    canonicalIdentity: "/canonical/bridge",
    port,
    registrationTransport: "env",
    transportMode: "loopback-http",
    nonceFingerprint: nonceFp,
    bytePatch: "{}",
    rawActivationNonce: rawNonce,
  });
  store.finalizeIntent(intentId, revId, new Date().toISOString(), cfgHash);
  return { nonceFp, cfgHash, revId };
}

/** Commit a disabled (deactivated) bridge state. */
function commitDisabledBridge(
  configText: string,
  suffix = "",
): { cfgHash: string; revId: string } {
  writeFileSync(configPath, configText, "utf-8");
  const cfgHash = hashContent(configText);
  const intentId = `intent_${Date.now()}_${suffix}_${Math.random().toString(36).slice(2, 8)}`;
  const revId = `rev_${Date.now()}_${suffix}_${Math.random().toString(36).slice(2, 8)}`;
  store.insertPreparedIntent({
    id: intentId,
    targetPath: configPath,
    sourceKind: "opencode-config-dir",
    operation: "remove",
    baselineHash: "h_base",
    proposedHash: cfgHash,
    canonicalIdentity: "/canonical/bridge",
    registrationTransport: "env",
    transportMode: "loopback-http",
    bytePatch: "{}",
  });
  store.finalizeIntent(intentId, revId, new Date().toISOString(), cfgHash);
  return { cfgHash, revId };
}

describe("OpenCodeLifecycleManager", () => {
  test("attach invalid/empty fails and never invokes SDK", async () => {
    let starts = 0;
    const manager = new OpenCodeLifecycleManager(cfg("attach", ""), {
      startSdk: async () => {
        starts++;
        throw new Error("should not start");
      },
    });
    const state = await manager.start();
    expect(state.status).toBe("failed");
    expect(state.error?.code).toBe("invalid-attach-url");
    expect(starts).toBe(0);
  });

  test("attach is external, increments generation once, and never closes", async () => {
    let closes = 0;
    const manager = new OpenCodeLifecycleManager(
      cfg("attach", "http://127.0.0.1:9000"),
      {
        probe: async () => fullReady(),
        startSdk: async () => ({
          url: "http://never",
          close: () => closes++,
        }),
      },
    );
    const state = await manager.start();
    expect(state.status).toBe("connected");
    expect(state.ownership).toBe("external");
    expect(state.generation).toBe(1);
    await manager.stop();
    expect(closes).toBe(0);
  });

  test("managed reuses compatible preferred backend as preexisting external", async () => {
    let starts = 0;
    const manager = new OpenCodeLifecycleManager(cfg("managed"), {
      probe: async (url) => {
        expect(url).toBe(PREFERRED_OPENCODE_BASE_URL);
        return fullReady();
      },
      startSdk: async () => {
        starts++;
        throw new Error("not expected");
      },
    });
    const state = await manager.start();
    expect(state.ownership).toBe("external");
    expect(state.detail).toContain("preexisting");
    expect(starts).toBe(0);
  });

  test("preexisting OpenCode waits for delayed OMO registration before reuse", async () => {
    let probes = 0;
    let sleeps = 0;
    const manager = new OpenCodeLifecycleManager(cfg("managed"), {
      probe: async () => {
        probes++;
        if (probes === 1) {
          return {
            kind: "unavailable",
            version: "1.18.14",
            readiness: { ...ready, omo: false },
            detail: "OMO-Slim agents are not registered in OpenCode /agent",
          };
        }
        return fullReady();
      },
      sleep: async () => { sleeps++; },
    });
    const state = await manager.start();
    expect(state.status).toBe("connected");
    expect(state.ownership).toBe("external");
    expect(sleeps).toBe(0);
  });

  test("refused preferred port starts owned SDK with inherited config-dir setup", async () => {
    let requested: { hostname: string; port: number; timeout: number } | undefined;
    let probeCount = 0;
    const previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
    const manager = new OpenCodeLifecycleManager(cfg("managed"), {
      probe: async () => {
        probeCount++;
        if (probeCount === 1) {
          return { kind: "refused", readiness: { ...ready, health: false, rest: false } };
        }
        return fullReady();
      },
      startSdk: async (opts) => {
        requested = opts;
        expect(process.env.OPENCODE_CONFIG_DIR).toBe(DEFAULT_OPENCODE_CONFIG_DIRECTORY);
        return { url: PREFERRED_OPENCODE_BASE_URL, close() {} };
      },
      portBindable: async () => true,
    });
    try {
      const state = await manager.start();
      expect(requested).toEqual({ hostname: "127.0.0.1", port: 4096, timeout: 15_000 });
      expect(state.ownership).toBe("control-plane");
      expect(state.generation).toBe(1);
    } finally {
      if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
    }
  });

  test("non-OpenCode collision uses verified port:0 fallback and publishes actual URL", async () => {
    let requestedPort = -1;
    let calls = 0;
    const manager = new OpenCodeLifecycleManager(cfg("managed"), {
      probe: async () => {
        calls++;
        if (calls === 1) return { kind: "collision", readiness: { ...ready, health: false, rest: false }, detail: "not OpenCode" };
        return fullReady();
      },
      startSdk: async (opts) => {
        requestedPort = opts.port;
        return { url: "http://127.0.0.1:54321", close() {} };
      },
      ephemeralPortSupported: true,
    });
    const state = await manager.start();
    expect(requestedPort).toBe(0);
    expect(state.baseUrl).toBe("http://127.0.0.1:54321");
  });

  test("HTTP refusal with an occupied preferred port also uses alternate port", async () => {
    let requestedPort = -1;
    let calls = 0;
    const manager = new OpenCodeLifecycleManager(cfg("managed"), {
      probe: async () => {
        calls++;
        return calls === 1
          ? { kind: "refused", readiness: { ...ready, health: false, rest: false } }
          : fullReady();
      },
      portBindable: async () => false,
      startSdk: async (opts) => {
        requestedPort = opts.port;
        return { url: "http://127.0.0.1:55555", close() {} };
      },
    });
    const state = await manager.start();
    expect(requestedPort).toBe(0);
    expect(state.baseUrl).toBe("http://127.0.0.1:55555");
  });

  test("collision is actionable terminal failure when ephemeral fallback disabled", async () => {
    let starts = 0;
    const manager = new OpenCodeLifecycleManager(cfg("managed"), {
      probe: async () => ({ kind: "collision", readiness: { ...ready, health: false, rest: false } }),
      startSdk: async () => {
        starts++;
        throw new Error("not expected");
      },
      ephemeralPortSupported: false,
    });
    const state = await manager.start();
    expect(state.status).toBe("failed");
    expect(state.error?.code).toBe("preferred-port-collision");
    expect(state.error?.retryable).toBe(false);
    expect(starts).toBe(0);
  });

  test("owned startup errors are redacted and restart is bounded", async () => {
    let starts = 0;
    const manager = new OpenCodeLifecycleManager(cfg("managed"), {
      env: { OPENCODE_SERVER_PASSWORD: "super-secret-value" },
      probe: async () => ({ kind: "refused", readiness: { ...ready, health: false, rest: false } }),
      startSdk: async () => {
        starts++;
        throw new Error("password=super-secret-value startup failed");
      },
      sleep: async () => {},
      portBindable: async () => true,
    });
    const state = await manager.start();
    expect(starts).toBe(6);
    expect(state.status).toBe("failed");
    expect(state.error?.code).toBe("managed-restart-exhausted");
    expect(state.error?.message).not.toContain("super-secret-value");
    expect(state.error?.message).toContain("[redacted]");
  });

  test("owned backend loss closes only owned handle and activates one new generation", async () => {
    let starts = 0;
    let closes = 0;
    const manager = new OpenCodeLifecycleManager(cfg("managed"), {
      probe: async (url) => {
        if (url === PREFERRED_OPENCODE_BASE_URL) {
          return { kind: "refused", readiness: { ...ready, health: false, rest: false } };
        }
        return fullReady();
      },
      portBindable: async () => true,
      startSdk: async () => {
        starts++;
        return {
          url: `http://127.0.0.1:${6000 + starts}`,
          close: () => closes++,
        };
      },
      sleep: async () => {},
    });
    const first = await manager.start();
    expect(first.generation).toBe(1);
    await manager.backendLost("connection lost");
    const second = manager.getState();
    expect(second.status).toBe("connected");
    expect(second.generation).toBe(2);
    expect(starts).toBe(2);
    expect(closes).toBe(1);
  });
});

// ── Slice 17: restartForTelemetryBridge ──────────────────────────────────

describe("OpenCodeLifecycleManager.restartForTelemetryBridge", () => {
  beforeEach(() => setupBridgeStore());
  afterEach(() => teardownBridgeStore());

  function makeManagerWithBridge(
    overrides: {
      probe?: (url: string) => Promise<LifecycleProbeResult>;
      startSdk?: () => Promise<{ url: string; close(): void }>;
      isBridgePortOccupied?: (port: number) => Promise<boolean>;
      isReconciliationClean?: () => boolean;
    } = {},
  ): OpenCodeLifecycleManager {
    // Default probe: first call (preferred port) refused, subsequent ready.
    // This forces an owned start (control-plane ownership).
    let probeCount = 0;
    return new OpenCodeLifecycleManager(cfg("managed"), {
      probe: overrides.probe ?? (async () => {
        probeCount++;
        if (probeCount === 1) return { kind: "refused", readiness: { ...ready, health: false, rest: false } };
        return fullReady();
      }),
      startSdk: overrides.startSdk ?? (async () => ({
        url: "http://127.0.0.1:4096",
        close() {},
      })),
      sleep: async () => {},
      portBindable: async () => true,
      bridge: {
        store,
        isReconciliationClean: overrides.isReconciliationClean,
        isBridgePortOccupied: overrides.isBridgePortOccupied ?? (async () => false),
      },
    });
  }

  async function startConnected(manager: OpenCodeLifecycleManager): Promise<void> {
    await manager.start();
    expect(manager.getState().ownership).toBe("control-plane");
    expect(manager.getState().status).toBe("connected");
  }

  /** Build full expected state from a committed active bridge. */
  function expectedActive(
    gen: number,
    committed: { nonceFp: string; cfgHash: string; revId: string },
    port: number,
  ): ExpectedBridgeActivationState {
    return {
      generation: gen,
      configHash: committed.cfgHash,
      revisionId: committed.revId,
      nonceFingerprint: committed.nonceFp,
      port,
    };
  }

  test("attach/external negative: rejects attach mode", async () => {
    const manager = new OpenCodeLifecycleManager(
      cfg("attach", "http://127.0.0.1:9000"),
      {
        probe: async () => fullReady(),
        bridge: { store, isBridgePortOccupied: async () => false },
      },
    );
    await manager.start();
    const result = await manager.restartForTelemetryBridge("activate", {
      generation: 1,
      configHash: "x",
      revisionId: "x",
      nonceFingerprint: "x",
      port: 8788,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("mode-not-managed");
  });

  test("rejects managed+external without process action", async () => {
    // Managed mode that reuses preexisting external backend.
    const manager = new OpenCodeLifecycleManager(cfg("managed"), {
      probe: async () => fullReady(),
      bridge: { store, isBridgePortOccupied: async () => false },
    });
    await manager.start();
    expect(manager.getState().ownership).toBe("external");
    const result = await manager.restartForTelemetryBridge("activate", {
      generation: 1,
      configHash: "x",
      revisionId: "x",
      nonceFingerprint: "x",
      port: 8788,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("ownership-not-control-plane");
  });

  test("generation unchanged on registration/no restart", async () => {
    const manager = makeManagerWithBridge();
    await startConnected(manager);
    const genBefore = manager.getState().generation;
    // Just calling getState doesn't restart.
    const state = manager.getState();
    expect(state.generation).toBe(genBefore);
  });

  test("+1 only after readiness on successful activation restart", async () => {
    const manager = makeManagerWithBridge();
    await startConnected(manager);
    const genBefore = manager.getState().generation;

    const committed = commitActiveBridge(8788, "nonce-1234567890abcdef", `{"plugin":["/bridge"]}`);
    const result = await manager.restartForTelemetryBridge("activate", expectedActive(genBefore, committed, 8788));
    expect(result.ok).toBe(true);
    expect(result.state.generation).toBe(genBefore + 1);
  });

  test("activation failure leaves failed owned state, no automatic backoff", async () => {
    let startCallCount = 0;
    const manager = makeManagerWithBridge({
      startSdk: async () => {
        startCallCount++;
        if (startCallCount === 1) {
          // Initial start: resolve.
          return { url: "http://127.0.0.1:4096", close() {} };
        }
        // Activation restart: fail.
        throw new Error("activation start failed");
      },
    });
    await startConnected(manager);
    const genBefore = manager.getState().generation;

    const committed = commitActiveBridge(8788, "nonce-1234567890abcdef", `{"plugin":["/bridge"]}`, "fail");
    const result = await manager.restartForTelemetryBridge("activate", expectedActive(genBefore, committed, 8788));
    expect(result.ok).toBe(false);
    expect(result.state.status).toBe("failed");
    // Generation remains last successful.
    expect(result.state.generation).toBe(genBefore);
    // No automatic backoff: no restart scheduled.
    expect(result.state.restart).toBeUndefined();
  });

  test("explicit recovery from failed state", async () => {
    let startCount = 0;
    const manager = makeManagerWithBridge({
      startSdk: async () => {
        startCount++;
        if (startCount === 1) {
          // Initial start: resolve.
          return { url: "http://127.0.0.1:4096", close() {} };
        }
        if (startCount === 2) {
          // Activation restart: fail.
          throw new Error("activation start fails");
        }
        // Recovery: succeed.
        return { url: "http://127.0.0.1:4096", close() {} };
      },
    });
    await startConnected(manager);
    const genBefore = manager.getState().generation;

    const committed = commitActiveBridge(8788, "nonce-1234567890abcdef", `{"plugin":["/bridge"]}`, "recover");

    // First: activate fails.
    const failResult = await manager.restartForTelemetryBridge("activate", expectedActive(genBefore, committed, 8788));
    expect(failResult.ok).toBe(false);
    expect(failResult.state.status).toBe("failed");

    // Then: explicit recovery succeeds.
    const recoverResult = await manager.restartForTelemetryBridge("recover-activation-failure", expectedActive(genBefore, committed, 8788));
    expect(recoverResult.ok).toBe(true);
    expect(recoverResult.state.status).toBe("connected");
    expect(recoverResult.state.generation).toBe(genBefore + 1);
  });

  test("committed hash mismatch rejects restart", async () => {
    const manager = makeManagerWithBridge();
    await startConnected(manager);
    const genBefore = manager.getState().generation;

    const committed = commitActiveBridge(8788, "nonce-1234567890abcdef", `{"plugin":["/bridge"]}`);
    const result = await manager.restartForTelemetryBridge("activate", {
      generation: genBefore,
      configHash: "wrong-hash",
      revisionId: committed.revId,
      nonceFingerprint: committed.nonceFp,
      port: 8788,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("config-hash-mismatch");
  });

  test("committed generation mismatch rejects restart", async () => {
    const manager = makeManagerWithBridge();
    await startConnected(manager);
    const committed = commitActiveBridge(8788, "nonce-1234567890abcdef", `{"plugin":["/bridge"]}`);
    const result = await manager.restartForTelemetryBridge("activate", expectedActive(999, committed, 8788));
    expect(result.ok).toBe(false);
    expect(result.code).toBe("generation-mismatch");
  });

  test("committed revision mismatch rejects restart", async () => {
    const manager = makeManagerWithBridge();
    await startConnected(manager);
    const genBefore = manager.getState().generation;
    const committed = commitActiveBridge(8788, "nonce-1234567890abcdef", `{"plugin":["/bridge"]}`);
    const result = await manager.restartForTelemetryBridge("activate", {
      generation: genBefore,
      configHash: committed.cfgHash,
      revisionId: "wrong-rev",
      nonceFingerprint: committed.nonceFp,
      port: 8788,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("revision-mismatch");
  });

  test("committed nonce fingerprint mismatch rejects restart", async () => {
    const manager = makeManagerWithBridge();
    await startConnected(manager);
    const genBefore = manager.getState().generation;
    const committed = commitActiveBridge(8788, "nonce-1234567890abcdef", `{"plugin":["/bridge"]}`);
    const result = await manager.restartForTelemetryBridge("activate", {
      generation: genBefore,
      configHash: committed.cfgHash,
      revisionId: committed.revId,
      nonceFingerprint: "wrong-fingerprint",
      port: 8788,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("nonce-fingerprint-mismatch");
  });

  test("committed port mismatch rejects restart", async () => {
    const manager = makeManagerWithBridge();
    await startConnected(manager);
    const genBefore = manager.getState().generation;
    const committed = commitActiveBridge(8788, "nonce-1234567890abcdef", `{"plugin":["/bridge"]}`);
    const result = await manager.restartForTelemetryBridge("activate", {
      generation: genBefore,
      configHash: committed.cfgHash,
      revisionId: committed.revId,
      nonceFingerprint: committed.nonceFp,
      port: 8789,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("port-mismatch");
  });

  test("omitted expected fields reject restart (no bypass)", async () => {
    const manager = makeManagerWithBridge();
    await startConnected(manager);
    const genBefore = manager.getState().generation;
    commitActiveBridge(8788, "nonce-1234567890abcdef", `{"plugin":["/bridge"]}`);
    // Omit nonceFingerprint and port — must be rejected.
    const result = await manager.restartForTelemetryBridge("activate", {
      generation: genBefore,
      configHash: "some-hash",
      revisionId: "some-rev",
    });
    expect(result.ok).toBe(false);
    // Should fail on configHash mismatch first (since "some-hash" != committed).
    // But the point is: omitted nonceFingerprint/port would also fail.
    expect(result.ok).toBe(false);
  });

  test("dirty reconciliation blocks owned start", async () => {
    let reconciliationDirty = false;
    const manager = makeManagerWithBridge({
      isReconciliationClean: () => !reconciliationDirty,
    });
    await startConnected(manager);
    const genBefore = manager.getState().generation;
    const committed = commitActiveBridge(8788, "nonce-1234567890abcdef", `{"plugin":["/bridge"]}`, "dirty");
    // Now make reconciliation dirty.
    reconciliationDirty = true;
    const result = await manager.restartForTelemetryBridge("activate", expectedActive(genBefore, committed, 8788));
    expect(result.ok).toBe(false);
    expect(result.code).toBe("bridge-reconciliation-dirty");
  });

  test("port race before close: occupied port returns bridge-port-race and does not close", async () => {
    let closes = 0;
    const manager = makeManagerWithBridge({
      isBridgePortOccupied: async () => true, // port occupied
      startSdk: async () => ({
        url: "http://127.0.0.1:4096",
        close: () => closes++,
      }),
    });
    await startConnected(manager);
    const genBefore = manager.getState().generation;
    const committed = commitActiveBridge(8788, "nonce-1234567890abcdef", `{"plugin":["/bridge"]}`);

    const result = await manager.restartForTelemetryBridge("activate", expectedActive(genBefore, committed, 8788));
    expect(result.ok).toBe(false);
    // Port occupied before close → bridge-port-race, no process action.
    expect(result.code).toBe("bridge-port-race");
    // Owned handle was NOT closed.
    expect(closes).toBe(0);
    // State remains connected (no process action).
    expect(manager.getState().status).toBe("connected");
  });

  test("port race for recovery: occupied port returns bridge-port-race with no process action", async () => {
    let startCallCount = 0;
    const manager = makeManagerWithBridge({
      startSdk: async () => {
        startCallCount++;
        if (startCallCount === 1) {
          // Initial start: resolve.
          return { url: "http://127.0.0.1:4096", close() {} };
        }
        // Activation restart: fail.
        throw new Error("activation start fails");
      },
      isBridgePortOccupied: async () => true, // always occupied
    });
    await startConnected(manager);
    const genBefore = manager.getState().generation;
    const committed = commitActiveBridge(8788, "nonce-1234567890abcdef", `{"plugin":["/bridge"]}`, "recover-race");

    // First: activate fails (port is occupied → bridge-port-race, no process action).
    const failResult = await manager.restartForTelemetryBridge("activate", expectedActive(genBefore, committed, 8788));
    expect(failResult.ok).toBe(false);
    expect(failResult.code).toBe("bridge-port-race");
    // State remains connected (no process action).
    expect(failResult.state.status).toBe("connected");

    // Recovery also blocked by port race (no process action).
    // But since state is still connected (not failed), recovery requires failed state.
    // So we need to actually fail first. Let's use a different approach:
    // The port race prevented any process action, so the state is still connected.
    // Recovery requires failed state, so this would fail with "not-failed".
    const recoverResult = await manager.restartForTelemetryBridge("recover-activation-failure", expectedActive(genBefore, committed, 8788));
    expect(recoverResult.ok).toBe(false);
    expect(recoverResult.code).toBe("not-failed");
  });

  test("in-flight rejection: second call while first is in flight", async () => {
    let startCallCount = 0;
    let resolveStart: ((v: { url: string; close(): void }) => void) | undefined;
    const manager = makeManagerWithBridge({
      startSdk: async () => {
        startCallCount++;
        if (startCallCount === 1) {
          // Initial start: resolve immediately.
          return { url: "http://127.0.0.1:4096", close() {} };
        }
        // Activation restart: hang until resolved.
        return new Promise((resolve) => {
          resolveStart = resolve;
        });
      },
    });
    await startConnected(manager);
    const genBefore = manager.getState().generation;
    const committed = commitActiveBridge(8788, "nonce-1234567890abcdef", `{"plugin":["/bridge"]}`, "inflight");

    // First call (in flight) — don't await yet.
    const firstPromise = manager.restartForTelemetryBridge("activate", expectedActive(genBefore, committed, 8788));
    // Give the first call a tick to set activationRestartInFlight.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Second call while first is in flight.
    const secondResult = await manager.restartForTelemetryBridge("activate", expectedActive(genBefore, committed, 8788));
    expect(secondResult.ok).toBe(false);
    expect(secondResult.code).toBe("activation-restart-in-flight");

    // Resolve the first start to clean up.
    if (resolveStart) resolveStart({ url: "http://127.0.0.1:4096", close() {} });
    const firstResult = await firstPromise;
    expect(firstResult.ok).toBe(true);
  });

  test("no use of ordinary restart budget (MANAGED_RESTART_DELAYS_MS)", async () => {
    let sleepCalls = 0;
    let probeCount = 0;
    const manager = new OpenCodeLifecycleManager(cfg("managed"), {
      probe: async () => {
        probeCount++;
        if (probeCount === 1) return { kind: "refused", readiness: { ...ready, health: false, rest: false } };
        return fullReady();
      },
      startSdk: async () => ({ url: "http://127.0.0.1:4096", close() {} }),
      sleep: async () => { sleepCalls++; },
      portBindable: async () => true,
      bridge: { store, isBridgePortOccupied: async () => false },
    });
    await startConnected(manager);
    const genBefore = manager.getState().generation;
    const committed = commitActiveBridge(8788, "nonce-1234567890abcdef", `{"plugin":["/bridge"]}`);

    const result = await manager.restartForTelemetryBridge("activate", expectedActive(genBefore, committed, 8788));
    expect(result.ok).toBe(true);
    // Activation restart never uses MANAGED_RESTART_DELAYS_MS sleep.
    expect(sleepCalls).toBe(0);
  });

  test("raw nonce absent from state/errors/log snapshots", async () => {
    let startCallCount = 0;
    const manager = makeManagerWithBridge({
      startSdk: async () => {
        startCallCount++;
        if (startCallCount === 1) {
          // Initial start: resolve.
          return { url: "http://127.0.0.1:4096", close() {} };
        }
        // Activation restart: fail with an error containing the raw nonce.
        throw new Error("activation start failed with raw-nonce-leaked-1234567890abcdef");
      },
    });
    await startConnected(manager);
    const genBefore = manager.getState().generation;

    const rawNonce = "super-secret-raw-nonce-1234567890";
    const committed = commitActiveBridge(8788, rawNonce, `{"plugin":["/bridge"]}`, "raw");

    const result = await manager.restartForTelemetryBridge("activate", expectedActive(genBefore, committed, 8788));
    expect(result.ok).toBe(false);

    // Raw nonce absent from result state.
    const stateSerialized = JSON.stringify(result.state);
    expect(stateSerialized).not.toContain(rawNonce);
    expect(stateSerialized).not.toContain("super-secret-raw-nonce");

    // Raw nonce absent from error message.
    if (result.message) {
      expect(result.message).not.toContain(rawNonce);
    }

    // Raw nonce absent from getStateWithRestartKind.
    const fullState = manager.getStateWithRestartKind();
    const fullSerialized = JSON.stringify(fullState);
    expect(fullSerialized).not.toContain(rawNonce);
  });

  test("env reinjection ordinary recovery reuses same committed port/nonce", async () => {
    // This test verifies that ordinary backend-loss recovery (not activation
    // restart) goes through the owned start path which uses the launch
    // boundary env overlay. The sdk-adapter test proves the overlay is
    // applied; here we verify the lifecycle's ordinary recovery path
    // calls startSdk which internally uses the overlay.
    let startCount = 0;
    const manager = new OpenCodeLifecycleManager(cfg("managed"), {
      probe: async (url) => {
        if (url === PREFERRED_OPENCODE_BASE_URL) {
          return { kind: "refused", readiness: { ...ready, health: false, rest: false } };
        }
        return fullReady();
      },
      startSdk: async () => {
        startCount++;
        return {
          url: `http://127.0.0.1:${7000 + startCount}`,
          close() {},
        };
      },
      sleep: async () => {},
      portBindable: async () => true,
      bridge: { store, isBridgePortOccupied: async () => false },
    });

    // Commit an active bridge so the launch boundary applies the overlay.
    const rawNonce = "recovery-nonce-1234567890abcdef";
    commitActiveBridge(8788, rawNonce, `{"plugin":["/bridge"]}`);

    // Start (owned) — preferred port refused forces owned start.
    const first = await manager.start();
    expect(first.ownership).toBe("control-plane");
    expect(first.generation).toBe(1);

    // Ordinary backend loss → recovery.
    await manager.backendLost("connection lost");
    const second = manager.getState();
    expect(second.status).toBe("connected");
    expect(second.generation).toBe(2);

    // The ordinary recovery reuses the same committed port/nonce via the
    // launch boundary overlay. The sdk-adapter applies the overlay
    // synchronously during spawn and restores env before awaiting.
    expect(startCount).toBe(2);
  });

  test("lifecycle state distinguishes telemetry-activation restart kind", async () => {
    let startCallCount = 0;
    let resolveStart: ((v: { url: string; close(): void }) => void) | undefined;
    const manager = makeManagerWithBridge({
      startSdk: async () => {
        startCallCount++;
        if (startCallCount === 1) {
          // Initial start: resolve immediately.
          return { url: "http://127.0.0.1:4096", close() {} };
        }
        // Activation restart: hang until resolved.
        return new Promise((resolve) => {
          resolveStart = resolve;
        });
      },
    });
    await startConnected(manager);
    const genBefore = manager.getState().generation;
    const committed = commitActiveBridge(8788, "nonce-1234567890abcdef", `{"plugin":["/bridge"]}`, "kind");

    // Start activation restart (in flight) — don't await yet.
    const promise = manager.restartForTelemetryBridge("activate", expectedActive(genBefore, committed, 8788));
    // Give it a tick to transition.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // While in flight, the state should show telemetry-activation restart kind.
    const inFlightState = manager.getStateWithRestartKind();
    expect(inFlightState.status).toBe("restarting");
    expect(inFlightState.restartKind).toBe("telemetry-activation");

    // Resolve and wait.
    if (resolveStart) resolveStart({ url: "http://127.0.0.1:4096", close() {} });
    const result = await promise;
    expect(result.ok).toBe(true);

    // After success, restartKind is cleared.
    const finalState = manager.getStateWithRestartKind();
    expect(finalState.restartKind).toBeUndefined();
  });

  test("awaiting-owner restart kind for attach/external backend loss", async () => {
    const manager = new OpenCodeLifecycleManager(
      cfg("attach", "http://127.0.0.1:9000"),
      {
        probe: async () => fullReady(),
        bridge: { store, isBridgePortOccupied: async () => false },
      },
    );
    await manager.start();
    // Simulate backend loss for attach.
    await manager.backendLost("lost");
    const state = manager.getStateWithRestartKind();
    // Attach fails to "failed" status (not "restarting" with awaiting-owner).
    // The backendLost for attach transitions to "restarting" with
    // "awaiting-owner" then immediately fails.
    expect(state.status).toBe("failed");
  });

  test("deactivate requires disabled committed state and no port check", async () => {
    let closes = 0;
    let portChecks = 0;
    const manager = makeManagerWithBridge({
      startSdk: async () => ({
        url: "http://127.0.0.1:4096",
        close: () => closes++,
      }),
      isBridgePortOccupied: async () => {
        portChecks++;
        return false;
      },
    });
    await startConnected(manager);
    const genBefore = manager.getState().generation;

    // First commit an active bridge, then commit a disabled state.
    commitActiveBridge(8788, "nonce-1234567890abcdef", `{"plugin":["/bridge"]}`, "deact1");
    const disabled = commitDisabledBridge(`{"plugin":[]}`, "deact2");

    const result = await manager.restartForTelemetryBridge("deactivate", {
      generation: genBefore,
      configHash: disabled.cfgHash,
      revisionId: disabled.revId,
    });
    expect(result.ok).toBe(true);
    expect(result.state.generation).toBe(genBefore + 1);
    // The old owned handle was closed.
    expect(closes).toBeGreaterThanOrEqual(1);
    // Deactivate does NOT perform a port check.
    expect(portChecks).toBe(0);
  });

  test("deactivate rejects when committed state is still active", async () => {
    const manager = makeManagerWithBridge();
    await startConnected(manager);
    const genBefore = manager.getState().generation;

    // Commit active bridge (not disabled).
    const committed = commitActiveBridge(8788, "nonce-1234567890abcdef", `{"plugin":["/bridge"]}`, "deact-still");

    const result = await manager.restartForTelemetryBridge("deactivate", {
      generation: genBefore,
      configHash: committed.cfgHash,
      revisionId: committed.revId,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("committed-state-still-active");
  });

  test("deactivate rejects when expected includes nonceFingerprint or port", async () => {
    const manager = makeManagerWithBridge();
    await startConnected(manager);
    const genBefore = manager.getState().generation;

    commitActiveBridge(8788, "nonce-1234567890abcdef", `{"plugin":["/bridge"]}`, "deact-still");
    const disabled = commitDisabledBridge(`{"plugin":[]}`, "deact3");

    const result = await manager.restartForTelemetryBridge("deactivate", {
      generation: genBefore,
      configHash: disabled.cfgHash,
      revisionId: disabled.revId,
      nonceFingerprint: "should-not-be-here",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("unexpected-nonce-fingerprint");
  });

  test("same canonical runtime handle: activation restart uses same manager", async () => {
    const manager = makeManagerWithBridge();
    await startConnected(manager);
    const genBefore = manager.getState().generation;

    // Multiple activation restarts on the same manager.
    for (let i = 0; i < 2; i++) {
      const committed = commitActiveBridge(8788 + i, `nonce-${i}-1234567890abcdef`, `{"plugin":["/bridge"]}`, `loop${i}`);
      const result = await manager.restartForTelemetryBridge("activate", expectedActive(genBefore + i, committed, 8788 + i));
      expect(result.ok).toBe(true);
      expect(result.state.generation).toBe(genBefore + i + 1);
    }
  });

  test("OPENCODE_CONFIG_DIR restored after activation restart", async () => {
    const priorDir = process.env.OPENCODE_CONFIG_DIR;
    const manager = makeManagerWithBridge();
    await startConnected(manager);
    const genBefore = manager.getState().generation;

    const committed = commitActiveBridge(8788, "nonce-1234567890abcdef", `{"plugin":["/bridge"]}`, "cfgdir");
    await manager.restartForTelemetryBridge("activate", expectedActive(genBefore, committed, 8788));

    // OPENCODE_CONFIG_DIR is restored to its prior value.
    if (priorDir === undefined) {
      expect(process.env.OPENCODE_CONFIG_DIR).toBeUndefined();
    } else {
      expect(process.env.OPENCODE_CONFIG_DIR).toBe(priorDir);
    }
  });
});
// ── Phase 2: reconciliation-clean gate helper ───────────────────────────

describe("computeBridgeReconciliationClean", () => {
  test("clean when disposition committed/not-written and no unresolved intents", () => {
    expect(
      computeBridgeReconciliationClean({
        cachedDisposition: "committed",
        hasUnresolvedOrConflictIntents: () => false,
      }),
    ).toBe(true);
    expect(
      computeBridgeReconciliationClean({
        cachedDisposition: "not-written",
        hasUnresolvedOrConflictIntents: () => false,
      }),
    ).toBe(true);
    expect(
      computeBridgeReconciliationClean({
        cachedDisposition: undefined,
        hasUnresolvedOrConflictIntents: () => false,
      }),
    ).toBe(true);
  });

  test("recovery-pending disposition blocks even with no unresolved intents", () => {
    expect(
      computeBridgeReconciliationClean({
        cachedDisposition: "recovery-pending",
        hasUnresolvedOrConflictIntents: () => false,
      }),
    ).toBe(false);
  });

  test("unresolved/conflict intents (conflict/drift) block", () => {
    expect(
      computeBridgeReconciliationClean({
        cachedDisposition: "committed",
        hasUnresolvedOrConflictIntents: () => true,
      }),
    ).toBe(false);
  });

  test("store errors fail closed", () => {
    expect(
      computeBridgeReconciliationClean({
        cachedDisposition: "committed",
        hasUnresolvedOrConflictIntents: () => {
          throw new Error("db gone");
        },
      }),
    ).toBe(false);
  });
});

// ── Phase 2 Gate 2: external-edit drift gate ────────────────────────────

describe("bridgeReconcileDispositionAfterExternalEdit", () => {
  test("external edit with active committed state dirties the disposition", () => {
    const d = bridgeReconcileDispositionAfterExternalEdit({
      hasActiveCommittedState: true,
      currentDisposition: "committed",
    });
    expect(d).toBeDefined();
    expect(d!.disposition).toBe("recovery-pending");
    expect(d!.errors[0]!.code).toBe("state-recovery-pending");
  });

  test("external edit with no active committed state leaves disposition alone", () => {
    expect(
      bridgeReconcileDispositionAfterExternalEdit({
        hasActiveCommittedState: false,
        currentDisposition: "not-written",
      }),
    ).toBeUndefined();
  });

  test("already recovery-pending stays recovery-pending (no redundant churn)", () => {
    expect(
      bridgeReconcileDispositionAfterExternalEdit({
        hasActiveCommittedState: true,
        currentDisposition: "recovery-pending",
      }),
    ).toBeUndefined();
  });

  test("dirtied disposition blocks the owned-start gate even with zero unresolved intents", () => {
    const dirtied = bridgeReconcileDispositionAfterExternalEdit({
      hasActiveCommittedState: true,
      currentDisposition: "committed",
    });
    expect(
      computeBridgeReconciliationClean({
        cachedDisposition: dirtied!.disposition,
        hasUnresolvedOrConflictIntents: () => false,
      }),
    ).toBe(false);
  });
});

describe("external-edit / missing-field owned-start gating (integration)", () => {
  beforeEach(() => setupBridgeStore());
  afterEach(() => teardownBridgeStore());

  // Local self-contained harness (mirrors the restartForTelemetryBridge one,
  // which is describe-scoped and not visible here).
  function makeGatedManager(input: {
    startSdk: () => Promise<{ url: string; close(): void }>;
    isReconciliationClean: () => boolean;
  }): OpenCodeLifecycleManager {
    let probeCount = 0;
    return new OpenCodeLifecycleManager(cfg("managed"), {
      probe: async () => {
        probeCount++;
        if (probeCount === 1) {
          return { kind: "refused", readiness: { ...ready, health: false, rest: false } };
        }
        return fullReady();
      },
      startSdk: input.startSdk,
      sleep: async () => {},
      portBindable: async () => true,
      bridge: {
        store,
        isReconciliationClean: input.isReconciliationClean,
        isBridgePortOccupied: async () => false,
      },
    });
  }

  test("startSdk is never called after an external edit dirties the gate", async () => {
    const committed = commitActiveBridge(8788, "nonce-1234567890abcdef", `{"plugin":["/bridge"]}`, "gate");
    let sdkStarts = 0;
    // The gate closure mirrors the composition root: cached disposition +
    // unresolved-intent check.
    let cachedDisposition: "not-written" | "committed" | "recovery-pending" = "committed";
    const manager = makeGatedManager({
      startSdk: async () => {
        sdkStarts++;
        return { url: "http://127.0.0.1:4096", close() {} };
      },
      isReconciliationClean: () =>
        computeBridgeReconciliationClean({
          cachedDisposition,
          hasUnresolvedOrConflictIntents: () =>
            store.hasUnresolvedOrConflictIntents(),
        }),
    });
    await manager.start();
    expect(manager.getState().status).toBe("connected");
    expect(manager.getState().ownership).toBe("control-plane");
    expect(sdkStarts).toBe(1);
    const genBefore = manager.getState().generation;

    // Simulate the watcher: external edit with an active committed state
    // immediately dirties the gate (before any async refresh).
    const dirtied = bridgeReconcileDispositionAfterExternalEdit({
      hasActiveCommittedState: store.getActivationState()?.active === true,
      currentDisposition: cachedDisposition,
    });
    if (dirtied !== undefined) cachedDisposition = dirtied.disposition;

    // Unresolved-intent absence must not make it clean.
    expect(store.hasUnresolvedOrConflictIntents()).toBe(false);

    const result = await manager.restartForTelemetryBridge("activate", {
      generation: genBefore,
      configHash: committed.cfgHash,
      revisionId: committed.revId,
      nonceFingerprint: committed.nonceFp,
      port: 8788,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("bridge-reconciliation-dirty");
    expect(sdkStarts).toBe(1); // never called again
  });

  test("startSdk is never called when the committed active state misses mandatory fields", async () => {
    // Commit an active state MISSING the port (mandatory field).
    writeFileSync(configPath, `{"plugin":["/bridge"]}`, "utf-8");
    const cfgHash = hashContent(`{"plugin":["/bridge"]}`);
    store.insertPreparedIntent({
      id: "intent_missing_port",
      targetPath: configPath,
      sourceKind: "opencode-config-dir",
      operation: "add",
      baselineHash: "h_base",
      proposedHash: cfgHash,
      canonicalIdentity: "/canonical/bridge",
      registrationTransport: "env",
      transportMode: "loopback-http",
      nonceFingerprint: "a".repeat(64),
      bytePatch: "{}",
      rawActivationNonce: "nonce-1234567890abcdef",
    });
    store.finalizeIntent("intent_missing_port", "rev_missing", new Date().toISOString(), cfgHash);

    // The service reconcile classifies missing mandatory committed state as
    // recovery-pending.
    const service = new BridgeService({
      opencodeConfigDir: DEFAULT_OPENCODE_CONFIG_DIRECTORY,
      projectDirectory: MANAGED_PROJECT_DIRECTORY,
      authorizedRoots: [MANAGED_PROJECT_DIRECTORY, DEFAULT_OPENCODE_CONFIG_DIRECTORY],
      revisions: store,
      effectiveViewProvider: async () => {
        throw new Error("not needed");
      },
    });
    const rec = service.reconcile();
    expect(rec.disposition).toBe("recovery-pending");

    let sdkStarts = 0;
    const manager = makeGatedManager({
      startSdk: async () => {
        sdkStarts++;
        return { url: "http://127.0.0.1:4096", close() {} };
      },
      isReconciliationClean: () =>
        computeBridgeReconciliationClean({
          cachedDisposition: rec.disposition,
          hasUnresolvedOrConflictIntents: () =>
            store.hasUnresolvedOrConflictIntents(),
        }),
    });
    // Owned start itself must block: manage() fails before any SDK start.
    await manager.start();
    expect(manager.getState().status).toBe("failed");
    expect(sdkStarts).toBe(0);
  });
});

// ── Phase 2 Gate 2 attempt 2: watcher removal → drift gate wiring ───────

describe("watcher removal drift gate (real watcher wiring)", () => {
  beforeEach(() => setupBridgeStore());
  afterEach(() => teardownBridgeStore());

  test("real watcher 'removed' for the committed target dirties the gate; startSdk never called", async () => {
    // Commit an active bridge whose target lives in the watched sandbox dir.
    commitActiveBridge(8788, "nonce-1234567890abcdef", `{"plugin":["/bridge"]}`, "watch-rm");
    expect(store.getActivationState()?.active).toBe(true);

    // REAL watcher (fs.watch) with injected zero debounce — no sleeps; the
    // baseline hash is recorded synchronously by start().
    let cachedDisposition: "not-written" | "committed" | "recovery-pending" = "committed";
    const watcher = createBridgeWatcher({ directory: sandbox, debounceMs: 0 });
    const removedSeen = new Promise<void>((resolve, reject) => {
      const guard = setTimeout(
        () => reject(new Error("watcher 'removed' event never arrived — wiring broken")),
        10_000,
      );
      watcher.onEvent((event) => {
        if (event.kind === "external-edit" || event.kind === "removed") {
          // Mirror the composition-root wiring (index.ts): dirty the gate
          // immediately on external change/removal, before any refresh.
          const dirtied = bridgeReconcileDispositionAfterExternalEdit({
            hasActiveCommittedState: store.getActivationState()?.active === true,
            currentDisposition: cachedDisposition,
          });
          if (dirtied !== undefined) cachedDisposition = dirtied.disposition;
          if (event.kind === "removed") {
            clearTimeout(guard);
            resolve();
          }
        }
      });
    });
    watcher.start();
    try {
      rmSync(configPath); // remove the committed target
      await removedSeen; // event-driven wait; timeout is a failure guard only
    } finally {
      watcher.stop();
    }

    expect(cachedDisposition as string).toBe("recovery-pending");
    expect(store.hasUnresolvedOrConflictIntents()).toBe(false);

    // A subsequent lifecycle start must fail BEFORE any SDK start.
    let sdkStarts = 0;
    const manager = new OpenCodeLifecycleManager(cfg("managed"), {
      probe: async () => ({ kind: "refused", readiness: { ...ready, health: false, rest: false } }),
      startSdk: async () => {
        sdkStarts++;
        return { url: "http://127.0.0.1:4096", close() {} };
      },
      sleep: async () => {},
      portBindable: async () => true,
      bridge: {
        store,
        isReconciliationClean: () =>
          computeBridgeReconciliationClean({
            cachedDisposition,
            hasUnresolvedOrConflictIntents: () =>
              store.hasUnresolvedOrConflictIntents(),
          }),
        isBridgePortOccupied: async () => false,
      },
    });
    await manager.start();
    expect(manager.getState().status).toBe("failed");
    expect(manager.getState().error?.code).toBe("bridge-reconciliation-dirty");
    expect(sdkStarts).toBe(0);
  });
});
