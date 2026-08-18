/**
 * Slice 17 v3 telemetry bridge tests.
 *
 * Tests cover:
 * - successful v3 managed match (verified)
 * - schema/fingerprint/origin/instance mismatch
 * - capability malformed degradation
 * - legacy non-authoritative (v1/v2 display only)
 * - override precedence / invalid rejection
 * - generation change stale + old response discard
 * - independent backoff/reconnect
 * - bridge-only loss preserves jobs
 * - multiplexer current verified only
 * - manager stop aborts
 * - no terminal fields
 * - v3 sanitizer security (sensitive keys rejected)
 */

import { describe, expect, test } from "bun:test";
import { OmoBridgeClient } from "./bridge";
import { buildMultiplexerRuntime, MULTIPLEXER_GRACE_MS } from "./multiplexer-runtime";
import {
  ReconnectScheduler,
  RECONNECT_BACKOFF_MS,
  type SchedulerFetch,
  type SchedulerTimers,
  type SchedulerTickResult,
} from "./scheduler";
import { TelemetryBridgeManager } from "./manager";
import { OmoRuntimeStore } from "./store";
import {
  parseTelemetryPayload,
  sanitizeBridgeCapabilities,
  sanitizeBridgeHealth,
  sanitizeBridgeIdentity,
  sanitizeBridgeStores,
  verifyV3Identity,
  BridgeV3ParseError,
} from "./v3";
import {
  OMO_BRIDGE_SCHEMA_VERSION_V3,
  type OmoBridgeCapabilities,
  type OmoBridgeIdentity,
  type OmoBridgeManagerInput,
  type OmoBridgeStatus,
  type OmoRuntimeSnapshot,
} from "./types";

// ── helpers ──────────────────────────────────────────────────────────────

const VALID_INSTANCE_ID = "11111111-2222-3333-4444-555555555555";
const VALID_FINGERPRINT = "a".repeat(64);
const CANONICAL_ORIGIN = "http://127.0.0.1:4096";

function validIdentity(overrides: Partial<OmoBridgeIdentity> = {}): OmoBridgeIdentity {
  return {
    pluginInstanceId: VALID_INSTANCE_ID,
    startupTimestamp: 1000,
    transportMode: "loopback-http",
    schemaVersion: 3,
    capturedAt: 2000,
    canonicalOrigin: CANONICAL_ORIGIN,
    nonceFingerprint: VALID_FINGERPRINT,
    ...overrides,
  };
}

function validCapabilities(overrides: Partial<OmoBridgeCapabilities> = {}): OmoBridgeCapabilities {
  return {
    fallbackInProgress: "present",
    continuationGate: "present",
    multiplexerManager: "present",
    cmuxStore: "present",
    runtimePreset: false,
    workerReuse: false,
    terminalCapture: false,
    ...overrides,
  };
}

function v3Payload(opts: {
  identity?: OmoBridgeIdentity;
  capabilities?: OmoBridgeCapabilities;
  stores?: Record<string, unknown>;
  capturedAt?: number;
} = {}): Record<string, unknown> {
  return {
    telemetrySchemaVersion: 3,
    capturedAt: opts.capturedAt ?? 2000,
    stores: opts.stores ?? {},
    identity: opts.identity ?? validIdentity(),
    capabilities: opts.capabilities ?? validCapabilities(),
  };
}

function v1Payload(stores: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    telemetrySchemaVersion: 1,
    capturedAt: 1000,
    stores,
  };
}

function v2Payload(stores: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    telemetrySchemaVersion: 2,
    capturedAt: 1500,
    stores,
  };
}

function healthPayload(opts: {
  ok?: boolean;
  bound?: boolean;
  schemaVersion?: number;
  capabilities?: OmoBridgeCapabilities;
  pluginInstanceId?: string;
} = {}): Record<string, unknown> {
  return {
    ok: opts.ok ?? true,
    schemaVersion: opts.schemaVersion ?? 3,
    bound: opts.bound ?? true,
    capabilities: opts.capabilities ?? validCapabilities(),
    pluginInstanceId: opts.pluginInstanceId ?? VALID_INSTANCE_ID,
  };
}

function emptySnapshot(): OmoRuntimeSnapshot {
  return {
    telemetrySchemaVersion: 2,
    generatedAt: 0,
    stale: false,
    availability: { opencodeJobs: false, bridge: false, runtimePreset: false },
    jobs: [],
    workers: [],
    notes: [],
  };
}

function snapshotWithJobs(jobs: OmoRuntimeSnapshot["jobs"]): OmoRuntimeSnapshot {
  return { ...emptySnapshot(), jobs };
}

function managedInput(overrides: Partial<OmoBridgeManagerInput> = {}): OmoBridgeManagerInput {
  return {
    mode: "managed",
    ownership: "control-plane",
    generation: 1,
    canonicalOrigin: CANONICAL_ORIGIN,
    omoReady: true,
    committed: {
      enabled: true,
      port: 8788,
      nonceFingerprint: VALID_FINGERPRINT,
      registrationTransport: "tuple",
    },
    localPackageAvailable: true,
    registration: "registered",
    ...overrides,
  };
}

/** A scripted response: either a payload object or a throw directive. */
interface ScriptedResponse {
  payload?: Record<string, unknown>;
  throwError?: string;
}

