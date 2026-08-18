# Side slice (follow-up) — Team topology views: Agents / Models / Providers

**Date:** 2026-08-17
**Status:** Approved contract. Frontend-only follow-up to 28 and 33. No server/shared/API/schema/probe-engine/mutation changes.
**Relationship:** Docs `28-agents-ui-redesign.md` and `33-antigravity-ui-redesign.md` remain **completed historical side slices**. This document is the focused follow-up that refines their doctrine into route-backed Team topology views. `PLAN.md` remains gospel and is **not modified** — this is an information-architecture refinement of existing Desired → Effective → Live doctrine, not a new product scope.

## Scope and non-scope

**Frontend-only** using existing data plumbing:

- Existing DTOs/types: `AgentsDto` (Desired + Effective), `ModelInventoryDto` / `ModelAvailability.usage` (`primary`/`fallback`), `ProviderDiagnostics`, `ProvidersDto`, `LiveProvider.source`.
- Existing helpers: `presentAgent` and existing canonical `modelKey` encoder.
- Existing fetch: `/api/acp` for ACP wrapper inventory (no new endpoint).
- Reuses existing probe history/safeguards/history UI and the existing Change Model workflow unchanged.

**No changes** to server, `shared/`, API contracts, OpenAPI/schema, probe engine, config mutation/write paths, or OMO loader semantics. Effective remains computed by the control plane; the frontend only regroups/filters/sorts existing Effective topology.

## Shell: routing and chrome

- **Existing Team `ContextNav` / `NavigateMenu` is the sole route-backed segmented control.** Three segments:
  - `Agents` → `/agents` (default)
  - `Models` → `/models`
  - `Providers` → `/providers`
  No additional segmented control, tabs, or pills create Team topology state. `aria-current="page"` on the active segment; keyboard roving per existing `NavigateMenu` pattern.

- **TeamHeader is title + active-effective counts only.** e.g. `Team · 9 agents · 7 models · 4 providers` — counts derive from **active Effective eligible topology** (see below). No filter state, drift counts, or secondary badges in the header.

- **`/council` and `/acp` remain standalone routes** reached only via in-page ownership/dependency links (Council coordinator context, ACP wrapper rows, provider/agent dependency). They are not Team segments.

## Layer authority

| Layer | Authority |
|---|---|
| **Effective** | **Only** topology grouping, counting, filtering, sorting, and cross-navigation authority. Every Team view groups and counts by Effective. |
| **Desired** | Explains assignment and source and feeds the edit destination. Rendered as `Assigned` / source path; never groups or counts. |
| **Live** | Annotates `Runtime drift` only (`Effective ≠ Live` model). Never creates groups, never moves an agent/model/provider between groups, never changes counts. |

Drift, assignment overrides (`Assigned ≠ Effective`), and probe/issues are **signals** rendered as badges/text inside the Effective group row — never group keys.

## Agents route — `/agents`

### Eligibility (Effective-gated)

Team-eligible agents are **OMO built-ins and custom agents only, enabled by default**:

- Include: built-in OMO agents (`orchestrator`, `explorer`, `librarian`, `oracle`, `fixer`, `designer`, etc.) and `custom` agents where presentation `enabled === true`; disabled agents are those with `enabled === false`. Effective assignment gates topology membership (an eligible agent without an Effective assignment does not contribute to Models/Providers scope).
- Exclude: `native` agents, ACP wrapper agents, councillor agents. `council` coordinator is included **only when it has a normal Effective assignment** (not `councillor`/`native` disposition); otherwise it is represented only as a dependency link to `/council`.
- Eligibility uses existing Agent row/presentation `enabled === true/false` semantics via `presentAgent` (do not read `AgentsDto.effective.enabled`); Effective assignment gates topology. Live never adds an agent.

### Show disabled (Agents only)

- Toolbar checkbox **Show disabled** exists **only** on Agents, defaults **OFF**.
- It is an **eligibility gate executed before** facet filters/search/sort: when OFF, disabled agents are excluded from the working set; when ON, they re-enter with a `Disabled` label and count as `disabled shown: N` separate from the header `active` count.
- Toggling it **never changes** TeamHeader active counts or the Models/Providers universes (those remain active-Effective-scoped).

### Filters and sorts

