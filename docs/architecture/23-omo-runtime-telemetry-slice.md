# Slice 14 — OMO Runtime Telemetry Bridge (read-only)

**Date:** 2026-08-12  
**Status:** Implemented. Patch-free. No OMO/node_modules modification. Bridge plugin built but **not registered** (live registration requires opencode.json plugin-array change + OpenCode restart — activation procedure documented, deliberately deferred).

## Feasibility audit — installed state ownership (2.2.10, authoritative)

| State | Owner (installed source) | Reachability |
|---|---|---|
| BackgroundJobBoard instance | created once at plugin init, `dist/index.js:40870-40876` | **Plugin-instance closure — not externally reachable** |
| BackgroundJobCoordinator | `dist/index.js:40876` (closure local) | **Not reachable** |
| BackgroundJobSupervisor | `dist/index.js:40877-40886` (closure) | **Not reachable** |
| ForegroundFallbackManager chains/tried/retries | `dist/index.js:40904` instance; internals at 26316+ | **Not reachable** |
| Foreground-fallback **in-progress Set** | `getProcessFallbacksInProgress`, `dist/index.js:26309-26314` | **Module-shared globalThis Symbol.for — reachable in-process** |
| Continuation-attempt gate (wake) | `dist/index.js:27972-27984` | **globalThis Symbol.for — reachable in-process** |
| Cmux session store | `dist/index.js:35667-35675` | **globalThis Symbol.for — reachable in-process** |
| Multiplexer session-manager state | `dist/index.js:36299-36312` | **globalThis Symbol.for — reachable in-process** |
| activeRuntimePreset | module var `dist/index.js:21244-21249`; bundle exports only default (`:41424-41425`) | **Module-level but NOT exported — not reachable** |
| Job/task status outputs | `parseTaskStateFromOutput`, `dist/index.js:24976-24995`; formats at 24976-24994 | **Persisted in OpenCode session message parts — reachable via REST** |
| Task tool call args (agent/desc/task_id) | OpenCode task tool, part state in messages | **Persisted in OpenCode messages — reachable via REST** |
| Job record fields | `BackgroundJobRecord` (board.d.ts:18-52) — internal only | Not reachable (subset recoverable from task parts) |
| Council member identity | councillors dispatched via plain `task()`; **no council metadata keys found** (verified: only `internalInitiator :25849`, `phaseReminder :26986`, `backgroundJobBoard :27258` exist) | Job-level correlation works; member↔session identity unavailable |
| Orchestrator wake (continueOnIdle) | gate store above + coordinator closure | Config + gate counts reachable in-process via bridge |

