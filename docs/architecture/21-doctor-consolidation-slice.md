# Slice 12 — Doctor / Health Consolidation

**Date:** 2026-08-11  
**Status:** Implemented. Read-only by design.

## Architecture

```text
RuntimeStore / resolvers / inventories / revisions
        ↓ (composed once, cached)
   DoctorInput
        ↓
   Rule groups (pure functions)
        ↓ dedupe / sort / aggregate
 DoctorSnapshot → GET /api/doctor|/summary|/recheck
        ↓
 Overview + Doctor workspace
```

`apps/server/src/doctor/`:
- `types.ts` — Diagnostic, DoctorSnapshot, categories, severities
- `severity.ts` — central aggregation policy
- `input.ts` — composed state (runtime, provenance, capability/council/ACP inventories, revisions, env, versions)
- `rules-core.ts` — core/omo/config/prompt/provider-model rules
- `rules-groups.ts` — agents/capabilities/council/acp/sessions/revisions/security rules
- `engine.ts` — evaluate, cache, invalidate-on-generation
- `doctor.test.ts` — fixture tests

## Severity policy (single source: `severity.ts`)

| Overall | Rule |
|---------|------|
| error | any diagnostic severity=error |
| degraded | any warning |
| healthy | otherwise (info/unknown never degrade) |

Errors: OpenCode unreachable, config/resolver failure, revision DB write failure, protected-invariant violations.  
Warnings: active provider disconnected, enabled agent not live-registered (when runtime not stale), active MCP disconnected, stale runtime with SSE down, outstanding permissions, current session errors, missing Council default preset.  
Info: built-in/default-disabled states, version skew, masking/shadowing, env preset override, default-disabled entities, unknown skills, out-of-scope cwd.  
Unknown: blocked-by-prerequisite (`blocked.*`, providers catalog, omo.registration), runtime stale → live drift downgraded to unknown, runtime preset.

## Stable IDs

Deterministic slugs, e.g. `agent.explorer.model-drift`, `provider.xai.disconnected-active`, `council.default-missing`, `acp.<name>.command-unresolved`. Dedup map by id; aggregated counts.

## Prerequisite gating

- OpenCode down → Live checks return unknown (`providers.catalog`, `omo.registration`)
- Runtime stale → live model-drift severity downgraded warning→unknown, cross-linked via `relatedDiagnosticIds`

## APIs

- `GET /api/doctor` — full snapshot (`?severity=`, `?category=` filters)
- `GET /api/doctor/:id` — single deterministic diagnostic
- `GET /api/doctor/summary` — overview payload
- `POST /api/doctor/recheck` — runtime reconcile + fresh snapshot; **non-mutating** (no probes, no writes)

## Caching

Snapshot regenerates only when input generation changes (runtime event/reconcile stamps, configGeneration, revision count). Overview polls summary every 15s.

## Live findings (real environment, after verification)

| Diagnostic | Severity |
|------------|----------|
| `council ... default empty` | **warning** |
| `agent.observer.default-disabled` | info |
| `omo.version-skew` (package ^2.2.10 vs manifest 2.2.13) | info |

## False-positive correction found during live verification

A phantom `fixer-low`/`fixer-high` builtin classification existed in the control-plane shared roster (not present in installed OMO 2.2.10's authoritative `SUBAGENT_NAMES`) and produced false "missing live agent" warnings. Removed; roster now matches installed implementation exactly. This validates the unknown/unknown+unknown policy: installed source wins, never invented semantics.

## Tests

123 pass total (fixture rules: healthy, offline, SSE-down, config failure, drift stale/non-stale, missing live, session errors, permissions, aggregation policy).

## Deferred

Auto-remediation, Fix-All, acknowledgement/suppression rules, historical doctor telemetry, notifications, automatic probes/restarts, nonatomic fixes.

## Recommended next slice

Companion/Interview read-only inspection, or doctor-driven doctor/noise tuning pass after live usage feedback.
