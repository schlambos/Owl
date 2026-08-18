# Slice 14.5 — Agent Configuration Editor Remediation

Remediation slice. Makes the existing agent-model mutation backend genuinely usable from the Agents workspace. No new mutation families.

## Root cause

Slice 5 shipped a working backend (`POST /api/config/simulate|apply` for `agent-model` / `agent-variant`) and a minimal `AgentEditModal` wired from Agents via a small **Model** button. Later slices added provenance, presets, capabilities, council, ACP, doctor, and telemetry — but never revisited the Agents editor UX.

The modal was reachable. The product workflow was not:

| Defect | Location (pre-remediation) | Impact |
|--------|----------------------------|--------|
| Free-text chain was the default; live catalog picker hidden behind an opt-in checkbox (state var `manual`) | `AgentEditModal.tsx` | Normal path required typing raw `provider/model` IDs |
| Chain seeded with only the primary model string | `AgentsPage` → `initialModel={effectiveModel}` | Apply collapsed any ordered fallback chain (data-loss-shaped) |
| Destination always defaulted to active preset | mount effect set `destKind="preset"` | Ignored provenance winner (root override cases) |
| Masked writes only weakly flagged after preview | `"Masked: YES — may not change effective"` | Users could unknowingly write ineffective assignments |
| No Edit entry in agent detail panel | `AgentDetailPanel.tsx` | Forced table-only discovery |
| No provider → model cascade, no reorder, no revision restore UX | modal | Incomplete chain editor |
| Zero web/component tests | `apps/web` | Defect had nothing to catch it |

This was not a wiring regression and not a backend regression. It was a product/UI workflow defect left incomplete after Slice 5.

## Backend audited and reused (no new mutation backend)

| Capability | Endpoint / module | Status |
|------------|-------------------|--------|
| Agent model mutation | `POST /api/config/simulate` + `apply`, kind `agent-model` | Intact |
| Agent variant mutation | kind `agent-variant` | Intact |
| Destination model | `ConfigDestination` = preset \| root-agent × scope user \| project | Intact (no dedicated list endpoint; UI synthesizes) |
| Edit-state hashes | `GET /api/config/edit-state` | Intact |
| Provenance winner | `GET /api/omo/provenance?path=agents.<name>.model` | Intact |
| Live catalog | `GET /api/providers` via OpenCode runtime | Intact |
| Roster | `GET /api/agents` via `buildAgentsDto` (builtin ∪ effective ∪ desired ∪ live non-native) | Intact |
| Revisions / restore | `GET /api/config/revisions`, `POST .../restore` (full-file) | Intact |
| Masked-write detection | `SimulationResult.masked` + warnings | Intact |

Server mutation tests remain in `apps/server/src/cfgwrite/mutate.test.ts` (14 cases including masked-write and revision restore).

### Backend notes (not fixed in this slice)

1. Preset provenance leaves are always attributed `scope: "user"` even when the preset block lives in the project file — destination default for a winning preset therefore selects user scope; `sim.masked` is the backstop.
2. `/api/config/revisions` returns full before/after content (can be large); UI filters client-side.
3. Model + variant are two sequential writes (partial-state window if the second 409s).
4. Server has no native-agent mutation guard — UI is the gate (`kind !== "native"` + ACP exclusion).

## UI architecture

### Agents page (`AgentsPage.tsx`)

Dense table:

```
AGENT | EFFECTIVE MODEL | VARIANT | SOURCE | LIVE | SESSIONS | ACTIONS
```

- Primary action: visible **Edit** (not overflow-only).
- Secondary: **Caps**.
- Edit shown for every non-native, non-ACP-wrapper row (including disabled Observer and custom agents).
- ACP wrappers: muted "managed in ACP" (wrapperModel stays in ACP workspace).
- Native OpenCode agents hidden by default toggle; never get Edit.
- Source stage pill is a button → selects row → detail panel field provenance.
- Hide-native toggle retained.

### Agent detail (`AgentDetailPanel.tsx`)

**Model assignment** card:

- Desired / Effective (+variant + provenanceSummary) / Live (+variant) / Source
- **Change Model** → opens the same modal
- Existing-sessions lifecycle note

### Editor (`AgentEditModal.tsx`) — in-place rewrite

Flow:

```
Explorer → Edit → CURRENT STATE
                 → MODEL CHAIN (catalog-first provider → model + entry variant)
                 → AGENT VARIANT (separate field)
                 → WRITE DESTINATION (provenance-defaulted)
                 → Preview → Apply
                 → Revision history (restore whole file)
```

1. **Seed from provenance** — full winner value (string or ordered array with per-entry variants). Defaults-only agents fall back to row effective/desired. No chain collapse.
2. **Catalog-first selection** — live `/api/providers`; Connected vs Disconnected grouping; search filter; unadvertised current model kept as `(current — not currently advertised)`.
3. **Manual escape hatch** — per-entry "manual" toggle; free-text `provider/model`; warn pill; never blocked solely for catalog absence.
4. **Chain controls** — add / remove / reorder (↑↓); primary badge on entry 1; per-entry variant datalist from observed values only.
5. **Agent-level variant** — separate checkbox + field; never conflated with entry variants.
6. **Destination** — four radios (user/project × preset/root-agent) with file paths; default = provenance winner; **Edit current winning source** shortcut (selection only, no write).
7. **Masked-write explanation** — pre-apply from provenance stage ranks + post-preview `sim.masked` with winner path/reason.
8. **Preview / Apply** — existing simulate→apply safety model; fresh `expectedSourceHash`; 409 → Re-preview; optional second variant write with fresh hash.
9. **Live honesty** — Live shown independently; note that runtime may stay old until OMO/OpenCode reload; existing sessions retain recorded model.
10. **Revisions** — latest agent-filtered revisions; Restore confirms full-file revert.

