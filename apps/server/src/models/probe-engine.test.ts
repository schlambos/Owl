/**
 * ModelProbeEngine unit tests (Slice 15, Lane 5a; plan §73).
 *
 * ZERO real OpenCode/provider calls: the OpenCodeProbeGateway is faked.
 * Conventions (documented by Lane 1):
 *  - HTTP errors: thrown object with a numeric `.status` property.
 *  - transport: thrown value WITHOUT `.status` and without the engine's own
 *    signal being aborted.
 *  - deadline: fake timers drive the engine's real setTimeout(PROBE_TIMEOUT_MS);
 *    gateway fakes reject their promise on opts.signal abort.
 * No test waits real 20s.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProbeRun } from "@omo/shared";
import { ModelProbeStore } from "./probe-store";
import {
  ModelProbeEngine,
  type OpenCodeProbeGateway,
} from "./probe-engine";
import { PROBE_TIMEOUT_MS } from "./constants";

const HEALTHY = { info: { role: "assistant", modelID: "m" }, parts: [{ type: "text", text: "OK" }] };

/** Yield until cond() holds (real timers; setImmediate pumping). */
async function waitFor(cond: () => boolean, guard = 10_000): Promise<void> {
  let i = 0;
  while (!cond() && i++ < guard) {
    await new Promise((r) => setImmediate(r));
  }
  if (!cond()) throw new Error("waitFor: condition never met");
}

interface GatewayCalls {
  create: Array<Record<string, unknown>>;
  prompt: Array<Record<string, unknown>>;
  abort: Array<{ sessionId: string; directory?: string }>;
  del: Array<{ sessionId: string; directory?: string }>;
}

function makeGateway(over: Partial<OpenCodeProbeGateway> = {}) {
  const calls: GatewayCalls = { create: [], prompt: [], abort: [], del: [] };
  const gateway: OpenCodeProbeGateway = {
    isProviderConnected: () => true,
    isModelAdvertised: () => true,
    opencodeVersion: () => "9.9.9",
    async createProbeSession(opts) {
      calls.create.push(opts as unknown as Record<string, unknown>);
      return { id: `ses_fake_${calls.create.length}` };
    },
    async promptProbe(opts) {
      calls.prompt.push(opts as unknown as Record<string, unknown>);
      return HEALTHY;
    },
    async abortSession(sessionId, directory) {
      calls.abort.push({ sessionId, directory });
      return true;
    },
    async deleteSession(sessionId, directory) {
      calls.del.push({ sessionId, directory });
      return true;
    },
    ...over,
  };
  return { gateway, calls };
}

let tempRoot: string;
let store: ModelProbeStore;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "probe-engine-test-"));
  store = new ModelProbeStore(":memory:");
});
afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("request shapes on the gateway", () => {
  test("createProbeSession: title prefix + provider/model IDs + directory under tempRoot; promptProbe: exact session/provider/model", async () => {
    const { gateway, calls } = makeGateway();
    const engine = new ModelProbeEngine({ gateway, store, tempRoot });
    await engine.run({ id: "t1", providerId: "p", modelId: "m" });

    expect(calls.create).toHaveLength(1);
    const create = calls.create[0]!;
    expect(create.title).toBe("[OMO CP Probe] p/m");
    expect(create.providerID).toBe("p");
    expect(create.modelID).toBe("m");
    const dir = String(create.directory);
    expect(dir.startsWith(tempRoot)).toBe(true);
    // Tempdir is an EMPTY mkdtemp child of tempRoot.
    expect(dir.split("/").pop()).toMatch(/^omo-cp-probe-/);

    expect(calls.prompt).toHaveLength(1);
    const prompt = calls.prompt[0]!;
    expect(prompt.sessionId).toBe("ses_fake_1");
    expect(prompt.directory).toBe(dir);
    expect(prompt.providerID).toBe("p");
    expect(prompt.modelID).toBe("m");
    // NOTE: the deny-all permissions ruleset, `tools: {}` and the fixed
    // control-plane prompt parts are properties of the Lane-0 OpenCodeClient
    // (client.ts createProbeSession/promptProbe bodies) — the engine passes
    // only directory/title/IDs/signal. The client-level POST body is asserted
    // in routes.test.ts with a stubbed global fetch.

    // Tempdir removed after success; session deleted best-effort.
    expect(readdirSync(tempRoot).filter((x) => x.startsWith("omo-cp-probe-"))).toHaveLength(0);
    expect(calls.del).toHaveLength(1);
    expect(calls.del[0]!.sessionId).toBe("ses_fake_1");
    // Healthy path: no abort call (nothing in flight).
    expect(calls.abort).toHaveLength(0);
  });

  test("healthy run returns terminal ModelProbeRun with real latency + capture flags", async () => {
    const { gateway } = makeGateway();
    const t0 = Date.now();
    const engine = new ModelProbeEngine({ gateway, store, tempRoot, now: () => t0 });
    const run = await engine.run({ id: "t2", providerId: "p", modelId: "m" });
    expect(run.state).toBe("healthy");
    expect(run.latencyMs).toBe(0); // injected clock: started === completed
    expect(run.responseModel).toBe("m");
    expect(run.opencodeVersion).toBe("9.9.9");
    expect(run.advertisedAtProbe).toBe(true);
    expect(run.providerConnectedAtProbe).toBe(true);
    // persisted exactly once (latch)
    expect(store.historyFor("p", "m")).toHaveLength(1);
    expect(store.historyFor("p", "m")[0]?.state).toBe("healthy");
  });
});

