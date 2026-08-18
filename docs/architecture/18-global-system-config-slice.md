# Slice 9 — Global System Configuration

**Date:** 2026-08-11  
**Status:** Implemented

## Installed option catalog (2.2.10)

35 entries cataloged in `apps/server/src/omo/catalog.ts`.  
Coverage: 25 Slice-9 supported; deferred: `council`, `acpAgents`, `multiplexer`, `companion`, `interview`; unsupported: `showStartupToast` (absent from installed schema/dist), `fallback.runtimeOverride` (deprecated).

## Global array semantics

`disabled_*` arrays use OMO deepMerge rules — override scope **replaces**, not unions. Proven via resolver.

## Protected / default-disabled

- Protected (cannot disable): `orchestrator`, `councillor`
- Default disabled: `observer` (built-in)

## backgroundJobs (installed)

`strategy` (latest|checkpoint-compatible), `maxSessionsPerAgent` 1–10 d2, `maxContextLines` 0–500000 d50000, `readContextMinLines` 0–1000 d10, `readContextMaxFiles` 0–50 d8, `maxRetainedSnapshots` 1–100 d20, `continueOnIdle` bool dfalse, `wallClockTimeoutMs` 0|60000–2^31-1 d0, `abortGraceMs` 1000–60000 d10000.

## fallback

`enabled` dtrue, `timeoutMs` d15000, `retryDelayMs` d500, `maxRetries` d3, `retry_on_empty` dtrue.  
`runtimeOverride` deprecated (not editable). Worker deadline ≠ model request timeout (kept distinct).

## image_routing

`auto|direct`. Omitted → `observerEnabled ? auto : direct` (verified `resolveImageRouting`).

## stripOrchestratorModel

True → omit orchestrator.model/variant from SDK config so OpenCode session model applies. Default false.

## webfetch

`{enabled, model}` — bounded; supported this slice.

## APIs

- `GET /api/system/options` — coverage matrix
- `GET /api/system/globals` — globals + effective + env status
- `POST /api/config/global/simulate|apply`

## UI

**System** workspace: Overview, Global Availability, Background Jobs, Failure Handling, Routing, Startup/UI, Environment, Option Coverage.

## Tests

89 pass total (catalog, protected agent, nested edit, range validation, exact `retry_on_empty`, image_routing, set/remove, hash conflict).

## Live verification

`compactSidebar=false` applied → Effective false → restore → removed from file. Comment/unknown keys preserved.

## Deferred

Council, ACP, multiplexer, Companion, Interview, prompt-dir rename, raw whole-file editor, OMO job-board telemetry.

## Recommended next

Council workspace, ACP workspace, or Capabilities write integration refinement.
