# Telemetry Bridge Ownership — Root-Cause Report

**Status: FINAL — complete.** Root cause classified as **cross-process
activation leakage (H2)** (Oracle Gate 1 approved): a global bare plugin
registration with no managed activation identity defaulted to port 8788 and
bound in interactive OpenCode — registration equaled activation. The Phase 2
remediation (§10) was verified live in Phase 3 (§11): one owned managed
listener, exact identity, independent verifier PASS. The temporary Phase 1
diagnostics were removed after that evidence was accepted, and the removal
was itself confirmed live by a post-cleanup **normal-mode** run (diagnostic
env gates explicitly unset) with identical ownership/identity posture
(§11.7). The config-hash drift recorded in §6 was resolved separately by the
audited metadata-only rebase (§11.2) and is no longer a blocker.

Sections §1–§9 and the "pending/blocker" sentences in §6, §8, and §10.4 are
retained as the **historical** record of their respective phases; where later
phases superseded them, an inline note points to §11 rather than rewriting
history. Scope of §1–§9: reconcile the read-only evidence, classify
hypotheses against it, and define the exact evidence still missing. No code,
config, process, or port action was taken to produce them.

---

## 1. Verified facts (read-only, this timeline)

### 1.1 Control-plane lifecycle state

- `GET :8787/api/opencode/lifecycle` reports: mode `managed`, ownership
  `external`, status `failed`, generation `0`.
- The owned/managed OpenCode launch **failed before start** because the
  committed target config hash drifted from the current source hash. The
  managed runtime therefore never executed in this timeline and could not have
  attempted a bridge bind.

### 1.2 Bridge registration state

- Desired bridge: enabled, port `8788`, activation fingerprint
  `8c2372539b366160c337486f7dd35e24dc49e0353064d3712a6222e6f20f43f0`.
- Committed source hash
  `300a16126acb2eff39424ab185c790d892d636738feae4ef3a772cf209a7794e`,
  revision `brev_2d804dfe5632e72fcb449638`; bridge status
  recovery-pending/unavailable.
- Current source hash
  `14b43df251bac0dea389952f6148b44ce253fcc747658b8b49740db330555608` differs
  from committed → the drift that blocked the owned launch.
- The sanitized current source plugin array contains **exactly one** canonical
  global bridge entry plus the two existing npm plugins. No duplicate
  canonical entry exists at config level.

### 1.3 Live global config (read this phase)

- `<opencode-config-dir>/opencode.json` `plugin` array:
  ```json
  [
    "@ex-machina/opencode-anthropic-auth@1.8.1",
    "oh-my-opencode-slim",
    "<owl-install-root>/packages/omo-telemetry-bridge"
  ]
  ```
  The bridge entry is a **bare string**: no tuple, no `port`, no
  `activationNonce`. One canonical absolute-path entry — consistent with the
  sanitized source view.

### 1.4 OS listener state

- Exactly one listener on `127.0.0.1:8788`, owned by OpenCode **PID 5107**,
  parented to interactive shell PID 891, cwd `<owl-install-root>`.
- PID 5107 is **not** a child of control-plane PID 15000 / supervisor 14999.
- `GET /health` → schema v3, bound, pluginInstanceId
  `2be6f6e0-2c2c-4855-9dfd-d4ec82a01581`.
- `GET /telemetry` identity matches health; `canonicalOrigin`
  `http://localhost:4096`; `bridgePackageVersion` `0.2.0`; **no
  `nonceFingerprint` field**.

### 1.5 Diagnostics state

- The temporary env-gated diagnostics (Phase 1) were added to the package
  **after** PID 5107 loaded the plugin. PID 5107 runs pre-instrumentation
  code. No diagnostic JSONL run has occurred; the event/lock files have never
  been armed by the controller.

---

## 2. Source-verified behavior (local paths/lines)

### 2.1 Bare global registration resolves to legacy default 8788 and binds

`packages/omo-telemetry-bridge/src/options.ts`:

- `LEGACY_DEFAULT_PORT = 8788` (line 31).
- Port precedence: explicit option → env `OMO_BRIDGE_PORT` → legacy default.
  With neither present, lines 292–295 assign `port = LEGACY_DEFAULT_PORT`
  with `portSource = "legacy-default"`. Absent port is **not** an error.
- Nonce: absent nonce is **not** an error either; `rawNonce` stays
  `undefined` (lines 304–322), no fingerprint is computed (lines 326–329),
  and `resolveBridgeOptions` returns `ok: true` (lines 331–340).

**Conclusion (proven from source):** a plugin loaded from the bare global
string entry — no options, and (for an interactive TUI launch) no
`OMO_BRIDGE_PORT`/`OMO_BRIDGE_ACTIVATION_NONCE` in its environment — resolves
to `127.0.0.1:8788` with no nonce and proceeds to acquisition. The bridge is
**fail-open for unmanaged registration**: it enables and binds by default.