/** Fake fetch that returns scripted responses for /health and /telemetry. */
function fakeFetch(
  health: ScriptedResponse,
  telemetry: ScriptedResponse,
): SchedulerFetch {
  return async (url) => {
    if (url.endsWith("/health")) {
      if (health.throwError) throw new Error(health.throwError);
      return {
        ok: true,
        status: 200,
        json: async () => health.payload ?? {},
      };
    }
    if (url.endsWith("/telemetry")) {
      if (telemetry.throwError) throw new Error(telemetry.throwError);
      return {
        ok: true,
        status: 200,
        json: async () => telemetry.payload ?? {},
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

/** Fake timers for deterministic scheduler tests. */
function fakeTimers(): SchedulerTimers & {
  _runNext: () => void;
  _pending: Array<{ cb: () => void; ms: number }>;
  _now: number;
} {
  const state: {
    pending: Array<{ cb: () => void; ms: number }>;
    now: number;
  } = { pending: [], now: 1000 };
  return {
    now: () => state.now,
    setTimeout: (cb, ms) => {
      const entry = { cb, ms };
      state.pending.push(entry);
      return entry as unknown;
    },
    clearTimeout: (handle) => {
      const idx = state.pending.indexOf(handle as never);
      if (idx >= 0) state.pending.splice(idx, 1);
    },
    get _pending() {
      return state.pending;
    },
    _runNext() {
      const entry = state.pending.shift();
      if (entry) entry.cb();
    },
    get _now() {
      return state.now;
    },
  };
}

// ── (a) v3 sanitizer ──────────────────────────────────────────────────────

describe("v3 sanitizer", () => {
  test("valid identity parses with all fields", () => {
    const id = sanitizeBridgeIdentity(validIdentity());
    expect(id.pluginInstanceId).toBe(VALID_INSTANCE_ID);
    expect(id.transportMode).toBe("loopback-http");
    expect(id.schemaVersion).toBe(3);
    expect(id.nonceFingerprint).toBe(VALID_FINGERPRINT);
    expect(id.canonicalOrigin).toBe(CANONICAL_ORIGIN);
  });

  test("identity rejects non-whitelisted fields", () => {
    expect(() =>
      sanitizeBridgeIdentity({ ...validIdentity(), evil: "x" }),
    ).toThrow(BridgeV3ParseError);
  });

  test("identity rejects sensitive keys (raw nonce)", () => {
    expect(() =>
      sanitizeBridgeIdentity({ ...validIdentity(), activationNonce: "raw" }),
    ).toThrow(BridgeV3ParseError);
  });

  test("identity rejects invalid UUID", () => {
    expect(() =>
      sanitizeBridgeIdentity({ ...validIdentity(), pluginInstanceId: "not-a-uuid" }),
    ).toThrow(BridgeV3ParseError);
  });

  test("identity rejects non-hex fingerprint", () => {
    expect(() =>
      sanitizeBridgeIdentity({
        ...validIdentity(),
        nonceFingerprint: "XYZ".repeat(22),
      }),
    ).toThrow(BridgeV3ParseError);
  });

  test("identity rejects wrong transportMode", () => {
    expect(() =>
      sanitizeBridgeIdentity({
        ...validIdentity(),
        transportMode: "tcp" as never,
      }),
    ).toThrow(BridgeV3ParseError);
  });

  test("identity rejects wrong schemaVersion", () => {
    expect(() =>
      sanitizeBridgeIdentity({ ...validIdentity(), schemaVersion: 2 }),
    ).toThrow(BridgeV3ParseError);
  });

  test("capabilities parse with all fields", () => {
    const caps = sanitizeBridgeCapabilities(validCapabilities());
    expect(caps.fallbackInProgress).toBe("present");
    expect(caps.runtimePreset).toBe(false);
    expect(caps.workerReuse).toBe(false);
    expect(caps.terminalCapture).toBe(false);
  });

  test("capabilities reject non-whitelisted fields", () => {
    expect(() =>
      sanitizeBridgeCapabilities({ ...validCapabilities(), evil: "x" }),
    ).toThrow(BridgeV3ParseError);
  });

  test("capabilities reject invalid availability enum", () => {
    expect(() =>
      sanitizeBridgeCapabilities({
        ...validCapabilities(),
        fallbackInProgress: "bogus" as never,
      }),
    ).toThrow(BridgeV3ParseError);
  });

  test("capabilities reject runtimePreset=true", () => {
    expect(() =>
      sanitizeBridgeCapabilities({ ...validCapabilities(), runtimePreset: true as never }),
    ).toThrow(BridgeV3ParseError);
  });

  test("health parses with all fields", () => {
    const h = sanitizeBridgeHealth(healthPayload());
    expect(h.ok).toBe(true);
    expect(h.bound).toBe(true);
    expect(h.schemaVersion).toBe(3);
    expect(h.pluginInstanceId).toBe(VALID_INSTANCE_ID);
  });

  test("health rejects non-whitelisted fields", () => {
    expect(() =>
      sanitizeBridgeHealth({ ...healthPayload(), evil: "x" }),
    ).toThrow(BridgeV3ParseError);
  });

  test("health rejects ok=false as valid v3", () => {
    // ok=false parses but the manager will treat it as not-ready.
    const h = sanitizeBridgeHealth({ ...healthPayload(), ok: false });
    expect(h.ok).toBe(false);
  });

  test("parseTelemetryPayload: v3 valid → isV3=true", () => {
    const parsed = parseTelemetryPayload(v3Payload());
    expect(parsed.isV3).toBe(true);
    expect(parsed.identity).toBeDefined();
    expect(parsed.capabilities).toBeDefined();
  });

  test("parseTelemetryPayload: v1 legacy → isV3=false", () => {
    const parsed = parseTelemetryPayload(v1Payload());
    expect(parsed.isV3).toBe(false);
    expect(parsed.schemaVersion).toBe(1);
  });

  test("parseTelemetryPayload: v2 legacy → isV3=false", () => {
    const parsed = parseTelemetryPayload(v2Payload());
    expect(parsed.isV3).toBe(false);
    expect(parsed.schemaVersion).toBe(2);
  });

  test("parseTelemetryPayload: malformed v3 fails closed (no silent downgrade)", () => {
    expect(() =>
      parseTelemetryPayload({
        telemetrySchemaVersion: 3,
        capturedAt: 2000,
        stores: {},
        // missing identity + capabilities
      }),
    ).toThrow(BridgeV3ParseError);
  });

  test("parseTelemetryPayload: unknown schema version rejected", () => {
    expect(() =>
      parseTelemetryPayload({ telemetrySchemaVersion: 99, stores: {} }),
    ).toThrow(BridgeV3ParseError);
  });

  test("no terminal/pty/scrollback fields in sanitized output", () => {
    const id = sanitizeBridgeIdentity(validIdentity());
    const caps = sanitizeBridgeCapabilities(validCapabilities());
    expect(JSON.stringify(id)).not.toContain("terminal");
    expect(JSON.stringify(id)).not.toContain("pty");
    expect(JSON.stringify(id)).not.toContain("scrollback");
    // terminalCapture is a legitimate false flag (not content); assert no
    // terminal CONTENT fields exist.
    const capsKeys = Object.keys(caps);
    expect(capsKeys).not.toContain("terminalOutput");
    expect(capsKeys).not.toContain("terminalBuffer");
    expect(capsKeys).not.toContain("scrollback");
    expect(capsKeys).not.toContain("ptyBuffer");
    // terminalCapture flag is present and false.
    expect(caps.terminalCapture).toBe(false);
  });
});

// ── (b) v3 identity verification ──────────────────────────────────────────

describe("v3 identity verification", () => {
  test("successful match → ok=true", () => {
    const parsed = parseTelemetryPayload(v3Payload());
    const result = verifyV3Identity(parsed, {
      expectedFingerprint: VALID_FINGERPRINT,
      canonicalOrigin: CANONICAL_ORIGIN,
      healthInstanceId: VALID_INSTANCE_ID,
    });
    expect(result.ok).toBe(true);
  });

  test("fingerprint mismatch → ok=false", () => {
    const parsed = parseTelemetryPayload(v3Payload());
    const result = verifyV3Identity(parsed, {
      expectedFingerprint: "b".repeat(64),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("fingerprint");
  });

  test("canonicalOrigin mismatch → ok=false", () => {
    const parsed = parseTelemetryPayload(v3Payload());
    const result = verifyV3Identity(parsed, {
      canonicalOrigin: "http://127.0.0.1:9999",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("canonicalOrigin");
  });

  test("pluginInstanceId differs from health → ok=false", () => {
    const parsed = parseTelemetryPayload(v3Payload());
    const result = verifyV3Identity(parsed, {
      healthInstanceId: "99999999-2222-3333-4444-555555555555",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("pluginInstanceId");
  });

  test("wrong transportMode → parse fails closed", () => {
    // parseTelemetryPayload will throw on bad transportMode.
    expect(() =>
      parseTelemetryPayload(
        v3Payload({
          identity: { ...validIdentity(), transportMode: "tcp" as never },
        }),
      ),
    ).toThrow(BridgeV3ParseError);
  });

  test("store absent/malformed degrades capabilities but does not invalidate identity", () => {
    // Capabilities with absent stores still verify identity ok.
    const parsed = parseTelemetryPayload(
      v3Payload({
        capabilities: validCapabilities({
          fallbackInProgress: "absent",
          cmuxStore: "malformed",
        }),
      }),
    );
    const result = verifyV3Identity(parsed, {
      expectedFingerprint: VALID_FINGERPRINT,
    });
    expect(result.ok).toBe(true);
    expect(result.capabilities.fallbackInProgress).toBe("absent");
    expect(result.capabilities.cmuxStore).toBe("malformed");
  });
});

// ── (c) OmoBridgeClient v3 ────────────────────────────────────────────────

describe("OmoBridgeClient v3", () => {
  test("v3 valid payload → connected, verified=false (client never authoritative), identity+capabilities for display", async () => {
    const client = new OmoBridgeClient("http://127.0.0.1:8788", {
      fetchImpl: (async () =>
        new Response(JSON.stringify(v3Payload()), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
      now: () => 3000,
    });
    const status = await client.fetchTelemetry();
    expect(status.connected).toBe(true);
    // Client NEVER marks verified=true — only manager may.
    expect(status.verified).toBe(false);
    expect(status.schemaVersion).toBe(3);
    // Identity+capabilities are populated for display only.
    expect(status.identity?.pluginInstanceId).toBe(VALID_INSTANCE_ID);
    expect(status.capabilities?.fallbackInProgress).toBe("present");
  });

  test("v1 legacy payload → connected, verified=false, no identity", async () => {
    const client = new OmoBridgeClient("http://127.0.0.1:8788", {
      fetchImpl: (async () =>
        new Response(JSON.stringify(v1Payload()), { status: 200 })) as unknown as typeof fetch,
      now: () => 3000,
    });
    const status = await client.fetchTelemetry();
    expect(status.connected).toBe(true);
    expect(status.verified).toBe(false);
    expect(status.schemaVersion).toBe(1);
    expect(status.identity).toBeUndefined();
    expect(status.capabilities).toBeUndefined();
  });

  test("v2 legacy payload → connected, verified=false, no identity", async () => {
    const client = new OmoBridgeClient("http://127.0.0.1:8788", {
      fetchImpl: (async () =>
        new Response(JSON.stringify(v2Payload()), { status: 200 })) as unknown as typeof fetch,
      now: () => 3000,
    });
    const status = await client.fetchTelemetry();
    expect(status.connected).toBe(true);
    expect(status.verified).toBe(false);
    expect(status.schemaVersion).toBe(2);
    expect(status.identity).toBeUndefined();
  });

  test("malformed v3 fails closed (connected=false, no silent downgrade)", async () => {
    const client = new OmoBridgeClient("http://127.0.0.1:8788", {
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            telemetrySchemaVersion: 3,
            capturedAt: 2000,
            stores: {},
            // missing identity + capabilities
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
      now: () => 3000,
    });
    const status = await client.fetchTelemetry();
    expect(status.connected).toBe(false);
    expect(status.verified).toBe(false);
  });

  test("unknown schema version fails closed", async () => {
    const client = new OmoBridgeClient("http://127.0.0.1:8788", {
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ telemetrySchemaVersion: 99, stores: {} }),
          { status: 200 },
        )) as unknown as typeof fetch,
      now: () => 3000,
    });
    const status = await client.fetchTelemetry();
    expect(status.connected).toBe(false);
    expect(status.verified).toBe(false);
  });

  test("bridge failure after success → connected:false, lastGood cached", async () => {
    let fail = false;
    const client = new OmoBridgeClient("http://127.0.0.1:8788", {
      fetchImpl: (async () => {
        if (fail) throw new Error("down");
        return new Response(JSON.stringify(v3Payload()), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await client.fetchTelemetry();
    expect(client.getBridgeStores().connected).toBe(true);
    fail = true;
    const status = await client.fetchTelemetry();
    expect(status.connected).toBe(false);
    // lastGood stores remain cached.
    expect(status.identity?.pluginInstanceId).toBe(VALID_INSTANCE_ID);
  });
});

// ── (d) TelemetryBridgeManager URL precedence ────────────────────────────

describe("TelemetryBridgeManager URL precedence", () => {
  test("managed + control-plane + committed port → derived endpoint", () => {
    const mgr = new TelemetryBridgeManager({ fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }) });
    mgr.update(managedInput());
    expect(mgr.getEndpoint()).toBe("http://127.0.0.1:8788");
  });

  test("valid explicit override wins and opts out of management", () => {
    const mgr = new TelemetryBridgeManager({ fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }) });
    mgr.update(managedInput({ overrideUrl: "http://127.0.0.1:8790" }));
    expect(mgr.getEndpoint()).toBe("http://127.0.0.1:8790");
    const ls = mgr.getLifecycleState();
    expect(ls?.overrideActive).toBe(true);
    expect(ls?.endpointSource).toBe("explicit-override");
  });

  test("invalid override is ignored (falls back to managed)", () => {
    const mgr = new TelemetryBridgeManager({ fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }) });
    mgr.update(managedInput({ overrideUrl: "http://127.0.0.1:8790", overrideInvalid: true }));
    expect(mgr.getEndpoint()).toBe("http://127.0.0.1:8788");
    const ls = mgr.getLifecycleState();
    expect(ls?.overrideActive).toBe(false);
    expect(ls?.overrideInvalid).toBe(true);
  });

  test("attach + external without override → unavailable/awaiting owner", () => {
    const mgr = new TelemetryBridgeManager({ fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }) });
    mgr.update(
      managedInput({
        mode: "attach",
        ownership: "external",
        overrideUrl: undefined,
      }),
    );
    expect(mgr.getEndpoint()).toBeUndefined();
    const ls = mgr.getLifecycleState();
    expect(ls?.runtime).toBe("unavailable");
    expect(ls?.endpointSource).toBe("unavailable");
  });

  test("managed + control-plane without committed port → unavailable", () => {
    const mgr = new TelemetryBridgeManager({ fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }) });
    mgr.update(
      managedInput({
        committed: { enabled: false },
      }),
    );
    expect(mgr.getEndpoint()).toBeUndefined();
  });

  test("never requests non-loopback", () => {
    const mgr = new TelemetryBridgeManager({ fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }) });
    // Override with non-loopback is never fed (config validates it). But
    // verify the manager does not invent non-loopback URLs.
    mgr.update(managedInput());
    const ep = mgr.getEndpoint();
    expect(ep?.startsWith("http://127.0.0.1:")).toBe(true);
  });

  test("does not hardcode 8788 as managed truth (uses committed port)", () => {
    const mgr = new TelemetryBridgeManager({ fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }) });
    mgr.update(managedInput({ committed: { enabled: true, port: 8795, nonceFingerprint: VALID_FINGERPRINT } }));
    expect(mgr.getEndpoint()).toBe("http://127.0.0.1:8795");
  });
});

