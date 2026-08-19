/**
 * Slice 17 hardened — Simulate / Preview / Apply / Restore service.
 *
 * Oracle decisions implemented:
 *  - 2: two-phase DB state (prepared intent before rename, finalize after)
 *  - 3: desired activation descriptor (disabled | enabled with env/tuple)
 *  - 4: raw nonce boundary (internal launch accessor, not barrel-exported)
 *  - 6: 64-char SHA-256 nonce fingerprint, randomBytes(32)
 *  - 7: in-memory one-shot preview registry (crypto ID, 5-min TTL, max 64)
 *  - 8: BridgeBytePatchV1 for exact reversible byte edits
 *  - 9: apply ordering (consume preview, fresh effective, port recheck,
 *       validate patch, insert intent, arm watcher, secure temp, rename,
 *       fsync, prove hash, finalize transaction)
 *  - 12: stable redacted errors, no raw identities/exception messages
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  fsyncSync,
  openSync,
  closeSync,
  lstatSync,
  chmodSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type {
  BridgeAdvisory,
  BridgeApplyDto,
  BridgeBytePatchV1,
  BridgeError,
  BridgePreviewDto,
  BridgeRestoreDto,
  BridgeRevisionRecord,
  ConfigSourceKind,
  DriftAcceptanceApplyDto,
  DriftAcceptanceApplyRequest,
  DriftAcceptancePreviewDto,
  DriftAcceptancePreviewRequest,
  DriftAcceptanceProof,
  EffectivePluginView,
  ActivationIntentRecord,
  BridgeStateDisposition,
} from "./types";
import {
  DRIFT_ACCEPT_ACKNOWLEDGEMENT,
  DRIFT_ACCEPT_CONFIRMATION_TOKEN,
} from "./types";
import { computeDriftAcceptanceProof } from "./drift-acceptance";
import { stableReadConfigFile } from "./stable-config-reader";
import { BRIDGE_PORT_RANGE_START, BRIDGE_PORT_RANGE_END } from "./types";
import { resolveAuthorizedCandidate, resolveSourceCandidates } from "./resolver";
import { canonicalBridgeDir, resolveCanonicalBridge, realpathIfExists, isWithinRoots, realpathRoots } from "./canonical";
import { hashContent, parseConfigText } from "../cfgwrite/jsonc-edit";
import { selectBridgePort, recheckPortFree, defaultPortProbe, type PortProbe } from "./port-selection";
import type { BridgeRevisionStore } from "./revisions-bridge";
import { fingerprintNonce, generateNonce } from "./extractor";
import { computeAddPatch, computeRemovePatch, applyPatch, inversePatch } from "./byte-patch";
import type { SelfWriteIntent } from "./types";

// ── Preview registry (oracle decision 7) ──────────────────────────────

interface PreviewRecord {
  id: string;
  operation: "add" | "remove";
  targetPath: string;
  targetFormat: "json" | "jsonc";
  sourceKind: ConfigSourceKind;
  effectiveDigest: string;
  baselineHash: string;
  proposedHash: string;
  port: number | null;
  rawNonce: string;
  nonceFingerprint?: string;
  bytePatch: BridgeBytePatchV1;
  canonicalIdentity: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}

const PREVIEW_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PREVIEW_MAX = 64;

/**
 * Drift-acceptance preview record. Stores ONLY hashes, the state snapshot
 * identifiers, the sanitized proof, and its digest — never file text or
 * nonce material.
 */
interface DriftPreviewRecord {
  id: string;
  expectedRevisionId: string;
  expectedCommittedHash: string;
  expectedObservedHash: string;
  proof: DriftAcceptanceProof;
  proofDigest: string;
  anchorRevisionId: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}

function effectiveViewDigest(view: EffectivePluginView): string {
  return createHash("sha256")
    .update(JSON.stringify(view.entries.map((e) => ({
      form: e.form,
      effectiveIdentity: e.effectiveIdentity,
      identityKind: e.identityKind,
      bridge: e.bridge ? {
        port: e.bridge.port,
        registrationTransport: e.bridge.registrationTransport,
        nonceFingerprint: e.bridge.nonceFingerprint,
      } : undefined,
    }))))
    .digest("hex");
}

function cryptoId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

// ── Service options ───────────────────────────────────────────────────

export interface BridgeServiceOptions {
  opencodeConfigDir: string;
  projectDirectory: string;
  /**
   * Owl install root (omo-control-plane repository). The managed bridge
   * package identity is `<owlInstallDirectory>/packages/omo-telemetry-bridge`;
   * `projectDirectory` remains the target OpenCode/OMO project for candidate
   * sources and logical write scoping.
   */
  owlInstallDirectory: string;
  authorizedRoots: string[];
  revisions: BridgeRevisionStore;
  probe?: PortProbe;
  /**
   * Injectable effective-view provider for preview and apply. The service
   * obtains a fresh trusted effective view via this provider; external/browser
   * callers cannot forge the effective view. (oracle decision 7)
   */
  effectiveViewProvider: () => Promise<EffectivePluginView>;
  /**
   * Shared in-process opencode.json/jsonc write mutex. When provided, the
   * bridge writer's secure atomic write runs inside this lock so provider
   * management writes and bridge writes never interleave. Mutation
   * semantics are otherwise unchanged.
   */
  writeLock?: <T>(fn: () => T) => Promise<T>;
}

export interface PreviewRequest {
  operation: "add" | "remove";
}

export interface ApplyRequest {
  previewId: string;
}

export interface RestoreRequest {
  revisionId: string;
  expectedSourceHash: string;
}

// ── Watcher hook (oracle decision 9) ──────────────────────────────────

export interface WatcherHook {
  armSelfWrite(intent: SelfWriteIntent): void;
}

// ── Service ───────────────────────────────────────────────────────────