### 2.2 Missing nonce is accepted; acquisition proceeds

`packages/omo-telemetry-bridge/src/index.ts`:

- Line 141: `resolveBridgeOptions(options)`; line 142: only a **validation
  error** short-circuits. A bare registration is valid, so execution
  continues.
- Lines 155–159: `captureBridgeIdentity` runs with
  `nonceFingerprint: undefined`; `stores.ts` omits the field from identity
  when undefined — exactly matching the observed `/telemetry` identity (no
  `nonceFingerprint`).
- Line 188: `acquireBridge(...)` runs unconditionally after identity capture;
  on success it binds and publishes; on `EADDRINUSE` it logs and resolves
  without a server (fail-open, by design, unchanged this phase).

**Conclusion (proven from source + corroborated by live identity):** the
PID 5107 listener is precisely what a bare global registration produces —
schema v3, port 8788, package 0.2.0, no nonce fingerprint. It is an
**unmanaged/legacy** instance, not a verified managed activation for the
committed fingerprint `8c23…f43f0`.

### 2.3 OpenCode plugin loader semantics — limitation declared

The OpenCode **host loader source is not present under the allowed roots**
(`<owl-install-root>`, `<opencode-config-dir>`). What exists
locally:

- `<opencode-config-dir>/node_modules/@opencode-ai/plugin/dist/index.d.ts`
  — the plugin API type contract only:
  - lines 48–50: `Config.plugin?: Array<string | [string, PluginOptions]>` —
    one global `plugin` array, bare-string or tuple entries; no per-mode
    (TUI vs serve) scoping exists in the config type.
  - lines 52–56: `PluginModule = { id?: string; server: Plugin; tui?: never }`
    — the type system acknowledges server/TUI module discrimination, implying
    both process kinds consume plugin modules from the same list.
- `<opencode-config-dir>/node_modules/@opencode-ai/sdk/dist/server.{js,d.ts}`
  — the SDK server **helper** (used to spawn/connect), not the host's plugin
  scan/load implementation.

**Classification of the claim "a plugin in global `opencode.json` applies to
both interactive TUI and managed `opencode serve` processes":**
**behavior/config-evidenced, not loader-source-proven.** Support: (a) the live
fact that an interactive TUI process (PID 5107) is serving the bridge loaded
from exactly that global array; (b) the config type has a single global
`plugin` array with no mode scoping; (c) the `PluginModule.server`/`tui`
distinction presupposes both runtimes load plugin modules. The exact loader
scan order, dedup behavior, and per-process instantiation topology remain
unproven and are not asserted.

---

## 3. Timeline limits (what this evidence cannot show)

- PID 5107 loaded the bridge **before** diagnostics existed. There is no
  event timeline for its initialization, and none can be reconstructed.
- The managed/owned launch never started (hash drift). There is therefore no
  bind attempt, no `EADDRINUSE`, and no second initialization **in this
  timeline at all**.
- No diagnostic JSONL run has occurred. Every statement about initialization
  *dynamics* (repeated calls, races, realms, release ordering) is necessarily
  about the code's structure, not observed behavior.

---

## 4. Hypothesis classification table

| # | Hypothesis | Classification | Basis |
|---|------------|----------------|-------|
| H1 | Duplicate config-source registration (two canonical entries) | **Refuted for this timeline** | Live `opencode.json` and sanitized source each show exactly one canonical bridge entry. |
| H2 | Cross-process contention: unmanaged interactive instance holds 8788 via fail-open legacy default, so any managed/owned launch binding 8788 hits `EADDRINUSE` | **Best-supported; not yet live-proven** | Source proves bare global entry → 8788 + no nonce + bind (§2.1–2.2); OS shows exactly one listener owned by interactive PID 5107 serving exactly that shape (no `nonceFingerprint`); managed launch never ran. Matches the originally reported duplicate-bind symptom structure. Missing: a diagnostic-armed timeline of an actual failed managed bind. |
| H3 | Repeated same-PID initialization (plugin init invoked twice in one process) | **Unproven — no timeline evidence** | Structurally survivable in-realm (Symbol.for registry reuse), so even if it occurred it would not produce `EADDRINUSE` within one realm. No event data exists to show it. |
| H4 | Multiple realms/isolates in one process (registry not shared) | **Unproven — no timeline evidence** | `Symbol.for` registry is realm-global, not proven process-global (accepted package fact). Could produce two binds in one PID only if realms exist; no realm tokens observed (none could be). Diagnostics are armed to detect this. |
| H5 | Async/publication race (`serve` before publish) | **Unproven — no timeline evidence** | Race requires two concurrent acquisitions in one realm; no concurrency evidence exists. |
| H6 | Ownership-key / compatibility bug (equal configs misjudged) | **Unproven; no supporting evidence** | Config equality is fingerprint/port/host/transport only; the observed listener's shape matches the bare registration exactly. |
| H7 | Premature release then rebind | **Unproven — no timeline evidence** | No dispose/release activity observable; refcount introspection shows nothing anomalous in tests. |
| H8 | Config-hash drift as the EADDRINUSE cause | **Refuted as cause of port conflict** | Drift blocked the managed launch **before** process start (generation 0). It is a boot blocker, not a bind actor. See §6. |

