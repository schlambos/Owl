# Slice 26 — Schema-Safe Config Writes Remediation

**Date:** 2026-08-12
**Status:** Implemented. Every OMO JSON write now validates the full candidate document against the **installed** `oh-my-opencode-slim` JSON Schema (draft 2020-12) plus supplemental dist-evidence parity checks, fail-closed. No invalid candidate can reach the on-disk atomic rename.

## Incident

The control plane wrote an invalid standalone model object for `agents.critic`:

```json
"model": {"id": "xai/grok-4.5", "variant": "xhigh"}
```

Installed `oh-my-opencode-slim@2.2.10` rejected the **ENTIRE** config at startup ("Config invalid / Run doctor for details"; doctor: "Invalid input → at `agents.critic.model`"). Configured built-in agents fell back to defaults in the UI. Manual repair to `"model": "xai/grok-4.5"` + `"variant": "xhigh"` (string + sibling) restored validity.

## Root cause (multi-layer)

1. **UI** — `apps/web` `AgentEditModal.serializeEntry` emitted `{id, variant}` for any entry with a variant, and `buildModelMutation` collapsed a 1-entry chain to a bare entry → the client sent `model: {id, variant}` standalone.
2. **Server** — `cfgwrite/mutate.ts` `modelToJsonValue` wrote the standalone object verbatim (now deleted).
3. **Shared DTO ambiguity** — `ModelChainEntry` / `ModelRef` typed the object form as legal for a standalone agent model; the schema only permits it INSIDE a fallback array.
4. **Tolerant readers** — `normalizeModelField` (`omo/loader.ts`, `provenance.ts`) accepted the invalid shape, masking the violation.

## Installed-schema model forms (authoritative: `oh-my-opencode-slim@2.2.10`)

- **Single model:** `"model": "provider/model"` + optional sibling `"variant": "high"`.
- **Fallback chain:** `"model": ["a/x", "b/y"]` or `[{"id":"a/x","variant":"high"}, ...]` or mixed; min 1 entry.
- **Standalone `{id, variant}` object is INVALID** — never emit.
- **Agent-level `variant` is an INDEPENDENT sibling property.** Evidence: installed `dist/index.js:20001-20029` (`applyOverrides`): agent-level variant only sets `agent.config.variant` (primary dispatch); it is NOT applied as a default to chain entries (that behavior is council-only, `normalizeCouncillorModels` `dist:18550-18553`). Entry variants live in the array and are independent.
- One-element arrays are schema-valid, but the control plane canonicalizes single-model to string + sibling variant.
- **Single→multi transition:** prior agent-level variant is preserved unchanged (independent). **Multi→single:** the surviving entry's variant is promoted to the sibling `variant` property.

## Canonical serializer

`apps/server/src/omo/model-serializer.ts` — `serializeOmoAgentModel(chain)`:

- 1 entry → `{model: "<id>" string, promotedVariant}` (caller emits the sibling variant edit).
- 2+ entries → ordered array (string for variant-less entries, `{id, variant}` otherwise).
- **NEVER** a standalone object, **NEVER** a one-element array.

The `agent-model` mutation payload is now **always** `ModelChainEntry[]`. The server tolerantly normalizes legacy non-array payloads at the boundary.

## Installed-schema validation service (fail-closed)

`apps/server/src/omo-schema/` (`loader.ts`, `validator.ts`, `parity.ts`, `errors.ts`, `types.ts`):

- Loads the schema **dynamically** from `{opencodeConfigDir}/node_modules/oh-my-opencode-slim/` — `package.json` (version) + `oh-my-opencode-slim.schema.json` (draft 2020-12). **Not** copied into source.
- AJV via `ajv/dist/2020.js` (`allErrors`, `strict:false`, `validateSchema:false`); compiled validator cached keyed by `version:sha256(schemaBytes)`; files re-read per call so a package/schema update automatically invalidates and recompiles.
- Schema unavailable (missing/unreadable/uncompilable) → **ALL** config writes fail closed ("Cannot validate generated OMO configuration against installed schema. No write performed."); reads continue.
- Structured errors → `SchemaValidationIssue { path (dot), keyword, message, expected?, received? }` (capped).
- `parity.ts`: supplemental dist-evidence checks beyond the JSON Schema — `orchestratorPrompt`-on-orchestrator superRefine (`dist:18865-18877`), council preset member model format (`CouncillorModelSchema`, `dist:18556-18564` / `18578-18605`). Marked version-scoped like `omo/catalog.ts`.

## Validation points in the write pipeline

Every OMO JSON writer (agent mutations `mutate.ts`, `globals.ts`, `council.ts`, `acp.ts`, `presets.ts` via `applyPresetEdit`, revision restore `mutate.ts`) validates the **FULL** candidate document:

