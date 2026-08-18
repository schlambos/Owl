/**
 * Model routes unit tests (Slice 15, Lane 5a).
 * handleModelRequest with fully fake deps — no real server, no OpenCode.
 * Tail block: client-level createProbeSession POST body via stubbed global fetch.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type {
  ModelAvailabilityDetail,
  ModelInventoryDto,
  ModelProbeQueueSnapshot,
  ModelProbeRun,
} from "@omo/shared";
import { handleModelRequest, type ModelRouteDeps } from "./routes";
import {
  ModelProbeQueue,
  ProbeQueueError,
  type BatchResult,
  type SubmitResult,
} from "./probe-queue";
import { OpenCodeClient } from "../opencode/client";

const Q: ModelProbeQueueSnapshot = { concurrency: 2, pending: [], running: [] };

const BASE_INVENTORY: ModelInventoryDto = {
  generatedAt: "2026-08-12T00:00:00.000Z",
  models: [
    {
      providerId: "openai",
      modelId: "gpt-x/y",
      configured: true,
      provider: { known: true, connected: true },
      advertised: true,
      probe: { state: "never", freshness: "never" },
      capabilities: { state: "partial", source: "opencode:/config/providers" },
      lastUpdatedAt: "2026-08-12T00:00:00.000Z",
      usage: [],
    },
    {
      providerId: "ghost-prov",
      modelId: "old-model",
      configured: true,
      provider: { known: false, connected: false },
      advertised: false,
      probe: { state: "healthy", freshness: "fresh", lastCompletedAt: "2026-08-12T00:00:00.000Z" },
      capabilities: { state: "unknown", source: "none" },
      lastUpdatedAt: "2026-08-12T00:00:00.000Z",
      usage: [
        { kind: "agent-primary", ownerId: "fixer", label: "fixer", active: true, fallback: false },
      ],
    },
  ],
  providers: [],
  queue: Q,
};

class FakeQueue {
  submitCalls: Array<{ providerId: string; modelId: string; force?: boolean }> = [];
  nextSubmit: SubmitResult = { status: "queued", item: { id: "q1", providerId: "p", modelId: "m", state: "pending", enqueuedAt: "x" } };
  submitError: ProbeQueueError | undefined;
  nextBatch: BatchResult = { accepted: [], skipped: [], deduped: [], queue: Q };
  nextCancel: { ok: true } | { ok: false; status: 404 | 409; error: string } = { ok: true };

  submit(spec: { providerId: string; modelId: string; force?: boolean }): SubmitResult {
    this.submitCalls.push(spec);
    if (this.submitError) throw this.submitError;
    return this.nextSubmit;
  }
  submitBatch(): BatchResult {
    return this.nextBatch;
  }
  cancel() {
    return this.nextCancel;
  }
  snapshot(): ModelProbeQueueSnapshot {
    return Q;
  }
}

function deps(over: Partial<ModelRouteDeps> = {}) {
  const queue = new FakeQueue();
  const d: ModelRouteDeps = {
    getInventory: async () => BASE_INVENTORY,
    getDetail: async (providerId, modelId) => {
      const availability = BASE_INVENTORY.models.find(
        (m) => m.providerId === providerId && m.modelId === modelId,
      );
      return availability
        ? ({ availability, history: [] } satisfies ModelAvailabilityDetail)
        : undefined;
    },
    getHistory: (providerId, modelId, limit) => [
      {
        id: "r1",
        providerId,
        modelId,
        startedAt: "2026-08-12T00:00:00.000Z",
        completedAt: "2026-08-12T00:00:01.000Z",
        state: "healthy",
        advertisedAtProbe: true,
        providerConnectedAtProbe: true,
      } satisfies ModelProbeRun,
    ].slice(0, limit),
    queue: queue as unknown as ModelProbeQueue,
    store: {} as ModelRouteDeps["store"],
    ...over,
  };
  return { d, queue };
}

function req(path: string, method = "GET", body?: unknown): Request {
  return new Request(`http://cp${path}`, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
      : {}),
  });
}

describe("routing", () => {
  test("non-model paths → undefined (chain continues)", async () => {
    const { d } = deps();
    expect(await handleModelRequest(req("/api/agents"), new URL("http://cp/api/agents"), d)).toBeUndefined();
    expect(await handleModelRequest(req("/api/model"), new URL("http://cp/api/model"), d)).toBeUndefined();
  });

  test("GET /api/models → inventory DTO", async () => {
    const { d } = deps();
    const res = await handleModelRequest(req("/api/models"), new URL("http://cp/api/models"), d);
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as ModelInventoryDto;
    expect(body.generatedAt).toBe("2026-08-12T00:00:00.000Z");
    expect(body.models).toHaveLength(2);
    expect(body.queue).toEqual(Q);
  });

  test("slash-containing model IDs: encoded %2F segments decode correctly (detail + probes + cancel)", async () => {
    const { d } = deps();
    const encoded = encodeURIComponent("gpt-x/y"); // gpt-x%2Fy
    const detail = await handleModelRequest(
      req(`/api/models/openai/${encoded}`),
      new URL(`http://cp/api/models/openai/${encoded}`),
      d,
    );
    expect(detail?.status).toBe(200);
    const db = (await detail!.json()) as ModelAvailabilityDetail;
    expect(db.availability.modelId).toBe("gpt-x/y");
    expect(db.availability.providerId).toBe("openai");

    const probes = await handleModelRequest(
      req(`/api/models/openai/${encoded}/probes`),
      new URL(`http://cp/api/models/openai/${encoded}/probes`),
      d,
    );
    expect(probes?.status).toBe(200);
    const pb = (await probes!.json()) as { providerId: string; modelId: string; probes: ModelProbeRun[] };
    expect(pb.providerId).toBe("openai");
    expect(pb.modelId).toBe("gpt-x/y");
    expect(pb.probes[0]?.id).toBe("r1");
  });

  test("GET detail for referenced-but-unadvertised model → advertised:false", async () => {
    const { d } = deps();
    const res = await handleModelRequest(
      req("/api/models/ghost-prov/old-model"),
      new URL("http://cp/api/models/ghost-prov/old-model"),
      d,
    );
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as ModelAvailabilityDetail;
    expect(body.availability.advertised).toBe(false);
    expect(body.availability.configured).toBe(true);
    expect(body.availability.capabilities.state).toBe("unknown");
  });

  test("GET detail for unknown model → 404", async () => {
    const { d } = deps();
    const res = await handleModelRequest(
      req("/api/models/nope/nada"),
      new URL("http://cp/api/models/nope/nada"),
      d,
    );
    expect(res?.status).toBe(404);
  });
});

describe("POST /api/models/probe", () => {
  test("queued result → 202 with item + queue snapshot", async () => {
    const { d } = deps();
    const res = await handleModelRequest(
      req("/api/models/probe", "POST", { providerId: "p", modelId: "m", force: true }),
      new URL("http://cp/api/models/probe"),
      d,
    );
    expect(res?.status).toBe(202);
    const b = (await res!.json()) as { queued: boolean; item: { id: string } };
    expect(b.queued).toBe(true);
    expect(b.item.id).toBe("q1");
  });

  test("strict body: extra / prompt-ish fields → 400", async () => {
    const { d, queue } = deps();
    for (const bad of [
      { providerId: "p", modelId: "m", prompt: "hack" },
      { providerId: "p", modelId: "m", text: "say hi" },
      { providerId: "p", modelId: "m", parts: [] },
      { providerId: "p", modelId: "m", messages: [] },
      { modelId: "m" },
      { providerId: "", modelId: "m" },
      { providerId: "p", modelId: 42 },
      { providerId: "p", modelId: "m", force: "yes" },
      "not-an-object",
    ]) {
      const res = await handleModelRequest(
        req("/api/models/probe", "POST", bad),
        new URL("http://cp/api/models/probe"),
        d,
      );
      expect(res?.status).toBe(400);
    }
    expect(queue.submitCalls).toHaveLength(0);
  });

  test("invalid JSON → 400", async () => {
    const { d } = deps();
    const r = new Request("http://cp/api/models/probe", { method: "POST", body: "{nope" });
    const res = await handleModelRequest(r, new URL("http://cp/api/models/probe"), d);
    expect(res?.status).toBe(400);
  });

  test("fresh-skip → 200 {skipped:'fresh'}; duplicate → 200 {duplicate:true}", async () => {
    const { d, queue } = deps();
    queue.nextSubmit = {
      status: "skipped",
      reason: "fresh",
      latest: {
        id: "r9", providerId: "p", modelId: "m", startedAt: "x", state: "healthy",
        advertisedAtProbe: true, providerConnectedAtProbe: true,
      },
    };
    let res = await handleModelRequest(
      req("/api/models/probe", "POST", { providerId: "p", modelId: "m" }),
      new URL("http://cp/api/models/probe"),
      d,
    );
    expect(res?.status).toBe(200);
    expect(((await res!.json()) as { skipped: string }).skipped).toBe("fresh");

    queue.nextSubmit = { status: "duplicate", item: { id: "q9", providerId: "p", modelId: "m", state: "running", enqueuedAt: "x" } };
    res = await handleModelRequest(
      req("/api/models/probe", "POST", { providerId: "p", modelId: "m" }),
      new URL("http://cp/api/models/probe"),
      d,
    );
    expect(((await res!.json()) as { duplicate: boolean }).duplicate).toBe(true);
  });

  test("503 surfaces (opencode-unavailable / probe-store-degraded)", async () => {
    const { d, queue } = deps();
    queue.submitError = new ProbeQueueError(503, "opencode-unavailable", "down");
    const res = await handleModelRequest(
      req("/api/models/probe", "POST", { providerId: "p", modelId: "m" }),
      new URL("http://cp/api/models/probe"),
      d,
    );
    expect(res?.status).toBe(503);
    const b = (await res!.json()) as { code: string };
    expect(b.code).toBe("opencode-unavailable");
  });
});

describe("POST /api/models/probe-batch guards", () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ providerId: "p", modelId: `m${i}` }));

  test(">100 → 400", async () => {
    const { d } = deps();
    const res = await handleModelRequest(
      req("/api/models/probe-batch", "POST", { models: mk(101), force: true, acknowledgeLargeBatch: true }),
      new URL("http://cp/api/models/probe-batch"),
      d,
    );
    expect(res?.status).toBe(400);
  });

  test("26–100 without force+acknowledgeLargeBatch → 400 (either missing)", async () => {
    const { d } = deps();
    for (const body of [
      { models: mk(26) },
      { models: mk(26), force: true },
      { models: mk(26), acknowledgeLargeBatch: true },
    ]) {
      const res = await handleModelRequest(
        req("/api/models/probe-batch", "POST", body),
        new URL("http://cp/api/models/probe-batch"),
        d,
      );
      expect(res?.status).toBe(400);
    }
  });

  test("26–100 with force:true AND acknowledgeLargeBatch:true → 202", async () => {
    const { d, queue } = deps();
    queue.nextBatch = {
      accepted: mk(26).map((m, i) => ({ id: `q${i}`, ...m, state: "pending" as const, enqueuedAt: "x" })),
      skipped: [],
      deduped: [],
      queue: Q,
    };
    const res = await handleModelRequest(
      req("/api/models/probe-batch", "POST", { models: mk(26), force: true, acknowledgeLargeBatch: true }),
      new URL("http://cp/api/models/probe-batch"),
      d,
    );
    expect(res?.status).toBe(202);
    const b = (await res!.json()) as BatchResult;
    expect(b.accepted).toHaveLength(26);
  });

  test("≤25 normal → 202 when accepted; no-mutation fields rejected", async () => {
    const { d, queue } = deps();
    queue.nextBatch = {
      accepted: [{ id: "q0", providerId: "p", modelId: "m0", state: "pending", enqueuedAt: "x" }],
      skipped: [],
      deduped: [],
      queue: Q,
    };
    const res = await handleModelRequest(
      req("/api/models/probe-batch", "POST", { models: [{ providerId: "p", modelId: "m0" }] }),
      new URL("http://cp/api/models/probe-batch"),
      d,
    );
    expect(res?.status).toBe(202);

    const bad = await handleModelRequest(
      req("/api/models/probe-batch", "POST", { models: [{ providerId: "p", modelId: "m0", prompt: "x" }] }),
      new URL("http://cp/api/models/probe-batch"),
      d,
    );
    expect(bad?.status).toBe(400);
  });

  test("batch empty-accepted → 200", async () => {
    const { d, queue } = deps();
    queue.nextBatch = { accepted: [], skipped: [], deduped: [], queue: Q };
    const res = await handleModelRequest(
      req("/api/models/probe-batch", "POST", { models: [{ providerId: "p", modelId: "m0" }] }),
      new URL("http://cp/api/models/probe-batch"),
      d,
    );
    expect(res?.status).toBe(200);
  });
});

describe("POST /api/models/probes/:id/cancel", () => {
  test("success → 200 with queue snapshot; 404 / 409 surfaced", async () => {
    const { d, queue } = deps();
    let res = await handleModelRequest(
      req("/api/models/probes/q1/cancel", "POST"),
      new URL("http://cp/api/models/probes/q1/cancel"),
      d,
    );
    expect(res?.status).toBe(200);
    expect(((await res!.json()) as { queue: ModelProbeQueueSnapshot }).queue).toEqual(Q);

    queue.nextCancel = { ok: false, status: 404, error: "Unknown probe id" };
    res = await handleModelRequest(
      req("/api/models/probes/nope/cancel", "POST"),
      new URL("http://cp/api/models/probes/nope/cancel"),
      d,
    );
    expect(res?.status).toBe(404);

    queue.nextCancel = { ok: false, status: 409, error: "Probe already completed" };
    res = await handleModelRequest(
      req("/api/models/probes/done/cancel", "POST"),
      new URL("http://cp/api/models/probes/done/cancel"),
      d,
    );
    expect(res?.status).toBe(409);
  });
});

// ── Client-level POST body (stubbed global fetch — no server) ────────────
// The engine passes only directory/title/IDs/signal to the gateway; the
// deny-all permissions ruleset, fixed probe prompt, `tools: {}` and the
// control-plane metadata tag are properties of the Lane-0 OpenCodeClient.

describe("OpenCodeClient probe bodies (stubbed fetch)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("createProbeSession POSTs deny-all ruleset + metadata tag + title + no project fields", async () => {
    const posts: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "ses_probe1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const client = new OpenCodeClient("http://opencode.local");
    const session = await client.createProbeSession({
      directory: "/tmp/omo-cp-probe-xyz",
      title: "[OMO CP Probe] openai/gpt-x",
      providerID: "openai",
      modelID: "gpt-x",
    });
    expect(session.id).toBe("ses_probe1");
    expect(posts).toHaveLength(1);
    const p = posts[0]!;
    expect(p.url).toBe("http://opencode.local/session?directory=%2Ftmp%2Fomo-cp-probe-xyz");
    expect(p.init?.method).toBe("POST");
    const body = JSON.parse(String(p.init?.body)) as Record<string, unknown>;
    expect(body.title).toBe("[OMO CP Probe] openai/gpt-x");
    expect(body.model).toEqual({ providerID: "openai", id: "gpt-x" });
    expect(body.metadata).toEqual({ "omo.control-plane.probe": true });
    expect(body.permission).toEqual([
      { permission: "*", pattern: "*", action: "deny" },
    ]);
    // No project-config fields leak into a probe session.
    expect("agent" in body).toBe(false);
    expect("prompt" in body).toBe(false);
    expect("parts" in body).toBe(false);
  });

  test("promptProbe POSTs fixed control-plane prompt + tools:{} + model ids", async () => {
    const posts: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({ url: String(url), init });
      return new Response(
        JSON.stringify({ info: { role: "assistant", modelID: "gpt-x" }, parts: [{ type: "text", text: "OK" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const client = new OpenCodeClient("http://opencode.local/");
    const out = await client.promptProbe({
      directory: "/tmp/d",
      sessionId: "ses_probe1",
      providerID: "openai",
      modelID: "gpt-x",
    });
    expect((out.info as { role: string }).role).toBe("assistant");
    const p = posts[0]!;
    expect(p.url).toContain("/session/ses_probe1/message?directory=%2Ftmp%2Fd");
    const body = JSON.parse(String(p.init?.body)) as Record<string, unknown>;
    expect(body.model).toEqual({ providerID: "openai", modelID: "gpt-x" });
    expect(body.tools).toEqual({});
    expect(body.parts).toEqual([{ type: "text", text: "Respond with: OK" }]);
  });
});
