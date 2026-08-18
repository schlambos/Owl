import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type {
  ConfigMutation,
  ControlPlaneEvent,
  ModelAvailabilityDetail,
  ModelProbeRun,
  ModelUsageReference,
  OpenCodeLifecycleState,
  TelemetryBridgeStatusDto,
} from "@omo/shared";
import { loadServerConfig, assertAuthorizedPath } from "./config";
import { loadOmoConfig } from "./omo/loader";
import {
  buildAgentsDto,
  buildOverview,
  buildSessionsDto,
} from "./domain/join";
import { RuntimeStore } from "./runtime/store";
import { SessionDetailService } from "./session/detail";
import {
  applyMutation,
  restoreRevision,
  simulateMutation,
} from "./cfgwrite/mutate";
import { ensureRecoveredOmoScope } from "./cfgwrite/transaction";
import {
  defaultRevisionDbPath,
  RevisionStore,
} from "./cfgwrite/revisions";
import { resolveWriteTarget } from "./cfgwrite/paths";
import { hashContent } from "./cfgwrite/jsonc-edit";
import { buildCapabilityInventory } from "./omo/capabilities";
import {
  applyPromptFileMutation,
  resolvePromptComposition,
  simulatePromptFileMutation,
} from "./cfgwrite/prompts";
import {
  buildPresetInventory,
  comparePresets,
  createPreset,
  deletePreset,
  renamePreset,
  runtimeSwitchImpact,
  setConfiguredPreset,
} from "./cfgwrite/presets";
import { applyGlobal, simulateGlobal, type GlobalMutation } from "./cfgwrite/globals";
import { handleInterviewConfigRoutes } from "./cfgwrite/interview-routes";
import { handleRawConfigRoutes } from "./cfgwrite/raw-routes";
import { createSourceWatcher } from "./cfgwrite/source-watcher";
import {
  applyCouncil,
  buildCouncilInventory,
  simulateCouncil,
  type CouncilMutation,
} from "./cfgwrite/council";
import {
  applyAcp,
  buildAcpInventory,
  getRawAcpAgent,
  simulateAcp,
  type AcpMutation,
} from "./cfgwrite/acp";
import { probeAcp } from "./acp/probe";
import { DoctorEngine } from "./doctor/engine";
import type { DoctorInput } from "./doctor/input";
import { TELEMETRY_ERROR_WINDOW_MS } from "./doctor/rules-groups";
import { OmoBridgeClient } from "./omo-runtime/bridge";
import { OmoRuntimeStore } from "./omo-runtime/store";
import { TelemetryBridgeManager } from "./omo-runtime/manager";
import type { OmoRuntimeUpdatedEvent, OmoBridgeManagerInput } from "./omo-runtime/types";
import { OPTION_CATALOG } from "./omo/catalog";
import {
  getInstalledSchemaDocument,
  getOmoSchemaStatus,
  schemaContextFor,
  validateCandidateText,
} from "./omo-schema/validator";
import { buildCompanionState } from "./omo/companion";
import { buildInterviewState } from "./omo/interview";
import { fingerprintAuthorizedSource } from "./omo-schema/fingerprint";
import { buildMultiplexerSystem, resolveDetection } from "./omo/multiplexer";
import { StaticCommandRunner } from "./omo/multiplexer-commands";
import { buildMultiplexerRuntime } from "./omo-runtime/multiplexer-runtime";
import {
  defaultProbeDbPath,
  ModelProbeStore,
} from "./models/probe-store";
import {
  ModelProbeEngine,
  type OpenCodeProbeGateway,
} from "./models/probe-engine";
import { ModelProbeQueue } from "./models/probe-queue";
import { buildModelUsage } from "./models/usage";
import {
  buildModelInventory,
  buildModelInventoryDetail,
  type ModelInventorySources,
} from "./models/inventory";
import { handleModelRequest, type ModelRouteDeps } from "./models/routes";
import {
  OpenCodeLifecycleManager,
  computeBridgeReconciliationClean,
  bridgeReconcileDispositionAfterExternalEdit,
} from "./opencode/lifecycle";
import {
  handleBridgeDriftRoute,
  isDriftRoutePath,
} from "./opencode-bridge/drift-route";
import { sanitizeOpenCodeError } from "./opencode/security";
import { handleReleaseWeb } from "./release-web";
import { handleInternalShutdown } from "./internal-shutdown";
// ── Slice 17: bridge composition imports ──────────────────────────────
import {
  BridgeRevisionStore,
  defaultBridgeRevisionDbPath,
} from "./opencode-bridge/revisions-bridge";
import { BridgeService } from "./opencode-bridge/service";
import { createBridgeWatcher, type BridgeWatcher } from "./opencode-bridge/watcher";
import { validateBridgeOverride } from "./opencode-bridge/override";
import { canonicalBridgeDir } from "./opencode-bridge/canonical";
import { resolveAuthorizedCandidate } from "./opencode-bridge/resolver";
import type { SourceCandidate } from "./opencode-bridge/types";
import {
  composeBridgeStatus,
  computeRegistrationState,
  sanitizeBridgeStatusForSse,
  storePreviewConfirmation,
  consumePreviewConfirmation,
  invalidateProvenTargetOnExternalEdit,
  type CachedEffectiveState,
  type CachedReconcileDisposition,
} from "./opencode-bridge/status";

const cfg = loadServerConfig();
// The SDK inherits process.env. Materialize only the active config-dir
// selector; do not reconstruct provider/auth environment variables.
process.env.OPENCODE_CONFIG_DIR = cfg.opencodeConfigDir;
// Managed mode: the installed SDK has no cwd option and inherits
// process.cwd(), so adopt the target project as this process's cwd
// BEFORE any stores, services, lifecycle, or SDK construction. There is
// deliberately no fixed-project cwd requirement anymore — the project
// root comes from config (OMO_CP_PROJECT_DIR or the startup cwd). Attach
// mode attaches to an external process and must not chdir.
if (cfg.opencodeMode === "managed") {
  process.chdir(cfg.projectDirectory);
}

// ── Slice 17: Bridge composition (startup order/ownership) ────────────
// 1. Create long-lived BridgeRevisionStore inside repository data dir with
//    authorized roots. Composition root owns and closes it only after
//    lifecycle.stop. DB construction failure → fail closed cleanly: store
//    and service are undefined; lifecycle starts without managed bridge
//    injection; derived telemetry still works. All bridge mutation/restart
//    routes return stable bridge-state-unavailable.
let bridgeRevisionDbOk = true;
let bridgeRevisions: BridgeRevisionStore | undefined;
let bridgeService: BridgeService | undefined;
try {
  bridgeRevisions = new BridgeRevisionStore(
    defaultBridgeRevisionDbPath(cfg.projectDirectory),
    cfg.authorizedRoots,
  );
} catch (e) {
  bridgeRevisionDbOk = false;
  const msg = e instanceof Error ? e.message : String(e);
  console.error("[omo-cp] bridge revision DB construction failed: %s", sanitizeOpenCodeError(msg));
  bridgeRevisions = undefined;
}

// 2. Create BridgeService with trusted effectiveViewProvider using the
//    CURRENT canonical OpenCodeClient only. Only when DB is available.
if (bridgeRevisionDbOk && bridgeRevisions) {
  bridgeService = new BridgeService({
    opencodeConfigDir: cfg.opencodeConfigDir,
    projectDirectory: cfg.projectDirectory,
    owlInstallDirectory: cfg.owlInstallDirectory,
    authorizedRoots: cfg.authorizedRoots,
    revisions: bridgeRevisions,
    effectiveViewProvider: async () => {
      // Uses the CURRENT canonical OpenCodeClient only — no second runtime.
      // Bridge identity in the effective view derives from the Owl install
      // root, which may differ from the target project directory.
      const client = runtime.getClient();
      return client.effectivePluginView({ owlInstallDirectory: cfg.owlInstallDirectory });
    },
  });
}

// 3. Run service.reconcile before any owned OpenCode start (startup only).
//    Cache the disposition/errors for pure status composition later.
let bridgeReconcileDisposition: CachedReconcileDisposition = { disposition: "not-written", errors: [] };
if (bridgeRevisionDbOk && bridgeService) {
  try {
    const result = bridgeService.reconcile();
    bridgeReconcileDisposition = { disposition: result.disposition, errors: result.errors };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    bridgeReconcileDisposition = { disposition: "recovery-pending", errors: [{ code: "state-recovery-pending", message: sanitizeOpenCodeError(msg) }] };
  }
}

// 4. Construct lifecycle with bridge store, reconciliation-clean hook,
//    passive port occupancy check. No second runtime. When DB is unavailable,
//    lifecycle starts without managed bridge injection.
const lifecycle = new OpenCodeLifecycleManager(cfg, {
  bridge: {
    ...(bridgeRevisions !== undefined ? { store: bridgeRevisions } : {}),
    isReconciliationClean: () => {
      if (!bridgeRevisions) return true; // no bridge → assumed clean
      // Align with the cached reconcile disposition: recovery-pending (and,
      // via unresolved/conflict intents, conflict/drift) blocks repeated SDK
      // starts as well as the launch boundary. Logic lives in the tested
      // computeBridgeReconciliationClean helper — this closure only wires it.
      return computeBridgeReconciliationClean({
        cachedDisposition: bridgeReconcileDisposition.disposition,
        hasUnresolvedOrConflictIntents: () =>
          bridgeRevisions.hasUnresolvedOrConflictIntents(),
      });
    },
  },
});
const runtime = new RuntimeStore(cfg.projectDirectory, cfg.authorizedRoots);
const sessionDetails = new SessionDetailService(runtime);
runtime.onEventReason = (reason) => sessionDetails.onRuntimeEvent(reason);
runtime.start();

// ── Slice 17: TelemetryBridgeManager (canonical bridge source) ──────
// TelemetryBridgeManager is canonical. A valid explicit override is fed to
// manager observation and opts out of management. Multiplexer uses
// manager.getBridgeStatus(). OmoRuntimeStore receives bridgeManager and
// does not piggyback direct fetch.
const bridgeManager = new TelemetryBridgeManager();

// Legacy OmoBridgeClient remains for configurations without a manager.
// When bridgeManager is wired, OmoRuntimeStore uses the manager as bridge
// authority and skips the old piggyback OmoBridgeClient.fetchTelemetry().
const omoBridge = new OmoBridgeClient(cfg.omoBridgeBaseUrl);
const omoStore = new OmoRuntimeStore({
  getClient: () => runtime.getClient(),
  bridge: omoBridge,
  bridgeManager,
});
// Keep telemetry fresh enough to emit omo-runtime.updated on /api/events:
// piggyback on runtime activity; the store memoizes to a 3s min interval
// and tolerates per-session fetch failures.
runtime.subscribe((evt) => {
  if (
    evt.type === "runtime.updated" ||
    evt.type === "connection" ||
    evt.type === "snapshot"
  ) {
    void omoStore.refresh(runtime.getSnapshot()).catch(() => {});
  }
});

// ── Doctor engine (read-only diagnostics) ──────────────────────
function omoManifestVersion(): string | undefined {
  try {
    const p = join(cfg.opencodeConfigDir, ".oh-my-opencode-slim", "skills-manifest.json");
    assertAuthorizedPath(p, cfg.authorizedRoots);
    if (!existsSync(p)) return undefined;
    const j = JSON.parse(readFileSync(p, "utf-8")) as {
      skills?: Record<string, { packageVersion?: string }>;
    };
    return Object.values(j.skills ?? {})[0]?.packageVersion;
  } catch {
    return undefined;
  }
}

