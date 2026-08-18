# Slice 17 — Telemetry Bridge Activation Manifest

**Date:** 2026-08-14  
**Status:** Implemented (backend management pipeline + web UI). No live bridge activation was performed.  
**Scope:** `packages/omo-telemetry-bridge`, `apps/server/src/opencode-bridge`, bridge routes in `apps/server/src/index.ts`, `apps/web/src/pages/system/TelemetryBridgeSection.tsx`, `apps/web/src/pages/system/telemetry-bridge-types.ts`, `apps/server/src/omo-runtime/manager.ts`, `apps/server/src/opencode/lifecycle.ts`, `apps/server/src/opencode/sdk-adapter.ts`, and the shared DTOs in `packages/shared/src/index.ts`.

This document records the **post-implementation** canonical behavior of the telemetry-bridge activation lane. It is meant for future operators who need to understand what the control plane actually does, what it deliberately does not do, and what validation exists.

---

## 1. What this slice built

| Area | Implementation |
|---|---|
| Bridge plugin | `packages/omo-telemetry-bridge/src/index.ts` — OpenCode plugin entry point. |
| Bridge v3 snapshot/identity/capabilities | `packages/omo-telemetry-bridge/src/stores.ts`. |
| Bridge option/env resolution | `packages/omo-telemetry-bridge/src/options.ts`. |
| Bridge lease lifecycle (global Symbol registry) | `packages/omo-telemetry-bridge/src/lifecycle.ts`. |
| Bridge HTTP routing | `packages/omo-telemetry-bridge/src/routing.ts`. |
| Server config/source/revision foundation | `apps/server/src/opencode-bridge/{types,service,resolver,canonical,extractor,byte-patch,port-selection,revisions-bridge,launch-boundary,override,status,watcher}.ts`. |
| Managed OpenCode restart integration | `apps/server/src/opencode/lifecycle.ts` `restartForTelemetryBridge`, `apps/server/src/opencode/sdk-adapter.ts` `withOwnedBridgeLaunchEnv` integration. |
| Canonical bridge observation | `apps/server/src/omo-runtime/manager.ts` `TelemetryBridgeManager`. |
| Server HTTP routes | `apps/server/src/index.ts` `/api/opencode/bridge/*` (status, preview, apply, restore, restart, probe). |
| Web UI | `apps/web/src/pages/system/TelemetryBridgeSection.tsx` + `telemetry-bridge-types.ts`. |
| Shared DTO/event contracts | `packages/shared/src/index.ts` `TelemetryBridgeStatusDto`, `TelemetryBridgeStatusSummary`, `telemetry-bridge.updated` event. |

---

## 2. Truth layers

The System → Telemetry Bridge UI deliberately renders four separate truth layers so an operator cannot confuse desired config, committed source, effective runtime registration, and bridge health:

1. **Desired registration** — the committed activation state in `data/control-plane-bridge.db`. This is what the control-plane safe-write pipeline has recorded (`enabled`, `port`, `nonceFingerprint`, `sourceHash`, `revisionId`, `registrationTransport`, `stateDisposition`).
2. **Committed source / restart-required** — the raw `opencode.json`/`opencode.jsonc` file on disk that carries the bridge plugin entry. After a successful `apply` or `restore` the source hash is verified against the committed state; the UI shows **“Committed — awaiting restart”** until the owned OpenCode runtime is explicitly restarted.
3. **Effective runtime registration** — the sanitized plugin sequence returned by OpenCode `GET /config` (`effectivePluginView`). This shows whether the *currently running* OpenCode process actually loaded the bridge plugin. It can lag behind committed source until restart.
4. **Runtime connection / health** — `TelemetryBridgeManager` fetching `GET /health` and `GET /telemetry` from the loopback bridge endpoint. This layer tells you whether the bridge plugin, once loaded, is bound and responding.

The UI never collapses these layers into a single boolean.

---

## 3. Safe source resolution, preview, apply, revisions, restore, recovery

All writes to `opencode.json`/`opencode.jsonc` go through the server-side `BridgeService`:

- **Trusted effective view.** `BridgeService` receives the effective plugin view from the *current canonical* `OpenCodeClient.effectivePluginView()` only; browser callers cannot forge it.
- **Authorized candidate resolution.** `resolveAuthorizedCandidate` compares every authorized source candidate (`opencode.json` and `opencode.jsonc` under both the config dir and project root) against the effective plugin sequence and requires **exactly one** match. Zero, multiple, malformed, symlink-escaping, or scope-escaping candidates block management.
- **Preview is a no-write diff.** `POST /api/opencode/bridge/preview` returns a redacted, bridge-only diff (`diff`), target path/format, baseline hash, proposed hash, selected port, and a one-shot `previewId`.
- **Preview confirmation registry.** The server stores the preview operation in a bounded, TTL’d in-memory registry. `POST /api/opencode/bridge/apply` must provide `confirmation` matching the preview operation; mismatch or stale preview is rejected.
- **Atomic apply ordering.** Apply consumes the preview, re-fetches the effective view, re-checks the source hash, re-checks the selected port is still free, validates the byte patch, parses the proposed text, writes to a crypto-random temp file, fsyncs, re-reads the temp for parity, re-checks the target file baseline hash and symlink state, atomically renames, fsyncs the directory, re-reads the target, proves the post-write hash, and finalizes the SQLite transaction.
- **Prepared intents / recovery.** A `bridge_activation_intents` row is inserted before rename. If rename succeeds but DB finalize fails, the intent remains `recovery-pending`; startup `reconcile()` and explicit restore paths can finalize it when the disk hash matches.
- **Revisions.** Every successful apply creates a `bridge_revisions` row with `baselineHash`, `postWriteHash`, `bytePatch`, and sanitized metadata (no raw nonce).
- **Restore.** `POST /api/opencode/bridge/restore` takes `revisionId` + `expectedSourceHash`. It verifies the current source hash, validates the stored byte patch schema, applies the exact inverse patch, verifies the restored hash matches the revision baseline, and finalizes a new intent/revision.

Raw activation nonces are never stored in revision rows, DTOs, logs, SSE payloads, or error messages. Only the SHA-256 fingerprint is retained.

---

## 4. Two-step registration, then explicit dashboard-owned restart

The control plane **never** auto-restarts OpenCode when a bridge config is written:

1. **Register / Remove step.** The operator previews and applies the bridge plugin addition or removal. The response always includes:
   ```jsonc
   {
     "ok": true,
     "apply": { ... },
     "restartRequired": true,
     "restartAction": "POST /api/opencode/bridge/restart with confirmation 'restart-owned-bridge'",
     "note": "Config applied. No runtime action occurred. An explicit restart request is required to activate the bridge."
   }
   ```
2. **Restart step.** Only when `actions.canRestart === true` does the UI expose a restart control. The restart request is built from the current real DTO/state and requires:
   - `intent`: `"activate" | "deactivate" | "recover-activation-failure"`
   - `expectedGeneration`: current lifecycle generation
   - `expectedSourceHash`: committed config hash
   - `revisionId`: committed revision id
   - `confirmation`: exact string `"restart-owned-bridge"`
   - For activate/recover: `nonceFingerprint` and `port` from committed state.

The server validates every precondition in `OpenCodeLifecycleManager.restartForTelemetryBridge`:
- mode must be `managed`, ownership must be `control-plane`
- no ordinary restart, start, stop, or activation restart already in flight
- expected generation matches
- committed activation state matches expected hash/revision/fingerprint/port
- committed port is in `8788..8803`
- bridge reconciliation is clean
- for activate/recover, the committed port is passively re-probed and must be free (`bridge-port-race` if occupied)

Only then is the owned OpenCode backend closed and a new owned start issued with the verified `OMO_BRIDGE_PORT` + `OMO_BRIDGE_ACTIVATION_NONCE` env overlay (applied synchronously around `createOpencodeServer`, restored immediately after spawn).

---

## 5. Managed loopback port range, listener policy, and token/nonce handling

- **Managed range.** `BRIDGE_PORT_RANGE_START = 8788`, `BRIDGE_PORT_RANGE_END = 8803` (`apps/server/src/opencode-bridge/types.ts`). Port selection probes `127.0.0.1` TCP only; only `ECONNREFUSED` means free, other errors fail closed.
- **Never kill listeners.** The control plane never kills an existing listener. The bridge plugin itself uses a global `Symbol.for("omo-telemetry-bridge.v1.active")` registry with idempotent leases: duplicate plugin inits reuse the existing server (first registration wins). The restart path checks for port occupancy before closing the owned backend and refuses to proceed if occupied.
- **Bridge plugin binding.** `127.0.0.1` only, hardcoded, no CORS, no auth. Routes: `GET /health`, `GET /telemetry`; non-GET returns `405`; other paths `404`.
- **Nonce / token redaction.**
  - Activation nonce is generated as `randomBytes(32).toString("hex")` (64-char hex) and must be 16..256 chars when supplied externally.
  - The raw nonce is reduced to a SHA-256 fingerprint (`fingerprintNonce`) before any DTO, log, error, SSE payload, revision record, or UI render.
  - The raw nonce is stored only in `bridge_activation_state.raw_activation_nonce` and is accessed only through the non-barrel `withCommittedRawNonce` callback inside `launch-boundary.ts`.
  - `OMO_BRIDGE_ACTIVATION_NONCE` is set in the parent process environment only for the synchronous scope around `createOpencodeServer` and is restored to its prior value in `finally` before awaiting the promise.
  - `OMO_BRIDGE_BASE_URL` is a read-only override that opts out of management. It is validated to be exactly `http://127.0.0.1:<port>` with no userinfo, path, query, or fragment.

