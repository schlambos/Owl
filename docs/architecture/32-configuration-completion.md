# Slice 18 — Configuration Completion

**Date:** 2026-08-17  
**Status:** Backend + Config workspace implemented. Catalog/audit documented. **Live/browser reversible proofs are not claimed here** — they belong to the parent orchestrator and independent verifier.

Authority is the currently installed package under the active OpenCode config directory only. Re-verified for this document:

| Identity | Value |
|---|---|
| Package | `oh-my-opencode-slim@2.2.10` |
| Installed schema SHA-256 | `947ac72a9035e0b7d7ce80c6e8f16ccdf930677b6b80b61d83b054cedbd30e8b` |
| Cache key | `oh-my-opencode-slim@2.2.10-947ac72a9035e0b7d7ce80c6e8f16ccdf930677b6b80b61d83b054cedbd30e8b` |
| Authority path | `{OPENCODE_CONFIG_DIR}/node_modules/oh-my-opencode-slim/oh-my-opencode-slim.schema.json` |
| Audit command | `bun run audit:omo-schema` |

The config `$schema` URL is never fetched. A static schema copy is never authoritative. `bun run audit:omo-schema` re-reads the installed package + schema bytes and fails closed if any current field is unclassified, Companion is marked editable, typed Interview is unaudited, or OpenCode/prompt sources are claimed as raw coverage.

---

## Companion — intentionally skipped

Companion remains **read-only / intentionally not developed further**.

- Eight installed fields: `enabled`, `binaryPath`, `position`, `size`, `gifPack`, `loopStyle`, `speed`, `debug`.
- Classification: `read-only-companion`.
- Structured writes reject Companion mutation (`companion-read-only`).
- Raw Apply rejects any structural Companion change, including mixed allowed+Companion candidates. Pure reformatting with canonical Companion equality is allowed.
- Invalid-current repair is fail-closed unless unchanged Companion can be proven from the parse tree / best-effort AST. Unproven Companion → reject, no temp/rename.
- System UI copy: **Read-only / intentionally not developed further**.
- The control plane does not launch, probe, or lifecycle-manage the companion binary.

---

## Interview — current installed semantics

Verified against `InterviewConfigSchema` in installed `2.2.10` (`dist/index.js:18778-18784`) and schema SHA above. Typed writes stay closed unless package version, schema hash, field set, and source semantics all match this audit.

| Field | Type | Default | Range / constraint | Omission | Notes |
|---|---|---|---|---|---|
| `maxQuestions` | integer | `2` | `1..10` | installed default | Captured at plugin init |
| `outputFolder` | string | `"interview"` | minLength `1` | installed default | Trim + strip leading/trailing slashes; empty → `"interview"`; `path.join(projectDirectory, normalized)` |
| `autoOpenBrowser` | boolean | `true` | — | installed default | Configuration only. Control plane never opens a browser. OMO auto-disables in automated runtimes |
| `port` | integer | `0` | `0..65535` | installed default | `0` = OS-assigned per-session unless dashboard interaction selects installed default `43211` |
| `dashboard` | boolean | `false` | — | installed default | `dashboardEnabled = dashboard===true \|\| port>0`; dashboard+port0 → `43211` |

Activation: `/interview` is an OpenCode **command**, not a tool. One lazy HTTP server per plugin instance, `127.0.0.1` only. Config is captured at plugin init → `restartRequired: true`, `runtimeAction: "none"`.

Output path is **metadata only**: `inspected: false`, `exists: null`. Control-plane Interview/raw paths never `stat`/`read`/`readdir` the resolved destination.

Typed Interview operations: nonempty unique installed-field `set`/`remove` on `user` or `project`. `remove` deletes only that source leaf so inheritance or the installed default returns. Values use the audited metadata. Apply requires `expectedCandidateSha256` and delegates the D1 transaction.

---

## One OMO JSON transaction boundary

Only `apps/server/src/cfgwrite/transaction.ts` may physically write authoritative user/project OMO JSON/JSONC.

Producers (Interview, raw, globals, council, ACP, presets, mutate, revision restore) produce candidate text. They do not call `writeFileSync` / `renameSync`. Prompt-file writes (`cfgwrite/prompts.ts`) and OpenCode-bridge writes remain separate domains.

Apply sequence (summary):

1. Recover pending revisions for the logical scope.
2. Resolve target from logical scope / `sourceId` only — never a client path.
3. Reread and compare existence, SHA-256, format, generation.
4. Enforce 2 MiB candidate / request caps.
5. Parse current (legacy `.json` may be read as JSONC for structured compatibility) and candidate (`target-extension` for raw).
6. Companion policy.
7. Full installed-schema + parity validation.
8. Virtual Desired / Effective / provenance (merge even when candidate `exists:true` and no disk path).
9. Pending revision → same-directory temp → reread/revalidate → atomic rename → hash → committed.
10. Post-rename finalization failure leaves pending and returns `503 recovery-pending`.

