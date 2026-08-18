# Slice 17 — Telemetry Bridge Activation Source Audit

**Deliverable owner:** parent source-audit owner will review.  
**Scope:** OMO-Slim repository (`<owl-install-root>`) and installed OpenCode config directory (`<opencode-config-dir>`) only.
**Boundary:** this audit was performed before the Slice 17 implementation; it documents the pre-implementation state. The post-implementation behavior is recorded in [`manifest.md`](./manifest.md). No live probes were run and no configuration was changed during the audit.

Legend for evidence class:

- **VERIFIED LOCAL** — read directly from the local filesystem within the allowed scope.
- **ADVISORY WEB** — derived from current public documentation/source; may differ from the installed runtime.
- **DRIFT** — discrepancy between local sources, installed artifacts, docs, or advisory sources.
- **LIMITATION** — fact that cannot be established without a runtime probe or canonical response.
- **FUTURE LANE** — assigned follow-up work that exceeds this audit.

---

## 1. Scope and boundaries

| Boundary | Status | Evidence |
|---|---|---|
| Filesystem scope | enforced | `<owl-install-root>`, `<opencode-config-dir>` |
| No code/config changes | enforced | no writes outside this deliverable; parent dirs created only as requested |
| No live probes | enforced | no network/HTTP calls executed |
| Secret-bearing config | sanitized | `opencode.json` provider API keys are not reproduced in this document |
| Provider credentials | omitted | no `apiKey`, token, or key values are exposed below |

---

## 0. Post-implementation status pointer

The implementation described in this audit is now complete. See [`manifest.md`](./manifest.md) for the post-implementation evidence, API contract, UI eligibility, validation counts, limitations, and rollback guidance.

---

## 2. Bridge package audit (verified local)

### 2.1 Package metadata

| Field | Value | Path |
|---|---|---|
| Package name | `@omo/telemetry-bridge` | `<owl-install-root>/packages/omo-telemetry-bridge/package.json:2` |
| Version | `0.1.0` | `package.json:3` |
| Private | `true` | `package.json:4` |
| Type | ESM (`"type": "module"`) | `package.json:5` |
| Entry | source-loaded, no build step (`"main": "./src/index.ts"`, `"exports": { ".": "./src/index.ts" }`) | `package.json:7-11` |

### 2.2 Plugin runtime (`packages/omo-telemetry-bridge/src/index.ts`)

| Fact | Value | Path |
|---|---|---|
| Bind host | hardcoded `127.0.0.1` | `src/index.ts:29` |
| Default port | `8788` | `src/index.ts:32` |
| Port override | env `OMO_BRIDGE_PORT` only (1–65535 integer, fallback to 8788) | `src/index.ts:35, 40-52` |
| Server | `Bun.serve` | `src/index.ts:67` |
| Routes | `GET /health`, `GET /telemetry`; anything else `404 Not Found` | `src/index.ts:74-85` |
| Health response | `{ ok: true, schemaVersion: <TELEMETRY_SCHEMA_VERSION> }` | `src/index.ts:78-82` |
| Telemetry response | `Response.json(captureTelemetrySnapshot())` | `src/index.ts:75` |
| Failure mode | bind errors are logged, server stays undefined, plugin resolves normally | `src/index.ts:96-104` |
| Shutdown | `dispose()` stops server (`server?.stop(true)`) | `src/index.ts:107-117` |
| OpenCode input | ignored (`_input: PluginInput`) | `src/index.ts:61-62` |

### 2.3 Store schema v2 (`packages/omo-telemetry-bridge/src/stores.ts`)