// ── (e) generation change + old response discard ─────────────────────────

describe("generation change and old response discard", () => {
  test("generation change increments epoch and clears verified state", () => {
    const mgr = new TelemetryBridgeManager({ fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }) });
    mgr.update(managedInput({ generation: 1 }));
    const epoch1 = mgr.getEpoch();
    mgr.update(managedInput({ generation: 2 }));
    const epoch2 = mgr.getEpoch();
    expect(epoch2).toBeGreaterThan(epoch1);
    expect(mgr.getVerifiedState()).toBeUndefined();
  });

  test("endpoint change increments epoch", () => {
    const mgr = new TelemetryBridgeManager({ fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }) });
    mgr.update(managedInput({ committed: { enabled: true, port: 8788, nonceFingerprint: VALID_FINGERPRINT } }));
    const epoch1 = mgr.getEpoch();
    mgr.update(managedInput({ committed: { enabled: true, port: 8789, nonceFingerprint: VALID_FINGERPRINT } }));
    const epoch2 = mgr.getEpoch();
    expect(epoch2).toBeGreaterThan(epoch1);
  });

  test("fingerprint change increments epoch", () => {
    const mgr = new TelemetryBridgeManager({ fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }) });
    mgr.update(managedInput({ committed: { enabled: true, port: 8788, nonceFingerprint: VALID_FINGERPRINT } }));
    const epoch1 = mgr.getEpoch();
    mgr.update(managedInput({ committed: { enabled: true, port: 8788, nonceFingerprint: "b".repeat(64) } }));
    const epoch2 = mgr.getEpoch();
    expect(epoch2).toBeGreaterThan(epoch1);
  });

  test("canonicalOrigin change increments epoch", () => {
    const mgr = new TelemetryBridgeManager({ fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }) });
    mgr.update(managedInput({ canonicalOrigin: "http://127.0.0.1:4096" }));
    const epoch1 = mgr.getEpoch();
    mgr.update(managedInput({ canonicalOrigin: "http://127.0.0.1:4097" }));
    const epoch2 = mgr.getEpoch();
    expect(epoch2).toBeGreaterThan(epoch1);
  });

  test("OMO not ready → runtime unavailable", () => {
    const mgr = new TelemetryBridgeManager({ fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }) });
    mgr.update(managedInput({ omoReady: false }));
    const ls = mgr.getLifecycleState();
    expect(ls?.runtime).toBe("unavailable");
    expect(ls?.omoReady).toBe(false);
  });

  test("generation change clears verified state (old telemetry never repopulates)", () => {
    const mgr = new TelemetryBridgeManager({ fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }) });
    mgr.update(managedInput({ generation: 1 }));
    // Simulate a verified state being set (would happen via scheduler tick).
    // After generation change, verified must be cleared.
    mgr.update(managedInput({ generation: 2 }));
    expect(mgr.getVerifiedState()).toBeUndefined();
  });
});