The user's initial same-process hypothesis (H3/H4/H5 family) is **not**
supported by current evidence and is not adopted here. H2 is the only
hypothesis with convergent source + OS + identity evidence, but it still
lacks the decisive observation: a diagnostic-armed managed launch failing
with `serve-failure(EADDRINUSE)` while PID 5107 (or equivalent unmanaged
holder) occupies the port.

---

## 5. Proposed minimal primary-fix candidates (for post-Gate-1 decision only)

These are candidates, not implementations. Selection requires Oracle Gate 1
acceptance of H2 (or live evidence selecting another mechanism).

- **F1 — Fail closed unless managed activation identity is explicitly present
  (leading candidate).** The plugin binds only when an explicit managed
  activation is supplied (valid `activationNonce` via tuple options or
  `OMO_BRIDGE_ACTIVATION_NONCE`, i.e. `portSource !== "legacy-default"` and a
  nonce fingerprint exists). A bare global registration resolves normally
  **without binding** — unmanaged/interactive processes never claim 8788.
  Directly removes the H2 mechanism at its source; preserves "never kill/
  adopt, never port-fallback"; keeps invalid-options fail-closed semantics;
  the legacy default remains reachable only for deliberate manual use with a
  nonce. Blast radius: manual/unmanaged users must now supply a nonce —
  acceptable per the managed-first design in ACTIVATION.md.
- **F2 — Registration-scoping correction.** Remove the bridge from the global
  `opencode.json` plugin array; register it only in the owned/managed launch
  configuration. Effective against H2 but conflicts with the documented
  canonical global registration model (ACTIVATION.md §"Registration (managed
  path)") and pushes lifecycle complexity into config management; also does
  nothing if any other global registration reappears. Weaker invariant than
  F1.
- **F3 — Process-kind discrimination at the plugin boundary** (e.g. refuse to
  bind in TUI-kind loading). The `PluginModule.server`/`tui` type distinction
  (plugin `dist/index.d.ts:52-56`) hints this may be expressible, but loader
  semantics are unproven under allowed roots (§2.3); this would be
  probe-gated and is inferior to F1's explicit-identity invariant.

Mandatory later hardening (per user decision after critic gate 3 —
defense-in-depth, **not** the primary fix, and must not be misreported as
such): deterministic `Starting`/waiter ownership with acquisition-specific
owner epochs, stale-lease fencing, fenced `Failed(stop)` (never clears
ownership, never rebinds), compatible-waiter settlement, and permanent
`TB-OWN-*` coverage for re-entrant/concurrent acquisition, multiple plugin
instance IDs, isolated realms, stop failure, and clean restart. This remains
required because the in-realm registry cannot defend cross-realm/cross-process
cases and the current release path decrements the registry's current record
rather than an acquisition-specific epoch.

---

## 6. Separation: config-hash drift (boot blocker) vs EADDRINUSE (port conflict)

> **Historical (Phase 1–2 wording).** The drift described here was later
> resolved by the audited metadata-only rebase (§11.2); the port conflict was
> eliminated by the Phase 2 primary fix and proven in Phase 3 (§11.3). The
> analysis below is retained unchanged because the *separation* argument
> remains correct and was load-bearing for the gate sequence.

These are independent defects and must not be conflated:

1. **Drift / recovery-pending** — committed source hash `300a…794e` ≠ current
   `14b4…5608`, revision `brev_2d804dfe5632e72fcb449638`. Effect: the managed
   lifecycle refuses to launch (status `failed`, generation 0). It prevented
   the reproduction experiment; it did not touch port 8788. Remediation is a
   control-plane revision/recommit matter, separate from bridge ownership.
2. **Port conflict (H2)** — an unmanaged interactive instance holds
   `127.0.0.1:8788` via the fail-open legacy default. Any future managed
   launch resolving 8788 collides and fails open. This defect survives a
   drift fix: recommitting the config and launching owned would reproduce the
   `EADDRINUSE` while PID 5107 (or any interactive OpenCode with the global
   registration) is alive.

---

## 7. Unsafe alternatives rejected (standing constraints reaffirmed)

- Killing or adopting the unknown/legacy listener (PID 5107).
- Retrying on alternate ports, sleeping around the race, or probing-then-
  adopting.
- Hiding, downgrading, or reclassifying `EADDRINUSE` (it remains duplicate-
  initialization evidence).
- Weakening schema/runtime identity checks or logging raw nonce/config/env.
- Editing OpenCode/OMO config or installed dependencies as part of diagnosis.
- Treating the in-realm `Symbol.for` registry as a process-global ownership
  coordinator.

---

