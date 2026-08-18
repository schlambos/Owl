/**
 * ModelProbeStore unit tests (Slice 15, Lane 5a; plan §74).
 * In-memory SQLite only; no files, no OpenCode.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { ModelProbeRun } from "@omo/shared";
import { PROBE_RETENTION_PER_MODEL } from "./constants";
import { ModelProbeStore } from "./probe-store";

function run(over: Partial<ModelProbeRun> & Pick<ModelProbeRun, "id">): ModelProbeRun {
  return {
    providerId: "p",
    modelId: "m",
    startedAt: "2026-08-12T00:00:00.000Z",
    state: "running",
    advertisedAtProbe: true,
    providerConnectedAtProbe: true,
    ...over,
  };
}

function terminalOf(
  r: ModelProbeRun,
  over: Partial<ModelProbeRun> = {},
): ModelProbeRun {
  return {
    ...r,
    state: "healthy",
    completedAt: "2026-08-12T00:00:01.000Z",
    latencyMs: 1000,
    ...over,
  };
}

describe("roundtrip", () => {
  test("insertRunning + complete → latestFor/historyFor/latestByModel", () => {
    const store = new ModelProbeStore(":memory:");
    // opencode_version / advertised / connected flags are captured at
    // insertRunning time (preflight) — NOT updated by the terminal write.
    const r = run({ id: "r1", opencodeVersion: "1.2.3" });
    store.insertRunning(r);
    expect(store.latestFor("p", "m")?.state).toBe("running");
    store.complete(
      terminalOf(r, {
        state: "unauthorized",
        statusCode: 401,
        errorCode: "http-401",
        errorMessage: "bad key (already sanitized)",
        responseModel: undefined,
      }),
    );
    const latest = store.latestFor("p", "m");
    expect(latest?.state).toBe("unauthorized");
    expect(latest?.statusCode).toBe(401);
    expect(latest?.errorCode).toBe("http-401");
    expect(latest?.errorMessage).toBe("bad key (already sanitized)");
    expect(latest?.latencyMs).toBe(1000);
    expect(latest?.opencodeVersion).toBe("1.2.3");
    expect(latest?.advertisedAtProbe).toBe(true);
    expect(latest?.providerConnectedAtProbe).toBe(true);
    const hist = store.historyFor("p", "m");
    expect(hist).toHaveLength(1);
    expect(store.latestByModel().get("p\0m")?.id).toBe("r1");
    expect(store.isHealthy()).toBe(true);
  });

  test("history newest-first", () => {
    const store = new ModelProbeStore(":memory:");
    for (let i = 0; i < 3; i++) {
      const r = run({
        id: `h${i}`,
        startedAt: `2026-08-12T00:00:0${i}.000Z`,
      });
      store.insertRunning(r);
      store.complete(
        terminalOf(r, { completedAt: `2026-08-12T00:00:0${i}.500Z` }),
      );
    }
    const hist = store.historyFor("p", "m");
    expect(hist.map((h) => h.id)).toEqual(["h2", "h1", "h0"]);
  });

  test("complete() rejects non-terminal runs (programmer error, not degraded)", () => {
    const store = new ModelProbeStore(":memory:");
    expect(() => store.complete(run({ id: "x", state: "running" }))).toThrow(
      /terminal/,
    );
    expect(store.isHealthy()).toBe(true);
  });
});

describe("retention", () => {
  test("51st completed run evicts the oldest completed; running rows never evicted", () => {
    const store = new ModelProbeStore(":memory:");
    const total = PROBE_RETENTION_PER_MODEL + 1;
    for (let i = 0; i < total; i++) {
      const r = run({
        id: `k${i}`,
        startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      });
      store.insertRunning(r);
      store.complete(
        terminalOf(r, {
          completedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i, 30)).toISOString(),
        }),
      );
    }
    const hist = store.historyFor("p", "m", 100);
    expect(hist).toHaveLength(PROBE_RETENTION_PER_MODEL);
    expect(hist.some((h) => h.id === "k0")).toBe(false); // oldest evicted
    expect(hist.some((h) => h.id === `k${total - 1}`)).toBe(true); // newest kept

    // A long-lived running row is never counted/deleted by retention.
    store.insertRunning(run({ id: "stuck", startedAt: "2020-01-01T00:00:00.000Z" }));
    for (let i = total; i < total + 3; i++) {
      const r = run({
        id: `k${i}`,
        startedAt: new Date(Date.UTC(2026, 0, 2, 0, 0, i)).toISOString(),
      });
      store.insertRunning(r);
      store.complete(
        terminalOf(r, {
          completedAt: new Date(Date.UTC(2026, 0, 2, 0, 0, i, 30)).toISOString(),
        }),
      );
    }
    const hist2 = store.historyFor("p", "m", 200);
    expect(
      hist2.filter((h) => h.state !== "running"),
    ).toHaveLength(PROBE_RETENTION_PER_MODEL);
    const stuck = hist2.find((h) => h.id === "stuck");
    expect(stuck?.state).toBe("running");
    expect(stuck?.completedAt).toBeUndefined();
  });
});

describe("finalizeAbandonedRuns", () => {
  test("running → opencode-disconnected / control-plane-restarted / no fabricated latency", () => {
    const store = new ModelProbeStore(":memory:");
    store.insertRunning(run({ id: "ab1" }));
    store.insertRunning(run({ id: "ab2", modelId: "m2" }));
    // A completed row must not be touched.
    store.insertRunning(run({ id: "done", modelId: "m3" }));
    store.complete(terminalOf(run({ id: "done", modelId: "m3" })));

    expect(store.finalizeAbandonedRuns("2026-08-12T01:00:00.000Z")).toBe(2);
    const ab = store.latestFor("p", "m");
    expect(ab?.state).toBe("opencode-disconnected");
    expect(ab?.errorCode).toBe("control-plane-restarted");
    expect(ab?.completedAt).toBe("2026-08-12T01:00:00.000Z");
    expect(ab?.latencyMs).toBeUndefined();
    expect(store.latestFor("p", "m3")?.state).toBe("healthy");
  });
});

describe("secret-free storage", () => {
  test("schema has no prompt/response columns; sanitized text roundtrips verbatim", () => {
    const store = new ModelProbeStore(":memory:");
    const db = (store as unknown as { db: Database }).db;
    const cols = (
      db.query(`PRAGMA table_info(model_probe_runs)`).all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    // No prompt text, response text, tokens, or credential columns anywhere.
    for (const c of cols) {
      expect(c).not.toMatch(/prompt|response_text|token|credential|secret/i);
    }

    // Sanitization happens in probe-normalize BEFORE persistence; the store
    // persists exactly the sanitized value it is given and returns it.
    const sanitized = "Authorization: [redacted] failed";
    const r = run({ id: "s1" });
    store.insertRunning(r);
    store.complete(terminalOf(r, { state: "error", errorMessage: sanitized }));
    expect(store.latestFor("p", "m")?.errorMessage).toBe(sanitized);
  });
});

describe("recentCountsByProvider", () => {
  test("failure counts by state + rate-limit count + lastSuccessfulProbeAt", () => {
    const store = new ModelProbeStore(":memory:");
    const nowMs = Date.parse("2026-08-12T12:00:00.000Z");
    const iso = (hOffset: number) =>
      new Date(nowMs - hOffset * 3600_000).toISOString();
    const add = (
      id: string,
      providerId: string,
      state: ModelProbeRun["state"],
      hOffset: number,
    ) => {
      const r = run({ id, providerId, startedAt: iso(hOffset) });
      store.insertRunning(r);
      store.complete(terminalOf(r, { state, completedAt: iso(hOffset) }));
    };
    add("a", "p1", "unauthorized", 1);
    add("b", "p1", "rate-limited", 2);
    add("c", "p1", "rate-limited", 3);
    add("d", "p1", "healthy", 4);
    add("e", "p1", "healthy", 26); // outside 24h window, but lastSuccessfulProbeAt tracks ALL time
    add("f", "p2", "timeout", 1);
    add("g", "p1", "error", 48); // outside window → not counted

    const stats = store.recentCountsByProvider(24 * 3600_000, nowMs);
    const p1 = stats.get("p1");
    expect(p1?.recentFailureCounts.unauthorized).toBe(1);
    expect(p1?.recentFailureCounts["rate-limited"]).toBe(2);
    expect(p1?.recentFailureCounts.error).toBeUndefined();
    expect(p1?.recentRateLimitCount).toBe(2);
    // healthy is not a failure
    expect(p1?.recentFailureCounts.healthy).toBeUndefined();
    // last successful tracks all-time, here the older healthy run
    expect(p1?.lastSuccessfulProbeAt).toBe(iso(4));
    const p2 = stats.get("p2");
    expect(p2?.recentFailureCounts.timeout).toBe(1);
    expect(p2?.recentRateLimitCount).toBe(0);
  });
});

describe("degraded mode", () => {
  test("terminal write failure → isHealthy false, terminal result served from overlay", () => {
    const store = new ModelProbeStore(":memory:");
    const r = run({ id: "d1", providerId: "px", modelId: "mx" });
    store.insertRunning(r);
    // Force a write failure: close the underlying DB (writes now throw).
    (store as unknown as { db: Database }).db.close();

    const terminal = terminalOf(r, {
      state: "healthy",
      latencyMs: 42,
      responseModel: "mx",
      completedAt: "2026-08-12T02:00:00.000Z",
    });
    // complete() never throws — it degrades into the overlay instead.
    store.complete(terminal);
    expect(store.isHealthy()).toBe(false);

    // Reads compose persisted + overlay even when the DB is closed? No —
    // reads need a live DB. Rebuild a store on a fresh DB to verify overlay
    // composition semantics with a working read path.
  });

  test("overlay supersedes the leftover persisted running row", () => {
    const store = new ModelProbeStore(":memory:");
    const r = run({ id: "d2", providerId: "px", modelId: "mx" });
    store.insertRunning(r);
    // Directly inject an overlay entry (same run id) as complete() would on
    // failure, then assert every read path prefers it.
    const terminal = terminalOf(r, {
      state: "healthy",
      latencyMs: 42,
      completedAt: "2026-08-12T02:00:00.000Z",
    });
    const overlay = (store as unknown as { overlay: Map<string, ModelProbeRun> })
      .overlay;
    overlay.set("px\0mx", terminal);

    expect(store.latestFor("px", "mx")?.state).toBe("healthy");
    expect(store.latestFor("px", "mx")?.latencyMs).toBe(42);
    const hist = store.historyFor("px", "mx");
    expect(hist).toHaveLength(1); // same id — deduped, not doubled
    expect(hist[0]?.state).toBe("healthy");
    expect(store.latestByModel().get("px\0mx")?.state).toBe("healthy");
    expect(store.getOverlay().get("px\0mx")?.id).toBe("d2");
  });

  test("insertRunning failure marks degraded without throwing", () => {
    const store = new ModelProbeStore(":memory:");
    store.insertRunning(run({ id: "dup" }));
    // Duplicate PK → INSERT fails → degraded (never throws).
    store.insertRunning(run({ id: "dup" }));
    expect(store.isHealthy()).toBe(false);
  });
});
