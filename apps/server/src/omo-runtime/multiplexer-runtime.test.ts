/**
 * Multiplexer runtime correlation tests (Slice 16, hardened Slice 17 v3).
 *
 * Tests cover:
 * - v1/v2 bridge stores: display diagnostics only (no mapping/grace)
 * - verified v3 bridge stores: authoritative mapping + grace
 * - mappings (session records, collection IDs)
 * - job mapping (OMO jobs → child session → mux record) — v3 only
 * - missing/stale/unavailable
 * - security allowlists (no env/content, no unscoped commands)
 */

import { describe, expect, test } from "bun:test";
import { buildMultiplexerRuntime, MULTIPLEXER_GRACE_MS } from "./multiplexer-runtime";
import type { OmoBridgeStatus, OmoRuntimeSnapshot } from "./types";

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

/** A verified v3 bridge status with minimal identity/capabilities. */
function verifiedV3Bridge(overrides: Partial<OmoBridgeStatus> = {}): OmoBridgeStatus {
  return {
    connected: true,
    schemaVersion: 3,
    verified: true,
    identity: {
      pluginInstanceId: "11111111-2222-3333-4444-555555555555",
      startupTimestamp: 1000,
      transportMode: "loopback-http",
      schemaVersion: 3,
      capturedAt: 2000,
    },
    capabilities: {
      fallbackInProgress: "absent",
      continuationGate: "absent",
      multiplexerManager: "present",
      cmuxStore: "absent",
      runtimePreset: false,
      workerReuse: false,
      terminalCapture: false,
    },
    ...overrides,
  };
}

