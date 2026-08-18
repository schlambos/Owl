# Slice 15 — Model Availability, Entitlement Probing, Provider Diagnostics, Agent-Assignment Validation

**Date:** 2026-08-12
**Status:** Implemented. Probing is **explicit-only** — no automatic scheduled probing, ever. All probe results are persisted sanitized; response text is never stored.

## OpenCode model surfaces used (1.18.14)

| Endpoint | Use | Cadence |
|---|---|---|
| `GET /config/providers` | Routine catalog: models + whitelisted `capabilities` / `limit` / `cost` / `status` metadata | Reconcile + provider-catalog SSE events |
| `GET /provider` | **Connected-provider authority** (`connected[]`, `default` model map) — ~4.6MB payload | Bootstrap, reconnect after OpenCode-down, provider-catalog/integration SSE events only. **Never per-request.** Routine catalog refreshes MERGE against this cached connected set |
| `GET /provider/auth` | Auth **method metadata** (`{type,label}[]` per provider) — never auth state, never credentials | On-demand inventory composition only |
| `POST /session` + `POST /session/{id}/message` | Synchronous probe invocation (see below) | Explicit probe jobs only |
| `POST /session/{id}/abort` | In-flight probe cancellation (cancel/timeout) | Best-effort cleanup |
| `DELETE /session/{id}` | Probe session disposal | Best-effort cleanup |

`/experimental/tool/ids` is **global-only** in 1.18.14 — there is **no per-model tool introspection endpoint**. Per-model toolIds therefore permanently stay `undefined` (see Capabilities).

## State machine realization

Seven conceptual availability stages map onto **distinct DTO fields** rather than one overloaded enum (`ModelAvailability`):

| Conceptual stage | DTO realization |
|---|---|
| Configured / referenced | `configured` + `usage: ModelUsageReference[]` (kind/owner/active/fallback) |
| Provider known / connected | `provider.known` (in OpenCode catalog) / `provider.connected` (`/provider` authority) |
| Advertised | `advertised` (model in provider catalog) |
| Entitled / callable | `probe.state === "healthy"` — a real completed call succeeded |
| Probe evidence | `probe` summary + persisted `model_probe_runs` history |
| Compatibility | `capabilities` (tools/vision/reasoning + state + `source`) |
| Healthy now | fresh healthy — `probe.state === "healthy"` AND `freshness === "fresh"` |

`probe.state` union: `never | running | healthy | unauthorized | model-not-found | rate-limited | timeout | provider-disconnected | opencode-disconnected | malformed | error`. Rationale: state is orthogonal to configuration/advertisement/connectivity — collapsing them into one enum would lose information (e.g. a referenced-but-unadvertised model CAN still be healthy).

## Probe invocation mechanism

Single-probe execution (`apps/server/src/models/probe-engine.ts`, driven through the injectable `OpenCodeProbeGateway`):

1. **Preflight** — provider must be in the connected authority set; otherwise terminal `provider-disconnected` with **NO session created, no tempdir**. Captures `advertisedAtProbe`, `providerConnectedAtProbe`, `opencodeVersion`.
2. **Isolated `mkdtemp` temp directory** (`omo-cp-probe-*`, own directory only — never touches other sessions or dirs).
3. Persisted `running` row (`insertRunning`).
4. `POST /session` — title `"[OMO CP Probe] {providerId}/{modelId}"`, metadata `{"omo.control-plane.probe": true}`, deny-all `PermissionRuleset` `[{permission:"*",pattern:"*",action:"deny"}]`. No project-config fields.
5. `POST /session/{id}/message` — **synchronous** (deliberately NOT `prompt_async`: a probe is a single bounded operation; synchronous gives deterministic classification without SSE correlation). Body: fixed prompt `"Respond with: OK"`, `tools: {}`.
6. Hard deadline `PROBE_TIMEOUT_MS = 20_000` — a **hard-coded control-plane constant**, never user-configurable, never written into OMO/OpenCode config. Firing aborts the run's own `AbortController`.
7. Outcome normalization (below), end-to-end latency `started→terminal`.

**Healthy predicate** (callability, not instruction following): HTTP 200 + `info.role === "assistant"` + no `info.error` + non-empty `parts`. A reply of "OK." is still healthy. `responseModel` extracted from `info.modelID` when present. **Response text never persisted** — only the sanitized summary record.

Success path: terminal write, then best-effort `DELETE /session/{id}` + tempdir removal. Termination routine (shared by cancel + timeout): abort own controller → best-effort `POST abort` → best-effort `DELETE session` → remove own tempdir → persist terminal. Cleanup failure NEVER overrides the outcome; the terminal latch guarantees exactly one terminal write.

## Isolation + tagging

