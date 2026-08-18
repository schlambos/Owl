/**
 * OMO runtime telemetry tests.
 *
 * Fixtures under apps/server/test/fixtures/omo-runtime are REAL anonymized
 * captures from GET /session/:id/message on OpenCode 127.0.0.1:4096
 * (2026-08-11), re-verified live 2026-08-12 (same part structure:
 * input keys description/prompt/subagent_type; metadata keys
 * model/parentSessionId/sessionId/truncated; time.start/end).
 *
 * Hardcoded OMO formats cite installed oh-my-opencode-slim@2.2.10
 * dist/index.js lines.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveSession, LiveSnapshot } from "@omo/shared";
import { OmoBridgeClient } from "./bridge";
import {
  extractAlias,
  parseTaskStatusOutput,
  scanMessagesForJobs,
  scanToolParts,
} from "./scan";
import {
  ALLOWED_JOB_FIELDS,
  assertNoDisallowedFields,
  assertNoSensitiveKeys,
  capSummary,
  RESULT_SUMMARY_MAX,
  sanitizeJob,
  TelemetrySecurityError,
} from "./security";
import { OmoRuntimeStore, OMO_PRUNE_AFTER_MS, selectSessions } from "./store";
import {
  OMO_TELEMETRY_SCHEMA_VERSION,
  OMO_TERMINAL_STATES,
  type OmoJobState,
  type OmoRuntimeUpdatedEvent,
} from "./types";

const FIXTURES = join(import.meta.dir, "../../test/fixtures/omo-runtime");

function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf-8")) as T;
}

const PARENT = "ses_parent00000000000000000";
const CHILD_1 = "ses_child00000000000000001";
const CHILD_2 = "ses_child00000000000000002";

function liveSnapshot(
  sessions: Array<{ id: string; parentID?: string; updated?: number }>,
  connection?: Partial<LiveSnapshot["connection"]>,
): LiveSnapshot {
  const flat: LiveSession[] = sessions.map((s) => ({
    id: s.id,
    parentID: s.parentID,
    time: { created: 1, updated: s.updated ?? 1 },
  }));
  return {
    health: { healthy: true },
    providers: [],
    agents: [],
    sessions: flat,
    mcp: {},
    permissions: [],
    connection: {
      rest: "connected",
      sse: "connected",
      stale: false,
      opencodeBaseUrl: "http://x",
      ...connection,
    },
    fetchedAt: "2026-08-12T00:00:00Z",
    baseUrl: "http://x",
  };
}

function makeStore(opts: {
  sessions: Array<{ id: string; parentID?: string; updated?: number }>;
  messagesBySession?: Record<string, unknown>;
  now?: () => number;
  bridge?: OmoBridgeClient;
  connection?: Partial<LiveSnapshot["connection"]>;
  pruneAfterMs?: number;
}): OmoRuntimeStore {
  return new OmoRuntimeStore({
    // Client never used: fetchMessages override below.
    client: { sessionMessages: () => Promise.reject(new Error("no I/O in tests")) } as never,
    bridge: opts.bridge,
    now: opts.now,
    minRefreshIntervalMs: 0,
    pruneAfterMs: opts.pruneAfterMs,
    fetchMessages: async (id: string) => opts.messagesBySession?.[id] ?? [],
  });
}

// ── (a) state-enum freeze regression ───────────────────────────────────────

describe("state enum freeze", () => {
  test("OmoJobState runtime surface is exactly the installed TaskOutputState set", () => {
    // Fabricated states must never appear: the installed enum is
    // 'running' | 'completed' | 'error' | 'cancelled'
    // (src/utils/task.d.ts TaskOutputState).
    const allowed: OmoJobState[] = ["running", "completed", "error", "cancelled"];
    expect([...allowed].sort()).toEqual(["cancelled", "completed", "error", "running"]);

    // Terminal set is exactly TERMINAL_STATES (dist/index.js:25000-25004).
    expect([...OMO_TERMINAL_STATES].sort()).toEqual(["cancelled", "completed", "error"]);
    expect((OMO_TERMINAL_STATES as ReadonlySet<string>).has("reconciled")).toBe(false);
    expect((OMO_TERMINAL_STATES as ReadonlySet<string>).has("queued")).toBe(false);
  });

  test("fabricated states 'queued'/'reconciled' never parse from task output", () => {
    // 'reconciled' is an OMO-closure-only board state (dist/index.js:25225)
    // and must NEVER be emitted by this telemetry layer.
    expect(parseTaskStatusOutput(`<task id="t1" state="queued">\n</task>`)).toBeUndefined();
    expect(parseTaskStatusOutput(`<task id="t1" state="reconciled">\n</task>`)).toBeUndefined();
    expect(parseTaskStatusOutput("task_id: t1\nstate: reconciled\n")).toBeUndefined();
    expect(parseTaskStatusOutput("task_id: t1\nstate: queued\n")).toBeUndefined();
    // Sanity: valid enum values still parse.
    expect(parseTaskStatusOutput(`<task id="t1" state="running">\n</task>`)?.state).toBe("running");
  });
});

describe("backend generation invalidation", () => {
  test("clears derived jobs and marks telemetry unavailable until rebootstrap", async () => {
    const now = Date.now();
    const store = makeStore({
      sessions: [{ id: "parent", updated: now }],
      messagesBySession: {
        parent: [{
          info: { id: "m1" },
          parts: [{
            type: "tool",
            tool: "task",
            state: {
              status: "completed",
              input: { subagent_type: "explorer", description: "x" },
              output: "task_id: child",
              metadata: { sessionId: "child", parentSessionId: "parent" },
            },
          }],
        }],
      },
      now: () => now,
    });
    await store.refresh(liveSnapshot([{ id: "parent", updated: now }, { id: "child", parentID: "parent", updated: now }]));
    expect(store.getSnapshot().jobs.length).toBeGreaterThan(0);
    store.resetForBackendGeneration();
    expect(store.getSnapshot().jobs).toEqual([]);
    expect(store.getSnapshot().availability.opencodeJobs).toBe(false);
  });
});

// ── (b) output formats, timedOut, resultSummary cap ────────────────────────

describe("task status output parsing (both installed formats)", () => {
  const samples = fixture<{
    xmlCompleted: string;
    xmlError: string;
    xmlCancelled: string;
    xmlRunningPlaceholder: string;
    headerCancelled: string;
    headerTimedOutRunning: string;
    headerWithAliasNote: string;
    boardRowSample: string;
  }>("task-output-samples.json");

  test("XML format (renderRunningTaskPlaceholder / terminal wrappers)", () => {
    const done = parseTaskStatusOutput(samples.xmlCompleted)!;
    expect(done.taskID).toBe(CHILD_1);
    expect(done.state).toBe("completed");
    expect(done.timedOut).toBe(false);
    expect(done.result).toContain("Sample result body line one.");

    const err = parseTaskStatusOutput(samples.xmlError)!;
    expect(err.state).toBe("error");
    // <task_error> bodies parse through the same regex
    // (parseTaskResultFromOutput, dist/index.js:24988-24990).
    expect(err.result).toBe("Sample error body.");

    const running = parseTaskStatusOutput(samples.xmlRunningPlaceholder)!;
    expect(running.state).toBe("running");
    expect(running.timedOut).toBe(false);
  });

  test("header-line format (formatCancelledTaskStatusOutput, dist/index.js:27172-27181)", () => {
    const cancelled = parseTaskStatusOutput(samples.headerCancelled)!;
    expect(cancelled.taskID).toBe("ses_child00000000000000004");
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.result).toBe("cancelled");
  });

  test("header lines after <task_result|task_error> start are ignored (getTaskHeader, dist/index.js:24992-24997)", () => {
    const out = parseTaskStatusOutput(
      "<task_result>\nstate: completed\ntask_id: bogus\n</task_result>",
    );
    expect(out).toBeUndefined();
  });

  test("timedOut only for running + 'Timed out after Nms' (dist/index.js:24972)", () => {
    const timed = parseTaskStatusOutput(samples.headerTimedOutRunning)!;
    expect(timed.state).toBe("running");
    expect(timed.timedOut).toBe(true);

    // Same text but terminal state → never timedOut.
    const terminalText = samples.headerTimedOutRunning.replace(
      "state: running",
      "state: completed",
    );
    expect(parseTaskStatusOutput(terminalText)!.timedOut).toBe(false);
  });

  test("taskID + state are BOTH required (parseTaskStatusOutput, dist/index.js:24964-24974)", () => {
    expect(parseTaskStatusOutput("state: running")).toBeUndefined();
    expect(parseTaskStatusOutput("task_id: abc")).toBeUndefined();
    expect(parseTaskStatusOutput("")).toBeUndefined();
  });

  test("resultSummary capped at 200 chars", () => {
    const long = "x".repeat(500);
    const job = sanitizeJob({
      taskId: "t",
      agent: "explorer",
      parentSessionId: "p",
      childSessionId: "t",
      state: "completed",
      resultSummary: long,
      source: "opencode-task-call",
    });
    expect(job.resultSummary!.length).toBe(RESULT_SUMMARY_MAX);
    expect(job.resultSummary!.endsWith("…")).toBe(true);
    expect(capSummary("a\n\n  b")).toBe("a b");
  });

  test("alias extraction (board row shape, dist/index.js:25487; nextAlias, dist/index.js:25496-25503)", () => {
    expect(extractAlias(samples.boardRowSample, undefined, CHILD_1)).toBe("exp-1");
    // Unanchored: only returned when no specific taskId requested.
    expect(extractAlias(samples.boardRowSample, undefined, "ses_other")).toBeUndefined();
    expect(extractAlias(samples.boardRowSample)).toBe("exp-1");
    // Metadata alias honored when it matches the alias shape.
    expect(extractAlias(undefined, { alias: "fix-3" }, "x")).toBe("fix-3");
    expect(extractAlias(undefined, { alias: "not an alias" }, "x")).toBeUndefined();
  });
});

// ── (c) fixture launch/terminal/resume flow ────────────────────────────────

describe("fixture launch/terminal/resume flow", () => {
  const seq = fixture<{ messages: unknown[] }>("messages-sequence.json");

  test("scanMessagesForJobs + scanToolParts bucket launch/resume/status", () => {
    const res = scanMessagesForJobs(seq.messages, PARENT);
    expect(res.calls.length).toBe(3);
    expect(res.otherTools.length).toBe(0);

    const parts = scanToolParts([res]);
    // Launch part (completed terminal state → completions bucket),
    // resume-request part (input.task_id set), running part (launch bucket).
    expect(parts.resumeRequests.length).toBe(1);
    expect(parts.resumeRequests[0]!.requestedTaskId).toBe(CHILD_1);
    expect(parts.completions.length).toBe(1);
    expect(parts.completions[0]!.childSessionId).toBe(CHILD_1);
    expect(parts.launches.length).toBe(1);
    expect(parts.launches[0]!.state).toBe("running");
    // Security: description only — prompt text is never captured.
    for (const c of [...parts.launches, ...parts.resumeRequests, ...parts.completions]) {
      expect(JSON.stringify(c)).not.toContain("sample-prompt-redacted");
    }
  });

  test("store merges launch → resume-request → running into job records", async () => {
    const store = makeStore({
      sessions: [
        { id: PARENT, updated: 100 },
        { id: CHILD_1, parentID: PARENT, updated: 100 },
        { id: CHILD_2, parentID: PARENT, updated: 100 },
      ],
      messagesBySession: { [PARENT]: seq.messages },
      now: () => 1_786_500_000_000,
    });
    await store.refresh(
      liveSnapshot([
        { id: PARENT, updated: 1_786_500_000_000 },
        { id: CHILD_1, parentID: PARENT, updated: 1_786_500_000_000 },
        { id: CHILD_2, parentID: PARENT, updated: 1_786_500_000_000 },
      ]),
      { force: true },
    );

    const snap = store.getSnapshot();
    expect(snap.telemetrySchemaVersion).toBe(OMO_TELEMETRY_SCHEMA_VERSION);
    expect(snap.jobs.length).toBe(2);

    const j1 = snap.jobs.find((j) => j.taskId === CHILD_1)!;
    expect(j1.state).toBe("completed");
    expect(j1.agent).toBe("explorer");
    expect(j1.parentSessionId).toBe(PARENT);
    expect(j1.childSessionId).toBe(CHILD_1);
    // Resume observed: task_id arg on the later call equals this taskId —
    // labeled resume-requested; OMO-side reuse is NOT claimed.
    expect(j1.resumeRequested).toBe(true);
    expect(j1.resultSummary).toBe("Sample follow-up result.");
    expect(j1.launchedAt).toBe(1786493282899);
    expect(j1.completedAt).toBe(1786494300000);
    expect(j1.source).toBe("opencode-task-call");

    const j2 = snap.jobs.find((j) => j.taskId === CHILD_2)!;
    expect(j2.state).toBe("running");
    expect(j2.agent).toBe("fixer");
    expect(j2.completedAt).toBeUndefined();

    // Worker views aggregate per agent.
    const explorer = snap.workers.find((w) => w.agent === "explorer")!;
    expect(explorer.completed).toBe(1);
    expect(explorer.jobs).toEqual([CHILD_1]);

    // getJob by alias/taskId; alias absent in fixtures (board snapshots are
    // transient — see metadata-parts.json) so lookup by id only.
    expect(store.getJob(CHILD_1)?.taskId).toBe(CHILD_1);
    expect(store.getJob("nope")).toBeUndefined();
  });

  test("terminal part from real capture (task-call-part.json)", async () => {
    const cap = fixture<{ info: unknown; parts: unknown[] }>("task-call-part.json");
    const res = scanMessagesForJobs([cap], PARENT);
    expect(res.calls.length).toBe(1);
    const ev = res.calls[0]!;
    expect(ev.kind).toBe("status");
    expect(ev.state).toBe("completed");
    expect(ev.childSessionId).toBe(CHILD_1); // state.metadata.sessionId (persisted)
    expect(ev.description).toBe("Sample task description");
    expect(ev.startedAt).toBe(1786493282899);
    expect(ev.endedAt).toBe(1786493433039);
  });

  test("emits debounced omo-runtime.updated (small payload) on signature change only", async () => {
    const store = new OmoRuntimeStore({
      client: { sessionMessages: () => Promise.reject(new Error("no I/O")) } as never,
      minRefreshIntervalMs: 0,
      emitDebounceMs: 5,
      now: () => 1_786_500_000_000,
      fetchMessages: async (id: string) =>
        id === PARENT ? fixture<{ messages: unknown[] }>("messages-sequence.json").messages : [],
    });
    const events: OmoRuntimeUpdatedEvent[] = [];
    const unsub = store.subscribe((e) => events.push(e));

    const live = liveSnapshot([
      { id: PARENT, updated: 1_786_500_000_000 },
      { id: CHILD_1, parentID: PARENT, updated: 1_786_500_000_000 },
      { id: CHILD_2, parentID: PARENT, updated: 1_786_500_000_000 },
    ]);
    await store.refresh(live, { force: true });
    await new Promise((r) => setTimeout(r, 30));

    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("omo-runtime.updated");
    expect(events[0]!.jobCount).toBe(2);
    expect([...events[0]!.changed].sort()).toEqual([CHILD_1, CHILD_2]);
    expect(events[0]!.bridgeConnected).toBe(false);
    // Full snapshot is NEVER on the wire — payload keys only.
    expect(Object.keys(events[0]!).sort()).toEqual(
      ["bridgeConnected", "changed", "jobCount", "ts", "type"].sort(),
    );

    // Same signature → no further emit.
    await store.refresh(live, { force: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(events.length).toBe(1);

    unsub();
    store.dispose();
  });

  test("running placeholder part has no output/end time (task-running-part.json)", () => {
    const cap = fixture<{ info: unknown; parts: unknown[]; runningPlaceholderOutput: string }>(
      "task-running-part.json",
    );
    const res = scanMessagesForJobs([cap], PARENT);
    const ev = res.calls[0]!;
    expect(ev.state).toBe("running"); // from part state.status
    expect(ev.endedAt).toBeUndefined();
    // The placeholder output (renderRunningTaskPlaceholder,
    // dist/index.js:24927-24938) parses as running when present.
    const parsed = parseTaskStatusOutput(cap.runningPlaceholderOutput)!;
    expect(parsed.state).toBe("running");
    expect(parsed.taskID).toBe(CHILD_2);
  });
});

// ── (d) parent/child correlation, missing child, prune ─────────────────────

describe("correlation, orphan tolerance, prune", () => {
  const seq = fixture<{ messages: unknown[] }>("messages-sequence.json");
  const T0 = 1_786_500_000_000;

  test("missing child session is tolerated and surfaced via getOrphanInfo", async () => {
    let now = T0;
    const store = makeStore({
      sessions: [{ id: PARENT, updated: T0 }], // children absent
      messagesBySession: { [PARENT]: seq.messages },
      now: () => now,
    });
    await store.refresh(
      liveSnapshot([{ id: PARENT, updated: T0 }]),
      { force: true },
    );

    const snap = store.getSnapshot();
    expect(snap.jobs.length).toBe(2); // jobs survive missing child sessions
    const orphans = store.getOrphanInfo();
    expect(orphans.map((o) => o.taskId).sort()).toEqual([CHILD_1, CHILD_2]);
    expect(orphans.every((o) => o.missingSince === T0)).toBe(true);

    // Child reappears → orphan flag cleared.
    now = T0 + 10_000;
    await store.refresh(
      liveSnapshot([
        { id: PARENT, updated: T0 },
        { id: CHILD_1, parentID: PARENT, updated: T0 },
        { id: CHILD_2, parentID: PARENT, updated: T0 },
      ]),
      { force: true },
    );
    expect(store.getOrphanInfo()).toEqual([]);
  });

  test("jobs prune only after BOTH parent and child vanished >6h", async () => {
    let now = T0;
    const store = makeStore({
      sessions: [],
      messagesBySession: { [PARENT]: seq.messages },
      now: () => now,
    });
    // Seed corpus while sessions still present.
    await store.refresh(
      liveSnapshot([
        { id: PARENT, updated: T0 },
        { id: CHILD_1, parentID: PARENT, updated: T0 },
        { id: CHILD_2, parentID: PARENT, updated: T0 },
      ]),
      { force: true },
    );
    expect(store.getSnapshot().jobs.length).toBe(2);

    // Both vanish — first observation starts the clock; jobs kept.
    now = T0 + 60_000;
    await store.refresh(liveSnapshot([]), { force: true });
    expect(store.getSnapshot().jobs.length).toBe(2);

    // Just before the 6h window closes — still kept.
    now = T0 + 60_000 + OMO_PRUNE_AFTER_MS - 1;
    await store.refresh(liveSnapshot([]), { force: true });
    expect(store.getSnapshot().jobs.length).toBe(2);

    // Past the window — pruned.
    now = T0 + 60_000 + OMO_PRUNE_AFTER_MS + 1;
    await store.refresh(liveSnapshot([]), { force: true });
    expect(store.getSnapshot().jobs.length).toBe(0);
  });

  test("parent present, child absent → never pruned (only orphaned)", async () => {
    let now = T0;
    const store = makeStore({
      sessions: [],
      messagesBySession: { [PARENT]: seq.messages },
      now: () => now,
    });
    await store.refresh(
      liveSnapshot([{ id: PARENT, updated: T0 }]),
      { force: true },
    );
    now = T0 + OMO_PRUNE_AFTER_MS * 4; // way past 6h
    await store.refresh(liveSnapshot([{ id: PARENT, updated: T0 }]), { force: true });
    expect(store.getSnapshot().jobs.length).toBe(2);
  });

  test("selectSessions: 24h window + all children, hard cap by recency", () => {
    const now = 1_000_000_000;
    const flat: LiveSession[] = [
      { id: "old-root", time: { updated: now - 25 * 3600_000 } }, // outside window, no parent
      { id: "fresh-root", time: { updated: now - 1000 } },
      { id: "old-child", parentID: "old-root", time: { updated: now - 99 * 3600_000 } },
    ];
    const sel = selectSessions(flat, now, 24 * 3600_000, 40);
    expect(sel.map((s) => s.id).sort()).toEqual(["fresh-root", "old-child"]);

    // Hard cap keeps most recently updated.
    const many: LiveSession[] = Array.from({ length: 50 }, (_, i) => ({
      id: `s${i}`,
      time: { updated: now - i * 1000 },
    }));
    expect(selectSessions(many, now, 24 * 3600_000, 40).length).toBe(40);
  });
});

// ── (e) stale flags ────────────────────────────────────────────────────────

describe("stale flags", () => {
  test("stale when rest+sse both disconnected; fresh when rest connected", async () => {
    const store = makeStore({ sessions: [], now: () => 123 });
    await store.refresh(
      liveSnapshot([], { rest: "disconnected", sse: "disconnected", stale: true }),
      { force: true },
    );
    let snap = store.getSnapshot();
    expect(snap.stale).toBe(true);
    expect(snap.availability.opencodeJobs).toBe(false);

    await store.refresh(
      liveSnapshot([], { rest: "connected", sse: "disconnected", stale: true }),
      { force: true },
    );
    snap = store.getSnapshot();
    expect(snap.stale).toBe(false);
    expect(snap.availability.opencodeJobs).toBe(true);
  });

  test("snapshot before any refresh is stale with empty corpus", () => {
    const store = makeStore({ sessions: [] });
    const snap = store.getSnapshot();
    expect(snap.stale).toBe(true);
    expect(snap.jobs).toEqual([]);
    expect(snap.availability.runtimePreset).toBe(false); // ALWAYS false on 2.2.10
  });
});

// ── (f) bridge absent/present merge ────────────────────────────────────────

describe("bridge merge", () => {
  const bridgePayload = {
    telemetrySchemaVersion: 1,
    capturedAt: 1786500000000,
    stores: {
      fallbackInProgressSessionIDs: ["ses_a"],
      continuationGate: {
        attemptCounts: { msg_1: 2, msg_2: "3" }, // bridge may stringify (stores.ts:124-133)
        lastRearmIdentity: { msg_1: "id-1" },
      },
      cmux: { recordCount: 4 },
      multiplexer: {
        sessionsCount: 2,
        knownSessionsCount: 3,
        spawningCount: 0,
        closingCount: 1,
        permanentlyClosedCount: 0,
      },
      // Non-whitelisted junk must be dropped by the sanitizer.
      evil: { prompt: "steal me" },
    },
  };

  function fakeBridge(payload: unknown, opts: { fail?: boolean } = {}) {
    return new OmoBridgeClient("http://127.0.0.1:8788", {
      fetchImpl: (async () => {
        if (opts.fail) throw new Error("ECONNREFUSED");
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
      now: () => 1786500000123,
    });
  }

  test("bridge absent (unconfigured) → silently disabled, no bridge field", async () => {
    const store = makeStore({ sessions: [], bridge: new OmoBridgeClient(undefined) });
    await store.refresh(liveSnapshot([]), { force: true });
    const snap = store.getSnapshot();
    expect(snap.bridge).toBeUndefined();
    expect(snap.availability.bridge).toBe(false);
  });

  test("bridge present → stores merged exactly, schema captured", async () => {
    const bridge = fakeBridge(bridgePayload);
    const store = makeStore({ sessions: [], bridge });
    await store.refresh(liveSnapshot([]), { force: true });
    const snap = store.getSnapshot();
    expect(snap.availability.bridge).toBe(true);
    expect(snap.bridge?.connected).toBe(true);
    expect(snap.bridge?.lastSeenAt).toBe(1786500000123);
    expect(snap.bridge?.schemaVersion).toBe(1);
    expect(snap.bridge?.stores?.fallbackInProgressSessionIDs).toEqual(["ses_a"]);
    expect(snap.bridge?.stores?.continuationGate?.attemptCounts).toEqual({
      msg_1: 2,
      msg_2: "3",
    });
    expect(snap.bridge?.stores?.multiplexer).toEqual({
      sessionsCount: 2,
      knownSessionsCount: 3,
      spawningCount: 0,
      closingCount: 1,
      permanentlyClosedCount: 0,
    });
    expect(snap.bridge?.stores?.cmux).toEqual({ recordCount: 4 });
    // Junk keys dropped; nothing sensitive leaks through.
    expect(JSON.stringify(snap.bridge)).not.toContain("steal me");
  });

  test("bridge failure after success → connected:false, lastGood stores cached", async () => {
    let fail = false;
    const bridge = new OmoBridgeClient("http://127.0.0.1:8788", {
      fetchImpl: (async () => {
        if (fail) throw new Error("down");
        return new Response(JSON.stringify(bridgePayload), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await bridge.fetchTelemetry();
    expect(bridge.getBridgeStores().connected).toBe(true);

    fail = true;
    const status = await bridge.fetchTelemetry();
    expect(status.connected).toBe(false);
    // lastGood stores remain cached for display while disconnected.
    expect(status.stores?.fallbackInProgressSessionIDs).toEqual(["ses_a"]);

    // Unconfigured client never throws and reports disconnected.
    const disabled = new OmoBridgeClient(undefined);
    expect((await disabled.fetchTelemetry()).connected).toBe(false);
    expect(disabled.configured).toBe(false);
  });
});

// ── (g) security guard ─────────────────────────────────────────────────────

describe("security guard", () => {
  test("non-whitelisted fields are rejected (fail-closed)", () => {
    expect(() =>
      assertNoDisallowedFields({ taskId: "t", prompt: "secret" } as never),
    ).toThrow(TelemetrySecurityError);
    expect(() =>
      assertNoDisallowedFields({ taskId: "t", args: { prompt: "x" } } as never),
    ).toThrow(TelemetrySecurityError);
  });

  test("sensitive key names are rejected anywhere in the shape", () => {
    expect(() => assertNoSensitiveKeys({ meta: { apiKey: "x" } }, "job")).toThrow(
      TelemetrySecurityError,
    );
    expect(() => assertNoSensitiveKeys({ env: {} }, "job")).toThrow(TelemetrySecurityError);
    expect(() => assertNoSensitiveKeys({ authorization: "Bearer x" }, "job")).toThrow(
      TelemetrySecurityError,
    );
    // Whitelisted job shape passes.
    expect(() =>
      assertNoSensitiveKeys(
        { taskId: "t", state: "running", resultSummary: "ok" },
        "job",
      ),
    ).not.toThrow();
  });

  test("sanitizeJob output only ever contains whitelisted keys", () => {
    const job = sanitizeJob({
      taskId: "t",
      agent: "explorer",
      description: "d",
      parentSessionId: "p",
      childSessionId: "t",
      state: "running",
      source: "opencode-task-call",
    });
    for (const key of Object.keys(job)) {
      expect(ALLOWED_JOB_FIELDS.has(key)).toBe(true);
    }
  });

  test("snapshot jobs from fixture evidence carry no prompt text or foreign keys", async () => {
    const seq = fixture<{ messages: unknown[] }>("messages-sequence.json");
    const store = makeStore({
      sessions: [],
      messagesBySession: { [PARENT]: seq.messages },
      now: () => 1_786_500_000_000,
    });
    await store.refresh(
      liveSnapshot([
        { id: PARENT, updated: 1_786_500_000_000 },
        { id: CHILD_1, parentID: PARENT, updated: 1_786_500_000_000 },
        { id: CHILD_2, parentID: PARENT, updated: 1_786_500_000_000 },
      ]),
      { force: true },
    );
    const serialized = JSON.stringify(store.getSnapshot().jobs);
    expect(serialized).not.toContain("sample-prompt-redacted");
    for (const job of store.getSnapshot().jobs) {
      expect(() =>
        assertNoDisallowedFields(job as unknown as Record<string, unknown>),
      ).not.toThrow();
    }
  });
});

// ── (h) council metadata — verified keys only ──────────────────────────────

describe("council metadata (verified keys only)", () => {
  test("no council composition metadata key exists in installed dist — nothing is relied upon", () => {
    // Verified 2026-08-11/12 by grepping installed
    // oh-my-opencode-slim@2.2.10 dist/index.js around all council code:
    // councillors are dispatched via plain task() calls (subagent_type), and
    // the ONLY part metadata keys in the bundle are
    //   oh-my-opencode-slim.internalInitiator   (dist/index.js:25849)
    //   oh-my-opencode-slim.phaseReminder       (dist/index.js:26986)
    //   oh-my-opencode-slim.backgroundJobBoard  (dist/index.js:27258)
    // (plus Symbol.for store keys). Therefore this lane asserts no council
    // metadata handling exists here — this test freezes that decision.
    const meta = fixture<{
      transientExamplesNotPersisted: Array<{ key: string }>;
    }>("metadata-parts.json");
    const knownKeys = meta.transientExamplesNotPersisted.map((k) => k.key);
    expect(knownKeys).not.toContain(expect.stringMatching(/council/i));
  });

  test("metadata-only / transient parts never produce job evidence", () => {
    const meta = fixture<{
      persistedCompactionContinuePart: Record<string, unknown>;
    }>("metadata-parts.json");
    // A synthetic text part with metadata (compaction_continue) is not a job.
    const res = scanMessagesForJobs(
      [{ info: { role: "user", id: "m1" }, parts: [meta.persistedCompactionContinuePart] }],
      PARENT,
    );
    expect(res.calls).toEqual([]);
    expect(res.otherTools).toEqual([]);
    // Unknown/future OMO metadata keys on tool parts are ignored.
    const res2 = scanMessagesForJobs(
      [
        {
          info: { role: "assistant", id: "m2" },
          parts: [
            {
              type: "text",
              synthetic: true,
              text: "board",
              metadata: { "oh-my-opencode-slim.backgroundJobBoard": true },
            },
          ],
        },
      ],
      PARENT,
    );
    expect(res2.calls).toEqual([]);
  });

  test("cancelTask / waitForUser are observed but carry no job semantics", () => {
    const res = scanMessagesForJobs(
      [
        {
          info: { role: "assistant", id: "m3" },
          parts: [
            { type: "tool", tool: "cancelTask", id: "p1", state: { status: "completed" } },
            { type: "tool", tool: "waitForUser", id: "p2", state: { status: "running" } },
          ],
        },
      ],
      PARENT,
    );
    expect(res.calls).toEqual([]);
    expect(res.otherTools.map((t) => t.tool).sort()).toEqual(["cancelTask", "waitForUser"]);
  });
});

// ── Slice 15 §41: control-plane probe sessions never scanned as OMO jobs ──

describe("probe-session exclusion regression", () => {
  test("selectSessions excludes probe-titled and metadata-flagged sessions even without the derived flag", () => {
    const now = 1_000_000_000;
    const fresh = { created: 1, updated: now - 1000 };
    const flat: LiveSession[] = [
      { id: "keep-1", time: fresh },
      // Title-prefixed probe session, flagless (raw shape).
      { id: "probe-title", title: "[OMO CP Probe] openai/gpt-x", time: fresh },
      // Metadata-flagged probe session, flagless.
      {
        id: "probe-meta",
        title: "something else",
        time: fresh,
        metadata: { "omo.control-plane.probe": true },
      } as LiveSession & { metadata: unknown },
      // Explicit derived flag.
      { id: "probe-flag", controlPlaneProbe: true, time: fresh },
      // Child of a probe session is still just a session like any other
      // (exclusion is on the model session itself) — keep it.
      { id: "keep-child", parentID: "probe-flag", time: fresh },
    ];
    const sel = selectSessions(flat, now, 24 * 3600_000, 40);
    expect(sel.map((s) => s.id).sort()).toEqual(["keep-1", "keep-child"]);
  });
});