const doctor = new DoctorEngine((): DoctorInput => {
  const live = runtime.getSnapshot();
  const rt = runtime.getRuntimeState();
  let omo: ReturnType<typeof loadOmoSafe> | undefined;
  let loadError: string | undefined;
  try {
    omo = loadOmoSafe();
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
  }

  let capabilities: DoctorInput["capabilities"];
  let council: DoctorInput["council"];
  let acp: DoctorInput["acp"];
  let companion: DoctorInput["companion"];
  let interview: DoctorInput["interview"];
  let omoTelemetry: DoctorInput["omoTelemetry"];
  const lifecycleState = lifecycle.getState();
  const lifecycleReady = lifecycleState.status === "connected";
  if (omo) {
    try {
      if (lifecycleReady) {
        capabilities = buildCapabilityInventory({
          provenance: omo.provenance,
          skillNames: [],
          mcpRuntime: rt.mcp,
        });
      }
    } catch {
      /* inventory failure shouldn't fail doctor */
    }
    try {
      council = buildCouncilInventory(cfg);
    } catch {
      /* */
    }
    try {
      acp = buildAcpInventory(cfg, rt.agents.map((a) => a.name), true);
    } catch {
      /* */
    }
    try {
      companion = buildCompanionState(
        omo.provenance,
        cfg.projectDirectory,
        cfg.authorizedRoots,
      );
    } catch {
      /* */
    }
    try {
      interview = buildInterviewState(
        omo.provenance,
        cfg.projectDirectory,
        cfg.authorizedRoots,
        process.env,
        { cfg },
      );
    } catch {
      /* */
    }
  }

  // OMO runtime telemetry summary — fire-and-forget refresh + cached read.
  // Independent try/catch: telemetry failure must never fail the doctor.
  try {
    if (!lifecycleReady) throw new Error("OpenCode lifecycle not ready");
    void omoStore.refresh(runtime.getSnapshot()).catch(() => {});
    const omoSnap = omoStore.getSnapshot();
    const nowMs = Date.now();
    const orphans = omoStore.getOrphanInfo();
    const orphanMissingSince: Record<string, number> = {};
    for (const o of orphans) {
      if (o.missingSince !== undefined) orphanMissingSince[o.taskId] = o.missingSince;
    }
    omoTelemetry = {
      // Slice 17: bridgeConfigured reflects manager endpoint derivation
      // (not just the legacy direct client). Deep bridge disconnected is
      // distinct from derived OMO telemetry.
      bridgeConfigured: bridgeManager.getEndpoint() !== undefined,
      bridgeConnected: omoSnap.bridge?.connected ?? false,
      bridgeSchema: omoSnap.bridge?.schemaVersion,
      jobCount: omoSnap.jobs.length,
      orphanJobs: orphans.map((o) => o.taskId),
      orphanMissingSince,
      timedOutJobs: omoSnap.jobs
        .filter((j) => j.timedOut === true)
        .map((j) => j.taskId),
      recentErrors: omoSnap.jobs
        .filter(
          (j) =>
            j.state === "error" &&
            j.completedAt !== undefined &&
            nowMs - j.completedAt <= TELEMETRY_ERROR_WINDOW_MS,
        )
        .map((j) => j.taskId),
      stale: omoSnap.stale,
    };
  } catch {
    /* telemetry provider failure → rules stay silent */
  }

  // Model inventory (Slice 15, Lane 2) — read-only composition from the
  // runtime snapshot + probe store + config inventories. NO OpenCode HTTP
  // calls beyond what this closure already makes (authMethods intentionally
  // omitted → {}), NO probe invocation. Independent try/catch: inventory
  // failure never fails the doctor.
  let modelInventory: DoctorInput["modelInventory"];
  try {
    if (!lifecycleReady) throw new Error("OpenCode lifecycle not ready");
    const connected =
      runtime.getClient().getProviderAuthority()?.connected ??
      live.providers.filter((p) => p.connected).map((p) => p.id);
    const probeLatest = probeStore.latestByModel();
    for (const [k, v] of probeStore.getOverlay()) probeLatest.set(k, v);
    const inv = buildModelInventory({
      providers: live.providers,
      connected,
      authMethods: {},
      usage: buildModelUsageSafe(),
      probeLatest,
      queue: probeQueue.snapshot(),
      providerProbeStats: probeStore.recentCountsByProvider(),
    });
    modelInventory = {
      probeStoreAvailable: probeStore.isHealthy(),
      models: inv.models,
      providers: inv.providers,
    };
  } catch {
    /* model inventory composition failure → model rules stay silent */
  }

  // Multiplexer subsystem summary (Slice 16) — read-only composition from
  // cached provenance + cached bridge/OMO runtime. NO OpenCode HTTP calls,
  // no mux queries, no command execution. Independent try/catch: multiplexer
  // failure never fails the doctor.
  let multiplexerInput: DoctorInput["multiplexer"];
  try {
    if (omo) {
      const configured = omo.provenance.rawMerged.multiplexer as
        | Record<string, unknown>
        | undefined;
      const configuredType =
        typeof configured?.type === "string" ? configured.type : "none";
      const effectiveType =
        typeof configured?.type === "string" ? configured.type : "none";
      const detected = resolveDetection(process.env);
      const legacyTmuxPresent = Object.prototype.hasOwnProperty.call(
        omo.provenance.rawMerged,
        "tmux",
      );
      const omoSnap = omoStore.getSnapshot();
      // Slice 17: Multiplexer uses manager.getBridgeStatus() (canonical).
      const bridgeStatus = bridgeManager.getBridgeStatus();
      const muxRuntime = buildMultiplexerRuntime(
        bridgeStatus,
        omoSnap,
        Date.now(),
      );
      // Explicit backend command missing: probe via static command -v only
      // (synchronous — doctor provider must stay sync).
      let explicitBackendCommandMissing = false;
      if (effectiveType !== "auto" && effectiveType !== "none") {
        const cmdMap: Record<string, string> = {
          tmux: "tmux",
          zellij: "zellij",
          herdr: "herdr",
          kitty: "kitty",
          cmux: "cmux",
        };
        const cmd = cmdMap[effectiveType];
        if (cmd) {
          try {
            const result = Bun.spawnSync({
              cmd: ["command", "-v", cmd],
              stdout: "pipe",
              stderr: "pipe",
            });
            explicitBackendCommandMissing = result.exitCode !== 0;
          } catch {
            explicitBackendCommandMissing = true;
          }
        }
      }
      const graceApplied = muxRuntime.mapping.graceAppliedMs !== undefined;
      const unmappedJobsAfterGrace = graceApplied
        ? muxRuntime.mapping.unmappedJobs
        : [];
      multiplexerInput = {
        configuredType,
        effectiveType,
        detectedType: detected.resolvedType,
        legacyTmuxPresent,
        explicitBackendCommandMissing,
        runtimeUnavailable: muxRuntime.mapping.unavailable,
        runtimeStale: muxRuntime.mapping.stale,
        unmappedJobsAfterGrace,
        graceApplied,
      };
    }
  } catch {
    /* multiplexer composition failure → multiplexer rules stay silent */
  }

  let revList: ReturnType<RevisionStore["list"]> = [];
  try {
    revList = revisionDbOk ? revisions.list(1) : [];
  } catch {
    revisionDbOk = false;
  }

  // Installed-schema surface (read-only). The revision audit is capped at
  // the latest 50 revisions and runs only during Doctor evaluation — lazy,
  // no revision mutation.
  let schemaInput: DoctorInput["schema"];
  try {
    const status = getOmoSchemaStatus(cfg);
    let revisionsScanned = 0;
    let revisionsIncompatible = 0;
    if (status.available && revisionDbOk) {
      const ctx = schemaContextFor(cfg);
      for (const rev of revisions.list(50)) {
        revisionsScanned++;
        if (!validateCandidateText(rev.afterContent, ctx).ok) {
          revisionsIncompatible++;
        }
      }
    }
    schemaInput = { status, revisionsScanned, revisionsIncompatible };
  } catch {
    /* schema status failure → schema rules stay silent */
  }

  return {
    generatedAt: new Date().toISOString(),
    cp: {
      revisionDbOk,
      runtimeStoreStarted: true,
      configGeneration: configWatchGeneration,
      host: cfg.host,
    },
    lifecycle: lifecycleState,
    connection: rt.connection,
    health: live.health,
    agents: rt.agents,
    providers: rt.providers,
    sessions: rt.sessions.flat,
    permissions: rt.permissions,
    mcp: rt.mcp,
    config: {
      loadOk: !!omo,
      loadError,
    },
    provenance: omo?.provenance,
    ...(schemaInput ? { schema: schemaInput } : {}),
    capabilities,
    council,
    acp,
    companion,
    interview,
    environment: {
      OPENCODE_CONFIG_DIR_SET: !!process.env.OPENCODE_CONFIG_DIR,
      OH_MY_OPENCODE_SLIM_PRESET: process.env.OH_MY_OPENCODE_SLIM_PRESET,
      OH_MY_OPENCODE_SLIM_DISABLE: process.env.OH_MY_OPENCODE_SLIM_DISABLE,
      OPENCODE_BASE_URL_SET: cfg.opencodeMode === "attach",
      OMO_CP_HOST: cfg.host,
    },
    packageHint: readPackageHint(),
    omoManifestVersion: omoManifestVersion(),
    omoTelemetry,
    ...(modelInventory ? { modelInventory } : {}),
    ...(multiplexerInput ? { multiplexer: multiplexerInput } : {}),
    // Slice 17: sanitized bridge lifecycle/status DTO.
    ...(bridgeRevisionDbOk ? {
      bridgeStatus: composeBridgeStatus({
        cfg,
        bridgeStore: bridgeRevisions,
        bridgeService,
        bridgeManager,
        lifecycleState: lifecycle.getStateWithRestartKind(),
        overrideStatus: cfg.omoBridgeOverride ?? validateBridgeOverride(undefined),
        cachedEffectiveState,
        cachedReconcile: bridgeReconcileDisposition,
      }),
    } : {}),
    revisions: {
      reachable: revisionDbOk,
      count: revisionDbOk ? revisions.list(100).length : undefined,
      lastRevisionAt: revList[0]?.timestamp,
      conflictScopes: revisionDbOk ? revisions.listConflictScopes(cfg) : [],
    },
  };
});

// ── Model inventory & probing (Slice 15, Lane 1) ─────────────
// Probe store (shares data/control-plane.db with RevisionStore). Abandoned
// `running` rows are reconciled BEFORE the queue is constructed so no stale
// job can ever be accepted.
let probeStore: ModelProbeStore;
try {
  probeStore = new ModelProbeStore(defaultProbeDbPath(cfg.projectDirectory));
} catch (e) {
  // Belt-and-suspenders: constructor falls back to in-memory on file-open
  // failure; this covers a total construction failure.
  console.error("[models] probe store construction failed: %s", e);
  probeStore = new ModelProbeStore(":memory:");
}
probeStore.finalizeAbandonedRuns();

// Engine gateway: adapts the Lane-0 OpenCodeClient probe primitives plus
// read-only authority/catalog lookups from the runtime store.
const probeGateway: OpenCodeProbeGateway = {
  isProviderConnected(providerId) {
    const authority = runtime.getClient().getProviderAuthority();
    if (authority) return authority.connected.includes(providerId);
    return (
      runtime.getSnapshot().providers.find((p) => p.id === providerId)
        ?.connected ?? false
    );
  },
  isModelAdvertised(providerId, modelId) {
    return runtime
      .getSnapshot()
      .providers.some(
        (p) => p.id === providerId && p.models.some((m) => m.id === modelId),
      );
  },
  opencodeVersion() {
    return runtime.getSnapshot().health.version;
  },
  createProbeSession(opts) {
    return runtime.getClient().createProbeSession(opts);
  },
  promptProbe(opts) {
    return runtime.getClient().promptProbe(opts);
  },
  abortSession(sessionId, directory) {
    return runtime.getClient().abortSession(sessionId, directory);
  },
  deleteSession(sessionId, directory) {
    return runtime.getClient().deleteSession(sessionId, directory);
  },
};

