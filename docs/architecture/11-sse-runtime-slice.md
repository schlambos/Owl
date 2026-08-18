# Slice 2 — Live OpenCode Runtime Synchronization (SSE)

**Date:** 2026-08-11  
**Status:** Implemented  
**Scope:** Live layer only (Desired/Effective unchanged)

## Goal

Replace request-time REST snapshots with a continuously synchronized in-memory
runtime store:

```text
REST bootstrap / reconcile
        ↓
 Normalized RuntimeStore (apps/server)
        ↑
 OpenCode SSE GET /event
        ↓
 Control-plane SSE GET /api/events
        ↓
 Browser RuntimeProvider
```

## OpenCode SSE surfaces inspected

| Endpoint | Role | Selected? |
|----------|------|-----------|
| `GET /event` | Instance event stream; payload `{ id, type, properties }` | **Yes — primary** |
| `GET /global/event` | Global wrap `{ directory?, project?, workspace?, payload }` | No (redundant for single-instance CP) |
| `GET /api/event` | V2 stream; similar types, `data` field variant | No |
| `GET /api/session/{id}/event` | Per-session durable stream | Deferred |

### Observed connect envelope

```json
{ "id": "evt_…", "type": "server.connected", "properties": {} }
```

Heartbeats appear as SSE comment lines (`: heartbeat`).

### Event types applied (store mutations)

| Type | Action |
|------|--------|
| `server.connected` | Mark SSE live |
| `server.instance.disposed` | Full REST reconcile |
| `session.created` / `session.updated` | Upsert session from `properties.info` |
| `session.deleted` | Remove session |
| `session.status` | Update status + statusDetail |
| `session.idle` | status → idle |
| `session.error` | status → error |
| `session.next.step.started` / `prompted` / `prompt.admitted` | status → busy |
| `session.next.agent.switched` | Update agent |
| `session.next.model.switched` | Update model |
| `permission.asked` / `permission.v2.asked` | Track outstanding permission |
| `permission.replied` / `permission.v2.replied` | Clear permission |
| `mcp.tools.changed` / `mcp.browser.open.failed` | Soft MCP REST refresh |
| `models-dev.refreshed` / `catalog.updated` / `integration.*` | Soft provider REST refresh |
| `message.*`, `session.next.text.*`, tool/reasoning deltas | Touch session `time.updated` only (debounced emit) |

### Event types intentionally ignored

TUI events, PTY, questions, file watcher, todos, installation, project/vcs/workspace/worktree noise, `session.diff`, `session.compacted`, `plugin.added`, `reference.updated`, `global.disposed`, `lsp.updated` (no store field yet).

## Runtime store

**File:** `apps/server/src/runtime/store.ts`

Holds:

- health, path, projectCurrent  
- providers, agents, sessions (flat map → tree), MCP, permissions  
- `RuntimeConnection` (rest/sse/stale/lastEvent/lastReconcile)

### Reconnect strategy

- OpenCode SSE loop with exponential backoff (1s → 15s)  
- On each successful SSE connect: full REST reconcile (`sse-connected`)  
- On stream end/error: `sse=disconnected`, `stale=true`, retry  
- Periodic REST reconcile every **45s** while running  
- Manual: `POST /api/runtime/reconcile`

### Control-plane browser stream

`GET /api/events` emits normalized `ControlPlaneEvent`:

- `hello`
- `snapshot` (full `RuntimeStateDto` on connect)
- `runtime.updated` (debounced ~75ms)
- `connection` (connectivity-only)

Browser never parses OpenCode raw event schemas.

## UI

- `RuntimeProvider` + `EventSource("/api/events")`  
- `ConnectionBar`: OpenCode REST, OpenCode SSE, control-plane SSE, last event, last reconcile, stale badge, Reconcile button  
- Sessions page: live tree + status pills; stale banner when disconnected  

## Verification (2026-08-11)

Against OpenCode `1.18.14` @ `127.0.0.1:4096`:

1. Bootstrap loaded 50 existing sessions; REST+SSE `connected`, `stale=false`  
2. `POST /session` title `omo-cp sse verify` → store total 51, `lastEventType=session.created`, session found without browser refresh path  
3. `DELETE /session/{id}` → total 50, `lastEventType=session.deleted`  
4. `GET /api/events` delivers `hello` + `snapshot`  
5. No config writes; filesystem scope unchanged  

OpenCode process kill/restart was not destructively tested in this pass (would interrupt the active engineering session). Recovery path is implemented: disconnect → stale → backoff reconnect → REST bootstrap.

## Unresolved / follow-ups

- Child session appearance verified via prior parent/child REST data; create-child live path depends on OMO task tool (not forced here)  
- `/global/event` multi-directory fan-in not needed yet  
- Message bodies not stored (by design)  
- OMO job board / reuse / fallback still not exposed  

## Recommended next slice

Deeper session inspector (messages/diff/permissions UI) **or** prompt-file discovery for Effective prompts — still **no config writes**.