## 8. Evidence requirements after Oracle Gate 1 (supersedes the pre-approval plan)

**Oracle Gate 1 APPROVED H2 as the root cause. No intentional collision
reproduction run is required — and none is permitted.** The Phase 1
diagnostic-armed reproduction sketched in earlier drafts of this section is
superseded: deliberately staging a duplicate bind against a live holder is
not an approved validation action. Historical uncertainty about same-process
mechanisms (H3–H7) is retained only as a qualification: those hypotheses had
no timeline evidence and were not selected; the Starting/Stopping/waiter/
epoch hardening is defense-in-depth against exactly those classes.

Remaining live evidence (Phase 3, orchestrator-owned process control,
diagnostics-armed via the approved env-gated JSONL channel). **All items
below were satisfied in Phase 3 — see §11 for the accepted evidence; the
list is retained as the approved requirement set.**

1. **Drift disposition** (separate live blocker, §6): reconcile or recommit
   the config so a managed launch is possible; record the new committed hash.
2. **Positive single-listener proof** after the Phase 2 fix:
   - an interactive/unmanaged OpenCode process with the bare global
     registration produces NO bridge listener (typed inactive;
     `plugin-init-inactive` diagnostic, zero `serve-enter` events);
   - one owned managed launch shows exactly one
     `serve-success` / `registry-publish-confirmed(state=active)` /
     `lease-outcome(state=acquired)` sequence, and the OS shows exactly one
     `127.0.0.1:8788` listener owned by the control-plane child PID;
   - `/health` + `/telemetry` report schema v3 with `nonceFingerprint` ==
     `8c2372539b366160c337486f7dd35e24dc49e0353064d3712a6222e6f20f43f0`;
   - a clean owned restart reproduces exactly one listener on 8788 (new
     epoch, same fingerprint), no alternate port;
   - temporary diagnostics are removed after accepted evidence.
3. Note on failure surfacing: a managed activation that cannot bind now
   **rejects plugin initialization** with a typed redacted
   `BridgeActivationError`. The OpenCode host may catch a rejected plugin
   initializer; this report claims rejection of plugin initialization, NOT
   process termination.

---

## 9. Bottom line (Oracle Gate 1 outcome)

- Proven from source + live read-only state: the bridge was fail-open for
  unmanaged registration (legacy default 8788, no nonce, binds), and the
  observed listener was exactly such an unmanaged instance owned by an
  interactive OpenCode process outside control-plane ownership.
- **Oracle Gate 1 accepted the root cause as cross-process activation
  leakage (H2):** a global bare plugin with no managed activation identity
  defaulted to 8788 and bound in interactive OpenCode. Registration must no
  longer equal activation.
- Same-process repeated initialization, realm, race, key, and release
  hypotheses had no timeline evidence and were NOT selected as the primary
  mechanism; the ownership state machine below is therefore explicitly
  **defense-in-depth**, not the primary fix.

## 10. Phase 2 remediation (implemented; pre-live-verification)

### 10.1 Primary fix (targets the accepted root cause)

**Registration is no longer activation** (`options.ts`, `index.ts`):

- Bare/no-env registration → typed **inactive** (`activation-absent`):
  supported no-op hooks, one stable secret-free structured log, ZERO
  acquire/factory/bind calls. The legacy default port 8788 bind path is
  removed.
- Partial (port-only/nonce-only), mixed-channel (tuple port + env nonce or
  vice versa), or malformed activation → typed **invalid**
  (`activation-incomplete` / `fingerprint-unavailable` with stable detail
  codes), zero bind. Channels are never silently combined.
- Complete explicit managed activation requires an explicit managed-range
  port + valid nonce fingerprint + parseable canonical origin (missing/
  invalid origin never binds). Exactly one deliberate channel activates;
  when both are complete the tuple channel wins (preserved precedence).
- A valid managed activation that cannot bind (EADDRINUSE or any serve
  failure) now **rejects plugin init with a typed, redacted
  `BridgeActivationError`** (stable code + normalized classification only).
  The unbound-success continuation was removed. No fallback, retry, sleep,
  probe, or adoption.
- Canonical managed path unchanged: bare string registration + launch-scoped
  env overlay via the control-plane launch boundary.

### 10.2 Mandatory defense-in-depth hardening (not the primary fix)

Ownership state machine (`lifecycle.ts`, registry key
`omo-telemetry-bridge.v2.active`):
`Absent → Starting → Active | Failed(start)`; `Active → Absent | Failed(stop)`.

- Starting published BEFORE serve; starting-publication failure → zero serve.
- Compatible concurrent/reentrant acquisitions join one starting epoch; all
  waiters settle (TB-OWN-03, deterministic stall gate, no sleeps).
- Exact reuse key: canonical origin, host 127.0.0.1, exact port,
  loopback-http, schema 3, exact nonce fingerprint. Incompatible/missing key
  → typed reject, zero side effects (TB-OWN-05). First-registration-wins
  reuse of mismatched identity removed.