| Fact | Value | Path |
|---|---|---|
| Schema version | `TELEMETRY_SCHEMA_VERSION = 2` | `src/stores.ts:29` |
| Read-only Symbol.for stores (4) | `oh-my-opencode-slim.foreground-fallback.in-progress`, `oh-my-opencode-slim.continuation-attempt-gate`, `oh-my-opencode-slim.cmux-session-store`, `oh-my-opencode-slim.multiplexer-session-manager.state` | `src/stores.ts:43-69` |
| Whitelist discipline | only the four keys above are read; unknown `Symbol.for` stores are ignored by construction | `src/stores.ts:37-69` |
| Serialization | primitive-only allowlist; objects/functions/symbols/null/undefined dropped | `src/stores.ts:180-189` |
| Caps/sorting/dedup | `RECORD_CAP = 100`; records sorted by `sessionId` and deduped | `src/stores.ts:329, 412-413, 442, 525-526` |
| Mutation guarantee | no store mutation; only iteration and counting | `src/stores.ts:15-16` |
| v2 record types | `MultiplexerSessionRecord`, `CmuxSessionRecord`, collection IDs | `src/stores.ts:97-143` |

### 2.4 Tests

| Fact | Value | Path |
|---|---|---|
| Test file | `packages/omo-telemetry-bridge/src/stores.test.ts` | local filesystem |
| Test framework | `bun:test` | `src/stores.test.ts:10` |
| Test count | 32 tests (`test(…)` calls × 32) | counted from `src/stores.test.ts` |
| Test isolation | imports only `./stores`, never `./index`; fakes `globalThis` stores and clears them after each test | `src/stores.test.ts:1-60` |

### 2.5 Activation docs

| Fact | Value | Path |
|---|---|---|
| Activation guide | `packages/omo-telemetry-bridge/ACTIVATION.md` | local filesystem |
| Drift: schema version in health example | docs say `{"ok":true,"schemaVersion":1}` but code emits `TELEMETRY_SCHEMA_VERSION = 2` | `ACTIVATION.md:48` vs `src/stores.ts:29` |
| Drift: port phrasing / activation responsibility | docs say default port `8788` and manual registration in `opencode.json`; server only consumes an already-running bridge via `OMO_BRIDGE_BASE_URL`; plugin registration remains an external OpenCode config/runtime concern | `ACTIVATION.md:23-41` vs `apps/server/src/config.ts:19-23`, `apps/server/src/index.ts:114` |
| Drift: manual registration | docs instruct hand-editing `opencode.json` plugin array; control-plane safe-write pipeline is the actual target | `ACTIVATION.md:23-34` |

---

## 3. Server consumer map (verified local)

### 3.1 Server configuration

| Fact | Value | Path |
|---|---|---|
| Config key | `omoBridgeBaseUrl?: string` | `apps/server/src/config.ts:23` |
| Env source | `OMO_BRIDGE_BASE_URL` | `apps/server/src/config.ts:43` |
| Default | `undefined` → bridge lane silently disabled | `apps/server/src/config.ts:55` |
| No validation/normalization | raw string trimmed only; arbitrary base URL accepted by client | `apps/server/src/config.ts:43, 55` |

### 3.2 Server bridge client (`apps/server/src/omo-runtime/bridge.ts`)

| Fact | Value | Path |
|---|---|---|
| Class | `OmoBridgeClient` | `apps/server/src/omo-runtime/bridge.ts:19` |
| Timeout | default `BRIDGE_FETCH_TIMEOUT_MS = 800` ms; configurable | `apps/server/src/omo-runtime/bridge.ts:11, 14, 30` |
| Endpoint | `GET /telemetry` only | `apps/server/src/omo-runtime/bridge.ts:56-60` |
| Base URL | arbitrary string accepted, trailing slash stripped | `apps/server/src/omo-runtime/bridge.ts:26-27, 56` |
| Failure mode | never throws; caches `{ connected: false }` on error | `apps/server/src/omo-runtime/bridge.ts:72-77` |
| Sanitization | `sanitizeBridgeStores` whitelist-only pass-through of v1/v2 fields | `apps/server/src/omo-runtime/bridge.ts:82-229` |
| Accepted schemas | v1 aggregates, v2 records (see `types.ts`) | `apps/server/src/omo-runtime/types.ts:24-25` |

### 3.3 Server runtime types (`apps/server/src/omo-runtime/types.ts`)

