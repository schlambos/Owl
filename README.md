# OMO Control Plane

Local engineering control plane for **OpenCode** + **Oh My OpenCode Slim**.

Product model: **Desired → Effective → Live**.

See `PLAN.md` for full scope. Recon notes live in `docs/recon/`.

## Status

**Slice 1 (read-only):** backend + minimal UI for health, providers/models, agents (desired/effective/live), and session trees.

**Slice 2 (live SSE):** in-memory runtime store bootstrapped from REST, updated from OpenCode `GET /event`, exposed to the browser via `GET /api/events`. See `docs/architecture/11-sse-runtime-slice.md`.

**Slice 3 (session inspector):** split Sessions workspace with deep detail — messages, tool activity, diff, permissions, parent/child nav, Desired/Effective/Live model compare. See `docs/architecture/12-session-inspector-slice.md`.

**Slice 4 (provenance + prompts):** field-level Desired→Effective provenance, prompt file discovery/composition, Config workspace. See `docs/architecture/13-provenance-prompts-slice.md`.

**Slice 5 (safe writes):** agent model + variant mutations with JSONC-preserving atomic writes, simulate/apply, SQLite revisions, restore. See `docs/architecture/14-safe-config-writes-slice.md`.

**Slice 6 (capabilities):** temperature, skills, MCPs, permissions + capability matrix. See `docs/architecture/15-agent-capabilities-slice.md`.

**Slice 7 (prompts):** inline/orchestratorPrompt + prompt-file create/edit/delete with composition preview. See `docs/architecture/16-prompt-editing-slice.md`.

**Slice 8 (presets):** inventory, comparison, runtime-switch impact, create/clone/rename/delete lifecycle. Runtime preset observability documented as not exposed. See `docs/architecture/17-presets-slice.md`.

**Slice 9 (system):** global OMO config — disabled lists, backgroundJobs, fallback, image_routing, stripOrchestratorModel, UI/startup, option coverage matrix. See `docs/architecture/18-global-system-config-slice.md`.

**Slice 10 (council):** councillor presets lifecycle, member model/variant/prompt, coordinator separation, runtime session visibility. See `docs/architecture/19-council-slice.md`.

**Slice 11 (ACP):** external ACP agents — lifecycle, command/args/env/cwd/wrapperModel/permissionMode/timeout editing, command probing, explicit handshake probe, secret-safe revisions. See `docs/architecture/20-acp-agents-slice.md`.

**Slice 12 (Doctor):** unified rule-based diagnostics across all subsystems with stable IDs, evidence, severity policy, prerequisite gating, and a `GET /api/doctor` consolidation + Doctor workspace. Includes correction of a fabricated builtin-agent roster entry found by Doctor itself. See `docs/architecture/21-doctor-consolidation-slice.md`.

**Slice 13 (Companion + Interview inspection):** read-only subsystem support with installed-source-verified schemas (8 companion fields incl. gifPack/loopStyle/speed/debug; 5 interview fields), effective/provenance resolution, scope-guarded binary path display (never inspected outside authorized roots), non-inspected output paths, honest runtime non-observability, conservative Doctor categories, option-capability matrix (readable/resolved/provenance/editable/runtime-observable/runtime-controllable/doctor), System UI subsections, `/api/system/companion` and `/api/system/interview`. No subsystem launched. See `docs/architecture/22-companion-interview-inspection-slice.md`.

**Slice 14 (OMO runtime telemetry):** source-verified feasibility audit of installed OMO state (closure/module/globalThis/REST-reachable classification), patch-free two-track bridge — derive track from persisted OpenCode task-tool parts (jobs, workers, statuses, resume evidence) + opt-in in-process bridge plugin for the four globalThis registries (fallback in-flight, wake gate, multiplexer, cmux). Versioned schema (v1), whitelisted security, graceful absence, Sessions/Inspector/Agents/Overview/Doctor integration, 224+19 tests. See `docs/architecture/23-omo-runtime-telemetry-slice.md`.

**Slice 14.5 (agent editor remediation):** makes agent-model reassignment a real Agents-workspace workflow. Root cause: Slice 5 backend + minimal modal existed, but free-text-first selection, incomplete chain seeding (fallback collapse), provenance-ignorant destination defaults, and missing detail-panel Edit made the product path unusable. UI rewrite reuses existing simulate/apply/revision/provenance/providers APIs; catalog-first provider→model cascade; ordered fallback chain with per-entry variants; explicit write destination; masked-write explanation; revision restore; web component tests (8). Live browser Explorer reassignment + restore verified. See `docs/architecture/24-agent-editor-remediation.md`.