**Reachability verdict:** rich job telemetry is recoverable from **persisted OpenCode task-tool parts** (authoritative: these parts are OMO/OpenCode's own records). Deep OMO internals (reuse counts, pool membership, discard reasons, fallback chain positions, runtime preset) are **closure/module-scoped without exports — truthfully `Unavailable` in 2.2.10**.

## Capability matrix

| State | Reachable? | Method |
|---|---|---|
| OMO job ID | ✅ | task tool ID = child session ID (direct correlation) |
| Agent role | ✅ | `subagent_type` arg in persisted task call |
| Parent/child session | ✅ | task part ↔ OpenCode session |
| Job status | ✅ | `running/completed/error/cancelled` from persisted task status outputs (verified formats) |
| `reconciled` state | ❌ | OMO-closure-only board decoration; never emitted |
| `timedOut` | ✅ | only when OMO status output declares it (`dist/index.js:24972`) |
| Launch/completion times | ✅ | part `time` metadata |
| Resume (new vs reused) | Partial | we observe `task_id` args → labelled "Resume requested"; OMO reuse decision internals unavailable |
| Worker reuse count | ❌ | closure |
| Pool membership/eligibility | ❌ | closure |
| Tracked context lines | ❌ | closure (config threshold readable from Slice 9 config) |
| Discard reason | ❌ | not recorded by installed source |
| Read-context snapshots | ❌ | injection-state closure |
| Fallback chain position | ❌ | ForegroundFallbackManager closure |
| Fallback in-progress | ✅ via bridge | globalThis Set |
| Orchestrator wake/gate counts | ✅ via bridge | continuation-attempt-gate |
| continueOnIdle config | ✅ | existing config provenance |
| activeRuntimePreset | ❌ | module var, unexported — stated as explicit `runtimePreset: false` |
| Council member↔session | ❌ | no metadata pathway verified |
| ACP jobs | ✅ | same task-part machinery (ACP dispatch visible as task calls) |

## Selected architecture

**Two-track, patch-free:**

1. **Derive track (always on):** control-plane scans persisted OpenCode session message parts for `task` tool calls + status outputs, using OMO's own serialization formats verbatim (`parseTaskStateFromOutput` regexes, `dist/index.js:24976`). `OmoRuntimeStore` maintains `Map<taskId, OmoJob>`, merges incremental SSE-driven refreshes (3s memo), prunes fully-vanished jobs >6h. This works today with zero OpenCode changes.
2. **Bridge track (opt-in):** `packages/omo-telemetry-bridge` — an OpenCode plugin that reads the four verified globalThis `Symbol.for` stores **read-only** and serves a localhost snapshot (`127.0.0.1:8788`, `/telemetry`, schema v1). Defensive per-store shape validation; missing/malformed stores simply omitted. Configured by `OMO_BRIDGE_BASE_URL`; **absence is normal and degrades gracefully**.

Alternatives rejected: (A) native export — none exists; (B) plugin-to-plugin escalation — only the 4 globalThis stores are shared; (C) OMO-provided telemetry — absent in 2.2.10 (2.2.13 cache shows OMO added `dist/server.js` — future versions may obsolete the bridge; migration note); (E) dist patch — vetoed by the no-silent-patch rule.

**No OMO modification was required.**

## Telemetry schema (v1)

```jsonc
// GET /api/omo/runtime
{
  "telemetrySchemaVersion": 1,
  "generatedAt": 1723456789000,
  "stale": false,
  "availability": { "opencodeJobs": true, "bridge": false, "runtimePreset": false },
  "jobs": [ OmoJob ],
  "workers": [ { "agent", "running", "completed", "errored", "cancelled", "jobs" } ],
  "bridge": { "connected", "lastSeenAt", "stores": {...}, "schemaVersion": 1 } | null,
  "notes": [...]
}
```

`OmoJob` — whitelisted fields only: `taskId, agent, parentSessionId, childSessionId, state, alias?, description?, resultSummary?(≤200 chars), timedOut?, launchedAt?, completedAt?, resumeRequested?, statusUncertain?, source:"opencode-task-call"`. Schema mismatch on bridge → warning, no crash.

## Transport

Derive track: existing OpenCode REST (`GET /session/:id/message`). Bridge track: localhost HTTP `127.0.0.1:8788/telemetry` (port via `OMO_BRIDGE_PORT`; loopback hardcoded; no auth — loopback only). No filesystem polling.

## Events

`/api/events` carries `omo-runtime.updated {ts, jobCount, changed:[taskIds], bridgeConnected}` on debounced signature change — full snapshot never streamed.

## Stale / reconnect

OpenCode down → snapshot served `stale:true` from cache, doctor qualifies downstream conclusions. Bridge down (when configured) → `telemetry.bridge-down` info; `lastSeenAt` retained.

## Security whitelist

Only `OmoJob` keys survive serialization; `resultSummary` capped at 200 chars; prompt text, tool args, file contents, provider auth, ACP env structurally excluded by the server-side `security.ts` fail-closed guard. Bridge plugin serializes only whitelisted primitives per store.

## UI

- Sessions sidebar: collapsible OMO JOBS panel (per-job state pills incl. pulse-dashdot running animation); click→selects child session.
- Session Inspector `omo` tab: child view (job detail incl. "Timed out (OMO)", "Resume requested"), parent view (child-jobs list), footer honest-derivation note.
- Agents rows: `· jobs X running / Y done` appended to Sessions cell.
- Overview "OMO Runtime" card: aggregated counts, bridge row, runtime-preset unavailable line.
- DoctorPage filter: `telemetry` category added.

Unavailable states render as explicit "unavailable" text (runtime preset) or are absent entirely — no empty scaffolding for fallback chains, reuse counts, or pool capacity.

## Doctor integration

`telemetry` category rules (conservative): activity (healthy/info), bridge-down (info only when configured), bridge-schema mismatch (warning), job-orphan (warning, 60s grace + timestamps), job-timeout (warning, OMO-declared only), job-errors (info, 30m window), stale (info). Info never degrades overall.

## Tests / results

- Server: 224 pass (+39 this slice) on 13 files — state-enum freeze, both output formats, timedOut propagation, summary cap, alias extraction, launch/terminal/resume fixtures, parent/child correlation, >6h prune, session-cap selection, stale flags, bridge absent/present merge, security guards incl. fail-closed whitelist, verified council-metadata-none freeze, orphan grace (30s suppressed / 90s warns), zero bridge diagnostics when unconfigured.
- Bridge package: 19 pass — populated/wrong-shape/missing stores, primitive whitelisting, WeakMap skip, concurrent stability.
- Web: tsc + build clean.

## Live verification (real data)

`/api/omo/runtime`: schema 1, not stale, **16 OMO jobs derived** from real persisted task parts across explorer/fixer (completed/error states), workers aggregated, bridge absent (expected — not registered). `/api/omo/jobs/:id` returns job + child session summary. Doctor: `telemetry.activity` healthy (16 records), `telemetry.job-errors` info referencing the real errored fixer session ID. No synthetic/destructive work was launched; no provider manipulation.

## Unsupported runtime states (2.2.10, closure/module-limited)

Board record internals (generation/deadline fields), worker reuse counts/eligibility/discard reasons, tracked context lines & retained read snapshots, fallback chains/positions/reasons, orchestrator wake timestamps (gate counts only via bridge), activeRuntimePreset, council member↔session identity. All intentionally displayed as unavailable — no inferred substitutes.

## Maintenance / update implications

- 2.2.13 adds `dist/server.js` (session/status + health surfaces) — if/when 2.2.13 becomes the loaded package, re-audit: upstream may provide a superset bridge; prefer it then.
- Bridge `Symbol.for` keys are version-locked to 2.2.10 findings; cross-check after OMO upgrades (keys validated shape-first, unknowns omitted).
- Bridge live registration (`./packages/omo-telemetry-bridge` in opencode.json plugin array) follows the safe write + revision pipeline + required restart, per `packages/omo-telemetry-bridge/ACTIVATION.md`. Deliberately not performed this slice.

## Priority-adjusted continuation openings

Future: upstream server-path (2.2.13+) migration; bridge live registration after package-version gate; SQLite job-history analytics (explicitly deferred historical telemetry).