| Fact | Value | Path |
|---|---|---|
| Server schema version | `OMO_TELEMETRY_SCHEMA_VERSION = 2` | `apps/server/src/omo-runtime/types.ts:23` |
| Accepted versions | `{1, 2}` | `apps/server/src/omo-runtime/types.ts:24-25` |
| DTO shape | `OmoBridgeStores` mirrors `TelemetryStores` (fallback/continuation/multiplexer/cmux + v2 records) | `apps/server/src/omo-runtime/types.ts:92-134` |

### 3.4 Store integration (`apps/server/src/omo-runtime/store.ts`)

| Fact | Value | Path |
|---|---|---|
| Job derivation | from persisted OpenCode `task` tool parts, independent of bridge | `apps/server/src/omo-runtime/store.ts:1-13` |
| Bridge refresh | piggybacked on runtime activity, memoized to 3 s min interval | `apps/server/src/omo-runtime/store.ts:34-35, 215-229` |
| Reset behavior | `resetForBackendGeneration()` clears jobs only on backend generation replacement | `apps/server/src/omo-runtime/store.ts:124-137` |
| Snapshot includes | `bridge` status when `bridge?.configured` | `apps/server/src/omo-runtime/store.ts:144-146` |
| Signature includes | `bridge:<connected>` | `apps/server/src/omo-runtime/store.ts:341` |
| Emit event includes | `bridgeConnected` | `apps/server/src/omo-runtime/store.ts:366` |

### 3.5 Multiplexer runtime (`apps/server/src/omo-runtime/multiplexer-runtime.ts`)

| Fact | Value | Path |
|---|---|---|
| Build input | cached bridge status + cached OMO runtime snapshot; no fetch here | `apps/server/src/omo-runtime/multiplexer-runtime.ts:112-116` |
| Authoritative rule | `bridge?.connected && !stale` | `apps/server/src/omo-runtime/multiplexer-runtime.ts:165-179` |
| Reconciliation grace | `MULTIPLEXER_GRACE_MS = 60_000` applied only when authoritative | `apps/server/src/omo-runtime/multiplexer-runtime.ts:21, 170-171` |
| Record normalization | merges collection-only IDs into session records, capped/sorted/deduped to 100 | `apps/server/src/omo-runtime/multiplexer-runtime.ts:30-71, 118-121` |
| Job correlation | exact child session ID join against OMO jobs | `apps/server/src/omo-runtime/multiplexer-runtime.ts:150-163` |

### 3.6 Server routes and doctor

| Fact | Value | Path |
|---|---|---|
| Server wiring | constructs optional `OmoBridgeClient(cfg.omoBridgeBaseUrl)` at startup; does **not** register or load the bridge plugin | `apps/server/src/index.ts:114-118` |
| Runtime activity refresh | `runtime.subscribe(...)` drives `omoStore.refresh(...)` | `apps/server/src/index.ts:122-130` |
| GET `/api/omo/runtime` | returns `omoStore.getSnapshot()` including `bridge` | `apps/server/src/index.ts:295-299` |
| GET `/api/system/multiplexer` | builds from `omoBridge.getBridgeStores()` + `omoStore.getSnapshot()` | `apps/server/src/index.ts:1387-1393` |
| Doctor telemetry | `telemetry.activity`, `telemetry.bridge-down`, `telemetry.bridge-schema`, `telemetry.job-orphan`, `telemetry.job-timeout` | `apps/server/src/doctor/rules-groups.ts:482-559` |
| Doctor bridge-down copy | refers to `OMO_BRIDGE_BASE_URL` and accepted schemas `{1,2}` | `apps/server/src/doctor/rules-groups.ts:510` |
| Doctor multiplexer input | uses `omoBridge.getBridgeStores()` + `buildMultiplexerRuntime(...)` | `apps/server/src/index.ts:294-302` |

### 3.7 Security allowlist (`apps/server/src/omo-runtime/security.ts`)

| Fact | Value | Path |
|---|---|---|
| Job sanitizer | `sanitizeJob` enforces allowed fields and state set | `apps/server/src/omo-runtime/security.ts` |
| Summary cap | 120 chars in evidence, 200 chars elsewhere | `apps/server/src/omo-runtime/security.ts`, `store.ts:382-387` |
| Result cap | 200 chars | `apps/server/src/omo-runtime/store.ts:382-387` |

