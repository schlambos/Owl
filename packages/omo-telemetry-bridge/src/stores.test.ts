/**
 * Unit tests for the store readers/serializers.
 *
 * These tests intentionally import ONLY `./stores` (never `./index`) so they
 * run without any plugin runtime, node_modules, or server. Fake stores are
 * installed directly on `globalThis` under the same `Symbol.for` keys OMO
 * uses, and removed after every test.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  captureBridgeCapabilities,
  captureBridgeIdentity,
  captureTelemetrySnapshot,
  computeNonceFingerprint,
  normalizeCanonicalOrigin,
  readCmuxRecords,
  readContinuationGate,
  readCmuxSnapshot,
  readFallbackInProgressSessionIDs,
  readMultiplexerCollectionIds,
  readMultiplexerRecords,
  readMultiplexerSnapshot,
  STORE_SYMBOLS,
  TELEMETRY_SCHEMA_VERSION,
} from "./stores";

const globals = globalThis as unknown as Record<symbol, unknown>;

function setStore(symbol: symbol, value: unknown): void {
  globals[symbol] = value;
}

/** Populate all four stores with realistic, well-formed data. */
function populateAllStores(): void {
  setStore(STORE_SYMBOLS.fallbackInProgress, new Set(["sess_a", "sess_b"]));
  setStore(STORE_SYMBOLS.continuationAttemptGate, {
    attempts: new Map<string, unknown>([
      ["sess_a", 2],
      ["sess_b", "3"],
    ]),
    lastRearmIdentity: new Map<string, unknown>([["sess_a", "msg#7"]]),
    messageObjectIdentity: new WeakMap<object, unknown>(),
  });
  setStore(
    STORE_SYMBOLS.cmuxSessionStore,
    new Map<string, unknown>([["cmux-1", { session: "cmux-1" }]]),
  );
  setStore(STORE_SYMBOLS.multiplexerState, {
    sessions: new Map<string, unknown>([["m1", {}]]),
    knownSessions: new Map<string, unknown>([
      ["m1", {}],
      ["m2", {}],
    ]),
    spawningSessions: new Set(["m3"]),
    closingSessions: new Map<string, unknown>(),
    permanentlyClosedSessions: new Set<string>(),
  });
}

afterEach(() => {
  for (const symbol of Object.values(STORE_SYMBOLS)) {
    delete globals[symbol];
  }
});

describe("captureTelemetrySnapshot", () => {
  test("populated stores produce a fully sanitized snapshot", () => {
    populateAllStores();

    const snapshot = captureTelemetrySnapshot(1234);

    expect(snapshot.telemetrySchemaVersion).toBe(TELEMETRY_SCHEMA_VERSION);
    expect(snapshot.capturedAt).toBe(1234);
    expect(snapshot.stores.fallbackInProgressSessionIDs).toEqual([
      "sess_a",
      "sess_b",
    ]);
    expect(snapshot.stores.continuationGate).toEqual({
      attemptCounts: { sess_a: 2, sess_b: "3" },
      lastRearmIdentity: { sess_a: "msg#7" },
    });
    expect(snapshot.stores.cmux).toEqual({ recordCount: 1 });
    expect(snapshot.stores.multiplexer).toEqual({
      sessionsCount: 1,
      knownSessionsCount: 2,
      spawningCount: 1,
      closingCount: 0,
      permanentlyClosedCount: 0,
    });
  });

  test("missing stores omit every field without erroring", () => {
    const snapshot = captureTelemetrySnapshot(0);

    expect(snapshot.telemetrySchemaVersion).toBe(TELEMETRY_SCHEMA_VERSION);
    expect(snapshot.capturedAt).toBe(0);
    expect(snapshot.stores).toEqual({});
    expect("fallbackInProgressSessionIDs" in snapshot.stores).toBe(false);
    expect("continuationGate" in snapshot.stores).toBe(false);
    expect("cmux" in snapshot.stores).toBe(false);
    expect("multiplexer" in snapshot.stores).toBe(false);
  });

  test("capturedAt defaults to Date.now() when omitted", () => {
    const before = Date.now();
    const snapshot = captureTelemetrySnapshot();
    const after = Date.now();

    expect(snapshot.capturedAt).toBeGreaterThanOrEqual(before);
    expect(snapshot.capturedAt).toBeLessThanOrEqual(after);
  });

  test("repeated concurrent reads are stable and non-mutating", async () => {
    populateAllStores();
    const attemptsBefore = (
      globals[STORE_SYMBOLS.continuationAttemptGate] as {
        attempts: Map<unknown, unknown>;
      }
    ).attempts.size;

    const results = await Promise.all(
      Array.from({ length: 64 }, async () => captureTelemetrySnapshot(42)),
    );

    const first = results[0];
    if (!first) throw new Error("expected at least one snapshot");
    for (const result of results) {
      expect(result).toEqual(first);
    }

    // Reads must never mutate the underlying stores.
    const attemptsAfter = (
      globals[STORE_SYMBOLS.continuationAttemptGate] as {
        attempts: Map<unknown, unknown>;
      }
    ).attempts.size;
    expect(attemptsAfter).toBe(attemptsBefore);
  });
});

