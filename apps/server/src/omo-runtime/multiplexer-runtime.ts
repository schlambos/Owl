/**
 * Multiplexer runtime correlation (Slice 16, hardened Slice 17 v3).
 *
 * Authoritative mapping ONLY from verified current-generation v3 bridge
 * telemetry. Legacy v1/v2, stale, mismatch, or previous-generation cache
 * may display diagnostics but NEVER map panes/jobs. Preserves whitelist
 * and no terminal capture.
 *
 * Joins by exact OpenCode session ID. Reuses existing Slice 14 OMO
 * job→child session mapping. Adds a 60s reconciliation grace only when
 * authoritative; otherwise exposes exact mapping plus unknown/unmapped
 * without inventing liveness. Bridge stale uses existing Slice 14 staleness.
 * No calls to OpenCode/session APIs from GET multiplexer and no mux queries.
 */

import type {
  CmuxSessionRecord,
  MultiplexerRuntime,
  MultiplexerRuntimeMapping,
  MultiplexerRuntimeStores,
  MultiplexerSessionRecord,
} from "@omo/shared";
import type { OmoBridgeStatus, OmoBridgeStores, OmoRuntimeSnapshot } from "./types";

/** Reconciliation grace window (60s) — applied only when authoritative. */
export const MULTIPLEXER_GRACE_MS = 60_000;

/**
 * Normalize collection-only IDs (known/spawning/closing/permanentlyClosed)
 * into session records when no sessions record exists for them. The
 * server-side normalization merges them into one record set when practical.
 * Unknown/malformed ignored. Never mutates the bridge stores.
 */
function normalizeCollectionIds(
  records: MultiplexerSessionRecord[],
  collectionIds: OmoBridgeStores["multiplexerCollectionIds"] | undefined,
): MultiplexerSessionRecord[] {
  if (!collectionIds) return records;
  const existing = new Set(records.map((r) => r.sessionId));
  const merged = [...records];

  const addId = (
    id: string,
    flag: keyof Omit<
      MultiplexerSessionRecord,
      "sessionId" | "paneId" | "parentSessionId" | "title"
    >,
  ) => {
    if (existing.has(id)) {
      // Merge flag into existing record
      const rec = merged.find((r) => r.sessionId === id);
      if (rec) rec[flag] = true;
    } else {
      merged.push({
        sessionId: id,
        known: false,
        spawning: false,
        closing: false,
        permanentlyClosed: false,
        [flag]: true,
      });
      existing.add(id);
    }
  };

  for (const id of collectionIds.known ?? []) addId(id, "known");
  for (const id of collectionIds.spawning ?? []) addId(id, "spawning");
  for (const id of collectionIds.closing ?? []) addId(id, "closing");
  for (const id of collectionIds.permanentlyClosed ?? []) {
    addId(id, "permanentlyClosed");
  }

  merged.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  return merged.slice(0, 100);
}

/** Convert bridge store records to the shared DTO shape. */
function toSessionRecords(
  raw: OmoBridgeStores["multiplexerRecords"] | undefined,
): MultiplexerSessionRecord[] {
  if (!raw) return [];
  return raw.map((r) => ({
    sessionId: r.sessionId,
    ...(r.paneId !== undefined ? { paneId: r.paneId } : {}),
    ...(r.parentSessionId !== undefined ? { parentSessionId: r.parentSessionId } : {}),
    ...(r.title !== undefined ? { title: r.title } : {}),
    known: r.known,
    spawning: r.spawning,
    closing: r.closing,
    permanentlyClosed: r.permanentlyClosed,
  }));
}

function toCmuxRecords(
  raw: OmoBridgeStores["cmuxRecords"] | undefined,
): CmuxSessionRecord[] {
  if (!raw) return [];
  return raw.map((r) => ({
    sessionId: r.sessionId,
    ...(r.parentSessionId !== undefined ? { parentSessionId: r.parentSessionId } : {}),
    ...(r.paneId !== undefined ? { paneId: r.paneId } : {}),
    ...(r.title !== undefined ? { title: r.title } : {}),
    spawnState: r.spawnState,
    lifecycle: r.lifecycle,
    panePresent: r.panePresent,
  }));
}