`runtime/probe-sessions.ts` classifier: metadata key `omo.control-plane.probe === true` (authoritative) OR exact title prefix `[OMO CP Probe] ` (human-visible fallback). Probe sessions are excluded **by default** from: `RuntimeStore.getSnapshot()/getRuntimeState()/buildSessionsDto`, `/api/sessions`, agent session counts, overview totals, `OmoRuntimeStore.selectSessions` (Slice-14 job scanner, defense-in-depth re-classification included), and Doctor session inputs. Opt-in: `/api/sessions?includeControlPlaneProbes=1` and the Sessions UI "Show control-plane probe sessions" toggle (default off; "CP probe" pill rendering; selection safely resets when the view excludes a selected probe session).

## Queue

In-memory (`models/probe-queue.ts`): concurrency 2 workers; max 100 pending; dedupe key `providerId\0modelId` across pending+running; **explicit submit only** (nothing auto-enqueues). 503-style rejection (`opencode-unavailable` / `probe-store-degraded`) when OpenCode REST is disconnected or the probe store is degraded. Non-force submit skips when the latest persisted probe is fresh (`{skipped:"fresh", latest}`); active duplicates return the existing job ref. Batch guards: **≤25 normal; 26–100 requires `force:true` AND `acknowledgeLargeBatch:true`; >100 rejected with 400**. Cancel: pending job removed; running job → termination routine with terminal `error`/`aborted` (`"Probe aborted by user"` — never confused with timeout); terminal id → 409; unknown id → 404. Every queue state change emits SSE `model-probes.updated` and `doctor.invalidate()` on terminal events (the `/api/doctor/recheck` path stays inference-free — invalidation only recomputes from persisted data).

## Error normalization (authoritative 9-step order)

`models/probe-normalize.ts`, pure:

1. Control-plane deadline fired → `timeout`
2. User cancel → `error`, code `aborted`, `"Probe aborted by user"`
3. Transport failure/refusal/loss mid-probe → `opencode-disconnected`
4. Provider preflight disconnected (before session creation) → `provider-disconnected`
5. True non-200 from create/prompt: `404 → model-not-found`, `401/403 → unauthorized`, `429 → rate-limited`, other → `error` (`statusCode` recorded)
6. HTTP 200 + healthy predicate → `healthy` (+ `responseModel`)
7. HTTP 200 + `info.error` present (AssistantMessage error union from `.opencode-openapi.json`): `ProviderAuthError → unauthorized`; `APIError` with `data.statusCode` `401/403 → unauthorized`, `404 → model-not-found`, `429 → rate-limited`, else → `error`; `MessageAbortedError → error`/`aborted`; other union names → `error`; unparseable → `error` (raw payload never embedded)
8. HTTP 200 failing the predicate without an error → `malformed`
9. else → `error`

**Sanitization** (before any persistence): bearer/token-shaped secrets and `name=value` credential pairs redacted, URL query strings/fragments stripped, whitespace collapsed, 240-char cap.

## Persistence

`models/probe-store.ts` on `bun:sqlite`, shares `data/control-plane.db` with the RevisionStore (same DB, own table):

```sql
CREATE TABLE IF NOT EXISTS model_probe_runs (
  id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
  started_at TEXT NOT NULL, completed_at TEXT,
  state TEXT NOT NULL CHECK (state IN ('running','healthy','unauthorized','model-not-found',
    'rate-limited','timeout','provider-disconnected','opencode-disconnected','malformed','error')),
  latency_ms INTEGER, status_code INTEGER, error_code TEXT, error_message_sanitized TEXT,
  response_model TEXT, opencode_version TEXT,
  advertised_at_probe INTEGER NOT NULL CHECK (advertised_at_probe IN (0,1)),
  provider_connected_at_probe INTEGER NOT NULL CHECK (provider_connected_at_probe IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_model_probe_runs_lookup
  ON model_probe_runs(provider_id, model_id, completed_at DESC);
```

- **Retention:** terminal write + retention in the SAME transaction — newest 50 COMPLETED runs kept per (provider,model); running rows never counted or evicted.
- **Startup finalization** (`finalizeAbandonedRuns`, before the queue accepts jobs): rows left `running` by a previous process → `opencode-disconnected`, `error_code: "control-plane-restarted"`, `latency_ms` stays NULL (no fabricated latency).
- **Degraded mode:** a failed terminal write marks the store degraded, keeps the terminal result in an in-memory overlay map (superseding the leftover persisted running row by id), logs a server warning; reads compose persisted + overlay; enqueue rejects 503 while degraded. DB file-open failure at construction falls back to in-memory + degraded-from-birth.
- Sanitized fields only — never prompt text, response text, tokens, credentials.

## Freshness

