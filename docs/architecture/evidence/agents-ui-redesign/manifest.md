# Slice 28 redesign — exit-criteria manifest

Date: 2026-08-13. Surface: `http://127.0.0.1:5173/agents`.
Each criterion maps to its proof (test file / browser evidence).

| # | Original exit criterion | Proof |
|---|---|---|
| 1 | Relevant locally installed frontend/design skills were actually used | `28-agents-ui-redesign.md` “Skills used” records the explicit `/Users/matt/.agents` authorization, each invoked skill, and the concrete principles applied; the generic bento recommendation and its rejection are recorded. |
| 2 | The existing Agents page was reviewed in the running browser before redesign | `before-wide.png` (1440×1000), `before-narrow.png` (1024×768), and the baseline findings in `critique.md`. |
| 3 | The page information architecture was redesigned, not merely restyled | `AgentsPage.tsx` and `AgentAssignmentRow.tsx`; “exactly five headers” in `agents-assignment-ui.test.tsx`; `before-wide.png` versus `after-wide.png`. |
| 4 | Agent model assignment is the primary visual concept | Five-column surface places **Assignment** directly after Agent and folds provider/runtime comparison into it; `after-wide.png`; `28-agents-ui-redesign.md` “Design thesis.” |
| 5 | Assigned, Effective, and Live are understandable without documentation | Semantic layer labels and distinct user-facing state text in `AgentAssignmentRow.tsx`; override/drift/both interaction tests; editor Current state uses the same terminology. |
| 6 | Identical Assigned/Effective/Live state does not create redundant visual noise | “aligned row compresses…” in `agents-assignment-ui.test.tsx`; aligned rows render one model line in `AgentAssignmentRow.tsx`; `after-wide.png`. |
| 7 | Assignment overrides are immediately recognizable | “Assigned ≠ Effective…” test verifies expanded Assigned/Effective layers and `Assignment overridden`; source tests verify `Root override`. |
| 8 | Runtime drift is immediately recognizable and distinguished from assignment override | “Effective ≠ Live…” and “both: all three layers…” tests verify `Runtime drift` separately from `Assignment overridden`. |
| 9 | Configuration source is understandable | Human source labels plus independent exact-path disclosure; “source button reveals path inline; never opens drawer or selects” test; live source review recorded in `28-agents-ui-redesign.md`. |
| 10 | Fallback-chain existence is obvious without overwhelming the main view | `+N fallbacks` in Signals with independent ordered disclosure; “+N fallbacks with independent ordered disclosure” test. |
| 11 | Model probe problems are visible while healthy/unprobed states remain quiet | Primary/fallback adverse issue tests (including disconnects), Model Issues filter test, and “healthy and never-probed are quiet; running primary says Testing”; live fixer Timeout in `after-wide.png`. |
| 12 | Edit/Change Model is obvious | Primary Edit action in `AgentAssignmentRow.tsx`; Edit visibility/correct-agent interaction tests; `after-wide.png` and `after-editor.png`. |
| 13 | Current controlling source is obvious in the edit workflow | `destination-defaults.test.tsx` covers winner-derived defaults, project-preset scope, and destination advisory; `after-editor.png`; architecture note “Editor changes.” |
| 14 | Custom agents work correctly | “custom agent shows Custom pill + Edit” and ownership/edit visibility tests; custom rows reviewed live. |
| 15 | Disabled agents remain understandable and editable where appropriate | “disabled Observer is an ordinary editable row (Edit + Caps)” test; disabled Observer reviewed live. |
| 16 | Native OpenCode/ACP/Councillor ownership boundaries remain correct | Ownership and `edit-visibility.test.tsx`: councillor/live-only council → `/council`, ACP → `/acp`, native → `/config` with `Managed by OpenCode configuration`; configured council coordinator remains editable. |
| 17 | Search/filtering materially improves navigation | Overrides, Runtime Drift, and Model Issues filter tests; search test covers agent, model, provider, source, and fallback IDs; `agents-url-state.test.tsx` proves durable URL state and Back behavior. |
| 18 | Existing schema-safe model mutation behavior is unchanged | `agent-edit-workflow.test.tsx`, `schema-validation.test.tsx`, and `destination-defaults.test.tsx`; unchanged server regressions `mutate.test.ts` and `validator.test.ts` pass 31/0. No server/shared files appear in `changed-files.md`. |
| 19 | Frontend interaction tests cover aligned/override/drift/problem states | `agents-assignment-ui.test.tsx` covers aligned, Assigned≠Effective, Effective≠Live, both, primary/fallback problems, quiet healthy/never, source, fallback, Edit, custom, disabled, and ownership states. |
| 20 | Real browser verification is completed | `after-wide.png`, `after-narrow.png`, `after-drawer.png`, `after-editor.png`; live review table in `28-agents-ui-redesign.md`. Real-unavailable divergence/fallback states map to semantic tests below. |
| 21 | A post-implementation design critique was performed and issues corrected | `critique.md` and `28-agents-ui-redesign.md` “Critique findings and corrections” record issue → correction for assignment classification, project-preset destination, dialogs, source behavior, fallback health, and URL state. |
| 22 | No filesystem outside authorized roots was inspected | Work remained within `/Users/matt/Repos/omo-slim`, active OpenCode config, and the user-authorized `/Users/matt/.agents` skill root; `changed-files.md` confirms no server/shared/multiplexer/Slice 16 paths were modified. |

## Validation results

- `bun --cwd apps/web test` (run as `bun test` in `apps/web`): **112 pass / 0 fail**, 13 files.
- `bun --cwd apps/web run typecheck` (run in `apps/web`): clean.
- `bun --cwd apps/web run build` (run in `apps/web`): clean (vite build ✓).
- Repo-root `bun run typecheck` (shared + server + web): clean.
- Unchanged server regression evidence: `mutate.test.ts` + `validator.test.ts` → **31 pass / 0 fail**.

## Synthetic-state mapping (real config lacks these states)

| State | Covered by |
|---|---|
| Assigned ≠ Effective (assignment override) | agents-assignment-ui "Assigned ≠ Effective…" + modal Assigned consistency |
| Runtime drift / both | "Effective ≠ Live…", "both: all three layers…" |
| Configured fallback chain + disclosure | "+N fallbacks with independent ordered disclosure" |
| Fallback probe issue / disconnect states | "primary + fallback adverse issues…", "filter Model Issues uses hasModelIssue" |
| Running primary ("Testing") | "healthy and never-probed are quiet; running primary says Testing" |
| ACP wrapper ownership link | ownership + edit-visibility tests |
| Native row + /config link | ownership + edit-visibility tests |
| Council with effective assignment (editable) | "council WITH a normal effective assignment is editable" |