/**
 * Build the multiplexer runtime view from cached bridge + OMO jobs.
 *
 * Slice 17 v3: authoritative mapping (mappedJobs/unmappedJobs/grace) is
 * populated ONLY when the bridge status is verified v3
 * (`bridge.verified === true` and `bridge.schemaVersion === 3`). Legacy
 * v1/v2, stale, mismatch, or previous-generation cache may display store
 * diagnostics (sessions/cmux/counts) but NEVER map panes/jobs —
 * mappedJobs/unmappedJobs are empty and grace is not applied.
 *
 * @param bridge Cached bridge status (v1, v2, or verified v3). Never fetched here.
 * @param omoSnapshot Cached OMO runtime snapshot (jobs + staleness).
 * @param nowMs Current time for grace computation.
 */
export function buildMultiplexerRuntime(
  bridge: OmoBridgeStatus | undefined,
  omoSnapshot: OmoRuntimeSnapshot,
  nowMs: number,
): MultiplexerRuntime {
  const storesRaw = bridge?.stores;
  const sessionRecords = normalizeCollectionIds(
    toSessionRecords(storesRaw?.multiplexerRecords),
    storesRaw?.multiplexerCollectionIds,
  );
  const cmuxRecords = toCmuxRecords(storesRaw?.cmuxRecords);

  const counts: MultiplexerRuntimeStores["counts"] = {};
  if (storesRaw?.multiplexer?.sessionsCount !== undefined) {
    counts.sessions = storesRaw.multiplexer.sessionsCount;
  }
  if (storesRaw?.multiplexer?.knownSessionsCount !== undefined) {
    counts.knownSessions = storesRaw.multiplexer.knownSessionsCount;
  }
  if (storesRaw?.multiplexer?.spawningCount !== undefined) {
    counts.spawning = storesRaw.multiplexer.spawningCount;
  }
  if (storesRaw?.multiplexer?.closingCount !== undefined) {
    counts.closing = storesRaw.multiplexer.closingCount;
  }
  if (storesRaw?.multiplexer?.permanentlyClosedCount !== undefined) {
    counts.permanentlyClosed = storesRaw.multiplexer.permanentlyClosedCount;
  }
  if (storesRaw?.cmux?.recordCount !== undefined) {
    counts.cmuxRecords = storesRaw.cmux.recordCount;
  }

  const stores: MultiplexerRuntimeStores = {
    sessions: sessionRecords,
    cmux: cmuxRecords,
    counts,
  };

  // Slice 17 v3: authoritative mapping ONLY from verified current-generation
  // v3 bridge telemetry. Legacy/stale/mismatch/previous-generation never map.
  const isVerifiedV3 =
    bridge?.verified === true && bridge?.schemaVersion === 3;

  const unavailable = !bridge?.connected;
  const stale = omoSnapshot.stale;

  if (!isVerifiedV3) {
    // Display diagnostics only — never map panes/jobs.
    const mapping: MultiplexerRuntimeMapping = {
      bySessionId: Object.fromEntries(byIdEntries(sessionRecords)),
      mappedJobs: [],
      unmappedJobs: [],
      unavailable,
      stale,
    };
    return {
      stores,
      mapping,
      ...(bridge?.schemaVersion !== undefined
        ? { bridgeSchemaVersion: bridge.schemaVersion }
        : {}),
      bridgeConnected: bridge?.connected ?? false,
    };
  }

  // Verified v3: authoritative mapping with grace.
  const byId = new Map<string, MultiplexerSessionRecord>();
  for (const r of sessionRecords) byId.set(r.sessionId, r);

  const mappedJobs: string[] = [];
  const unmappedJobs: string[] = [];
  for (const job of omoSnapshot.jobs) {
    const childId = job.childSessionId;
    if (childId && byId.has(childId)) {
      mappedJobs.push(job.taskId);
    } else {
      unmappedJobs.push(job.taskId);
    }
  }

  // Grace applied only when authoritative (verified v3 + connected + not stale).
  const graceAppliedMs =
    bridge?.connected && !stale ? MULTIPLEXER_GRACE_MS : undefined;

  const mapping: MultiplexerRuntimeMapping = {
    bySessionId: Object.fromEntries(byId.entries()),
    mappedJobs,
    unmappedJobs,
    unavailable,
    stale,
    ...(graceAppliedMs !== undefined ? { graceAppliedMs } : {}),
  };

  return {
    stores,
    mapping,
    ...(bridge?.schemaVersion !== undefined
      ? { bridgeSchemaVersion: bridge.schemaVersion }
      : {}),
    bridgeConnected: bridge?.connected ?? false,
  };
}

/** Build bySessionId entries without mapping jobs (display-only path). */
function byIdEntries(
  records: MultiplexerSessionRecord[],
): Array<[string, MultiplexerSessionRecord]> {
  return records.map((r) => [r.sessionId, r]);
}