- **Filters** (`filter` param) — IDs exactly `all | overrides | runtime-drift | model-issues | custom`:
  - `overrides` — `Assigned ≠ Effective` (requires non-null Assigned; built-in defaults do not count).
  - `runtime-drift` — `Effective ≠ Live` (annotated from Live).
  - `model-issues` — adverse health for the effective primary **or any fallback** via `ProviderDiagnostics`/`ProbeLookup` (same adverse set as doc 28: `unauthorized`, `model-not-found`, `rate-limited`, `timeout`, `malformed`, `error`, `provider-disconnected`, `opencode-disconnected`; `Testing` is not adverse; healthy/never-probed are quiet).
  - `custom` — `agent.kind === "custom"`.
- **Sorts** (`sort` param) — default is **team order** (existing Effective team order; omitted from URL), plus `name | model | provider | source | signals | kind`. Sort is stable; missing values sort last; `aria-sort` on sortable headers only. Actions column is not sortable.

Search `q` matches agent name, model id/provider, source path, and fallback ids (same `hasModelIssue` family as doc 28).

## Models route — `/models`

### Hard scope: active Effective topology only

The Models view is **not the full catalog**. It renders the **set of models that are actively assigned in Effective** to the scoped topology:

- Active agent **primary** and **fallback** usage refs are distinguished (primary vs fallback badges, with counts).
- Active `council-member` and active `acp-wrapper` usage refs are **independently in scope and may cause a model group to exist**, separately labeled from eligible OMO agent usage (e.g. `Council` / `ACP` dependency label).
- **Excluded:** merely advertised provider models, probe-history-only models, Desired-only models, Live-only models, inactive Council refs, disabled ACP wrapper refs, and refs from disabled-agent eligibility (disabled OMO agents).

Empty state reads as topology-empty, not catalog-empty.

### Filters, sorts, chrome

- **Filters** `all | primary | fallback | shared | issues | never-probed`:
  - `primary` — has ≥1 active agent-primary **OR** active `council-member` **OR** active `acp-wrapper` usage.
  - `fallback` — has ≥1 fallback usage by an active eligible agent.
  - `shared` — 2+ distinct scoped owner IDs across eligible agents, Council, and ACP, deduped (an owner counted once even if both primary and fallback use the same model).
  - `issues` — any adverse probe/provider issue for the model (via `ProviderDiagnostics`).
  - `never-probed` — no probe record for the model.
- **Sorts** `model | provider | primary | fallback | probe | issues` (default `model` or provider-grouped model order; provider grouping is display-only, sort key remains per-spec).

- **Chrome removed:** the catalog `ProviderStrip` and any batch-probe/selection chrome are removed from this route.
- **Retained:** explicit single scoped-model drawer/probe safeguards (confirm + history) and connection/probe history — scoped to the single model only. No bulk probe invocation.

## Providers route — `/providers`

### Derivation

Providers are **derived only from the scoped Models set** above — not from `ProvidersDto` enumeration or OpenCode advertised list. A provider with no scoped model does not appear.

### Row content — compact expandable rows

Each row shows (dense, no cards):

- Provider display name and canonical provider ID (secondary quiet text).
- Connected state (badge/dot + text: `Connected` / `Not connected`; text and color, not color-only).
- Source — **`LiveProvider.source` only** when present, otherwise `Not reported`. No other source inference or path rendering.
- **Unique active eligible OMO agents** count/list using the scoped models (deduped; disabled agents excluded) — this dependent active-agent count remains **eligible OMO only**.
- **Scoped models** count/list (only models in the active scoped set).
- Dependency labels `Council` / `ACP` separately labeled whether or not eligible OMO agents also use the provider.
- Probe/issues summary (adverse issues roll-up for scoped models of that provider).

Expandable disclosure reveals the full agent/model lists and issue details. No secrets, tokens, keys, or provider internals are rendered.

### Filters and sorts

- **Filters** `all | connected | custom-configured | shared | issues`:
  - `connected` — `LiveProvider.connected === true`.
  - `shared` — 2+ distinct scoped active owner IDs across OMO, Council, and ACP, deduping primary+fallback for one owner (e.g. one agent using the provider for both primary and fallback counts as one owner).
  - `issues` — any adverse issue among its scoped models.
  - `custom-configured` — **evidence-based only**, true if **any** of:
    1. ≥1 active eligible **custom** agent uses a scoped model of this provider, **OR**
    2. `ProviderDiagnostics.known === false` for the provider (not `ProvidersDto`), **OR**
    3. ≥1 scoped model of this provider is **unadvertised** (`advertised === false` / not in `ModelInventoryDto` advertised set).
    No heuristics, no config-file parsing, no secrets.