---

## 4. Web consumer map (verified local)

| Consumer | Bridge/multiplexer usage | Path |
|---|---|---|
| `useOmoRuntime` hook | polls `GET /api/omo/runtime`; uses local `OmoRuntimeSnapshot`/`OmoBridgeStores` types | `apps/web/src/hooks/useOmoRuntime.ts` |
| `useMultiplexer` hook | polls `GET /api/system/multiplexer` (sparse poll) | `apps/web/src/hooks/useMultiplexer.ts` |
| `OverviewPage` | shows hardcoded `:8788` when `omo.bridge?.connected` | `apps/web/src/pages/OverviewPage.tsx:51-54` |
| `SystemPage` / `MultiplexerSection` | renders multiplexer runtime from `MultiplexerSystemDto`; shows `bridgeSchemaVersion`, `bridgeConnected`, mapping | `apps/web/src/pages/system/MultiplexerSection.tsx`, `SystemPage.tsx:209` |
| `OmoJobsPanel` | joins jobs to mux mapping by `childSessionId`; requires `mappingAuthoritative` | `apps/web/src/pages/sessions/OmoJobsPanel.tsx:84-108` |
| `SessionInspector` | looks up `mux.runtime.mapping.bySessionId[props.sessionId]`; renders bridge schema version/stale | `apps/web/src/pages/sessions/SessionInspector.tsx:193-198, 562-581` |
| `AgentsPage` | shows `trackedMappings` from `mux.runtime.mapping.mappedJobs` when mapping live | `apps/web/src/pages/AgentsPage.tsx:23, 63-65, 339-344` |
| `multiplexer-utils` | `mappingAuthoritative` = `bridgeConnected && !unavailable`; `mappingLive` adds `!stale` | `apps/web/src/pages/system/multiplexer-utils.ts:228-234` |

### Web local type drift

| Drift | Detail | Paths |
|---|---|---|
| Local bridge types miss v2 record fields | `apps/web/src/pages/omo-runtime-types.ts` defines `OmoBridgeStores` with only v1 aggregates (`multiplexer` counts, `cmux.recordCount`); it omits `multiplexerRecords`, `multiplexerCollectionIds`, and `cmuxRecords` | `apps/web/src/pages/omo-runtime-types.ts:32-46` vs `apps/server/src/omo-runtime/types.ts:106-134` |
| Hardcoded `:8788` in UI | `OverviewPage` prints `connected :8788` regardless of actual configured port | `apps/web/src/pages/OverviewPage.tsx:54` |

---

## 5. Installed OpenCode evidence (verified local)

### 5.1 Config files

| Fact | Value | Path |
|---|---|---|
| Both JSON and JSONC exist | `opencode.json` and `opencode.jsonc` present | `<opencode-config-dir>/` |
| `opencode.json` schema | `$schema: "https://opencode.ai/config.json"` | `<opencode-config-dir>/opencode.json:2` |
| `opencode.json` plugin array | `["@ex-machina/opencode-anthropic-auth@1.8.1", "oh-my-opencode-slim"]` | `<opencode-config-dir>/opencode.json:3-6` |
| `opencode.jsonc` content | only `$schema` line (no plugins declared) | `<opencode-config-dir>/opencode.jsonc:1-3` |
| Active source | **not proven** without sanitized live `GET /config`; file content shows plugin identities only | limitation |

### 5.2 Installed package versions

| Package | Installed version | Path |
|---|---|---|
| `oh-my-opencode-slim` | `2.2.10` | `<opencode-config-dir>/node_modules/oh-my-opencode-slim/package.json:3` |
| `@opencode-ai/plugin` (top-level) | `1.18.14` | `<opencode-config-dir>/node_modules/@opencode-ai/plugin/package.json:4` |
| `@opencode-ai/sdk` (top-level) | `1.18.14` | `<opencode-config-dir>/node_modules/@opencode-ai/sdk/package.json:4` |
| `@opencode-ai/plugin` (nested under `oh-my-opencode-slim`) | `1.18.13` | `<opencode-config-dir>/node_modules/oh-my-opencode-slim/package.json:84` |
| `@opencode-ai/sdk` (nested under `oh-my-opencode-slim`) | `1.18.13` | `<opencode-config-dir>/node_modules/oh-my-opencode-slim/package.json:85` |