---

## 6. API and SSE contract names

| Contract | Name / Path |
|---|---|
| Status endpoint | `GET /api/opencode/bridge/status` |
| Preview endpoint | `POST /api/opencode/bridge/preview` |
| Apply endpoint | `POST /api/opencode/bridge/apply` |
| Restore endpoint | `POST /api/opencode/bridge/restore` |
| Restart endpoint | `POST /api/opencode/bridge/restart` |
| Probe endpoint | `POST /api/opencode/bridge/probe` (returns `501 bridge-probe-inapplicable`) |
| Control-plane SSE stream | `GET /api/events` |
| Bridge-specific SSE event | `telemetry-bridge.updated` |

The `telemetry-bridge.updated` event carries only a `TelemetryBridgeStatusSummary` (runtime, registration, compatibility, lifecycleStatus, generation, verificationEpoch, omoReady, backendConnected, override flags, restartRequired, capability/schema availability). It never carries source path/hash, diffs, nonces, or endpoint credentials.

---

## 7. System → Telemetry Bridge UI actions, eligibility, and intentionally unavailable controls

The UI renders actions only when the server DTO marks them eligible:

| Action | Eligibility (`actions.*`) | Notes |
|---|---|---|
| **Register** | `canRegister` | Requires managed + control-plane + connected lifecycle + proven source + not already registered + local package available + DB available + no override. |
| **Remove** | `canRemove` | Requires managed + control-plane + connected + proven source + exactly one registered bridge entry + no override. |
| **Restore** | `canRestore` | Requires managed + control-plane + DB available + no override. The UI additionally requires a committed desired state with `revisionId` and `sourceHash`; otherwise it shows a recovery-status message instead of a fake control. |
| **Restart** | `canRestart` | Requires managed + control-plane + `restartRequired === true` + committed disposition + DB available + no override. The UI derives `activate` / `deactivate` / `recover-activation-failure` from the actual desired vs runtime state. |
| **Probe** | `canProbe` is always `false` | The server returns `501 bridge-probe-inapplicable`. There is no probe control in the UI. |

**Intentionally unavailable / not exposed in the UI:**
- **Tuple activation with explicit options** — the foundation path uses a bare string `./packages/omo-telemetry-bridge` plus env vars (`OMO_BRIDGE_PORT`, `OMO_BRIDGE_ACTIVATION_NONCE`). The code recognizes tuple entries in the effective/source view, but the management UI does not generate or prefer tuple registrations.
- **Live config mutation** — apply only writes the plugin array; it does not mutate any other OpenCode config.
- **Live managed-runtime restart** — restart is a separate explicit user action.
- **Real bridge connection probe/activation** — the probe endpoint is a structured not-implemented response.
- **Listener kill / port reservation** — the system never kills an existing listener; it fails closed on port race.
- **Raw nonce display** — only the SHA-256 fingerprint is shown where relevant.

---

## 8. Validation evidence currently available

| Suite | Command | Result |
|---|---|---|
| Server full | `bun test --cwd apps/server` | **824 pass / 0 fail** |
| Web full | `bun test --cwd apps/web` | **163 pass / 0 fail** |
| Telemetry bridge UI focused | `bun test apps/web/test/telemetry-bridge-ui.test.tsx --preload ./apps/web/test/setup-dom.ts` | **25 pass / 0 fail** |
| Bridge package | `bun test packages/omo-telemetry-bridge/src` | **138 pass / 0 fail** |
| Server bridge foundation | `bun test apps/server/src/opencode-bridge` | **164 pass / 0 fail** |
| Server OpenCode lifecycle + bridge restart | `bun test apps/server/src/opencode` | **219 pass / 0 fail** |
| Repo typecheck (shared + server + web) | `bun run typecheck` | **all exit 0** |
| Telemetry-bridge typecheck | `bun run typecheck:telemetry-bridge` | **exit 0** |