const probeEngine = new ModelProbeEngine({
  gateway: probeGateway,
  store: probeStore,
});

const probeQueue = new ModelProbeQueue({
  engine: probeEngine,
  store: probeStore,
  isRestConnected: () => runtime.getConnection().rest === "connected",
});

let activatedBackendGeneration = 0;
let handlingLifecycle = Promise.resolve();
let backendMarkedUnavailable = false;

function broadcastLifecycleState(state: OpenCodeLifecycleState): void {
  const at = new Date().toISOString();
  for (const listener of runtime.listeners) {
    try {
      listener({ type: "opencode.lifecycle.updated", lifecycle: state, at });
    } catch {
      /* per-listener isolation */
    }
  }
}

lifecycle.subscribe((state) => {
  broadcastLifecycleState(state);
  doctor.invalidate();
  if (state.status !== "connected") {
    if (activatedBackendGeneration > 0 && !backendMarkedUnavailable) {
      backendMarkedUnavailable = true;
      runtime.deactivateBackend(`lifecycle:${state.status}`);
      sessionDetails.resetForBackendGeneration();
      omoStore.resetForBackendGeneration();
      probeQueue.interruptForBackendChange();
    }
    return;
  }
  backendMarkedUnavailable = false;
  if (state.generation === activatedBackendGeneration) return;
  activatedBackendGeneration = state.generation;
  handlingLifecycle = handlingLifecycle.then(async () => {
    sessionDetails.resetForBackendGeneration();
    omoStore.resetForBackendGeneration();
    probeQueue.interruptForBackendChange();
    await runtime.activateBackend(state);
    if (runtime.getConnection().rest !== "connected") {
      activatedBackendGeneration = 0;
      await lifecycle.backendLost(
        runtime.getConnection().restError ?? "Runtime bootstrap failed",
      );
      return;
    }
    lifecycle.updateRuntimeConnection(runtime.getConnection());
    const at = new Date().toISOString();
    for (const listener of runtime.listeners) {
      try {
        listener({
          type: "opencode.backend.generation",
          generation: state.generation,
          baseUrl: state.baseUrl!,
          ownership: state.ownership,
          at,
        });
      } catch {
        /* per-listener isolation */
      }
    }
  }).catch((error) => {
    activatedBackendGeneration = 0;
    void lifecycle.backendLost(error);
  });
});

runtime.onBackendLost = (reason) => {
  lifecycle.scheduleBackendLossCheck(reason);
};
runtime.onConnectionChange = (connection) => {
  lifecycle.updateRuntimeConnection(connection);
};

// ── Slice 17: Bridge watcher + effective-state cache + manager feeding ──
// Watcher: create parent-directory watcher(s) using existing BridgeWatcher.
// External edits invalidate preview/effective status and trigger
// manager/status refresh only; self writes suppressed; no reload/restart/
// write. Re-arm/error behavior remains foundation-owned. Close on shutdown.
const bridgeWatchers: BridgeWatcher[] = [];
let bridgeWatcherGeneration = 0;

function createBridgeWatchers(): void {
  const watchDirs = new Set<string>();
  try { watchDirs.add(cfg.opencodeConfigDir); } catch { /* */ }
  try { watchDirs.add(cfg.projectDirectory); } catch { /* */ }
  for (const dir of watchDirs) {
    try {
      const watcher = createBridgeWatcher({ directory: dir, debounceMs: 300 });
      watcher.onEvent((event) => {
        // A `removed` event for a watched config directory is treated exactly
        // like external drift (the committed target may be gone).
        if (event.kind === "external-edit" || event.kind === "removed") {
          bridgeWatcherGeneration++;
          const invalidated = invalidateProvenTargetOnExternalEdit(cachedEffectiveState);
          provenWriteTarget = invalidated.provenWriteTarget;
          cachedEffectiveState = invalidated.cachedEffectiveState;
          // Phase 2: immediately dirty the reconcile disposition / owned-start
          // gate when an active committed activation exists (fail closed on
          // read errors). The async refresh below must NOT be able to observe
          // a clean gate; only a real reconcile can restore cleanliness.
          if (bridgeRevisions) {
            let hasActiveCommitted = true; // fail closed
            try {
              hasActiveCommitted =
                bridgeRevisions.getActivationState()?.active === true;
            } catch {
              hasActiveCommitted = true;
            }
            const dirtied = bridgeReconcileDispositionAfterExternalEdit({
              hasActiveCommittedState: hasActiveCommitted,
              currentDisposition: bridgeReconcileDisposition.disposition,
            });
            if (dirtied !== undefined) {
              bridgeReconcileDisposition = dirtied;
            }
          }
          // Asynchronously refresh cache THEN manager input/status/Doctor/SSE.
          // No direct stale bridgeManager.update(feed...) before refresh.
          void refreshEffectiveStateAndBroadcast();
        }
        // self-write events are suppressed (no action).
      });
      watcher.start();
      bridgeWatchers.push(watcher);
    } catch {
      /* watch may fail on some FS */
    }
  }
}
createBridgeWatchers();

// Wire the bridge service watcher hook for self-write suppression.
if (bridgeService) {
  bridgeService.setWatcherHook({
    armSelfWrite(intent) {
      for (const w of bridgeWatchers) {
        try { w.armSelfWrite(intent); } catch { /* */ }
      }
    },
  });
}

// ── Sanitized async effective-state cache ───────────────────────────
// When canonical lifecycle is connected, call ONLY
// runtime.getClient().effectivePluginView(), capture lifecycle generation/
// baseUrl, discard result if generation/baseUrl changed, compute
// registration with computeRegistrationState, and resolve source uniquely.
// Refresh after lifecycle connection/generation, watcher external edit,
// and before GET status/preview as appropriate.
// Manager input uses cached registration, not hardcoded unknown.
let cachedEffectiveState: CachedEffectiveState | undefined;
let provenWriteTarget: SourceCandidate | undefined;

async function refreshEffectiveState(): Promise<void> {
  const lifecycleState = lifecycle.getStateWithRestartKind();
  if (lifecycleState.status !== "connected") return;
  const generation = lifecycleState.generation;
  const baseUrl = lifecycleState.baseUrl;
  try {
    const view = await runtime
      .getClient()
      .effectivePluginView({ owlInstallDirectory: cfg.owlInstallDirectory });
    // Discard result if generation/baseUrl changed during async fetch.
    const currentLifecycle = lifecycle.getStateWithRestartKind();
    if (currentLifecycle.generation !== generation || currentLifecycle.baseUrl !== baseUrl) {
      return; // stale — discard
    }
    // Resolve source uniquely using the proven resolver.
    const resolver = resolveAuthorizedCandidate(
      {
        opencodeConfigDir: cfg.opencodeConfigDir,
        projectDirectory: cfg.projectDirectory,
        owlInstallDirectory: cfg.owlInstallDirectory,
        authorizedRoots: cfg.authorizedRoots,
      },
      view,
    );
    if (resolver.status === "proven") {
      provenWriteTarget = resolver.candidate;
    }
    cachedEffectiveState = {
      view,
      generation,
      baseUrl,
      resolver,
    };
  } catch {
    // effectivePluginView failure → leave cache as-is (stale or absent).
  }
}

async function refreshEffectiveStateAndBroadcast(): Promise<void> {
  await refreshEffectiveState();
  // After cache refresh, feed manager and broadcast.
  feedBridgeManagerOnLifecycleChange();
  doctor.invalidate();
  broadcastBridgeStatus();
}

/**
 * Feed the TelemetryBridgeManager with the current lifecycle/committed state.
 * Called on initial lifecycle start and every lifecycle state/generation/
 * config state change. Uses generation/epoch guards for async effective config
 * reads. Start manager only after first update. Manager input uses cached
 * registration, not hardcoded unknown.
 */
function feedBridgeManagerInput(): OmoBridgeManagerInput {
  const lifecycleState = lifecycle.getStateWithRestartKind();
  const committed = bridgeRevisions?.getActivationState();
  const overrideStatus = cfg.omoBridgeOverride ?? validateBridgeOverride(undefined);

  const omoReady = lifecycleState.status === "connected" && lifecycleState.ready.omo;

  let canonicalOrigin: string | undefined;
  if (lifecycleState.baseUrl) {
    try {
      const url = new URL(lifecycleState.baseUrl);
      canonicalOrigin = `${url.protocol}//${url.host}`;
    } catch { /* */ }
  }

  let localPackageAvailable: boolean | "unknown" = "unknown";
  try {
    // Bridge package identity derives from the Owl install root.
    const bridgeDir = canonicalBridgeDir(cfg.owlInstallDirectory);
    localPackageAvailable = existsSync(bridgeDir);
  } catch {
    localPackageAvailable = "unknown";
  }

  const committedActivation = committed
    ? {
        enabled: committed.active,
        ...(committed.port !== undefined ? { port: committed.port } : {}),
        ...(committed.nonceFingerprint !== undefined ? { nonceFingerprint: committed.nonceFingerprint } : {}),
        ...(committed.configHash !== undefined ? { sourceHash: committed.configHash } : {}),
        ...(committed.revisionId !== undefined ? { revisionId: committed.revisionId } : {}),
        ...(committed.registrationTransport !== undefined ? { registrationTransport: committed.registrationTransport } : {}),
      }
    : { enabled: false };

  const overrideUrl = overrideStatus.present && !overrideStatus.invalid ? overrideStatus.url : undefined;
  const overrideInvalid = overrideStatus.present && overrideStatus.invalid;

  // Registration state from cached effective state (not hardcoded unknown).
  let registration: OmoBridgeManagerInput["registration"] = "unknown";
  if (cachedEffectiveState) {
    registration = computeRegistrationState(
      cachedEffectiveState.view,
      cfg.owlInstallDirectory,
      cfg.authorizedRoots,
    );
  }

  return {
    mode: lifecycleState.mode,
    ownership: lifecycleState.ownership,
    generation: lifecycleState.generation,
    ...(canonicalOrigin !== undefined ? { canonicalOrigin } : {}),
    omoReady,
    committed: committedActivation,
    ...(overrideUrl !== undefined ? { overrideUrl } : {}),
    ...(overrideInvalid !== undefined ? { overrideInvalid } : {}),
    localPackageAvailable,
    registration,
  };
}

let bridgeManagerStarted = false;
function feedBridgeManagerOnLifecycleChange(): void {
  try {
    bridgeManager.update(feedBridgeManagerInput());
    if (!bridgeManagerStarted) {
      bridgeManagerStarted = true;
      bridgeManager.start();
    }
  } catch {
    /* manager update failure must not break lifecycle */
  }
}

// Subscribe manager → omoStore.notifyBridgeUpdate + sanitized SSE bridge
// status event. Manager subscribe should NOT recursively trigger status
// composition side effects that re-feed the manager.
bridgeManager.subscribe(() => {
  try { omoStore.notifyBridgeUpdate(); } catch { /* */ }
  doctor.invalidate();
  broadcastBridgeStatus();
});