describe("wrong-shape stores are omitted, never crash", () => {
  test("Map where Set expected (fallback store) is omitted", () => {
    setStore(
      STORE_SYMBOLS.fallbackInProgress,
      new Map<string, unknown>([["sess_a", true]]),
    );

    expect(readFallbackInProgressSessionIDs()).toBeUndefined();
    expect(captureTelemetrySnapshot(0).stores.fallbackInProgressSessionIDs).toBeUndefined();
  });

  test("array/primitive fallback stores are omitted", () => {
    setStore(STORE_SYMBOLS.fallbackInProgress, ["sess_a"]);
    expect(readFallbackInProgressSessionIDs()).toBeUndefined();

    setStore(STORE_SYMBOLS.fallbackInProgress, "sess_a");
    expect(readFallbackInProgressSessionIDs()).toBeUndefined();
  });

  test("non-string entries inside the fallback Set are filtered", () => {
    setStore(
      STORE_SYMBOLS.fallbackInProgress,
      new Set<unknown>(["ok", 123, { id: "x" }, null, undefined]),
    );

    expect(readFallbackInProgressSessionIDs()).toEqual(["ok"]);
  });

  test("gate store that is not an object is omitted", () => {
    setStore(STORE_SYMBOLS.continuationAttemptGate, "not-an-object");
    expect(readContinuationGate()).toBeUndefined();
  });

  test("gate members that are not Maps are omitted individually", () => {
    setStore(STORE_SYMBOLS.continuationAttemptGate, {
      attempts: { sess_a: 1 }, // plain object, not a Map
      lastRearmIdentity: ["nope"], // array, not a Map
      messageObjectIdentity: new WeakMap<object, unknown>(),
    });

    expect(readContinuationGate()).toBeUndefined();
    expect(captureTelemetrySnapshot(0).stores.continuationGate).toBeUndefined();
  });

  test("gate with only a WeakMap member is omitted entirely", () => {
    setStore(STORE_SYMBOLS.continuationAttemptGate, {
      messageObjectIdentity: new WeakMap<object, unknown>(),
    });

    expect(readContinuationGate()).toBeUndefined();
  });

  test("partial gate: valid attempts Map survives, invalid member omitted", () => {
    setStore(STORE_SYMBOLS.continuationAttemptGate, {
      attempts: new Map<string, unknown>([["sess_a", 5]]),
      lastRearmIdentity: new Set(["wrong shape"]),
    });

    expect(readContinuationGate()).toEqual({
      attemptCounts: { sess_a: 5 },
    });
  });

  test("Set where Map expected (cmux store) is omitted", () => {
    setStore(STORE_SYMBOLS.cmuxSessionStore, new Set(["cmux-1"]));
    expect(readCmuxSnapshot()).toBeUndefined();
    expect(captureTelemetrySnapshot(0).stores.cmux).toBeUndefined();
  });

  test("multiplexer members with wrong shapes omit only their counts", () => {
    setStore(STORE_SYMBOLS.multiplexerState, {
      sessions: ["not", "a", "map"], // array → omitted
      knownSessions: new Map<string, unknown>([["m1", {}]]),
      spawningSessions: "nope", // string → omitted
      closingSessions: new Map<string, unknown>([["m1", {}]]),
      // permanentlyClosedSessions missing → omitted
    });

    expect(readMultiplexerSnapshot()).toEqual({
      knownSessionsCount: 1,
      closingCount: 1,
    });
  });

  test("multiplexer store with no valid members is omitted entirely", () => {
    setStore(STORE_SYMBOLS.multiplexerState, {
      sessions: 42,
      knownSessions: null,
    });

    expect(readMultiplexerSnapshot()).toBeUndefined();
    expect(captureTelemetrySnapshot(0).stores.multiplexer).toBeUndefined();
  });

  test("multiplexer store that is not an object is omitted", () => {
    setStore(STORE_SYMBOLS.multiplexerState, new Map());
    expect(readMultiplexerSnapshot()).toBeUndefined();
  });
});

