# Side slice — Agents assignment UI / information architecture (critic-approved redesign)

**Date:** 2026-08-13 (redesign pass; first pass 2026-08-12)
**Status:** Implemented. Frontend-only IA redesign of the Agents workspace. Configuration semantics, serializers, write destinations, and all mutation paths are unchanged.

This slice paused the Slice 16 multiplexer roadmap. **Slice 16 remains paused** — this slice does not implement it.

## Design thesis

A dense engineering control plane. **Assignment dominates.** Visual complexity is spent only where the three layers (Assigned / Effective / Live) *diverge*; agreement is one quiet line. Existing semantic tokens only (`--bg`, `--bg-elev`, `--text`, `--ok`, `--warn`, `--bad`, `--accent`, `--mono`, `--sans`). No cards, no bento grid, no marketing surface. Healthy and never-probed rows are quiet; warnings are text **and** color; motion is restrained to dialog transitions; controls are semantic with visible focus.

The earlier generic bento/marketing recommendation (from a dashboard-generation skill) was **rejected** — this is an operator console, not a landing page.

## Skills used

The active config had **no frontend skills installed**; the user explicitly authorized reading `/Users/matt/.agents`. Skills actually invoked:

| Skill | What was taken |
|---|---|
| **frontend-design** | Structure encodes truth: compress when layers agree, expand only on divergence. Operator copy names what the user controls (Assigned / Effective / Live). |
| **ui-ux-pro-max** | Dense comparison surface (density 9/10, motion 2/10), progressive disclosure (drawer/disclosures), full keyboard operability. |
| **design-system** | Reuse of existing semantic tokens; additive `agents-*`/`ftd-*` classes only; tabular-nums on counts. |
| **web-design-guidelines** | Semantic `<table>`/`<button>`/`<dialog>` semantics, visible `:focus-visible`, aria-expanded/controls disclosures, true-modal dialog rules, long-content truncation with full text available. |
| **agent-browser** | Real before/after review of the running app at 1440×1000 and 1024×768 (evidence under `docs/architecture/evidence/agents-ui-redesign/`). |

`ui-styling` / `webapp-testing` were not invoked (no Tailwind/shadcn stack; agent-browser covered live review).

## Main surface — exactly five columns

`AGENT | ASSIGNMENT | SOURCE | SIGNALS | ACTIONS`

Provider / Fallbacks / Probe / Sessions columns (and their `provider` / `fallbacks` / `probe` / `sessions` sort keys) are **removed**. Sessions moved into the detail drawer. Remaining sort keys: `name` (Agent), `model` (Assignment), `source` (Source), `signals` (Signals).

- **Agent** — the visible agent-name **button** is the only detail opener (`aria-expanded` / `aria-controls="agent-detail-drawer"`). The `<tr>` is not clickable and has no role/tabIndex; the natural tab sequence is name → source → fallback/issues → Edit → Caps/owner link. Status text below the name: Disabled / Custom / Native.
- **Assignment** — aligned rows render one human model line (catalog name + agent variant) with provider · canonical id as *quiet secondary but visible* text (truncated intelligently; full id also on the cell title and in the drawer — never tooltip-only). Divergence expands: assignment override → Assigned + Effective + `Assignment overridden`; runtime drift → Effective + Live + `Runtime drift`; both → all three layers + both distinct labels. `row.desiredModel` is **never** used as Assigned (it prefers root over preset); Assigned is derived client-side from the desired config.
- **Source** — human source button (`Preset: openai`, `Root override`, `Custom / root`, …) with an **independent** inline path disclosure (`aria-expanded`/`aria-controls`). It never opens the drawer and never alters the selection URL.
- **Signals** — `+N fallbacks` with an independent ordered disclosure; adverse model-health issues for the effective primary **and** each fallback (looked up through the existing ProbeLookup). Adverse states exactly: `unauthorized`, `model-not-found`, `rate-limited`, `timeout`, `malformed`, `error`, `provider-disconnected`, `opencode-disconnected`. First issue renders with a `+N more` expansion. A running primary shows quiet `Testing` (not adverse); healthy/never-probed render `—`. Summary counts, the Model Issues filter, and search all use `hasModelIssue`; search also matches fallback ids.
- **Actions** — Edit (primary) + Caps (secondary) for self-owned rows: ordinary builtins/custom **including disabled Observer**. Ownership links otherwise: councillor and live-only/unconfigured council → `/council` (council with a normal effective assignment stays editable); ACP wrappers → `/acp`; native agents → `/config` with `Managed by OpenCode configuration`.

## FocusTrapDialog

`apps/web/src/components/FocusTrapDialog.tsx` is a portal-based true-modal primitive used by **both** the AgentDetailDrawer (side-sheet variant) and the AgentEditModal (modal variant):