- Leases fenced to exact owner epoch; stale/repeated/out-of-order dispose
  cannot affect another epoch (TB-OWN-07).
- Stop failure retains a fenced failed-stop record; all acquisitions/rebinds
  rejected (TB-OWN-07, TB-OWN-09).
- Active-transition publication failure → owned handle stopped exactly once,
  typed failure; if that stop fails, fenced — never an untracked live server.
- Realm-local registry proven via Worker realm test (TB-OWN-AUX-02);
  cross-realm/process duplicate binds surface as typed EADDRINUSE losers
  (TB-OWN-AUX-03, cooperative foreign test port 18788); cross-realm reuse is
  never claimed.

### 10.3 Supporting server safety

- Launch boundary (`launch-boundary.ts`): an active committed record MUST
  carry exact configHash (mandatory on-disk parity), explicit managed-range
  port, valid 64-lowercase-hex fingerprint, matching protected raw nonce,
  non-empty canonical identity, and `loopback-http` transport.
  Optional/missing fields can no longer skip validation.
- Activation-failure guidance no longer says "free the selected port"; it now
  directs ownership/duplicate-activation resolution. Ordinary non-bridge
  collision behavior unchanged.
- `isReconciliationClean` in the composition root now aligns with the cached
  `bridgeReconcileDisposition` via the tested pure helper
  `computeBridgeReconciliationClean`: recovery-pending blocks repeated SDK
  starts, conflict/drift block via unresolved/conflict intents, store errors
  fail closed.

### 10.4 Validation status (Gate 2 attempt 1)

- Focused TB-OWN/TB-DIAG/entry/registry-failure suites, full bridge package
  suite (181 tests), bridge `tsc --noEmit`, launch-boundary / lifecycle /
  reconciliation / sdk-adapter tests, full server suite (847 tests), and root
  `bun run typecheck`: all green (exact counts in the Phase 2 Gate 2
  remediation report).
- Gate 2 additions: explicit `stopping` record before stop with typed
  acquire rejection; compare-and-transition + readback on every registry
  transition; fail-closed registry reads; blocking `failed-start` /
  `cleanup-failed` records; in-place fence fallback; guarded refcount
  transitions; activation↔identity fingerprint equality and managed-port/
  host/schema/transport/origin revalidation before any serve; raw-nonce
  confinement (void callbacks, discarded returns, redactor closure, launch
  boundary length bound, sanitized async SDK rejection); explicit-empty env
  invalid (nonce never trimmed); external-edit drift gate dirtying the
  owned-start gate immediately; plugin-entry seam tests.
- Secret-sentinel scans: no raw nonce in outcomes, logs, diagnostics, or
  typed errors.
- Temporary diagnostics (env-gated JSONL writer + TB-DIAG tests) are
  RETAINED until Phase 3 live verification completes, per plan. *(Phase 3
  note: evidence was accepted and the diagnostics have since been removed —
  see §11.6.)*
- **Config-hash drift remains a separate live blocker** for the managed
  launch (§6): it is a control-plane revision/recommit matter and is not
  addressed by this remediation. Phase 3 live verification (one owned managed
  launch; exactly one 127.0.0.1:8788 listener owned by the CP child; v3
  identity with the committed fingerprint; clean owned restart) is still
  required before this remediation is called proven in production.
  *(Historical: both statements were true when written. The drift was
  resolved by the audited rebase and live verification PASSED — §11.)*

### 10.5 Gate 2 attempt-2 remediation (final)

1. **Async stop contract**: `BridgeServerHandle.stop` is `Promise<void>`
   (Bun's real contract; the capability-hiding cast in the index factory was
   removed). Lease disposal is async; the final release transitions the exact
   epoch to `stopping` and AWAITS stop while the epoch remains `stopping`;
   resolution clears only the exact stopping epoch (CAS+readback), rejection
   fences `failed-stop`. Promise-gated stop tests prove sync/async acquire
   rejection while stopping and exact-epoch clearing.
2. **Discriminated CAS outcomes**: every transition returns
   `verified | not-written | unknown | replaced`. Write-applied/readback-
   unknown poisons the exact next record in place BEFORE cleanup and fences
   the realm; a possibly-published record can never become a reusable
   `active`. Deterministic readback-fault injection tests cover active
   publication and stop/clear.
3. **Realm-wide poison/orphan fence** (`omo-telemetry-bridge.v2.poison`):
   separate from the primary slot; retains failed-to-stop orphan handle
   metadata (epoch, port, key digest, reason); blocks ALL acquisitions
   without clobbering a replacement; observation/fencing only, never
   adoption. Tested: replacement + rejected async cleanup stop + reentrant
   acquire → zero new bind/reuse, orphan fenced, replacement intact.
4. **Failed-release accounting**: leases are marked disposed only on
   consumed/final/fenced outcomes; registry read failure or an unproven
   Active→Stopping transition is retryable — the same lease can be retried.
   Tests prove exact refcount, one final stop, no phantom ref.
