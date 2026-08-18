# 08 — First Vertical Slice Implementation Plan

**Date:** 2026-08-11  
**Nature:** Read-only control plane MVP foundation

## Goals

1. Local backend starts and proxies/normalizes OpenCode runtime  
2. Reads OMO config from authorized OpenCode config dir (+ project if present)  
3. Parses JSON/JSONC  
4. Resolves effective agents with basic provenance  
5. Minimal UI: Overview, Models, Agents, Sessions  

## Non-goals (this slice)

- Config writes  
- SSE live updates  
- SQLite telemetry  
- Monaco / React Flow  
- Model probes  
- Prompt editing  
- Full schema validation UI  

## Backend routes

| Method | Path | Behavior |
|--------|------|----------|
| GET | `/api/health` | Control plane health |
| GET | `/api/opencode/health` | Proxied OpenCode health |
| GET | `/api/overview` | Aggregated overview DTO |
| GET | `/api/providers` | Providers + connected + models |
| GET | `/api/agents` | Desired + effective + live join |
| GET | `/api/sessions` | Sessions with parent/child tree |
| GET | `/api/omo/config` | Raw desired + effective summary |

## Implementation steps

1. Workspace scaffold (bun)  
2. Shared types  
3. OpenCode client  
4. OMO loader + resolver (reimplementation)  
5. Aggregate routes  
6. React UI pages  
7. Manual verify against live OpenCode  

## Verification

```bash
bun install
bun run dev          # server + frontend, single supervisor (default)
# or separately:
bun run dev:server   # :8787
bun run dev:web      # :5173
curl -s localhost:8787/api/overview | head
# UI shows health, providers, agents, sessions
```

> **Superseded (2026-08-13):** The original two-command `dev:server`/`dev:web` workflow above is still available, but `bun run dev` is now the default one-command workflow. No separate `opencode serve` is required. See `docs/architecture/30-managed-opencode-runtime.md`.

## Exit criteria

- Overview shows OpenCode online + version  
- Connected vs disconnected providers visible  
- OMO agents show configured vs live models  
- Sessions show parent/child  
- No filesystem writes to config  
