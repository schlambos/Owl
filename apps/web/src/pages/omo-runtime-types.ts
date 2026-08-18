// Local re-declaration of the OMO runtime telemetry contract (GET /api/omo/runtime).
// Server keeps these types local to its routes; nothing was added to @omo/shared.

export type OmoJobState = "running" | "completed" | "error" | "cancelled";

export interface OmoJob {
  taskId: string;
  alias?: string;
  agent: string;
  description?: string;
  parentSessionId: string;
  childSessionId: string;
  state: OmoJobState;
  timedOut?: boolean;
  resultSummary?: string;
  launchedAt?: number;
  completedAt?: number;
  resumeRequested?: boolean;
  statusUncertain?: boolean;
  source: "opencode-task-call";
}

export interface OmoWorkerView {
  agent: string;
  running: number;
  completed: number;
  errored: number;
  cancelled: number;
  jobs: string[];
}

export interface OmoBridgeStores {
  fallbackInProgressSessionIDs?: string[];
  continuationGate?: {
    attemptCounts?: Record<string, number | string>;
    lastRearmIdentity?: Record<string, string>;
  };
  multiplexer?: {
    sessionsCount?: number;
    knownSessionsCount?: number;
    spawningCount?: number;
    closingCount?: number;
    permanentlyClosedCount?: number;
  };
  cmux?: { recordCount?: number };
}

export interface OmoRuntimeSnapshot {
  telemetrySchemaVersion: number;
  generatedAt: number;
  stale: boolean;
  availability: {
    opencodeJobs: boolean;
    bridge: boolean;
    runtimePreset: false;
  };
  jobs: OmoJob[];
  workers: OmoWorkerView[];
  bridge?: {
    connected: boolean;
    lastSeenAt?: number;
    stores?: OmoBridgeStores;
    schemaVersion?: number;
  } | null;
  notes: string[];
}
