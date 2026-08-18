/**
 * Plugin-entry (index.ts) activation-gating tests (Phase 2, Gate 2).
 *
 * Uses the test-only server-factory seam (never reachable as a named export
 * candidate and always undefined in production) to prove:
 * - bare registration → typed inactive, no-op hooks, ZERO acquire/serve;
 * - partial/mixed activation → typed invalid, ZERO acquire/serve;
 * - missing canonical origin → typed invalid, ZERO acquire/serve;
 * - valid activation with bind collision → plugin init REJECTS with a typed
 *   redacted BridgeActivationError (no sentinel/raw error text in the error
 *   or in captured logs);
 * - valid activation → exactly one serve with the managed port; dispose
 *   releases the epoch.
 *
 * Sentinel values are fake; tests assert they never appear in outcomes/logs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PluginInput } from "@opencode-ai/plugin";
import omoTelemetryBridge from "./index";
import {
  __bridgeRefcountForTests,
  __bridgeRegistryStateForTests,
  __failNextRegistryReadsForTests,
  __resetBridgeRegistryForTests,
  __setBridgeServerFactoryForTests,
  BridgeActivationError,
  type BridgeFetchHandler,
  type BridgeServerFactory,
  type BridgeServerHandle,
} from "./lifecycle";

const SENTINEL = "SENTINEL-ENTRY-SECRET-abcdef0123456789";
const PORT_ENV = "OMO_BRIDGE_PORT";
const NONCE_ENV = "OMO_BRIDGE_ACTIVATION_NONCE";

const noopFetch: BridgeFetchHandler = () => new Response("ok");

class RecordingFactory implements BridgeServerFactory {
  calls: Array<{ hostname: string; port: number }> = [];
  stopCalls = 0;
  failWith: Error | undefined;
  serve(opts: {
    hostname: string;
    port: number;
    fetch: BridgeFetchHandler;
  }): BridgeServerHandle {
    this.calls.push({ hostname: opts.hostname, port: opts.port });
    if (this.failWith) throw this.failWith;
    const self = this;
    return {
      hostname: opts.hostname,
      port: opts.port,
      async stop() {
        self.stopCalls += 1;
      },
    };
  }
}

let factory: RecordingFactory;
let savedPort: string | undefined;
let savedNonce: string | undefined;
let logLines: string[];
let origInfo: typeof console.info;
let origError: typeof console.error;
let origWarn: typeof console.warn;

function inputWithOrigin(origin: string | undefined): PluginInput {
  return {
    serverUrl: origin === undefined ? undefined : new URL(origin),
  } as unknown as PluginInput;
}

beforeEach(() => {
  savedPort = process.env[PORT_ENV];
  savedNonce = process.env[NONCE_ENV];
  delete process.env[PORT_ENV];
  delete process.env[NONCE_ENV];
  factory = new RecordingFactory();
  __setBridgeServerFactoryForTests(factory);
  __resetBridgeRegistryForTests();
  logLines = [];
  origInfo = console.info;
  origError = console.error;
  origWarn = console.warn;
  const capture =
    (level: string) =>
    (...args: unknown[]) => {
      logLines.push(`${level}:${args.map((a) => String(a)).join(" ")}`);
    };
  console.info = capture("info");
  console.error = capture("error");
  console.warn = capture("warn");
  void noopFetch;
});

afterEach(() => {
  console.info = origInfo;
  console.error = origError;
  console.warn = origWarn;
  if (savedPort === undefined) delete process.env[PORT_ENV];
  else process.env[PORT_ENV] = savedPort;
  if (savedNonce === undefined) delete process.env[NONCE_ENV];
  else process.env[NONCE_ENV] = savedNonce;
  __setBridgeServerFactoryForTests(undefined);
  __resetBridgeRegistryForTests();
});

describe("plugin entry activation gating", () => {
  test("bare registration → typed inactive, no-op hooks, zero acquire/serve", async () => {
    const hooks = await omoTelemetryBridge(inputWithOrigin("http://127.0.0.1:4096"));
    expect(factory.calls.length).toBe(0);
    expect(__bridgeRegistryStateForTests()).toBe("absent");
    expect(typeof hooks.dispose).toBe("function");
    await expect(hooks.dispose!()).resolves.toBeUndefined();
    const log = logLines.join("\n");
    expect(log).toContain("activation-absent");
    expect(log).not.toContain(SENTINEL);
  });

  test("partial activation (port only) → typed invalid, zero acquire/serve", async () => {
    const hooks = await omoTelemetryBridge(inputWithOrigin("http://127.0.0.1:4096"), {
      port: 8790,
    });
    expect(factory.calls.length).toBe(0);
    expect(__bridgeRegistryStateForTests()).toBe("absent");
    await expect(hooks.dispose!()).resolves.toBeUndefined();
    expect(logLines.join("\n")).toContain("activation-incomplete");
  });

  test("mixed channels → typed invalid, zero acquire/serve", async () => {
    process.env[NONCE_ENV] = SENTINEL;
    const hooks = await omoTelemetryBridge(inputWithOrigin("http://127.0.0.1:4096"), {
      port: 8790,
    });
    expect(factory.calls.length).toBe(0);
    expect(__bridgeRegistryStateForTests()).toBe("absent");
    const log = logLines.join("\n");
    expect(log).toContain("mixed-activation-channels");
    expect(log).not.toContain(SENTINEL);
  });

  test("valid activation with missing origin → typed invalid, zero acquire/serve", async () => {
    process.env[PORT_ENV] = "8790";
    process.env[NONCE_ENV] = SENTINEL;
    const hooks = await omoTelemetryBridge(inputWithOrigin(undefined));
    expect(factory.calls.length).toBe(0);
    expect(__bridgeRegistryStateForTests()).toBe("absent");
    const log = logLines.join("\n");
    expect(log).toContain("canonical-origin-missing");
    expect(log).not.toContain(SENTINEL);
  });

  test("valid activation + EADDRINUSE → plugin init rejects typed redacted error", async () => {
    process.env[PORT_ENV] = "8790";
    process.env[NONCE_ENV] = SENTINEL;
    factory.failWith = new Error(`listen EADDRINUSE 127.0.0.1:8790 ${SENTINEL}`);

    const err = await omoTelemetryBridge(
      inputWithOrigin("http://127.0.0.1:4096"),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    if (!(err instanceof BridgeActivationError)) {
      throw new Error("expected plugin init to reject with BridgeActivationError");
    }
    expect(err.code).toBe("activation-start-failed");
    expect(err.detail).toBe("EADDRINUSE");
    // Redacted: no raw Bun error text, no sentinel.
    expect(err.message).not.toContain(SENTINEL);
    expect(err.message).not.toContain("listen EADDRINUSE 127.0.0.1");
    expect(err.stack ?? "").not.toContain(SENTINEL);
    // Logs never contain the sentinel either.
    expect(logLines.join("\n")).not.toContain(SENTINEL);
    // Registry cleaned (failed start returns to Absent).
    expect(__bridgeRegistryStateForTests()).toBe("absent");
  });

  test("valid activation → exactly one serve on the managed port; dispose releases", async () => {
    process.env[PORT_ENV] = "8790";
    process.env[NONCE_ENV] = SENTINEL;
    const hooks = await omoTelemetryBridge(inputWithOrigin("http://127.0.0.1:4096"));
    expect(factory.calls).toEqual([{ hostname: "127.0.0.1", port: 8790 }]);
    expect(__bridgeRegistryStateForTests()).toBe("active");
    await hooks.dispose!();
    expect(__bridgeRegistryStateForTests()).toBe("absent");
    // The raw nonce never appears in any log line.
    expect(logLines.join("\n")).not.toContain(SENTINEL);
  });

  test("dispose propagates typed redacted retryable rejection; explicit retry succeeds exactly once", async () => {
    process.env[PORT_ENV] = "8790";
    process.env[NONCE_ENV] = SENTINEL;
    const hooks = await omoTelemetryBridge(inputWithOrigin("http://127.0.0.1:4096"));
    expect(__bridgeRegistryStateForTests()).toBe("active");
    expect(__bridgeRefcountForTests()).toBe(1);

    // First dispose: injected registry read failure → the plugin's dispose
    // REJECTS with a typed, redacted BridgeActivationError (no raw error, no
    // sentinel). The lease remains open/retryable; nothing is stopped.
    __failNextRegistryReadsForTests(1);
    const err = await hooks.dispose!().then(
      () => undefined,
      (e: unknown) => e,
    );
    if (!(err instanceof BridgeActivationError)) {
      throw new Error("expected typed rejection from plugin dispose");
    }
    expect(err.code).toBe("activation-registry-failed");
    expect(err.detail).toBe("registry-read-failed");
    expect(err.message).not.toContain(SENTINEL);
    expect(err.stack ?? "").not.toContain(SENTINEL);
    expect(factory.stopCalls).toBe(0);
    expect(__bridgeRefcountForTests()).toBe(1);
    expect(__bridgeRegistryStateForTests()).toBe("active");

    // Explicit retry on the same lease: accounts exactly once, one final
    // stop, registry cleared — no phantom ref/listener.
    await expect(hooks.dispose!()).resolves.toBeUndefined();
    expect(factory.stopCalls).toBe(1);
    expect(__bridgeRegistryStateForTests()).toBe("absent");
    expect(logLines.join("\n")).not.toContain(SENTINEL);
  });
});