`PROBE_FRESHNESS_MS = 24h`, a UX-only threshold: `fresh` within 24h of `lastCompletedAt`, `stale` beyond, `never` without a completion. **Stale ≠ unhealthy** — Doctor never warns on stale or never-probed; the UI renders freshness as a separate label ("stale" / "14m ago"), never colored as health.

## Provider diagnostics

`ProviderDiagnostics` is **composite, never binary**: `connected` (authority), `advertisedCount`, `referencedCount` (usage map), `authMethods` (`/provider/auth` metadata only), `lastSuccessfulProbeAt` (all-time healthy), `recentFailureCounts` (per terminal state, last 24h of completed rows), `recentRateLimitCount`. A provider with 3 models where one is rate-limited and one entitles is representable; nothing forces a single pass/fail color.

## Capabilities

Deterministic rule (`models/inventory.ts`): `known` = advertised WITH a capabilities object → `tools ← toolcall`, `vision ← input.image`, `reasoning ← reasoning`; `partial` = advertised without capabilities; `unknown` = unadvertised. `source` recorded per model (`opencode:/config/providers` / `opencode:/provider` / `none`). `structuredOutput` and `toolIds` are **always `undefined` in 1.18.14** (no per-model tool introspection exists). Source-authority freeze tests feed invented fields (`performanceClass`, `codingScore`, `reasoningTier`, …) through the pipeline and assert they never surface on any DTO — the composition layer is the freeze point against invented metadata.

## Doctor integration

`doctor/rules-models.ts` (advisory; persisted/derived data only) — input is the composed inventory on `DoctorInput.modelInventory` (probe-store availability flag + `ModelAvailability[]` + `ProviderDiagnostics[]`; absent → all model rules silent).

**Diagnostic ID inventory:**

| ID | Severity policy |
|---|---|
| `model.<p>.<m>.probe-unauthorized` / `.probe-model-not-found` | active agent primary → **warning**; Orchestrator primary → **error** UNLESS a configured fallback has a fresh healthy probe (downgrade to warning, fallback evidence attached); Oracle → warning (never error); inactive → info; active fallback-only → silent |
| `model.<p>.<m>.probe-rate-limited` | info; Orchestrator/Oracle primary → warning |
| `model.<p>.<m>.probe-timeout` | active primary → warning framed as uncertainty ("may be transient"); otherwise info |
| `model.<p>.<m>.probe-error / -malformed / -provider-disconnected / -opencode-disconnected` | inactive fresh failure → info; active → conservative silence |
| `model.<p>.<m>.unadvertised` | active usage → warning ("not advertised by the OpenCode catalog; may still work — probe to verify"); inactive → info |
| `model.<p>.<m>.capability-tools` | warning ONLY when the agent's EFFECTIVE tool envelope (non-deny decisions from capability config, never role inference) is non-empty AND `capabilities.state === "known"` with `tools === false`; unknown/partial → silent |
| `model.<p>.<m>.observer-vision` | warning ONLY when observer enabled AND `capabilities.state === "known"` with `vision === false` explicitly |
| `provider.<pid>.probes-blocked-disconnected` | info aggregate |
| `provider.<pid>.recent-rate-limited` | info, at most one per provider when `recentRateLimitCount > 0` |

Never-probed → NO diagnostic. Stale-only → NO diagnostic. Latest probe `errorCode === "aborted"` → silent (non-actionable).

**Provider-down root-cause dedup:** when a provider is currently disconnected, the existing `provider.<pid>.disconnected-active` (from `providerModelRules`) is the root cause. `rules-models` computes a suppression set of that provider's models with fresh provider/opencode-disconnected probes and emits ONE info aggregate with `relatedDiagnosticIds: ["provider.<pid>.disconnected-active"]` — no per-model probe-failure flood, no double-warn. `providerModelRules` itself was refactored to consume `buildModelUsage` as the single usage-correlation source while preserving its exact IDs/summaries/severities.

**Roll-up:** `ModelHealthCounts { referenced, probed, healthy, freshFailing, neverTested }` on `DoctorSnapshot.modelHealth`, surfaced on `/api/doctor/summary` and an Overview "Model health" card (`neverTested` rendered neutral, never alarming).

## Agent-editor integration

Probe badges render in the agent model selector and fallback rows; a **[Test] action** calls `POST /api/models/probe` (with `force:true`) and **never mutates config**. Preview advisories: failed probe → WARNING but the assignment remains saveable; never-probed → INFO only. Test is disabled only when OpenCode/the provider is disconnected; **Apply is never disabled**. Chain semantic summaries carry an evidence-only disclaimer. Both test-then-apply and direct-apply flows are explicitly valid.

## Council / ACP distinction

Council member probe badges render in the member column with **inactive presets dimmed** (membership in a non-default preset is inactive usage). ACP wrapper-model probe state is a separate row from the ACP handshake/launch health — a wrapper model being callable says nothing about the external process, and vice versa.

