# Slice 10 — Council Configuration & Lifecycle

**Date:** 2026-08-11  
**Status:** Implemented

## Installed schema (2.2.10, verified)

```
council.default_preset        string, schema default "default"
council.presets.<preset>.<member> { model, variant?, prompt? }
```

- `model`: single `"provider/model"` or ordered fallback chain `[string | {id, variant}]` (same shape as agent model)
- Reserved member key `master` → silently ignored during parse; top-level `council.master` recorded as `_deprecated`
- Unknown fields preserved (passthrough)
- Councillors run through protected `councillor` agent with member model; coordinator is the normal `council` agent

## Coordinator vs councillors

Workspace explicitly separates: coordinator (`council` agent — edited via existing agent systems) from councillor presets (`council.presets`). No conflation.

## APIs

- `GET /api/council` — inventory (presets, members, sources, warnings, legacy)
- `GET /api/council/runtime` — council/councillor sessions from live store (no member-identity inference)
- `GET /api/council/compare?a&b` — member presence + model/variant/prompt diffs
- `POST /api/config/council/simulate|apply` — typed `council` mutation

## Mutations

Preset create (empty/clone desired) · rename (auto-updates default_preset reference) · delete (default-only rejection) · default preset set/remove · member create/update/rename/delete (model/variant/prompt field ops).

Validation: names, reserved `master`, provider/model format for chains, model required on create, model remove rejected.

## UI

**Council** workspace: coordinator note, preset list (★ default), member matrix (chain length, prompt presence), add/delete member, raw desired JSON, runtime sessions panel.

## Tests

101 pass (inventory, master-legacy exclusion, empty preset, create/clone/rename/delete, member chain+prompt, reserved-master rejection, model-format validation, only-default deletion rejection, default set).

## Live verification (real config)

| Step | Result |
|------|--------|
| Create `cp-test-council` | OK |
| Add alpha (model+variant+prompt) + beta (chain of 2) | OK |
| Inventory | matches, chain lengths correct |
| Rename → `cp-test-council-2` | OK (default_firmware untouched since non-default) |
| Delete | OK |
| Final config | back to `default` preset only |
| Revisions | 4 council entries |

Council-related sessions: none currently (filter verified, no fabrication).

## Deferred

ACP, multiplexer, Companion, Interview, runtime Council invocation (no verified isolated mechanism), member→session identity mapping (not exposed by OpenCode).

## Recommended next slice

ACP agents workspace (config + lifecycle, read-only process state) or Interview/Companion inspection slices.