describe("primitive whitelisting during serialization", () => {
  test("objects/functions/null/undefined/symbols are dropped, primitives kept", () => {
    const fnValue = () => "side effect";
    setStore(STORE_SYMBOLS.continuationAttemptGate, {
      attempts: new Map<unknown, unknown>([
        ["keep-number", 4],
        ["keep-string", "x"],
        ["bool-stringified", true],
        ["bigint-stringified", 12n],
        ["nan-stringified", Number.NaN],
        ["drop-object", { status: "waiting-for-user" }],
        ["drop-array", [1, 2]],
        ["drop-function", fnValue],
        ["drop-null", null],
        ["drop-undefined", undefined],
        ["drop-symbol", Symbol("nope")],
        [42, "non-string-key-dropped"],
      ]),
    });

    const gate = readContinuationGate();
    expect(gate).toEqual({
      attemptCounts: {
        "keep-number": 4,
        "keep-string": "x",
        "bool-stringified": "true",
        "bigint-stringified": "12",
        "nan-stringified": "NaN",
      },
    });
  });

  test("lastRearmIdentity values are stringified primitives only", () => {
    setStore(STORE_SYMBOLS.continuationAttemptGate, {
      lastRearmIdentity: new Map<unknown, unknown>([
        ["sess_a", "msg#1"],
        ["sess_b", 99],
        ["sess_c", false],
        ["sess_d", { complex: true }],
        ["sess_e", () => 1],
        [7, "non-string-key-dropped"],
      ]),
    });

    expect(readContinuationGate()).toEqual({
      lastRearmIdentity: {
        sess_a: "msg#1",
        sess_b: "99",
        sess_c: "false",
      },
    });
  });
});

describe("whitelist discipline", () => {
  test("unknown Symbol.for stores on globalThis are ignored", () => {
    const unknownKey = Symbol.for("oh-my-opencode-slim.some-future-store");
    setStore(unknownKey, new Map([["a", 1]]));
    try {
      const snapshot = captureTelemetrySnapshot(0);
      expect(snapshot.stores).toEqual({});
    } finally {
      delete globals[unknownKey];
    }
  });

  test("snapshot is JSON-serializable (no functions/symbols/undefined values)", () => {
    populateAllStores();
    setStore(STORE_SYMBOLS.continuationAttemptGate, {
      attempts: new Map<string, unknown>([
        ["keep", 1],
        ["drop", () => "x"],
      ]),
    });

    const snapshot = captureTelemetrySnapshot(5);
    const roundTripped = JSON.parse(JSON.stringify(snapshot)) as unknown;
    expect(roundTripped).toEqual(snapshot);
  });
});

// ── v2 whitelisted record readers (Slice 16) ──────────────────────────────

describe("v3 schema version", () => {
  test("TELEMETRY_SCHEMA_VERSION is 3", () => {
    expect(TELEMETRY_SCHEMA_VERSION).toBe(3);
  });
});