**Drift:** `oh-my-opencode-slim` declares plugin/sdk dependency `1.18.13` but the top-level installed copies are `1.18.14`.

### 5.3 Plugin config schema from installed artifacts

| Fact | Value | Path |
|---|---|---|
| SDK v1 generated types plugin field | `Array<string>` only (v1 `Config` lacks tuple support) | `@opencode-ai/sdk/dist/gen/client/types.gen.d.ts` (no `plugin` tuple field) |
| SDK v2 generated types plugin field | `plugin?: Array<string \| [string, { [key: string]: unknown }]>` | `<opencode-config-dir>/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts:1546-1551` |
| `@opencode-ai/plugin` Config plugin field | `plugin?: Array<string \| [string, PluginOptions]>` | `<opencode-config-dir>/node_modules/@opencode-ai/plugin/dist/index.d.ts:48-50` |
| Tuple support in type declarations | installed plugin schema allows `[string, options]` tuple | verified local |
| Tuple runtime acceptance | **unproven** — running OpenCode process may differ from installed `1.18.14/1.18.13` declarations | limitation |
| `PluginInput` shape | `{ client, project, directory, worktree, experimental_workspace, serverUrl, $ }` | `<opencode-config-dir>/node_modules/@opencode-ai/plugin/dist/index.d.ts:36-46` |
| SDK server spawn | uses synchronous `cross-spawn` with inherited `process.env` before first `await` | `<opencode-config-dir>/node_modules/@opencode-ai/sdk/dist/server.js:1-17` |
| Config injection | `OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config ?? {})` is written into child env | `<opencode-config-dir>/node_modules/@opencode-ai/sdk/dist/server.js:13-17` |

### 5.4 Limitations of installed evidence

| Limitation | Reason |
|---|---|
| No authoritative exact installed config schema proven locally | `opencode.json` shows only the file-based plugin list; runtime merge/load ordering and final effective config require a sanitized `GET /config` response. |
| Tuple acceptance at runtime not proven | The installed type declarations accept tuples, but whether the running OpenCode process (possibly patched beyond 1.18.14) actually loads tuple plugins requires a controlled canonical-runtime test. |
| Config source precedence not proven | File `opencode.json` vs `opencode.jsonc` vs `OPENCODE_CONFIG_CONTENT` vs API updates; no live probe performed. |
| Duplicate plugin handling not proven | Whether the runtime deduplicates by exact file URL or package name requires runtime evidence. |
| Hot reload | No evidence of hot reload; all local and advisory sources indicate startup-only plugin load. |

---

## 6. Official advisory evidence (current web/source at v1.18.18)

> **ADVISORY — not from the installed 1.18.14 runtime.** The installed plugin/SDK versions are `1.18.14` (top-level) / `1.18.13` (OMO-Slim nested), and an unknown runtime patch may differ.

| Topic | Advisory finding | Source URL |
|---|---|---|
| Version | OpenCode CLI / SDK / plugin current release `v1.18.18` | https://github.com/opencode-ai/opencode/releases (advisory) |
| Plugin spec format (advisory) | Schema and core plugin spec support string **or** `[string, options]` tuple | https://opencode.ai/docs/plugins (advisory) |
| Path-like specs (advisory) | `file://`, relative, and absolute plugin paths supported | https://opencode.ai/docs/plugins (advisory) |
| Relative resolution (advisory) | Relative plugin paths resolved against the declaring config file and converted to `file://` URL | https://opencode.ai/docs/plugins (advisory) |
| Local package dirs (advisory) | Use `exports["./server"]` then `main` for plugin loading | https://opencode.ai/docs/plugins (advisory) |
| npm specs (advisory) | Install and cache behavior for npm plugin specs | https://opencode.ai/docs/plugins (advisory) |
| Config merge/load ordering (advisory) | Deterministic config merge and load ordering | https://opencode.ai/docs/plugins (advisory) |
| Plugin execution order (advisory) | Deterministic plugin execution order | https://opencode.ai/docs/plugins (advisory) |
| Deduplication (advisory) | Latest / highest-precedence wins by **exact file URL** for local plugins or by npm package name (docs may incorrectly suggest same name+version) | https://opencode.ai/docs/plugins (advisory) |
| Load failure handling (advisory) | Plugin load/apply failures are non-fatal and dropped | https://opencode.ai/docs/plugins (advisory) |
| Startup-only load (advisory) | Plugins load at startup only; no hot reload | https://opencode.ai/docs/plugins (advisory) |

