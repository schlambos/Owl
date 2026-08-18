# Slice 8 — Presets Workspace & Lifecycle

**Date:** 2026-08-11  
**Status:** Implemented

## Merge asymmetry (verified)

| Context | Rule | Winner |
|---------|------|--------|
| Load-time | `deepMerge(presetAgents, rootAgents)` | **root** |
| Runtime `/preset` | `deepMerge(currentAgents, presetAgents)` | **preset** |

## Runtime preset observability

**Not exposed.** OMO `activeRuntimePreset` is a server-side in-memory singleton; TUI `/preset` calls `switchPresetOnDisk` which only persists `preset` to user config (applies on next reload/restart). No programmatic runtime activation endpoint exists.

Control plane shows:

```text
Runtime preset: Unknown
Mechanism: documented
```

No runtime activation is faked. Configured-preset edits go through the safe pipeline.

## Domain / APIs

- `GET /api/presets` — inventory (sources, masking, warnings)
- `GET /api/presets/compare?a&b&mode` — desired | load-effective | runtime-switch
- `GET /api/presets/:name/switch-impact` — field-level runtime activation impact
- `POST /api/config/preset/create` — empty or clone (desired content)
- `POST /api/config/preset/rename` — preset + optional configured ref; **refused when preset prompt dir exists** (multi-resource txn deferred)
- `POST /api/config/preset/delete` — rejects active preset unless forced
- `POST /api/config/preset/set-configured` — change persisted `preset`

## UI

**Presets** workspace: inventory (★ configured), agent matrix with masked-field badges, runtime-switch impact table, compare (mode toggle), raw desired JSON, lifecycle actions.

## Clone semantics

Clone copies **desired preset object**, not root-effective values (test: `openai/ex` not `root/ex`).

## Revisions

Unified SQLite (`preset-create/clone/rename/delete/configured-preset`).

## Tests

79 pass total (preset inventory, masking, switch impact, compare modes, lifecycle, name validation).

## Live verification (real config)

| Op | Result |
|----|--------|
| Clone `preset-3` → `test-clone` | OK |
| Rename → `test-renamed` (+configured ref update) | OK |
| Delete `test-renamed` | OK |
| Final presets | `openai, opencode-go, preset-3` unchanged |
| Revisions | 3 preset entries |
| Compare openai↔opencode-go | 14 differing fields |

## Deferred

- Prompt-dir-aware rename transaction
- Runtime preset activation (no mechanism exists)
- Global config editing, Council, ACP, etc.
- Prompt/capability cross-referencing in compare output (fields covered; deep semantic diff later)

## Recommended next

Global configuration workspace (`disabled_*`, `backgroundJobs`, `fallback`) or System workspace.