**Slice 15 (model availability, entitlement probing, provider diagnostics, agent-assignment validation):** explicit-only minimal-inference model probes through isolated tagged OpenCode sessions (deny-all permissions, 20s hard deadline, `provider\0model`-deduped queue with freshness skip and tiered batch guards); sanitized SQLite probe history with retention, startup finalization, and degraded-overlay persistence; deterministic capability composition (known/partial/unknown with a source-authority freeze on invented fields); composite provider diagnostics; probe-aware Doctor rules (Orchestrator escalation, provider-down root-cause dedup, capability mismatch, unadvertised advisories) plus a model-health roll-up; Models workspace inventory UI and probe badges across Agents/Council/ACP surfaces with non-blocking [Test] actions. Adjunct: `providerModelRules` single-sourced on the shared usage map; probe sessions excluded from every default surface with explicit opt-in. 353+31 tests. See `docs/architecture/25-model-probing-provider-diagnostics.md`.

**Slice 16 (multiplexer configuration & read-only runtime visibility):** source-authority documentation of the installed `multiplexer` schema (four fields, exact enums/ranges/defaults), user/project deep-merge provenance, auto-detection factory order with env-only signals, static `command -v` allowlist, per-backend layout semantics, legacy top-level `tmux` ignored/not-aliased, optional telemetry bridge v1/v2 with exact whitelisted store fields (no directory/owner/timestamps/promises), OMO job→child-session→pane correlation with 60s authoritative grace, typed `GlobalMutation` writes through simulate/apply/revision/restore, conservative Doctor rules, and read-only UI surfaces (System → Multiplexer, Session Inspector, OMO Jobs, Agents/Overview summary, Doctor deep-links). No runtime control, no pane create/delete/focus/move/rename/attach/detach/kill/capture/scrollback, no Companion/Interview writes. 515+138 tests, typechecks/build clean. See `docs/architecture/27-multiplexer-slice.md`.

**Side slice (Agents assignment UI / IA, critic-approved redesign):** the Agents workspace is an assignment-first control surface with exactly five columns (Agent | Assignment | Source | Signals | Actions). Assigned / Effective / Live are user-facing; identical layers compress to one quiet line; assignment override vs runtime drift expand as distinct states; the agent-name button opens a true-modal detail drawer (focus-trapped, inert background, URL-synced); adverse model health covers primary + fallback probes; ownership routes link council/ACP/native rows to their workspaces; filter/search/sort/selection state lives in the URL. Frontend-only — no mutation/schema change. Slice 16 remains paused. See `docs/architecture/28-agents-ui-redesign.md`.

**Slice 26 (schema-safe config writes remediation):** installed-`oh-my-opencode-slim` JSON Schema (draft 2020-12) loaded dynamically from `node_modules` (version+sha256-cached AJV compiler, auto-recompile on package/schema update) plus supplemental dist-evidence parity checks (`parity.ts`); every OMO JSON writer validates the FULL candidate document twice (post-mutation pre-temp-write, post-reread pre-rename) — no invalid candidate reaches the atomic rename, no successful revision is created, failure → HTTP 422 (distinct from 409/400); schema unavailable → ALL writes fail closed (reads continue). Canonical `serializeOmoAgentModel` (1 entry → string + sibling variant, 2+ → ordered array; never standalone object, never one-element array); `agent-model` payload now always `ModelChainEntry[]`. Revision restore validates historical content against the CURRENT installed schema and blocks incompatible restores. `GET /api/omo/schema` status; web preview "OMO-Slim schema validation ✓/✕" with Apply gated on candidate validity; global banner for current-config-invalid (repair edits still possible); System schema-health panel; Doctor `config.schema` rule with capped ≤50-revision incompatibility audit. Root cause: UI `serializeEntry` + `buildModelMutation` 1-entry collapse emitted standalone `{id, variant}` for `agents.critic` → installed 2.2.10 rejected entire config at startup; tolerant `normalizeModelField` masked the violation. 373+37 tests. Live critic-chain apply + restore verified (sha256-exact, doctor exit 0). See `docs/architecture/26-schema-safe-config-writes-remediation.md`.

**Slice 17 (telemetry bridge activation):** safe managed registration/removal/restart pipeline for the optional `packages/omo-telemetry-bridge` OpenCode plugin. The control plane writes the bridge plugin entry to `opencode.json`/`opencode.jsonc` via atomic JSONC byte-patch revisions, then requires an explicit dashboard-owned restart to load/unload it. Two-step workflow: preview → apply (no runtime action), then separate `POST /api/opencode/bridge/restart` with `confirmation: "restart-owned-bridge"` and generation/hash/revision guards. Managed loopback port range `8788..8803`; never kills existing listeners; activation nonce is reduced to a SHA-256 fingerprint in all DTOs/events/logs; the raw nonce exists only inside the synchronous launch-boundary scope. API routes under `/api/opencode/bridge/*`; SSE event `telemetry-bridge.updated` on `/api/events`; web UI in System → Telemetry Bridge. Probe endpoint returns `501 bridge-probe-inapplicable`; tuple plugin specs are recognized but the management path uses the env/string foundation fallback. Validation: server 824 pass / 0 fail, web 163 pass / 0 fail, focused telemetry UI 25 pass / 0 fail, repo typecheck all exit 0. **Critical limitation:** no live config mutation, no live managed-runtime restart, and no real bridge connection probe/activation were performed. See `docs/architecture/evidence/telemetry-bridge-activation/manifest.md`.