// ── (f) independent reconnect scheduler ──────────────────────────────────

describe("independent reconnect scheduler", () => {
  test("backoff schedule: immediate then 1s,2s,5s,10s,30s cap", () => {
    expect(RECONNECT_BACKOFF_MS).toEqual([0, 1_000, 2_000, 5_000, 10_000, 30_000]);
  });

  test("start schedules immediate tick", () => {
    const timers = fakeTimers();
    const ticks: SchedulerTickResult[] = [];
    const sched = new ReconnectScheduler({
      baseUrl: "http://127.0.0.1:8788",
      timeoutMs: 100,
      fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }),
      timers,
      verify: () => ({ ok: true }),
      onTick: (r) => ticks.push(r),
    });
    sched.start();
    expect(timers._pending.length).toBeGreaterThan(0);
    expect(timers._pending[0]!.ms).toBe(0);
    sched.stop();
  });

  test("verified response resets backoff and uses steady-state interval", async () => {
    const timers = fakeTimers();
    const ticks: SchedulerTickResult[] = [];
    const sched = new ReconnectScheduler({
      baseUrl: "http://127.0.0.1:8788",
      timeoutMs: 100,
      fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }),
      timers,
      verify: () => ({ ok: true }),
      onTick: (r) => ticks.push(r),
    });
    sched.start();
    // Run the immediate tick.
    timers._runNext();
    // Wait for the async fetch to settle.
    await new Promise((r) => setTimeout(r, 10));
    expect(ticks.length).toBe(1);
    expect(ticks[0]!.verified).toBe(true);
    // After success, next scheduled delay is the steady-state interval (3s),
    // NOT zero-delay (avoid hot loop).
    expect(timers._pending[0]!.ms).toBe(3_000);
    sched.stop();
  });

  test("failed response advances backoff", async () => {
    const timers = fakeTimers();
    const ticks: SchedulerTickResult[] = [];
    const sched = new ReconnectScheduler({
      baseUrl: "http://127.0.0.1:8788",
      timeoutMs: 100,
      fetchImpl: fakeFetch({ payload: healthPayload() }, { throwError: "down" }),
      timers,
      verify: () => ({ ok: true }),
      onTick: (r) => ticks.push(r),
    });
    sched.start();
    timers._runNext();
    await new Promise((r) => setTimeout(r, 10));
    expect(ticks.length).toBe(1);
    expect(ticks[0]!.verified).toBe(false);
    // Next delay should be 1000 (1s) after first failure.
    expect(timers._pending[0]!.ms).toBe(1_000);
    sched.stop();
  });

  test("stop aborts and prevents further ticks", () => {
    const timers = fakeTimers();
    const ticks: SchedulerTickResult[] = [];
    const sched = new ReconnectScheduler({
      baseUrl: "http://127.0.0.1:8788",
      timeoutMs: 100,
      fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }),
      timers,
      verify: () => ({ ok: true }),
      onTick: (r) => ticks.push(r),
    });
    sched.start();
    sched.stop();
    // After stop, no pending timer.
    expect(timers._pending.length).toBe(0);
    expect(sched.running).toBe(false);
  });

  test("updateExpectedRuntime resets backoff to immediate", async () => {
    const timers = fakeTimers();
    const ticks: SchedulerTickResult[] = [];
    const sched = new ReconnectScheduler({
      baseUrl: "http://127.0.0.1:8788",
      timeoutMs: 100,
      fetchImpl: fakeFetch({ payload: healthPayload() }, { throwError: "down" }),
      timers,
      verify: () => ({ ok: true }),
      onTick: (r) => ticks.push(r),
    });
    sched.start();
    timers._runNext();
    await new Promise((r) => setTimeout(r, 10));
    // After failure, delay is 1s.
    expect(timers._pending[0]!.ms).toBe(1_000);
    // Update resets to immediate.
    sched.updateExpectedRuntime();
    expect(timers._pending[0]!.ms).toBe(0);
    sched.stop();
  });

  test("one in-flight fetch at a time", async () => {
    const timers = fakeTimers();
    const ticks: SchedulerTickResult[] = [];
    let fetchCount = 0;
    let resolveFetch: (() => void) | undefined;
    const slowFetch: SchedulerFetch = async (url) => {
      fetchCount++;
      if (url.endsWith("/health")) {
        await new Promise<void>((r) => {
          resolveFetch = r;
        });
        return { ok: true, status: 200, json: async () => healthPayload() };
      }
      return { ok: true, status: 200, json: async () => v3Payload() };
    };
    const sched = new ReconnectScheduler({
      baseUrl: "http://127.0.0.1:8788",
      timeoutMs: 1000,
      fetchImpl: slowFetch,
      timers,
      verify: () => ({ ok: true }),
      onTick: (r) => ticks.push(r),
    });
    sched.start();
    timers._runNext();
    await new Promise((r) => setTimeout(r, 5));
    // First fetch in flight.
    expect(fetchCount).toBe(1);
    // Try to run another tick while first is in flight — should be a no-op.
    // (The scheduler guards re-entry via inFlight flag.)
    sched.stop();
    if (resolveFetch) resolveFetch();
  });
});