describe("multiplexer session-manager records (v2)", () => {
  afterEach(() => {
    for (const symbol of Object.values(STORE_SYMBOLS)) {
      delete globals[symbol];
    }
  });

  test("sessions Map with OMO-owned fields → whitelisted records", () => {
    setStore(STORE_SYMBOLS.multiplexerState, {
      sessions: new Map<string, unknown>([
        [
          "ses_1",
          {
            sessionId: "ses_1",
            paneId: "%5",
            parentId: "ses_parent",
            title: "Explorer",
            directory: "/secret",        // must NOT be exposed
            ownerInstanceId: "inst_1",   // must NOT be exposed
          },
        ],
        [
          "ses_2",
          {
            sessionId: "ses_2",
            paneId: "%6",
            parentId: "ses_parent2",
            title: "Librarian",
          },
        ],
      ]),
      knownSessions: new Map(),
      spawningSessions: new Set(["ses_2"]),
      closingSessions: new Map([["ses_1", Promise.resolve()]]),
      permanentlyClosedSessions: new Set(["ses_closed"]),
    });

    const records = readMultiplexerRecords();
    expect(records).toBeDefined();
    expect(records!.length).toBe(2);
    // Sorted by sessionId
    expect(records![0]!.sessionId).toBe("ses_1");
    expect(records![0]!.paneId).toBe("%5");
    expect(records![0]!.parentSessionId).toBe("ses_parent");
    expect(records![0]!.title).toBe("Explorer");
    expect(records![0]!.known).toBe(false);
    expect(records![0]!.spawning).toBe(false);
    expect(records![0]!.closing).toBe(true);
    expect(records![0]!.permanentlyClosed).toBe(false);
    // directory/owner NOT exposed
    expect("directory" in records![0]!).toBe(false);
    expect("ownerInstanceId" in records![0]!).toBe(false);

    expect(records![1]!.sessionId).toBe("ses_2");
    expect(records![1]!.spawning).toBe(true);
  });

  test("malformed session values are ignored", () => {
    setStore(STORE_SYMBOLS.multiplexerState, {
      sessions: new Map<string, unknown>([
        ["ses_ok", { sessionId: "ses_ok", title: "OK" }],
        ["ses_bad", "not-an-object"],
      ]),
      knownSessions: new Map(),
      spawningSessions: new Set(),
      closingSessions: new Map(),
      permanentlyClosedSessions: new Set(),
    });

    const records = readMultiplexerRecords();
    expect(records).toBeDefined();
    expect(records!.length).toBe(1);
    expect(records![0]!.sessionId).toBe("ses_ok");
  });

  test("missing sessions Map → undefined", () => {
    setStore(STORE_SYMBOLS.multiplexerState, {
      knownSessions: new Map(),
      spawningSessions: new Set(),
    });
    expect(readMultiplexerRecords()).toBeUndefined();
  });

  test("cap at 100 records", () => {
    const entries = new Map<string, unknown>();
    for (let i = 0; i < 150; i++) {
      entries.set(`ses_${String(i).padStart(3, "0")}`, {
        sessionId: `ses_${String(i).padStart(3, "0")}`,
      });
    }
    setStore(STORE_SYMBOLS.multiplexerState, {
      sessions: entries,
      knownSessions: new Map(),
      spawningSessions: new Set(),
      closingSessions: new Map(),
      permanentlyClosedSessions: new Set(),
    });
    const records = readMultiplexerRecords();
    expect(records!.length).toBe(100);
  });

  test("collection IDs without sessions records", () => {
    setStore(STORE_SYMBOLS.multiplexerState, {
      sessions: new Map<string, unknown>([
        ["ses_1", { sessionId: "ses_1" }],
      ]),
      knownSessions: new Map<string, unknown>([
        ["ses_1", {}],
        ["ses_known_only", {}],
      ]),
      spawningSessions: new Set(["ses_spawning_only"]),
      closingSessions: new Map<string, unknown>([["ses_closing_only", {}]]),
      permanentlyClosedSessions: new Set(["ses_perm_closed_only"]),
    });

    const ids = readMultiplexerCollectionIds();
    expect(ids).toBeDefined();
    // ses_1 has a sessions record → filtered out
    expect(ids!.known).toEqual(["ses_known_only"]);
    expect(ids!.spawning).toEqual(["ses_spawning_only"]);
    expect(ids!.closing).toEqual(["ses_closing_only"]);
    expect(ids!.permanentlyClosed).toEqual(["ses_perm_closed_only"]);
  });

  test("reads never mutate the store", () => {
    const sessionsMap = new Map<string, unknown>([
      ["ses_1", { sessionId: "ses_1", title: "T" }],
    ]);
    const knownMap = new Map<string, unknown>([["ses_1", {}]]);
    setStore(STORE_SYMBOLS.multiplexerState, {
      sessions: sessionsMap,
      knownSessions: knownMap,
      spawningSessions: new Set(),
      closingSessions: new Map(),
      permanentlyClosedSessions: new Set(),
    });

    const before = sessionsMap.get("ses_1");
    readMultiplexerRecords();
    readMultiplexerCollectionIds();
    const after = sessionsMap.get("ses_1");
    expect(after).toEqual(before);
    expect(sessionsMap.size).toBe(1);
    expect(knownMap.size).toBe(1);
  });
});

describe("cmux session-store records (v2)", () => {
  afterEach(() => {
    for (const symbol of Object.values(STORE_SYMBOLS)) {
      delete globals[symbol];
    }
  });

  test("cmux records with allowlist fields only", () => {
    setStore(
      STORE_SYMBOLS.cmuxSessionStore,
      new Map<string, unknown>([
        [
          "cmux_1",
          {
            session: "cmux_1",
            owner: "inst_1",          // must NOT be exposed
            parent: "cmux_parent",
            title: "Agent",
            directory: "/secret",     // must NOT be exposed
            paneId: "pane_1",
            spawnState: "attached",
            lifecycle: "active",
            lastActivityAt: 12345,    // must NOT be exposed
            activityVersion: 5,       // must NOT be exposed
          },
        ],
      ]),
    );

    const records = readCmuxRecords();
    expect(records).toBeDefined();
    expect(records!.length).toBe(1);
    expect(records![0]!.sessionId).toBe("cmux_1");
    expect(records![0]!.parentSessionId).toBe("cmux_parent");
    expect(records![0]!.paneId).toBe("pane_1");
    expect(records![0]!.title).toBe("Agent");
    expect(records![0]!.spawnState).toBe("attached");
    expect(records![0]!.lifecycle).toBe("active");
    expect(records![0]!.panePresent).toBe(true);
    // Not exposed
    expect("owner" in records![0]!).toBe(false);
    expect("directory" in records![0]!).toBe(false);
    expect("lastActivityAt" in records![0]!).toBe(false);
    expect("activityVersion" in records![0]!).toBe(false);
  });

  test("cmux record without paneId → panePresent false", () => {
    setStore(
      STORE_SYMBOLS.cmuxSessionStore,
      new Map<string, unknown>([
        [
          "cmux_2",
          {
            session: "cmux_2",
            parent: "p",
            title: "T",
            spawnState: "known",
            lifecycle: "active",
          },
        ],
      ]),
    );
    const records = readCmuxRecords();
    expect(records![0]!.panePresent).toBe(false);
    expect(records![0]!.paneId).toBeUndefined();
  });

  test("cmux record with invalid spawnState/lifecycle → skipped", () => {
    setStore(
      STORE_SYMBOLS.cmuxSessionStore,
      new Map<string, unknown>([
        [
          "cmux_bad",
          {
            session: "cmux_bad",
            parent: "p",
            spawnState: "invalid",
            lifecycle: "active",
          },
        ],
        [
          "cmux_ok",
          {
            session: "cmux_ok",
            parent: "p",
            spawnState: "spawning",
            lifecycle: "orphaned",
          },
        ],
      ]),
    );
    const records = readCmuxRecords();
    expect(records!.length).toBe(1);
    expect(records![0]!.sessionId).toBe("cmux_ok");
    expect(records![0]!.spawnState).toBe("spawning");
    expect(records![0]!.lifecycle).toBe("orphaned");
  });

  test("cmux store not a Map → undefined", () => {
    setStore(STORE_SYMBOLS.cmuxSessionStore, new Set());
    expect(readCmuxRecords()).toBeUndefined();
  });
});

