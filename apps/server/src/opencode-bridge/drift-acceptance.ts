/**
 * Metadata-only drift acceptance — proof engine (Oracle-approved).
 *
 * This is an AUDITED TRUST REBASE, not content equivalence: the historical
 * raw content of an externally modified committed target is treated as
 * unavailable (hard fact). The proof establishes ONLY canonical bridge
 * continuity plus exact hash/revision lineage, then the committed metadata
 * (config hash + revision) is rebased to the observed state in one DB
 * transaction. No config write, no runtime action, no rollback, no claim
 * that opaque changes are benign.
 *
 * Fail closed unless ALL eligibility and proof conditions hold:
 *  1. No prepared/recovery-pending/conflict intent; override inactive.
 *     (DB/service availability is enforced by the route layer.)
 *  2. Committed activation active+complete (env registration, loopback-http,
 *     managed port, lowercase SHA-256 fingerprint, target/source kind/
 *     config hash/revision/canonical identity present).
 *  3. Request carries the exact expected old committed hash/revision and
 *     the current observed hash; current differs from old.
 *  4. Exact committed target: inside authorized roots, regular non-symlink
 *     stable file (no inode/mode/size/hash change across the proof read),
 *     bounded size, valid UTF-8, root object, no duplicate top-level keys,
 *     supported plugin array.
 *  5. Exactly one canonical bridge entry: bare string, lexical identity
 *     exactly the committed canonical identity, canonical realpath match,
 *     no tuple/options; no canonical/bridge-like duplicate in any other
 *     authorized candidate. Never calls resolveAuthorizedCandidate or the
 *     effective-view provider.
 *  6. Anchor: the original/latest content-writing ADD revision with a
 *     valid/restorable BridgeBytePatchV1 (deleteText empty), whose exact
 *     insertText occurs exactly once (relocation allowed) and fully
 *     contains the parsed bridge node span. Fragment/patch digests are
 *     recorded. Repeated rebases preserve the original add anchor chain.
 *  7. The protected raw nonce exists, satisfies the length bound, and
 *     hashes to the committed fingerprint — verified inside the void scoped
 *     callback; it never leaves the callback.
 *
 * Output is sanitized: hashes, digests, spans, counts, and allowlisted
 * metadata only — never raw config text, raw nonce, raw arbitrary paths,
 * tuple options, or provider/auth values.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { parseTree } from "jsonc-parser";
import type {
  BridgeActivationStateRecord,
  BridgeError,
  ContentBridgeRevisionRecord,
  DriftAcceptanceProof,
  IdentityKind,
  PluginForm,
} from "./types";
import {
  BRIDGE_PORT_RANGE_END,
  BRIDGE_PORT_RANGE_START,
} from "./types";
import {
  detectIdentityKind,
  realpathIfExists,
  realpathRoots,
  resolveCanonicalBridge,
} from "./canonical";
import { parseDriftCandidateSnapshot } from "./resolver";
import {
  findPluginEntryNode,
  parseConfigText,
} from "../cfgwrite/jsonc-edit";
import { fingerprintNonce } from "./extractor";
import {
  stableReadConfigFile,
  type StableReadFileOps,
} from "./stable-config-reader";
import type { BridgeRevisionStore } from "./revisions-bridge";

/** Bounded proof read: 256 KiB. */
export const DRIFT_PROOF_MAX_FILE_BYTES = 256 * 1024;

/** Allowlisted top-level config keys whose NAMES may be reported. */
const KNOWN_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "$schema",
  "plugin",
  "agent",
  "mcp",
  "lsp",
  "provider",
  "model",
  "small_model",
  "permission",
  "tools",
  "instructions",
  "theme",
  "keybinds",
  "tui",
  "server",
  "formatter",
  "command",
  "skill",
  "skills",
  "share",
  "autoshare",
  "snapshot",
  "watcher",
  "default_agent",
  "mode",
]);

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

const LIMITATIONS: DriftAcceptanceProof["limitations"] = {
  historicalContentAvailable: false,
  fullDiffAvailable: false,
  contentEquivalenceProven: false,
  nonBridgeChangesOpaque: true,
  canonicalBridgeContinuityProven: true,
  configWritePlanned: false,
  runtimeActionPlanned: "none",
  rollbackAvailable: false,
};