describe("multiplexer runtime correlation", () => {
  test("bridge undefined → unavailable, no grace, no mapping", () => {
    const rt = buildMultiplexerRuntime(undefined, emptySnapshot(), 0);
    expect(rt.mapping.unavailable).toBe(true);
    expect(rt.mapping.graceAppliedMs).toBeUndefined();
    expect(rt.bridgeConnected).toBe(false);
    expect(rt.stores.sessions).toEqual([]);
    expect(rt.stores.cmux).toEqual([]);
    expect(rt.mapping.mappedJobs).toEqual([]);
    expect(rt.mapping.unmappedJobs).toEqual([]);
  });

  test("bridge connected v2 (legacy) → display only, no grace, no mapping", () => {
    const bridge: OmoBridgeStatus = { connected: true, schemaVersion: 2 };
    const rt = buildMultiplexerRuntime(bridge, emptySnapshot(), 0);
    expect(rt.mapping.unavailable).toBe(false);
    // Legacy v2 never gets grace (not authoritative).
    expect(rt.mapping.graceAppliedMs).toBeUndefined();
    expect(rt.bridgeSchemaVersion).toBe(2);
    // Legacy never maps jobs.
    expect(rt.mapping.mappedJobs).toEqual([]);
    expect(rt.mapping.unmappedJobs).toEqual([]);
  });

  test("bridge connected v1 (legacy) → display only, no grace, no mapping", () => {
    const bridge: OmoBridgeStatus = { connected: true, schemaVersion: 1 };
    const rt = buildMultiplexerRuntime(bridge, emptySnapshot(), 0);
    expect(rt.mapping.unavailable).toBe(false);
    expect(rt.mapping.graceAppliedMs).toBeUndefined();
    expect(rt.bridgeSchemaVersion).toBe(1);
    expect(rt.mapping.mappedJobs).toEqual([]);
    expect(rt.mapping.unmappedJobs).toEqual([]);
  });

  test("verified v3 + not stale → grace applied, authoritative mapping", () => {
    const bridge = verifiedV3Bridge();
    const rt = buildMultiplexerRuntime(bridge, emptySnapshot(), 0);
    expect(rt.mapping.unavailable).toBe(false);
    expect(rt.mapping.graceAppliedMs).toBe(MULTIPLEXER_GRACE_MS);
    expect(rt.bridgeSchemaVersion).toBe(3);
  });

  test("verified v3 + stale snapshot → no grace, mapping still authoritative", () => {
    const bridge = verifiedV3Bridge();
    const snap = { ...emptySnapshot(), stale: true };
    const rt = buildMultiplexerRuntime(bridge, snap, 0);
    expect(rt.mapping.graceAppliedMs).toBeUndefined();
    expect(rt.mapping.stale).toBe(true);
  });

  test("session records from v2 bridge stores (display diagnostics)", () => {
    const bridge: OmoBridgeStatus = {
      connected: true,
      schemaVersion: 2,
      stores: {
        multiplexerRecords: [
          {
            sessionId: "ses_1",
            paneId: "%5",
            parentSessionId: "ses_parent",
            title: "Explorer",
            known: true,
            spawning: false,
            closing: false,
            permanentlyClosed: false,
          },
        ],
      },
    };
    const rt = buildMultiplexerRuntime(bridge, emptySnapshot(), 0);
    expect(rt.stores.sessions.length).toBe(1);
    expect(rt.stores.sessions[0]!.sessionId).toBe("ses_1");
    expect(rt.stores.sessions[0]!.paneId).toBe("%5");
    expect(rt.stores.sessions[0]!.parentSessionId).toBe("ses_parent");
    expect(rt.stores.sessions[0]!.title).toBe("Explorer");
    expect(rt.stores.sessions[0]!.known).toBe(true);
    // Legacy v2 → no mapping.
    expect(rt.mapping.mappedJobs).toEqual([]);
    expect(rt.mapping.unmappedJobs).toEqual([]);
  });

  test("collection IDs normalized into session records (display)", () => {
    const bridge: OmoBridgeStatus = {
      connected: true,
      schemaVersion: 2,
      stores: {
        multiplexerRecords: [
          {
            sessionId: "ses_1",
            known: false,
            spawning: false,
            closing: false,
            permanentlyClosed: false,
          },
        ],
        multiplexerCollectionIds: {
          known: ["ses_2"],
          spawning: ["ses_3"],
          closing: ["ses_4"],
          permanentlyClosed: ["ses_5"],
        },
      },
    };
    const rt = buildMultiplexerRuntime(bridge, emptySnapshot(), 0);
    const byId = new Map(rt.stores.sessions.map((s) => [s.sessionId, s]));
    // ses_1 exists in records; ses_2-5 are collection-only
    expect(byId.get("ses_1")).toBeDefined();
    expect(byId.get("ses_2")!.known).toBe(true);
    expect(byId.get("ses_3")!.spawning).toBe(true);
    expect(byId.get("ses_4")!.closing).toBe(true);
    expect(byId.get("ses_5")!.permanentlyClosed).toBe(true);
  });

  test("OMO jobs mapped by child session ID — verified v3 only", () => {
    const bridge = verifiedV3Bridge({
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
    });
    const snap = snapshotWithJobs([
      {
        taskId: "ses_child1",
        agent: "explorer",
        parentSessionId: "ses_parent",
        childSessionId: "ses_child1",
        state: "running",
        source: "opencode-task-call",
      },
      {
        taskId: "ses_child2",
        agent: "librarian",
        parentSessionId: "ses_parent",
        childSessionId: "ses_child2",
        state: "running",
        source: "opencode-task-call",
      },
    ]);
    const rt = buildMultiplexerRuntime(bridge, snap, 0);
    expect(rt.mapping.mappedJobs).toEqual(["ses_child1"]);
    expect(rt.mapping.unmappedJobs).toEqual(["ses_child2"]);
  });

  test("OMO jobs NOT mapped for legacy v2 (display only)", () => {
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
    // Legacy v2 → no mapping.
    expect(rt.mapping.mappedJobs).toEqual([]);
    expect(rt.mapping.unmappedJobs).toEqual([]);
  });

  test("cmux records from v2 bridge stores (display)", () => {
    const bridge: OmoBridgeStatus = {
      connected: true,
      schemaVersion: 2,
      stores: {
        cmuxRecords: [
          {
            sessionId: "cmux_1",
            parentSessionId: "cmux_parent",
            paneId: "pane_1",
            title: "Agent",
            spawnState: "attached",
            lifecycle: "active",
            panePresent: true,
          },
        ],
      },
    };
    const rt = buildMultiplexerRuntime(bridge, emptySnapshot(), 0);
    expect(rt.stores.cmux.length).toBe(1);
    expect(rt.stores.cmux[0]!.sessionId).toBe("cmux_1");
    expect(rt.stores.cmux[0]!.spawnState).toBe("attached");
    expect(rt.stores.cmux[0]!.lifecycle).toBe("active");
    expect(rt.stores.cmux[0]!.panePresent).toBe(true);
  });

  test("v1 aggregate counts preserved (display)", () => {
    const bridge: OmoBridgeStatus = {
      connected: true,
      schemaVersion: 1,
      stores: {
        multiplexer: {
          sessionsCount: 2,
          knownSessionsCount: 3,
          spawningCount: 1,
          closingCount: 0,
          permanentlyClosedCount: 0,
        },
        cmux: { recordCount: 4 },
      },
    };
    const rt = buildMultiplexerRuntime(bridge, emptySnapshot(), 0);
    expect(rt.stores.counts.sessions).toBe(2);
    expect(rt.stores.counts.knownSessions).toBe(3);
    expect(rt.stores.counts.spawning).toBe(1);
    expect(rt.stores.counts.cmuxRecords).toBe(4);
  });

  test("no env/content/unscoped commands in output", () => {
    const bridge = verifiedV3Bridge({
      stores: {
        multiplexerRecords: [
          {
            sessionId: "ses_1",
            known: true,
            spawning: false,
            closing: false,
            permanentlyClosed: false,
          },
        ],
      },
    });
    const rt = buildMultiplexerRuntime(bridge, emptySnapshot(), 0);
    const serialized = JSON.stringify(rt);
    // No directory, owner, env, or content fields
    expect(serialized).not.toContain("directory");
    expect(serialized).not.toContain("owner");
    expect(serialized).not.toContain("env");
    expect(serialized).not.toContain("content");
  });

  test("unmapped jobs after grace → exposed when authoritative (v3)", () => {
    const bridge = verifiedV3Bridge();
    const snap = snapshotWithJobs([
      {
        taskId: "job_orphan",
        agent: "explorer",
        parentSessionId: "ses_parent",
        childSessionId: "ses_missing",
        state: "running",
        source: "opencode-task-call",
      },
    ]);
    const rt = buildMultiplexerRuntime(bridge, snap, 0);
    expect(rt.mapping.graceAppliedMs).toBe(MULTIPLEXER_GRACE_MS);
    expect(rt.mapping.unmappedJobs).toEqual(["job_orphan"]);
  });

  test("unmapped jobs without grace (stale v3) → still exposed but no grace flag", () => {
    const bridge = verifiedV3Bridge();
    const snap = {
      ...snapshotWithJobs([
        {
          taskId: "job_orphan",
          agent: "explorer",
          parentSessionId: "ses_parent",
          childSessionId: "ses_missing",
          state: "running",
          source: "opencode-task-call",
        },
      ]),
      stale: true,
    };
    const rt = buildMultiplexerRuntime(bridge, snap, 0);
    expect(rt.mapping.graceAppliedMs).toBeUndefined();
    expect(rt.mapping.unmappedJobs).toEqual(["job_orphan"]);
    expect(rt.mapping.stale).toBe(true);
  });

  test("v3 without verified flag → display only, no mapping", () => {
    // v3 schemaVersion but verified=false (e.g. identity mismatch).
    const bridge: OmoBridgeStatus = {
      connected: true,
      schemaVersion: 3,
      verified: false,
    };
    const snap = snapshotWithJobs([
      {
        taskId: "job_orphan",
        agent: "explorer",
        parentSessionId: "ses_parent",
        childSessionId: "ses_missing",
        state: "running",
        source: "opencode-task-call",
      },
    ]);
    const rt = buildMultiplexerRuntime(bridge, snap, 0);
    expect(rt.mapping.graceAppliedMs).toBeUndefined();
    expect(rt.mapping.mappedJobs).toEqual([]);
    expect(rt.mapping.unmappedJobs).toEqual([]);
  });
});