describe("v2 snapshot assembly", () => {
  afterEach(() => {
    for (const symbol of Object.values(STORE_SYMBOLS)) {
      delete globals[symbol];
    }
  });

  test("v2 snapshot includes records when present", () => {
    setStore(STORE_SYMBOLS.multiplexerState, {
      sessions: new Map<string, unknown>([
        ["ses_1", { sessionId: "ses_1", title: "T" }],
      ]),
      knownSessions: new Map(),
      spawningSessions: new Set(),
      closingSessions: new Map(),
      permanentlyClosedSessions: new Set(),
    });
    setStore(
      STORE_SYMBOLS.cmuxSessionStore,
      new Map<string, unknown>([
        ["c1", { session: "c1", parent: "p", spawnState: "known", lifecycle: "active" }],
      ]),
    );

    const snap = captureTelemetrySnapshot(0);
    expect(snap.telemetrySchemaVersion).toBe(3);
    expect(snap.stores.multiplexerRecords).toBeDefined();
    expect(snap.stores.multiplexerRecords!.length).toBe(1);
    expect(snap.stores.cmuxRecords).toBeDefined();
    expect(snap.stores.cmuxRecords!.length).toBe(1);
    // v1 aggregates also present
    expect(snap.stores.multiplexer).toBeDefined();
    expect(snap.stores.cmux).toBeDefined();
  });

  test("v2 snapshot omits records when absent (v1 compat)", () => {
    setStore(STORE_SYMBOLS.multiplexerState, {
      sessions: new Map(),
      knownSessions: new Map(),
      spawningSessions: new Set(),
      closingSessions: new Map(),
      permanentlyClosedSessions: new Set(),
    });
    const snap = captureTelemetrySnapshot(0);
    expect(snap.stores.multiplexerRecords).toBeUndefined();
    expect(snap.stores.cmuxRecords).toBeUndefined();
  });
});

// ── v3 identity and capabilities (Slice 17) ───────────────────────────────

describe("v3 capabilities", () => {
  afterEach(() => {
    for (const symbol of Object.values(STORE_SYMBOLS)) {
      delete globals[symbol];
    }
  });

  test("all four stores absent → all 'absent', unavailable flags false", () => {
    const caps = captureBridgeCapabilities();
    expect(caps.fallbackInProgress).toBe("absent");
    expect(caps.continuationGate).toBe("absent");
    expect(caps.multiplexerManager).toBe("absent");
    expect(caps.cmuxStore).toBe("absent");
    expect(caps.runtimePreset).toBe(false);
    expect(caps.workerReuse).toBe(false);
    expect(caps.terminalCapture).toBe(false);
  });

  test("all four stores present and well-shaped → all 'present'", () => {
    populateAllStores();
    const caps = captureBridgeCapabilities();
    expect(caps.fallbackInProgress).toBe("present");
    expect(caps.continuationGate).toBe("present");
    expect(caps.multiplexerManager).toBe("present");
    expect(caps.cmuxStore).toBe("present");
  });

  test("malformed stores → 'malformed'", () => {
    // Set where Set expected is fine (it IS a Set) — use wrong type.
    setStore(STORE_SYMBOLS.fallbackInProgress, "not-a-set");
    setStore(STORE_SYMBOLS.continuationAttemptGate, 42);
    setStore(STORE_SYMBOLS.multiplexerState, new Map());
    setStore(STORE_SYMBOLS.cmuxSessionStore, new Set());

    const caps = captureBridgeCapabilities();
    expect(caps.fallbackInProgress).toBe("malformed");
    expect(caps.continuationGate).toBe("malformed");
    expect(caps.multiplexerManager).toBe("malformed");
    expect(caps.cmuxStore).toBe("malformed");
  });

  test("mixed: some present, some absent, some malformed", () => {
    setStore(STORE_SYMBOLS.fallbackInProgress, new Set(["a"]));
    // continuation gate absent
    setStore(STORE_SYMBOLS.multiplexerState, "wrong");
    setStore(STORE_SYMBOLS.cmuxSessionStore, new Map());

    const caps = captureBridgeCapabilities();
    expect(caps.fallbackInProgress).toBe("present");
    expect(caps.continuationGate).toBe("absent");
    expect(caps.multiplexerManager).toBe("malformed");
    expect(caps.cmuxStore).toBe("present");
  });

  test("capabilities are included in v3 snapshot by default", () => {
    const snap = captureTelemetrySnapshot(0);
    expect(snap.capabilities).toBeDefined();
    expect(snap.capabilities!.runtimePreset).toBe(false);
  });

  test("capabilities can be omitted via flag", () => {
    const snap = captureTelemetrySnapshot(0, undefined, false);
    expect(snap.capabilities).toBeUndefined();
  });

  test("capabilities never mutate stores", () => {
    populateAllStores();
    const before = (globals[STORE_SYMBOLS.fallbackInProgress] as Set<unknown>).size;
    captureBridgeCapabilities();
    const after = (globals[STORE_SYMBOLS.fallbackInProgress] as Set<unknown>).size;
    expect(after).toBe(before);
  });
});