Simulation writes nothing.

---

## Raw workspace

Client-facing logical IDs only: `sourceId: "user-omo" | "project-omo"`. Never send filesystem paths.

| Route | Role |
|---|---|
| `GET /api/config/raw?sourceId=` | Exact UTF-8 text, fingerprint, format, path metadata, schema cache key, syntax/schema diagnostics. Missing project: `exists:false`, editor text `{}\n`, no create |
| `POST /api/config/raw/compare` | Read-only current vs draft textual compare |
| `POST /api/config/raw/simulate` | Preview. No write |
| `POST /api/config/raw/apply` | Commit. Requires `expectedCandidateSha256` |
| `GET /api/omo/schema` | Status + generations. No document body |
| `GET /api/omo/schema/document` | Installed schema document, `Cache-Control: no-store`, or `503` |
| `GET /api/config/omo-revisions?sourceId=&limit=1..100` | Committed authorized OMO revisions |
| `GET /api/config/omo-revisions/:id` | Exact before/after + current-schema eligibility |
| `POST .../simulate-restore` / `.../restore` | Transaction Preview/Apply restore |

Limits: `MAX_OMO_CANDIDATE_BYTES = 2,097,152`, `MAX_OMO_REQUEST_BYTES = 2,162,688`. Raw HTTP bounds **before decode**: oversized `Content-Length` is 413 without reading the body; chunked bodies stream and cancel at the cap.

Format: raw candidates use `candidateParse: "target-extension"`. `.json` comments/trailing commas are invalid. `.jsonc` comments/trailing commas are valid. Supplied candidate bytes and extension are preserved; no formatter/autosave.

Optimistic concurrency: load fingerprint (`exists`, `sha256`, `format`, `mtimeMs`, `generation`) + Preview candidate SHA + schema cache key. External change → `409` with current fingerprint. Schema/version change invalidates candidates. Schema unavailable: reads continue; simulate/apply fail closed.

Invalid current: load still `200` with exact text + diagnostics. Candidate validity governs Apply. Schema-invalid but parseable current repairs normally. Unparseable current repairs only when Companion can be proven unchanged.

Watcher roots (authorized only): user config dir exact OMO basename; project root only for `.opencode` creation; project `.opencode` exact basename; installed schema + sibling package manifest. Coalesce 100 ms. Event `config.sources.changed` includes fingerprints, schema identity, `ownApply`, and `ownApplyBySource`. Prefer per-source `ownApplyBySource`.

---

## Monaco / schema integration (web contract)

Locally bundled `monaco-editor` + `@monaco-editor/react`. No CDN.

- Model URIs: `file:///omo-control/{user\|project}/oh-my-opencode-slim.json[c]`
- Schema URI: `inmemory://omo-control/schema/oh-my-opencode-slim@<version>-<hash>.json`
- Register installed schema only when cache key / selected format changes.
- Backend validation remains authoritative. Monaco is interactive feedback.
- No formatter, autosave, code action, or AI action.

---

## Diffs and Live independence

Preview reports bounded source / Desired / Effective / provenance / semantic summaries. Exact full text remains available up to the candidate cap. Live runtime is unchanged until OpenCode reloads configuration (`liveUnchangedNote`). Interview/raw paths perform no process spawn, browser open, Interview server start, port probe, OpenCode lifecycle, model probe, or output-folder inspection.

---

## Revisions

Raw metadata kind: `Raw OMO configuration edit`. Historical invalid revisions remain inspectable; `currentSchemaCompatible: false` and restore is blocked. Restore is current-schema + fingerprint + candidate SHA guarded. Recover pending revisions before reads/lists/restores.

---

## Doctor deep links

| Diagnostic | Target |
|---|---|
| Invalid user OMO schema | `/config?tab=raw&sourceId=user-omo&path=<firstIssuePath>` |
| Invalid project OMO schema | `/config?tab=raw&sourceId=project-omo&path=<firstIssuePath>` |
| Installed schema unavailable | `/system?section=schema` |
| Invalid Interview field | `/config?tab=raw&sourceId=<winner>&path=interview.<field>` |
| Pending revision conflict | `/config?tab=revisions&sourceId=<id>` |

No duplicate validation engine — Doctor consumes the same installed-schema status used by writers.

---

## Current top-level coverage matrix