export interface DriftProofDeps {
  store: BridgeRevisionStore;
  opencodeConfigDir: string;
  /** Target OpenCode/OMO project root (candidate inventory locations). */
  projectDirectory: string;
  /**
   * Owl install root. Canonical bridge identity checks resolve against
   * `<owlInstallDirectory>/packages/omo-telemetry-bridge`, independent of
   * the target project directory.
   */
  owlInstallDirectory: string;
  authorizedRoots: string[];
  overrideActive: boolean;
  /**
   * Test-only file-ops seam for deterministic race/fault tests. Production
   * (route/service) never passes it; the strict default is always used.
   */
  fileOps?: StableReadFileOps;
}

export interface DriftProofRequest {
  expectedRevisionId: string;
  expectedCommittedHash: string;
  expectedObservedHash: string;
}

export interface DriftProofSuccess {
  ok: true;
  proof: DriftAcceptanceProof;
  proofDigest: string;
  state: BridgeActivationStateRecord;
  anchorRevision: ContentBridgeRevisionRecord;
}

export type DriftProofResult =
  | DriftProofSuccess
  | { ok: false; errors: BridgeError[] };

function eligible(message: string): DriftProofResult {
  return { ok: false, errors: [{ code: "drift-not-eligible", message }] };
}

function proofFailed(message: string): DriftProofResult {
  return { ok: false, errors: [{ code: "drift-proof-failed", message }] };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Compute the sanitized drift-acceptance proof, or fail closed with stable
 * redacted errors. Pure with respect to side effects: reads the file and
 * DB only; never writes config, DB, or runtime state.
 */
export function computeDriftAcceptanceProof(
  deps: DriftProofDeps,
  req: DriftProofRequest,
): DriftProofResult {
  const realRoots = realpathRoots(deps.authorizedRoots);

  // ── 1. Eligibility: intents + override ───────────────────────────────
  if (deps.overrideActive) {
    return eligible("Override is active; management actions disabled.");
  }
  let unresolvedOrConflict = true;
  try {
    unresolvedOrConflict = deps.store.hasUnresolvedOrConflictIntents();
  } catch {
    return eligible("Cannot read intent state; failing closed.");
  }
  if (unresolvedOrConflict) {
    return eligible("Unresolved or conflict intents exist; reconciliation required first.");
  }

  // ── 2. Committed activation active + complete ────────────────────────
  let state: BridgeActivationStateRecord | null = null;
  try {
    state = deps.store.getActivationState();
  } catch {
    return eligible("Cannot read committed activation state; failing closed.");
  }
  if (!state || !state.active) {
    return eligible("No active committed bridge activation.");
  }
  if (
    state.registrationTransport !== "env" ||
    state.transportMode !== "loopback-http" ||
    typeof state.port !== "number" ||
    !Number.isInteger(state.port) ||
    state.port < BRIDGE_PORT_RANGE_START ||
    state.port > BRIDGE_PORT_RANGE_END ||
    typeof state.nonceFingerprint !== "string" ||
    !FINGERPRINT_RE.test(state.nonceFingerprint) ||
    typeof state.canonicalIdentity !== "string" ||
    state.canonicalIdentity.length === 0 ||
    typeof state.targetPath !== "string" ||
    state.targetPath.length === 0 ||
    typeof state.sourceKind !== "string" ||
    typeof state.configHash !== "string" ||
    state.configHash.length === 0 ||
    typeof state.revisionId !== "string" ||
    state.revisionId.length === 0
  ) {
    return eligible("Committed active bridge state is missing mandatory activation fields.");
  }

  // ── 3. Exact expected hashes/revision ────────────────────────────────
  if (req.expectedRevisionId !== state.revisionId) {
    return eligible("Expected revision does not match the committed revision.");
  }
  if (req.expectedCommittedHash !== state.configHash) {
    return eligible("Expected committed hash does not match the committed hash.");
  }
  if (
    !FINGERPRINT_RE.test(req.expectedObservedHash) ||
    !FINGERPRINT_RE.test(req.expectedCommittedHash)
  ) {
    return eligible("Expected hashes must be 64-char lowercase SHA-256 hex.");
  }
  if (req.expectedObservedHash === req.expectedCommittedHash) {
    return eligible("Observed hash equals the committed hash; there is no drift to accept.");
  }

  // ── 4. Target file proof via the descriptor-stable reader ────────────
  // lstat-before-open, O_NOFOLLOW, descriptor-only bytes, fatal UTF-8,
  // before/after path+realpath stability, root recheck — never follows a
  // replacement or symlink.
  const targetPath = state.targetPath;
  const stable = stableReadConfigFile(
    targetPath,
    {
      maxBytes: DRIFT_PROOF_MAX_FILE_BYTES,
      authorizedRoots: deps.authorizedRoots,
    },
    deps.fileOps,
  );
  if (!stable.ok) {
    return proofFailed(`Committed target failed the stable read (${stable.reason}).`);
  }
  const text = stable.text;
  const realTarget = stable.realpath;
  const observedHash = stable.hash;
  if (observedHash !== req.expectedObservedHash) {
    return proofFailed("Observed hash does not match the current file content.");
  }
  if (observedHash === state.configHash) {
    return proofFailed("Current file content matches the committed hash; no drift present.");
  }

  // ── Root object + duplicate top-level keys ───────────────────────────
  let parsed: Record<string, unknown>;
  try {
    parsed = parseConfigText(text);
  } catch {
    return proofFailed("Committed target is not a parseable root object.");
  }
  const tree = parseTree(text, undefined, { allowTrailingComma: true });
  if (!tree || tree.type !== "object") {
    return proofFailed("Committed target root is not an object.");
  }
  const topKeys: string[] = [];
  {
    const seen = new Set<string>();
    for (const child of tree.children ?? []) {
      if (child.type !== "property") continue;
      const keyNode = child.children?.[0];
      const key = keyNode !== undefined ? String(keyNode.value) : "";
      if (seen.has(key)) {
        return proofFailed("Committed target has duplicate top-level keys.");
      }
      seen.add(key);
      topKeys.push(key);
    }
  }

  // ── 5. Plugin array + canonical bridge uniqueness ────────────────────
  const pluginRaw = parsed["plugin"];
  if (!Array.isArray(pluginRaw)) {
    return proofFailed("Committed target has no supported plugin array.");
  }
  interface Entry {
    form: PluginForm;
    identity: string;
    identityKind: IdentityKind;
  }
  const entries: Entry[] = [];
  for (const raw of pluginRaw) {
    if (typeof raw === "string") {
      const kind = detectIdentityKind(raw);
      if (kind === null) return proofFailed("Plugin array contains an unsupported entry.");
      entries.push({ form: "string", identity: raw, identityKind: kind });
    } else if (
      Array.isArray(raw) &&
      raw.length === 2 &&
      typeof raw[0] === "string" &&
      typeof raw[1] === "object" &&
      raw[1] !== null &&
      !Array.isArray(raw[1])
    ) {
      const kind = detectIdentityKind(raw[0]);
      if (kind === null) return proofFailed("Plugin array contains an unsupported entry.");
      entries.push({ form: "tuple", identity: raw[0], identityKind: kind });
    } else {
      return proofFailed("Plugin array contains an unsupported entry shape.");
    }
  }

  const canonicalIdentity = state.canonicalIdentity;
  const canonicalMatches: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]!.identity === canonicalIdentity) canonicalMatches.push(i);
  }
  if (canonicalMatches.length === 0) {
    return proofFailed("Canonical bridge entry is missing from the committed target.");
  }
  if (canonicalMatches.length > 1) {
    return proofFailed("Canonical bridge entry is duplicated in the committed target.");
  }
  const canonicalIndex = canonicalMatches[0]!;
  if (entries[canonicalIndex]!.form !== "string") {
    return proofFailed("Canonical bridge entry must remain a bare string (no tuple/options).");
  }
  const canonicalCheck = resolveCanonicalBridge(
    canonicalIdentity,
    deps.owlInstallDirectory,
    realRoots,
  );
  if (!canonicalCheck.isCanonical) {
    return proofFailed("Canonical bridge entry no longer resolves to the canonical realpath.");
  }
  // No OTHER entry in the target may be canonical-by-realpath or bridge-like.
  for (let i = 0; i < entries.length; i++) {
    if (i === canonicalIndex) continue;
    const check = resolveCanonicalBridge(
      entries[i]!.identity,
      deps.owlInstallDirectory,
      realRoots,
    );
    if (check.isCanonical || check.isBridgeLikeButNotCanonical) {
      return proofFailed("A noncanonical or duplicate bridge-like entry exists in the committed target.");
    }
  }
  // ── 5b. Strict drift inventory (never the legacy path reader) ────────
  // The four authorized candidate locations. Missing is allowed; EVERY
  // existing candidate is strict stable-read (descriptor-stable reader) and
  // parsed from the pure snapshot parser. Symlink (even in-root),
  // nonregular/FIFO, oversized, invalid UTF-8, unstable/inode/root escape,
  // malformed JSONC, or unsupported plugin shape blocks. The committed
  // target reuses the already-read snapshot — never re-opened/re-read.
  const inventory = buildDriftCandidateInventory(deps, {
    realpath: realTarget,
    text,
    hash: observedHash,
  });
  if (!inventory.ok) {
    return proofFailed(inventory.message);
  }
  const matching = inventory.entries.filter((e) => e.realpath === realTarget);
  if (matching.length === 0) {
    return proofFailed("Committed target is absent from the authorized source inventory.");
  }
  if (matching.length > 1) {
    return proofFailed("Committed target matches multiple source candidates.");
  }
  if (matching[0]!.kind !== state.sourceKind) {
    return proofFailed("Committed target source kind does not match the inventory.");
  }
  // No canonical/bridge-like entry in any OTHER authorized candidate.
  for (const candidate of inventory.entries) {
    if (candidate.realpath === realTarget) continue;
    for (const entry of candidate.pluginEntries) {
      const check = resolveCanonicalBridge(
        entry.identity,
        deps.owlInstallDirectory,
        realRoots,
      );
      if (check.isCanonical || check.isBridgeLikeButNotCanonical) {
        return proofFailed("A canonical or bridge-like entry exists in another authorized candidate.");
      }
    }
  }

  // ── 6. Anchor lineage (never timestamp-based) ────────────────────────
  // Start from the committed state.revisionId exactly and walk the rebase
  // parent chain back to the original ADD anchor with full hash/identity
  // linkage. Cycle/depth protected. Unrelated newer revisions are ignored.
  let anchor: ContentBridgeRevisionRecord;
  let anchorPatch: { version: number; offsetUtf16: number; deleteText: string; insertText: string };
  try {
    const lineage = deps.store.validateAnchorLineage(state);
    if (!lineage.ok) {
      return proofFailed(`Anchor lineage validation failed (${lineage.reason}).`);
    }
    if (lineage.anchor.operation !== "add") {
      return proofFailed("Anchor lineage did not terminate at an ADD revision.");
    }
    anchor = lineage.anchor as ContentBridgeRevisionRecord;
    anchorPatch = JSON.parse(anchor.bytePatch) as typeof anchorPatch;
  } catch {
    return proofFailed("Anchor lineage could not be evaluated.");
  }
  const insertPos = text.indexOf(anchorPatch.insertText);
  if (insertPos < 0 || text.indexOf(anchorPatch.insertText, insertPos + 1) >= 0) {
    return proofFailed("Anchor insert fragment does not occur exactly once in the current content.");
  }
  const bridgeNode = findPluginEntryNode(text, canonicalIdentity);
  if (!bridgeNode) {
    return proofFailed("Canonical bridge entry node cannot be located in the current content.");
  }
  const nodeStart = bridgeNode.node.offset;
  const nodeEnd = nodeStart + bridgeNode.node.length;
  if (
    nodeStart < insertPos ||
    nodeEnd > insertPos + anchorPatch.insertText.length
  ) {
    return proofFailed("Canonical bridge node is not fully inside the anchor insert fragment.");
  }
  const fragmentDigest = sha256(anchorPatch.insertText);
  const patchDigest = sha256(anchor.bytePatch);

  // ── 7. Protected raw nonce parity (void scoped callback only) ────────
  let nonceOk = false;
  let nonceRan = false;
  try {
    nonceRan = deps.store.withCommittedRawNonce((rawNonce) => {
      if (
        rawNonce.length >= 16 &&
        rawNonce.length <= 256 &&
        fingerprintNonce(rawNonce) === state.nonceFingerprint
      ) {
        nonceOk = true;
      }
    });
  } catch {
    return proofFailed("Protected raw nonce access failed.");
  }
  if (!nonceRan || !nonceOk) {
    return proofFailed("Protected raw nonce is missing or does not match the committed fingerprint.");
  }

  // ── Sanitized proof assembly ─────────────────────────────────────────
  const knownKeysPresent = topKeys
    .filter((k) => KNOWN_TOP_LEVEL_KEYS.has(k))
    .sort();
  const pluginSequence = entries.map((entry, index) =>
    index === canonicalIndex
      ? {
          index,
          form: entry.form,
          identityKind: entry.identityKind,
          label: "managed-telemetry-bridge" as const,
        }
      : {
          index,
          form: entry.form,
          identityKind: entry.identityKind,
          identityFingerprint: sha256(entry.identity),
        },
  );

  const proof: DriftAcceptanceProof = {
    version: 1,
    oldCommittedHash: state.configHash,
    observedHash,
    expectedRevisionId: state.revisionId,
    targetRealpath: realTarget,
    sourceKind: state.sourceKind,
    format: realTarget.endsWith(".jsonc") ? "jsonc" : "json",
    byteLength: stable.size,
    pluginSequence,
    canonicalBridgeIndex: canonicalIndex,
    canonicalBridgeSpan: { offset: nodeStart, length: bridgeNode.node.length },
    fragmentDigest,
    anchorRevisionId: anchor.id,
    patchDigest,
    anchorPresent: true,
    preserved: {
      port: state.port,
      transportMode: "loopback-http",
      canonicalIdentity,
      nonceFingerprint: state.nonceFingerprint,
    },
    topLevel: {
      knownKeysPresent,
      totalCount: topKeys.length,
      unknownCount: topKeys.filter((k) => !KNOWN_TOP_LEVEL_KEYS.has(k)).length,
    },
    limitations: LIMITATIONS,
  };

  return {
    ok: true,
    proof,
    proofDigest: sha256(JSON.stringify(proof)),
    state,
    anchorRevision: anchor,
  };
}

