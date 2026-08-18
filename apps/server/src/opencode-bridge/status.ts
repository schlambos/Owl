/**
 * Slice 17 — Server integration helper: composes the sanitized
 * TelemetryBridgeStatusDto from the already-built foundation modules.
 *
 * This is a narrowly-scoped composition helper so index.ts does not bloat.
 * It does NOT rewrite any foundation module. It reads from:
 *  - BridgeRevisionStore (committed activation state)
 *  - resolver/extractor/override (source/effective/override)
 *  - TelemetryBridgeManager (runtime/compatibility/identity/epoch)
 *  - OpenCodeLifecycleManager (mode/ownership/generation/restart)
 *
 * Security: never includes raw config, raw nonce, raw options, endpoint
 * credentials, environment, or diffs in the DTO. All fields are sanitized
 * enums or allowlisted values.
 *
 * PURE: composeBridgeStatus never calls bridgeService.reconcile() or any
 * other method that finalizes/aborts intents. Reconciliation runs only at
 * startup and explicit write/recovery paths. The cached disposition/errors
 * are passed in via composition state.
 */

import { existsSync } from "node:fs";
import type {
  TelemetryBridgeStatusDto,
  TelemetryBridgeStatusSummary,
  TelemetryBridgeSourceGate,
  TelemetryBridgeDesiredState,
  TelemetryBridgeOverride,
  TelemetryBridgeRegistrationState,
  TelemetryBridgeRuntimeState,
  TelemetryBridgeCompatibility,
  TelemetryBridgeEndpointSource,
  TelemetryBridgeLocalPackage,
  TelemetryBridgeLifecycleStatus,
  TelemetryBridgeActionEligibility,
  TelemetryBridgeCapabilities,
} from "@omo/shared";
import type {
  BridgeRevisionStore,
} from "./revisions-bridge";
import type { BridgeService } from "./service";
import { validateBridgeOverride } from "./override";
import {
  canonicalBridgeDir,
  detectDuplicateBridgeEntries,
  realpathIfExists,
} from "./canonical";
import { resolveSourceCandidates } from "./resolver";
import type {
  BridgeOverrideStatus,
  EffectivePluginView,
  ResolverResult,
  SourceCandidate,
  BridgeError,
  BridgeActivationStateRecord,
} from "./types";
import type { TelemetryBridgeManager } from "../omo-runtime/manager";
import type { OpenCodeLifecycleStateWithRestartKind } from "../opencode/lifecycle";
import type { ServerConfig } from "../config";

// ── Slice 17: In-memory one-shot preview confirmation registry ──────
// Long-lived composition scope outside fetch with 5-minute TTL and max 64 entries.
export interface PreviewConfirmationEntry {
  operation: "register" | "remove";
  createdAt: number;
}
export const PREVIEW_CONFIRMATION_TTL_MS = 5 * 60 * 1000;
export const MAX_PREVIEW_CONFIRMATIONS = 64;
export const previewConfirmations = new Map<string, PreviewConfirmationEntry>();

export function purgeStalePreviewConfirmations(now = Date.now()): void {
  for (const [id, entry] of previewConfirmations) {
    if (now - entry.createdAt > PREVIEW_CONFIRMATION_TTL_MS) {
      previewConfirmations.delete(id);
    }
  }
}

export function storePreviewConfirmation(
  previewId: string,
  operation: "register" | "remove",
  now = Date.now(),
): void {
  purgeStalePreviewConfirmations(now);
  while (previewConfirmations.size >= MAX_PREVIEW_CONFIRMATIONS) {
    const oldestKey = previewConfirmations.keys().next().value;
    if (oldestKey) previewConfirmations.delete(oldestKey);
    else break;
  }
  previewConfirmations.set(previewId, { operation, createdAt: now });
}

export function consumePreviewConfirmation(
  previewId: string,
  now = Date.now(),
): "register" | "remove" | undefined {
  purgeStalePreviewConfirmations(now);
  const entry = previewConfirmations.get(previewId);
  if (!entry) return undefined;
  previewConfirmations.delete(previewId);
  if (now - entry.createdAt > PREVIEW_CONFIRMATION_TTL_MS) {
    return undefined;
  }
  return entry.operation;
}