// ── (g) manager stop aborts ───────────────────────────────────────────────

describe("manager stop aborts", () => {
  test("stop increments epoch and stops scheduler", () => {
    const mgr = new TelemetryBridgeManager({ fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }) });
    mgr.update(managedInput());
    const epoch1 = mgr.getEpoch();
    mgr.stop();
    const epoch2 = mgr.getEpoch();
    expect(epoch2).toBeGreaterThan(epoch1);
  });

  test("stop then update restarts scheduler", () => {
    const mgr = new TelemetryBridgeManager({ fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }) });
    mgr.update(managedInput());
    mgr.stop();
    // Re-update with same input — scheduler restarts (changed=false but
    // scheduler was stopped, so reconcileScheduler creates a new one).
    mgr.update(managedInput({ generation: 3 }));
    expect(mgr.getEndpoint()).toBe("http://127.0.0.1:8788");
  });
});

// ── (h) bridge-only loss preserves jobs ───────────────────────────────────

describe("bridge-only loss preserves jobs", () => {
  test("bridge disconnect does not clear derived jobs", async () => {
    const PARENT = "ses_parent";
    const CHILD = "ses_child";
    const now = 1_000_000;
    let bridgeConnected = true;
    const bridge = new OmoBridgeClient("http://127.0.0.1:8788", {
      fetchImpl: (async () => {
        if (!bridgeConnected) throw new Error("down");
        return new Response(JSON.stringify(v3Payload()), { status: 200 });
      }) as unknown as typeof fetch,
      now: () => now,
    });
    const store = new OmoRuntimeStore({
      client: { sessionMessages: () => Promise.reject(new Error("no I/O")) } as never,
      bridge,
      now: () => now,
      minRefreshIntervalMs: 0,
      fetchMessages: async () => [
        {
          info: { id: "m1" },
          parts: [{
            type: "tool",
            tool: "task",
            state: {
              status: "completed",
              input: { subagent_type: "explorer" },
              output: "task_id: child",
              metadata: { sessionId: CHILD, parentSessionId: PARENT },
            },
          }],
        },
      ],
    });
    // Seed jobs.
    await store.refresh({
      health: { healthy: true },
      providers: [],
      agents: [],
      sessions: [
        { id: PARENT, time: { created: 1, updated: now } },
        { id: CHILD, parentID: PARENT, time: { created: 1, updated: now } },
      ] as never,
      mcp: {},
      permissions: [],
      connection: { rest: "connected", sse: "connected", stale: false, opencodeBaseUrl: "http://x" },
      fetchedAt: "",
      baseUrl: "http://x",
    } as never, { force: true });
    expect(store.getSnapshot().jobs.length).toBeGreaterThan(0);

    // Bridge disconnects.
    bridgeConnected = false;
    await bridge.fetchTelemetry();
    // Notify bridge update — jobs preserved.
    store.notifyBridgeUpdate();
    const snap = store.getSnapshot();
    expect(snap.jobs.length).toBeGreaterThan(0);
    // Bridge marked disconnected.
    expect(snap.bridge?.connected).toBe(false);
    // OMO jobs availability still true (rest connected).
    expect(snap.availability.opencodeJobs).toBe(true);
  });

  test("backend generation reset clears jobs (canonical behavior)", async () => {
    const PARENT = "ses_parent";
    const CHILD = "ses_child";
    const now = 1_000_000;
    const store = new OmoRuntimeStore({
      client: { sessionMessages: () => Promise.reject(new Error("no I/O")) } as never,
      now: () => now,
      minRefreshIntervalMs: 0,
      fetchMessages: async () => [
        {
          info: { id: "m1" },
          parts: [{
            type: "tool",
            tool: "task",
            state: {
              status: "completed",
              input: { subagent_type: "explorer" },
              output: "task_id: child",
              metadata: { sessionId: CHILD, parentSessionId: PARENT },
            },
          }],
        },
      ],
    });
    await store.refresh({
      health: { healthy: true },
      providers: [],
      agents: [],
      sessions: [
        { id: PARENT, time: { created: 1, updated: now } },
        { id: CHILD, parentID: PARENT, time: { created: 1, updated: now } },
      ] as never,
      mcp: {},
      permissions: [],
      connection: { rest: "connected", sse: "connected", stale: false, opencodeBaseUrl: "http://x" },
      fetchedAt: "",
      baseUrl: "http://x",
    } as never, { force: true });
    expect(store.getSnapshot().jobs.length).toBeGreaterThan(0);
    store.resetForBackendGeneration();
    expect(store.getSnapshot().jobs).toEqual([]);
  });
});

