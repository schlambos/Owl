# OMO Telemetry Bridge — Activation Guide

Read-only OpenCode plugin that snapshots OMO-Slim's `globalThis`
`Symbol.for` stores (fallback-in-progress set, continuation-attempt gate,
cmux session store, multiplexer session-manager state) over a loopback HTTP
endpoint: `GET http://127.0.0.1:<port>/telemetry` and `GET /health`.

## Schema v3

The bridge emits **schema v3** snapshots. v3 adds two top-level fields to the
v1/v2 store snapshot:

- **`identity`** — per-plugin-instance bridge identity:
  - `pluginInstanceId`: fresh random UUID per plugin instance.
  - `startupTimestamp`: `Date.now()` at plugin init.
  - `canonicalOrigin`: normalized OpenCode origin from `PluginInput.serverUrl`
    (scheme + host + port only; no userinfo/path/query/fragment).
  - `nonceFingerprint`: SHA-256 hex fingerprint of the activation nonce (exactly
    64 lowercase hex characters). The **raw nonce is never serialized or
    retained** beyond the digest call.
  - `transportMode`: always `"loopback-http"`.
  - `bridgePackageVersion`: read from `package.json` at init (best-effort).
  - `schemaVersion`: `3`.
  - `capturedAt`: identity capture timestamp.
- **`capabilities`** — capability-level availability for exactly four
  allowlisted stores (`fallbackInProgress`, `continuationGate`,
  `multiplexerManager`, `cmuxStore`), each reported as `"present"`,
  `"absent"`, or `"malformed"`. Plus three explicitly-unavailable flags:
  - `runtimePreset: false` — module-scoped variable inside the OMO bundle, not
    exported; unreachable and never fabricated.
  - `workerReuse: false` — lives inside the OMO BackgroundJobBoard closure; not
    externally derivable; never fabricated.
  - `terminalCapture: false` — no terminal/PTY/scrollback data is exposed by
    any allowlisted store; the bridge performs no terminal I/O.

v1/v2 store fields (`stores.*`) are preserved unchanged. The server sanitizer
ignores unknown top-level fields, so v3 is backward-compatible with v1/v2
consumers.

### Canonical v3 contract

The bridge defines one canonical v3 contract inside the package for later
server integration:

- **Transport literal**: `"loopback-http"` (always).
- **Nonce fingerprint**: SHA-256, exactly 64 lowercase hex characters.
- **Identity fields**: `pluginInstanceId`, `startupTimestamp`, `capturedAt`,
  `schemaVersion`, `transportMode`, `canonicalOrigin?`, `nonceFingerprint?`,
  `bridgePackageVersion?`.
- **Capabilities**: exactly four observable stores
  (`fallbackInProgress`, `continuationGate`, `multiplexerManager`,
  `cmuxStore`) plus explicitly `false` `runtimePreset`, `workerReuse`,
  `terminalCapture`.
- **No raw nonce** appears in any response (health or telemetry).

## Loopback binding

- **Loopback only.** The server binds `127.0.0.1` (hardcoded; not configurable
  via options, env, or config). No CORS headers, no auth — acceptable for a
  loopback-only endpoint. The bridge never binds `0.0.0.0`.
- **Read-only.** The plugin registers no event/config/tool hooks, performs no
  network writes, no OpenCode mutations, and no file writes. Store reads never
  mutate.
- **No secrets exposed.** Snapshots contain session IDs, small counters, and
  primitive gate values only. Object/function values, WeakMaps, and anything
  not explicitly whitelisted are dropped. The activation nonce is reduced to a
  SHA-256 fingerprint and never appears in any response.

## Activation model (Phase 2)

**Registration is not activation.** A plugin registration with no managed
activation identity resolves to a typed **inactive** outcome
(`activation-absent`): the plugin loads with supported no-op hooks, emits one
stable secret-free structured log line, and performs **zero**
acquire/serve/bind calls. There is **no legacy default port** and no
zero-config/manual bind path.

### Activation channels (exactly one complete channel required)

1. **Env channel (canonical managed path)** — bare string registration plus
   launch-scoped environment overlay:
   `OMO_BRIDGE_PORT` + `OMO_BRIDGE_ACTIVATION_NONCE`, supplied only through
   the control-plane launch boundary.
2. **Tuple channel** — `["<plugin>", { port, activationNonce }]` in the
   OpenCode config plugin array.

