/**
 * ModelProbeQueue unit tests (Slice 15, Lane 5a).
 * Real engine + fully fake gateway (zero OpenCode calls); ":memory:" store.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProbeQueueSnapshot } from "@omo/shared";
import { ModelProbeEngine } from "./probe-engine";
import { ModelProbeStore } from "./probe-store";
import {
  ModelProbeQueue,
  ProbeQueueError,
  type SubmitResult,
} from "./probe-queue";
import { PROBE_MAX_PENDING } from "./constants";

const HEALTHY = { info: { role: "assistant", modelID: "m" }, parts: [{ type: "text", text: "OK" }] };

let tempRoot: string;

function makeHarness(opts: { blockPrompt?: boolean } = {}) {
  const store = new ModelProbeStore(":memory:");
  const resolvers: Array<(v: unknown) => void> = [];
  const promptStarted: string[] = [];
  const storeRef = { completedOk: true };
  const engine = new ModelProbeEngine({
    store,
    tempRoot,
    gateway: {
      isProviderConnected: () => true,
      isModelAdvertised: () => true,
      opencodeVersion: () => "1",
      createProbeSession: async () => ({ id: crypto.randomUUID() }),
      promptProbe: (gwOpts) => {
        promptStarted.push(gwOpts.sessionId);
        if (!opts.blockPrompt) return Promise.resolve(HEALTHY);
        return new Promise<{ info?: unknown; parts?: unknown }>((resolve, reject) => {
          resolvers.push(resolve as (v: unknown) => void);
          gwOpts.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      },
      abortSession: async () => true,
      deleteSession: async () => true,
    },
  });
  const restState = { connected: true };
  const queue = new ModelProbeQueue({
    engine,
    store,
    isRestConnected: () => restState.connected,
  });
  const updates: ModelProbeQueueSnapshot[] = [];
  queue.onUpdate((s) => updates.push(s));
  const settled = () =>
    new Promise<void>((resolve) => {
      const off = queue.onUpdate((s) => {
        if (s.pending.length === 0 && s.running.length === 0) {
          off();
          resolve();
        }
      });
      if (queue.snapshot().pending.length === 0 && queue.snapshot().running.length === 0) {
        off();
        resolve();
      }
    });
  const releaseNext = (v: unknown = HEALTHY) => {
    resolvers.shift()?.(v);
  };
  /** Release blocked prompts as they start until the queue fully drains. */
  const drainAll = async () => {
    let guard = 0;
    while (guard++ < 200) {
      while (resolvers.length > 0) resolvers.shift()?.(HEALTHY);
      const snap = queue.snapshot();
      if (snap.pending.length === 0 && snap.running.length === 0) return;
      await new Promise((r) => setTimeout(r, 1));
    }
    throw new Error("drainAll: never settled");
  };
  return { store, queue, engine, updates, settled, releaseNext, drainAll, promptStarted, restState, storeRef };
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "probe-queue-test-"));
});
afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("concurrency + dedupe", () => {
  test("concurrency cap 2: third stays pending until a worker frees", async () => {
    const h = makeHarness({ blockPrompt: true });
    const s1 = h.queue.submit({ providerId: "p", modelId: "a" });
    const s2 = h.queue.submit({ providerId: "p", modelId: "b" });
    const s3 = h.queue.submit({ providerId: "p", modelId: "c" });
    for (const s of [s1, s2, s3]) expect(s.status).toBe("queued");
    let snap = h.queue.snapshot();
    expect(snap.concurrency).toBe(2);
    expect(snap.running).toHaveLength(2);
    expect(snap.pending).toHaveLength(1);
    expect(snap.pending[0]?.modelId).toBe("c");

    // Release prompts as workers free; the third job is picked up in turn.
    await h.drainAll();
    snap = h.queue.snapshot();
    expect(snap.pending).toHaveLength(0);
    expect(snap.running).toHaveLength(0);
    expect(h.promptStarted.length).toBe(3);
  });

  test("active dedupe across pending+running (same key, including while running)", async () => {
    const h = makeHarness({ blockPrompt: true });
    const first = h.queue.submit({ providerId: "p", modelId: "a" });
    expect(first.status).toBe("queued");
    const dupe = h.queue.submit({ providerId: "p", modelId: "a" });
    expect(dupe.status).toBe("duplicate");
    if (first.status === "queued" && dupe.status === "duplicate") {
      expect(dupe.item.id).toBe(first.item.id);
    }
    // force does NOT bypass active dedupe
    const dupeForce = h.queue.submit({ providerId: "p", modelId: "a", force: true });
    expect(dupeForce.status).toBe("duplicate");
    await h.drainAll();
  });

  test("fresh persisted probe → skipped without force; force bypasses", async () => {
    const h = makeHarness();
    const r = {
      id: "old",
      providerId: "p",
      modelId: "fresh",
      startedAt: new Date().toISOString(),
      state: "healthy" as const,
      completedAt: new Date().toISOString(),
      latencyMs: 10,
      advertisedAtProbe: true,
      providerConnectedAtProbe: true,
    };
    h.store.insertRunning({ ...r, completedAt: undefined });
    h.store.complete(r);
    const skip: SubmitResult = h.queue.submit({ providerId: "p", modelId: "fresh" });
    expect(skip.status).toBe("skipped");
    if (skip.status === "skipped") {
      expect(skip.reason).toBe("fresh");
      expect(skip.latest.id).toBe("old");
    }
    const forced = h.queue.submit({ providerId: "p", modelId: "fresh", force: true });
    expect(forced.status).toBe("queued");
    await h.settled();
  });

  test("stale persisted probe does NOT skip", async () => {
    const h = makeHarness();
    const stale = new Date(Date.now() - 25 * 3600_000).toISOString();
    h.store.insertRunning({
      id: "old", providerId: "p", modelId: "m", startedAt: stale, state: "running",
      advertisedAtProbe: true, providerConnectedAtProbe: true,
    });
    h.store.complete({
      id: "old", providerId: "p", modelId: "m", startedAt: stale, completedAt: stale,
      state: "healthy", advertisedAtProbe: true, providerConnectedAtProbe: true,
    });
    const res = h.queue.submit({ providerId: "p", modelId: "m" });
    expect(res.status).toBe("queued");
    await h.settled();
  });
});

