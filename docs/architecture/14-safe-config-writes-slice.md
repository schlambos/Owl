# Slice 5 — Safe Configuration Writes (Agent Model / Variant)

**Date:** 2026-08-11  
**Status:** Implemented  
**Scope:** `agent-model`, `agent-variant` only

## Mutation architecture

```text
UI Edit → POST /api/config/simulate → SimulationResult
                ↓ (user confirms)
         POST /api/config/apply
                ↓
    hash check → JSONC path edit → validate → same-dir temp → rename
                ↓
         SQLite revision + Desired/Effective reload
```

Browser never writes files. Paths resolved server-side from `scope` + known config locations.

## Supported writes

| Mutation | Destinations |
|----------|----------------|
| `agent-model` | User/Project × Preset / Root agent |
| `agent-variant` | User/Project × Preset / Root agent |

Model forms: string, string[], `{id, variant?}[]`.

## JSONC preservation

Uses `jsonc-parser` `modify` + `applyEdits` for targeted path edits.  
Verified: comments and `unknownKeep` / unrelated keys survive.

## Atomic write

1. Write `.filename.pid.ts.tmp` in **same directory** as target  
2. Re-read + parse temp  
3. `renameSync` over target  
4. Confirm hash  

No `/tmp`.

## Concurrency

`expectedSourceHash` on simulate/apply. Mismatch → no write, conflict response.

## Revisions

SQLite at `~/Repos/omo-slim/data/control-plane.db` (project-local).

Stores full before/after content. Restore creates a new revision via same atomic path.

APIs:

- `POST /api/config/simulate`
- `POST /api/config/apply`
- `GET /api/config/edit-state`
- `GET /api/config/revisions`
- `GET /api/config/revisions/:id`
- `POST /api/config/revisions/:id/restore`

## Validation

- Syntax (JSONC parse)
- Structural agent/model checks
- Full provenance resolve before/after (masked-write detection)
- Live model availability = warning only (not blocking)

## UI

Agents → **Edit** → scope + destination + model chain + optional agent variant → **Preview** (diff + effective) → **Apply**.

## Tests

`apps/server/src/cfgwrite/mutate.test.ts` — 10 tests in write-sandbox under project.  
Full suite: **45 pass**.

## Controlled live write (real OMO config)

1. Simulated + applied `agents.researcher.variant` → `cp-test-high`  
2. File updated; prompt and other agents preserved  
3. Restored via `POST .../revisions/{id}/restore`  
4. Final `researcher.variant` = `high` (original)  
5. Two revisions recorded (mutation + restore)

## Observed reload behavior

- Desired/Effective refresh immediately after apply (resolver re-read)  
- Live OpenCode `/agent` not claimed updated; UI note states Live may lag until OpenCode/OMO reload  
- No automatic OpenCode restart in this slice  
- `fs.watch` on known config paths bumps generation / notifies SSE clients

## Security

- No client-supplied absolute paths  
- `assertAuthorizedPath` + `realpathSync` on write targets  
- Reject `..` traversal  

## Deferred

temperature, skills, MCPs, permissions, prompts, options, globals, presets CRUD, etc.

## Recommended next slice

Expand typed mutations to skills/MCPs/temperature **or** prompt-file editing — reusing this write framework.