5. **Whitespace nonce**: empty-or-whitespace-only nonce is invalid
   (`nonce-empty`); a nonce with content is hashed byte-exact (never
   trimmed). Isolated valid-port + 16+-spaces nonce test proves invalid.
6. **Redaction order**: the launch-secret redactor applies to the ORIGINAL
   error text BEFORE `sanitizeOpenCodeError` normalization/truncation
   (240-char cap); a boundary-spanning 64-char nonce test proves no full or
   partial nonce substring survives; parent env secret redaction kept.
7. **Config removal drift**: watcher `removed` events are treated exactly as
   external drift (gate dirtied before refresh). A real-watcher wiring test
   (fs.watch, zero debounce, event-driven — no sleeps) proves a subsequent
   lifecycle start fails `bridge-reconciliation-dirty` with zero startSdk
   calls.

Validation (attempt 2): bridge 188/188 (lifecycle 42, entry/options/diag 59),
bridge tsc clean, server bridge/opencode 245/245, full server 850/850, root
typecheck clean, prohibited-pattern/secret scans clean, bun.lock untouched.
Checksum manifest updated to v4.

### 10.6 Gate 2 attempt-3 remediation (final, exceptional bounded correction)

1. **Single-flight dispose**: lease state `open | releasing | settled`;
   `releasing` is set synchronously before `releaseLease` runs; concurrent/
   unawaited dispose calls share the in-flight promise and can never
   double-decrement. Retryable failures return to `open` only after the
   promise settles. Test: two same-tick unawaited disposes on one lease at
   refcount 2 → refcount 1, no stop; the other lease final-disposes once.
2. **Production-visible retryable release**: retryable release REJECTS with
   a typed, redacted `BridgeActivationError`
   (`activation-registry-failed` + detail), propagated through the plugin's
   awaited `dispose` hook; the lease stays open; a later explicit retry
   accounts exactly once (one final stop, registry cleared). Proven at the
   plugin-entry level with injected release-read failure.
3. **Active→Stopping post-write readback failure**: pre-write failure stays
   retryable; write-applied/readback-unknown immediately fences BOTH
   candidate records in place (never reusable active, never stranded
   stopping), publishes + readback-verifies a cleanup-pending realm poison
   retaining the owned handle privately BEFORE awaiting one exact stop, and
   resolves terminal. Unverifiable poison → typed failure; the in-place
   fence is retained and cleanup safety is never claimed.
4. **Orphan fence completeness**: the cleanup-pending poison (with the
   failed handle retained privately) is published and readback-verified
   before any replacement-cleanup stop; acquisitions reject while cleanup is
   pending; a rejected stop leaves the poison+handle fenced; a replacement
   slot is never clobbered; poison publication failure is observable via the
   typed error. Tested with a delayed rejecting stop gate including
   stop-time reentrancy.

Validation (attempt 3): bridge 195/195 (lifecycle 46), bridge tsc clean,
full server 850/850 (untouched this round), root typecheck clean, scans
clean, bun.lock untouched. Checksum manifest updated to v5.

*(Subsequent pre-Phase-3 hardening — Gate 2 attempt-3 follow-ups, resolver
recovery of the three remaining fail-open edges, and the audited
drift-acceptance engine — is recorded in the deepwork ledger
`.slim/deepwork/telemetry-bridge-ownership.md`; final pre-live validation
was bridge 199/199, full server 973/973, root typecheck clean.)*

---

## 11. Phase 3 — controlled live verification and final disposition (accepted)

### 11.1 Gate sequence recap

1. **Oracle Gate 1** accepted H2 (cross-process activation leakage) as the
   root cause (§9).
2. **Drift metadata rebase (separate track).** The config-hash drift blocker
   (§6) was resolved by the Oracle-approved, audited, metadata-only trust
   rebase: committed hash
   `08e2ab2b1bdc2617348593d78596832793f5991660e6d0d82b858bdb86f301f7`,
   rebase revision `brev_8494aca5658f6c2d4dcd91cb` (parent/anchor
   `brev_2d804dfe5632e72fcb449638`). Config bytes/inode/mode/mtime unchanged
   by apply; `configWritten=false`, `runtimeAction=none`, `restorable=false`,
   `restartRequired=true`.
3. **Primary fix + mandatory hardening** (§10) shipped with permanent
   TB-OWN-01..10 + AUX-01..03 coverage.
4. **Clean owned diagnostic-armed launches** produced the accepted live
   evidence below (§11.3–§11.4), after which the temporary diagnostics were
   removed (§11.6).

### 11.2 Integration defect found during Phase 3 (fixed before acceptance)

The first diagnostic-armed managed launch proved the plugin-side ownership
behavior was correct (single bind, exact identity), but
`/api/opencode/bridge/status` still reported `registration: not-registered`.