describe("v3 identity: canonical origin normalization", () => {
  test("URL object → origin string", () => {
    expect(normalizeCanonicalOrigin(new URL("http://127.0.0.1:9999/api"))).toBe(
      "http://127.0.0.1:9999",
    );
  });

  test("string URL → origin string", () => {
    expect(normalizeCanonicalOrigin("https://host.example:8080/path?q=1")).toBe(
      "https://host.example:8080",
    );
  });

  test("URL with userinfo → origin only (no userinfo)", () => {
    expect(
      normalizeCanonicalOrigin("http://user:pass@127.0.0.1:4096/x"),
    ).toBe("http://127.0.0.1:4096");
  });

  test("absent/null/undefined → undefined", () => {
    expect(normalizeCanonicalOrigin(undefined)).toBeUndefined();
    expect(normalizeCanonicalOrigin(null)).toBeUndefined();
  });

  test("empty string → undefined", () => {
    expect(normalizeCanonicalOrigin("")).toBeUndefined();
    expect(normalizeCanonicalOrigin("   ")).toBeUndefined();
  });

  test("non-string non-URL → undefined", () => {
    expect(normalizeCanonicalOrigin(42)).toBeUndefined();
    expect(normalizeCanonicalOrigin({})).toBeUndefined();
  });

  test("unparseable string → undefined (no throw)", () => {
    expect(normalizeCanonicalOrigin("not a url")).toBeUndefined();
  });
});