/* ------------------------------------------------------------------ */
/* Strict drift candidate inventory (never the legacy path reader)      */
/* ------------------------------------------------------------------ */

interface DriftInventoryEntry {
  path: string;
  realpath: string;
  kind: "opencode-config-dir" | "project-root";
  hash: string;
  pluginEntries: Array<{
    form: PluginForm;
    identity: string;
    identityKind: IdentityKind;
  }>;
}

export type DriftInventoryResult =
  | { ok: true; entries: DriftInventoryEntry[] }
  | { ok: false; message: string };

/**
 * Build the strict drift candidate inventory over the four authorized
 * candidate locations (`<configDir>/opencode.json[ c ]`,
 * `<projectDir>/opencode.json[ c ]`). Missing locations are allowed; EVERY
 * existing candidate is strict stable-read and parsed from the pure
 * snapshot parser. The committed target's already-read snapshot is reused
 * for its location — it is never re-opened or re-read.
 */
function buildDriftCandidateInventory(
  deps: DriftProofDeps,
  targetSnapshot: { realpath: string; text: string; hash: string },
): DriftInventoryResult {
  const realConfigDir = realpathIfExists(deps.opencodeConfigDir);
  const realProjectDir = realpathIfExists(deps.projectDirectory);
  const locations: Array<{
    path: string;
    kind: "opencode-config-dir" | "project-root";
  }> = [
    { path: `${realConfigDir}/opencode.json`, kind: "opencode-config-dir" },
    { path: `${realConfigDir}/opencode.jsonc`, kind: "opencode-config-dir" },
    { path: `${realProjectDir}/opencode.json`, kind: "project-root" },
    { path: `${realProjectDir}/opencode.jsonc`, kind: "project-root" },
  ];

  const entries: DriftInventoryEntry[] = [];
  for (const location of locations) {
    // Reuse the committed target snapshot for its own location.
    if (realpathIfExists(location.path) === targetSnapshot.realpath) {
      const parsed = parseDriftCandidateSnapshot(targetSnapshot.text);
      if ("error" in parsed) {
        return {
          ok: false,
          message: "Committed target snapshot failed to parse for the inventory.",
        };
      }
      entries.push({
        path: location.path,
        realpath: targetSnapshot.realpath,
        kind: location.kind,
        hash: targetSnapshot.hash,
        pluginEntries: parsed.entries.map((e) => ({
          form: e.form,
          identity: e.identity,
          identityKind: e.identityKind,
        })),
      });
      continue;
    }

    // Missing is allowed; anything existing must be strict.
    let exists = false;
    try {
      exists = existsSync(location.path);
    } catch {
      return { ok: false, message: "Candidate existence check failed." };
    }
    if (!exists) continue;

    const stable = stableReadConfigFile(
      location.path,
      {
        maxBytes: DRIFT_PROOF_MAX_FILE_BYTES,
        authorizedRoots: deps.authorizedRoots,
      },
      deps.fileOps,
    );
    if (!stable.ok) {
      return {
        ok: false,
        message: `Authorized candidate failed the stable read (${stable.reason}).`,
      };
    }
    const parsed = parseDriftCandidateSnapshot(stable.text);
    if ("error" in parsed) {
      return {
        ok: false,
        message: "Authorized candidate has malformed content or an unsupported plugin shape.",
      };
    }
    entries.push({
      path: location.path,
      realpath: stable.realpath,
      kind: location.kind,
      hash: stable.hash,
      pluginEntries: parsed.entries.map((e) => ({
        form: e.form,
        identity: e.identity,
        identityKind: e.identityKind,
      })),
    });
  }
  return { ok: true, entries };
}