1. After in-memory mutations, **before** temp write.
2. After temp write + re-read, **before** atomic rename.

No invalid candidate can reach rename; no successful revision is created; failure → **HTTP 422** (distinct from 409 hash-conflict / 400 other). Simulate returns `schemaValidation` in `SimulationResult`; Apply revalidates independently (no simulate-cache trust). Revision restore validates the historical content against the **CURRENT** installed schema and blocks incompatible restores. Prompt `.md` writes are out of OMO JSON schema scope.

## Doctor integration

New `config.schema` rule (`rules-core.ts`):

- Schema unavailable → **warning** (writes blocked).
- User config invalid → **ERROR** with first issue paths + remediation.
- Project config invalid → error.
- Valid → ok with installed version.
- Capped informational audit of latest ≤50 revisions: counts historical revisions incompatible with current schema (restore will be blocked; revisions never mutated).

## APIs & UI

- `GET /api/omo/schema` → `OmoSchemaStatus { available, packageVersion, schemaPath, schemaHash, userConfig/projectConfig { present, valid, issues } }`.
- **Web:**
  - `AgentEditModal` always sends the chain as an array.
  - Preview shows "OMO-Slim schema validation ✓/✕" with issue paths (raw details expandable).
  - Apply disabled on schema-invalid candidates.
  - Global banner when the current config is schema-invalid (repair edits still possible — Apply gates on the candidate, not the current file).
  - System → Schema health panel (installed version, schema loaded, user/project config validity).
  - `DoctorPage` category filter unions server-emitted categories.

## Mutation families audited

`agent-model` / `variant` / `temperature` / `skills` / `mcps` / `permission` / `capabilities` / `inline-prompt` / `orchestrator-prompt` (`mutate.ts`), `globals`, `council` (member model validates array/string only — safe), `ACP` (`wrapperModel` string-only regex — safe, NOT run through the agent serializer), `presets` (raw deep-copy clone preserved), revision restore (raw text + schema gate), prompt-file (`.md` only).

## Regression tests

`bun test apps/server`: **373 pass / 0 fail**. Coverage:

- Exact incident regression (`typeof model === "string"` + sibling variant, not object / not array).
- Standalone-object rejection with path `agents.critic.model`.
- Valid object/string/mixed chains.
- One-entry collapse.
- Multi→single & single→multi transitions.
- Full-candidate validation.
- Unrelated invalid field fails apply.
- JSONC comment preservation.
- Simulate + apply independent rejection.
- Schema-missing fail-closed.
- Schema-version-change reload.
- Restore-invalid-revision blocked (file untouched, no new revision).
- Failure-injection end-to-end (file bytes unchanged, no successful revision).
- Doctor `config.schema` diagnostics.

Mechanics tests use synthetic schemas under `apps/server/test/schema-sandbox/`; correctness tests use the real installed schema (skip gracefully if absent).

**Web:** **37 pass / 0 fail** (always-array payload, schema-invalid preview gates Apply, banner, schema panel).

## Live verification (controlled, reversible)

Against the real user config:

1. `GET /api/omo/schema` → valid (2.2.10).
2. Simulated + applied critic chain `[{id:"xai/grok-4.5",variant:"high"}]` → live file had `"model": "xai/grok-4.5"` (string) + `"variant": "high"` (sibling).
3. Control-plane validator ✓.
4. `bunx oh-my-opencode-slim doctor` ✓ (exit 0).
5. Restored via revision restore → sha256 matched original exactly, variant back to `xhigh`, doctor ✓.
6. Orchestrator untouched.

## Historical revisions

Audit of `data/control-plane.db` (26 revisions): `rev_msqa5mp1_temzdb` (`after_content`) and `rev_msqa654u_q0aynq` (`before_content`) contain the invalid standalone-object shape. Left unmodified; restore of these is now blocked by the schema gate; surfaced via the capped Doctor revision audit.

## Limitations

- Agent-level `variant` uses zod `.catch(undefined)` in the installed plugin (non-string variant silently dropped); the control-plane AJV validator is stricter (rejects) — fail-closed direction, noted.
- JSON Schema does not express every zod behavior (root strip-mode, council transform semantics); `parity.ts` covers the write-relevant gaps with dist evidence; a future OMO version bump requires re-deriving parity checks + catalog (same process as 2.2.10).
- Normal write path does not shell out to `bunx oh-my-opencode-slim doctor`; in-process AJV + parity validation is the gate (doctor used as external cross-check during verification only).

## Out of scope (honored)

No new mutation families, no schema copy into source, no automatic OMO version bump, no prompt-`.md` schema gating, no historical revision mutation.