Channels are **never mixed**: tuple port + env nonce (or vice versa) is
invalid. A partial channel (port-only or nonce-only) is invalid. Invalid
values (port outside the managed range, non-string/out-of-bounds nonce)
fail closed. All of these produce a typed **invalid** outcome with stable
redacted codes (`activation-incomplete` / `fingerprint-unavailable` plus a
detail code), a structured log with NO raw values, and zero bind.

**Explicit empty env is invalid, not absent.** An env key that is present
but empty or whitespace-only counts as PRESENT and fails validation — it
never silently resolves to inactive. The activation nonce is **never
trimmed before hashing**: the exact env/option bytes are fingerprinted so
the control-plane's stored fingerprint matches exactly.

When BOTH channels are complete, the explicit tuple channel wins
(long-standing options-over-env precedence, preserved).

A complete managed activation additionally requires a **parseable canonical
origin** from `PluginInput.serverUrl`; a missing/unparseable origin is an
invalid activation and never binds.

### Managed port range

The managed allowed port range is **`8788..8803`** inclusive. Every active
activation must carry an explicit port in this range — there is no default.

### Activation nonce length bound

The activation nonce must be a string of **16..256 characters** inclusive.
Shorter, longer, empty, or non-string nonces fail closed with a stable detail
code (`nonce-too-short`, `nonce-too-long`, `nonce-empty`, `nonce-wrong-type`).
Only the SHA-256 fingerprint is retained; the raw nonce is never returned,
logged, or serialized.

## Routes

- `GET /health` → `{ ok, schemaVersion, bound, capabilities, pluginInstanceId? }`
  (schemaVersion from the `TELEMETRY_SCHEMA_VERSION` constant, never hardcoded)
- `GET /telemetry` → full v3 snapshot (`TelemetrySnapshot`)
- Non-GET on `/health` or `/telemetry` → `405 Method Not Allowed` (with
  `Allow: GET` header)
- Any other path → `404 Not Found`

No CORS headers on any response.

## Startup / restart

Plugins load **only at OpenCode startup** — a restart is required after
registration or option changes. There is no hot reload.

### Ownership state machine + lease lifecycle (Phase 2)

The bridge uses a **versioned `Symbol.for` globalThis registry slot**
(`Symbol.for("omo-telemetry-bridge.v2.active")`) with an explicit state
machine:

```text
Absent → Starting → Active | Failed(start)
Active → Stopping → Absent | Failed(stop, fenced)
```

- **Every transition is compare-and-transition + readback** on the exact
  record object. A registry read failure is fail-closed (typed rejection,
  zero serve) — an unreadable registry is never treated as Absent. A lost or
  replaced epoch is never clobbered.
- **Starting is published BEFORE `serve` is called.** A starting-publication
  failure means zero serve calls.
- **An acquisition observing `stopping` rejects typed** — it never reuses,
  refcounts, or rebinds a stopping epoch.