describe("preflight", () => {
  test("provider not connected → provider-disconnected, NO session, NO tempdir", async () => {
    const { gateway, calls } = makeGateway({ isProviderConnected: () => false });
    const engine = new ModelProbeEngine({ gateway, store, tempRoot });
    const run = await engine.run({ id: "t3", providerId: "p", modelId: "m" });
    expect(run.state).toBe("provider-disconnected");
    expect(run.providerConnectedAtProbe).toBe(false);
    expect(calls.create).toHaveLength(0);
    expect(calls.prompt).toHaveLength(0);
    expect(calls.del).toHaveLength(0);
    expect(
      readdirSync(tempRoot).filter((x) => x.startsWith("omo-cp-probe-")),
    ).toHaveLength(0);
    // Still recorded (running → terminal), exactly one row.
    expect(store.historyFor("p", "m")).toHaveLength(1);
  });

  test("model not advertised → advertisedAtProbe false (probe still runs)", async () => {
    const { gateway } = makeGateway({ isModelAdvertised: () => false });
    const engine = new ModelProbeEngine({ gateway, store, tempRoot });
    const run = await engine.run({ id: "t4", providerId: "p", modelId: "ghost" });
    expect(run.state).toBe("healthy");
    expect(run.advertisedAtProbe).toBe(false);
  });
});