// Feed manager on lifecycle state changes (mode, ownership, generation, etc).
// Also asynchronously refresh the effective-state cache when generation changes.
lifecycle.subscribe((state) => {
  feedBridgeManagerOnLifecycleChange();
  // Refresh effective state when lifecycle becomes connected or generation changes.
  if (state.status === "connected") {
    void refreshEffectiveState().then(() => {
      // Re-feed manager with updated registration after cache refresh.
      feedBridgeManagerOnLifecycleChange();
    }).catch(() => { /* */ });
  }
});

// Also feed on runtime connection changes (omoReady may change).
runtime.onConnectionChange = (connection) => {
  lifecycle.updateRuntimeConnection(connection);
  feedBridgeManagerOnLifecycleChange();
};

// Broadcast sanitized telemetry-bridge.updated SSE event.
// Fix #10: use TelemetryBridgeStatusSummary, no `as any`.
function broadcastBridgeStatus(): void {
  try {
    const status = composeBridgeStatus({
      cfg,
      bridgeStore: bridgeRevisions,
      bridgeService,
      bridgeManager,
      lifecycleState: lifecycle.getStateWithRestartKind(),
      overrideStatus: cfg.omoBridgeOverride ?? validateBridgeOverride(undefined),
      cachedEffectiveState,
      cachedReconcile: bridgeReconcileDisposition,
    });
    const ssePayload = sanitizeBridgeStatusForSse(status);
    const at = new Date().toISOString();
    for (const listener of runtime.listeners) {
      try {
        listener({ type: "telemetry-bridge.updated", bridge: ssePayload, at });
      } catch {
        /* per-listener isolation */
      }
    }
  } catch {
    /* composition failure must not break SSE */
  }
}

// Selection/startup is asynchronous; RuntimeStore has no independent target.
void lifecycle.start().then(() => {
  // Feed manager on initial lifecycle start + refresh effective state.
  feedBridgeManagerOnLifecycleChange();
  void refreshEffectiveState().then(() => {
    feedBridgeManagerOnLifecycleChange();
  }).catch(() => { /* */ });
}).catch((error) => {
  console.error(
    "[omo-cp] lifecycle start failed: %s",
    sanitizeOpenCodeError(error, [process.env.OPENCODE_SERVER_PASSWORD]),
  );
});

// Queue updates → SSE model-probes.updated + doctor invalidation. The
// doctor recheck stays inference-free: invalidation only recomputes from
// persisted data.
probeQueue.onUpdate((queue) => {
  const at = new Date().toISOString();
  for (const l of runtime.listeners) {
    try {
      l({ type: "model-probes.updated", queue, at });
    } catch {
      /* per-listener isolation */
    }
  }
  try {
    doctor.invalidate();
  } catch {
    /* doctor failure must not affect probing */
  }
});

/** Referenced-model usage map from effective config; soft-fails to empty. */
function buildModelUsageSafe(): Map<string, ModelUsageReference[]> {
  try {
    const omo = loadOmoSafe();
    let council: ReturnType<typeof buildCouncilInventory> | undefined;
    let acp: ReturnType<typeof buildAcpInventory> | undefined;
    try {
      council = buildCouncilInventory(cfg);
    } catch {
      /* council enumeration failure → no council refs */
    }
    try {
      // probe=false: skip ACP command resolution; wrapper/disabled state is
      // pure config and sufficient for usage enumeration.
      acp = buildAcpInventory(cfg, [], false);
    } catch {
      /* acp enumeration failure → no acp refs */
    }
    return buildModelUsage({
      agents: omo.effective.agents,
      ...(council ? { council } : {}),
      ...(acp ? { acp } : {}),
    });
  } catch {
    return new Map();
  }
}

/** Fresh per-request inventory sources (referenced + advertised + history). */
async function collectInventorySources(): Promise<ModelInventorySources> {
  const live = runtime.getSnapshot();
  const connected =
    runtime.getClient().getProviderAuthority()?.connected ??
    live.providers.filter((p) => p.connected).map((p) => p.id);
  // latestByModel() is already overlay-composed; merge defensively anyway.
  const probeLatest = probeStore.latestByModel();
  for (const [k, v] of probeStore.getOverlay()) probeLatest.set(k, v);
  return {
    providers: live.providers,
    connected,
    authMethods: await runtime.getClient().providerAuth(),
    usage: buildModelUsageSafe(),
    probeLatest,
    queue: probeQueue.snapshot(),
    providerProbeStats: probeStore.recentCountsByProvider(),
  };
}

const modelRouteDeps: ModelRouteDeps = {
  async getInventory() {
    return buildModelInventory(await collectInventorySources());
  },
  async getDetail(providerId, modelId): Promise<ModelAvailabilityDetail | undefined> {
    const src = await collectInventorySources();
    return buildModelInventoryDetail(
      src,
      providerId,
      modelId,
      probeStore.historyFor(providerId, modelId),
    );
  },
  getHistory(providerId, modelId, limit): ModelProbeRun[] {
    return probeStore.historyFor(providerId, modelId, limit);
  },
  queue: probeQueue,
  store: probeStore,
};

let revisionDbOk = true;
let revisions: RevisionStore;
try {
  revisions = new RevisionStore(defaultRevisionDbPath(cfg.projectDirectory));
  if (!revisions.available) {
    revisionDbOk = false;
  } else {
    ensureRecoveredOmoScope({ cfg, revisions }, "user");
    ensureRecoveredOmoScope({ cfg, revisions }, "project");
  }
} catch {
  revisionDbOk = false;
  const failing = () => {
    throw new Error("revision DB unavailable");
  };
  revisions = {
    insert: failing,
    list: () => [],
    get: () => null,
    available: false,
    recoverPendingOmo: () => [],
    isScopeWriteBlocked: () => true,
  } as unknown as RevisionStore;
}

/** Notify browser of external config changes */
let configWatchGeneration = 0;
const configWatchers: FSWatcher[] = [];
function watchConfigFiles() {
  const paths = new Set<string>();
  try {
    const u = resolveWriteTarget(cfg, "user");
    if (u.exists) paths.add(u.path);
  } catch {
    /* */
  }
  try {
    const p = resolveWriteTarget(cfg, "project");
    if (p.exists) paths.add(p.path);
  } catch {
    /* */
  }
  for (const p of paths) {
    try {
      const watcher = watch(p, () => {
        configWatchGeneration++;
        const at = new Date().toISOString();
        for (const l of runtime.listeners) {
          try {
            l({
              type: "runtime.updated",
              reason: "config-external-change",
              state: runtime.getRuntimeState(),
              at,
            });
          } catch {
            /* */
          }
        }
      });
      configWatchers.push(watcher);
    } catch {
      /* watch may fail on some FS */
    }
  }
}
watchConfigFiles();

const sourceWatcher = createSourceWatcher({
  cfg,
  emit(event) {
    configWatchGeneration = event.generation;
    const at = event.at;
    for (const l of runtime.listeners) {
      try {
        l(event);
      } catch {
        /* */
      }
    }
    for (const l of runtime.listeners) {
      try {
        l({
          type: "runtime.updated",
          reason: event.ownApply ? "config-own-apply" : "config-external-change",
          state: runtime.getRuntimeState(),
          at,
        });
      } catch {
        /* */
      }
    }
    doctor.invalidate();
  },
});
sourceWatcher.start();

// ── Desktop CORS origin + response security headers ────────────────
// In desktop sidecar mode the allow-origin is pinned to the exact bound
// loopback origin (`http://127.0.0.1:<port>`) instead of `*`. The origin is
// known only after Bun.serve binds the ephemeral port, so it is set below.
let corsAllowOrigin = "*";
function setDesktopCorsOrigin(origin: string): void {
  corsAllowOrigin = origin;
}

/**
 * Baseline response hardening. The theme bootstrap in apps/web/index.html is
 * a single inline <script>; its sha256 is allowlisted (update the hash if
 * that script changes). Styles need 'unsafe-inline' for React inline styles
 * and Monaco-triggered dynamic <style> injection.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; " +
    "script-src 'self' 'sha256-/aN6Hwg9DHoayJ+5tY/jvmOjV7EbbMkp/k2FOpILhmA='; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; " +
    "font-src 'self'; " +
    "connect-src 'self'; " +
    "worker-src 'self' blob:; " +
    "base-uri 'self'; " +
    "form-action 'self'; " +
    "frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/** Stamp security headers onto every response without touching the body. */
function withSecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": corsAllowOrigin,
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": corsAllowOrigin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

/** Installed-schema gate failure → HTTP 422 (distinct from 409 hash conflict / 400 other). */
function isSchemaFailure(r: {
  schemaValidation?: { ok: boolean };
}): boolean {
  return !!r.schemaValidation && !r.schemaValidation.ok;
}

/** Status for mutation-write results: 200 ok / 422 schema / 400 other. */
function writeStatus(r: { ok: boolean } & Parameters<typeof isSchemaFailure>[0]): number {
  return r.ok ? 200 : isSchemaFailure(r) ? 422 : 400;
}

async function readJsonBody<T>(req: Request): Promise<T> {
  return (await req.json()) as T;
}

async function readOptionalJsonBody<T>(req: Request): Promise<T | undefined> {
  const text = await req.text();
  return text.trim() ? (JSON.parse(text) as T) : undefined;
}

function readPackageHint(): string | undefined {
  try {
    const pkgPath = join(cfg.opencodeConfigDir, "package.json");
    assertAuthorizedPath(pkgPath, cfg.authorizedRoots);
    if (!existsSync(pkgPath)) return undefined;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      dependencies?: Record<string, string>;
    };
    const v = pkg.dependencies?.["oh-my-opencode-slim"];
    return v ? `oh-my-opencode-slim@${v}` : undefined;
  } catch {
    return undefined;
  }
}

function loadOmoSafe() {
  return loadOmoConfig({
    opencodeConfigDir: cfg.opencodeConfigDir,
    projectDirectory: cfg.projectDirectory,
    authorizedRoots: cfg.authorizedRoots,
  });
}

/** Control-plane SSE: normalized events only. */
function controlPlaneEventStream(req: Request): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let unsubscribeOmo: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Local superset of the shared ControlPlaneEvent union: the
      // omo-runtime.updated notification (small payload only — the full
      // OmoRuntimeSnapshot is NEVER sent on the stream). packages/shared
      // is intentionally not modified.
      const send = (event: ControlPlaneEvent | OmoRuntimeUpdatedEvent) => {
        if (closed) return;
        try {
          const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        } catch {
          cleanup();
        }
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        unsubscribeOmo?.();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      };

      unsubscribe = runtime.subscribe(send);
      unsubscribeOmo = omoStore.subscribe(send);
      runtime.pushSnapshotTo(send);
      send({
        type: "opencode.lifecycle.updated",
        lifecycle: lifecycle.getState(),
        at: new Date().toISOString(),
      });

      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          cleanup();
        }
      }, 15_000);

      req.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      closed = true;
      unsubscribe?.();
      unsubscribeOmo?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      ...corsHeaders(),
    },
  });
}

export function canonicalBackendUrl(): string | undefined {
  return lifecycle.getState().baseUrl;
}

let serverRef: ReturnType<typeof Bun.serve> | undefined;