- **Stop is async (Bun's real contract).** The final release transitions the
  exact epoch to `stopping` and AWAITS `server.stop()` while that epoch
  remains `stopping`; resolution clears only the exact stopping epoch, a
  rejection fences `failed-stop`. Lease disposal is async (`dispose():
  Promise<boolean>`) and is awaited from the plugin's `dispose` hook.
- **Single-flight dispose.** Each lease is `open | releasing | settled`;
  `releasing` is entered synchronously before any release work, so
  concurrent/unawaited `dispose()` calls share one in-flight release and can
  never double-decrement. On a retryable release failure the lease returns
  to `open` only after the in-flight promise settles — and `dispose()`
  REJECTS with a typed, redacted `BridgeActivationError`
  (`activation-registry-failed` + detail) that the plugin's `dispose` hook
  propagates to the host. An explicit retry on the same lease accounts
  exactly once.
- **Readback-unknown transitions never strand state.** If an Active→Stopping
  write may have applied but the readback fails, BOTH candidate records are
  fenced in place (never a reusable active, never an unowned stopping), a
  cleanup-pending realm poison retaining the owned handle privately is
  published AND readback-verified BEFORE the stop is awaited, and the stop
  runs exactly once. If the poison itself cannot be verified, the release
  fails typed and never claims cleanup safety.
- **Transition outcomes are discriminated** (`verified | not-written |
  unknown | replaced`). A write-applied/readback-unknown transition poisons
  the exact next record in place before cleanup and fences the realm. A
  realm-wide poison slot (`omo-telemetry-bridge.v2.poison`) retains orphan
  handle metadata (epoch, port, key digest) when cleanup of a lost/replaced
  epoch fails — it blocks ALL acquisitions without ever clobbering or
  adopting a replacement listener.
- **Stop success clears only the exact stopping epoch.** A clear failure
  leaves an explicit blocking `cleanup-failed` record; a failed-start
  cleanup failure leaves a blocking `failed-start` record; a fence-write
  failure still fences the in-slot object in place. Blocking records reject
  all acquisitions (`activation-fenced`) and are never reusable.
- **Active never observably holds refcount 0**: the final release
  transitions to Stopping at refcount 1 before stopping. Refcount mutation
  failures are fail-closed and never return a lease.
- **Activation↔served identity is revalidated before any serve/publication**:
  activation fingerprint must exactly equal the identity fingerprint (both
  64 lowercase hex); host exactly `127.0.0.1`; explicit managed port
  `8788..8803`; schema exactly 3; transport `loopback-http`; normalized
  parseable canonical HTTP loopback origin.
- **Compatible concurrent/reentrant acquisitions join the one starting
  epoch**; every accepted waiter settles (success or typed failure).
- **Exact reuse key:** normalized canonical origin, host `127.0.0.1`, exact
  port, `loopback-http`, schema version 3, exact nonce fingerprint. ALL fields
  required.
- **Incompatible or incomplete identity is a typed rejection**
  (`activation-incompatible`) with zero bind/refcount/stop/adoption. The old
  "first registration wins, duplicate config merely warned" behavior is gone:
  a mismatched managed identity NEVER reuses the active server.
- **Each lease is fenced to its exact owner epoch.** Stale, repeated, or
  out-of-order dispose calls cannot affect another epoch. An intermediate
  dispose preserves the listener; the final dispose stops the server exactly
  once.
- **A stop failure fences the registry** (`failed-stop`): the record and
  server handle are retained, and all new acquisitions/rebinds are rejected
  (`activation-fenced`). A live untracked server followed by a rebind is never
  permitted.
- **A failed start settles all waiters and returns the slot to Absent** — a
  later, separate activation attempt may try again; THIS attempt fails typed.
- The registry is **realm-local** (`Symbol.for` is not process-global).
  Cross-realm/process duplicate activation surfaces as a typed EADDRINUSE
  loser; cross-realm reuse is never claimed.

### Bind failure (managed activation)

A complete managed activation that cannot bind (e.g. `EADDRINUSE` because a
foreign or unmanaged listener holds the port) **rejects plugin
initialization with a typed, redacted `BridgeActivationError`**
(`activation-start-failed`, detail classification only — no raw error text).
The OpenCode host may catch a rejected plugin initializer; this is a
rejection of plugin initialization, not a claim about process termination.
The failure is surfaced, never swallowed as a successful unbound load. There
is **no port fallback, retry, sleep, probe, or listener adoption**. The
`/health` endpoint is only reachable when a server is bound.

## Registration (managed path)

**Control-plane registration is the intended managed path.** The OMO-Slim
server is a *consumer* of the bridge (via `OMO_BRIDGE_BASE_URL`); it does not
register or load the bridge plugin. The plugin must be registered in the
canonical OpenCode runtime config (`opencode.json` plugin array) and the
process restarted.

1. Add the plugin path to the `plugin` array in `opencode.json` **via the
   control-plane safe write / revision pipeline** (never hand-edit a live
   config while OpenCode is running):

   ```jsonc
   {
     "plugin": [
       // ...existing plugins (e.g. oh-my-opencode-slim)...,
       "./packages/omo-telemetry-bridge"
     ]
   }
   ```

   > **A bare string registration does NOT bind by itself.** It activates
   > only when the launch-scoped env overlay (`OMO_BRIDGE_PORT` +
   > `OMO_BRIDGE_ACTIVATION_NONCE`) is present — supplied exclusively by the
   > control-plane launch boundary for owned managed launches. Interactive
   > or otherwise unmanaged processes loading this registration stay
   > **inactive** and never claim a port.

   For managed use with explicit options, use the tuple form:

   ```jsonc
   {
     "plugin": [
       ["./packages/omo-telemetry-bridge", { "port": 8789, "activationNonce": "<nonce>" }]
     ]
   }
   ```

   > **Tuple runtime support:** the installed `@opencode-ai/plugin@1.18.14`
   > type declarations (`dist/index.d.ts:48-50`) allow
   > `Array<string | [string, PluginOptions]>`, so tuple plugin specs with
   > options are source-verifiable in the type contract. However, **tuple
   > runtime acceptance is not yet proven** for the installed runtime (which
   > may carry patches beyond 1.18.14). Treat tuple as a **controlled-probe
   > gated** form; env/string is the **foundation fallback**. Do not assume
   > tuple runtime support is proven without a controlled canonical-runtime
   > test.

   > **Absolute managed entry identity:** the plugin path shown above is a
   > relative path for config convenience only. The **canonical** identity of
   > a managed registration is the absolute resolved path (or `file://` URL)
   > that OpenCode resolves it to at load time. Do not treat the relative path
   > string as the canonical identity — the control plane should track the
   > absolute resolved entry.

2. **Restart OpenCode.** The plugin starts its loopback server during plugin
   init.

3. Verify:

   ```sh
   curl -s http://127.0.0.1:8788/health
   # {"ok":true,"schemaVersion":3,"bound":true,"capabilities":{...},"pluginInstanceId":"..."}
   curl -s http://127.0.0.1:8788/telemetry | jq .
   ```

   Fields under `stores` appear only when the corresponding OMO store exists
   and has a valid shape; anything else is omitted.

## Rollback

1. Remove the `"./packages/omo-telemetry-bridge"` entry (or tuple) from the
   `plugin` array in `opencode.json` (again, via the safe write / revision
   pipeline).
2. Restart OpenCode. The server is also stopped automatically via the
   `dispose` hook on any normal shutdown.

## Migration note (Phase 2)

- **Zero-config/manual binding was removed.** Previously a bare registration
  bound legacy default port `8788` with no nonce. That fail-open path caused
  unmanaged interactive OpenCode processes to claim the managed port
  (cross-process activation leakage). Now: bare registration → typed
  inactive, no bind.
- **Action for manual/unmanaged users:** supply a complete activation
  channel — either env (`OMO_BRIDGE_PORT` + `OMO_BRIDGE_ACTIVATION_NONCE`) or
  the tuple form — or the bridge stays inactive by design.
- **Partial or mixed-channel activation now fails closed** (typed invalid,
  no bind) instead of silently falling back to defaults.
- **A managed activation that hits `EADDRINUSE` now surfaces a typed
  redacted failure** instead of logging and continuing unbound. Resolve the
  duplicate/unmanaged activation holding the port — never kill unknown
  listeners; there is no alternate-port fallback.

## Capability limits

The bridge exposes **capability-level availability** only — not runtime
state beyond the four allowlisted stores. The following remain **unavailable**
and are never fabricated:

- **Runtime preset** — module-scoped variable inside the OMO bundle
  (`dist/index.js:21244`), not exported from the plugin entry
  (`dist/index.js:41424-41425`). Unreachable.
- **Worker reuse** — lives inside the OMO `BackgroundJobBoard` closure
  (`dist/index.js:25015` class, `dist/index.js:25225` state). Not externally
  derivable.
- **Terminal capture** — no terminal/PTY/scrollback data is exposed by any
  allowlisted store. The bridge performs no terminal I/O.

Store reads preserve conservative semantics: primitive-only whitelist, record
caps (100) applied consistently to fallback IDs, continuation gate maps, and
multiplexer/cmux records, sorting/dedup, and no mutation.

## Compatibility

- Verified against `oh-my-opencode-slim@2.2.10` (`dist/index.js` citations
  in `src/stores.ts`): the four whitelisted `Symbol.for` keys and their
  shapes.
- `Symbol.for` keys and store shapes **may change across OMO versions**. The
  bridge validates every shape (`Set`/`Map` `instanceof`, plain-object
  checks), wraps each read in its own try/catch, and **omits** any store it
  does not recognize — unknown symbols are ignored by construction. It never
  throws into OpenCode's event loop.
- Newer OMO (2.2.13+) ships its own `server.js`; the bridge tolerates either
  set of stores being missing. If a managed activation's port collides with
  anything, plugin init rejects with a typed redacted `BridgeActivationError`
  (no fallback, no adoption); an unmanaged registration simply stays inactive
  and never collides.
- **After every OMO upgrade, re-cross-check** the whitelisted keys/shapes in
  `src/stores.ts` against the new `dist/index.js` and bump
  `TELEMETRY_SCHEMA_VERSION` if the snapshot shape changes.