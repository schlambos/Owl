# 02 — OpenCode API / SDK Inventory

**Date:** 2026-08-11  
**Live server:** `http://127.0.0.1:4096`  
**Version:** `1.18.14` (`GET /global/health` → `{ healthy: true, version: "1.18.14" }`)  
**OpenAPI:** 3.1.0, title `opencode`, **162 paths** (captured in `.opencode-openapi.json`)

## Integration rule

Prefer REST + SSE over CLI scraping. Do not treat static model catalogs as authoritative.

## High-value endpoints (verified live)

| Method | Path | Purpose | Notes |
|--------|------|---------|-------|
| GET | `/global/health` | Health + version | Primary health check |
| GET | `/path` | home/state/config/worktree/directory | Config dir discovery |
| GET | `/project` | Project list | Metadata only — do not enter foreign dirs |
| GET | `/project/current` | Current project | May be `global` |
| GET | `/provider` | All providers + connected + defaults | Large payload (~4.6MB) |
| GET | `/provider/auth` | Auth method catalogs | Not connection state |
| GET | `/config/providers` | Connected providers + models | Smaller; good for UI |
| GET | `/config` | Effective OpenCode config | Includes agents, plugins |
| GET | `/agent` | Live agent definitions | OMO agents appear here |
| GET | `/session` | Sessions | Includes `parentID`, `agent`, `model` |
| GET | `/session/status` | Session status map | Often empty `{}` when idle |
| GET | `/session/{id}/children` | Child sessions | Parent/child tree |
| GET | `/session/{id}/message` | Messages | Later slices |
| GET | `/session/{id}/diff` | Diffs | Later slices |
| GET | `/mcp` | MCP status | e.g. `context7`, `gh_grep` connected |
| GET | `/lsp` | LSP status | `[]` observed |
| GET | `/skill` | Skills | Large |
| GET | `/event` | SSE runtime events | Phase 1+ |
| GET | `/global/event` | Global SSE | |
| GET | `/experimental/capabilities` | Caps | `{ backgroundSubagents: false }` |
| GET | `/experimental/tool/ids` | Tool IDs | Includes OMO tools |
| GET | `/api/*` | Parallel API surface | Overlaps classic routes |

## Observed live shapes

### Health
```json
{ "healthy": true, "version": "1.18.14" }
```

### Path
```json
{
  "home": "<home>",
  "state": "<home>/.local/state/opencode",
  "config": "<opencode-config-dir>",
  "worktree": "/",
  "directory": "<owl-install-root>"
}
```

### Provider (`GET /provider`)
- `all`: array (~184 providers)
- `connected`: string[] of provider IDs
- `default`: map providerID → default model id

**Connected (this environment):**  
`ollama-cloud`, `synthetic`, `alibaba-token-plan`, `openai`, `xai`, `anthropic`, `opencode`, `muse-local`

### Agent (`GET /agent`)
Array of agents. Keys include: `name`, `description`, `mode`, `native`, `hidden`, `model` (`{ providerID, modelID }`), `variant`, `permission`, `prompt`, `options`, `temperature`, `topP`, `color`, `steps`.

OMO agents observed: orchestrator, explorer, librarian, oracle, designer, fixer, council, councillor, plus custom researcher/planner/spotter/critic. Native OpenCode agents: build, plan, compaction, summary, title.

### Session (`GET /session`)
Keys: `id`, `slug`, `projectID`, `directory`, `path`, `parentID?`, `title`, `agent`, `model` (`{ id, providerID, variant? }`), `version`, `time`, `cost`, `tokens`, `summary`.

Parent/child via `parentID` and `/session/{id}/children`.

**Important:** `directory` may point outside authorized filesystem scope. Display as metadata only.

## SDK

- Package present under config install: `@opencode-ai/sdk` (via `~/.config/opencode/node_modules`)
- Plugin package: `@opencode-ai/plugin@1.18.14`
- Control plane may call REST directly in v1; optional later adoption of official SDK client

## CLI

- `opencode` at `/opt/homebrew/bin/opencode`, version `1.18.14`
- Server started with `opencode serve` (unsecured warning if no password)

> **Superseded (2026-08-13):** The control plane no longer requires a separately running `opencode serve`. In Managed mode (default) the server's `OpenCodeLifecycleManager` starts/owns/stops the OpenCode backend via the installed SDK (`createOpencodeServer`). A preexisting `opencode serve` on `:4096` is reused as an external backend if compatible. See `docs/architecture/30-managed-opencode-runtime.md`. This recon note records the 2026-08-11 observation and remains factually accurate for that date.

## Not used as authority

- Static model lists in docs
- Guessed provider catalogs
- Session `directory` paths for filesystem reads outside authorized scope