describe("v3 identity: nonce fingerprint (redaction)", () => {
  test("valid nonce → sha256 hex fingerprint (never raw)", async () => {
    const fp = await computeNonceFingerprint("my-secret-nonce");
    expect(fp).toBeDefined();
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    // The raw nonce must NOT appear in the fingerprint.
    expect(fp).not.toContain("my-secret-nonce");
    // Deterministic.
    const fp2 = await computeNonceFingerprint("my-secret-nonce");
    expect(fp2).toBe(fp);
  });

  test("different nonces → different fingerprints", async () => {
    const a = await computeNonceFingerprint("nonce-a");
    const b = await computeNonceFingerprint("nonce-b");
    expect(a).not.toBe(b);
  });

  test("absent/empty/non-string → undefined", async () => {
    expect(await computeNonceFingerprint(undefined)).toBeUndefined();
    expect(await computeNonceFingerprint(null)).toBeUndefined();
    expect(await computeNonceFingerprint("")).toBeUndefined();
    expect(await computeNonceFingerprint(42)).toBeUndefined();
  });

  test("known vector matches sha256", async () => {
    // sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    const fp = await computeNonceFingerprint("abc");
    expect(fp).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("v3 identity: captureBridgeIdentity", () => {
  test("produces fresh per-instance identity with all source-verifiable fields", async () => {
    const fp = await computeNonceFingerprint("nonce-123456789012345");
    const id = await captureBridgeIdentity({
      serverUrl: new URL("http://127.0.0.1:9999"),
      nonceFingerprint: fp,
      bridgePackageVersion: "0.2.0",
      startupTimestamp: 1000,
      capturedAt: 2000,
    });

    expect(id.pluginInstanceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(id.startupTimestamp).toBe(1000);
    expect(id.capturedAt).toBe(2000);
    expect(id.canonicalOrigin).toBe("http://127.0.0.1:9999");
    expect(id.nonceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(id.transportMode).toBe("loopback-http");
    expect(id.bridgePackageVersion).toBe("0.2.0");
    expect(id.schemaVersion).toBe(TELEMETRY_SCHEMA_VERSION);
  });

  test("two captures produce different pluginInstanceIds", async () => {
    const a = await captureBridgeIdentity({});
    const b = await captureBridgeIdentity({});
    expect(a.pluginInstanceId).not.toBe(b.pluginInstanceId);
  });

  test("absent serverUrl → no canonicalOrigin", async () => {
    const id = await captureBridgeIdentity({});
    expect(id.canonicalOrigin).toBeUndefined();
  });

  test("absent nonce → no nonceFingerprint", async () => {
    const id = await captureBridgeIdentity({});
    expect(id.nonceFingerprint).toBeUndefined();
  });

  test("absent bridgePackageVersion → no bridgePackageVersion", async () => {
    const id = await captureBridgeIdentity({});
    expect(id.bridgePackageVersion).toBeUndefined();
  });

  test("timestamps default to Date.now()", async () => {
    const before = Date.now();
    const id = await captureBridgeIdentity({});
    const after = Date.now();
    expect(id.startupTimestamp).toBeGreaterThanOrEqual(before);
    expect(id.startupTimestamp).toBeLessThanOrEqual(after);
    expect(id.capturedAt).toBeGreaterThanOrEqual(before);
    expect(id.capturedAt).toBeLessThanOrEqual(after);
  });

  test("identity is JSON-serializable with no raw nonce", async () => {
    const fp = await computeNonceFingerprint("super-secret-value-1");
    const id = await captureBridgeIdentity({
      nonceFingerprint: fp,
    });
    const json = JSON.stringify(id);
    expect(json).not.toContain("super-secret-value-1");
    const parsed = JSON.parse(json);
    expect(parsed.nonceFingerprint).toBe(id.nonceFingerprint);
  });
});

describe("v3 snapshot with identity", () => {
  afterEach(() => {
    for (const symbol of Object.values(STORE_SYMBOLS)) {
      delete globals[symbol];
    }
  });

  test("snapshot includes identity when supplied", async () => {
    const fp = await computeNonceFingerprint("0123456789abcdef");
    const id = await captureBridgeIdentity({
      serverUrl: "http://127.0.0.1:8888",
      nonceFingerprint: fp,
    });
    const snap = captureTelemetrySnapshot(0, id);
    expect(snap.identity).toBe(id);
    expect(snap.identity!.canonicalOrigin).toBe("http://127.0.0.1:8888");
    expect(snap.capabilities).toBeDefined();
  });

  test("snapshot omits identity when not supplied", () => {
    const snap = captureTelemetrySnapshot(0);
    expect(snap.identity).toBeUndefined();
  });

  test("snapshot is JSON-serializable with no raw nonce", async () => {
    const fp = await computeNonceFingerprint("do-not-leak-this!!");
    const id = await captureBridgeIdentity({
      nonceFingerprint: fp,
    });
    populateAllStores();
    const snap = captureTelemetrySnapshot(0, id);
    const json = JSON.stringify(snap);
    expect(json).not.toContain("do-not-leak-this!!");
    const parsed = JSON.parse(json);
    expect(parsed).toEqual(snap);
  });
});

// ── Hardened telemetry bounds (Slice 17 hardening) ────────────────────────

describe("hardened: fallback IDs capped, sorted, deduped", () => {
  afterEach(() => {
    for (const symbol of Object.values(STORE_SYMBOLS)) {
      delete globals[symbol];
    }
  });

  test("fallback IDs are sorted", () => {
    setStore(
      STORE_SYMBOLS.fallbackInProgress,
      new Set(["sess_c", "sess_a", "sess_b"]),
    );
    expect(readFallbackInProgressSessionIDs()).toEqual([
      "sess_a",
      "sess_b",
      "sess_c",
    ]);
  });

  test("fallback IDs are deduped", () => {
    setStore(
      STORE_SYMBOLS.fallbackInProgress,
      new Set(["sess_a", "sess_a", "sess_b"]),
    );
    expect(readFallbackInProgressSessionIDs()).toEqual(["sess_a", "sess_b"]);
  });

  test("fallback IDs are capped at RECORD_CAP (100)", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 150; i++) {
      ids.add(`sess_${String(i).padStart(3, "0")}`);
    }
    setStore(STORE_SYMBOLS.fallbackInProgress, ids);
    const result = readFallbackInProgressSessionIDs();
    expect(result!.length).toBe(100);
    // Sorted, so first 100 alphabetically.
    expect(result![0]).toBe("sess_000");
    expect(result![99]).toBe("sess_099");
  });
});

describe("hardened: continuation gate maps capped, sorted, deduped", () => {
  afterEach(() => {
    for (const symbol of Object.values(STORE_SYMBOLS)) {
      delete globals[symbol];
    }
  });

  test("attemptCounts are sorted by key and capped at RECORD_CAP", () => {
    const entries: Array<[string, number]> = [];
    for (let i = 0; i < 150; i++) {
      entries.push([`key_${String(i).padStart(3, "0")}`, i]);
    }
    setStore(STORE_SYMBOLS.continuationAttemptGate, {
      attempts: new Map(entries),
    });
    const gate = readContinuationGate();
    expect(gate).toBeDefined();
    const keys = Object.keys(gate!.attemptCounts!);
    expect(keys.length).toBe(100);
    expect(keys[0]).toBe("key_000");
    expect(keys[99]).toBe("key_099");
  });

  test("lastRearmIdentity is sorted by key and capped at RECORD_CAP", () => {
    const entries: Array<[string, string]> = [];
    for (let i = 0; i < 150; i++) {
      entries.push([`key_${String(i).padStart(3, "0")}`, `val_${i}`]);
    }
    setStore(STORE_SYMBOLS.continuationAttemptGate, {
      lastRearmIdentity: new Map(entries),
    });
    const gate = readContinuationGate();
    expect(gate).toBeDefined();
    const keys = Object.keys(gate!.lastRearmIdentity!);
    expect(keys.length).toBe(100);
    expect(keys[0]).toBe("key_000");
    expect(keys[99]).toBe("key_099");
  });

  test("attemptCounts deduped by key (Map already dedupes, but verify)", () => {
    // Map naturally dedupes by key, but the reader should handle it.
    setStore(STORE_SYMBOLS.continuationAttemptGate, {
      attempts: new Map([
        ["sess_a", 1],
        ["sess_a", 2], // Map overwrites
        ["sess_b", 3],
      ]),
    });
    const gate = readContinuationGate();
    expect(gate!.attemptCounts).toEqual({ sess_a: 2, sess_b: 3 });
  });
});

describe("hardened: multiplexer records deduped by emitted sessionId", () => {
  afterEach(() => {
    for (const symbol of Object.values(STORE_SYMBOLS)) {
      delete globals[symbol];
    }
  });

  test("two Map entries with same emitted sessionId → deduped", () => {
    // Two different Map keys but same sessionId field value.
    setStore(STORE_SYMBOLS.multiplexerState, {
      sessions: new Map<string, unknown>([
        ["key_a", { sessionId: "same_sess", title: "A" }],
        ["key_b", { sessionId: "same_sess", title: "B" }],
      ]),
      knownSessions: new Map(),
      spawningSessions: new Set(),
      closingSessions: new Map(),
      permanentlyClosedSessions: new Set(),
    });
    const records = readMultiplexerRecords();
    expect(records).toBeDefined();
    expect(records!.length).toBe(1);
    // First entry wins (Map iteration order).
    expect(records![0]!.sessionId).toBe("same_sess");
    expect(records![0]!.title).toBe("A");
  });

  test("Map key differs from sessionId → dedup by sessionId", () => {
    setStore(STORE_SYMBOLS.multiplexerState, {
      sessions: new Map<string, unknown>([
        ["key_a", { sessionId: "dup_sess" }],
        ["dup_sess", { sessionId: "dup_sess", title: "second" }],
      ]),
      knownSessions: new Map(),
      spawningSessions: new Set(),
      closingSessions: new Map(),
      permanentlyClosedSessions: new Set(),
    });
    const records = readMultiplexerRecords();
    expect(records).toBeDefined();
    expect(records!.length).toBe(1);
  });
});

describe("hardened: cmux records deduped by emitted sessionId", () => {
  afterEach(() => {
    for (const symbol of Object.values(STORE_SYMBOLS)) {
      delete globals[symbol];
    }
  });

  test("two Map entries with same emitted sessionId → deduped", () => {
    setStore(
      STORE_SYMBOLS.cmuxSessionStore,
      new Map<string, unknown>([
        ["key_a", { session: "same_sess", spawnState: "known", lifecycle: "active" }],
        ["key_b", { session: "same_sess", spawnState: "known", lifecycle: "active" }],
      ]),
    );
    const records = readCmuxRecords();
    expect(records).toBeDefined();
    expect(records!.length).toBe(1);
    expect(records![0]!.sessionId).toBe("same_sess");
  });

  test("Map key differs from session field → dedup by session field", () => {
    setStore(
      STORE_SYMBOLS.cmuxSessionStore,
      new Map<string, unknown>([
        ["key_a", { session: "dup_sess", spawnState: "known", lifecycle: "active" }],
        ["dup_sess", { session: "dup_sess", spawnState: "known", lifecycle: "active" }],
      ]),
    );
    const records = readCmuxRecords();
    expect(records).toBeDefined();
    expect(records!.length).toBe(1);
  });
});

describe("hardened: no sensitive fields in snapshot", () => {
  afterEach(() => {
    for (const symbol of Object.values(STORE_SYMBOLS)) {
      delete globals[symbol];
    }
  });

  test("snapshot has no activationNonce field anywhere", async () => {
    const fp = await computeNonceFingerprint("0123456789abcdef");
    const id = await captureBridgeIdentity({ nonceFingerprint: fp });
    populateAllStores();
    const snap = captureTelemetrySnapshot(0, id);
    const json = JSON.stringify(snap);
    expect(json).not.toContain("activationNonce");
    // The raw nonce value must not appear.
    expect(json).not.toContain("0123456789abcdef");
  });
});