Generated from the live installed schema by `bun run audit:omo-schema` (not a conceptual example).

| Field | Coverage | Notes |
|---|---|---|
| `preset` | Structured + Raw | Preset inventory / switch |
| `setDefaultAgent` | Structured + Raw | Global |
| `compactSidebar` | Structured + Raw | Harmless System/raw field |
| `stripOrchestratorModel` | Structured + Raw | Global |
| `autoUpdate` | Structured + Raw | Global |
| `presets` | Structured + Raw | Template `presets.<name>.<agent>.*`; `options` bag is Raw only |
| `agents` | Structured + Raw | Template `agents.<name>.*`; `options` bag is Raw only |
| `disabled_agents` | Structured + Raw | Protected: orchestrator, councillor |
| `image_routing` | Structured + Raw | `auto` \| `direct` |
| `disabled_mcps` | Structured + Raw | |
| `disabled_tools` | Structured + Raw | |
| `disabled_skills` | Structured + Raw | |
| `multiplexer` | Structured + Raw | Four installed fields; no runtime pane control |
| `interview` | Structured + Raw | Typed editable when version/hash/source audit match |
| `backgroundJobs` | Structured + Raw | Nine installed fields |
| `fallback` | Structured + Raw | Nested `runtimeOverride` is Deprecated |
| `council` | Structured + Raw | `presets` required by schema; member object is open |
| `companion` | Read-only intentionally | Intentionally not developed further |
| `webfetch` | Structured + Raw | `enabled`, `model` |
| `acpAgents` | Structured + Raw | Template `acpAgents.<name>.*` |

Absent from the current installed schema (catalog only, unsupported): `showStartupToast`. Deprecated nested: `fallback.runtimeOverride`. Reserved/legacy: `council.master*` (not a current schema leaf).

Classifications used by the auditor: `typed-editable`, `raw-editable`, `read-only-companion`, `unsupported-installed-version`, `deprecated`, `runtime-limited`. Current 2.2.10 has no `runtime-limited` current schema leaf.

---

## Intentional remaining gaps

- Companion writes and Companion lifecycle.
- Raw OpenCode `opencode.json` / provider / auth / server / plugin editing (bridge registration remains its own domain).
- Prompt-file editing is a separate writer (`cfgwrite/prompts.ts`), not the raw OMO workspace.
- Runtime Interview server / browser / port / model-probe / OpenCode restart from Interview or raw Apply.
- Runtime multiplexer pane control.
- Runtime preset observability (OpenCode does not expose `/preset` selection).
- Historical revisions restoreable only when compatible with the **current** installed schema.
- **Live reversible browser proofs** for Interview apply/restore, raw harmless-field apply/restore, and invalid-candidate non-apply. Procedure below; evidence is **not** recorded in this document.

---

## Controlled verification procedure (placeholders)

Use `agent-browser` only against an already-running operator-opened Control Plane. Do not start the app or launch a browser from configuration behavior.

1. Record user source hash, format, byte length, schema version/hash, revision count. Do not copy source/secrets.
2. System → Interview: valid `maxQuestions` Preview (`restartRequired:true`, `runtimeAction:none`) → Apply once → network allowlist Interview simulate/apply only.
3. Restore via OMO revision UI; final hash/length must equal baseline.
4. Config → Raw: change a harmless structured field (e.g. `compactSidebar`), Preview, Apply, confirm System refresh, restore exact baseline.
5. Draft-only invalid standalone model object: Monaco + server Preview error, Apply disabled, hash unchanged, discard/reload.
6. Unexpected fingerprint change → Compare/Reload only; never force-overwrite.

Evidence location (parent/verifier): `.slim/deepwork/slice-18-live-browser-verification.md` and `.slim/deepwork/evidence/slice-18/`. This architecture document does **not** claim those proofs are complete.

Automated command log: `.slim/deepwork/slice-18-automated-validation.md`.

---

## Implementation map

| Area | Paths |
|---|---|
| Installed authority | `apps/server/src/omo-schema/{authority,introspect,validator,coverage}.ts` |
| Transaction | `apps/server/src/cfgwrite/transaction.ts` |
| Interview | `apps/server/src/cfgwrite/{interview,interview-routes}.ts`, `apps/server/src/omo/interview.ts` |
| Raw / watcher / revisions | `apps/server/src/cfgwrite/{raw,raw-routes,source-watcher,revisions}.ts` |
| Shared contracts | `packages/shared/src/{index,interview-contract-fixture,raw-contract-fixture}.ts` |
| Audit | `scripts/audit-installed-omo-schema.ts`, `bun run audit:omo-schema` |
| Catalog | `apps/server/src/omo/catalog.ts` |
