# Metadata-Only Drift Acceptance (Audited Trust Rebase)

Oracle-approved workflow for the case where the committed bridge target
config changed externally and the historical raw content is **unavailable**
(hard fact). This is a trust rebase of committed metadata — **not** content
equivalence, **not** a config write, **not** a rollback, and **not** a claim
that opaque changes are benign.

## What it does

Two-phase, local-only, API/CLI-only:

1. `POST /api/opencode/bridge/accept-drift/preview` — body
   `{expectedRevisionId, expectedCommittedHash, expectedObservedHash}`.
   Computes a sanitized proof (below). Zero DB writes, zero config writes,
   zero effective-view calls. Returns a one-shot preview ID (128-bit crypto
   random, 5-minute TTL, max 64) plus the fixed acknowledgement text and the
   fixed confirmation token `accept-opaque-config-drift-v1`.
2. `POST /api/opencode/bridge/accept-drift/apply` — body adds `previewId`
   and `confirmation`. The preview is consumed BEFORE any comparison (every
   valid ID is one-shot). The service re-reads state/file, re-runs the full
   proof, compares the proof digest, verifies raw-nonce parity inside the
   void scoped callback, then commits ONE `BEGIN IMMEDIATE` transaction:
   committed rebase intent + rebase revision + CAS update of ONLY
   `config_hash`/`revision_id`/`updated_at` bound by every committed field
   (exactly one row required). An immediate secure reread/state
   re-verification follows; post-commit drift returns
   `metadataCommitted: true` + `post-acceptance-drift` + `recovery-pending`
   and never pretends rollback.

Success response: `configWritten: false`, `runtimeAction: "none"`,
`restorable: false`, `restartRequired: true`.

## Eligibility/proof (fail closed)

- DB/service available; no prepared/recovery-pending/conflict intent;
  override inactive.
- Committed activation active+complete (env registration, loopback-http,
  managed port, 64-hex fingerprint, target/source kind/config hash/revision/
  canonical identity present).
- Exact expected old committed hash/revision/observed hash; observed differs.
- Committed target: inside authorized roots, regular non-symlink, stable
  (inode/mode/size/hash compared across the proof read), ≤256 KiB, valid
  UTF-8, root object, no duplicate top-level keys, supported plugin array.
- Exactly one canonical bridge entry: bare string, exact lexical committed
  identity, canonical realpath match, no tuple/options; no canonical or
  bridge-like duplicate in any other authorized candidate. The proof never
  calls `resolveAuthorizedCandidate` or the effective-view provider.
- Anchor: the original/latest content-writing ADD revision with a valid
  restorable `BridgeBytePatchV1` (empty deleteText) whose exact insertText
  occurs exactly once (relocation allowed) and fully contains the parsed
  bridge node span; fragment/patch digests recorded. Repeated rebases
  preserve the original ADD anchor chain.
- Protected raw nonce exists, satisfies the length bound, and hashes to the
  committed fingerprint — verified inside the void scoped callback only.

## Sanitized preview contents

Exact old/current hashes, expected revision, target realpath/source kind/
format/byteLength; sanitized plugin sequence (index/form/identityKind;
canonical entry labeled `managed-telemetry-bridge`; noncanonical identities
as SHA-256 fingerprints only); canonical bridge index/span; fragment and
patch digests; anchor revision; preserved port/transport/canonical identity/
fingerprint; top-level summary (allowlisted known key names, total count,
unknown count — never unknown names/values); and the exact limitation
booleans:

```json
{
  "historicalContentAvailable": false,
  "fullDiffAvailable": false,
  "contentEquivalenceProven": false,
  "nonBridgeChangesOpaque": true,
  "canonicalBridgeContinuityProven": true,
  "configWritePlanned": false,
  "runtimeActionPlanned": "none",
  "rollbackAvailable": false
}
```

## Local request security

Routes respond only when the CP bind host is loopback AND
`server.requestIP(req)` is loopback; any `Origin` header or any
`sec-fetch-*` metadata is rejected; OPTIONS is rejected (405); responses
carry no CORS headers; bodies are bounded JSON (≤4 KiB). The routes work
while the lifecycle is failed at generation 0 and never start/reconcile the
runtime or touch process control. After a successful apply only, the
composition root runs `bridgeService.reconcile()`, updates the cached
disposition, invalidates Doctor, and broadcasts the sanitized status — never
`refreshEffectiveState`, `runtime.reconcile`, `feedBridgeManager`, or any
lifecycle/process control.

## DB v3

`byte_patch` becomes nullable; intents gain
`expected_revision_id`/`anchor_revision_id`/`audit_metadata`; revisions gain
`parent_revision_id`/`anchor_revision_id`/`acceptance_intent_id`. Safe
rebuild migrations cover v0/v1/v2. `rebase` intents commit directly
(created == committed, null patch/nonce); `rebase` revisions are
non-restorable (restore rejects with `revision-not-restorable`); existing
add/remove revisions remain restorable; the raw nonce in activation state
is byte-identical and untouched. Status exposes
`latestRevisionRestorable: false` when the latest committed revision is a
metadata-only rebase.

