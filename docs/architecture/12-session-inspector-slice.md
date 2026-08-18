# Slice 3 — Deep Live Session Inspector

**Date:** 2026-08-11  
**Status:** Implemented  
**Layer:** Live only (Desired/Effective join for agent model compare)

## Goal

Make the Sessions workspace a full operational inspector so routine diagnosis does not require watching OpenCode terminal panes.

## OpenCode endpoints consumed

| Method | Path | Use |
|--------|------|-----|
| GET | `/session/{id}` | Metadata (cost, tokens, summary, model, directory, version) |
| GET | `/session/{id}/message` | Message envelopes `{ info, parts }` |
| GET | `/session/{id}/diff` | `SnapshotFileDiff[]` (often `[]`) |
| GET | `/session/{id}/children` | Child sessions |
| GET | `/session` / runtime store | Tree, status, permissions |
| GET | `/permission` | Bootstrap outstanding (via store) |

Permission **reply** (`POST /permission/{id}/reply`) documented but **not** implemented (read-only slice).

## Control-plane APIs

| Path | Purpose |
|------|---------|
| `GET /api/sessions/:id` | Full `SessionDetail` |
| `GET /api/sessions/:id/messages` | Messages + activity subset |
| `GET /api/sessions/:id/diff` | Diff subset |

## Observed message structure (live)

```json
{
  "info": {
    "id": "msg_…",
    "role": "user" | "assistant",
    "agent": "…",
    "model": { "providerID", "modelID", "variant?" },
    "time": { "created", "completed?" },
    "cost?": 0,
    "error?": …
  },
  "parts": [
    { "type": "text", "text": "…" },
    { "type": "reasoning", "text": "…" },
    { "type": "tool", "tool": "read", "state": { "status", "input", "output", "title", "time" } },
    { "type": "step-start" },
    { "type": "step-finish", "reason", "cost", "tokens" },
    …
  ]
}
```

Part types handled: `text`, `reasoning`, `tool`, `file`, `subtask`, `step-start`, `step-finish`, plus unknown preserved as `kind: "unknown"`.

### Tool state statuses

`pending` | `running` | `completed` | `error` (from OpenAPI `ToolState*`).

### Task / initial instruction

**Source:** first non-synthetic `user` message `text` part.  
**Label:** `Initial user/delegation message` (not claimed as canonical OMO “task” field — OpenCode has no separate task resource).

Child explorer sample confirmed: first user text is the full delegation prompt from the orchestrator.

## Diff behavior

- Live `GET /session/{id}/diff` often returns `[]`.
- Fallback: `session.summary` additions/deletions/files and optional embedded `diffs`.
- UI shows empty state clearly; patches rendered as monospace text (Monaco deferred).
- Diff content is **API payload**, not independent filesystem reads of project paths.

## Permissions

- Pending list filtered from RuntimeStore by `sessionID`.
- History of allow/deny not available without additional OpenCode APIs — not invented.
- Reply actions deferred.

## Live refresh strategy

1. Tree/status from RuntimeProvider SSE (Slice 2).
2. Detail fetch on selection + debounced (~400ms) refresh when selected session’s live status/updated/permissions change.
3. Server-side detail cache (~3s meta, ~2s messages, ~5s diff) with invalidation hooks from runtime event reasons.
4. Abort in-flight fetch when switching sessions.

## Data intentionally not stored

- Full message history in RuntimeStore (fetched on demand).
- Token streaming deltas as separate timeline.
- SQLite / disk persistence.

## Unavailable / uncertain from OpenCode alone

| Wanted | Reality |
|--------|---------|
| Canonical “task” field | Use first user message |
| Waiting-for-child inference | Not claimed without OMO telemetry |
| Fallback-chain reason for model drift | Note only: live ≠ effective |
| Permission history | Pending only |
| Rich diff when summary empty | Empty state |

## Filesystem boundary

- Session `directory` displayed as metadata only.
- Tool inputs may contain absolute paths outside authorized roots — shown as API text, never opened by the control plane.
- Diff patches displayed from OpenCode response only.

## UI

Split Sessions workspace:

- Left: live hierarchical tree (filter, status dots)
- Right: inspector tabs — Overview · Messages · Activity · Diff · Permissions · Raw

## Tests

`apps/server/src/session/normalize.test.ts` — 18 tests covering message/part/diff/activity/initial-instruction/unknown types/large lists.

## Verification (live)

- Root session with 128 tools: detail returns messages, activity tool names, cost/tokens, agentCompare.
- Child explorer: parent link, initial instruction = delegation text, model compare.
- Missing session id: `exists: false` + error message, no crash.
- No config writes.

## Recommended next slice

Prompt-file discovery for Effective prompts, **or** operational permission reply + message streaming polish — still no broad config writes unless explicitly started.
