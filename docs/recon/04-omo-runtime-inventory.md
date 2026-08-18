# 04 — OMO-Slim Runtime Inventory

**Date:** 2026-08-11

## What OpenCode already exposes (usable now)

| Concern | Source | Notes |
|---------|--------|-------|
| Effective agent list + models | `GET /agent` | Post-OMO-registration view |
| Sessions + parent/child | `GET /session`, `/session/{id}/children` | `agent`, `model` on session |
| MCP connectivity | `GET /mcp` | status per server |
| Tools | `/experimental/tool/ids` | includes `task`, `cancel_task`, `wait_for_user`, ast-grep |
| Skills | `GET /skill` | installed skill payloads |
| Capabilities | `/experimental/capabilities` | `backgroundSubagents: false` here |
| SSE | `/event`, `/global/event` | not yet consumed in slice 1 |

## What OMO owns internally (not fully exposed via OpenCode API)

From package structure (`dist/hooks`, `dist/tools`, constants):

| Concern | Location (package) | Exposure gap |
|---------|-------------------|--------------|
| Background job board | hooks/task-session-manager, BackgroundJobBoard | No first-class OpenCode endpoint |
| Worker reuse / discard reasons | session lifecycle hooks | Infer partially from sessions; incomplete |
| maxSessionsPerAgent etc. | `backgroundJobs` config + board | Config readable; live board not |
| Fallback chain position | fallback hooks | Not in session API |
| Council councillor runs | council agents + tools | Sessions may show councillor; synthesis opaque |
| Orchestrator wake / continueOnIdle | backgroundJobs.continueOnIdle | Internal |
| Runtime preset active name | TUI/runtime state | May differ from file `preset` |
| Multiplexer pane state | multiplexer module | Partially observable via opt-in telemetry bridge v2 (whitelisted session-manager/cmux records); control plane is read-only and cannot drive the multiplexer |
| Companion window | companion module | External |

## Defaults (constants)

| Constant | Default |
|----------|---------|
| `DEFAULT_MAX_SESSIONS_PER_AGENT` | 2 |
| `DEFAULT_MAX_CONTEXT_LINES` | 50000 |
| `DEFAULT_READ_CONTEXT_MIN_LINES` | 10 |
| `DEFAULT_READ_CONTEXT_MAX_FILES` | 8 |
| `DEFAULT_MAX_RETAINED_SNAPSHOTS` | 20 |
| `DEFAULT_DISABLED_AGENTS` | `["observer"]` |

## Telemetry extension (future)

PLAN.md Phase 7: narrow read-only OMO telemetry for job IDs, reuse state, board, fallback position, effective preset, wake state. **Do not implement a second scheduler.**

## Live correlation example

Configured explorer (preset openai): `ollama-cloud/deepseek-v4-flash:0731`  
Live `/agent` explorer model: matches  
Some historical child sessions used `synthetic/hf:moonshotai/Kimi-K2.7-Code` — runtime can diverge from current config (old sessions, fallbacks, or prior config).
