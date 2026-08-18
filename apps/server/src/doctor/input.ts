/**
 * Doctor input: normalized state composed from existing subsystems.
 * Pure data — rules are pure functions over this.
 */

import type {
  CapabilityInventory,
  LiveAgent,
  LivePermission,
  LiveProvider,
  LiveSession,
  ModelAvailability,
  OpenCodeLifecycleState,
  OmoSchemaStatus,
  ProvenanceBundle,
  ProviderDiagnostics,
  ResolvedProperty,
  RuntimeConnection,
  TelemetryBridgeStatusDto,
} from "@omo/shared";
import type { CouncilInventory } from "../cfgwrite/council";
import type { AcpInventory } from "../cfgwrite/acp";
import type { CompanionState } from "../omo/companion";
import type { InterviewState } from "../omo/interview";

export interface DoctorInput {
  generatedAt: string;

  // Control plane
  cp: {
    revisionDbOk: boolean;
    runtimeStoreStarted: boolean;
    configGeneration: number;
    host: string;
  };

  lifecycle: OpenCodeLifecycleState;

  // Runtime
  connection: RuntimeConnection;
  health: { healthy: boolean; version?: string; error?: string };
  agents: LiveAgent[];
  providers: LiveProvider[];
  sessions: LiveSession[];
  permissions: LivePermission[];
  mcp: Record<string, { status: string }>;

  // OMO config resolution
  config: {
    loadOk: boolean;
    loadError?: string;
  };
  provenance?: ProvenanceBundle;

  /**
   * Installed OMO-Slim schema validation surface (fail-closed write gate).
   * Absent when status composition failed — schema rules stay silent.
   */
  schema?: {
    status: OmoSchemaStatus;
    /**
     * Lazy audit: how many of the latest scanned revisions' stored content
     * fails the CURRENT installed schema (restore of those is blocked).
     */
    revisionsScanned: number;
    revisionsIncompatible: number;
  };

  // Inventories
  capabilities?: CapabilityInventory;
  council?: CouncilInventory;
  acp?: AcpInventory;
  companion?: CompanionState;
  interview?: InterviewState;

  // Environment (masked)
  environment: {
    OPENCODE_CONFIG_DIR_SET: boolean;
    OH_MY_OPENCODE_SLIM_PRESET?: string;
    OH_MY_OPENCODE_SLIM_DISABLE?: string;
    OPENCODE_BASE_URL_SET: boolean;
    OMO_CP_HOST: string;
  };

  // Package metadata (already available in control plane)
  packageHint?: string;
  omoManifestVersion?: string;

  /**
   * OMO runtime telemetry summary (apps/server/src/omo-runtime).
   * Absent when the telemetry store could not be composed — rules stay
   * silent (conservative). All lists are sanitized taskIds only.
   */
  omoTelemetry?: {
    bridgeConfigured: boolean;
    bridgeConnected: boolean;
    bridgeSchema?: number;
    jobCount: number;
    /** Jobs whose child session is absent from OpenCode (grace applied by rule). */
    orphanJobs: string[];
    /** taskId → epoch ms when the child was first observed missing. */
    orphanMissingSince?: Record<string, number>;
    /** Jobs with OMO-declared timedOut in status output (dist/index.js:24972). */
    timedOutJobs: string[];
    /** Jobs in state "error" completed within the last 30 minutes. */
    recentErrors: string[];
    stale: boolean;
  };

  /**
   * Slice 17: sanitized telemetry bridge lifecycle/status DTO from the
   * TelemetryBridgeManager + BridgeRevisionStore composition. Absent when
   * composition failed — bridge rules stay silent (conservative).
   *
   * Policy: unconfigured neutral; source unproven/override unmanaged
   * informational; invalid override warning; registered-awaiting-restart
   * informational; configured/unreachable informational; schema/identity
   * mismatch warning; duplicate registration warning; bridge absence never
   * degrades derived jobs; deep bridge disconnected distinct from derived
   * OMO telemetry.
   */
  bridgeStatus?: TelemetryBridgeStatusDto;

  // Revisions
  revisions: {
    reachable: boolean;
    count?: number;
    lastRevisionAt?: string;
    /** Logical scopes currently blocked by a recovered conflict revision. */
    conflictScopes?: Array<"user" | "project">;
  };

  /**
   * Composed model inventory (Slice 15). Read-only: derived from the runtime
   * snapshot, persisted probe runs, and config inventories — NO probe
   * invocation and no additional OpenCode HTTP calls. Absent when the
   * composition failed; model rules stay silent (conservative), matching the
   * existing inventory patterns above.
   */
  modelInventory?: {
    /** False while probe persistence is degraded (fresh results live in the in-memory overlay only). */
    probeStoreAvailable: boolean;
    models: ModelAvailability[];
    providers: ProviderDiagnostics[];
  };

  /**
   * Multiplexer subsystem summary (Slice 16). Absent when composition failed;
   * multiplexer rules stay silent (conservative). Conservative by design:
   * explicit backend command missing → warning; configured/detected drift →
   * info only if runtime detected authoritative; missing bridge/runtime
   * unavailable → no warning; auto→none healthy/info; none healthy; legacy
   * modern conflict info/warning based exact ignored behavior; missing
   * mapping after grace warning only when authoritative.
   */
  multiplexer?: {
    configuredType: string;
    effectiveType: string;
    detectedType: string | null;
    legacyTmuxPresent: boolean;
    explicitBackendCommandMissing: boolean;
    runtimeUnavailable: boolean;
    runtimeStale: boolean;
    unmappedJobsAfterGrace: string[];
    graceApplied: boolean;
  };
}