### Styles

Additive only in `styles.css`: `.btn-xs`, `.pill-btn`, `.chain-row select`, `.dest-scope`/`.dest-option`, `.warn-block`. Dense engineering visual language preserved.

## Provider / model discovery

```
OpenCode GET /config/providers|/provider
  → OpenCodeClient.providers()
  → GET /api/providers
  → useRuntime().providers
  → AgentEditModal catalog
```

No static model catalog. Connected flag is OpenCode's auth state.

## Destination + provenance

Default destination from `ResolvedProperty.winner`:

| Winner stage | Default |
|--------------|---------|
| `preset` | Active preset at winner scope (scope attribution caveat above) |
| `root-agent` | Root agent override at winner scope |
| none (defaults-only) | User active preset |

Masked when selected destination loses to higher-precedence winner (project > user; root-agent > preset at same scope). Simulation re-checks via sandbox provenance.

## Tests

### Web component tests (new)

Infra: `happy-dom` + `@testing-library/react` + `bun test` preload (`apps/web/bunfig.toml`, `apps/web/test/setup*.ts`).

| File | Covers |
|------|--------|
| `test/smoke.test.tsx` | Infra smoke |
| `test/agent-edit-workflow.test.tsx` | §28 open → pick → preview → apply |
| `test/edit-visibility.test.tsx` | §29 Edit on every non-native non-ACP fixture row |
| `test/model-catalog.test.tsx` | §30 connected/disconnected, filter, unadvertised current, manual hatch |
| `test/destination-defaults.test.tsx` | §31 preset/root/project preselect + masked warning |

Run: `cd apps/web && bun test` → **8 pass**.

### Server

Existing `mutate.test.ts` / `provenance.test.ts` unchanged and still green.

## Live browser verification

Performed against running stack:

- OpenCode `http://127.0.0.1:4096` (healthy)
- Control plane API `http://127.0.0.1:8787`
- Web UI `http://127.0.0.1:5174` (Vite; 5173 occupied by unrelated app)

### Explorer reassignment + restore

1. Opened Agents — table columns and **Edit** on every OMO agent (including custom + disabled Observer).
2. Clicked **Edit** on Explorer.
3. Observed Desired/Effective/Live = `ollama-cloud/deepseek-v4-flash:0731`, source preset, destination preselected **Active preset "openai"**.
4. Catalog showed connected providers; current tagged model preserved in model select.
5. Selected advertised `deepseek-v4-flash` (same provider).
6. Preview:
   - Target: user preset `"openai"`
   - File: `~/.config/opencode/oh-my-opencode-slim.json`
   - JSON path: `presets.openai.explorer.model`
   - Current → Proposed: `:0731` → untagged
   - Effective before/after matched
   - Live note + existing-sessions note present
7. Apply succeeded (`POST /api/config/apply` 200).
8. Post-apply API:
   - Desired = `ollama-cloud/deepseek-v4-flash`
   - Effective = `ollama-cloud/deepseek-v4-flash`
   - Live = `ollama-cloud/deepseek-v4-flash:0731` (unchanged)
   - `drift.effectiveVsLive = true`
9. Reopened Edit → Revision history showed the mutation → Restore with full-file confirm.
10. Final API state matched original (Desired/Effective/Live all `:0731`, no drift).

### Custom agent

Opened **researcher** Edit:

- Destination defaulted to **Root agent override** (`current winner: root-agent · agents.researcher.model`)
- Preview only (no apply): target `agents.researcher.model`, proposed `ollama-cloud/kimi-k2.7-code`, effective after correct

### Detail panel

Selected Explorer row → **Model assignment** card with Desired/Effective/Live/Source + **Change Model** + existing-sessions note.

**Browser model reassignment verified: YES**

## Agents that cannot be edited here (and why)

| Agent type | Editable? | Why |
|------------|-----------|-----|
| Builtin OMO (`orchestrator`, `explorer`, `librarian`, `oracle`, `designer`, `fixer`, `observer`, `council`, `councillor`) | Yes (model assignment) | Authoritative OMO config |
| Configured custom (`researcher`, `planner`, `spotter`, `critic`, `fixer-low`, `fixer-high`, …) | Yes | Root/preset agent blocks |
| Native OpenCode-only (`build`, `plan`, `summary`, `title`, `compaction`, …) | No | Not OMO-authoritative; UI hides Edit |
| ACP wrapper agents | No (in this editor) | `wrapperModel` managed in ACP workspace |
| Councillor *member* models | No (in this editor) | Council workspace owns member models |
| Observer when disabled | Yes (model still configurable) | Disable ≠ model assignment |

## Files changed

| Path | Change |
|------|--------|
| `apps/web/src/pages/AgentsPage.tsx` | Table columns, Edit action, ACP gate, source pill, modal/detail wiring |
| `apps/web/src/pages/AgentEditModal.tsx` | Full in-place rewrite (catalog-first, chain, destination, masked, preview/apply, revisions) |
| `apps/web/src/pages/AgentDetailPanel.tsx` | Model assignment + Change Model |
| `apps/web/src/styles.css` | Additive dense-UI helpers |
| `apps/web/package.json` | `test` script + happy-dom / testing-library devDeps |
| `apps/web/bunfig.toml` | test preload |
| `apps/web/test/*` | setup + 5 test files |
| `docs/architecture/24-agent-editor-remediation.md` | this note |
| `README.md` | Slice 14.5 status |

## Out of scope (honored)

No new telemetry, multiplexer, Companion/Interview writes, analytics, raw Monaco editor, model auto-probing, automatic OpenCode restart, or new mutation families.
