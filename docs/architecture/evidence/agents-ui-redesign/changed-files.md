# Slice 28 redesign — changed files

Date: 2026-08-13. Scope: web production code, web tests, docs, evidence only.
No `apps/server`, `packages/shared`, multiplexer, or Slice 16 files touched.

## Production

| Path | Status | Purpose |
|---|---|---|
| `apps/web/src/components/FocusTrapDialog.tsx` | added | Portal true-modal primitive: role=dialog, aria-modal, labelledby, inert+aria-hidden background (restored), heading initial focus, Tab/Shift+Tab trap, Escape, direct backdrop close, focus return. Sheet + modal variants. |
| `apps/web/src/pages/AgentsPage.tsx` | modified | Five columns; useSearchParams two-way state (filter/q/sort/agent/native, push/replace discipline, invalid-agent cleanup, native implication); drawer-before-editor orchestration with distinct focus-return targets; passes `assigned` to the editor; summary/counts on `hasModelIssue`. |
| `apps/web/src/pages/agents/presentation.ts` | modified | `probeIssues[]`/`probeIssueCount`/`hasModelIssue`/`primaryProbeRunning` (8 exact adverse states, primary + fallbacks); ownership model (`self`/`council`/`acp`/`native`); sort keys reduced to name/model/source/signals; override requires a real Assigned; search includes fallback ids. |
| `apps/web/src/pages/agents/AgentAssignmentRow.tsx` | modified | 5-cell row; name button is the only opener (aria-expanded/controls); aligned quiet provider·canonical line; independent source/fallback/issue disclosures; Signals cell; ownership links in Actions. |
| `apps/web/src/pages/agents/AgentDetailDrawer.tsx` | modified | On FocusTrapDialog (sheet); labelled heading with initial focus; Sessions + model issues moved into the drawer. |
| `apps/web/src/pages/AgentEditModal.tsx` | modified | On FocusTrapDialog (modal); `assigned` prop drives Current state Assigned (never `row.desiredModel`); project-scope preset winner defaults project preset; exact destination-differs pre-preview copy. Mutation/simulation behavior unchanged. |
| `apps/web/src/styles.css` | modified | Additive: `.agent-name-btn`, `.model-canonical`, `.signals-cell`/`.signal-*`, `.owner-link`, `.ftd-*` dialog shells, focus-visible coverage. Existing semantic tokens only. |

## Tests

| Path | Status | Purpose |
|---|---|---|
| `apps/web/test/helpers.tsx` | modified | `renderWithRouter(ui, initialEntries)` (MemoryRouter) alongside `renderWithRuntime`. |
| `apps/web/test/agents-assignment-ui.test.tsx` | modified | Five headers; alignment states; signals (fallbacks, primary+fallback issues, quiet healthy/never, Testing); ownership; source independence; drawer/editor transitions + focus return; page/modal Assigned consistency; filters; search incl. fallback ids; long ids. |
| `apps/web/test/agents-sort.test.tsx` | modified | Four retained sort keys; removed keys absent; signals severity sort; missing-last; aria-sort; non-sortable Actions. |
| `apps/web/test/edit-visibility.test.tsx` | modified | Ownership routes: editable set, /council, /acp, /config links. |
| `apps/web/test/destination-defaults.test.tsx` | modified | Project-scope preset winner default; exact destination-differs advisory copy. |
| `apps/web/test/agent-probe-integration.test.tsx` | modified | AgentsPage Probe column → Signals column assertions; router-aware mounts. |
| `apps/web/test/focus-trap-dialog.test.tsx` | added | Dialog semantics, initial focus, trap, Escape, backdrop, inert/aria-hidden restore, focus return. |
| `apps/web/test/agents-url-state.test.tsx` | added | URL hydration/update/cleanup, push vs replace, Back behavior, unrelated-param preservation, native implication. |
| `apps/web/test/agent-edit-workflow.test.tsx` | modified (mount only) | Router-aware mount; workflow assertions unchanged. |
| `apps/web/test/schema-validation.test.tsx`, `model-catalog.test.tsx` | unchanged | Still green against the new dialog shell. |

## Docs & evidence

| Path | Status | Purpose |
|---|---|---|
| `docs/architecture/28-agents-ui-redesign.md` | rewritten | Critic-approved redesign doc (thesis, skills, columns, dialog, URL state, editor, responsive, tests, critique, limitations). |
| `docs/architecture/README.md` | modified | Slice-table entry updated for the redesign pass. |
| `README.md` | modified | Side-slice status paragraph updated. |
| `docs/architecture/evidence/agents-ui-redesign/before-wide.png` | added | 1440×1000 before (8-column first pass). |
| `docs/architecture/evidence/agents-ui-redesign/before-narrow.png` | added | 1024×768 before. |
| `docs/architecture/evidence/agents-ui-redesign/after-wide.png` | added | 1440×1000 after (5 columns). |
| `docs/architecture/evidence/agents-ui-redesign/after-narrow.png` | added | 1024×768 after — no h-scroll, Edit reachable. |
| `docs/architecture/evidence/agents-ui-redesign/after-drawer.png` | added | Drawer open; list visible but inert; `?agent=` URL. |
| `docs/architecture/evidence/agents-ui-redesign/after-editor.png` | added | Editor opened from drawer (drawer closed first). |
| `docs/architecture/evidence/agents-ui-redesign/critique.md` | added | Critique pass: problems → resolutions, findings → corrections. |
| `docs/architecture/evidence/agents-ui-redesign/manifest.md` | added | 22 exit-criteria mapping + validation results + synthetic-state mapping. |
| `docs/architecture/evidence/agents-ui-redesign/changed-files.md` | added | This file. |