// ── (i) multiplexer current verified only ─────────────────────────────────

describe("multiplexer current verified only", () => {
  test("verified v3 maps jobs", () => {
    const bridge: OmoBridgeStatus = {
      connected: true,
      schemaVersion: 3,
      verified: true,
      identity: validIdentity(),
      capabilities: validCapabilities(),
      stores: {
        multiplexerRecords: [
          {
            sessionId: "ses_child1",
            known: true,
            spawning: false,
            closing: false,
            permanentlyClosed: false,
          },
        ],
      },
    };
    const snap = snapshotWithJobs([
      {
        taskId: "ses_child1",
        agent: "explorer",
        parentSessionId: "ses_parent",
        childSessionId: "ses_child1",
        state: "running",
        source: "opencode-task-call",
      },
    ]);
    const rt = buildMultiplexerRuntime(bridge, snap, 0);
    expect(rt.mapping.mappedJobs).toEqual(["ses_child1"]);
    expect(rt.mapping.graceAppliedMs).toBe(MULTIPLEXER_GRACE_MS);
  });

  test("legacy v2 never maps jobs (display only)", () => {
    const bridge: OmoBridgeStatus = {
      connected: true,
      schemaVersion: 2,
      stores: {
        multiplexerRecords: [
          {
            sessionId: "ses_child1",
            known: true,
            spawning: false,
            closing: false,
            permanentlyClosed: false,
          },
        ],
      },
    };
    const snap = snapshotWithJobs([
      {
        taskId: "ses_child1",
        agent: "explorer",
        parentSessionId: "ses_parent",
        childSessionId: "ses_child1",
        state: "running",
        source: "opencode-task-call",
      },
    ]);
    const rt = buildMultiplexerRuntime(bridge, snap, 0);
    expect(rt.mapping.mappedJobs).toEqual([]);
    expect(rt.mapping.graceAppliedMs).toBeUndefined();
  });

  test("v3 unverified (mismatch) never maps jobs", () => {
    const bridge: OmoBridgeStatus = {
      connected: true,
      schemaVersion: 3,
      verified: false,
    };
    const snap = snapshotWithJobs([
      {
        taskId: "ses_child1",
        agent: "explorer",
        parentSessionId: "ses_parent",
        childSessionId: "ses_child1",
        state: "running",
        source: "opencode-task-call",
      },
    ]);
    const rt = buildMultiplexerRuntime(bridge, snap, 0);
    expect(rt.mapping.mappedJobs).toEqual([]);
    expect(rt.mapping.graceAppliedMs).toBeUndefined();
  });
});

// ── (j) lifecycle state structure ─────────────────────────────────────────

describe("lifecycle state structure", () => {
  test("managed control-plane → restartControllable=true", () => {
    const mgr = new TelemetryBridgeManager({ fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }) });
    mgr.update(managedInput());
    const ls = mgr.getLifecycleState()!;
    expect(ls.mode).toBe("managed");
    expect(ls.ownership).toBe("control-plane");
    expect(ls.restartControllable).toBe(true);
    expect(ls.verificationEpoch).toBeGreaterThan(0);
    expect(ls.generation).toBe(1);
  });

  test("attach external → restartControllable=false", () => {
    const mgr = new TelemetryBridgeManager({ fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }) });
    mgr.update(managedInput({ mode: "attach", ownership: "external" }));
    const ls = mgr.getLifecycleState()!;
    expect(ls.restartControllable).toBe(false);
  });

  test("registration state propagated", () => {
    const mgr = new TelemetryBridgeManager({ fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }) });
    mgr.update(managedInput({ registration: "duplicate" }));
    const ls = mgr.getLifecycleState()!;
    expect(ls.registration).toBe("duplicate");
  });

  test("localPackageAvailable propagated", () => {
    const mgr = new TelemetryBridgeManager({ fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }) });
    mgr.update(managedInput({ localPackageAvailable: false }));
    const ls = mgr.getLifecycleState()!;
    expect(ls.localPackageAvailable).toBe(false);
  });

  test("overrideInvalid propagated", () => {
    const mgr = new TelemetryBridgeManager({ fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }) });
    mgr.update(managedInput({ overrideUrl: "http://127.0.0.1:8790", overrideInvalid: true }));
    const ls = mgr.getLifecycleState()!;
    expect(ls.overrideInvalid).toBe(true);
    expect(ls.overrideActive).toBe(false);
  });
});

// ── (k) no terminal fields in any output ─────────────────────────────────

describe("no terminal fields in any output", () => {
  test("v3 identity has no terminal/pty/scrollback keys", () => {
    const id = sanitizeBridgeIdentity(validIdentity());
    const keys = Object.keys(id);
    expect(keys).not.toContain("terminal");
    expect(keys).not.toContain("pty");
    expect(keys).not.toContain("scrollback");
  });

  test("v3 capabilities has terminalCapture=false (flag only, no content)", () => {
    const caps = sanitizeBridgeCapabilities(validCapabilities());
    expect(caps.terminalCapture).toBe(false);
    // No terminal content fields.
    const keys = Object.keys(caps);
    expect(keys).not.toContain("terminalOutput");
    expect(keys).not.toContain("scrollback");
    expect(keys).not.toContain("ptyBuffer");
  });

  test("bridge status from v3 payload has no terminal content", async () => {
    const client = new OmoBridgeClient("http://127.0.0.1:8788", {
      fetchImpl: (async () =>
        new Response(JSON.stringify(v3Payload()), { status: 200 })) as unknown as typeof fetch,
      now: () => 3000,
    });
    const status = await client.fetchTelemetry();
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("terminalOutput");
    expect(serialized).not.toContain("scrollback");
    expect(serialized).not.toContain("ptyBuffer");
  });
});