async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Drift-acceptance routes are mounted BEFORE the generic OPTIONS/CORS
    // behavior: they enforce their own local-request security (loopback
    // bind + loopback peer, no Origin/sec-fetch metadata, no OPTIONS, no
    // CORS headers, 4KiB bounded bodies).
    if (isDriftRoutePath(url.pathname)) {
      return handleBridgeDriftRoute(req, {
        loopbackBind: ["127.0.0.1", "localhost", "::1"].includes(cfg.host),
        requestAddress: (r: Request): string | undefined =>
          serverRef?.requestIP(r)?.address,
        getService: () =>
          bridgeRevisionDbOk && bridgeService ? bridgeService : undefined,
        overrideActive: () => cfg.omoBridgeOverride?.optsOutOfManagement === true,
        onMetadataCommitted: (result) => {
          // Runs for EVERY metadata-committed outcome (clean commit AND
          // post-commit drift/fault): reconcile, update the cached
          // disposition, invalidate Doctor, broadcast sanitized status.
          // Returns the ACTUAL reconciliation disposition. Never calls
          // refreshEffectiveState / runtime.reconcile / feedBridgeManager /
          // lifecycle or process control.
          void result;
          let disposition: "not-written" | "committed" | "recovery-pending" =
            "recovery-pending";
          try {
            if (bridgeService) {
              const rec = bridgeService.reconcile();
              disposition = rec.disposition;
              bridgeReconcileDisposition = {
                disposition: rec.disposition,
                errors: rec.errors,
              };
            }
          } catch {
            disposition = "recovery-pending";
            bridgeReconcileDisposition = {
              disposition: "recovery-pending",
              errors: [
                {
                  code: "state-recovery-pending",
                  message: "Reconcile failed after drift acceptance.",
                },
              ],
            };
          }
          doctor.invalidate();
          broadcastBridgeStatus();
          return disposition;
        },
      });
    }

    // ── Desktop sidecar shutdown (loopback + per-launch token) ────────
    // Registered only in desktop mode; mounted before OPTIONS/CORS so a
    // preflight can never probe it. See internal-shutdown.ts for the
    // security contract.
    if (cfg.desktop && url.pathname === "/internal/shutdown") {
      return handleInternalShutdown(req, {
        token: cfg.desktop.shutdownToken,
        requestAddress: serverRef?.requestIP(req)?.address,
        onShutdown: () => void shutdown("internal-shutdown"),
      });
    }

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      if (url.pathname === "/api/health") {
        return json({
          ok: true,
          service: "omo-control-plane",
          version: "0.1.0",
          opencodeBaseUrl: canonicalBackendUrl(),
          opencodeConfigDir: cfg.opencodeConfigDir,
          projectDirectory: cfg.projectDirectory,
          connection: runtime.getConnection(),
          lifecycle: lifecycle.getState(),
        });
      }

      if (url.pathname === "/api/opencode/health") {
        const snap = runtime.getSnapshot();
        return json({
          healthy: snap.health.healthy,
          version: snap.health.version,
          error: snap.health.error,
          baseUrl: canonicalBackendUrl(),
          connection: snap.connection,
          lifecycle: lifecycle.getState(),
        });
      }

      if (url.pathname === "/api/opencode/lifecycle" && req.method === "GET") {
        return json(lifecycle.getState());
      }

      if (url.pathname === "/api/opencode/lifecycle/retry" && req.method === "POST") {
        void lifecycle.retry().catch((error) => {
          console.error(
            "[omo-cp] lifecycle retry failed: %s",
            sanitizeOpenCodeError(error, [process.env.OPENCODE_SERVER_PASSWORD]),
          );
        });
        return json({ ok: true, lifecycle: lifecycle.getState() }, 202);
      }

      if (url.pathname === "/api/events") {
        return controlPlaneEventStream(req);
      }

      if (url.pathname === "/api/runtime") {
        return json(runtime.getRuntimeState());
      }

      if (url.pathname === "/api/runtime/reconcile" && req.method === "POST") {
        await runtime.reconcile("manual");
        return json({ ok: true, state: runtime.getRuntimeState() });
      }

      if (url.pathname === "/api/overview") {
        const live = runtime.getSnapshot();
        const omo = loadOmoSafe();
        return json(buildOverview(live, omo, readPackageHint()));
      }

      if (url.pathname === "/api/providers") {
        const live = runtime.getSnapshot();
        return json({
          providers: live.providers,
          connected: live.providers.filter((p) => p.connected).map((p) => p.id),
          connection: live.connection,
          fetchedAt: live.fetchedAt,
        });
      }

      // ── Model inventory & probing (Slice 15, Lane 1) ─────────
      // Registered BEFORE any other matching could occur; returns undefined
      // for non-model paths so the chain below is untouched.
      {
        const modelResponse = await handleModelRequest(req, url, modelRouteDeps);
        if (modelResponse) return modelResponse;
      }

      if (url.pathname === "/api/agents") {
        const live = runtime.getSnapshot();
        const omo = loadOmoSafe();
        return json(buildAgentsDto(live, omo));
      }

      if (url.pathname === "/api/sessions") {
        const includeControlPlaneProbes =
          url.searchParams.get("includeControlPlaneProbes") === "1";
        const live = runtime.getSnapshot({ includeControlPlaneProbes });
        return json({
          ...buildSessionsDto(live, { includeControlPlaneProbes }),
          connection: live.connection,
          fetchedAt: live.fetchedAt,
        });
      }

      // GET /api/sessions/:id — deep inspector payload
      {
        const m = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
        if (m && req.method === "GET") {
          const sessionID = decodeURIComponent(m[1]!);
          const force = url.searchParams.get("force") === "1";
          const omo = loadOmoSafe();
          const detail = await sessionDetails.getDetail(sessionID, {
            omo,
            force,
          });
          return json(detail);
        }
      }

      // GET /api/sessions/:id/messages
      {
        const m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
        if (m && req.method === "GET") {
          const sessionID = decodeURIComponent(m[1]!);
          const omo = loadOmoSafe();
          const detail = await sessionDetails.getDetail(sessionID, {
            omo,
            force: url.searchParams.get("force") === "1",
            includeMessages: true,
            includeDiff: false,
          });
          return json({
            sessionID,
            messages: detail.messages,
            activity: detail.activity,
            initialInstruction: detail.initialInstruction,
            initialInstructionLabel: detail.initialInstructionLabel,
            errors: detail.errors,
            fetchedAt: detail.fetchedAt,
          });
        }
      }

      // GET /api/sessions/:id/diff
      {
        const m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/diff$/);
        if (m && req.method === "GET") {
          const sessionID = decodeURIComponent(m[1]!);
          const detail = await sessionDetails.getDetail(sessionID, {
            force: url.searchParams.get("force") === "1",
            includeMessages: false,
            includeDiff: true,
          });
          return json({
            sessionID,
            diff: detail.diff,
            errors: detail.errors,
            fetchedAt: detail.fetchedAt,
          });
        }
      }

      if (url.pathname === "/api/omo/config") {
        const omo = loadOmoSafe();
        return json({
          userConfigPath: omo.userConfigPath,
          projectConfigPath: omo.projectConfigPath,
          desired: omo.desired,
          effective: {
            preset: omo.effective.preset,
            disabledAgents: omo.effective.disabledAgents,
            agentNames: Object.keys(omo.effective.agents),
            agents: omo.effective.agents,
            warnings: omo.effective.warnings,
            backgroundJobs: omo.effective.backgroundJobs,
            fallback: omo.effective.fallback,
            sources: omo.effective.sources,
            runtimePreset: omo.effective.runtimePreset,
            globals: omo.effective.globals,
          },
        });
      }

      if (url.pathname === "/api/omo/effective") {
        const omo = loadOmoSafe();
        return json({
          preset: omo.provenance.preset,
          filePreset: omo.provenance.filePreset,
          envPreset: omo.provenance.envPreset,
          runtimePreset: omo.provenance.runtimePreset,
          agents: omo.provenance.agents,
          globals: omo.provenance.globals,
          warnings: omo.provenance.warnings,
          sources: omo.provenance.sources,
          propertyCount: Object.keys(omo.provenance.properties).length,
        });
      }

      if (url.pathname === "/api/omo/provenance") {
        const omo = loadOmoSafe();
        const pathQ = url.searchParams.get("path");
        if (pathQ) {
          const prop = omo.provenance.properties[pathQ];
          if (!prop) {
            return json(
              {
                path: pathQ,
                found: false,
                // fuzzy: agent field shortcuts
                suggestions: Object.keys(omo.provenance.properties)
                  .filter((p) => p.includes(pathQ) || pathQ.includes(p))
                  .slice(0, 20),
              },
              404,
            );
          }
          return json({ found: true, property: prop });
        }
        return json({
          sources: omo.provenance.sources,
          properties: omo.provenance.properties,
          warnings: omo.provenance.warnings,
          runtimePreset: omo.provenance.runtimePreset,
          preset: omo.provenance.preset,
        });
      }

      if (url.pathname === "/api/omo/sources") {
        const omo = loadOmoSafe();
        return json({ sources: omo.provenance.sources });
      }

      // ── Installed OMO-Slim schema status (read-only) ──────────
      // Validator availability/version/path/hash plus validation of the
      // CURRENT user and project config files. Never throws: schema
      // unavailable → available:false + error.
      if (url.pathname === "/api/omo/schema" && req.method === "GET") {
        if (revisionDbOk) {
          ensureRecoveredOmoScope({ cfg, revisions }, "user");
          ensureRecoveredOmoScope({ cfg, revisions }, "project");
        }
        return json({
          ...getOmoSchemaStatus(cfg),
          sourceGeneration: sourceWatcher.generation(),
        });
      }

      // Installed schema document for Monaco/preview. Authorized paths only;
      // never fetches the config `$schema` URL. Unavailable → 503 fail-closed
      // for writers; GET /api/omo/schema status remains 200.
      if (url.pathname === "/api/omo/schema/document" && req.method === "GET") {
        if (revisionDbOk) {
          ensureRecoveredOmoScope({ cfg, revisions }, "user");
          ensureRecoveredOmoScope({ cfg, revisions }, "project");
        }
        const doc = getInstalledSchemaDocument(schemaContextFor(cfg), cfg);
        return json(doc, doc.available ? 200 : 503);
      }

      // ── OMO runtime telemetry (read-only) ────────────────────
      // GET /api/omo/runtime — full snapshot. When OpenCode is down the
      // refresh fails soft and the cached snapshot is served marked stale.
      if (url.pathname === "/api/omo/runtime" && req.method === "GET") {
        try {
          await omoStore.refresh(runtime.getSnapshot());
          return json(omoStore.getSnapshot());
        } catch {
          const cached = omoStore.getSnapshot();
          return json({ ...cached, stale: true });
        }
      }

      // GET /api/omo/jobs/:id — single job (by taskId or alias) + child
      // session summary, or 404.
      {
        const m = url.pathname.match(/^\/api\/omo\/jobs\/([^/]+)$/);
        if (m && req.method === "GET") {
          const id = decodeURIComponent(m[1]!);
          try {
            await omoStore.refresh(runtime.getSnapshot());
          } catch {
            /* fall back to cached corpus */
          }
          const job = omoStore.getJob(id);
          if (!job) return json({ error: "not found", taskId: id }, 404);
          const flat = runtime.getRuntimeState().sessions.flat;
          const child = flat.find((s) => s.id === job.childSessionId);
          return json({
            job,
            childSessionPresent: !!child,
            childSession: child
              ? {
                  id: child.id,
                  parentID: child.parentID,
                  title: child.title,
                  agent: child.agent,
                  model: child.model,
                  time: child.time,
                }
              : null,
          });
        }
      }

      // GET /api/agents/:name/prompts
      {
        const m = url.pathname.match(/^\/api\/agents\/([^/]+)\/prompts$/);
        if (m && req.method === "GET") {
          const agent = decodeURIComponent(m[1]!);
          const includeText = url.searchParams.get("text") !== "0";
          const omo = loadOmoConfig({
            opencodeConfigDir: cfg.opencodeConfigDir,
            projectDirectory: cfg.projectDirectory,
            authorizedRoots: cfg.authorizedRoots,
            includePromptText: includeText,
          });
          const prompt = omo.provenance.prompts[agent];
          if (!prompt) {
            return json({ error: "unknown agent", agent }, 404);
          }
          return json(prompt);
        }
      }

      // GET /api/omo/prompts — all agents summary
      if (url.pathname === "/api/omo/prompts") {
        const includeText = url.searchParams.get("text") === "1";
        const omo = loadOmoConfig({
          opencodeConfigDir: cfg.opencodeConfigDir,
          projectDirectory: cfg.projectDirectory,
          authorizedRoots: cfg.authorizedRoots,
          includePromptText: includeText,
        });
        return json({
          prompts: omo.provenance.prompts,
          compositionRule:
            "resolvePrompt: base = inline ?? fileReplacement ?? builtin; append concatenated",
        });
      }

      // ── Prompt workspace (Slice 7) ───────────────────────────
      {
        const m = url.pathname.match(/^\/api\/prompts\/([^/]+)$/);
        if (m && req.method === "GET") {
          const agent = decodeURIComponent(m[1]!);
          const detail = resolvePromptComposition(cfg, agent, {
            includeText: true,
          });
          return json(detail);
        }
      }

      if (url.pathname === "/api/prompts" && req.method === "GET") {
        const omo = loadOmoSafe();
        const names = [
          ...new Set([
            ...Object.keys(omo.effective.agents),
            ...Object.keys(omo.provenance.agents),
            ...Object.keys(omo.desired.agents),
          ]),
        ].sort();
        return json({
          agents: names,
          activePreset: omo.effective.preset,
        });
      }

      if (url.pathname === "/api/config/prompt/simulate" && req.method === "POST") {
        const body = await readJsonBody<Extract<ConfigMutation, { kind: "prompt-file" }>>(req);
        const result = simulatePromptFileMutation(cfg, body);
        return json(result, result.ok ? 200 : 400);
      }

      if (url.pathname === "/api/config/prompt/apply" && req.method === "POST") {
        const body = await readJsonBody<Extract<ConfigMutation, { kind: "prompt-file" }>>(req);
        const result = applyPromptFileMutation(cfg, body, revisions);
        if (result.ok) void runtime.reconcile("prompt-write");
        return json(result, result.ok ? 200 : 400);
      }

      // ── Presets (Slice 8) ────────────────────────────────────
      if (url.pathname === "/api/presets" && req.method === "GET") {
        const omo = loadOmoSafe();
        const live = runtime.getSnapshot();
        const mcpNames = Object.keys(live.mcp);
        const inv = buildPresetInventory(cfg, omo.provenance, {
          skillNames: Object.keys(omo.provenance.prompts),
          mcpNames,
          disabled_skills:
            (omo.provenance.globals.disabled_skills as string[] | undefined) ??
            [],
          disabled_mcps:
            (omo.provenance.globals.disabled_mcps as string[] | undefined) ??
            [],
        });
        return json(inv);
      }

      if (url.pathname === "/api/presets/compare" && req.method === "GET") {
        const omo = loadOmoSafe();
        const a = url.searchParams.get("a");
        const b = url.searchParams.get("b");
        const mode = (url.searchParams.get("mode") ?? "desired") as
          | "desired"
          | "load-effective"
          | "runtime-switch";
        if (!a || !b) return json({ error: "a and b required" }, 400);
        return json(comparePresets(cfg, omo.provenance, a, b, mode));
      }

      {
        const m = url.pathname.match(/^\/api\/presets\/([^/]+)\/switch-impact$/);
        if (m && req.method === "GET") {
          const omo = loadOmoSafe();
          return json({
            preset: decodeURIComponent(m[1]!),
            impact: runtimeSwitchImpact(
              cfg,
              omo.provenance,
              decodeURIComponent(m[1]!),
            ),
          });
        }
      }

      if (url.pathname === "/api/config/preset/create" && req.method === "POST") {
        const body = await readJsonBody<{
          scope: "user" | "project";
          name: string;
          initial:
            | { mode: "empty" }
            | { mode: "clone"; sourcePreset: string; sourceScope?: "user" | "project" };
          expectedSourceHash?: string;
        }>(req);
        const r = createPreset(cfg, revisions, body);
        if (r.ok) void runtime.reconcile("preset-create");
        return json(r, writeStatus(r));
      }

      if (url.pathname === "/api/config/preset/rename" && req.method === "POST") {
        const body = await readJsonBody<{
          scope: "user" | "project";
          oldName: string;
          newName: string;
          updateConfigured: boolean;
          expectedSourceHash?: string;
        }>(req);
        const r = renamePreset(cfg, revisions, body);
        if (r.ok) void runtime.reconcile("preset-rename");
        return json(r, writeStatus(r));
      }

      if (url.pathname === "/api/config/preset/delete" && req.method === "POST") {
        const body = await readJsonBody<{
          scope: "user" | "project";
          name: string;
          expectedSourceHash?: string;
          forceActive?: boolean;
        }>(req);
        const r = deletePreset(cfg, revisions, body);
        if (r.ok) void runtime.reconcile("preset-delete");
        return json(r, writeStatus(r));
      }

      if (url.pathname === "/api/config/preset/set-configured" && req.method === "POST") {
        const body = await readJsonBody<{
          scope: "user" | "project";
          value: string | null;
          expectedSourceHash?: string;
        }>(req);
        const r = setConfiguredPreset(cfg, revisions, body);
        if (r.ok) void runtime.reconcile("configured-preset");
        return json(r, writeStatus(r));
      }

      // ── Global System (Slice 9) ──────────────────────────────
      if (url.pathname === "/api/system/options" && req.method === "GET") {
        return json({ catalog: OPTION_CATALOG });
      }

      if (url.pathname === "/api/system/globals" && req.method === "GET") {
        const omo = loadOmoSafe();
        const live = runtime.getSnapshot();
        const g = omo.provenance.globals;
        return json({
          globals: g,
          effective: {
            disabled_agents: omo.effective.disabledAgents,
            backgroundJobs: omo.effective.backgroundJobs,
            fallback: omo.effective.fallback,
            image_routing: g.image_routing,
            stripOrchestratorModel: g.stripOrchestratorModel,
            compactSidebar: g.compactSidebar,
            setDefaultAgent: g.setDefaultAgent,
            autoUpdate: g.autoUpdate,
            webfetch: g.webfetch,
          },
          live: {
            mcp: live.mcp,
            agents: live.agents.map((a) => a.name),
          },
          environment: {
            OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR ? "(set)" : "(unset)",
            OH_MY_OPENCODE_SLIM_PRESET: process.env.OH_MY_OPENCODE_SLIM_PRESET ?? "(unset)",
            OH_MY_OPENCODE_SLIM_DISABLE: process.env.OH_MY_OPENCODE_SLIM_DISABLE ?? "(unset)",
          },
          properties: omo.provenance.properties,
        });
      }

      // ── Companion / Interview read-only (Slice 13) ────────────
      if (url.pathname === "/api/system/companion" && req.method === "GET") {
        const omo = loadOmoSafe();
        return json(
          buildCompanionState(
            omo.provenance,
            cfg.projectDirectory,
            cfg.authorizedRoots,
          ),
        );
      }

      if (url.pathname === "/api/system/interview" && req.method === "GET") {
        if (revisionDbOk) {
          ensureRecoveredOmoScope({ cfg, revisions }, "user");
          ensureRecoveredOmoScope({ cfg, revisions }, "project");
        }
        const omo = loadOmoSafe();
        return json(
          buildInterviewState(
            omo.provenance,
            cfg.projectDirectory,
            cfg.authorizedRoots,
            process.env,
            {
              cfg,
              fingerprints: {
                user: fingerprintAuthorizedSource(cfg, "user", configWatchGeneration),
                project: fingerprintAuthorizedSource(cfg, "project", configWatchGeneration),
              },
            },
          ),
        );
      }

      // ── Interview typed writes (Slice 18 D2) ────────────────
      // GET /api/config/interview + POST simulate/apply. Physical writes
      // delegate exclusively to the D1 transaction; no runtime/lifecycle
      // action is triggered by an Interview write.
      {
        const handled = await handleInterviewConfigRoutes(
          {
            cfg,
            revisions,
            loadBundle: () => loadOmoSafe().provenance,
            sourceGeneration: () => configWatchGeneration,
          },
          req,
          url,
        );
        if (handled) return handled;
      }

      {
        const handled = await handleRawConfigRoutes(
          {
            cfg,
            revisions,
            sourceGeneration: () => sourceWatcher.generation(),
            noteOwnApply: (sourceId, sha256) =>
              sourceWatcher.noteOwnApply(sourceId, sha256),
          },
          req,
          url,
        );
        if (handled) return handled;
      }

      if (url.pathname === "/api/config/global/simulate" && req.method === "POST") {
        const body = await readJsonBody<GlobalMutation>(req);
        return json(simulateGlobal(cfg, body));
      }

      if (url.pathname === "/api/config/global/apply" && req.method === "POST") {
        const body = await readJsonBody<GlobalMutation>(req);
        const r = applyGlobal(cfg, body, revisions);
        if (r.ok) void runtime.reconcile("global-write");
        return json(r, writeStatus(r));
      }

      // ── Multiplexer (Slice 16) ───────────────────────────────
      // GET /api/system/multiplexer — desired/effective/provenance, legacy,
      // command availability, detection, runtime aggregates/mappings,
      // activation, capabilities, conservative warnings. Read-only. No
      // calls to OpenCode/session APIs, no mux queries. Runtime built from
      // cached bridge + cached OMO jobs only.
      if (url.pathname === "/api/system/multiplexer" && req.method === "GET") {
        const omo = loadOmoSafe();
        const omoSnap = omoStore.getSnapshot();
        // Slice 17: Multiplexer uses manager.getBridgeStatus() (canonical).
        const bridgeStatus = bridgeManager.getBridgeStatus();
        const runtime = buildMultiplexerRuntime(bridgeStatus, omoSnap, Date.now());
        const runner = new StaticCommandRunner((cmd, args) => {
          const proc = Bun.spawn({
            cmd: [cmd, ...args],
            stdout: "pipe",
            stderr: "pipe",
          });
          return Promise.resolve({
            exited: proc.exited,
            stdout: async () => {
              const text = await new Response(proc.stdout).text();
              return text;
            },
          });
        });
        const dto = await buildMultiplexerSystem({
          bundle: omo.provenance,
          runner,
          runtime,
        });
        return json(dto);
      }

      // ── Council (Slice 10) ───────────────────────────────────
      if (url.pathname === "/api/council" && req.method === "GET") {
        return json(buildCouncilInventory(cfg));
      }

      if (url.pathname === "/api/council/runtime" && req.method === "GET") {
        const live = runtime.getRuntimeState();
        const related = live.sessions.flat.filter(
          (s) => s.agent === "council" || s.agent === "councillor",
        );
        return json({
          sessions: related,
          configured: buildCouncilInventory(cfg),
          note: "Session→preset/member identity not exposed by OpenCode; no inference.",
        });
      }

      {
        const m = url.pathname.match(/^\/api\/council\/compare$/);
        if (m && req.method === "GET") {
          const inv = buildCouncilInventory(cfg);
          const a = url.searchParams.get("a");
          const b = url.searchParams.get("b");
          const A = inv.presets.find((p) => p.name === a);
          const B = inv.presets.find((p) => p.name === b);
          if (!A || !B) return json({ error: "preset not found" }, 404);
          const members = new Set([
            ...A.members.map((x) => x.name),
            ...B.members.map((x) => x.name),
          ]);
          const rows: Array<{
            member: string;
            field: string;
            aValue: unknown;
            bValue: unknown;
          }> = [];
          for (const name of members) {
            const ma = A.members.find((x) => x.name === name);
            const mb = B.members.find((x) => x.name === name);
            if (!ma || !mb) {
              rows.push({
                member: name,
                field: "presence",
                aValue: ma ? "present" : "absent",
                bValue: mb ? "present" : "absent",
              });
              continue;
            }
            for (const f of ["model", "variant", "prompt"] as const) {
              if (JSON.stringify(ma[f]) !== JSON.stringify(mb[f])) {
                rows.push({ member: name, field: f, aValue: ma[f], bValue: mb[f] });
              }
            }
          }
          return json({ a, b, rows });
        }
      }

      if (url.pathname === "/api/config/council/simulate" && req.method === "POST") {
        const body = await readJsonBody<CouncilMutation>(req);
        return json(simulateCouncil(cfg, body));
      }

      if (url.pathname === "/api/config/council/apply" && req.method === "POST") {
        const body = await readJsonBody<CouncilMutation>(req);
        const r = applyCouncil(cfg, body, revisions);
        if (r.ok) void runtime.reconcile("council-write");
        return json(r, writeStatus(r));
      }

      // ── ACP (Slice 11) ───────────────────────────────────────
      if (url.pathname === "/api/acp" && req.method === "GET") {
        const live = runtime.getRuntimeState();
        return json(buildAcpInventory(cfg, live.agents.map((a) => a.name)));
      }

      if (url.pathname === "/api/acp/runtime" && req.method === "GET") {
        const inv = buildAcpInventory(cfg, runtime.getRuntimeState().agents.map((a) => a.name), false);
        const live = runtime.getRuntimeState();
        const names = new Set(inv.agents.map((a) => a.name));
        const sessions = live.sessions.flat.filter((s) => s.agent && names.has(s.agent));
        return json({ sessions, note: "External ACP process internal state not observable" });
      }

      if (url.pathname === "/api/acp/probe" && req.method === "POST") {
        const body = await readJsonBody<{ name: string }>(req);
        const inv = buildAcpInventory(cfg, [], false);
        const agent = inv.agents.find((a) => a.name === body.name);
        if (!agent) return json({ ok: false, error: "ACP agent not found" }, 404);
        if (!agent.command) return json({ ok: false, error: "No command configured" }, 400);
        // Reconstruct real env from raw config for probe (masked in view)
        const raw = getRawAcpAgent(cfg, body.name) ?? {};
        const result = await probeAcp({
          command: agent.command,
          args: (raw.args as string[] | undefined) ?? [],
          env: (raw.env as Record<string, string> | undefined) ?? {},
          cwd: (raw.cwd as string | undefined) ?? cfg.projectDirectory,
        });
        return json(result);
      }

      if (url.pathname === "/api/config/acp/simulate" && req.method === "POST") {
        const body = await readJsonBody<AcpMutation>(req);
        return json(simulateAcp(cfg, body));
      }

      if (url.pathname === "/api/config/acp/apply" && req.method === "POST") {
        const body = await readJsonBody<AcpMutation>(req);
        const r = applyAcp(cfg, body, revisions);
        if (r.ok) void runtime.reconcile("acp-write");
        return json(r, writeStatus(r));
      }

      // ── Doctor (Slice 12) ────────────────────────────────────
      if (url.pathname === "/api/doctor" && req.method === "GET") {
        const snap = doctor.getSnapshot();
        const sev = url.searchParams.get("severity");
        const cat = url.searchParams.get("category");
        let diags = snap.diagnostics;
        if (sev) {
          const wanted = new Set(sev.split(","));
          diags = diags.filter((d) => wanted.has(d.severity));
        }
        if (cat) diags = diags.filter((d) => d.category === cat);
        return json({
          ...snap,
          diagnostics: diags,
          totalDiagnostics: snap.diagnostics.length,
        });
      }

      if (url.pathname === "/api/doctor/summary" && req.method === "GET") {
        const snap = doctor.getSnapshot();
        return json({
          generatedAt: snap.generatedAt,
          overall: snap.overall,
          counts: snap.counts,
          // Slice 15: compact model-health roll-up (optional — absent when
          // inventory composition failed).
          modelHealth: snap.modelHealth,
          system: snap.system,
          top: snap.diagnostics.filter((d) => d.severity !== "healthy").slice(0, 8),
        });
      }

      {
        const m = url.pathname.match(/^\/api\/doctor\/([^/]+)$/);
        if (m && req.method === "GET" && !url.pathname.includes("/summary")) {
          const id = decodeURIComponent(m[1]!);
          const snap = doctor.getSnapshot();
          const diag = snap.diagnostics.find((d) => d.id === id);
          if (!diag) return json({ error: "not found", id }, 404);
          return json(diag);
        }
      }

      if (url.pathname === "/api/doctor/recheck" && req.method === "POST") {
        doctor.invalidate();
        await runtime.reconcile("doctor-recheck");
        doctor.invalidate();
        return json(doctor.getSnapshot(true));
      }

      // ── Slice 17: Telemetry bridge API routes ────────────────────
      // Routes with stable JSON errors {ok:false,error:{code,message,action?}}.
      // No raw config/nonce/options in errors/events/logs. Restrict bodies,
      // validate strings/enums. No terminal capture/control/scheduling actions.

      // Helper: bridge-state-unavailable when DB/service is missing.
      function bridgeStateUnavailable() {
        return json({
          ok: false,
          error: {
            code: "bridge-state-unavailable",
            message: "Bridge revision store is unavailable. Bridge management is disabled.",
            action: "Check the bridge database path and permissions.",
          },
        }, 503);
      }

      // GET /api/opencode/bridge/status — sanitized bridge status DTO.
      if (url.pathname === "/api/opencode/bridge/status" && req.method === "GET") {
        // Await the guarded refresh before composing when lifecycle connected.
        try {
          await refreshEffectiveState();
        } catch {
          // Errors remain soft/redacted.
        }
        const status = composeBridgeStatus({
          cfg,
          bridgeStore: bridgeRevisions,
          bridgeService,
          bridgeManager,
          lifecycleState: lifecycle.getStateWithRestartKind(),
          overrideStatus: cfg.omoBridgeOverride ?? validateBridgeOverride(undefined),
          cachedEffectiveState,
          cachedReconcile: bridgeReconcileDisposition,
          provenWriteTarget,
        });
        return json({ ok: true, status });
      }

      // POST /api/opencode/bridge/preview — body {operation:"register"|"remove"}.
      // Map to service add/remove. Return exact bridge-only diff and no write.
      if (url.pathname === "/api/opencode/bridge/preview" && req.method === "POST") {
        if (!bridgeRevisionDbOk || !bridgeService || !bridgeRevisions) return bridgeStateUnavailable();
        const body = await readJsonBody<{ operation: string }>(req);
        if (body.operation !== "register" && body.operation !== "remove") {
          return json({ ok: false, error: { code: "invalid-operation", message: "operation must be 'register' or 'remove'" } }, 400);
        }
        if (cfg.omoBridgeOverride?.optsOutOfManagement) {
          return json({ ok: false, error: { code: "override-unmanaged", message: "Override active; management actions disabled.", action: "Unset OMO_BRIDGE_BASE_URL to manage the bridge." } }, 409);
        }
        const serviceOp = body.operation === "register" ? "add" : "remove";
        const result = await bridgeService.preview({ operation: serviceOp as "add" | "remove" });
        if (!result.ok) {
          // Fix #8: preserve foundation error codes.
          const firstError = result.errors[0];
          const code = firstError?.code ?? "preview-failed";
          const message = result.errors.map((e) => e.message).join("; ");
          return json({ ok: false, error: { code, message } }, 409);
        }
        // Fix #7: bind previewId to required confirmation in module-level bounded registry.
        storePreviewConfirmation(result.previewId, body.operation);
        return json({ ok: true, preview: result });
      }

      // POST /api/opencode/bridge/apply — body {previewId, confirmation:"register"|"remove"}.
      // Confirmation must match preview operation; apply config only, NEVER restart.
      if (url.pathname === "/api/opencode/bridge/apply" && req.method === "POST") {
        if (!bridgeRevisionDbOk || !bridgeService || !bridgeRevisions) return bridgeStateUnavailable();
        const body = await readJsonBody<{ previewId: string; confirmation: string }>(req);
        if (typeof body.previewId !== "string" || !body.previewId) {
          return json({ ok: false, error: { code: "invalid-preview-id", message: "previewId is required" } }, 400);
        }
        if (body.confirmation !== "register" && body.confirmation !== "remove") {
          return json({ ok: false, error: { code: "invalid-confirmation", message: "confirmation must be 'register' or 'remove'" } }, 400);
        }
        // Fix #7: verify confirmation matches the preview operation (consumed on every attempt).
        const requiredConfirmation = consumePreviewConfirmation(body.previewId);
        if (requiredConfirmation === undefined) {
          return json({ ok: false, error: { code: "preview-stale", message: "Preview not found, already consumed, or expired." } }, 409);
        }
        if (requiredConfirmation !== body.confirmation) {
          return json({ ok: false, error: { code: "confirmation-mismatch", message: `Confirmation '${body.confirmation}' does not match preview operation '${requiredConfirmation}'.` } }, 409);
        }
        if (cfg.omoBridgeOverride?.optsOutOfManagement) {
          return json({ ok: false, error: { code: "override-unmanaged", message: "Override active; management actions disabled." } }, 409);
        }
        const result = await bridgeService.apply({ previewId: body.previewId });
        if (!result.ok) {
          // Fix #8: preserve foundation error codes.
          const firstError = result.errors[0];
          const code = firstError?.code ?? "apply-failed";
          const message = result.errors.map((e) => e.message).join("; ");
          return json({ ok: false, error: { code, message } }, 409);
        }
        // Update cached reconciliation disposition from result
        bridgeReconcileDisposition = {
          disposition: result.stateDisposition ?? "committed",
          errors: result.errors ?? [],
        };
        // Feed manager from newly committed desired state, preserve old runtime effective view as effective truth until restart, invalidate Doctor, and broadcast sanitized status.
        feedBridgeManagerOnLifecycleChange();
        doctor.invalidate();
        broadcastBridgeStatus();

        // Explicit two-step: registration apply succeeds with "no runtime action occurred"
        // semantics in DTO; restart is a separate request/confirmation.
        return json({
          ok: true,
          apply: result,
          restartRequired: true,
          restartAction: "POST /api/opencode/bridge/restart with confirmation 'restart-owned-bridge'",
          note: "Config applied. No runtime action occurred. An explicit restart request is required to activate the bridge.",
        });
      }

      // POST /api/opencode/bridge/restore — body {revisionId, expectedSourceHash, confirmation:"restore"}.
      if (url.pathname === "/api/opencode/bridge/restore" && req.method === "POST") {
        if (!bridgeRevisionDbOk || !bridgeService || !bridgeRevisions) return bridgeStateUnavailable();
        const body = await readJsonBody<{ revisionId: string; expectedSourceHash: string; confirmation: string }>(req);
        if (typeof body.revisionId !== "string" || !body.revisionId) {
          return json({ ok: false, error: { code: "invalid-revision-id", message: "revisionId is required" } }, 400);
        }
        if (typeof body.expectedSourceHash !== "string" || !body.expectedSourceHash) {
          return json({ ok: false, error: { code: "invalid-expected-hash", message: "expectedSourceHash is required" } }, 400);
        }
        if (body.confirmation !== "restore") {
          return json({ ok: false, error: { code: "invalid-confirmation", message: "confirmation must be 'restore'" } }, 400);
        }
        if (cfg.omoBridgeOverride?.optsOutOfManagement) {
          return json({ ok: false, error: { code: "override-unmanaged", message: "Override active; management actions disabled." } }, 409);
        }
        const result = await bridgeService.restore({ revisionId: body.revisionId, expectedSourceHash: body.expectedSourceHash });
        if (!result.ok) {
          // Fix #8: preserve foundation error codes.
          const firstError = result.errors[0];
          const code = firstError?.code ?? "restore-failed";
          const message = result.errors.map((e) => e.message).join("; ");
          return json({ ok: false, error: { code, message } }, 409);
        }
        // Update cached reconciliation disposition from result
        bridgeReconcileDisposition = {
          disposition: result.stateDisposition ?? "committed",
          errors: result.errors ?? [],
        };
        // Feed manager from newly committed desired state, preserve old runtime effective view, invalidate Doctor, and broadcast sanitized status.
        feedBridgeManagerOnLifecycleChange();
        doctor.invalidate();
        broadcastBridgeStatus();

        return json({
          ok: true,
          restore: result,
          restartRequired: true,
          note: "Config restored. No runtime action occurred. An explicit restart request is required to apply the restored state.",
        });
      }

      // POST /api/opencode/bridge/restart — body {intent, expectedGeneration, expectedSourceHash, revisionId, nonceFingerprint?, port?, confirmation:"restart-owned-bridge"}.
      if (url.pathname === "/api/opencode/bridge/restart" && req.method === "POST") {
        if (!bridgeRevisionDbOk || !bridgeService || !bridgeRevisions) return bridgeStateUnavailable();
        const body = await readJsonBody<{
          intent: string;
          expectedGeneration: number;
          expectedSourceHash: string;
          revisionId: string;
          nonceFingerprint?: string;
          port?: number;
          confirmation: string;
        }>(req);
        if (body.intent !== "activate" && body.intent !== "deactivate" && body.intent !== "recover-activation-failure") {
          return json({ ok: false, error: { code: "invalid-intent", message: "intent must be 'activate', 'deactivate', or 'recover-activation-failure'" } }, 400);
        }
        if (body.confirmation !== "restart-owned-bridge") {
          return json({ ok: false, error: { code: "invalid-confirmation", message: "confirmation must be 'restart-owned-bridge'" } }, 400);
        }
        if (cfg.omoBridgeOverride?.optsOutOfManagement) {
          return json({ ok: false, error: { code: "override-unmanaged", message: "Override active; management actions disabled." } }, 409);
        }
        const result = await lifecycle.restartForTelemetryBridge(
          body.intent as "activate" | "deactivate" | "recover-activation-failure",
          {
            generation: body.expectedGeneration,
            configHash: body.expectedSourceHash,
            revisionId: body.revisionId,
            ...(body.nonceFingerprint !== undefined ? { nonceFingerprint: body.nonceFingerprint } : {}),
            ...(body.port !== undefined ? { port: body.port } : {}),
          },
        );
        if (!result.ok) {
          return json({ ok: false, error: { code: result.code ?? "restart-failed", message: result.message ?? "Restart failed" } }, 409);
        }
        if (bridgeRevisions) {
          const state = bridgeRevisions.getActivationState();
          bridgeReconcileDisposition = {
            disposition: state?.active ? "committed" : "not-written",
            errors: [],
          };
        }
        return json({ ok: true, restart: result });
      }

      // POST /api/opencode/bridge/probe — honest structured bridge-probe-inapplicable/
      // transport-unverified response; tuple probe is optional and not implemented
      // on the production env path. No runtime change.
      // Fix #9: return 501 (not implemented), not 200.
      if (url.pathname === "/api/opencode/bridge/probe" && req.method === "POST") {
        return json({
          ok: false,
          error: {
            code: "bridge-probe-inapplicable",
            message: "Tuple probe is optional and not implemented on the production env path. Transport remains unverified.",
            action: "Use the bridge status endpoint to observe the verified state.",
          },
        }, 501);
      }

      if (url.pathname === "/api/live") {
        return json(runtime.getSnapshot());
      }

      // ── Capabilities inventory ───────────────────────────────
      if (
        (url.pathname === "/api/capabilities" ||
          url.pathname === "/api/skills" ||
          url.pathname === "/api/mcps") &&
        req.method === "GET"
      ) {
        const omo = loadOmoSafe();
        const live = runtime.getSnapshot();
        let skillNames: string[] = [];
        try {
          const raw = await runtime.getClient().skills();
          if (Array.isArray(raw)) {
            skillNames = raw
              .map((s: { name?: string }) => s.name)
              .filter(Boolean) as string[];
          } else if (raw && typeof raw === "object") {
            skillNames = Object.keys(raw as object);
          }
        } catch {
          /* */
        }
        try {
          const { readdirSync } = await import("node:fs");
          const skillsDir = join(cfg.opencodeConfigDir, "skills");
          assertAuthorizedPath(skillsDir, cfg.authorizedRoots);
          for (const name of readdirSync(skillsDir)) {
            if (!name.startsWith(".") && !skillNames.includes(name)) {
              skillNames.push(name);
            }
          }
        } catch {
          /* */
        }
        const inv = buildCapabilityInventory({
          provenance: omo.provenance,
          skillNames,
          mcpRuntime: live.mcp,
        });
        if (url.pathname === "/api/skills") return json({ skills: inv.skills });
        if (url.pathname === "/api/mcps")
          return json({ mcps: inv.mcps, globals: inv.globals });
        return json(inv);
      }

      // ── Config mutation (Slice 5–6) ─────────────────────────
      if (url.pathname === "/api/config/edit-state" && req.method === "GET") {
        if (revisionDbOk) {
          ensureRecoveredOmoScope({ cfg, revisions }, "user");
          ensureRecoveredOmoScope({ cfg, revisions }, "project");
        }
        const omo = loadOmoSafe();
        const user = resolveWriteTarget(cfg, "user");
        const project = resolveWriteTarget(cfg, "project");
        const hash = (p: string, exists: boolean) => {
          if (!exists) return null;
          try {
            return hashContent(readFileSync(p, "utf-8"));
          } catch {
            return null;
          }
        };
        return json({
          preset: omo.effective.preset,
          user: {
            path: user.path,
            exists: user.exists,
            hash: hash(user.path, user.exists),
          },
          project: {
            path: project.path,
            exists: project.exists,
            hash: hash(project.path, project.exists),
          },
          configWatchGeneration,
          agents: Object.keys(omo.effective.agents),
        });
      }

      if (url.pathname === "/api/config/simulate" && req.method === "POST") {
        const body = await readJsonBody<ConfigMutation>(req);
        const result = simulateMutation(cfg, body);
        return json(result, result.ok ? 200 : 400);
      }

      if (url.pathname === "/api/config/apply" && req.method === "POST") {
        const body = await readJsonBody<ConfigMutation>(req);
        const result = applyMutation(cfg, body, revisions);
        // Refresh runtime agents after write (REST reconcile)
        if (result.ok) {
          void runtime.reconcile("config-write");
        }
        return json(
          result,
          result.ok
            ? 200
            : result.conflict
              ? 409
              : isSchemaFailure(result)
                ? 422
                : 400,
        );
      }

      if (url.pathname === "/api/config/revisions" && req.method === "GET") {
        if (revisionDbOk) {
          ensureRecoveredOmoScope({ cfg, revisions }, "user");
          ensureRecoveredOmoScope({ cfg, revisions }, "project");
        }
        return json({ revisions: revisions.list(100) });
      }

      {
        const m = url.pathname.match(/^\/api\/config\/revisions\/([^/]+)$/);
        if (m && req.method === "GET") {
          if (revisionDbOk) {
            ensureRecoveredOmoScope({ cfg, revisions }, "user");
            ensureRecoveredOmoScope({ cfg, revisions }, "project");
          }
          const rev = revisions.get(decodeURIComponent(m[1]!));
          if (!rev) return json({ error: "not found" }, 404);
          return json(rev);
        }
      }

      {
        const m = url.pathname.match(
          /^\/api\/config\/revisions\/([^/]+)\/restore$/,
        );
        if (m && req.method === "POST") {
          const body = await readOptionalJsonBody<{ expectedSourceHash?: string }>(req);
          if (revisionDbOk) {
            ensureRecoveredOmoScope({ cfg, revisions }, "user");
            ensureRecoveredOmoScope({ cfg, revisions }, "project");
          }
          const result = restoreRevision(
            cfg,
            decodeURIComponent(m[1]!),
            revisions,
            body?.expectedSourceHash,
          );
          if (result.ok) void runtime.reconcile("config-restore");
          return json(
            result,
            result.ok
              ? 200
              : result.conflict
                ? 409
                : isSchemaFailure(result)
                  ? 422
                  : 400,
          );
        }
      }

      // ── Release web static handler ────────────────────────────
      // Serves the built web app from `<install>/web` when present. Mounted
      // after all drift/OPTIONS/API routes and before the generic JSON 404.
      // Returns undefined for non-GET/HEAD, `/api` and `/api/*`, or when no
      // usable web directory exists, preserving the dev JSON 404.
      {
        const webResponse = handleReleaseWeb(req, {
          owlInstallDirectory: cfg.owlInstallDirectory,
          authorizedRoots: cfg.authorizedRoots,
        });
        if (webResponse) return webResponse;
      }

      return json({ error: "not found", path: url.pathname }, 404);
    } catch (e) {
      const message = sanitizeOpenCodeError(e, [process.env.OPENCODE_SERVER_PASSWORD]);
      console.error("[omo-cp] request failed: %s", message);
      return json(
        { error: message },
        500,
      );
    }
}