describe("backend generation interruption", () => {
  test("running and pending probes become OpenCode-disconnected while history remains", async () => {
    const h = makeHarness({ blockPrompt: true });
    const first = h.queue.submit({ providerId: "p", modelId: "running" });
    const second = h.queue.submit({ providerId: "p", modelId: "running-2" });
    const third = h.queue.submit({ providerId: "p", modelId: "pending" });
    expect(first.status).toBe("queued");
    expect(second.status).toBe("queued");
    expect(third.status).toBe("queued");
    while (h.promptStarted.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    h.queue.interruptForBackendChange();
    await h.settled();
    expect(h.store.latestFor("p", "running")?.state).toBe("opencode-disconnected");
    expect(h.store.latestFor("p", "running-2")?.state).toBe("opencode-disconnected");
    expect(h.store.latestFor("p", "pending")?.state).toBe("opencode-disconnected");
    expect(h.store.latestFor("p", "pending")?.errorCode).toBe("backend-generation-changed");
  });
});

describe("503 gating", () => {
  test("OpenCode REST disconnected → ProbeQueueError 503 opencode-unavailable", () => {
    const h = makeHarness();
    h.restState.connected = false;
    expect(() => h.queue.submit({ providerId: "p", modelId: "a" })).toThrow(ProbeQueueError);
    try {
      h.queue.submit({ providerId: "p", modelId: "a" });
    } catch (e) {
      expect((e as ProbeQueueError).statusCode).toBe(503);
      expect((e as ProbeQueueError).code).toBe("opencode-unavailable");
    }
  });

  test("degraded probe store → ProbeQueueError 503 probe-store-degraded", () => {
    const h = makeHarness();
    (h.store as unknown as { db: Database }).db.close();
    // The store discovers degradation on the first FAILED write (closed DB).
    h.store.insertRunning({
      id: "x", providerId: "p", modelId: "a", startedAt: new Date().toISOString(),
      state: "running", advertisedAtProbe: true, providerConnectedAtProbe: true,
    });
    expect(h.store.isHealthy()).toBe(false);
    try {
      h.queue.submit({ providerId: "p", modelId: "a" });
      expect.unreachable("submit should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ProbeQueueError);
      expect((e as ProbeQueueError).statusCode).toBe(503);
      expect((e as ProbeQueueError).code).toBe("probe-store-degraded");
    }
    void h;
  });
});

describe("cancel", () => {
  test("pending cancel removes the job; re-cancel of it → 409", () => {
    const h = makeHarness({ blockPrompt: true });
    h.queue.submit({ providerId: "p", modelId: "w1" });
    h.queue.submit({ providerId: "p", modelId: "w2" });
    const third = h.queue.submit({ providerId: "p", modelId: "pend" });
    if (third.status !== "queued") throw new Error("expected queued");
    expect(h.queue.snapshot().pending.map((j) => j.modelId)).toEqual(["pend"]);
    const res = h.queue.cancel(third.item.id);
    expect(res.ok).toBe(true);
    expect(h.queue.snapshot().pending).toHaveLength(0);
    const again = h.queue.cancel(third.item.id);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.status).toBe(409);
  });

  test("running cancel → aborted terminal (engine termination routine)", async () => {
    const h = makeHarness({ blockPrompt: true });
    const first = h.queue.submit({ providerId: "p", modelId: "run1" });
    if (first.status !== "queued") throw new Error("expected queued");
    // Wait until the engine actually started prompting.
    while (h.promptStarted.length === 0) await new Promise((r) => setTimeout(r, 0));
    const res = h.queue.cancel(first.item.id);
    expect(res.ok).toBe(true);
    await h.settled();
    const hist = h.store.historyFor("p", "run1");
    expect(hist).toHaveLength(1);
    expect(hist[0]?.state).toBe("error");
    expect(hist[0]?.errorCode).toBe("aborted");
  });

  test("terminal cancel → 409; unknown id → 404", async () => {
    const h = makeHarness();
    const done = h.queue.submit({ providerId: "p", modelId: "done" });
    if (done.status !== "queued") throw new Error("expected queued");
    await h.settled();
    const c1 = h.queue.cancel(done.item.id);
    expect(c1.ok).toBe(false);
    if (!c1.ok) expect(c1.status).toBe(409);
    const c2 = h.queue.cancel("never-existed");
    expect(c2.ok).toBe(false);
    if (!c2.ok) expect(c2.status).toBe(404);
  });
});

describe("batch", () => {
  test("server-side dedupe within batch AND against the live queue", async () => {
    const h = makeHarness({ blockPrompt: true });
    h.queue.submit({ providerId: "p", modelId: "live" });
    const result = h.queue.submitBatch([
      { providerId: "p", modelId: "b1" },
      { providerId: "p", modelId: "b1" }, // in-batch dupe
      { providerId: "p", modelId: "live" }, // dupe against live queue
      { providerId: "p", modelId: "b2" },
    ]);
    expect(result.accepted.map((a) => a.modelId).sort()).toEqual(["b1", "b2"]);
    expect(result.deduped).toHaveLength(2);
    expect(result.deduped.some((d) => d.modelId === "live")).toBe(true);
    expect(result.queue.pending.length + result.queue.running.length).toBe(3);
    // cleanup
    await h.drainAll();
  });

  test("skipRecentlyTested default behavior: fresh skips ONLY when enabled; force overrides", async () => {
    const h = makeHarness();
    const fresh = new Date().toISOString();
    h.store.insertRunning({
      id: "f1", providerId: "p", modelId: "fresh", startedAt: fresh, state: "running",
      advertisedAtProbe: true, providerConnectedAtProbe: true,
    });
    h.store.complete({
      id: "f1", providerId: "p", modelId: "fresh", startedAt: fresh, completedAt: fresh,
      state: "healthy", advertisedAtProbe: true, providerConnectedAtProbe: true,
    });
    // Default (no skipRecentlyTested): accepted despite being fresh.
    const def = h.queue.submitBatch([{ providerId: "p", modelId: "fresh" }]);
    expect(def.accepted).toHaveLength(1);
    expect(def.skipped).toHaveLength(0);
    await h.settled();
    // Enabled: skipped as fresh.
    const skip = h.queue.submitBatch([{ providerId: "p", modelId: "fresh" }], { skipRecentlyTested: true });
    expect(skip.skipped).toHaveLength(1);
    expect(skip.skipped[0]?.reason).toBe("fresh");
    expect(skip.accepted).toHaveLength(0);
    // Force overrides skipRecentlyTested.
    const force = h.queue.submitBatch([{ providerId: "p", modelId: "fresh" }], {
      skipRecentlyTested: true,
      force: true,
    });
    expect(force.accepted).toHaveLength(1);
    await h.settled();
  });

  test("pending overflow → skipped with reason queue-full (no throw)", () => {
    const h = makeHarness({ blockPrompt: true });
    // 2 workers block; fill pending to PROBE_MAX_PENDING.
    for (let i = 0; i < PROBE_MAX_PENDING + 2; i++) {
      h.queue.submit({ providerId: "p", modelId: `m${i}` });
    }
    expect(h.queue.snapshot().pending).toHaveLength(PROBE_MAX_PENDING);
    const result = h.queue.submitBatch([
      { providerId: "p", modelId: "extra" },
    ]);
    expect(result.accepted).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe("queue-full");
  });
});

describe("onUpdate", () => {
  test("fires with a snapshot on submit and on completion", async () => {
    const h = makeHarness();
    h.queue.submit({ providerId: "p", modelId: "a" });
    await h.settled();
    expect(h.updates.length).toBeGreaterThanOrEqual(2);
    // Every emitted snapshot is a coherent DTO copy.
    const first = h.updates[0]!;
    const hasItem = [...first.pending, ...first.running].some((j) => j.modelId === "a");
    expect(hasItem).toBe(true);
    const last = h.updates[h.updates.length - 1]!;
    expect(last.pending).toHaveLength(0);
    expect(last.running).toHaveLength(0);
  });
});