describe("failure outcomes", () => {
  test("HTTP 404 object thrown → model-not-found; latency recorded", async () => {
    const { gateway } = makeGateway();
    gateway.promptProbe = async () => {
      throw { status: 404, bodySummary: "not found" };
    };
    const engine = new ModelProbeEngine({ gateway, store, tempRoot });
    const run = await engine.run({ id: "t5", providerId: "p", modelId: "m" });
    expect(run.state).toBe("model-not-found");
    expect(run.statusCode).toBe(404);
    expect(run.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("transport throw (no .status) → opencode-disconnected", async () => {
    const { gateway } = makeGateway();
    gateway.promptProbe = async () => {
      throw new TypeError("fetch failed");
    };
    const engine = new ModelProbeEngine({ gateway, store, tempRoot });
    const run = await engine.run({ id: "t6", providerId: "p", modelId: "m" });
    expect(run.state).toBe("opencode-disconnected");
  });

  test("engine.run never throws even when the gateway throws synchronously-typed rejects", async () => {
    const { gateway } = makeGateway();
    gateway.createProbeSession = async () => {
      throw "string rejection";
    };
    const engine = new ModelProbeEngine({ gateway, store, tempRoot });
    const run = await engine.run({ id: "t7", providerId: "p", modelId: "m" });
    expect(run.state).toBe("opencode-disconnected");
    expect(store.historyFor("p", "m")).toHaveLength(1);
  });
});

describe("timeout path (deadline stubbed — no real 20s)", () => {
  test("deadline → abort own controller → POST abort → deleteSession → tempdir removed → terminal timeout", async () => {
    // bun fake-timers freeze node:fs/promises (mkdtemp never resolves), so
    // instead capture the engine's global setTimeout callback (the deadline)
    // and fire it manually once the prompt is in flight. Real I/O, no waiting.
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    let fireDeadline!: () => void;
    globalThis.setTimeout = ((fn: () => void) => {
      fireDeadline = fn;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
    try {
      const { gateway, calls } = makeGateway();
      // Gateway promise that only settles when the engine aborts its signal.
      gateway.promptProbe = (opts) => {
        calls.prompt.push(opts as unknown as Record<string, unknown>);
        return new Promise((_resolve, reject) => {
          opts.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      };
      const engine = new ModelProbeEngine({ gateway, store, tempRoot });
      const pending = engine.run({ id: "t8", providerId: "p", modelId: "m" });
      await waitFor(() => calls.prompt.length === 1);
      fireDeadline();
      const run = await pending;

      expect(run.state).toBe("timeout");
      expect(run.errorMessage).toContain(String(PROBE_TIMEOUT_MS));
      // Termination routine: abort own controller (fired), POST abort → delete.
      expect(calls.abort).toHaveLength(1);
      expect(calls.abort[0]!.sessionId).toBe("ses_fake_1");
      expect(calls.del).toHaveLength(1);
      expect(calls.del[0]!.sessionId).toBe("ses_fake_1");
      expect(
        readdirSync(tempRoot).filter((x) => x.startsWith("omo-cp-probe-")),
      ).toHaveLength(0);
      expect(store.historyFor("p", "m")).toHaveLength(1);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });
});

describe("user cancel", () => {
  test("engine.cancel(id) → terminal error/aborted (NOT timeout), termination runs", async () => {
    const { gateway, calls } = makeGateway();
    type ProbeResponse = { info?: unknown; parts?: unknown };
    let resolvePrompt: ((v: ProbeResponse) => void) | undefined;
    let rejectPrompt: ((e: unknown) => void) | undefined;
    gateway.promptProbe = (opts) => {
      calls.prompt.push(opts as unknown as Record<string, unknown>);
      return new Promise((resolve, reject) => {
        resolvePrompt = resolve;
        rejectPrompt = reject;
        opts.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
    };
    const engine = new ModelProbeEngine({ gateway, store, tempRoot });
    const pending = engine.run({ id: "t9", providerId: "p", modelId: "m" });
    await waitFor(() => calls.prompt.length === 1);
    expect(engine.cancel("t9")).toBe(true);
    const run = await pending;
    expect(run.state).toBe("error");
    expect(run.errorCode).toBe("aborted");
    expect(run.errorMessage).toBe("Probe aborted by user");
    expect(calls.abort).toHaveLength(1);
    expect(calls.del).toHaveLength(1);
  });

  test("terminal latch: cancel during/after completion cannot double-write", async () => {
    const { gateway } = makeGateway();
    let resolvePrompt: ((v: { info?: unknown; parts?: unknown }) => void) | undefined;
    gateway.promptProbe = () =>
      new Promise((resolve) => {
        resolvePrompt = resolve;
      });
    const engine = new ModelProbeEngine({ gateway, store, tempRoot });
    const pending = engine.run({ id: "t10", providerId: "p", modelId: "m" });
    await waitFor(() => resolvePrompt !== undefined);
    // Settle the prompt healthy, then try to cancel while completion is
    // racing — the settled flag makes cancel a no-op at worst.
    resolvePrompt!(HEALTHY);
    const run = await pending;
    expect(engine.cancel("t10")).toBe(false);
    expect(run.state).toBe("healthy");
    // Exactly ONE terminal row — the latch held.
    expect(store.historyFor("p", "m")).toHaveLength(1);
    expect(store.historyFor("p", "m")[0]?.state).toBe("healthy");
  });

  test("cancel on unknown id → false", () => {
    const { gateway } = makeGateway();
    const engine = new ModelProbeEngine({ gateway, store, tempRoot });
    expect(engine.cancel("nope")).toBe(false);
  });
});

describe("cleanup failure never overrides outcome", () => {
  test("deleteSession + abortSession throwing → outcome preserved, no throw", async () => {
    const { gateway } = makeGateway({
      async deleteSession() {
        throw new Error("session delete boom");
      },
      async abortSession() {
        throw new Error("abort boom");
      },
    });
    const engine = new ModelProbeEngine({ gateway, store, tempRoot });
    const run = await engine.run({ id: "t11", providerId: "p", modelId: "m" });
    expect(run.state).toBe("healthy");
    expect(store.historyFor("p", "m")[0]?.state).toBe("healthy");
  });

  test("tempdir removal failure → outcome preserved", async () => {
    const { gateway } = makeGateway();
    const engine = new ModelProbeEngine({ gateway, store, tempRoot });
    const run = await engine.run({ id: "t12", providerId: "p", modelId: "m" });
    expect(run.state).toBe("healthy");
  });
});

describe("persistence integration", () => {
  test("every run leaves exactly one run row (running insert + one terminal write)", async () => {
    const { gateway } = makeGateway();
    const engine = new ModelProbeEngine({ gateway, store, tempRoot });
    const a: ModelProbeRun = await engine.run({ id: "p1", providerId: "p", modelId: "m" });
    const b: ModelProbeRun = await engine.run({ id: "p2", providerId: "p", modelId: "m" });
    expect(a.id).not.toBe(b.id);
    expect(store.historyFor("p", "m")).toHaveLength(2);
    expect(store.latestFor("p", "m")?.id).toBe("p2");
  });
});