- **Sorts** `name | connection | agents | models | issues | source`.

## Cross-navigation contract

- Agent effective primary/fallback -> `/models?model=<canonical>`
- Model all eligible Agents -> `/agents?model=<canonical>`
- Model eligible child -> `/agents?model=<canonical>&agent=<ownerId>`
- Model Council child -> `/council`; ACP child -> `/acp`
- Model provider -> `/providers?provider=<providerId>`
- Provider parent Models -> `/models?provider=<providerId>`
- Provider child Model -> `/models?provider=<providerId>&model=<canonical>`
- Provider parent eligible Agents -> `/agents?provider=<providerId>`
- Provider eligible child -> `/agents?provider=<providerId>&agent=<ownerId>`
- Provider Council/ACP labels -> `/council` or `/acp`

modelKey is encoded by URLSearchParams as one `model` value; provider may also be present as a separate focus param in provider-originated links. If the model is not in the scoped set, the Models view shows its topology-empty state with focus preserved. Invalid agent selection is removed via `replace`. Clear-focus removes `model`/`provider`/`agent`, preserves unrelated params, and restores stored state. Only eligible agents are link targets for Agents focus; Council/ACP refs go to `/council`/`/acp`. Existing Change Model workflow is unchanged; cross-nav never triggers probe or mutation.

## Persistence

- **Keys (sessionStorage, per-tab):** `omo-control.team.v1.agents`, `omo-control.team.v1.models`, `omo-control.team.v1.providers` — JSON object per route: `{ filter, q, sort, showDisabled? }`. `showDisabled` only for `agents`.
- **What is stored:** `filter` (when not `all`), `q` (when non-empty), `sort` (when not default), and Agents `showDisabled` (when true). Defaults are **omitted** (not written).
- **URL wins; focus uses defaults:** on load, URL params take precedence over sessionStorage. When valid focus params (`model`, `provider`, `agent`) are present, missing `filter`/`q`/`sort`/`showDisabled` use **defaults rather than storage** until clear-focus; clearing focus restores the stored tab state. Focus params themselves use transient defaults without overwriting stored state — navigating with focus does not save it. User-initiated controls (filter/q/sort/showDisabled) first clear focus via `replace` then persist the deliberate state.
- **Validation/clean:** invalid `filter`/`sort`/`q` values are normalized to defaults and removed from the URL via `replace`; invalid `agent` focus for the current context is also removed via `replace`. Unknown params are preserved.
- **Migration:** on hydration, `filter=disabled` migrates to `disabled=1` (Agents `showDisabled`) and is removed from `filter`; `native=1` is removed (native agents are no longer a separate toggle — excluded by eligibility). Migration uses `replace`.
- **Lifetime:** current browser session only (`sessionStorage`, per-tab). No `localStorage`, no cross-tab sync.

## UI, tokens, layout

- Reuses existing Antigravity tokens and layout primitives from doc 33: semantic tokens (`--bg`, `--bg-elev`, `--text`, `--ok`, `--warn`, `--bad`, `--accent`, `--border`, `--radius`, `--mono`, `--sans`), 12–16px radii, hairline borders, restrained shadows, `tabular-nums` on counts.
- **Dense rows, compact disclosures, no cards/bento.** Tables use minimal separators; disclosures are inline/expandable rows (same `aria-expanded`/`aria-controls` pattern as doc 28). Long provider/model IDs truncate with full value in drawer/title — never tooltip-only.
- **Responsive:** targets 1440/1000/768 desktop widths (same breakpoints as doc 33). Tables scroll locally without viewport overflow; no horizontal page scroll at 1024×768.
- **Keyboard/a11y:** semantic `<table>`/`<button>`, visible `:focus-visible`, labeled icon-only controls, focus trap + `inert` + `aria-hidden` + focus return for drawer/modal, `aria-current="page"` on the Team segment, status conveyed by text+icon and color, reduced-motion respected. Existing `FocusTrapDialog` is reused for drawers.