**Key advisory limitation:** because the installed versions are `1.18.14/1.18.13` and the runtime may carry patches, the advisory v1.18.18 behavior cannot be assumed canonical for this machine without controlled runtime evidence.

---

## 7. Drift table

| # | Drift | Conflicting sources | Risk / note |
|---|---|---|---|
| 1 | Activation doc health example reports schema v1; code emits v2 | `ACTIVATION.md:48` vs `src/stores.ts:29` | Doc example stale; actual health output is v2. |
| 2 | Activation doc instructs fixed port `8788` / manual `opencode.json` edit; server only consumes an already-running bridge via `OMO_BRIDGE_BASE_URL`; it does not register or load the plugin | `ACTIVATION.md:23-41` vs `apps/server/src/config.ts:19-55`, `apps/server/src/index.ts:114` | Bridge endpoint remains absent unless the OpenCode runtime loads the plugin independently; server side is a consumer, not the activator. |
| 3 | Activation doc says schema v1; stores.ts is schema v2 | `ACTIVATION.md:1-7` vs `src/stores.ts:29` | Bridge emits v2 by default; v1 consumers are backward-compatible via accepted versions. |
| 4 | `oh-my-opencode-slim` declares plugin/sdk `1.18.13`; top-level installed are `1.18.14` | `<opencode-config-dir>/node_modules/oh-my-opencode-slim/package.json:84-85` vs `<opencode-config-dir>/node_modules/@opencode-ai/plugin/package.json:4` and `sdk/package.json:4` | Minor runtime version mismatch; could affect tuple/config behavior if runtime picks nested copy. |
| 5 | Web local `OmoBridgeStores` omits v2 record fields | `apps/web/src/pages/omo-runtime-types.ts:32-46` vs `apps/server/src/omo-runtime/types.ts:106-134` | Web type declarations are incomplete; runtime payloads carry the fields anyway. |
| 6 | `OverviewPage` hardcodes `:8788` display | `apps/web/src/pages/OverviewPage.tsx:54` vs configurable `OMO_BRIDGE_PORT`/`OMO_BRIDGE_BASE_URL` | UI may misreport port if non-default bridge port is used. |
| 7 | Advisory v1.18.18 docs vs installed 1.18.14/1.18.13 | See section 6 | Do not assume latest behavior; verify with controlled runtime. |
| 8 | Advisory docs suggest dedup by name+version; authoritative behavior is by exact file URL or package name | https://opencode.ai/docs/plugins (advisory) | Config audit lane should test actual deduplication. |

---

## 8. Unresolved gates

These gates require controlled canonical-runtime evidence and are **not** closed by this audit:

1. **Active source provenance** — is the running OpenCode process actually using `<opencode-config-dir>/opencode.json` (not `opencode.jsonc`, not API-injected config, not `OPENCODE_CONFIG_CONTENT`)? Requires sanitized `GET /config` or equivalent.
2. **Tuple acceptance** — does the installed runtime load `["./packages/omo-telemetry-bridge", { ... }]` if supplied? Type declarations support it; runtime behavior unproven.
3. **Config file precedence** — if `opencode.json` and `opencode.jsonc` both exist, which wins and under what conditions?
4. **Plugin deduplication rule** — exact file URL vs package name+version vs package name only.
5. **Duplicate plugin handling** — what happens if both `oh-my-opencode-slim` and the bridge are declared twice or in conflicting forms?
6. **Hot reload** — confirm no hot reload (advisory says startup-only; installed runtime may differ).
7. **Bridge activation end-to-end** — confirm `OMO_BRIDGE_BASE_URL=http://127.0.0.1:8788` results in `GET /telemetry` answering and `GET /api/omo/runtime` reporting `bridge.connected === true`.
8. **Default port collision behavior** — confirm `OMO_BRIDGE_PORT` override works and bind-failure logs without crashing the plugin.