const server = Bun.serve({
  hostname: cfg.host,
  port: cfg.port,
  idleTimeout: 255,
  async fetch(req) {
    return withSecurityHeaders(await handleRequest(req));
  },
});
serverRef = server;

if (cfg.desktop) {
  // Exact, parseable readiness line for the desktop shell. Must be the only
  // line with this prefix on stdout.
  const origin = `http://127.0.0.1:${server.port}`;
  setDesktopCorsOrigin(origin);
  console.log(`OWL_READY ${origin}`);
}

console.log(`[omo-cp] listening on http://${server.hostname}:${server.port}`);
console.log(`[omo-cp] OpenCode lifecycle mode: ${cfg.opencodeMode}`);
console.log(`[omo-cp] config dir: ${cfg.opencodeConfigDir}`);
console.log(`[omo-cp] project: ${cfg.projectDirectory}`);
console.log(
  `[omo-cp] sessions + provenance + safe config writes (model/variant)`,
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[omo-cp] ${signal}: stopping owned OpenCode backend`);
  // Slice 17 shutdown order (requirement 15):
  // manager.stop; watcher stop; omoStore dispose; lifecycle stop; bridge DB checkpoint/close.
  try { bridgeManager.stop(); } catch { /* idempotent */ }
  for (const watcher of bridgeWatchers) {
    try { watcher.stop(); } catch { /* idempotent */ }
  }
  runtime.stop();
  omoStore.dispose();
  for (const watcher of configWatchers) watcher.close();
  try { sourceWatcher.stop(); } catch { /* idempotent */ }
  await lifecycle.stop();
  // Composition root owns and closes bridge store only after lifecycle.stop.
  try { bridgeRevisions?.close(); } catch { /* idempotent */ }
  server.stop(true);
  if (cfg.desktop) {
    // Desktop shutdown is initiated over HTTP (or a signal) rather than by
    // the owning terminal; exit explicitly so the sidecar process always
    // terminates after graceful cleanup instead of waiting on stragglers.
    const t = setTimeout(() => process.exit(0), 100) as unknown as {
      unref?: () => void;
    };
    t.unref?.();
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("beforeExit", () => void lifecycle.stop());