## Oracle attempt-2 remediation (accepted corrections)

1. **Candidate provenance fail-closed**: `resolveSourceCandidates` errors AND
   advisories block acceptance; the committed target must match exactly one
   enumerated candidate with the exact committed source kind and realpath.
   Ordinary resolver semantics are unchanged; alternate raw identities are
   never exposed.
2. **Descriptor-stable target reader** (`stable-config-reader.ts`): shared
   by the drift proof, post-commit verification, `BridgeService.reconcile`
   committed-target reads, and the launch boundary. lstat-before-open,
   `O_RDONLY | O_NOFOLLOW` (explicit failure when unavailable), fstat
   regularity/size/dev/ino parity, descriptor-only bytes, fatal UTF-8,
   before/after path+realpath stability, post-read root recheck, fd always
   closed. Injectable file-ops seam; production default strict. No plain
   pathname hash authorizes state.
3. **Lineage, not timestamp**: `validateAnchorLineage` starts from
   `state.revisionId` exactly and walks rebase parents (cycle + 4096 depth
   protection) proving hash linkage, identity-field equality, consistent
   anchor IDs, and null patches, terminating at the recorded ADD anchor with
   a valid content patch. `commitDriftAcceptance` revalidates the current
   revision AND full lineage inside its BEGIN IMMEDIATE transaction; the
   generic `insertRevision` rejects rebase rows at type level and runtime.
4. **Post-commit honesty**: all post-commit DB/state/stable-read faults are
   caught into structured `metadataCommitted:true` outcomes; the route hook
   `onMetadataCommitted` runs for clean AND drifted commits, returns the
   actual reconciliation disposition, and any non-committed disposition (or
   hook fault) yields `post-acceptance-drift` + `recovery-pending` — never
   thrown, never hidden. The route catches internally (mounted outside the
   generic route try).
5. **Status honesty**: `actions.canRestore` is false unless the latest
   committed revision is restorable (`latest-revision-not-restorable`
   reason); shared wording corrected to "latest committed bridge-state
   revision".

## Oracle attempt-3 remediation (final bounded correction)

1. **Strict drift inventory, never the legacy path reader**: the proof no
   longer calls `resolveSourceCandidates`. A drift-specific inventory covers
   the four authorized candidate locations (`<configDir>/opencode.json[ c ]`,
   `<projectDir>/opencode.json[ c ]`); missing is allowed, and every existing
   candidate is strict stable-read (descriptor reader) plus pure snapshot
   parse (`parseSourceCandidateSnapshot`, exported from resolver with zero
   behavior change). In-root symlinks, nonregular/FIFO, oversized, invalid
   UTF-8, unstable/inode/root escape, malformed JSONC, or unsupported plugin
   shape all block. The committed target's already-read snapshot is reused
   (asserted: exactly one open/read of the target). The stable reader's
   descriptor read is now a bounded `readSync` loop (at most maxBytes+1,
   overflow rejected even when fstat reported smaller).
2. **Lineage start hash + strict operations**: `validateAnchorLineage`
   requires the CURRENT revision's postWriteHash to equal the committed
   configHash before walking (direct add and current rebase alike).
   Operation values are strictly parsed (`add|remove|rebase`); unknown values
   throw internally and every getter/mapper/transaction path converts them
   to stable rejections (never uncaught, never cast). `commitDriftAcceptance`
   revalidates inside BEGIN IMMEDIATE before any insert/update.

## Exceptional parser correction (Oracle-authorized, narrow)

The drift inventory now parses every candidate snapshot (committed target
snapshot included) through `parseDriftCandidateSnapshot`, a drift-strict
wrapper in `resolver.ts` that: requires the root AST node to be exactly an
object; enumerates top-level property nodes BEFORE any plugin lookup and
rejects EVERY duplicate top-level property name (duplicate `plugin`
included) without relying on runtime first/last-wins semantics; and only
then extracts supported plugin entries. The ordinary resolver path
(`parseSourceCandidateSnapshot` / `resolveSourceCandidates` /
`resolveAuthorizedCandidate`) is unchanged. Errors carry stable codes and
redacted messages only — never raw candidate contents or identities.
Zero-write preview tests cover duplicate-plugin (canonical first and
second), duplicate non-plugin keys, array roots, and scalar roots, each
asserting `drift-proof-failed` with zero intent/revision/activation writes,
zero config writes, zero effective-view calls, and sentinel-free output.

## Stable errors

`drift-not-eligible`, `drift-proof-failed`, `revision-not-restorable`,
`post-acceptance-drift`, `local-request-required`, `confirmation-mismatch`,
plus existing conflict/replay codes (`preview-stale`, `hash-conflict`,
`state-conflict`, `state-recovery-pending`). No raw messages.
