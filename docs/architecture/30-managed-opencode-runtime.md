# 30 — Managed OpenCode Runtime (Backend Lifecycle Remediation)

**Date:** 2026-08-13  
**Status:** Implementation and controlled live verification complete (see [Controlled live verification results](#controlled-live-verification-results)).  
**Scope:** Documents the actual coded behavior of the OpenCode backend lifecycle as implemented in `apps/server/src/opencode/lifecycle.ts`, `apps/server/src/opencode/sdk-adapter.ts`, `apps/server/src/opencode/security.ts`, `apps/server/src/config.ts`, `apps/server/src/runtime/store.ts`, and `apps/server/src/index.ts`. Source of truth is the installed implementation, not any earlier draft.

This slice is the development-workflow and documentation portion of the Managed OpenCode Backend Lifecycle remediation. It does **not** include provider-discovery remediation or Slice 16 work (see [Boundary](#boundary)).

---

## Original defect / root cause

The original development workflow required a separately running `opencode serve` process as a prerequisite and used a shell-background `&` script to start the server and frontend:

```jsonc
// package.json (before)
"dev": "bun run --filter @omo/server dev & bun run --filter @omo/web dev"
```

This had two concrete defects:

1. **Lifecycle leak.** The shell backgrounds both `bun --filter` wrappers and the parent shell exits immediately, leaving the server, vite, and any `opencode serve` process detached. A Ctrl-C in the launching terminal does not reliably reach the detached children, so they keep running. Restarting `bun run dev` then collides with the orphaned listeners.

2. **No owned-backend shutdown.** Even when the server process did receive a signal, the workflow assumed an externally-managed `opencode serve`. There was no path by which the control plane could start, own, and cleanly stop an SDK-started OpenCode backend. An orphaned owned backend would persist across dev restarts.

The remediation makes the control plane the single authority for the OpenCode backend lifecycle in the default (Managed) mode, and makes `bun run dev` a single coordinated command that forwards signals so the server's graceful shutdown closes the owned SDK backend.

---

## Installed SDK findings / API choice

The installed SDK is `@opencode-ai/sdk@1.18.14`, resolved dynamically from the active OpenCode config install (`~/.config/opencode/node_modules/@opencode-ai/sdk`). Verified against installed source:

| Property | Finding |
|----------|---------|
| `createOpencodeServer(options)` | Returns `{ url: string, close(): void }`. Starts a loopback OpenCode server. This is the lifecycle surface used. |
| `createOpencode(options)` | Only adds a generated client to the same server handle. **Not used** because this control plane already has a mature normalized REST/SSE client (`OpenCodeClient`) and a `RuntimeStore` that normalizes OpenCode REST + SSE. `createOpencode` would add a redundant generated client while the existing REST/SSE path remains the integration. |
| Return type | `url` + `close()` only. **No PID**, no process handle, no success log stream. |
| `options.hostname` | Loopback hostname. The adapter passes `127.0.0.1`. |
| `options.port` | `0` → OS-selected ephemeral loopback port; the actual port is available in `handle.url`. A specific port (e.g. `4096`) is requested when the preferred port is free. |
| `options.timeout` | Startup timeout (ms). The adapter passes `15_000`. |
| `options.signal` | Optional `AbortSignal`. Not currently wired by the lifecycle (the lifecycle uses its own `runId`/`stopping` guards). |
| Process environment | The SDK inherits the complete `process.env` of the server process, including provider auth tokens and `OPENCODE_CONFIG_DIR`. Verified in installed source. |
| `OPENCODE_CONFIG_CONTENT` | SDK supports an overlay; not used by this control plane. |
| Startup failure | The SDK includes captured child stderr/stdout in startup failure errors but offers **no success log stream**. The adapter bounds the error message to 2 000 chars before it can reach state, diagnostics, or logs. |
| Version pin | The adapter rejects any SDK version other than `1.18.14` at startup. |

### Why `createOpencodeServer` and not `createOpencode`

`createOpencode` only attaches a generated client to the same underlying server handle. The control plane already has:

- `OpenCodeClient` — a normalized REST/SSE client with abort-signal health probes, provider readiness, agents, sessions, MCP, permissions, and SSE event subscription.
- `RuntimeStore` — bootstraps from REST, subscribes to `GET /event` SSE, normalizes events, and exposes a `RuntimeStateDto` to the browser via `GET /api/events`.

Adopting `createOpencode`'s generated client would duplicate this integration without removing the existing REST/SSE normalizer. `createOpencodeServer` is the minimal useful lifecycle surface: it starts the backend and returns `url + close()`, which is exactly what the lifecycle manager needs to own and stop a backend. The existing REST/SSE path continues to serve all runtime data.

---

## `opencode serve`, `opencode attach`, and the TUI embedded distinction

Three distinct ways exist to get an OpenCode server process. The control plane's relationship to each is different:

### 1. `opencode serve` — standalone headless server

`opencode serve` starts a headless OpenCode HTTP server (default `127.0.0.1:4096`, configurable via `--port`/`--hostname`). It is a long-running process independent of any TUI. The control plane **does not spawn `opencode serve`**. In Managed mode, if a compatible `opencode serve` (or any compatible OpenCode) is already listening on the preferred port `127.0.0.1:4096`, the lifecycle reuses it as an external backend rather than starting a competing one. In Attach mode, the user points `OPENCODE_BASE_URL` at any running OpenCode server (including one started by `opencode serve`).

### 2. `opencode attach <url>` — TUI attached to a running server

`opencode attach <url>` starts the OpenCode TUI and connects it to an already-running OpenCode server at the given URL. The TUI does not start its own server in this mode; it is a client of the existing server. This is the same-runtime TUI workflow for a Managed control plane: attach the TUI to the URL the control plane's lifecycle reports (see [Dynamic canonical URL](#dynamic-canonical-url)).

### 3. `opencode` (default) / `opencode <project>` — TUI with embedded runtime

The default `opencode` command (or `opencode <project>`) starts the TUI **with its own embedded OpenCode server**. This embedded runtime is independent of the control plane's Managed backend. Running plain `opencode` while the control plane is running in Managed mode creates a **second, independent** OpenCode runtime that the control plane does not own or observe. To work in the same runtime as the control plane, use `opencode attach <managed-url>` instead.

> **Warning:** Plain `opencode` (without `attach`) may create an independent embedded OpenCode runtime that is not the same backend the control plane manages. Use `opencode attach <url>` to work in the same runtime.

---

## Managed / Attach precedence

The lifecycle mode is selected by the presence of `OPENCODE_BASE_URL` in the server process environment (see `config.ts`):

| `OPENCODE_BASE_URL` | Mode | Behavior |
|---------------------|------|---------|
| unset / absent | **Managed** (default) | The control plane owns the OpenCode backend lifecycle: it probes the preferred port, reuses a compatible preexisting backend, or starts one via the installed SDK. It owns, restarts, and stops the backend it started. |
| set to a valid `http://`/`https://` URL | **Attach** | The control plane attaches to that explicit external OpenCode server. It **never** owns, starts, stops, or replaces that server. Loss of the external backend is a terminal failure (with Retry), not a restart. |

`OPENCODE_BASE_URL` presence is detected with `Object.prototype.hasOwnProperty.call(env, "OPENCODE_BASE_URL")`, so an empty-string value selects Attach mode and then fails validation (see [Auth handling](#auth-handling)).

The OMO-Slim kill switch `OH_MY_OPENCODE_SLIM_DISABLE` (any value other than empty/`0`/`false`/`no`/`off`) relaxes the OMO-registration readiness requirement: `omoExpected` becomes `false` and the lifecycle does not require OMO agents to be registered.

### Project, config, and install roots (portable contract)

- **Owl install root** — discovered portably from the root `package.json` (`omo-control-plane`) by walking ancestors of the server module (no `../../..` literal, no `process.cwd()` authority). It is distinct from the selected target project.
- **Target project root** — `OMO_CP_PROJECT_DIR` if set must be an absolute existing directory (validated via `realpath`); otherwise the server's startup cwd. Under the official launchers (`bun run dev` / `dev:server` / `start`) the server is started with cwd = install root, so the default target is the Owl checkout itself. An explicit `OMO_CP_PROJECT_DIR=/path/to/your/project` selects a different project.
- **OpenCode config root** — `OPENCODE_CONFIG_DIR` if set must be an absolute existing directory; otherwise `$HOME/.config/opencode` (must exist).
- **Authorized roots** — exactly the realpaths of Owl install root, target project root, and OpenCode config root (deduped). All filesystem reads/writes are gated by this set.
- **Managed chdir** — in Managed mode the server `process.chdir()`s to the selected target immediately after config load and before any stores, services, lifecycle, or SDK construction, so the SDK (which inherits `process.cwd()`) runs in the target project. Attach mode does not chdir and never owns/stops an external backend.
- **Telemetry bridge identity** — canonical `packages/omo-telemetry-bridge` path resolves under the Owl install root, not the target project.

Ports remain `8787` (control plane), `5173` (Vite), `4096` (preferred OpenCode). `bun run dev` remains the one-command workflow; `dev:server` / `dev:web` / `start` are unchanged.

---

## Ownership

`OpenCodeLifecycleOwnership` is one of:

- **`control-plane`** — the lifecycle started the backend via the SDK and holds a `ManagedSdkHandle` (`url` + `close()`). It is responsible for closing it on shutdown, loss, or restart. Only one owned handle exists at a time.
- **`external`** — the backend was found preexisting (Managed reuse) or explicitly attached (Attach). The lifecycle holds no handle and **never closes** it. `stop()` and `backendLost()` do not close external backends.

The `OpenCodeLifecycleState` DTO deliberately contains **no PID, no credentials, no request headers, and no provider secrets**. The installed SDK exposes only `url + close()`, and the state surface reflects that.

---

## Startup / readiness state machine

The lifecycle progresses through `OpenCodeLifecycleStatus` values. The actual transitions coded in `lifecycle.ts`:

```
initializing
  │
  ├─[attach]→ waiting-health ──probe──ready──→ waiting-runtime ──waitReady──ready──→ connected
  │            │                                                                                │
  │            └─probe──refused/unavailable/collision──→ failed                                  │
  │                                                                                             │
  └─[managed]→ waiting-health (probe preferred :4096)
               │
               ├─probe──ready──→ connected (reuse as external, generation=1)
               │
               ├─probe──unavailable, health ok, OMO not yet registered──→ waiting-runtime ──waitReady──→ connected (reuse)
               │                                                                            │
               │                                                                            └─timeout──→ failed (omo-registration-failed / preexisting-readiness-failed)
               │
               ├─probe──unavailable, OMO registration failed──→ failed (omo-registration-failed / preferred-opencode-unavailable)
               │
               ├─probe──refused, port bindable──→ starting ──startOwned(4096)──→ waiting-health ──waitReady──→ connected (control-plane)
               │
               ├─probe──refused, port NOT bindable, ephemeral supported──→ starting ──startOwned(0)──→ waiting-health ──→ connected (control-plane, alternate port)
               │
               ├─probe──refused, port NOT bindable, ephemeral NOT supported──→ failed (preferred-port-collision, not retryable)
               │
               ├─probe──collision, ephemeral supported──→ starting ──startOwned(0)──→ waiting-health ──→ connected (control-plane, alternate port)
               │
               └─probe──collision, ephemeral NOT supported──→ failed (preferred-port-collision, not retryable)

connected
  │
  ├─backendLost (control-plane)──→ restarting ──restartOrFail──→ manage(true) ──→ connected (new generation) | failed (managed-restart-exhausted)
  ├─backendLost (attach/external)──→ failed (attached-backend-unavailable, retryable)
  ├─stop()──→ stopped
  └─retry()──→ initializing/restarting ──→ start()

restarting
  │
  ├─restartOrFail succeeds──→ manage(true) ──→ connected (generation++)
  └─restartIndex exhausted──→ failed (managed-restart-exhausted / omo-registration-failed)
```

### Readiness probe

`probeOpenCodeBackend` is a bounded REST-only probe (SSE starts only after lifecycle activation). It checks, in order:

1. `GET /global/health` — `healthy === true` required. Sets `ready.health`, `ready.rest`.
2. If `requireRuntime` is false, returns `ready` after health.
3. If `requireRuntime` is true, additionally fetches `configProvidersReady()`, `providerReady()`, and `agents()`. Sets `ready.configProviders`, `ready.providers`, `ready.agents`, `ready.omo`.
4. `ready.rest` is the conjunction of health + configProviders + providers + agents.
5. `ready.omo` is true if OMO agents are registered (`orchestrator` + ≥3 of explorer/librarian/oracle/designer/fixer) or if `omoExpected` is false (kill switch).

Probe classification:

| `kind` | Meaning |
|--------|---------|
| `ready` | Health ok and (if required) full runtime readiness including OMO registration. |
| `refused` | TCP/HTTP connection refused (port likely free). |
| `collision` | Something answered but it is not a healthy compatible OpenCode (health not ok, or non-OpenCode HTTP). |
| `unavailable` | OpenCode answered but runtime checks failed (e.g. OMO not registered, or 401/403 auth failure). |

### Readiness polling

`waitReady` polls `probeTarget(baseUrl, requireRuntime=true)` every `READINESS_POLL_MS` (250 ms) until `READINESS_TIMEOUT_MS` (30 000 ms) elapses or the probe returns `ready`. Each non-ready poll transitions the state to `waiting-health` or `waiting-runtime` based on whether health is up. On timeout, owned backends go to `restartOrFail`; external/attached backends go to `failed`.

---

## Port / preexisting / collision / alternate-port behavior (as actually coded)

Managed mode always begins by probing the preferred loopback URL `http://127.0.0.1:4096` (`PREFERRED_OPENCODE_BASE_URL`) with a full-runtime probe:

1. **Compatible preexisting backend** (`kind === "ready"`): reuse it as `external` ownership, `generation=1`, detail `"Reused compatible preexisting backend"`. The SDK is never started. This covers a user-started `opencode serve` or any compatible OpenCode already on 4096.

2. **OMO registration delayed** (`kind === "unavailable"`, health ok, `omoExpected && !omo`): transition to `waiting-runtime` and poll until OMO registers, then reuse as external. If it never registers, fail with `omo-registration-failed`.

3. **Preferred port refused** (`kind === "refused"`): the port *might* be free, but a refusal alone does not prove it (a listener may accept TCP and reset HTTP). The lifecycle verifies bindability with `loopbackPortBindable(4096)`:
   - **Bindable**: start owned SDK on port `4096`.
   - **Not bindable** + ephemeral supported: start owned SDK on port `0` (OS-selected alternate loopback port). The actual URL comes from `handle.url`.
   - **Not bindable** + ephemeral NOT supported: fail `preferred-port-collision` (not retryable).

4. **Non-OpenCode collision** (`kind === "collision"`): something is on 4096 but it is not a compatible OpenCode. The lifecycle **never kills the occupant**.
   - Ephemeral supported: start owned SDK on port `0` (alternate port).
   - Ephemeral NOT supported: fail `preferred-port-collision` (not retryable).

5. **Unavailable with OMO registration failed** (`kind === "unavailable"`, `omoExpected && !omo`, health ok handled in step 2; otherwise): fail with `omo-registration-failed` or `preferred-opencode-unavailable`.

`INSTALLED_SDK_SUPPORTS_EPHEMERAL_PORT` is `true` for the pinned SDK version `1.18.14`, so the alternate-port path is available. The adapter passes `port: 0` and the SDK resolves the actual port in `handle.url`.

### Managed URL validation

`validManagedUrl` enforces that the SDK-returned URL is `http://`, loopback (`127.0.0.1`/`localhost`/`::1`), and contains no userinfo credentials. A non-loopback or credentialed URL is a startup failure (the handle is closed and restart is attempted).

---

## Dynamic canonical URL

The canonical OpenCode backend URL is **not hardcoded**. It is determined at runtime by the lifecycle and published to the rest of the system:

- **Managed reuse**: `http://127.0.0.1:4096` (the preferred URL that was probed ready).
- **Managed owned, preferred port**: the SDK returns the URL for port 4096.
- **Managed owned, alternate port**: the SDK returns an `http://127.0.0.1:<ephemeral>` URL from `handle.url`.
- **Attach**: the validated `OPENCODE_BASE_URL`.

The lifecycle state's `baseUrl` field is the single source of truth. `RuntimeStore.activateBackend(lifecycle)` reads `lifecycle.baseUrl` and constructs a new `OpenCodeClient` against it. All runtime data (`GET /api/runtime`, `GET /api/events`, snapshots) uses the `RuntimeStore`'s client, which always points at the current canonical URL. The `opencode.backend.generation` event carries `{ generation, baseUrl, ownership }` so the browser can observe backend identity changes.

The `GET /api/opencode/lifecycle` endpoint returns the full `OpenCodeLifecycleState` including `baseUrl`, so a user can read the actual managed URL to use with `opencode attach`.

---

## Auth handling

OpenCode server Basic auth is controlled by `OPENCODE_SERVER_PASSWORD` (and optional `OPENCODE_SERVER_USERNAME`, defaulting to `opencode`). See `security.ts`:

- `openCodeAuthFromEnv(env)` returns `OpenCodeBasicAuth | undefined` — `undefined` when `OPENCODE_SERVER_PASSWORD` is unset (server is unsecured).
- The auth is attached to all REST probes and the `RuntimeStore`'s `OpenCodeClient`.
- The lifecycle state exposes only `authConfigured: boolean` — **never** the credentials.
- Error messages are sanitized by `sanitizeOpenCodeError`, which redacts: explicit secrets (the configured password), URL userinfo, `basic`/`bearer` tokens, query strings, and common token patterns (`sk-`/`pk-`/`api-key`/`password-...`). Messages are capped at 240 chars.

### Attach URL validation

`validAttachUrl` rejects:
- empty/whitespace `OPENCODE_BASE_URL`,
- non-URL strings,
- non-`http(s)` protocols,
- URLs with no hostname,
- URLs containing userinfo (`user:pass@host`).

Basic auth for the attached backend comes only from `OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME` environment semantics, never from the URL. A 401/403 from the probe classifies as `unavailable` (auth failure), surfaced as `attach-unavailable`.

---

## Restart policy

Only **owned** (`control-plane`) backends are restarted. External/attached backends are never restarted by the control plane; their loss is a terminal failure with a manual Retry.

`MANAGED_RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000]` — up to 5 restart attempts with increasing backoff. `restartOrFail`:

1. Closes the current owned handle.
2. If `restartIndex >= 5`, fails with `managed-restart-exhausted` (or `omo-registration-failed` if the last reason was an OMO registration failure). This is retryable via `retry()`.
3. Otherwise schedules a restart after the delay, transitions to `restarting` with `{ attempt, maxAttempts: 5, nextRetryAt, lastReason }`, and re-enters `manage(id, restarting=true)`.

`backendLost(reason)`:
- **Attach / external**: fail `attached-backend-unavailable` (retryable). The external server is never touched.
- **Control-plane owned**: close the owned handle, transition to `restarting`, and run `restartOwned`.

`scheduleBackendLossCheck(reason, graceMs=1000)` guards against transient reconciliation failures: before declaring loss, it waits 1 s and re-probes health; only a sustained non-ready probe triggers `backendLost`.

`retry()` resets `restartIndex` to 0 and re-enters `start()` from a `failed`/`stopped` state.

---

## Generation

`generation` is a monotonically increasing integer in `OpenCodeLifecycleState`. It increments by 1 on every successful `activate()` (i.e. every time a backend becomes `connected`). It is **not** incremented on state transitions that do not produce a newly-connected backend.

The server (`index.ts`) tracks `activatedBackendGeneration`. On a `connected` lifecycle event with a new generation, it:
1. Resets per-backend state (`sessionDetails.resetForBackendGeneration()`, `omoStore.resetForBackendGeneration()`, `probeQueue.interruptForBackendChange()`).
2. Calls `runtime.activateBackend(state)` — which builds a new `OpenCodeClient` at the new `baseUrl`, bootstraps from REST, and starts the SSE loop.
3. If REST bootstrap fails, calls `lifecycle.backendLost(...)` (which for owned backends triggers restart).
4. Emits an `opencode.backend.generation` event to all SSE listeners with `{ generation, baseUrl, ownership }`.

On any non-`connected` lifecycle event (while a backend was previously activated), it deactivates the runtime backend (`runtime.deactivateBackend`), resets per-backend state, and interrupts probing. This ensures stale backend data is never served across a backend change.

---

## RuntimeStore / probe / OMO telemetry / model / Doctor integration

### RuntimeStore

`RuntimeStore` (`runtime/store.ts`) is the in-memory normalized runtime state. It has no independent backend target — it is activated by the lifecycle:

- `activateBackend(lifecycle)`: constructs `OpenCodeClient(lifecycle.baseUrl, ...)`, sets `backendGeneration`, bootstraps (full REST reconcile), and starts the SSE loop. Idempotent if the same baseUrl+generation is already active.
- `deactivateBackend(reason)`: aborts SSE, clears client and all backend-derived state (sessions, providers, agents, permissions, mcp). Used when the lifecycle leaves `connected`.
- `onBackendLost`: callback → `lifecycle.scheduleBackendLossCheck(reason)`.
- `onConnectionChange`: callback → `lifecycle.updateRuntimeConnection(connection)` (updates `ready.rest`/`ready.sse` in place, without a state transition).
- `getSnapshot()` / `getRuntimeState()`: include `baseUrl` and `backendGeneration` from the current client.

### Model probe queue

`ModelProbeQueue` (Slice 15) runs explicit-only minimal-inference model probes through isolated tagged OpenCode sessions. It is interrupted on every backend generation change (`interruptForBackendChange()`) so probes never target a stale backend. It checks `runtime.getConnection().rest === "connected"` before issuing probes.

### OMO runtime telemetry

`OmoRuntimeStore` (Slice 14) is a read-only observation lane. It is reset on backend generation change (`resetForBackendGeneration()`). It refreshes from `runtime.getSnapshot()` piggybacking on runtime activity, with a 3 s memoization interval. It tolerates per-session fetch failures and bridge absence.

### Doctor

`DoctorEngine` (Slice 12) is invalidated on every lifecycle state change (`doctor.invalidate()`). The doctor input builder reads `lifecycle.getState()` and gates capability/telemetry building on `lifecycleState.status === "connected"`. Doctor never fails the server; it is read-only diagnostics. Lifecycle failures surface as doctor evidence, not vice versa.

### Overview / API surfaces

`GET /api/overview` and `GET /api/runtime` include `lifecycle: OpenCodeLifecycleState` so the browser can render the backend mode, ownership, status, baseUrl, generation, readiness, and any error/restart info. `GET /api/opencode/lifecycle` returns the lifecycle state alone; `POST /api/opencode/lifecycle/retry` triggers `lifecycle.retry()`.

---

## UI contract

The browser receives:

- `opencode.lifecycle.updated` events on `GET /api/events` carrying the full `OpenCodeLifecycleState`.
- `opencode.backend.generation` events carrying `{ generation, baseUrl, ownership, at }` when a new backend is activated.
- `connection` events with `RuntimeConnection` (rest/sse state, stale flag, opencodeBaseUrl).
- `snapshot`/`runtime.updated` events with `RuntimeStateDto` including `baseUrl` and `backendGeneration`.

The UI should render:

- **Mode** (Managed/Attach) and **ownership** (control-plane/external).
- **Status** (initializing/starting/waiting-health/waiting-runtime/connected/restarting/stopped/failed).
- **baseUrl** — the actual canonical URL. For Managed alternate-port, this is the ephemeral URL, not `:4096`.
- **Generation** — increments on each backend activation.
- **Readiness** — health/configProviders/providers/agents/omo/rest/sse booleans.
- **Error** — `{ code, message (redacted, ≤240 chars), action, retryable, at }` when failed.
- **Restart** — `{ attempt, maxAttempts: 5, nextRetryAt, lastReason }` when restarting.
- A **Retry** action that `POST /api/opencode/lifecycle/retry`.

The UI must not assume `baseUrl` is always `:4096`. In Managed alternate-port mode it is an OS-selected loopback port available only after the lifecycle activates.

---

## Shutdown / dev hot restart

### Server graceful shutdown

`apps/server/src/index.ts` registers:

```ts
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("beforeExit", () => void lifecycle.stop());
```

`shutdown(signal)` is idempotent (`shuttingDown` guard) and runs, in order:

1. `runtime.stop()` — aborts SSE, clears timers.
2. `omoStore.dispose()`.
3. Closes config watchers.
4. `await lifecycle.stop()` — closes the owned SDK backend handle (if any), transitions to `stopped`. For external/attached backends, this is a no-op on the backend itself (nothing to close).
5. `server.stop(true)` — stops the Bun HTTP server.

This is the path that closes the owned SDK OpenCode backend. If the server is SIGKILLed or orphaned, this path does not run and the owned backend leaks — which is why the dev supervisor forwards SIGINT/SIGTERM rather than relying on detached background processes.

### Dev supervisor (`scripts/dev-supervisor.ts`)

`bun run dev` runs `scripts/dev-supervisor.ts`, which:

- Spawns the server (`bun apps/server/src/index.ts` from the Owl install root) and the web (`bun run dev` in `apps/web`, which runs Vite) as direct child processes with inherited stdio. The install root is discovered portably via the `omo-control-plane` manifest; the target project is selected via `OMO_CP_PROJECT_DIR` (defaulting to the server's startup cwd, which under this supervisor is the install root checkout) and the server `chdir`s to it in Managed mode before SDK construction.
- Forwards SIGINT/SIGTERM to both children and waits for them to exit before exiting itself, so the server's `shutdown()` runs and closes the owned SDK backend.
- If one child exits unexpectedly, stops the survivor and exits non-zero.
- Does **not** use `bun --watch` for the server. `bun --watch` intercepts SIGINT/SIGTERM and does not exit (it treats them as restart triggers), which prevents the server's graceful shutdown and leaks the owned backend. The server's own `dev:server` script keeps `--watch` for users who want hot restart as a separate command.
- Does **not** spawn `opencode serve`. In Managed mode the server's lifecycle manager starts/owns/stops the SDK backend itself.
- Does **not** invent PID files, log streaming, or crash-restart supervision. Process lifetime coordination only.

Exit codes: `0` clean, `1` unexpected child exit, `130` (128+SIGINT) signal-initiated teardown.

### Hot restart

For hot restart during development, use `bun run dev:server` (which runs the server's `dev` script with `--watch`) in one terminal and `bun run dev:web` in another, or accept that `bun run dev` prioritizes clean shutdown over auto-restart. The `--watch` flag is intentionally omitted from the supervisor for signal-safety reasons documented above.

---

## Tests

The lifecycle is covered by `apps/server/src/opencode/lifecycle.test.ts` (Bun test). The tests use dependency injection (`startSdk`, `probe`, `sleep`, `portBindable`, `ephemeralPortSupported`, `env`) to verify the state machine without a live OpenCode:

| Test | Verifies |
|------|----------|
| attach invalid/empty fails and never invokes SDK | `invalid-attach-url`, 0 SDK starts |
| attach is external, increments generation once, and never closes | external ownership, generation=1, 0 closes on stop |
| managed reuses compatible preferred backend as preexisting external | external ownership, "preexisting" detail, 0 SDK starts |
| preexisting OpenCode waits for delayed OMO registration before reuse | waiting-runtime → connected, 0 sleeps |
| refused preferred port starts owned SDK with inherited config-dir setup | control-plane ownership, generation=1, `OPENCODE_CONFIG_DIR` inherited, port=4096 |
| non-OpenCode collision uses verified port:0 fallback and publishes actual URL | port=0, baseUrl from handle.url |
| HTTP refusal with an occupied preferred port also uses alternate port | portBindable=false → port=0, actual URL |
| collision is actionable terminal failure when ephemeral fallback disabled | `preferred-port-collision`, not retryable, 0 SDK starts |
| owned startup errors are redacted and restart is bounded | 6 starts (1 initial + 5 restarts), `managed-restart-exhausted`, password redacted |
| owned backend loss closes only owned handle and activates one new generation | generation 1→2, 2 starts, 1 close |

Additional tests: `apps/server/src/opencode/sdk-adapter.test.ts`, `apps/server/src/opencode/security.test.ts`, `apps/server/src/opencode/client.test.ts`, `apps/server/src/runtime/store.test.ts`, `apps/server/src/config.test.ts`.

> **Note:** These are unit tests with injected fakes. They do not constitute live verification against a real OpenCode backend. See the procedure below.

---

## Controlled live verification results

Controlled verification was completed on 2026-08-13 against installed OpenCode `1.18.16` and SDK `@opencode-ai/sdk@1.18.14`, within the authorized project/config roots. No manual `opencode serve` was started during the managed test.

### Prerequisites

- Bun installed.
- `@opencode-ai/sdk@1.18.14` installed under `~/.config/opencode/node_modules` (the adapter pins this version).
- OMO-Slim installed in the active OpenCode config (`~/.config/opencode`).
- No other process listening on `127.0.0.1:4096` (for clean-start Managed verification), or a compatible `opencode serve` already running (for reuse verification).

### Results

1. **Clean-start Managed (owned backend): PASS**
   ```bash
   # ensure nothing is on :4096
   curl -s http://127.0.0.1:4096/global/health || true
   bun run dev
   ```
   - An existing detached standalone server on `:4096` was identified through the listener-specific OS API and stopped only after explicit approval.
   - `curl http://127.0.0.1:4096/global/health` then failed with connection refused.
   - `env -u OPENCODE_BASE_URL bun run dev` started the control plane, frontend, and SDK-owned OpenCode without a manual serve command.
   - Lifecycle reached `mode: managed`, `ownership: control-plane`, `status: connected`, `generation: 1`, `baseUrl: http://127.0.0.1:4096`, version `1.18.16`.
   - Health, config/providers, providers, agents, OMO registration, REST, and SSE readiness were all true.
   - Runtime used project `<owl-install-root>` (target project — in that run the Owl checkout, because `OMO_CP_PROJECT_DIR` was unset) and config `<opencode-config-dir>` (`$HOME/.config/opencode`); 78 sessions and authenticated provider/model state loaded.
   - Doctor reported OpenCode, OMO, runtime, sessions, and security healthy with zero errors.

2. **Preexisting/external ownership: PASS by automated contract and prior live listener observation**
   - Automated lifecycle tests prove compatible preferred-port reuse performs zero SDK starts and zero closes.
   - The pre-test standalone listener was observed but intentionally stopped to satisfy the mandatory clean-start proof; it was not killed by lifecycle code.

3. **Attach mode ownership: PASS by automated contract**
   - Tests prove explicit `OPENCODE_BASE_URL` selects Attach, starts no SDK backend, performs no managed fallback, and never closes the external handle.

4. **Clean shutdown and recovery: PASS**
   - SIGINT sent to the dev supervisor stopped the server and frontend through the coordinated shutdown path.
   - Both `:8787` and managed `:4096` refused connections afterward; no owned OpenCode listener remained.
   - A second clean `bun run dev` reached Managed/Control Plane/Connected again, proving normal recovery after shutdown.

5. **Same-runtime TUI: PASS**
   - `opencode attach http://127.0.0.1:4096 --dir <target-project> --mini` (in that run `<target-project>` was `<owl-install-root>`) opened the installed TUI against the managed URL.
   - The attached TUI submitted the harmless prompt `Reply exactly: managed-runtime-verification` and displayed the exact response.
   - Control-plane SSE observed `message.updated`, `message.part.delta`, and `session.updated` activity during that interaction.
   - Runtime session count increased 78 → 79 and exposed session `ses_004e6ce74ffeQItf97CGVh4oII`, title `Managed runtime verification`, on generation 1. This proves the TUI and control plane observed the same backend.

6. **Unexpected owned-backend exit + restart: PASS**
   - Only the current listener on managed `:4096`, verified as the control-plane server child, was terminated.
   - The lifecycle recovered through its bounded restart path and reached `connected` with generation 2 and REST/SSE true.
   - Final SIGINT again stopped both the recovered control plane and owned backend; `:4096` refused afterward.

### Verification boundary

The live run proves managed start, readiness, shared-runtime TUI activity, unexpected-exit recovery, generation change, clean shutdown, and clean relaunch. Attach/preexisting no-close semantics and collision/auth branches remain covered by deterministic automated tests rather than additional destructive live scenarios.

---

## Limitations

- **No PID/process handle.** The installed SDK returns `url + close()` only. The lifecycle cannot signal the OpenCode process directly; it can only call `close()`. There is no PID in the state surface and no process-level supervision.
- **No success log stream.** The SDK offers no success log API. Only bounded, redacted startup *errors* are surfaced (≤2 000 chars in the adapter, ≤240 chars in state). There is no startup log stream.
- **Managed cwd inheritance.** The SDK has no cwd option and inherits `process.cwd()`. In Managed mode the server changes cwd to the selected target ( `OMO_CP_PROJECT_DIR` or the startup cwd ) immediately after config load, before lifecycle/SDK construction, so the backend runs in the target project. Attach mode does not chdir.
- **Target vs install root.** The managed backend and all project-scoped requests use the selected target project root; the Owl install root (where `packages/omo-telemetry-bridge` lives) is distinct and discovered portably from the `omo-control-plane` manifest.
- **`bun --watch` is signal-unsafe.** It intercepts SIGINT/SIGTERM and does not exit, so the dev supervisor does not use it for the server. Hot restart is available via `dev:server` separately, at the cost of manual signal handling.
- **External backend loss is terminal.** Attach/external backends are never restarted by the control plane. Loss requires manual Retry.
- **No provider-discovery remediation.** This slice does not address provider discovery. See [Boundary](#boundary).
- **Version pin.** The adapter rejects SDK versions other than `1.18.14`. A SDK upgrade requires an adapter update.

---

## Boundary

This side remediation covers the canonical OpenCode backend lifecycle across shared contracts, the control-plane server, the web UI, development workflow, and documentation:

- Shared lifecycle and event contracts.
- Server lifecycle ownership, canonical client routing, runtime generation handling, probes, telemetry invalidation, and Doctor integration.
- Ownership-aware web UI and lifecycle controls.
- Root development scripts and `scripts/dev-supervisor.ts`.
- README, architecture index, this document, and narrowly relevant recon supersession notes.

It explicitly **stops before**:

- **Provider-discovery remediation** — not in scope here.
- **Slice 16** — not started.

It does not implement automatic TUI launch, provider-discovery remediation, Slice 16, provider authentication UI, remote discovery, packaging, or unrelated roadmap work.

---

## Filesystem boundary

This project only reads:

1. Owl install root — discovered portably from the root `package.json` (`omo-control-plane`)
2. Target project root — `OMO_CP_PROJECT_DIR` if set (must be absolute existing directory), otherwise the server's startup cwd (under `bun run dev`/`dev:server`/`start` this is the Owl checkout)
3. Active OpenCode config root — `OPENCODE_CONFIG_DIR` if set (must be absolute existing directory), otherwise `$HOME/.config/opencode`

Authorized roots are exactly the realpaths of those three directories. Runtime session metadata may reference other paths; those paths are not opened. In Managed mode the server changes cwd to the selected target immediately after config load so the SDK inherits it; Attach mode does not chdir. The managed SDK backend inherits the server process environment and config dir; it does not expand the control plane's authorized read roots. Telemetry bridge package identity (`packages/omo-telemetry-bridge`) resolves under the Owl install root, not the target project.
