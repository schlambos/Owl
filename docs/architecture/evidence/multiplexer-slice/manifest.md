# Slice 16 — Multiplexer Manifest

**Date:** 2026-08-13  
**Status:** Implemented  
**Source authority:** installed `oh-my-opencode-slim@2.2.10`

## Changed files

### Backend / shared / bridge (this slice)

| File | Change |
|------|--------|
| `packages/shared/src/index.ts` | Added normalized multiplexer DTOs: MultiplexerType/Layout/ZellijPaneMode, Configured/Effective/Provenance/Availability/Detection/Runtime/Activation/Capabilities, SessionRecord, CmuxSessionRecord, RuntimeMapping, MultiplexerSystemDto. |
| `packages/omo-telemetry-bridge/src/stores.ts` | Bumped TELEMETRY_SCHEMA_VERSION to 2. Added v2 whitelisted record readers: readMultiplexerRecords, readMultiplexerCollectionIds, readCmuxRecords. Capped 100, sorted, deduped. v1 aggregates preserved. |
| `apps/server/src/omo/multiplexer.ts` | NEW — pure resolver: MULTIPLEXER_FIELDS catalog, builtin defaults, resolveConfigured/Effective/Provenance, detectLegacyTmux, resolveDetection (auto factory order), resolveAvailability (static command -v), resolveActivation, resolveWarnings, buildMultiplexerSystem. |
| `apps/server/src/omo/multiplexer-commands.ts` | NEW — StaticCommandRunner (production, `command -v` only) + FakeCommandRunner (tests). Strict allowlist; no unscoped command ever callable. |
| `apps/server/src/omo-runtime/multiplexer-runtime.ts` | NEW — buildMultiplexerRuntime: cached bridge + OMO jobs correlation by exact OpenCode session ID. 60s grace only when authoritative. Reuses Slice 14 staleness. |
| `apps/server/src/omo-runtime/types.ts` | OMO_TELEMETRY_SCHEMA_VERSION → 2; added OMO_TELEMETRY_ACCEPTED_SCHEMA_VERSIONS (1,2). OmoBridgeStores extended with v2 records (multiplexerRecords, multiplexerCollectionIds, cmuxRecords). OmoRuntimeSnapshot telemetrySchemaVersion widened to 1\|2. |
| `apps/server/src/omo-runtime/bridge.ts` | Sanitizer accepts v1 and v2. Added sanitizeMultiplexerRecords, sanitizeCmuxRecords. Preserves v1 aggregates. |
| `apps/server/src/omo/catalog.ts` | Replaced deferred `multiplexer` row with exactly four `implemented-slice-16` rows (type, layout, main_pane_size, zellij_pane_mode). Added `implemented-slice-16` to support union. |
| `apps/server/src/cfgwrite/globals.ts` | Extended GlobalMutation with `multiplexer?: Record<string, FieldOp>`. Added expansion + validation (enum/range/type/unknown fields). Reuses existing schema-gated JSONC pipeline. |
| `apps/server/src/doctor/input.ts` | Added `multiplexer?` field to DoctorInput. |
| `apps/server/src/doctor/rules-groups.ts` | Added multiplexerRules (conservative). Updated telemetry bridge-schema rule to accept v1 and v2. |
| `apps/server/src/doctor/engine.ts` | Registered multiplexerRules. |
| `apps/server/src/index.ts` | Added GET /api/system/multiplexer endpoint. Added multiplexer input composition to doctor provider (sync command -v via Bun.spawnSync). |
| `apps/server/src/omo/multiplexer.test.ts` | NEW — resolver tests (schema, auto, resolution, provenance, removal, conflict, mutation, command, detection). |
| `apps/server/src/omo-runtime/multiplexer-runtime.test.ts` | NEW — runtime correlation tests (v1/v2, mappings, job mapping, missing, stale, unavailable, security allowlists). |
| `apps/server/src/cfgwrite/globals.test.ts` (multiplexer section) | NEW — mutation set/remove/compound/hash/schema/comments/revision/restore tests for multiplexer. |
| `apps/server/src/doctor/doctor.test.ts` | Updated bridge schema test to accept v1 and v2; added multiplexer doctor rule tests. |
| `packages/omo-telemetry-bridge/src/stores.test.ts` | Added v2 record reader tests. |