---

## 9. Lane ownership (assigned future lanes)

| Target / question | Lane | Rationale |
|---|---|---|
| Controlled runtime bridge activation test (env var, health, telemetry, GET /api/omo/runtime) | `fixer-high` or runtime QA lane | Requires starting/stopping OpenCode and validating live responses. |
| Sanitized `GET /config` to prove active source and plugin list | `fixer-low` probe lane | Bounded HTTP read; must redact secrets. |
| Verify tuple plugin config acceptance at runtime | `fixer-high` | Cross-component OpenCode config/plugin loading behavior. |
| Resolve `opencode.json` vs `opencode.jsonc` precedence | `fixer-high` | Requires runtime config semantics. |
| Verify plugin deduplication rule (exact file URL / package name) | `fixer-high` | Cross-component config merge behavior. |
| Update `ACTIVATION.md` schema v1→v2 and port/base-URL guidance | `fixer-low` | Mechanical doc fix once drift is accepted. |
| Update web `omo-runtime-types.ts` to include v2 record fields | `fixer-low` | Mechanical type sync. |
| Remove/replace hardcoded `:8788` in `OverviewPage` | `designer` / `fixer-low` | UI copy should reflect configured base URL or omit port. |
| Update `OverviewPage` bridge display to use actual `bridge` metadata | `designer` | Small UI behavior change. |
| Audit installed 1.18.14 vs advisory 1.18.18 behavior deltas | `librarian` / `researcher` | Public changelog/source comparison. |
| Determine whether nested `1.18.13` plugin/sdk are ever loaded instead of top-level `1.18.14` | `fixer-high` | Node module resolution under OMO-Slim process. |
| Security review of `OPENCODE_CONFIG_CONTENT` injection and inherited `process.env` | `fixer-high` or security lane | SDK server spawn behavior. |

**Search targets discovered and lane assignments:**

- `packages/omo-telemetry-bridge/src/index.ts` — bridge runtime owner: parent source-audit; activation lane.
- `packages/omo-telemetry-bridge/src/stores.ts` — schema/reader owner: telemetry bridge lane.
- `packages/omo-telemetry-bridge/src/stores.test.ts` — test owner: telemetry bridge lane.
- `packages/omo-telemetry-bridge/ACTIVATION.md` — doc drift owner: `fixer-low` doc lane.
- `packages/omo-telemetry-bridge/package.json` — package metadata owner: telemetry bridge lane.
- `apps/server/src/config.ts` — server config owner: server/control-plane lane.
- `apps/server/src/omo-runtime/bridge.ts` — server bridge client owner: telemetry bridge lane.
- `apps/server/src/omo-runtime/types.ts` — server DTO owner: telemetry bridge lane.
- `apps/server/src/omo-runtime/store.ts` — store integration owner: telemetry bridge lane.
- `apps/server/src/omo-runtime/multiplexer-runtime.ts` — multiplexer runtime owner: multiplexer lane.
- `apps/server/src/index.ts` (bridge wiring + `/api/system/multiplexer`) — server runtime owner.
- `apps/server/src/doctor/rules-groups.ts` — doctor telemetry rules owner: doctor lane.
- `apps/server/src/omo-runtime/security.ts` — security sanitizer owner: security lane.
- `apps/web/src/pages/omo-runtime-types.ts` — web type drift owner: web lane / `fixer-low`.
- `apps/web/src/pages/OverviewPage.tsx` — hardcoded port owner: web lane / `designer`.
- `apps/web/src/pages/sessions/OmoJobsPanel.tsx` — multiplexer job join owner: web lane.
- `apps/web/src/pages/sessions/SessionInspector.tsx` — session mux lookup owner: web lane.
- `apps/web/src/pages/AgentsPage.tsx` — agent tracked mappings owner: web lane.
- `apps/web/src/pages/system/MultiplexerSection.tsx` — multiplexer UI owner: web lane.
- `apps/web/src/pages/system/multiplexer-utils.ts` — mapping utility owner: web lane.
- `apps/web/src/hooks/useOmoRuntime.ts` — runtime hook owner: web lane.
- `apps/web/src/hooks/useMultiplexer.ts` — multiplexer hook owner: web lane.
- `<opencode-config-dir>/opencode.json` — config source owner: config audit lane.
- `<opencode-config-dir>/opencode.jsonc` — config source owner: config audit lane.
- `<opencode-config-dir>/node_modules/@opencode-ai/plugin/dist/index.d.ts` — plugin schema owner: config audit lane.
- `<opencode-config-dir>/node_modules/@opencode-ai/sdk/dist/server.js` — SDK server spawn owner: runtime/platform lane.