## Quota considerations

Probing is explicit-only; the prompt is one tokenish line ("Respond with: OK"); dedupe across pending+running; fresh-skip is the default for single submits; batch opt-in `skipRecentlyTested` defaults on in the UI; the batch confirmation modal carries quota-warning copy; the 25 soft guard forces a conscious ack (`force:true` + `acknowledgeLargeBatch:true`); manual live verification capped at ≤3 probes (below).

## APIs

| Endpoint | Shape |
|---|---|
| `GET /api/models` | `ModelInventoryDto { generatedAt, models: ModelAvailability[], providers: ProviderDiagnostics[], queue }` |
| `GET /api/models/:provider/:model` | `ModelAvailabilityDetail { availability, history }`; model segment supports slash-containing IDs via URL encoding (`%2F`); 404 unknown |
| `GET /api/models/:provider/:model/probes` | `{ providerId, modelId, probes: ModelProbeRun[] }` newest-first |
| `POST /api/models/probe` | Strict body `{providerId, modelId, force?}` (any extra field → 400). 202 `{queued:true,item,queue}` / 200 `{skipped:"fresh",latest}` / 200 `{duplicate:true,item}` / 503 `{code:"opencode-unavailable"\|"probe-store-degraded"}` |
| `POST /api/models/probe-batch` | Strict body `{models:[{providerId,modelId}], force?, skipRecentlyTested?, acknowledgeLargeBatch?}`; >100 → 400; 26–100 requires force+ack; → `{accepted, skipped, deduped, queue}` |
| `POST /api/models/probes/:id/cancel` | 200 `{ok:true, queue}` / 404 unknown / 409 terminal |
| `GET /api/events` | SSE gains `model-probes.updated { queue, at }` on every queue state change |
| `GET /api/sessions?includeControlPlaneProbes=1` | opt-in inclusion of probe-tagged sessions (excluded everywhere by default) |

## UI (Lanes 3/4)

ModelsPage: provider summary cards; 7-column table (Model | Provider | Advertised | Referenced | Probe | Probe latency | Agents/Usage); client-side filters (provider, connected, referenced, advertised, probe-state, usage-kind); detail drawer (state, latency, last-5 history + count, grouped usage, capabilities + source, limits); batch confirmation modal (quota copy, skip-recently-tested default-on, >25 ack checkbox); queue panel with Abort/Cancel; disconnected-provider banners. `ProbeBadge` is state-colored with a separate freshness label ("stale"/"14m ago"), never colored as health. `ModelAvailabilityContext` refetches on SSE-driven probe generations (JSON-tuple keys). AgentsPage Probe column; CouncilPage member column (inactive dimmed); AcpPage separate "wrapper model probe" row.

## Tests

353 server tests (slice-15 suites: probe-normalize ×38, probe-store ×10, probe-engine ×14, probe-queue ×13, usage ×8, inventory ×10, routes ×18, doctor additive ×17, omo-runtime probe-session exclusion regression ×1) + 31 web tests. **Zero real provider/OpenCode quota** — the engine runs against fake `OpenCodeProbeGateway` implementations (HTTP errors as thrown objects with numeric `.status`; transport as non-abort throws; deadline driven by stubbing the deadline timer, never real 20s waits); the store runs on `:memory:`; routes against fake deps. Key freeze/regression tests: source-authority freeze (invented capability fields never surface), secret-free schema assertion, retention/startup-finalization, terminal latch (exactly one terminal write), providerModelRules usage-map parity, probe-session exclusion from telemetry scanning.

## Manual live-verification procedure

At most **3 explicit probes**, all user-initiated: (1) one effective agent primary on a connected provider → healthy row + badge; (2) one configured fallback → healthy; (3) one model on a different connected provider → healthy. No 403-hunting (no deliberately unauthorized keys); batch modal exercised only with a tiny selection. Agent-editor Test flow: [Test] enqueues, badge flips running→healthy, Test-then-Apply and direct-apply both remain available. All three probes leave exactly one persisted run row each; probe sessions never appear in default session surfaces.

## Unsupported capability metadata in 1.18.14 (unknown-by-design)

`structuredOutput`, per-model `toolIds` (no per-model tool introspection endpoint), per-model benchmark/quality tiers (no `performanceClass`, `codingScore`, `reasoningTier` source exists in OpenCode 1.18.14). These fields stay `undefined`/absent by construction; the freeze tests make inventing them a test failure.

## Future analytics hooks

`model_probe_runs` history (latency, terminal states, timestamps, capture flags) already supports future trend/flakiness analytics per model/provider without schema change. No scheduled/automatic probing is built or planned for this slice — any future scheduler must remain opt-in.