### NOT edited (out of scope)

- Web UI files — not edited by this lane.
- README/docs architecture final — only the two evidence files in `docs/architecture/evidence/multiplexer-slice/`.
- `opencode.json` — not edited.
- Bridge registration — not performed.
- OpenCode processes/sessions/sockets — not inspected.

## Field matrix (summary)

| Field | Type | Enum/Range | Default | Omission | Activation |
|-------|------|-----------|---------|----------|------------|
| multiplexer.type | string | auto/tmux/zellij/herdr/kitty/cmux/none | none | → none | plugin-load |
| multiplexer.layout | string | main-horizontal/main-vertical/tiled/even-horizontal/even-vertical | main-vertical | → main-vertical | plugin-load |
| multiplexer.main_pane_size | number | 20..80 | 60 | → 60 | plugin-load |
| multiplexer.zellij_pane_mode | string | agent-tab/current-tab | agent-tab | → agent-tab | plugin-load |

## Legacy

- Top-level `tmux` key: inspected at load, emits warning, **ignored**. Not aliased, not migrated (dist/index.js:18901-18911).

## Auto detection (factory order)

1. CMUX_SOCKET_PATH && CMUX_WORKSPACE_ID && CMUX_SURFACE_ID → cmux
2. TMUX → tmux
3. ZELLIJ → zellij
4. HERDR_ENV || HERDR_PANE_ID → herdr
5. KITTY_PID || KITTY_WINDOW_ID → kitty
6. else → null (disabled)

No ancestry/executable availability in auto selection.

## Stores (bridge v2 allowlists)

### Multiplexer session-manager
- Expose: sessionId, paneId, parentId, title + known/spawning/closing/permanentlyClosed flags.
- Never: directory, owner, promise, raw object.
- Collection IDs without sessions records exposed separately; server normalizes into one record when practical.

### cmux session-store
- Expose: sessionId, parentSessionId, paneId, title, spawnState, lifecycle, panePresent.
- Never: directory, owner, timestamps, activity, intent, timers, promises.

## Runtime correlation

- Built from cached bridge (v2) + cached OMO jobs only.
- Joins by exact OpenCode session ID (child session = task tool result taskID).
- 60s reconciliation grace only when authoritative (bridge connected + not stale).
- Reuses Slice 14 staleness (rest+sse both disconnected).
- No calls to OpenCode/session APIs from GET multiplexer; no mux queries.

## APIs

- `GET /api/system/multiplexer` — full MultiplexerSystemDto (desired/effective/provenance, legacy, availability, detection, runtime, activation, capabilities, warnings).
- `POST /api/config/global/simulate` — extended with multiplexer Record of 4 FieldOps.
- `POST /api/config/global/apply` — extended with multiplexer Record of 4 FieldOps.

## Doctor

- Category: `agents` (Navigation: System multiplexer).
- Conservative rules:
  - Explicit backend command missing → warning.
  - Configured/detected drift → info only if runtime detected authoritative.
  - Missing bridge/runtime unavailable → no warning.
  - auto→none → healthy/info.
  - none → healthy.
  - Legacy modern conflict → info (ignored behavior).
  - Missing mapping after grace → warning only when authoritative.
  - Avoid warning for unobservable runtime.

## Write safety

- Existing simulate already schema-gates; apply temp revalidates (unchanged).
- Pre-rename atomicity preserved (temp write → verify → rename).
- Revision label: `global-settings` (existing); semantic before/after in effectiveChanges.
- Schema validation before temp write and after reread (existing).
- Comments/unknown raw fields preserved (JSONC writer).

## Tests

- Resolver: schema fields/enums/defaults/range, auto fixture signals/order/none/explicit, resolution/provenance/removal/inactive preservation/conflict.
- Mutation: set/remove/compound/hash/schema/comments/revision/restore.
- Bridge v1/v2: mappings, job mapping, missing, stale, unavailable, security allowlists, no env/content, no unscoped commands.
- Doctor: multiplexer rules (none healthy, auto-detected, command missing, legacy ignored, missing mapping after grace).
- Source freeze: schema exact fields/enums/defaults/range/legacy/raw unknown.