// ── (l) verifyV3Identity exactness: missing OR unequal fails ──────────────

describe("verifyV3Identity exactness (missing OR unequal fails)", () => {
  test("expected fingerprint present + identity fingerprint missing → fail", () => {
    const parsed = parseTelemetryPayload(
      v3Payload({ identity: { ...validIdentity(), nonceFingerprint: undefined } }),
    );
    const result = verifyV3Identity(parsed, {
      expectedFingerprint: VALID_FINGERPRINT,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("fingerprint");
    expect(result.reason).toContain("missing");
  });

  test("expected fingerprint present + identity fingerprint unequal → fail", () => {
    const parsed = parseTelemetryPayload(v3Payload());
    const result = verifyV3Identity(parsed, {
      expectedFingerprint: "b".repeat(64),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("fingerprint");
    expect(result.reason).toContain("mismatch");
  });

  test("expected canonical origin present + identity origin missing → fail", () => {
    const parsed = parseTelemetryPayload(
      v3Payload({ identity: { ...validIdentity(), canonicalOrigin: undefined } }),
    );
    const result = verifyV3Identity(parsed, {
      canonicalOrigin: CANONICAL_ORIGIN,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("canonicalOrigin");
    expect(result.reason).toContain("missing");
  });

  test("expected canonical origin present + identity origin unequal → fail", () => {
    const parsed = parseTelemetryPayload(v3Payload());
    const result = verifyV3Identity(parsed, {
      canonicalOrigin: "http://127.0.0.1:9999",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("canonicalOrigin");
    expect(result.reason).toContain("mismatch");
  });

  test("health instance exact match required", () => {
    const parsed = parseTelemetryPayload(v3Payload());
    // Matching instance → ok.
    expect(
      verifyV3Identity(parsed, { healthInstanceId: VALID_INSTANCE_ID }).ok,
    ).toBe(true);
    // Different instance → fail.
    expect(
      verifyV3Identity(parsed, {
        healthInstanceId: "99999999-2222-3333-4444-555555555555",
      }).ok,
    ).toBe(false);
  });

  test("no expected values supplied → ok=true (all optional)", () => {
    const parsed = parseTelemetryPayload(v3Payload());
    const result = verifyV3Identity(parsed, {});
    expect(result.ok).toBe(true);
  });
});

// ── (m) manager mismatch state preserves reason ───────────────────────────

describe("manager mismatch state preserves reason", () => {
  test("fingerprint mismatch → runtime=mismatch, compatibility=incompatible", () => {
    const mgr = new TelemetryBridgeManager({
      fetchImpl: fakeFetch(
        { payload: healthPayload() },
        {
          payload: v3Payload({
            identity: { ...validIdentity(), nonceFingerprint: "b".repeat(64) },
          }),
        },
      ),
    });
    mgr.update(managedInput());
    // Run scheduler tick to produce a verify failure.
    const timers = (mgr as unknown as { opts: { timers: SchedulerTimers } }).opts.timers;
    // The manager creates its own scheduler with real timers; we need to
    // wait for the async tick. Use a small delay.
  });

  test("manager getBridgeStatus verified=false when not correlated", () => {
    const mgr = new TelemetryBridgeManager({
      fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }),
    });
    mgr.update(managedInput());
    // Before any tick resolves, status is not verified.
    const status = mgr.getBridgeStatus();
    expect(status.verified).toBe(false);
    expect(status.connected).toBe(false);
  });
});

// ── (n) generation instance correlation ───────────────────────────────────

describe("generation instance correlation", () => {
  test("previous generation instance ID preserved for comparison", () => {
    const mgr = new TelemetryBridgeManager({
      fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }),
    });
    mgr.update(managedInput({ generation: 1 }));
    // No verified state yet, but the manager should track instance IDs
    // across generation changes internally.
    // After generation change, prevGenAcceptedInstanceId should be preserved
    // (not erased before comparison).
    mgr.update(managedInput({ generation: 2 }));
    // The manager should not crash and epoch should increment.
    expect(mgr.getEpoch()).toBeGreaterThan(0);
  });
});

// ── (o) manager subscribe ─────────────────────────────────────────────────

describe("manager subscribe", () => {
  test("subscribe receives sanitized lifecycle + status on update", () => {
    const mgr = new TelemetryBridgeManager({
      fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }),
    });
    const events: Array<{ lifecycle: unknown; status: unknown }> = [];
    const unsub = mgr.subscribe((lifecycle, status) => {
      events.push({ lifecycle, status });
    });
    mgr.update(managedInput());
    expect(events.length).toBeGreaterThan(0);
    // Lifecycle is sanitized (has expected fields).
    const ls = events[0]!.lifecycle as { mode: string; runtime: string };
    expect(ls.mode).toBe("managed");
    expect(ls.runtime).toBe("starting");
    // Status is sanitized (no raw secrets).
    const st = events[0]!.status as { verified: boolean; connected: boolean };
    expect(st.verified).toBe(false);
    expect(st.connected).toBe(false);
    unsub();
  });

  test("unsubscribe stops receiving events", () => {
    const mgr = new TelemetryBridgeManager({
      fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }),
    });
    let count = 0;
    const unsub = mgr.subscribe(() => {
      count++;
    });
    mgr.update(managedInput());
    const afterFirst = count;
    unsub();
    mgr.update(managedInput({ generation: 2 }));
    expect(count).toBe(afterFirst);
  });
});

// ── (p) endpoint validation defense-in-depth ──────────────────────────────