**Managed OpenCode runtime (backend lifecycle remediation):** `bun run dev` is now the default one-command workflow (server + frontend under a single signal-coordinating supervisor). The control plane owns the OpenCode backend lifecycle in Managed mode (default) — it probes `:4096`, reuses a compatible preexisting backend, or starts one via the installed SDK (`createOpencodeServer`), and cleanly stops the owned backend on shutdown. Attach mode (`OPENCODE_BASE_URL`) never owns/stops the external server. No separate `opencode serve` prerequisite. See `docs/architecture/30-managed-opencode-runtime.md`.

**Slice 18 (configuration completion):** typed Interview writes for the current installed five-field set (version/hash/source gated), a schema-aware raw OMO workspace on logical `user-omo` / `project-omo` sources only, one physical OMO JSON transaction, OMO revisions, Doctor deep links, and `bun run audit:omo-schema` coverage of the live installed schema. System coverage: **Interview is editable** (when the installed audit matches); **Companion is read-only / intentionally not developed further**. Live reversible browser proofs are not claimed in-repo until the parent/verifier records them. See `docs/architecture/32-configuration-completion.md`.

## Quick start

Prerequisites: Bun, `@opencode-ai/sdk@1.18.14` installed under the active OpenCode config dir (`~/.config/opencode/node_modules`), and OMO-Slim installed in that config.

```bash
bun install
bun run dev
```

`bun run dev` starts both the server and the frontend under a single supervisor that forwards SIGINT/SIGTERM so the server can shut down cleanly and close its owned OpenCode backend. It does **not** spawn `opencode serve`.

- UI: http://127.0.0.1:5173  
- API: http://127.0.0.1:8787/api/overview  
- Runtime: http://127.0.0.1:8787/api/runtime  
- Live events: http://127.0.0.1:8787/api/events  
- Lifecycle: http://127.0.0.1:8787/api/opencode/lifecycle  

### OpenCode backend modes

The control plane selects how it talks to the OpenCode backend based on `OPENCODE_BASE_URL`:

| Mode | When | Behavior |
|------|------|---------|
| **Managed** (default) | `OPENCODE_BASE_URL` unset | The control plane owns the OpenCode backend lifecycle. It probes `127.0.0.1:4096`, reuses a compatible preexisting backend if found, or starts one via the installed SDK (`createOpencodeServer`). It owns, restarts, and stops the backend it started. No separate `opencode serve` is required. |
| **Attach** | `OPENCODE_BASE_URL=http://host:port` | The control plane attaches to that explicit external OpenCode server and **never** owns, starts, stops, or replaces it. Loss of the external backend is a terminal failure with Retry, not a restart. |

```bash
# Managed (default): control plane owns the backend
bun run dev

# Attach: use an already-running OpenCode server (e.g. opencode serve)
OPENCODE_BASE_URL=http://127.0.0.1:4096 bun run dev
```

The actual canonical backend URL (which may be an OS-selected alternate loopback port if `:4096` is occupied) is reported by `GET /api/opencode/lifecycle` as `baseUrl`. Use that URL to attach the OpenCode TUI to the same runtime:

```bash
opencode attach <managed-url-from-/api/opencode/lifecycle>
```

> **Warning:** Plain `opencode` (without `attach`) starts the TUI with its own embedded OpenCode runtime, which is independent of the backend the control plane manages. Use `opencode attach <url>` to work in the same runtime.

See `docs/architecture/30-managed-opencode-runtime.md` for the full lifecycle state machine, restart policy, and verification procedure.

### Separate processes

If you prefer hot restart on the server, run the two halves separately (the server's own `dev` script uses `--watch`):

```bash
bun run dev:server   # http://127.0.0.1:8787 (with --watch)
bun run dev:web       # http://127.0.0.1:5173
```


## Filesystem scope

This project only reads:

1. `~/Repos/omo-slim`
2. Active OpenCode config dir (`~/.config/opencode` or `OPENCODE_CONFIG_DIR`)

Runtime session metadata may reference other paths; those paths are not opened.