export class BridgeService {
  private readonly opts: BridgeServiceOptions;
  private readonly probe: PortProbe;
  private readonly realRoots: string[];
  private readonly realConfigDir: string;
  private readonly realProjectDir: string;
  private readonly realOwlInstallDir: string;
  private readonly previewRegistry: Map<string, PreviewRecord>;
  private watcherHook: WatcherHook | null = null;

  constructor(opts: BridgeServiceOptions) {
    this.opts = opts;
    this.probe = opts.probe ?? defaultPortProbe;
    this.realRoots = realpathRoots(opts.authorizedRoots);
    this.realConfigDir = realpathIfExists(opts.opencodeConfigDir);
    this.realProjectDir = realpathIfExists(opts.projectDirectory);
    this.realOwlInstallDir = realpathIfExists(opts.owlInstallDirectory);
    this.previewRegistry = new Map();
  }

  /** Set the watcher hook for self-write suppression arming (oracle decision 9). */
  setWatcherHook(hook: WatcherHook): void {
    this.watcherHook = hook;
  }

  private purgeExpiredPreviews(): void {
    const now = Date.now();
    for (const [id, rec] of this.previewRegistry) {
      if (rec.expiresAt <= now || rec.consumed) {
        this.previewRegistry.delete(id);
      }
    }
    // Enforce max size.
    if (this.previewRegistry.size > PREVIEW_MAX) {
      const sorted = [...this.previewRegistry.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
      while (this.previewRegistry.size > PREVIEW_MAX && sorted.length > 0) {
        const [id] = sorted.shift()!;
        this.previewRegistry.delete(id);
      }
    }
  }

  /**
   * Preview a bridge add/remove. No write.
   * Obtains trusted effective view from injected provider.
   * Creates a one-shot preview record in the in-memory registry.
   */
  async preview(req: PreviewRequest): Promise<BridgePreviewDto> {
    this.purgeExpiredPreviews();

    if (!this.opts.effectiveViewProvider) {
      return this.previewError(req.operation, [{ code: "source-unproven", message: "No effective view provider configured." }]);
    }

    let effectiveView: EffectivePluginView;
    try {
      effectiveView = await this.opts.effectiveViewProvider();
    } catch {
      return this.previewError(req.operation, [{ code: "source-unproven", message: "Failed to obtain trusted effective view." }]);
    }

    const resolverResult = resolveAuthorizedCandidate(
      {
        opencodeConfigDir: this.realConfigDir,
        projectDirectory: this.realProjectDir,
        owlInstallDirectory: this.realOwlInstallDir,
        authorizedRoots: this.realRoots,
      },
      effectiveView,
    );

    if (resolverResult.status === "blocked") {
      return this.previewError(req.operation, resolverResult.errors);
    }

    const candidate = resolverResult.candidate;
    // Bridge package identity derives from the Owl install root, not the
    // target project directory.
    const canonicalIdentity = canonicalBridgeDir(this.realOwlInstallDir);

    // For add: verify canonical bridge is recognized.
    if (req.operation === "add") {
      const canonicalCheck = resolveCanonicalBridge(canonicalIdentity, this.realOwlInstallDir, this.realRoots);
      if (!canonicalCheck.isCanonical) {
        return this.previewError(req.operation, [
          { code: "env-scope-unproven", message: "Canonical bridge directory not resolvable under authorized roots." },
        ]);
      }
    }

    // Port selection for add.
    let port: number | null = null;
    if (req.operation === "add") {
      const portResult = await selectBridgePort(this.probe);
      port = portResult.port;
      if (port === null) {
        return this.previewError(req.operation, portResult.errors);
      }
    }

    // Compute byte patch.
    const patchResult = req.operation === "add"
      ? computeAddPatch(candidate.text, canonicalIdentity)
      : computeRemovePatch(candidate.text, canonicalIdentity);

    if ("errors" in patchResult) {
      return this.previewError(req.operation, patchResult.errors);
    }

    const { patch, proposedText } = patchResult;
    const baselineHash = candidate.hash;
    const proposedHash = hashContent(proposedText);

    // Generate nonce for add; remove generates NO nonce or fingerprint.
    let rawNonce = "";
    let nonceFingerprint: string | undefined = undefined;
    if (req.operation === "add") {
      rawNonce = generateNonce();
      nonceFingerprint = fingerprintNonce(rawNonce);
    }

    // Create preview record.
    const previewId = cryptoId("preview");
    const now = Date.now();
    const record: PreviewRecord = {
      id: previewId,
      operation: req.operation,
      targetPath: candidate.path,
      targetFormat: candidate.format,
      sourceKind: candidate.kind,
      effectiveDigest: effectiveViewDigest(effectiveView),
      baselineHash,
      proposedHash,
      port,
      rawNonce,
      nonceFingerprint,
      bytePatch: patch,
      canonicalIdentity,
      createdAt: now,
      expiresAt: now + PREVIEW_TTL_MS,
      consumed: false,
    };
    this.previewRegistry.set(previewId, record);

    // Build safe synthetic bridge diff (no source scanning, no secrets).
    const diff = buildSafeBridgeDiff(patch, req.operation, canonicalIdentity);

    return {
      previewId,
      ok: true,
      operation: req.operation,
      targetPath: candidate.path,
      targetFormat: candidate.format,
      diff,
      port: port ?? undefined,
      registrationTransport: req.operation === "add" ? "env" : undefined,
      transportMode: req.operation === "add" ? "loopback-http" : undefined,
      nonceFingerprint,
      baselineHash,
      proposedHash,
      errors: [],
    };
  }

  /**
   * Apply a bridge add/remove. Consumes the one-shot preview record.
   * (oracle decision 9: apply ordering)
   */
  async apply(req: ApplyRequest): Promise<BridgeApplyDto> {
    this.purgeExpiredPreviews();

    // 1. Consume preview record.
    const record = this.previewRegistry.get(req.previewId);
    if (!record || record.consumed || record.expiresAt <= Date.now()) {
      return {
        ok: false,
        previewId: req.previewId,
        errors: [{ code: "preview-stale", message: "Preview not found, already consumed, or expired." }],
      };
    }
    // Mark consumed (one-shot).
    record.consumed = true;

    // 2. Obtain fresh trusted effective view via injected provider.
    if (!this.opts.effectiveViewProvider) {
      this.previewRegistry.delete(req.previewId);
      return {
        ok: false,
        previewId: req.previewId,
        errors: [{ code: "source-unproven", message: "No effective view provider configured." }],
      };
    }

    let freshView: EffectivePluginView;
    try {
      freshView = await this.opts.effectiveViewProvider();
    } catch {
      this.previewRegistry.delete(req.previewId);
      return {
        ok: false,
        previewId: req.previewId,
        errors: [{ code: "source-unproven", message: "Failed to obtain fresh effective view." }],
      };
    }

    // 3. Proven source: resolve authorized candidate with fresh view.
    const resolverResult = resolveAuthorizedCandidate(
      {
        opencodeConfigDir: this.realConfigDir,
        projectDirectory: this.realProjectDir,
        owlInstallDirectory: this.realOwlInstallDir,
        authorizedRoots: this.realRoots,
      },
      freshView,
    );

    if (resolverResult.status === "blocked") {
      this.previewRegistry.delete(req.previewId);
      return { ok: false, previewId: req.previewId, errors: resolverResult.errors };
    }

    const candidate = resolverResult.candidate;

    // 4. Verify effective digest matches preview.
    const freshDigest = effectiveViewDigest(freshView);
    if (freshDigest !== record.effectiveDigest) {
      this.previewRegistry.delete(req.previewId);
      return {
        ok: false,
        previewId: req.previewId,
        errors: [{ code: "preview-stale", message: "Effective view changed since preview." }],
      };
    }

    // 5. Verify baseline hash matches.
    if (candidate.hash !== record.baselineHash) {
      this.previewRegistry.delete(req.previewId);
      return {
        ok: false,
        previewId: req.previewId,
        errors: [{ code: "hash-conflict", message: "Source hash changed since preview." }],
      };
    }

    // 6. Recheck the exact previewed port (add only).
    if (record.operation === "add" && record.port !== null) {
      const recheck = await recheckPortFree(record.port, this.probe);
      if (!recheck.free) {
        this.previewRegistry.delete(req.previewId);
        return {
          ok: false,
          previewId: req.previewId,
          errors: [{ code: "port-race", message: "Previewed port is no longer free. Re-preview required." }],
        };
      }
    }

    // 7. Validate patch against current source text.
    let currentText: string;
    try {
      currentText = readFileSync(record.targetPath, "utf-8");
    } catch {
      this.previewRegistry.delete(req.previewId);
      return {
        ok: false,
        previewId: req.previewId,
        errors: [{ code: "source-unproven", message: "Cannot read target file." }],
      };
    }

    // Write-time symlink rejection (oracle decision 12).
    try {
      const stat = lstatSync(record.targetPath);
      if (stat.isSymbolicLink()) {
        const real = realpathSync(record.targetPath);
        if (!isWithinRoots(real, this.realRoots)) {
          this.previewRegistry.delete(req.previewId);
          return {
            ok: false,
            previewId: req.previewId,
            errors: [{ code: "env-scope-unproven", message: "Target file symlink escapes authorized roots." }],
          };
        }
      }
    } catch {
      this.previewRegistry.delete(req.previewId);
      return {
        ok: false,
        previewId: req.previewId,
        errors: [{ code: "source-unproven", message: "Target stat failed." }],
      };
    }

    const currentHash = hashContent(currentText);
    if (currentHash !== record.baselineHash) {
      this.previewRegistry.delete(req.previewId);
      return {
        ok: false,
        previewId: req.previewId,
        errors: [{ code: "hash-conflict", message: "File changed externally between preview and apply." }],
      };
    }

    // Apply patch to current text.
    const proposedText = applyPatch(currentText, record.bytePatch);
    if (hashContent(proposedText) !== record.proposedHash) {
      this.previewRegistry.delete(req.previewId);
      return {
        ok: false,
        previewId: req.previewId,
        errors: [{ code: "hash-conflict", message: "Patch does not produce expected proposed hash." }],
      };
    }

    try {
      parseConfigText(proposedText);
    } catch {
      this.previewRegistry.delete(req.previewId);
      return {
        ok: false,
        previewId: req.previewId,
        errors: [{ code: "plugin-shape-unsupported", message: "Proposed text does not parse." }],
      };
    }

    // 8. Insert prepared intent into DB (oracle decision 2).
    const intentId = cryptoId("intent");
    this.opts.revisions.insertPreparedIntent({
      id: intentId,
      targetPath: record.targetPath,
      sourceKind: record.sourceKind,
      operation: record.operation,
      baselineHash: record.baselineHash,
      proposedHash: record.proposedHash,
      canonicalIdentity: record.canonicalIdentity,
      port: record.port ?? undefined,
      registrationTransport: record.operation === "add" ? "env" : undefined,
      transportMode: record.operation === "add" ? "loopback-http" : undefined,
      nonceFingerprint: record.nonceFingerprint,
      bytePatch: JSON.stringify(record.bytePatch),
      rawActivationNonce: record.rawNonce || undefined,
    });

    // 9. Arm watcher self-write suppression (oracle decision 9).
    if (this.watcherHook) {
      this.watcherHook.armSelfWrite({
        path: record.targetPath,
        hash: record.proposedHash,
        token: cryptoId("sw"),
        expiresAt: Date.now() + 10_000,
      });
    }

    // 10. Secure atomic write with baseline check immediately before rename.
    //     Acquires the shared opencode config write mutex when wired so the
    //     provider-management writer cannot interleave (semantics unchanged).
    const writeResult = this.opts.writeLock
      ? await this.opts.writeLock(() => this.secureAtomicWrite(record.targetPath, proposedText, record.baselineHash))
      : this.secureAtomicWrite(record.targetPath, proposedText, record.baselineHash);
    if (!writeResult.ok) {
      this.opts.revisions.abortIntent(intentId);
      this.previewRegistry.delete(req.previewId);
      return {
        ok: false,
        previewId: req.previewId,
        errors: writeResult.errors,
      };
    }

    // 11. Prove hash: reread target and verify.
    let finalText: string;
    try {
      finalText = readFileSync(record.targetPath, "utf-8");
    } catch {
      // Rename succeeded but reread failed — mark recovery-pending (keeps raw nonce!).
      this.opts.revisions.markRecoveryPending(intentId);
      this.previewRegistry.delete(req.previewId);
      return {
        ok: false,
        previewId: req.previewId,
        targetPath: record.targetPath,
        baselineHash: record.baselineHash,
        stateDisposition: "recovery-pending",
        errors: [{ code: "state-recovery-pending", message: "Post-rename reread failed. Recovery required." }],
      };
    }
    const postWriteHash = hashContent(finalText);
    if (postWriteHash !== record.proposedHash) {
      // Content mismatch after rename — mark recovery-pending.
      this.opts.revisions.markRecoveryPending(intentId);
      this.previewRegistry.delete(req.previewId);
      return {
        ok: false,
        previewId: req.previewId,
        targetPath: record.targetPath,
        baselineHash: record.baselineHash,
        postWriteHash,
        stateDisposition: "recovery-pending",
        errors: [{ code: "hash-conflict", message: "Post-rename content mismatch. Recovery required." }],
      };
    }

    // 12. Finalize DB transaction (oracle decision 2).
    const revisionId = cryptoId("brev");
    const finalized = this.opts.revisions.finalizeIntent(
      intentId,
      revisionId,
      new Date().toISOString(),
      postWriteHash,
    );

    this.previewRegistry.delete(req.previewId);

    if (!finalized) {
      // DB commit failed — rename succeeded, so intent is left recovery-pending.
      return {
        ok: false,
        previewId: req.previewId,
        revisionId,
        targetPath: record.targetPath,
        baselineHash: record.baselineHash,
        postWriteHash,
        stateDisposition: "recovery-pending",
        errors: [{ code: "state-recovery-pending", message: "DB finalize failed. Recovery required." }],
      };
    }

    return {
      ok: true,
      previewId: req.previewId,
      revisionId,
      targetPath: record.targetPath,
      baselineHash: record.baselineHash,
      postWriteHash,
      port: record.port ?? undefined,
      registrationTransport: record.operation === "add" ? "env" : undefined,
      transportMode: record.operation === "add" ? "loopback-http" : undefined,
      nonceFingerprint: record.nonceFingerprint,
      stateDisposition: "committed",
      errors: [],
    };
  }

  // ── Metadata-only drift acceptance (two-phase) ──────────────────────

  private readonly driftPreviews: Map<string, DriftPreviewRecord> = new Map();



  private purgeDriftPreviews(): void {
    const now = Date.now();
    for (const [id, rec] of this.driftPreviews) {
      if (rec.expiresAt <= now || rec.consumed) this.driftPreviews.delete(id);
    }
    if (this.driftPreviews.size > PREVIEW_MAX) {
      const sorted = [...this.driftPreviews.entries()].sort(
        (a, b) => a[1].createdAt - b[1].createdAt,
      );
      while (this.driftPreviews.size > PREVIEW_MAX && sorted.length > 0) {
        const [id] = sorted.shift()!;
        this.driftPreviews.delete(id);
      }
    }
  }

  /** Test-only: force-expire all drift previews (TTL boundary tests). */
  __expireDriftPreviewsForTests(): void {
    for (const rec of this.driftPreviews.values()) {
      rec.expiresAt = 0;
    }
  }

  /**
   * Drift-acceptance preview. NO DB write, NO config write, NO effective-
   * view call — the proof reads the file and revision store only. Stores
   * only hashes, the state snapshot, the sanitized proof, and its digest;
   * never text or nonce material.
   */
  previewDriftAcceptance(
    req: DriftAcceptancePreviewRequest,
    opts: { overrideActive: boolean },
  ): DriftAcceptancePreviewDto {
    this.purgeDriftPreviews();
    const result = computeDriftAcceptanceProof(
      {
        store: this.opts.revisions,
        opencodeConfigDir: this.realConfigDir,
        projectDirectory: this.realProjectDir,
        owlInstallDirectory: this.realOwlInstallDir,
        authorizedRoots: this.opts.authorizedRoots,
        overrideActive: opts.overrideActive,
      },
      req,
    );
    if (!result.ok) {
      return {
        ok: false,
        acknowledgement: DRIFT_ACCEPT_ACKNOWLEDGEMENT,
        confirmationToken: DRIFT_ACCEPT_CONFIRMATION_TOKEN,
        errors: result.errors,
      };
    }
    const id = `driftpreview_${randomBytes(16).toString("hex")}`; // 128 bits
    const now = Date.now();
    const record: DriftPreviewRecord = {
      id,
      expectedRevisionId: req.expectedRevisionId,
      expectedCommittedHash: req.expectedCommittedHash,
      expectedObservedHash: req.expectedObservedHash,
      proof: result.proof,
      proofDigest: result.proofDigest,
      anchorRevisionId: result.anchorRevision.id,
      createdAt: now,
      expiresAt: now + PREVIEW_TTL_MS,
      consumed: false,
    };
    this.driftPreviews.set(id, record);
    return {
      ok: true,
      previewId: id,
      proof: result.proof,
      proofDigest: result.proofDigest,
      acknowledgement: DRIFT_ACCEPT_ACKNOWLEDGEMENT,
      confirmationToken: DRIFT_ACCEPT_CONFIRMATION_TOKEN,
      errors: [],
    };
  }

  /**
   * Drift-acceptance apply. The preview is consumed BEFORE any
   * confirmation/hash comparison (every valid ID is one-shot). Then:
   * re-read state/file, re-run the full proof, compare the proof digest,
   * verify raw-nonce parity (inside the proof), and commit ONE DB
   * transaction. Immediately after commit, securely reread the file and
   * re-verify the committed state (post-commit drift detection). No config
   * write, no runtime action, no rollback.
   */
  applyDriftAcceptance(
    req: DriftAcceptanceApplyRequest,
    opts: {
      overrideActive: boolean;
      /**
       * Test-only seam: runs between the commit and the post-commit secure
       * reread, enabling deterministic post-commit-drift tests. Never set in
       * production (the route layer does not pass it).
       */
      afterCommitBeforeReread?: () => void;
    },
  ): DriftAcceptanceApplyDto {
    this.purgeDriftPreviews();

    const fail = (
      errors: BridgeError[],
      extra: Partial<DriftAcceptanceApplyDto> = {},
    ): DriftAcceptanceApplyDto => ({
      ok: false,
      previewId: req.previewId,
      metadataCommitted: false,
      configWritten: false,
      runtimeAction: "none",
      restorable: false,
      errors,
      ...extra,
    });

    // 1. Consume the preview BEFORE any comparison (one-shot).
    const record = this.driftPreviews.get(req.previewId);
    if (!record || record.consumed || record.expiresAt <= Date.now()) {
      return fail([
        { code: "preview-stale", message: "Preview not found, already consumed, or expired." },
      ]);
    }
    record.consumed = true;
    this.driftPreviews.delete(req.previewId);

    // 2. Confirmation token + expected-field parity with the preview.
    if (req.confirmation !== DRIFT_ACCEPT_CONFIRMATION_TOKEN) {
      return fail([
        { code: "confirmation-mismatch", message: "Confirmation token does not match the required drift-acceptance token." },
      ]);
    }
    if (
      req.expectedRevisionId !== record.expectedRevisionId ||
      req.expectedCommittedHash !== record.expectedCommittedHash ||
      req.expectedObservedHash !== record.expectedObservedHash
    ) {
      return fail([
        { code: "hash-conflict", message: "Expected revision/hashes do not match the preview." },
      ]);
    }

    // 3. Re-read state/file and re-run the FULL proof (includes raw-nonce
    //    parity inside the void scoped callback).
    const fresh = computeDriftAcceptanceProof(
      {
        store: this.opts.revisions,
        opencodeConfigDir: this.realConfigDir,
        projectDirectory: this.realProjectDir,
        owlInstallDirectory: this.realOwlInstallDir,
        authorizedRoots: this.opts.authorizedRoots,
        overrideActive: opts.overrideActive,
      },
      {
        expectedRevisionId: req.expectedRevisionId,
        expectedCommittedHash: req.expectedCommittedHash,
        expectedObservedHash: req.expectedObservedHash,
      },
    );
    if (!fresh.ok) return fail(fresh.errors);
    if (fresh.proofDigest !== record.proofDigest) {
      return fail([
        { code: "preview-stale", message: "Proof changed between preview and apply." },
      ]);
    }

    // 4. One DB transaction: committed rebase intent + rebase revision +
    //    CAS update of config_hash/revision_id/updated_at only.
    const timestamp = new Date().toISOString();
    const intentId = cryptoId("intent");
    const revisionId = cryptoId("brev");
    const auditMetadata = JSON.stringify({
      version: 1,
      kind: "drift-acceptance",
      proofDigest: record.proofDigest,
      fragmentDigest: record.proof.fragmentDigest,
      patchDigest: record.proof.patchDigest,
      anchorRevisionId: record.anchorRevisionId,
      limitations: record.proof.limitations,
      confirmationToken: DRIFT_ACCEPT_CONFIRMATION_TOKEN,
    });
    const committed = this.opts.revisions.commitDriftAcceptance({
      intentId,
      revisionId,
      timestamp,
      targetPath: fresh.state.targetPath,
      sourceKind: fresh.state.sourceKind,
      canonicalIdentity: fresh.state.canonicalIdentity,
      port: fresh.state.port!,
      nonceFingerprint: fresh.state.nonceFingerprint!,
      oldConfigHash: record.expectedCommittedHash,
      newConfigHash: record.expectedObservedHash,
      expectedRevisionId: record.expectedRevisionId,
      anchorRevisionId: record.anchorRevisionId,
      auditMetadata,
    });
    if (!committed.ok) {
      return fail([{ code: committed.code, message: committed.message }]);
    }

    // 5. Immediate descriptor-stable reread + state re-verification
    //    (post-commit drift detection). ALL faults after the commit — DB,
    //    state read, stable read — produce a structured
    //    metadataCommitted:true outcome. NEVER pretend rollback.
    opts.afterCommitBeforeReread?.();
    try {
      const stable = stableReadConfigFile(fresh.state.targetPath, {
        maxBytes: 256 * 1024,
        authorizedRoots: this.opts.authorizedRoots,
      });
      const postState = this.opts.revisions.getActivationState();
      const postOk =
        stable.ok &&
        stable.hash === record.expectedObservedHash &&
        postState !== null &&
        postState.configHash === record.expectedObservedHash &&
        postState.revisionId === revisionId;
      if (!postOk) {
        return fail(
          [
            {
              code: "post-acceptance-drift",
              message: "State changed after the acceptance commit; metadata is committed and cannot be rolled back.",
            },
          ],
          {
            metadataCommitted: true,
            revisionId,
            oldConfigHash: record.expectedCommittedHash,
            newConfigHash: record.expectedObservedHash,
            stateDisposition: "recovery-pending",
          },
        );
      }
    } catch {
      return fail(
        [
          {
            code: "post-acceptance-drift",
            message: "Post-commit verification failed after the acceptance commit; metadata is committed and cannot be rolled back.",
          },
        ],
        {
          metadataCommitted: true,
          revisionId,
          oldConfigHash: record.expectedCommittedHash,
          newConfigHash: record.expectedObservedHash,
          stateDisposition: "recovery-pending",
        },
      );
    }

    return {
      ok: true,
      previewId: req.previewId,
      metadataCommitted: true,
      configWritten: false,
      runtimeAction: "none",
      restorable: false,
      restartRequired: true,
      revisionId,
      oldConfigHash: record.expectedCommittedHash,
      newConfigHash: record.expectedObservedHash,
      stateDisposition: "committed",
      errors: [],
    };
  }

  /**
   * Restore a prior bridge revision via exact inverse byte patch.
   * (oracle decision 8)
   */
  async restore(req: RestoreRequest): Promise<BridgeRestoreDto> {
    if (!req.expectedSourceHash) {
      return { ok: false, errors: [{ code: "hash-conflict", message: "expectedSourceHash is required for restore." }] };
    }

    const rev = this.opts.revisions.getRevision(req.revisionId);
    if (!rev) {
      return { ok: false, errors: [{ code: "restore-mismatch", message: "Revision not found." }] };
    }

    // Metadata-only rebase revisions are NEVER restorable (no byte patch).
    if (rev.operation === "rebase") {
      return {
        ok: false,
        errors: [{ code: "revision-not-restorable", message: "Metadata-only drift-acceptance revisions are not restorable." }],
      };
    }

    // Reauthorize target path under roots.
    if (!isWithinRoots(rev.targetPath, this.realRoots)) {
      return { ok: false, errors: [{ code: "env-scope-unproven", message: "Revision target path outside authorized roots." }] };
    }

    if (!existsSync(rev.targetPath)) {
      return { ok: false, errors: [{ code: "restore-mismatch", message: "Target file no longer exists." }] };
    }

    // Write-time symlink rejection.
    try {
      const stat = lstatSync(rev.targetPath);
      if (stat.isSymbolicLink()) {
        const real = realpathSync(rev.targetPath);
        if (!isWithinRoots(real, this.realRoots)) {
          return { ok: false, errors: [{ code: "env-scope-unproven", message: "Target symlink escapes roots." }] };
        }
      }
    } catch {
      return { ok: false, errors: [{ code: "source-unproven", message: "Target stat failed." }] };
    }

    let currentText: string;
    try {
      currentText = readFileSync(rev.targetPath, "utf-8");
    } catch {
      return { ok: false, errors: [{ code: "restore-mismatch", message: "Cannot read target." }] };
    }
    const currentHash = hashContent(currentText);

    // expectedSourceHash verification.
    if (req.expectedSourceHash !== currentHash) {
      return { ok: false, errors: [{ code: "hash-conflict", message: "Source hash does not match expected." }] };
    }
    if (currentHash !== rev.postWriteHash) {
      return { ok: false, errors: [{ code: "restore-mismatch", message: "Current hash does not match revision post-write hash." }] };
    }

    // Validate stored byte patch JSON schema before use.
    let storedPatch: BridgeBytePatchV1;
    try {
      storedPatch = JSON.parse(rev.bytePatch) as BridgeBytePatchV1;
      if (
        !storedPatch ||
        storedPatch.version !== 1 ||
        typeof storedPatch.offsetUtf16 !== "number" ||
        typeof storedPatch.deleteText !== "string" ||
        typeof storedPatch.insertText !== "string"
      ) {
        return { ok: false, errors: [{ code: "restore-mismatch", message: "Invalid stored byte patch schema in revision." }] };
      }
    } catch {
      return { ok: false, errors: [{ code: "restore-mismatch", message: "Cannot parse revision byte patch." }] };
    }

    // Apply exact inverse byte patch.
    const inverse = inversePatch(storedPatch);
    const restoredText = applyPatch(currentText, inverse);

    // Verify restored hash matches baseline.
    const restoredHash = hashContent(restoredText);
    if (restoredHash !== rev.baselineHash) {
      return { ok: false, errors: [{ code: "restore-mismatch", message: "Inverse patch does not reproduce baseline hash." }] };
    }

    try {
      parseConfigText(restoredText);
    } catch {
      return { ok: false, errors: [{ code: "plugin-shape-unsupported", message: "Restored text does not parse." }] };
    }

    // Insert prepared intent for restore.
    const intentId = cryptoId("intent");
    // For restore-to-enabled (inverse of remove), rotate fresh nonce.
    let rawNonce = "";
    let nonceFingerprint: string | undefined = undefined;
    if (rev.operation === "remove") {
      rawNonce = generateNonce();
      nonceFingerprint = fingerprintNonce(rawNonce);
    }

    const restorePatch: BridgeBytePatchV1 = inverse;

    this.opts.revisions.insertPreparedIntent({
      id: intentId,
      targetPath: rev.targetPath,
      sourceKind: rev.sourceKind,
      operation: rev.operation === "add" ? "remove" : "add",
      baselineHash: rev.postWriteHash,
      proposedHash: restoredHash,
      canonicalIdentity: rev.canonicalIdentity,
      port: rev.operation === "remove" ? (rev.port ?? undefined) : undefined,
      registrationTransport: rev.operation === "remove" ? "env" : undefined,
      transportMode: rev.operation === "remove" ? "loopback-http" : undefined,
      nonceFingerprint,
      bytePatch: JSON.stringify(restorePatch),
      rawActivationNonce: rawNonce || undefined,
    });

    // Arm watcher.
    if (this.watcherHook) {
      this.watcherHook.armSelfWrite({
        path: rev.targetPath,
        hash: restoredHash,
        token: cryptoId("sw"),
        expiresAt: Date.now() + 10_000,
      });
    }

    // Secure atomic write (inside the shared config write mutex when wired).
    const writeResult = this.opts.writeLock
      ? await this.opts.writeLock(() => this.secureAtomicWrite(rev.targetPath, restoredText, rev.postWriteHash))
      : this.secureAtomicWrite(rev.targetPath, restoredText, rev.postWriteHash);
    if (!writeResult.ok) {
      this.opts.revisions.abortIntent(intentId);
      return { ok: false, errors: writeResult.errors };
    }

    // Prove hash.
    let finalText: string;
    try {
      finalText = readFileSync(rev.targetPath, "utf-8");
    } catch {
      this.opts.revisions.markRecoveryPending(intentId);
      return {
        ok: false,
        stateDisposition: "recovery-pending",
        errors: [{ code: "state-recovery-pending", message: "Post-restore reread failed." }],
      };
    }
    const finalHash = hashContent(finalText);
    if (finalHash !== rev.baselineHash) {
      this.opts.revisions.markRecoveryPending(intentId);
      return {
        ok: false,
        stateDisposition: "recovery-pending",
        errors: [{ code: "restore-mismatch", message: "Post-restore hash mismatch." }],
      };
    }

    // Finalize DB transaction.
    const newRevId = cryptoId("brev");
    const finalized = this.opts.revisions.finalizeIntent(
      intentId,
      newRevId,
      new Date().toISOString(),
      finalHash,
    );

    if (!finalized) {
      return {
        ok: false,
        revisionId: newRevId,
        targetPath: rev.targetPath,
        stateDisposition: "recovery-pending",
        errors: [{ code: "state-recovery-pending", message: "DB finalize failed after restore." }],
      };
    }

    return {
      ok: true,
      revisionId: newRevId,
      targetPath: rev.targetPath,
      restoredHash: finalHash,
      baselineHash: rev.baselineHash,
      stateDisposition: "committed",
      errors: [],
    };
  }

  /**
   * Startup reconciliation (oracle decision 2 & 4).
   * 1. Unresolved intents:
   *    - baseline => abortIntent (clears pending nonce)
   *    - proposed => finalizeIntent with pending raw nonce into committed state
   *    - neither => conflictIntent (blocks owned launch)
   * 2. Committed enabled state:
   *    - Check target file exists and hash matches config_hash.
   *    - If drift detected => return conflict, blocking launch.
   */
  reconcile(): { disposition: BridgeStateDisposition; errors: BridgeError[] } {
    const prepared = this.opts.revisions.getPreparedIntents();
    const errors: BridgeError[] = [];

    for (const intent of prepared) {
      const targetPath = intent.targetPath;
      if (!existsSync(targetPath)) {
        this.opts.revisions.abortIntent(intent.id);
        continue;
      }
      let currentText: string;
      try {
        currentText = readFileSync(targetPath, "utf-8");
      } catch {
        this.opts.revisions.conflictIntent(intent.id);
        errors.push({ code: "state-conflict", message: "Cannot read target for reconciliation." });
        continue;
      }
      const currentHash = hashContent(currentText);

      if (currentHash === intent.proposedHash) {
        // Rename succeeded on disk: finish final transaction and preserve raw nonce!
        const revId = cryptoId("brev");
        const finalized = this.opts.revisions.finalizeIntent(
          intent.id,
          revId,
          new Date().toISOString(),
          intent.proposedHash,
        );
        if (!finalized) {
          errors.push({ code: "state-recovery-pending", message: "Reconciliation finalize failed." });
        }
      } else if (currentHash === intent.baselineHash) {
        // File has baseline content: rename didn't occur -> abort.
        this.opts.revisions.abortIntent(intent.id);
      } else {
        // File modified to something else -> conflict.
        this.opts.revisions.conflictIntent(intent.id);
        errors.push({ code: "state-conflict", message: "File hash matches neither baseline nor proposed." });
      }
    }

    if (errors.length > 0) {
      return { disposition: "recovery-pending", errors };
    }

    // Check committed enabled state for target-hash drift (oracle decision 4).
    const state = this.opts.revisions.getActivationState();
    if (state && state.active) {
      // An active committed record MUST be complete: configHash, explicit
      // managed port, valid 64-hex fingerprint, canonical identity, and
      // loopback transport. Missing/malformed mandatory fields reconcile to
      // recovery-pending (fail closed) — they never skip validation.
      const fingerprintOk =
        typeof state.nonceFingerprint === "string" &&
        /^[0-9a-f]{64}$/.test(state.nonceFingerprint);
      const portOk =
        typeof state.port === "number" &&
        Number.isInteger(state.port) &&
        state.port >= BRIDGE_PORT_RANGE_START &&
        state.port <= BRIDGE_PORT_RANGE_END;
      const hashOk =
        typeof state.configHash === "string" && state.configHash.length > 0;
      const identityOk =
        typeof state.canonicalIdentity === "string" &&
        state.canonicalIdentity.length > 0;
      const transportOk = state.transportMode === "loopback-http";
      if (!fingerprintOk || !portOk || !hashOk || !identityOk || !transportOk) {
        errors.push({
          code: "state-recovery-pending",
          message: "Committed active bridge state is missing mandatory activation fields.",
        });
        return { disposition: "recovery-pending", errors };
      }
      if (!existsSync(state.targetPath)) {
        errors.push({ code: "state-conflict", message: "Target config file missing for active bridge." });
        return { disposition: "recovery-pending", errors };
      }
      // Descriptor-stable read of the committed target: no plain pathname
      // hash may authorize state.
      const stable = stableReadConfigFile(state.targetPath, {
        maxBytes: 256 * 1024,
        authorizedRoots: this.opts.authorizedRoots,
      });
      if (!stable.ok) {
        errors.push({ code: "state-conflict", message: `Committed target failed the stable read (${stable.reason}).` });
        return { disposition: "recovery-pending", errors };
      }
      if (stable.hash !== state.configHash) {
        errors.push({ code: "state-conflict", message: "Committed active bridge target config hash drift detected." });
        return { disposition: "recovery-pending", errors };
      }
    }

    return { disposition: state?.active ? "committed" : "not-written", errors: [] };
  }

  // ── Secure atomic write (oracle decision 7, 9 & 11) ─────────────────

  private secureAtomicWrite(
    targetPath: string,
    content: string,
    expectedBaselineHash: string,
  ): { ok: true } | { ok: false; errors: BridgeError[] } {
    const dir = dirname(targetPath);
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* may exist */
    }

    // Crypto-random same-dir temp name.
    const tmp = join(dir, `.${basename(targetPath)}.${randomBytes(8).toString("hex")}.tmp`);

    // Exclusive/no-follow open, preserve mode but at most 0600.
    let fd: number | null = null;
    try {
      fd = openSync(tmp, "wx"); // exclusive write, fails if exists
      writeFileSync(fd, content, "utf-8");

      let mode = 0o600;
      try {
        if (existsSync(targetPath)) {
          const targetStat = lstatSync(targetPath);
          mode = Math.min(targetStat.mode & 0o777, 0o600);
        }
      } catch {
        /* default 0600 */
      }
      chmodSync(tmp, mode);
      fsyncSync(fd);
    } catch {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        /* */
      }
      return { ok: false, errors: [{ code: "source-unproven", message: "Temp write or durability sync failed." }] };
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          /* */
        }
      }
    }

    // Reread temp and verify parity.
    let tmpRead: string;
    try {
      tmpRead = readFileSync(tmp, "utf-8");
    } catch {
      try {
        unlinkSync(tmp);
      } catch {
        /* */
      }
      return { ok: false, errors: [{ code: "source-unproven", message: "Temp reread failed." }] };
    }
    if (tmpRead !== content) {
      try {
        unlinkSync(tmp);
      } catch {
        /* */
      }
      return { ok: false, errors: [{ code: "source-unproven", message: "Temp parity check failed." }] };
    }
    try {
      parseConfigText(tmpRead);
    } catch {
      try {
        unlinkSync(tmp);
      } catch {
        /* */
      }
      return { ok: false, errors: [{ code: "plugin-shape-unsupported", message: "Temp parse failed." }] };
    }

    // Recheck target baseline and symlink immediately before rename (oracle decision 11).
    try {
      if (existsSync(targetPath)) {
        const stat = lstatSync(targetPath);
        if (stat.isSymbolicLink()) {
          try {
            unlinkSync(tmp);
          } catch {
            /* */
          }
          return { ok: false, errors: [{ code: "env-scope-unproven", message: "Target became a symlink." }] };
        }

        const currentContent = readFileSync(targetPath, "utf-8");
        const currentHash = hashContent(currentContent);
        if (currentHash !== expectedBaselineHash) {
          try {
            unlinkSync(tmp);
          } catch {
            /* */
          }
          return { ok: false, errors: [{ code: "hash-conflict", message: "Target file changed immediately before rename." }] };
        }
      }
    } catch {
      try {
        unlinkSync(tmp);
      } catch {
        /* */
      }
      return { ok: false, errors: [{ code: "source-unproven", message: "Target pre-rename verification failed." }] };
    }

    // Rename.
    try {
      renameSync(tmp, targetPath);
    } catch {
      try {
        unlinkSync(tmp);
      } catch {
        /* */
      }
      return { ok: false, errors: [{ code: "source-unproven", message: "Atomic rename failed." }] };
    }

    // Fsync directory (fails closed on durability failure).
    let dirFd: number | null = null;
    try {
      dirFd = openSync(dir, "r");
      fsyncSync(dirFd);
    } catch {
      return { ok: false, errors: [{ code: "source-unproven", message: "Directory sync failed after rename." }] };
    } finally {
      if (dirFd !== null) {
        try {
          closeSync(dirFd);
        } catch {
          /* */
        }
      }
    }

    return { ok: true };
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private previewError(operation: "add" | "remove", errors: BridgeError[]): BridgePreviewDto {
    return {
      previewId: "",
      ok: false,
      operation,
      targetPath: "",
      targetFormat: "json",
      diff: "",
      registrationTransport: operation === "add" ? "env" : undefined,
      transportMode: operation === "add" ? "loopback-http" : undefined,
      nonceFingerprint: undefined,
      baselineHash: "",
      proposedHash: "",
      errors,
    };
  }
}

// ── Safe bridge-only diff (oracle decision 5 & Defect 13) ─────────────
//
// Construct purely from the synthetic bridge operation, NOT by scanning source lines.
// No neighboring plugin entries, trivia, or provider fields.

function buildSafeBridgeDiff(
  _patch: BridgeBytePatchV1,
  operation: "add" | "remove",
  canonicalIdentity: string,
): string {
  const lines: string[] = ["--- opencode.json", "+++ opencode.json", "@@ plugin @@"];
  if (operation === "add") {
    lines.push(`+ "${canonicalIdentity}"`);
  } else {
    lines.push(`- "${canonicalIdentity}"`);
  }
  return lines.join("\n");
}