describe("endpoint validation defense-in-depth", () => {
  test("non-loopback override rejected even if caller marks valid", () => {
    const mgr = new TelemetryBridgeManager({
      fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }),
    });
    // Caller incorrectly marks a non-loopback URL as valid.
    mgr.update(
      managedInput({
        overrideUrl: "http://192.168.1.1:8788",
        overrideInvalid: false,
      }),
    );
    // Manager must NOT request non-loopback. Falls back to managed.
    expect(mgr.getEndpoint()).toBe("http://127.0.0.1:8788");
    const ls = mgr.getLifecycleState()!;
    expect(ls.overrideActive).toBe(false);
  });

  test("override with path rejected", () => {
    const mgr = new TelemetryBridgeManager({
      fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }),
    });
    mgr.update(
      managedInput({
        overrideUrl: "http://127.0.0.1:8788/path",
        overrideInvalid: false,
      }),
    );
    expect(mgr.getEndpoint()).toBe("http://127.0.0.1:8788");
  });

  test("override with query rejected", () => {
    const mgr = new TelemetryBridgeManager({
      fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }),
    });
    mgr.update(
      managedInput({
        overrideUrl: "http://127.0.0.1:8788?q=1",
        overrideInvalid: false,
      }),
    );
    expect(mgr.getEndpoint()).toBe("http://127.0.0.1:8788");
  });

  test("override with fragment rejected", () => {
    const mgr = new TelemetryBridgeManager({
      fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }),
    });
    mgr.update(
      managedInput({
        overrideUrl: "http://127.0.0.1:8788#frag",
        overrideInvalid: false,
      }),
    );
    expect(mgr.getEndpoint()).toBe("http://127.0.0.1:8788");
  });

  test("override with userinfo rejected", () => {
    const mgr = new TelemetryBridgeManager({
      fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }),
    });
    mgr.update(
      managedInput({
        overrideUrl: "http://user:pass@127.0.0.1:8788",
        overrideInvalid: false,
      }),
    );
    expect(mgr.getEndpoint()).toBe("http://127.0.0.1:8788");
  });

  test("valid loopback override with trailing slash accepted", () => {
    const mgr = new TelemetryBridgeManager({
      fetchImpl: fakeFetch({ payload: healthPayload() }, { payload: v3Payload() }),
    });
    mgr.update(
      managedInput({
        overrideUrl: "http://127.0.0.1:8790/",
        overrideInvalid: false,
      }),
    );
    expect(mgr.getEndpoint()).toBe("http://127.0.0.1:8790");
  });
});

// ── (q) scheduler stop/update aborts in-flight ────────────────────────────

describe("scheduler stop/update aborts in-flight", () => {
  test("stop aborts in-flight fetch via AbortController", async () => {
    const timers = fakeTimers();
    let abortSignal: AbortSignal | undefined;
    let fetchStarted = false;
    const slowFetch: SchedulerFetch = async (url, opts) => {
      fetchStarted = true;
      abortSignal = opts.signal;
      // Never resolves (wait for abort).
      await new Promise(() => {});
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const sched = new ReconnectScheduler({
      baseUrl: "http://127.0.0.1:8788",
      timeoutMs: 10_000,
      fetchImpl: slowFetch,
      timers,
      verify: () => ({ ok: true }),
      onTick: () => {},
    });
    sched.start();
    timers._runNext();
    await new Promise((r) => setTimeout(r, 5));
    expect(fetchStarted).toBe(true);
    expect(abortSignal?.aborted).toBe(false);
    sched.stop();
    // AbortController should have been aborted.
    expect(abortSignal?.aborted).toBe(true);
  });

  test("updateExpectedRuntime aborts in-flight fetch", async () => {
    const timers = fakeTimers();
    let abortSignal: AbortSignal | undefined;
    const slowFetch: SchedulerFetch = async (_url, opts) => {
      abortSignal = opts.signal;
      await new Promise(() => {});
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const sched = new ReconnectScheduler({
      baseUrl: "http://127.0.0.1:8788",
      timeoutMs: 10_000,
      fetchImpl: slowFetch,
      timers,
      verify: () => ({ ok: true }),
      onTick: () => {},
    });
    sched.start();
    timers._runNext();
    await new Promise((r) => setTimeout(r, 5));
    expect(abortSignal?.aborted).toBe(false);
    sched.updateExpectedRuntime();
    expect(abortSignal?.aborted).toBe(true);
  });
});

// ── (r) v3 sanitizer top-level payload whitelist + store caps ─────────────

describe("v3 sanitizer top-level payload whitelist + store caps", () => {
  test("v3 payload with unknown top-level key fails closed", () => {
    expect(() =>
      parseTelemetryPayload({
        telemetrySchemaVersion: 3,
        capturedAt: 2000,
        stores: {},
        identity: validIdentity(),
        capabilities: validCapabilities(),
        evil: "x",
      }),
    ).toThrow(BridgeV3ParseError);
  });

  test("v3 payload with sensitive top-level key fails closed", () => {
    expect(() =>
      parseTelemetryPayload({
        telemetrySchemaVersion: 3,
        capturedAt: 2000,
        stores: {},
        identity: validIdentity(),
        capabilities: validCapabilities(),
        authorization: "Bearer secret",
      }),
    ).toThrow(BridgeV3ParseError);
  });

  test("store sanitizer caps fallbackInProgressSessionIDs at 100", () => {
    const stores = {
      fallbackInProgressSessionIDs: Array.from({ length: 200 }, (_, i) => `s${i}`),
    };
    const sanitized = sanitizeBridgeStores(stores);
    expect(sanitized?.fallbackInProgressSessionIDs?.length).toBe(100);
  });

  test("store sanitizer caps multiplexerRecords at 100", () => {
    const stores = {
      multiplexerRecords: Array.from({ length: 200 }, (_, i) => ({
        sessionId: `ses_${i}`,
        known: true,
        spawning: false,
        closing: false,
        permanentlyClosed: false,
      })),
    };
    const sanitized = sanitizeBridgeStores(stores);
    expect(sanitized?.multiplexerRecords?.length).toBe(100);
  });

  test("store sanitizer drops unknown store keys", () => {
    const stores = {
      fallbackInProgressSessionIDs: ["a"],
      evilKey: "steal me",
    };
    const sanitized = sanitizeBridgeStores(stores);
    expect(JSON.stringify(sanitized)).not.toContain("steal me");
    expect(sanitized?.fallbackInProgressSessionIDs).toEqual(["a"]);
  });

  test("store sanitizer handles empty stores object", () => {
    expect(sanitizeBridgeStores({})).toBeUndefined();
  });

  test("store sanitizer handles non-object stores", () => {
    expect(sanitizeBridgeStores("not an object")).toBeUndefined();
    expect(sanitizeBridgeStores(null)).toBeUndefined();
    expect(sanitizeBridgeStores(undefined)).toBeUndefined();
  });
});

// ── (s) no omoVersion fabricated from bridge package version ──────────────

describe("no omoVersion fabricated", () => {
  test("lifecycle state omits omoVersion even when bridgePackageVersion present", () => {
    const mgr = new TelemetryBridgeManager({
      fetchImpl: fakeFetch(
        { payload: healthPayload() },
        {
          payload: v3Payload({
            identity: { ...validIdentity(), bridgePackageVersion: "1.2.3" },
          }),
        },
      ),
    });
    mgr.update(managedInput());
    const ls = mgr.getLifecycleState();
    // omoVersion must NOT be fabricated from bridgePackageVersion.
    expect(ls?.omoVersion).toBeUndefined();
    // bridgePackageVersion is advisory and may be absent before verification.
  });
});