- **Root cause:** `RuntimeStore` omitted `authorizedRoots` when constructing
  `OpenCodeClient`. With empty roots, the effective canonical `file://` URL
  of the bridge was treated as outside the authorized roots, so registration
  was judged not-registered. (The earlier lexical path↔file-URL parity fix —
  `arePluginEntriesEquivalent` — had repaired *source-side* proof only; the
  *effective-view* comparison still failed until the roots plumbing was
  corrected.)
- **Correction:** `cfg.authorizedRoots` is now passed through `RuntimeStore`
  to `OpenCodeClient`; the client retains a safe `projectDirectory`
  fallback. The status regression test now feeds raw config through the real
  `extractEffectivePluginView` rather than pre-populating the bridge view.
- Re-verified before acceptance: opencode-bridge 297/297, full server
  973/973, bridge package 199/199, root + bridge typechecks clean.

### 11.3 Accepted live evidence (diagnostic run `ownlive-fbc2fb7b7e47cadd989bd646`)

- **Process/listener ownership:** control-plane PID 48394 owns
  `127.0.0.1:8787`; its child OpenCode PID 48397 owns `127.0.0.1:4096` and
  the exact bridge listener `127.0.0.1:8788`. No listeners on 8789..8803.
- **Diagnostic JSONL (PID 48397, lines 27..39):** exactly one module-eval,
  one plugin-init-enter/identity, one acquire, one starting publish,
  serve-enter + serve-success, one active publish, one acquired lease with
  refcount 1. No failure event and no EADDRINUSE anywhere in the run. Event
  and lock files mode 0600; secret scan clean.
- **`/api/opencode/bridge/status`:** source proven; registration
  `registered`; desired managed+enabled; runtime active; compatibility
  compatible; lifecycle active; ownership control-plane; duplicates false;
  restartRequired false; effective `file://` URL carries bridge metadata.
- **`/health` + `/telemetry`:** schema 3, package 0.2.0, instance
  `c92bbd8a-de84-4a29-8651-eccd546258ac`, origin `http://127.0.0.1:4096`,
  nonce fingerprint
  `8c2372539b366160c337486f7dd35e24dc49e0353064d3712a6222e6f20f43f0`
  (exactly the committed activation fingerprint).
- **Config state:** committed hash remains
  `08e2ab2b1bdc2617348593d78596832793f5991660e6d0d82b858bdb86f301f7`;
  rebase revision `brev_8494aca5658f6c2d4dcd91cb`.
- **System UI:** Registered + Active + Managed + Control Plane visible;
  Doctor reported no bridge lifecycle warning; browser console clean.

### 11.4 What the evidence proves

- Exactly one OS listener on the exact managed port 8788, owned by the
  control-plane child — positive single-listener proof, not merely absence
  of an error.
- Exactly one initialization sequence in the owning process: one module
  evaluation, one plugin init, one acquisition, one bind — the H3/H4/H5/H7
  same-process hypotheses produced zero events.
- Served identity is the committed managed identity (schema 3, exact nonce
  fingerprint, canonical origin) — activation↔served correlation holds live.
- No unmanaged/interactive listener exists: the interactive OpenCode with
  the bare global registration now resolves typed-inactive and binds
  nothing (the H2 mechanism is closed at its source).

### 11.5 Independent verification

Independent verifier: **PASS** — focused 107, opencode-bridge 297, full
server 973, bridge package 199, root and bridge typechecks clean, and
explicit clearance to remove the temporary diagnostics.

### 11.6 Diagnostic removal (post-acceptance cleanup)

With the evidence above accepted, the temporary Phase 1 instrumentation was
removed:

- Deleted `packages/omo-telemetry-bridge/src/diagnostics.ts` and
  `diagnostics.test.ts` (20 TB-DIAG tests).
- Removed all production diagnostic imports and event calls from `index.ts`
  and `lifecycle.ts`. The permanent failure classification surfaced on typed
  errors (`BridgeActivationError.detail`, fence/poison records) is retained
  as the permanent `BridgeFailureClassification` type with an in-module
  serve-failure classifier; owner epochs now use an in-module `newEpochId`;
  reuse-key digests are computed in-module. No behavioral change.
- AUX-02 (realm isolation) no longer depends on the diagnostic realm-token
  helper: it now uses a permanent deterministic `Symbol.for` marker fixture
  asserting same PID, marker invisibility both directions, and registry slot
  invisibility in the Worker realm.
- Post-cleanup validation: bridge package 179/179 (199 − 20 TB-DIAG),
  focused lifecycle 50/50, bridge `tsc --noEmit` clean, full server 973/973,
  root typecheck clean; static scans show zero production references to the
  temporary module, its env gates, or TB-DIAG identifiers.
- The live event JSONL/lock artifacts under `.slim/deepwork/` are retained
  until the orchestrator stops the running processes; they are evidence
  artifacts, not code. *(Post-cleanup note: those artifacts have since been
  removed by the orchestrator; only the durable ledger and checksum manifest
  remain — see §11.7.)*