- `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing at the heading.
- Every other `<body>` child gets `inert` + `aria-hidden="true"` while open; both are **restored exactly** on close. The sheet variant uses a transparent backdrop so the assignment list stays **visible but inert** behind the drawer.
- Initial focus lands on the labelling heading (`tabIndex={-1}`); Tab / Shift+Tab cycle inside the panel; Escape closes; a click directly on the backdrop closes (panel clicks never do).
- Focus returns on close — direct row Edit → the row's Edit button; drawer Edit → the row's name (detail) trigger.
- The drawer **closes before** the editor opens; only one dialog is ever open (no nesting).

**Limitation:** `CapabilityEditModal` still uses the legacy `.modal-backdrop` markup (no focus trap / inert background). Migrating it is out of scope for this slice.

## URL two-way state

All list state lives in the query string via `useSearchParams`:

| Param | Semantics |
|---|---|
| `filter` | valid FilterId; omitted when `all`; invalid → `all`. Push. |
| `q` | omitted when empty; updates use **replace** (typing never spams history). |
| `sort` | `<name\|model\|source\|signals>:<asc\|desc>`; omitted for default role order; invalid → default. Push. |
| `agent` | selected agent (drawer open); normal URLSearchParams encoding; omitted when closed. Push. Invalid names are cleaned up with replace **after data load**. A selected native agent implies `native=1` (replace). |
| `native` | `native=1`; omitted when false. Push. |

Unrelated params are preserved across every update; Back/Forward restore filter, sort, search, and drawer state.

## Editor changes (presentation only)

`AgentEditModal` gained an optional `assigned?: {model?, variant?, sourcePath?}` prop, fed from the row's presentation model. The Current state card's **Assigned** uses this prop only — never `row.desiredModel`. Chain seeding, provenance, mutation, masked-simulation behavior are unchanged. Destination defaults still follow the provenance winner, and a **project-scope preset winner now correctly defaults to the project preset** (previously hardcoded to user scope). When the chosen destination differs from the winner, the pre-preview advisory reads exactly: `Preview to confirm whether this source changes the Effective model.`

## Responsive

Five columns fit at 1024×768 without horizontal scrolling (verified by screenshot): the quiet canonical line truncates, and Edit/Caps wrap inside the Actions cell. A sticky Actions column was considered and **rejected** — the evidence shows Edit reachable without it.

## Tests

`cd apps/web && bun test` → **112 pass / 0 fail** (`bun run typecheck` and `bun run build` clean; repo-root `bun run typecheck` clean for shared/server/web).

- `agents-assignment-ui.test.tsx` — five headers; aligned/override/drift/both; fallback disclosure; primary+fallback and disconnect issues; healthy/never quiet + Testing; disabled/custom; council/councillor/ACP/native ownership; source disclosure independence; name-button drawer open; direct vs drawer editor transitions with focus return; page/modal Assigned consistency; filters; search by agent/model/provider/source/fallback; long ids.
- `agents-sort.test.tsx` — the four retained sort keys, click cycle, missing-last invariant, aria-sort, non-sortable Actions.
- `focus-trap-dialog.test.tsx` — semantics, initial heading focus, Tab/Shift+Tab trap, Escape, direct backdrop close, inert + aria-hidden apply/restore, focus return (default + explicit).
- `agents-url-state.test.tsx` — hydration, invalid-value fallback, invalid-agent cleanup, native implication, push/replace rules, Back behavior, unrelated-param preservation.
- `destination-defaults.test.tsx` — + project-scope preset winner default; + exact destination-differs advisory copy.
- `edit-visibility.test.tsx`, `agent-probe-integration.test.tsx` — ownership routes / Signals column updates. `agent-edit-workflow.test.tsx`, `schema-validation.test.tsx`, `model-catalog.test.tsx` run unchanged against the new dialog shell (array payload for one-entry chains, advisory/masked simulation, schema-gated Apply all still covered).
- `helpers.tsx` — added `renderWithRouter(ui, initialEntries)` (MemoryRouter) for the search-param-driven page.

All assertions are semantic; no snapshots.

## Browser review (live, http://127.0.0.1:5173/agents)

| Check | Result |
|---|---|
| 1440×1000 | Five columns; aligned rows one line + quiet `Provider · canonical`; fixer `Timeout` the only loud signal |
| 1024×768 | No horizontal scroll; Edit/Caps fully reachable; native checkbox wraps to its own line |
| Drawer | Opens via name button; URL gains `?agent=orchestrator`; list visible but inert; Sessions + full canonical ids + provenance inside |
| Drawer → Edit | Drawer closes first, editor opens; Assigned in Current state matches the presentation model |
| Source disclosure | Toggles the path inline; URL unchanged; no drawer |

States absent from the real config (synthetic test coverage instead): Assigned ≠ Effective override, runtime drift, configured fallback chains, fallback probe issues, running primary ("Testing"), ACP wrapper row, native row visible. See `evidence/agents-ui-redesign/manifest.md` for the state→test mapping.

## Critique findings and corrections (this pass)

| Finding | Correction |
|---|---|
| Effective present but no Assigned (builtin-default resolution) rendered as `Assignment overridden` | Override requires a real Assigned value: `a != null && modelsDiffer(a, e)` |
| Project-scope preset winner defaulted to the USER preset destination | `destinationForWinner` now maps preset winners to their actual scope |
| First-pass drawer/modal were non-modal overlays (no trap, background reachable) | FocusTrapDialog primitive: trap, inert background, focus return, one dialog at a time |
| Source badge click selected the row (destroyed scan focus) | Independent inline disclosure; selection only via the name button |
| Probe column only covered the primary model | `probeIssues[]` covers effective primary + every fallback; summary/filter/search follow `hasModelIssue` |
| Filter/sort/selection state was ephemeral | Full two-way URL state with push/replace discipline |

## Remaining UX limitations

- No live Assigned ≠ Effective, runtime-drift, fallback-chain, or fallback-issue examples in the real config — covered by synthetic tests.
- Council/councillor are not editable here unless council has a normal effective assignment (council model lives in the Council workspace).
- `CapabilityEditModal` is not yet on FocusTrapDialog (no focus trap/inert background there).
- The drawer intentionally repeats Assigned/Effective/Live even when aligned (depth view).
- Drawer Edit pushes a history entry (closing the drawer via URL); Back from the editor reopens the drawer.

## Files

See `evidence/agents-ui-redesign/changed-files.md` for the authoritative path/status/purpose list.