/**
 * Invalidate proven write target and cached resolver proof on an external
 * watcher edit before async refresh occurs.
 */
export function invalidateProvenTargetOnExternalEdit(
  cachedEffectiveState: CachedEffectiveState | undefined,
): {
  cachedEffectiveState: CachedEffectiveState | undefined;
  provenWriteTarget: undefined;
} {
  return {
    cachedEffectiveState: cachedEffectiveState
      ? {
          ...cachedEffectiveState,
          resolver: {
            status: "blocked",
            errors: [{ code: "source-unproven", message: "External edit invalidated proven source proof." }],
          },
        }
      : undefined,
    provenWriteTarget: undefined,
  };
}

// ── Cached effective state (immutable snapshot from index) ──────────────

/**
 * Immutable cached effective-state snapshot. Captured asynchronously by
 * index.ts when the canonical lifecycle is connected, using ONLY
 * runtime.getClient().effectivePluginView(). The lifecycle generation and
 * baseUrl are captured alongside so stale-generation results can be
 * discarded.
 */
export interface CachedEffectiveState {
  /** The sanitized effective plugin view (never raw config). */
  view: EffectivePluginView;
  /** Lifecycle generation when this view was captured. */
  generation: number;
  /** Lifecycle baseUrl when this view was captured. */
  baseUrl: string | undefined;
  /** The proven resolver result (unique candidate or blocked). */
  resolver: ResolverResult;
}

// ── Cached reconciliation disposition (from startup/explicit writes) ────

/**
 * Cached reconciliation disposition from the startup or explicit
 * write/recovery path. composeBridgeStatus reads this without calling
 * reconcile() itself (status/Doctor/SSE must be pure).
 */
export interface CachedReconcileDisposition {
  disposition: "not-written" | "committed" | "recovery-pending";
  errors: BridgeError[];
}

// ── Composition deps ────────────────────────────────────────────────────

export interface BridgeStatusCompositionDeps {
  cfg: ServerConfig;
  /** Bridge revision store. undefined when DB construction failed. */
  bridgeStore: BridgeRevisionStore | undefined;
  /** Bridge service. undefined when DB construction failed. */
  bridgeService: BridgeService | undefined;
  bridgeManager: TelemetryBridgeManager;
  lifecycleState: OpenCodeLifecycleStateWithRestartKind;
  /** Override status from config (already validated). */
  overrideStatus: BridgeOverrideStatus;
  /** Cached effective state (from async refresh in index). undefined when not yet captured. */
  cachedEffectiveState: CachedEffectiveState | undefined;
  /** Cached reconciliation disposition (from startup/explicit writes). */
  cachedReconcile: CachedReconcileDisposition | undefined;
  /** Cached proven write target from pre-write state. */
  provenWriteTarget?: SourceCandidate | null;
}

/**
 * Compose the full sanitized bridge status DTO.
 * Never throws — composition failures produce absent/null fields.
 * PURE: never calls reconcile() or any method that finalizes/aborts intents.
 */