### 11.7 Post-cleanup normal-mode live verification (final)

This section records a **separate, later run** from the diagnostic-armed run
`ownlive-fbc2fb7b7e47cadd989bd646` (§11.3). The historical run remains the
diagnostic-phase record; this run closes the remaining gap by proving the
accepted remediation in **normal mode after the diagnostics were deleted** —
launched with `OMO_BRIDGE_OWNERSHIP_EVENTS` and
`OMO_BRIDGE_OWNERSHIP_EVENT_RUN_ID` explicitly unset, with the diagnostic
source, tests, and artifacts already absent.

- **Process/listener ownership:** control-plane PID **51308** owns
  `127.0.0.1:8787`; its owned OpenCode child PID **51311** owns
  `127.0.0.1:4096` and the exact bridge listener `127.0.0.1:8788`. Zero
  listeners on 8789..8803 — positive single-listener proof without any
  diagnostic channel.
- **`/api/opencode/bridge/status`:** source proven; registration
  `registered`; desired managed+enabled; effective canonical `file://` URL
  carries bridge metadata; runtime active; compatibility compatible;
  lifecycle active; ownership control-plane; duplicates false;
  restartRequired false.
- **`/health` + `/telemetry`:** schema 3, package 0.2.0, bridge instance
  `7b860d0e-9318-4396-9573-43f2d838194a`, origin `http://127.0.0.1:4096`,
  nonce fingerprint
  `8c2372539b366160c337486f7dd35e24dc49e0353064d3712a6222e6f20f43f0`
  (exactly the committed activation fingerprint — activation↔served
  correlation holds in normal mode).
- **Config state:** committed hash unchanged at
  `08e2ab2b1bdc2617348593d78596832793f5991660e6d0d82b858bdb86f301f7`
  (mode 0600); rebase revision `brev_8494aca5658f6c2d4dcd91cb`. No
  config/DB write occurred.
- **Doctor:** 0 errors; **no bridge lifecycle warning** — only unrelated
  multiplexer/council warnings (out of scope).
- **Cleanup state:** diagnostic source/tests/artifacts absent
  (`src/diagnostics.ts`, `diagnostics.test.ts`, and the live JSONL/lock
  artifacts are gone); the durable ledger and checksum manifest remain.
- **Independent post-cleanup verifier: PASS** — focused lifecycle 50/50,
  bridge package 179/179, opencode-bridge 297/297, full server 973/973,
  bridge `tsc --noEmit` and root typecheck clean. The permanent AUX-02
  same-PID realm-isolation fixture (deterministic `Symbol.for` marker,
  bidirectional marker invisibility, cross-realm registry-slot invisibility)
  is equivalent-or-stronger than the removed diagnostic-helper version; the
  isolation guarantee is retained, not weakened.
- **What this adds over §11.3:** the single-listener, exact-identity,
  control-plane-owned posture is now proven with the temporary
  instrumentation fully removed and its env gates unset — i.e., the shipped
  production code path in normal mode, not a diagnostic-armed build. Ready
  for Oracle Gate 3.

### 11.8 Oracle Gate 3 Review — Gaps and Recovery

1. **Checksum Provenance Updates:** Superseding final hashes recorded in manifest v14 for all roots-plumbing files (`apps/server/src/opencode/client.ts`, `apps/server/src/runtime/store.ts`, `apps/server/src/index.ts`, `apps/server/src/runtime/store.test.ts`, `apps/server/src/opencode-bridge/status.test.ts`).
2. **Permanent RuntimeStore Roots Regression Test:** Added permanent test in `apps/server/src/runtime/store.test.ts` verifying that `RuntimeStore` instantiates `OpenCodeClient` with `authorizedRoots`, which extracts canonical `file://` bridge metadata from raw `/config` responses, and fails closed when roots do not authorize the path.
3. **Restart disposition:** Independent verification proved no restart was
   required: all roots-plumbing production source bytes predated the running
   normal-mode generation, only tests/docs/provenance changed, and the live
   effective canonical `file://` entry already carried bridge metadata.
4. **Correction validation:** RuntimeStore 2/2, opencode-bridge 297/297, full
   server 974/974, bridge package 179/179, and root/bridge typechecks passed.
   Manifest integration hashes matched byte-for-byte with strict JSON and no
   duplicate keys.

### 11.9 Oracle Gate 3 final disposition

**APPROVED — Phase 3 closed.** The final source, permanent regression suite,
accepted diagnostic evidence, and post-cleanup normal-mode run prove one
control-plane-owned listener on fixed port 8788 and resolve the accepted
cross-process activation-leakage mechanism without prohibited workarounds.

The only intentional residual is cross-realm/process behavior: independently
activated runtimes cannot share the realm-local registry and lose fail-closed
with typed `EADDRINUSE`. No fallback, adoption, retry, or invariant weakening
is introduced.