No live activation was performed, so these results prove the *coded* behavior and the *sanitized* contracts, not end-to-end bridge plugin load against a running OpenCode process.

---

## 9. Critical limitation

> **No live bridge activation has been performed.**
>
> The implementation provides the safe-write pipeline, the revision store, the lifecycle restart integration, and the UI. However:
> - No actual `opencode.json`/`opencode.jsonc` plugin-array mutation has been committed against a live OpenCode runtime.
> - No owned OpenCode backend has been restarted through `POST /api/opencode/bridge/restart` against a live process.
> - No real bridge `GET /health` or `GET /telemetry` response has been observed from a running OpenCode process.
> - The tuple plugin spec runtime acceptance remains unproven for the installed OpenCode runtime; the management path deliberately uses the env/string foundation fallback.
>
> Do not claim live activation or live bridge telemetry. Use the status endpoint to observe the verified state.

---

## 10. Rollback guidance

To roll back a committed bridge registration:

1. Use **Restore** to revert `opencode.json`/`opencode.jsonc` to the prior revision (this writes the config and creates a new revision record, but does **not** restart the runtime).
2. Separately request **Restart** (`POST /api/opencode/bridge/restart`) with the appropriate intent derived from the new desired state.
3. The restart request must pass the generation and hash guards (`expectedGeneration`, `expectedSourceHash`, `revisionId`). If the source has drifted since restore, the restart precondition will fail and must be reconciled first.

Because the control plane owns the runtime only in **managed + control-plane** mode, rollback in Attach/external mode is limited to source restoration; the operator must restart the external OpenCode process themselves.

---

## 11. Drift closed from the pre-implementation source audit

| Original drift | Resolution |
|---|---|
| Activation doc showed schema v1 example while code emitted v2 | Bridge now emits **schema v3**; `ACTIVATION.md` documents v3. Server accepts `{1,2,3}` and treats only verified v3 as authoritative. |
| Activation doc said manual `opencode.json` edit | The control plane now provides the safe-write / revision pipeline; the doc notes the intended managed path. |
| Server was only a bridge consumer via `OMO_BRIDGE_BASE_URL` | The server is now also a bridge **manager**: `/api/opencode/bridge/*` routes, `BridgeService`, `BridgeRevisionStore`, and `TelemetryBridgeManager`. |
| Web local `OmoBridgeStores` omitted v2 record fields | The web bridge UI uses the shared `TelemetryBridgeStatusDto` and no longer depends on the old local v1-only type for management. |
| `OverviewPage` hardcoded `:8788` | The System → Telemetry Bridge section now shows actual `endpoint`/`port` from the manager/override DTO. `OverviewPage` still has the hardcoded display but is not the authoritative bridge surface. |

---

## 12. Remaining unresolved gates

These still require a controlled canonical-runtime test:

1. **Live bridge activation end-to-end** — confirm a committed registration + explicit restart results in the bridge plugin loaded, `GET /health` answering, and `GET /api/opencode/bridge/status` reporting the bridge active.
2. **Tuple runtime acceptance** — does the installed OpenCode runtime actually load `["./packages/omo-telemetry-bridge", { port, activationNonce }]`? Type declarations allow it; the management path does not depend on it.
3. **Config source precedence under live runtime** — exact precedence of `opencode.json` vs `opencode.jsonc` vs `OPENCODE_CONFIG_CONTENT` vs API updates requires a sanitized live `GET /config` observation.
4. **Plugin deduplication rule** — exact file URL vs package name behavior can only be proven by runtime experiment.
5. **Hot reload** — advisory says startup-only; installed runtime may differ.

---

## 13. Validation evidence (re-run snapshot)

Commands executed on 2026-08-14 against the repository:

| Suite | Command | Result |
|---|---|---|
| Server full | `bun test --cwd apps/server` | **824 pass / 0 fail** |
| Web full | `bun test --cwd apps/web` | **163 pass / 0 fail** |
| Telemetry bridge UI focused | `bun test apps/web/test/telemetry-bridge-ui.test.tsx --preload ./apps/web/test/setup-dom.ts` | **25 pass / 0 fail** |
| Repo typecheck | `bun run typecheck` | shared, server, web all **exit 0** |
| Telemetry bridge typecheck | `bun run typecheck:telemetry-bridge` | **exit 0** |

---

*End of Slice 17 telemetry bridge activation manifest.*