## Testing and validation

### User acceptance behaviors (17)

1. Team `ContextNav` segmented control switches Agents/Models/Providers as route-backed navigation with correct `aria-current` and back/forward restoration.
2. TeamHeader shows active-Effective counts only and does not change when Agents `Show disabled` is toggled.
3. Effective is the sole grouping/count/filter/sort/cross-nav authority; Desired explains assignment/source and Live annotates `Runtime drift` without creating/moving groups.
4. Agents eligibility excludes native, ACP wrappers, councillor; Council coordinator appears only with a normal Effective assignment; otherwise only as a link to `/council`.
5. Agents `Show disabled` defaults OFF, gates eligibility before facet filters, renders `Disabled` labels and a separate `disabled shown` count, and never affects Models/Providers universes.
6. Agents filters `all|overrides|runtime-drift|model-issues|custom` and sorts `name|model|provider|source|signals|kind` apply correctly (including default team order omitted from URL).
7. Models view is hard-scoped to active Effective topology (primary/fallback + Council/ACP dependency labels distinguished; advertised/history/Desired-only/Live-only/inactive/disabled-only excluded).
8. Models filters `all|primary|fallback|shared|issues|never-probed` and sorts `model|provider|primary|fallback|probe|issues` apply within the scoped set.
9. Catalog `ProviderStrip` and batch probe/selection chrome are absent from Models; single scoped-model drawer retains explicit probe safeguards/history.
10. Providers are derived only from scoped models; rows show name/ID, connected state, `LiveProvider.source` or `Not reported`, unique active eligible agents, scoped models, Council/ACP labels, probe/issues.
11. Providers filters `all|connected|custom-configured|shared|issues` (with evidence-based `custom-configured`) and sorts `name|connection|agents|models|issues|source` apply.
12. Cross-nav: agent model → selected scoped Model; eligible model/provider agent refs → focused Agents/detail; councillor/ACP refs → `/council`/`/acp`; Models ↔ Providers.
13. Canonical `modelKey` is the single encoded `model` focus param; provider focus uses `provider=<id>`; no dual params.
14. Visible `Clear focus` removes focus params via `replace` and never persists focus; focus does not overwrite stored filter/q/sort/showDisabled.
15. `sessionStorage` per-tab persistence of `filter/q/sort` (+ Agents `showDisabled`); URL wins; defaults omitted; invalid values cleaned; `filter=disabled → disabled=1` and `native=1` removal migrated.
16. Antigravity tokens/layout: dense rows, compact disclosures, no cards; responsive at 1440/1000/768 without viewport overflow; keyboard and a11y requirements met.
17. No `Apply`/probe invocation is triggered by browsing, filtering, sorting, or cross-navigation; probe remains explicit single-model confirmed.

### Test plan

- **Targeted Team tests** (new): eligibility, show-disabled gating, header counts, drift/override signals vs grouping, all filter/sort IDs per route, cross-nav param contracts, clear-focus `replace`, sessionStorage persistence/URL precedence/migration, token/layout smoke.
- **Narrow updates** to existing suites impacted by Team IA only (URL-state helpers, assignment presentation where touched).
- **Existing regressions** remain green: edit/schema/probe workflows, `AgentEditModal` Assigned vs Effective, `ProbeLookup` adverse set, `presentAgent` derivation. No new probe-engine or mutation tests required (no backend change).
- **Typecheck:** `web typecheck` (and root `typecheck` if present) clean.
- **Browser pass (one, no mutations):** 1440/1000/768 in **both themes**, checking scanability (dense rows / quiet secondary text / disclosures), segmented keyboard operation, focus/cross-nav, and that no `Apply` or probe is invoked.

## Files

- `docs/architecture/34-team-topology-views-follow-up.md` — this contract.
- `docs/architecture/README.md` — indexed entry for this side slice follow-up.
- This documentation lane itself changes no code; the subsequent frontend implementation is scoped by this contract (no server/shared/API/schema/probe-engine/PLAN.md changes in this lane).

## Out of scope / not changed in this lane

- `PLAN.md` (gospel), docs `28` and `33` (frozen history), server/shared/API/schema/probe-engine, and all mutation/write destinations remain as-is for this documentation lane. The subsequent frontend implementation will be scoped strictly by this contract.