---

## 10. Audit conclusion

**Verified local facts**

- The `@omo/telemetry-bridge` package is a private ESM plugin with no build step, source-loaded from `src/index.ts`.
- It binds only `127.0.0.1`, uses `OMO_BRIDGE_PORT` (default `8788`), serves `GET /health` and `GET /telemetry`, and remains loaded even if the server fails to bind.
- Store reads are read-only, primitive-only, capped/sorted/deduped, and use four whitelisted `Symbol.for` stores with schema version `2`.
- 32 unit tests cover the store readers and snapshot assembly.
- The OMO-Slim server accepts `OMO_BRIDGE_BASE_URL` only and constructs an optional bridge client at startup; it does not register or load the bridge plugin. It refreshes telemetry from runtime activity with a 3 s memo when a base URL is supplied.
- The server accepts bridge schema versions `{1, 2}` and uses bridge data only when connected and non-stale for multiplexer authority.
- Web consumers include Overview, System/Multiplexer, OmoJobsPanel, SessionInspector, and Agents pages, all joining via `GET /api/omo/runtime` or `GET /api/system/multiplexer`.
- Installed OpenCode config has both `opencode.json` and `opencode.jsonc`; `opencode.json` declares `@ex-machina/opencode-anthropic-auth@1.8.1` and `oh-my-opencode-slim`.
- Installed plugin/SDK versions are `1.18.14` (top-level) and `1.18.13` (nested under `oh-my-opencode-slim`); plugin type declarations support string or `[string, PluginOptions]` tuple.
- The SDK server uses `cross-spawn` synchronously with inherited `process.env` before its first `await`.

**Advisory current-web facts**

- Official v1.18.18 documentation (advisory) supports string or tuple plugin specs, relative/file/npm resolution, deterministic merge/load ordering, dedup by exact file URL or package name, non-fatal plugin failures, and startup-only plugin load. None of these behaviors are verified locally.

**Critical limitations**

- Active source provenance (which config file/runtime actually drives OpenCode) is **not proven** without a sanitized live `GET /config`.
- No authoritative exact installed config schema is proven locally; the remote schema is advisory only.
- Tuple acceptance, config source precedence, duplicates handling, and hot reload require controlled canonical-runtime evidence.

**Conclusion:** The bridge package and the OMO-Slim server consumer are locally consistent and will use a bridge endpoint if one is already running at the configured `OMO_BRIDGE_BASE_URL`. Setting `OMO_BRIDGE_BASE_URL` alone does **not** register or load the plugin in OpenCode; the plugin must still be registered in the canonical OpenCode runtime and the process restarted. Safe activation depends on resolving the unresolved gates above, especially proving the active config source and verifying that the installed runtime loads the bridge plugin correctly. No source modifications are required for this audit deliverable.

---

## 11. Post-implementation note

After this audit, the Slice 17 implementation added the managed bridge safe-write pipeline, lifecycle restart integration, and web UI. The canonical post-implementation evidence is in [`manifest.md`](./manifest.md) in this same directory.

*End of Slice 17 source-audit deliverable.*