export function composeBridgeStatus(
  deps: BridgeStatusCompositionDeps,
): TelemetryBridgeStatusDto {
  const { cfg, bridgeStore, bridgeService: _bridgeService, bridgeManager, lifecycleState, overrideStatus, cachedEffectiveState, cachedReconcile, provenWriteTarget } = deps;
  void _bridgeService; // service is not called directly in pure status composition

  const dbAvailable = bridgeStore !== undefined;

  // ── Desired activation state (from revision store) ─────────────────
  // Uses cached reconcile disposition — never calls reconcile() here.
  let desired: TelemetryBridgeDesiredState | null = null;
  let activationState: BridgeActivationStateRecord | null = null;
  try {
    if (dbAvailable && bridgeStore) {
      activationState = bridgeStore.getActivationState();
      const disposition = cachedReconcile?.disposition ?? "not-written";
      if (activationState) {
        // A metadata-only rebase revision is NOT restore-eligible; the
        // original ADD anchor is retained in the revision history for proof.
        let latestRevisionRestorable: boolean | undefined;
        if (activationState.revisionId !== undefined) {
          const rev = bridgeStore.getRevision(activationState.revisionId);
          latestRevisionRestorable = rev !== null && rev.operation !== "rebase";
        }
        desired = {
          managed: lifecycleState.mode === "managed" && lifecycleState.ownership === "control-plane",
          enabled: activationState.active,
          ...(activationState.targetPath !== undefined ? { targetPath: activationState.targetPath } : {}),
          ...(activationState.sourceKind !== undefined ? { sourceKind: activationState.sourceKind } : {}),
          ...(activationState.port !== undefined ? { port: activationState.port } : {}),
          ...(activationState.nonceFingerprint !== undefined ? { nonceFingerprint: activationState.nonceFingerprint } : {}),
          ...(activationState.configHash !== undefined ? { sourceHash: activationState.configHash } : {}),
          ...(activationState.revisionId !== undefined ? { revisionId: activationState.revisionId } : {}),
          ...(latestRevisionRestorable !== undefined ? { latestRevisionRestorable } : {}),
          ...(activationState.registrationTransport !== undefined ? { registrationTransport: activationState.registrationTransport } : {}),
          stateDisposition: disposition,
        };
      } else {
        desired = {
          managed: lifecycleState.mode === "managed" && lifecycleState.ownership === "control-plane",
          enabled: false,
          stateDisposition: disposition,
        };
      }
    }
  } catch {
    desired = null;
  }

  // ── Source gate ──────────────────────────────────────────────────────
  // Source gate is "proven" for the unique candidate returned by
  // resolveAuthorizedCandidate (via cachedEffectiveState.resolver) or
  // "committed-awaiting-restart" after committed apply/restore when disk still
  // matches the committed hash. Zero/multiple/invalid = blocked/unknown.
  let source: TelemetryBridgeSourceGate | null = null;
  const isCommittedWrite = cachedReconcile?.disposition === "committed" && activationState !== null && activationState.targetPath;

  if (isCommittedWrite && activationState) {
    // Committed apply/restore: read-only hash check of the target path on disk via resolveSourceCandidates.
    const targetPath = activationState.targetPath;
    const realTarget = realpathIfExists(targetPath);
    const { candidates } = resolveSourceCandidates({
      opencodeConfigDir: cfg.opencodeConfigDir,
      projectDirectory: cfg.projectDirectory,
      owlInstallDirectory: cfg.owlInstallDirectory,
      authorizedRoots: cfg.authorizedRoots,
    });
    const candidate = candidates.find((c) => realpathIfExists(c.path) === realTarget);

    if (candidate && activationState.configHash && candidate.hash === activationState.configHash) {
      const matchedRuntime =
        cachedEffectiveState?.resolver.status === "proven" &&
        realpathIfExists(cachedEffectiveState.resolver.candidate.path) === realTarget &&
        cachedEffectiveState.resolver.candidate.hash === candidate.hash;

      source = {
        present: true,
        path: candidate.path,
        format: candidate.format,
        hash: candidate.hash,
        schemaGateMode: matchedRuntime ? "proven" : "committed-awaiting-restart",
        sourceKind: activationState.sourceKind ?? candidate.kind,
        pluginEntries: candidate.pluginEntries.map((e) => ({
          form: e.form,
          identity: e.identity,
          identityKind: e.identityKind,
        })),
      };
    } else if (candidate) {
      // Hash drifted!
      source = {
        present: true,
        path: candidate.path,
        format: candidate.format,
        hash: candidate.hash,
        schemaGateMode: "blocked",
        sourceKind: activationState.sourceKind ?? candidate.kind,
        pluginEntries: [],
      };
    } else {
      source = {
        present: false,
        path: targetPath,
        format: targetPath.endsWith(".jsonc") ? "jsonc" : "json",
        hash: "",
        schemaGateMode: "blocked",
        sourceKind: activationState.sourceKind,
        pluginEntries: [],
      };
    }
  } else if (cachedEffectiveState) {
    const resolver = cachedEffectiveState.resolver;
    if (resolver.status === "proven") {
      const candidate: SourceCandidate = resolver.candidate;
      source = {
        present: true,
        path: candidate.path,
        format: candidate.format,
        hash: candidate.hash,
        schemaGateMode: "proven",
        sourceKind: candidate.kind,
        pluginEntries: candidate.pluginEntries.map((e) => ({
          form: e.form,
          identity: e.identity,
          identityKind: e.identityKind,
        })),
      };
    } else if (provenWriteTarget) {
      // Prior proven target snapshot
      source = {
        present: true,
        path: provenWriteTarget.path,
        format: provenWriteTarget.format,
        hash: provenWriteTarget.hash,
        schemaGateMode: "proven",
        sourceKind: provenWriteTarget.kind,
        pluginEntries: provenWriteTarget.pluginEntries.map((e) => ({
          form: e.form,
          identity: e.identity,
          identityKind: e.identityKind,
        })),
      };
    } else {
      // Blocked — errors present.
      source = {
        present: false,
        path: "",
        format: "json",
        hash: "",
        schemaGateMode: "blocked",
        pluginEntries: [],
      };
    }
  } else {
    // No cached effective state yet — source unknown.
    source = null;
  }

  // ── Effective plugin view (sanitized, from cache) ───────────────────
  // After apply/restore without restart, effective runtime cache remains
  // the old runtime truth while desired committed state reflects the new
  // config. Do not overwrite effective registration with desired.
  let effective: TelemetryBridgeStatusDto["effective"] = null;
  let registration: TelemetryBridgeRegistrationState = "unknown";
  if (cachedEffectiveState) {
    const view = cachedEffectiveState.view;
    if (view.unavailable || view.invalid) {
      effective = {
        available: !view.unavailable,
        invalid: !!view.invalid,
        entries: [],
      };
      registration = "unknown";
    } else {
      effective = {
        available: true,
        invalid: false,
        entries: view.entries.map((e) => ({
          form: e.form,
          effectiveIdentity: e.effectiveIdentity,
          identityKind: e.identityKind,
          ...(e.bridge !== undefined ? {
            bridge: {
              ...(e.bridge.pluginForm !== undefined ? { pluginForm: e.bridge.pluginForm } : {}),
              ...(e.bridge.port !== undefined ? { port: e.bridge.port } : {}),
              registrationTransport: e.bridge.registrationTransport,
              transportMode: e.bridge.transportMode,
              ...(e.bridge.nonceFingerprint !== undefined ? { nonceFingerprint: e.bridge.nonceFingerprint } : {}),
            },
          } : {}),
        })),
      };
      registration = computeRegistrationState(view, cfg.owlInstallDirectory, cfg.authorizedRoots);
    }
  }

  // ── Duplicates ──────────────────────────────────────────────────────
  // Uses canonical equivalence/sanitized effective .bridge entries and
  // proven source entry equivalence from foundation helpers — NOT substring
  // matching. Duplicates in source/effective reported independently.
  let duplicates = { inSource: false, inEffective: false };
  try {
    // Effective duplicates: count sanitized .bridge entries.
    if (cachedEffectiveState) {
      const bridgeEntryCount = cachedEffectiveState.view.entries.filter((e) => e.bridge).length;
      duplicates.inEffective = bridgeEntryCount > 1;
    }
    // Source duplicates: use detectDuplicateBridgeEntries from canonical.
    if (cachedEffectiveState && cachedEffectiveState.resolver.status === "proven") {
      const candidate = cachedEffectiveState.resolver.candidate;
      const identities = candidate.pluginEntries.map((e) => e.identity);
      const dupResult = detectDuplicateBridgeEntries(identities, cfg.owlInstallDirectory, cfg.authorizedRoots);
      duplicates.inSource = dupResult.canonicalCount > 1;
    }
  } catch {
    /* */
  }

  // ── Override ────────────────────────────────────────────────────────
  let override: TelemetryBridgeOverride;
  try {
    override = overrideStatusToDto(overrideStatus);
  } catch {
    override = { present: false, invalid: false, optsOutOfManagement: false };
  }

  // ── Manager lifecycle state ──────────────────────────────────────────
  const managerLifecycle = bridgeManager.getLifecycleState();

  let runtime: TelemetryBridgeRuntimeState = "unavailable";
  let compatibility: TelemetryBridgeCompatibility = "unknown";
  let endpointSource: TelemetryBridgeEndpointSource = "unavailable";
  let endpoint: string | undefined;
  let overrideActive = false;
  let overrideInvalid = false;
  let schemaVersion: number | undefined;
  let bridgePackageVersion: string | undefined;
  let capabilities: TelemetryBridgeCapabilities | undefined;
  let verificationEpoch = 0;
  let omoReady = false;
  let backendConnected = false;
  let error: string | undefined;

  if (managerLifecycle) {
    runtime = managerLifecycle.runtime as TelemetryBridgeRuntimeState;
    compatibility = managerLifecycle.compatibility as TelemetryBridgeCompatibility;
    endpointSource = managerLifecycle.endpointSource as TelemetryBridgeEndpointSource;
    endpoint = managerLifecycle.endpoint;
    overrideActive = managerLifecycle.overrideActive;
    overrideInvalid = managerLifecycle.overrideInvalid;
    schemaVersion = managerLifecycle.schemaVersion;
    bridgePackageVersion = managerLifecycle.bridgePackageVersion;
    capabilities = managerLifecycle.capabilities as TelemetryBridgeCapabilities | undefined;
    verificationEpoch = managerLifecycle.verificationEpoch;
    omoReady = managerLifecycle.omoReady;
    backendConnected = managerLifecycle.backendConnected;
    error = managerLifecycle.error;
  }

  // ── Local package availability ───────────────────────────────────────
  // Bridge package identity lives under the Owl install root, not the
  // target project directory.
  let localPackageAvailable: TelemetryBridgeLocalPackage = "unknown";
  try {
    const bridgeDir = canonicalBridgeDir(cfg.owlInstallDirectory);
    localPackageAvailable = existsSync(bridgeDir);
  } catch {
    localPackageAvailable = "unknown";
  }

  // ── Lifecycle status (normalized, not one boolean) ────────────────────
  const effectiveOverrideActive = override.optsOutOfManagement;
  const effectiveOverrideInvalid = override.invalid;
  const lifecycleStatus = normalizeLifecycleStatus(
    runtime,
    registration,
    lifecycleState,
    effectiveOverrideActive,
    effectiveOverrideInvalid,
    localPackageAvailable,
  );

  // ── Restart required ─────────────────────────────────────────────────
  // Restart is required when the committed desired state differs from the
  // current runtime state. After apply without restart, desired reflects
  // the new config while effective runtime cache remains the old truth.
  // restartRequired expresses this discrepancy.
  // Recovery pending blocks restart.
  let restartRequired = false;
  try {
    if (desired?.stateDisposition === "committed") {
      if (desired.enabled && runtime !== "active") {
        restartRequired = true;
      } else if (!desired.enabled && runtime === "active") {
        restartRequired = true;
      }
    }
  } catch {
    /* */
  }

  // ── Action eligibility ───────────────────────────────────────────────
  const actions = computeActionEligibility(
    lifecycleState,
    effectiveOverrideActive,
    effectiveOverrideInvalid,
    desired,
    runtime,
    registration,
    localPackageAvailable,
    source,
    dbAvailable,
    cachedEffectiveState,
    restartRequired,
  );

  return {
    source,
    effective,
    desired,
    duplicates,
    override,
    registration,
    runtime,
    compatibility,
    localPackageAvailable,
    endpointSource,
    ...(endpoint !== undefined ? { endpoint } : {}),
    overrideActive,
    overrideInvalid,
    ...(schemaVersion !== undefined ? { schemaVersion } : {}),
    ...(bridgePackageVersion !== undefined ? { bridgePackageVersion } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
    verificationEpoch,
    generation: lifecycleState.generation,
    omoReady,
    backendConnected,
    lifecycleStatus,
    mode: lifecycleState.mode,
    ownership: lifecycleState.ownership,
    restartControllable: lifecycleState.mode === "managed" && lifecycleState.ownership === "control-plane",
    ...(lifecycleState.restartKind !== undefined ? { restartKind: lifecycleState.restartKind } : {}),
    restartRequired,
    ...(error !== undefined ? { error } : {}),
    actions,
    updatedAt: Date.now(),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function overrideStatusToDto(status: BridgeOverrideStatus): TelemetryBridgeOverride {
  return {
    present: status.present,
    ...(status.url !== undefined ? { url: status.url } : {}),
    ...(status.port !== undefined ? { port: status.port } : {}),
    invalid: status.invalid,
    ...(status.invalidReason !== undefined ? { invalidReason: status.invalidReason } : {}),
    optsOutOfManagement: status.optsOutOfManagement,
  };
}

function normalizeLifecycleStatus(
  runtime: TelemetryBridgeRuntimeState,
  registration: TelemetryBridgeRegistrationState,
  lifecycleState: OpenCodeLifecycleStateWithRestartKind,
  overrideActive: boolean,
  overrideInvalid: boolean,
  localPackageAvailable: TelemetryBridgeLocalPackage,
): TelemetryBridgeLifecycleStatus {
  if (overrideActive) return "external-unmanaged";
  if (overrideInvalid) return "external-unmanaged";
  if (localPackageAvailable === false) return "not-installed";
  if (registration === "not-registered") return "not-registered";
  if (registration === "registered" || registration === "duplicate") {
    switch (runtime) {
      case "active": return "active";
      case "starting": return "loading";
      case "failed": return "failed";
      case "stale": return "stale";
      case "mismatch": return "incompatible";
      case "inactive": return "registered-inactive";
      case "unavailable": return "registered-inactive";
    }
  }
  if (localPackageAvailable === true) return "available-locally";
  return "stale";
}

function computeActionEligibility(
  lifecycleState: OpenCodeLifecycleStateWithRestartKind,
  overrideActive: boolean,
  overrideInvalid: boolean,
  desired: TelemetryBridgeDesiredState | null,
  runtime: TelemetryBridgeRuntimeState,
  registration: TelemetryBridgeRegistrationState,
  localPackageAvailable: TelemetryBridgeLocalPackage,
  source: TelemetryBridgeSourceGate | null,
  dbAvailable: boolean,
  cachedEffectiveState: CachedEffectiveState | undefined,
  restartRequired: boolean,
): TelemetryBridgeActionEligibility {
  const reasons: string[] = [];
  const isManaged = lifecycleState.mode === "managed" && lifecycleState.ownership === "control-plane";
  const isConnected = lifecycleState.status === "connected";
  const sourceProven = source?.schemaGateMode === "proven" || source?.schemaGateMode === "committed-awaiting-restart";

  if (overrideActive) reasons.push("override-active");
  if (overrideInvalid) reasons.push("override-invalid");
  if (!isManaged) reasons.push("not-managed-control-plane");
  if (!isConnected && lifecycleState.status !== "failed") reasons.push("lifecycle-not-connected");
  if (!dbAvailable) reasons.push("bridge-db-unavailable");
  if (localPackageAvailable !== true) reasons.push("local-package-unavailable");
  if (!sourceProven) reasons.push("source-not-proven");
  if (!cachedEffectiveState && !sourceProven) reasons.push("effective-state-not-cached");
  if (desired?.stateDisposition === "recovery-pending") reasons.push("recovery-pending");
  // Restore requires a restorable latest revision: a metadata-only rebase
  // (or an unknown revision) is never restore-eligible.
  const latestRestorable = desired?.latestRevisionRestorable === true;
  if (!latestRestorable) reasons.push("latest-revision-not-restorable");

  // canRegister: local package available, source proven, effective
  // registration not-registered, lifecycle managed+control-plane+connected,
  // DB/service available, no override/conflict.
  const canRegister =
    isManaged && isConnected && !overrideActive && !overrideInvalid &&
    dbAvailable && localPackageAvailable === true && source?.schemaGateMode === "proven" &&
    registration === "not-registered" && cachedEffectiveState !== undefined;

  // canRemove: only one canonical registration/desired enabled (duplicates
  // warn and block auto-remove).
  const canRemove =
    isManaged && isConnected && !overrideActive && !overrideInvalid &&
    dbAvailable && source?.schemaGateMode === "proven" &&
    registration === "registered" && desired?.enabled === true;

  // canRestart: must explicitly require restartRequired === true, committed disposition,
  // exact Managed+control-plane ownership, no override/conflict, DB/service available,
  // and lifecycle connected or explicit failed-owned recovery.
  const canRestart =
    isManaged &&
    !overrideActive &&
    !overrideInvalid &&
    dbAvailable &&
    restartRequired === true &&
    desired?.stateDisposition === "committed" &&
    (isConnected || (lifecycleState.status === "failed" && lifecycleState.ownership === "control-plane"));

  const canProbe = false;

  return {
    canRegister,
    canRemove,
    canRestore:
      isManaged && !overrideActive && !overrideInvalid && dbAvailable && latestRestorable,
    canRestart,
    canProbe,
    reasons,
  };
}

/**
 * Compute the registration state from a sanitized EffectivePluginView.
 * Detects not-registered/registered/duplicate/unknown.
 * Both opencode.json/jsonc may exist; unique effective sequence match.
 * `owlInstallRoot`/`authorizedRoots` are accepted for identity-model
 * symmetry with the other composition helpers.
 */
export function computeRegistrationState(
  effectiveView: EffectivePluginView | null,
  owlInstallRoot: string,
  authorizedRoots: string[],
): TelemetryBridgeRegistrationState {
  void owlInstallRoot;
  void authorizedRoots;
  if (!effectiveView || effectiveView.unavailable) return "unknown";
  if (effectiveView.invalid) return "unknown";

  // Count sanitized .bridge entries (canonical equivalence from extractor).
  let bridgeCount = 0;
  for (const entry of effectiveView.entries) {
    if (entry.bridge) {
      bridgeCount++;
    }
  }

  if (bridgeCount === 0) return "not-registered";
  if (bridgeCount > 1) return "duplicate";
  return "registered";
}

/**
 * Sanitized SSE bridge status event payload. Carries only summarized
 * lifecycle/registration/runtime/generation/epoch/capability availability.
 * No diff, raw config, nonce, endpoint credentials, environment, source
 * path/hash, fingerprint, or revision details.
 */
export function sanitizeBridgeStatusForSse(
  status: TelemetryBridgeStatusDto,
): TelemetryBridgeStatusSummary {
  return {
    runtime: status.runtime,
    registration: status.registration,
    compatibility: status.compatibility,
    lifecycleStatus: status.lifecycleStatus,
    generation: status.generation,
    verificationEpoch: status.verificationEpoch,
    omoReady: status.omoReady,
    backendConnected: status.backendConnected,
    overrideActive: status.overrideActive,
    overrideInvalid: status.overrideInvalid,
    restartRequired: status.restartRequired,
    ...(status.capabilities !== undefined ? { capabilities: status.capabilities } : {}),
    ...(status.schemaVersion !== undefined ? { schemaVersion: status.schemaVersion } : {}),
    ...(status.bridgePackageVersion !== undefined ? { bridgePackageVersion: status.bridgePackageVersion } : {}),
    endpointSource: status.endpointSource,
    localPackageAvailable: status.localPackageAvailable,
    updatedAt: status.updatedAt,
  };
}

/**
 * Resolve the unique source candidate from a cached effective state.
 * Returns the proven SourceCandidate or null when blocked/absent.
 */
export function getProvenSourceCandidate(
  cachedEffectiveState: CachedEffectiveState | undefined,
): SourceCandidate | null {
  if (!cachedEffectiveState) return null;
  if (cachedEffectiveState.resolver.status === "proven") {
    return cachedEffectiveState.resolver.candidate;
  }
  return null;
}