/**
 * System → Telemetry Bridge (Slice 17).
 *
 * Renders the telemetry-bridge activation lifecycle from
 * GET /api/opencode/bridge/status as four deliberately separate, visually
 * distinct layers — desired registration, committed source / restart-required,
 * runtime connection / health, lifecycle / ownership, safe metadata — and
 * drives the register/remove (preview → apply) and separate restart flows.
 *
 * Truthfulness contract (mirrors the server DTO sanitizer):
 *   - Never renders tokens, nonce values, raw config, provider/plugin
 *     options, terminal content, or raw envelopes.
 *   - Active connection metadata (endpoint, schema version, capabilities,
 *     bridge package version) is shown ONLY when the bridge is connected.
 *   - Long paths / identities wrap safely (`.mux-break`).
 *   - Restart is a SEPARATE flow gated on `actions.canRestart`; apply never
 *     restarts. Restart request fields are sourced from the current real
 *     DTO/state; activate/deactivate/recovery is derived from authoritative
 *     actual state. If safe derivation is impossible, no control is shown
 *     and the contract gap is reported.
 *   - Restore only when the DTO provides enough valid revision data /
 *     eligibility; otherwise recovery status / next action is shown.
 *   - Probe is non-actionable (server returns 501); no probe control.
 *
 * Refresh: the single /api/events SSE stream drives refresh via
 * `bridgeGeneration` from useRuntime() — no duplicate polling.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TelemetryBridgeStatusDto } from "@omo/shared";
import { useRuntime } from "../../runtime/RuntimeContext";
import { Button } from "../../components/ui/Button";
import { StatusBadge } from "../../components/ui/StatusBadge";
import {
  ActionBar,
  Group,
  SectionIntro,
  ServiceHeader,
  SettingRow,
} from "./SystemPrimitives";
import {
  BridgeRestartIntent,
  BridgeRestartRequest,
  BridgeApiError,
  BridgeApplyDto,
  BridgePreviewDto,
  BridgeRestartResultView,
  BridgeRestoreDto,
} from "./telemetry-bridge-types";

// ── Human labels for the normalized enums (never the raw enum names) ───

const RUNTIME_LABEL: Record<string, string> = {
  inactive: "Inactive",
  starting: "Starting",
  active: "Active",
  failed: "Failed",
  stale: "Stale",
  unavailable: "Unavailable",
  mismatch: "Incompatible",
};

const REGISTRATION_LABEL: Record<string, string> = {
  "not-registered": "Not registered",
  registered: "Registered",
  duplicate: "Duplicate registration",
  unknown: "Unknown",
};

const LIFECYCLE_LABEL: Record<string, string> = {
  "not-installed": "Not installed",
  "available-locally": "Available locally",
  "not-registered": "Not registered",
  registered: "Registered",
  loading: "Loading",
  active: "Active",
  "registered-inactive": "Registered, inactive",
  incompatible: "Incompatible",
  failed: "Failed",
  stale: "Stale",
  "external-unmanaged": "External (unmanaged)",
};

const COMPATIBILITY_LABEL: Record<string, string> = {
  compatible: "Compatible",
  incompatible: "Incompatible",
  unknown: "Unknown",
};

const ENDPOINT_SOURCE_LABEL: Record<string, string> = {
  "managed-derived": "Managed (derived)",
  "explicit-override": "Explicit override",
  unavailable: "Unavailable",
};

const SCHEMA_GATE_LABEL: Record<string, string> = {
  proven: "Proven",
  blocked: "Blocked",
  absent: "Absent",
  "committed-awaiting-restart": "Committed — awaiting restart",
};

const STATE_DISPOSITION_LABEL: Record<string, string> = {
  "not-written": "Not written",
  committed: "Committed",
  "recovery-pending": "Recovery pending",
};

const RESTART_KIND_LABEL: Record<string, string> = {
  ordinary: "Ordinary restart",
  "telemetry-activation": "Telemetry activation restart",
  "awaiting-owner": "Awaiting owner",
};

function pillToneForRuntime(state: string): "ok" | "warn" | "bad" | "neutral" {
  switch (state) {
    case "active":
      return "ok";
    case "starting":
    case "stale":
      return "warn";
    case "failed":
    case "mismatch":
    case "unavailable":
      return "bad";
    default:
      return "neutral";
  }
}

function pillToneForLifecycle(state: string): "ok" | "warn" | "bad" | "neutral" {
  switch (state) {
    case "active":
      return "ok";
    case "loading":
    case "available-locally":
    case "stale":
      return "warn";
    case "failed":
    case "incompatible":
    case "not-installed":
    case "external-unmanaged":
      return "bad";
    default:
      return "neutral";
  }
}

// ── Intent derivation from authoritative actual state ─────────────────
//
// The restart intent is derived from the committed desired state vs the
// current runtime state. If safe derivation is impossible (missing
// committed desired state, or ambiguous transition), no control is shown
// and the contract gap is reported — we never invent a control.

interface DerivedIntent {
  intent: BridgeRestartIntent;
  label: string;
  description: string;
}

function deriveRestartIntent(
  status: TelemetryBridgeStatusDto,
): DerivedIntent | null {
  const { desired, runtime, restartRequired, lifecycleStatus } = status;
  // canRestart already gates on committed disposition + restartRequired;
  // we only derive the intent when those hold.
  if (!restartRequired || !desired || desired.stateDisposition !== "committed") {
    return null;
  }
  // recover-activation-failure: runtime failed while a committed enabled
  // desired state exists — the lifecycle is in a failed-owned state.
  if (runtime === "failed" && desired.enabled) {
    return {
      intent: "recover-activation-failure",
      label: "Recover activation",
      description:
        "The committed registration is enabled but the bridge runtime failed to activate. " +
        "Restart through strict owned start with the bridge env overlay.",
    };
  }
  // activate: committed enabled, runtime not yet active.
  if (desired.enabled && runtime !== "active") {
    return {
      intent: "activate",
      label: "Activate bridge",
      description:
        "Apply the committed registration: enable the bridge on its committed port with the env overlay. " +
        "No runtime action occurred during apply — this restart activates it.",
    };
  }
  // deactivate: committed disabled, runtime still active.
  if (!desired.enabled && (runtime === "active" || runtime === "starting")) {
    return {
      intent: "deactivate",
      label: "Deactivate bridge",
      description:
        "Apply the committed removal: disable the bridge (remove the env overlay, no bridge env).",
    };
  }
  // No safe derivation — the caller reports the contract gap.
  void lifecycleStatus;
  return null;
}

// ── Component ─────────────────────────────────────────────────────────

export function TelemetryBridgeSection() {
  const { bridgeGeneration } = useRuntime();
  const [status, setStatus] = useState<TelemetryBridgeStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const fetchSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setRefreshing(true);
    try {
      const r = await fetch("/api/opencode/bridge/status");
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`/api/opencode/bridge/status → ${r.status} ${text.slice(0, 200)}`);
      }
      const body = (await r.json()) as { ok: boolean; status: TelemetryBridgeStatusDto };
      if (seq !== fetchSeq.current) return; // superseded
      setStatus(body.status);
      setError(null);
    } catch (e) {
      if (seq !== fetchSeq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === fetchSeq.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  // Initial fetch on mount, then refetch only when a telemetry-bridge.updated
  // SSE event bumps bridgeGeneration. No duplicate polling.
  useEffect(() => {
    void refresh();
  }, [refresh, bridgeGeneration]);

  return (
    <TelemetryBridgeSectionView
      status={status}
      error={error}
      loading={loading}
      refreshing={refreshing}
      onRefresh={() => void refresh()}
    />
  );
}

function TelemetryBridgeSectionView(props: {
  status: TelemetryBridgeStatusDto | null;
  error: string | null;
  loading: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { status, error, loading, refreshing, onRefresh } = props;

  if (loading && !status) {
    return (
      <div data-testid="bridge-section" data-state="loading">
        <ServiceHeader title="Telemetry Bridge" description="Loading bridge status…" />
      </div>
    );
  }
  if (error && !status) {
    return (
      <div data-testid="bridge-section" data-state="error">
        <ServiceHeader title="Telemetry Bridge" />
        <div className="error" role="alert">
          {error}
        </div>
      </div>
    );
  }
  if (!status) {
    return (
      <div data-testid="bridge-section" data-state="empty">
        <ServiceHeader title="Telemetry Bridge" description="No bridge status available." />
      </div>
    );
  }

  return (
    <BridgeStatusLayout
      status={status}
      error={error}
      refreshing={refreshing}
      onRefresh={onRefresh}
    />
  );
}

function BridgeStatusLayout(props: {
  status: TelemetryBridgeStatusDto;
  error: string | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { status, error, refreshing, onRefresh } = props;
  const connected = status.backendConnected;
  const derivedIntent = deriveRestartIntent(status);

  return (
    <div data-testid="bridge-section" data-state="ready">
      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}

      {/* ── Summary header ─────────────────────────────────────────── */}
      <div data-testid="bridge-summary">
        <ServiceHeader
          title="Telemetry Bridge"
          description="The telemetry bridge is an optional OpenCode plugin. The control plane consumes a running bridge; it does not auto-register or hot-reload the plugin. Activation requires an explicit restart."
          badges={
            <>
              <StatusBadge
                tone={pillToneForRuntime(status.runtime)}
                testId="bridge-runtime-pill"
              >
                {RUNTIME_LABEL[status.runtime] ?? status.runtime}
              </StatusBadge>
              <span className="pill" data-testid="bridge-registration-pill">
                {REGISTRATION_LABEL[status.registration] ?? status.registration}
              </span>
              <StatusBadge
                tone={pillToneForLifecycle(status.lifecycleStatus)}
                testId="bridge-lifecycle-pill"
              >
                {LIFECYCLE_LABEL[status.lifecycleStatus] ?? status.lifecycleStatus}
              </StatusBadge>
              <span className="pill" data-testid="bridge-mode-pill">
                {status.mode === "managed" ? "Managed" : "Attach"}
              </span>
              <span className="pill" data-testid="bridge-ownership-pill">
                {status.ownership === "control-plane" ? "Control Plane" : "External"}
              </span>
              {status.restartRequired ? (
                <span className="pill warn" data-testid="bridge-restart-required-pill">
                  Restart required
                </span>
              ) : null}
              {status.restartKind ? (
                <span className="pill" data-testid="bridge-restart-kind-pill">
                  {RESTART_KIND_LABEL[status.restartKind] ?? status.restartKind}
                </span>
              ) : null}
            </>
          }
          meta={`generation ${status.generation} · epoch ${status.verificationEpoch}`}
          actions={
            <Button
              size="sm"
              onClick={onRefresh}
              disabled={refreshing}
              aria-label="Refresh telemetry bridge status"
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </Button>
          }
        />
      </div>

      {/* ── Layer 1: Desired registration ───────────────────────────── */}
      <DesiredLayer status={status} />

      {/* ── Layer 2: Committed source / restart-required ──────────── */}
      <SourceLayer status={status} />

      {/* ── Layer 3: Runtime connection / health ───────────────────── */}
      <RuntimeLayer status={status} connected={connected} />

      {/* ── Layer 4: Lifecycle / ownership ─────────────────────────── */}
      <LifecycleLayer status={status} />

      {/* ── Layer 5: Safe metadata (capabilities, override) ───────── */}
      <MetadataLayer status={status} />

      {/* ── Register / Remove flow (preview → apply, never restarts) */}
      <RegisterRemoveLayer status={status} onApplied={onRefresh} />

      {/* ── Separate restart flow (only when canRestart) ───────────── */}
      <RestartLayer
        status={status}
        derivedIntent={derivedIntent}
        onRestarted={onRefresh}
      />

      {/* ── Restore flow (only when eligible) ─────────────────────── */}
      <RestoreLayer status={status} onRestored={onRefresh} />

      {/* ── Live region for screen readers ─────────────────────────── */}
      <div
        role="status"
        aria-live="polite"
        className="visually-hidden"
        data-testid="bridge-aria-status"
      >
        Telemetry bridge is {RUNTIME_LABEL[status.runtime]?.toLowerCase() ?? status.runtime}.
        {status.restartRequired ? " Restart required to apply committed config." : ""}
      </div>
    </div>
  );
}

// ── Layer components ───────────────────────────────────────────────────

function DesiredLayer({ status }: { status: TelemetryBridgeStatusDto }) {
  const desired = status.desired;
  return (
    <div data-testid="bridge-desired">
      <SectionIntro
        title="Desired registration"
        description="The committed activation state from the revision store — what the control plane has written (or intends to write) to the OpenCode config."
      />
      {!desired ? (
        <p className="omo-sys-note">
          No desired state recorded (revision store unavailable or empty).
        </p>
      ) : (
        <Group>
          <SettingRow
            title="Managed"
            control={<span className="omo-sys-value">{desired.managed ? "Yes" : "No"}</span>}
          />
          <SettingRow
            title="Enabled"
            control={
              desired.enabled ? (
                <span className="pill ok">enabled</span>
              ) : (
                <span className="pill">disabled</span>
              )
            }
          />
          <SettingRow
            title="State"
            control={
              <span
                className={`pill ${
                  desired.stateDisposition === "committed"
                    ? "ok"
                    : desired.stateDisposition === "recovery-pending"
                      ? "warn"
                      : ""
                }`}
              >
                {STATE_DISPOSITION_LABEL[desired.stateDisposition] ?? desired.stateDisposition}
              </span>
            }
          />
          {desired.targetPath ? (
            <SettingRow
              title="Target file"
              control={
                <span className="omo-sys-value omo-mono mux-break">{desired.targetPath}</span>
              }
            />
          ) : null}
          {desired.sourceKind ? (
            <SettingRow
              title="Source kind"
              control={<span className="omo-sys-value omo-mono">{desired.sourceKind}</span>}
            />
          ) : null}
          {desired.registrationTransport ? (
            <SettingRow
              title="Registration transport"
              control={
                <span className="omo-sys-value omo-mono">{desired.registrationTransport}</span>
              }
            />
          ) : null}
          {desired.port !== undefined ? (
            <SettingRow
              title="Port"
              control={<span className="omo-sys-value omo-mono">{desired.port}</span>}
            />
          ) : null}
          {desired.nonceFingerprint ? (
            <SettingRow
              title="Nonce fingerprint"
              control={
                <span className="omo-sys-value omo-mono mux-break">
                  {desired.nonceFingerprint}
                </span>
              }
            />
          ) : null}
          {desired.sourceHash ? (
            <SettingRow
              title="Source hash"
              control={
                <span className="omo-sys-value omo-mono mux-break">{desired.sourceHash}</span>
              }
            />
          ) : null}
          {desired.revisionId ? (
            <SettingRow
              title="Revision id"
              control={
                <span className="omo-sys-value omo-mono mux-break">{desired.revisionId}</span>
              }
            />
          ) : null}
        </Group>
      )}
    </div>
  );
}

function SourceLayer({ status }: { status: TelemetryBridgeStatusDto }) {
  const source = status.source;
  return (
    <div data-testid="bridge-source">
      <SectionIntro
        title="Committed source"
        description="The raw config file on disk that carries the bridge registration, and whether it matches the committed desired state. A committed write that has not been activated yet shows “awaiting restart”."
      />
      {!source ? (
        <p className="omo-sys-note">
          Source not proven yet — effective state has not been captured.
        </p>
      ) : (
        <>
          <Group>
            <SettingRow
              title="Present"
              control={<span className="omo-sys-value">{source.present ? "Yes" : "No"}</span>}
            />
            {source.path ? (
              <SettingRow
                title="Path"
                control={<span className="omo-sys-value omo-mono mux-break">{source.path}</span>}
              />
            ) : null}
            <SettingRow
              title="Format"
              control={<span className="omo-sys-value omo-mono">{source.format}</span>}
            />
            {source.hash ? (
              <SettingRow
                title="Hash"
                control={<span className="omo-sys-value omo-mono mux-break">{source.hash}</span>}
              />
            ) : null}
            <SettingRow
              title="Schema gate"
              control={
                <span
                  className={`pill ${
                    source.schemaGateMode === "proven"
                      ? "ok"
                      : source.schemaGateMode === "committed-awaiting-restart"
                        ? "warn"
                        : "bad"
                  }`}
                >
                  {SCHEMA_GATE_LABEL[source.schemaGateMode] ?? source.schemaGateMode}
                </span>
              }
            />
            {source.sourceKind ? (
              <SettingRow
                title="Source kind"
                control={<span className="omo-sys-value omo-mono">{source.sourceKind}</span>}
              />
            ) : null}
          </Group>
          {source.pluginEntries.length > 0 ? (
            <Group title="Plugin entries">
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th scope="col">Form</th>
                      <th scope="col">Identity</th>
                      <th scope="col">Identity kind</th>
                    </tr>
                  </thead>
                  <tbody>
                    {source.pluginEntries.map((e, i) => (
                      <tr key={`${e.identity}-${i}`}>
                        <td className="mono">{e.form}</td>
                        <td className="mono mux-break">{e.identity}</td>
                        <td className="mono">{e.identityKind}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Group>
          ) : null}
          {status.duplicates.inSource || status.duplicates.inEffective ? (
            <div className="warn-block" data-testid="bridge-duplicates">
              Duplicate bridge entries detected
              {status.duplicates.inSource ? " (in source)" : ""}
              {status.duplicates.inEffective ? " (in effective)" : ""}. Automatic
              removal is blocked — reconcile the config manually.
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function RuntimeLayer({
  status,
  connected,
}: {
  status: TelemetryBridgeStatusDto;
  connected: boolean;
}) {
  // Active connection metadata is shown ONLY when connected.
  return (
    <div data-testid="bridge-runtime">
      <SectionIntro title="Runtime connection / health" />
      <Group>
        <SettingRow
          title="Runtime"
          control={
            <StatusBadge tone={pillToneForRuntime(status.runtime)}>
              {RUNTIME_LABEL[status.runtime] ?? status.runtime}
            </StatusBadge>
          }
        />
        <SettingRow
          title="Compatibility"
          control={
            <span
              className={`pill ${
                status.compatibility === "compatible"
                  ? "ok"
                  : status.compatibility === "incompatible"
                    ? "bad"
                    : ""
              }`}
            >
              {COMPATIBILITY_LABEL[status.compatibility] ?? status.compatibility}
            </span>
          }
        />
        <SettingRow
          title="Backend connected"
          control={<span className="omo-sys-value">{status.backendConnected ? "Yes" : "No"}</span>}
        />
        <SettingRow
          title="OMO ready"
          control={<span className="omo-sys-value">{status.omoReady ? "Yes" : "No"}</span>}
        />
        <SettingRow
          title="Local package"
          control={
            <span className="omo-sys-value">
              {status.localPackageAvailable === true
                ? "Available"
                : status.localPackageAvailable === false
                  ? "Not installed"
                  : "Unknown"}
            </span>
          }
        />
        <SettingRow
          title="Endpoint source"
          control={
            <span className="omo-sys-value">
              {ENDPOINT_SOURCE_LABEL[status.endpointSource] ?? status.endpointSource}
            </span>
          }
        />
      </Group>

      {/* Active connection metadata — only when connected. */}
      {connected ? (
        <Group title="Active connection">
          <div data-testid="bridge-runtime-connected">
            {status.endpoint ? (
              <SettingRow
                title="Endpoint"
                control={
                  <span className="omo-sys-value omo-mono mux-break">{status.endpoint}</span>
                }
              />
            ) : null}
            {status.schemaVersion !== undefined ? (
              <SettingRow
                title="Schema version"
                control={<span className="omo-sys-value omo-mono">{status.schemaVersion}</span>}
              />
            ) : null}
            {status.bridgePackageVersion ? (
              <SettingRow
                title="Bridge package"
                control={
                  <span className="omo-sys-value omo-mono">{status.bridgePackageVersion}</span>
                }
              />
            ) : null}
          </div>
        </Group>
      ) : null}

      {status.error ? (
        <div className="error" role="alert" data-testid="bridge-runtime-error">
          {status.error}
        </div>
      ) : null}
    </div>
  );
}

function LifecycleLayer({ status }: { status: TelemetryBridgeStatusDto }) {
  return (
    <div data-testid="bridge-lifecycle">
      <SectionIntro title="Lifecycle / ownership" />
      <Group>
        <SettingRow
          title="Mode"
          control={<span className="omo-sys-value">{status.mode === "managed" ? "Managed" : "Attach"}</span>}
        />
        <SettingRow
          title="Ownership"
          control={
            <span className="omo-sys-value">
              {status.ownership === "control-plane" ? "Control Plane" : "External"}
            </span>
          }
        />
        <SettingRow
          title="Restart controllable"
          control={
            <span className="omo-sys-value">{status.restartControllable ? "Yes" : "No"}</span>
          }
        />
        <SettingRow
          title="Restart required"
          control={<span className="omo-sys-value">{status.restartRequired ? "Yes" : "No"}</span>}
        />
        {status.restartKind ? (
          <SettingRow
            title="Restart kind"
            control={
              <span className="omo-sys-value">
                {RESTART_KIND_LABEL[status.restartKind] ?? status.restartKind}
              </span>
            }
          />
        ) : null}
        <SettingRow
          title="Generation"
          control={<span className="omo-sys-value omo-mono">{status.generation}</span>}
        />
        <SettingRow
          title="Verification epoch"
          control={<span className="omo-sys-value omo-mono">{status.verificationEpoch}</span>}
        />
      </Group>
    </div>
  );
}

function MetadataLayer({ status }: { status: TelemetryBridgeStatusDto }) {
  const override = status.override;
  const caps = status.capabilities;
  return (
    <div data-testid="bridge-metadata">
      <SectionIntro title="Safe metadata" />
      <Group title="Override (OMO_BRIDGE_BASE_URL)">
        <SettingRow
          title="Present"
          control={<span className="omo-sys-value">{override.present ? "Yes" : "No"}</span>}
        />
        {override.url ? (
          <SettingRow
            title="URL"
            control={<span className="omo-sys-value omo-mono mux-break">{override.url}</span>}
          />
        ) : null}
        {override.port !== undefined ? (
          <SettingRow
            title="Port"
            control={<span className="omo-sys-value omo-mono">{override.port}</span>}
          />
        ) : null}
        <SettingRow
          title="Valid"
          control={<span className="omo-sys-value">{override.invalid ? "No" : "Yes"}</span>}
        />
        {override.invalidReason ? (
          <SettingRow title="Invalid reason" description={override.invalidReason} />
        ) : null}
        <SettingRow
          title="Opts out of management"
          control={
            <span className="omo-sys-value">{override.optsOutOfManagement ? "Yes" : "No"}</span>
          }
        />
      </Group>

      {caps ? (
        <Group title="Capability availability">
          <div data-testid="bridge-capabilities">
            <SettingRow title="Fallback in-progress" control={<span className="omo-sys-value">{caps.fallbackInProgress}</span>} />
            <SettingRow title="Continuation gate" control={<span className="omo-sys-value">{caps.continuationGate}</span>} />
            <SettingRow title="Multiplexer manager" control={<span className="omo-sys-value">{caps.multiplexerManager}</span>} />
            <SettingRow title="cmux store" control={<span className="omo-sys-value">{caps.cmuxStore}</span>} />
            <SettingRow
              title="Runtime preset"
              control={
                <span className="omo-sys-value">
                  {caps.runtimePreset ? "exposed" : "never (module var not exported)"}
                </span>
              }
            />
            <SettingRow
              title="Worker reuse"
              control={
                <span className="omo-sys-value">
                  {caps.workerReuse ? "exposed" : "never (lives inside OMO closure)"}
                </span>
              }
            />
            <SettingRow
              title="Terminal capture"
              control={
                <span className="omo-sys-value">
                  {caps.terminalCapture ? "exposed" : "never (no terminal/PTY/scrollback data)"}
                </span>
              }
            />
          </div>
        </Group>
      ) : null}
    </div>
  );
}

// ── Register / Remove flow ─────────────────────────────────────────────

function RegisterRemoveLayer({
  status,
  onApplied,
}: {
  status: TelemetryBridgeStatusDto;
  onApplied: () => void;
}) {
  const { actions } = status;
  const [operation, setOperation] = useState<"register" | "remove" | null>(null);
  const [preview, setPreview] = useState<BridgePreviewDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<BridgeApplyDto | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [appliedRevision, setAppliedRevision] = useState<string | null>(null);

  // Reset transient state when the DTO changes such that the operation is no
  // longer eligible (e.g. override flipped on, source drifted).
  useEffect(() => {
    if (operation === "register" && !actions.canRegister && !preview) {
      setOperation(null);
    }
    if (operation === "remove" && !actions.canRemove && !preview) {
      setOperation(null);
    }
  }, [actions.canRegister, actions.canRemove, operation, preview]);

  const reset = () => {
    setPreview(null);
    setFormError(null);
    setApplyResult(null);
    setConfirmOpen(false);
  };

  const canRun = operation === "register" ? actions.canRegister : actions.canRemove;

  const runPreview = useCallback(async () => {
    if (!operation || !canRun) return;
    setBusy(true);
    setFormError(null);
    setPreview(null);
    setApplyResult(null);
    setConfirmOpen(false);
    try {
      const r = await fetch("/api/opencode/bridge/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation }),
      });
      const body = (await r.json()) as { ok: boolean; preview?: BridgePreviewDto } | BridgeApiError;
      if (!r.ok || !("ok" in body) || !body.ok || !body.preview) {
        const err = "error" in body ? body.error : { code: "preview-failed", message: `Preview failed (${r.status})` };
        setFormError(`${err.code}: ${err.message}${err.action ? ` — ${err.action}` : ""}`);
        return;
      }
      setPreview(body.preview);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [operation, canRun]);

  const runApply = useCallback(async () => {
    if (!preview || !preview.ok || !operation) return;
    setBusy(true);
    setFormError(null);
    try {
      const r = await fetch("/api/opencode/bridge/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ previewId: preview.previewId, confirmation: operation }),
      });
      const body = (await r.json()) as {
        ok: boolean;
        apply?: BridgeApplyDto;
        restartRequired?: boolean;
        restartAction?: string;
        note?: string;
      } | BridgeApiError;
      if (!r.ok || !("ok" in body) || !body.ok || !body.apply) {
        const err = "error" in body ? body.error : { code: "apply-failed", message: `Apply failed (${r.status})` };
        setFormError(`${err.code}: ${err.message}${err.action ? ` — ${err.action}` : ""}`);
        setConfirmOpen(false);
        return;
      }
      setApplyResult(body.apply);
      setAppliedRevision(body.apply.revisionId ?? null);
      setPreview(null);
      setConfirmOpen(false);
      setOperation(null);
      onApplied();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
      setConfirmOpen(false);
    } finally {
      setBusy(false);
    }
  }, [preview, operation, onApplied]);

  const disabledReasons = useMemo(() => {
    const reasons: string[] = [];
    if (operation === "register" && !actions.canRegister) reasons.push(...actions.reasons);
    if (operation === "remove" && !actions.canRemove) reasons.push(...actions.reasons);
    return reasons;
  }, [actions.canRegister, actions.canRemove, actions.reasons, operation]);

  return (
    <div data-testid="bridge-register-remove">
      <SectionIntro
        title="Register / Remove"
        description={
          <>
            Preview the bridge-only config patch, review the redacted before/after,
            then apply. <strong>Apply never restarts</strong> — activation is a
            separate explicit step below.
          </>
        }
      />
      <div className="omo-sys-pad">
        <ActionBar>
          <Button
            data-testid="bridge-op-register"
            aria-pressed={operation === "register"}
            disabled={busy || !actions.canRegister}
            aria-disabled={!actions.canRegister}
            title={!actions.canRegister ? actions.reasons.join("; ") : undefined}
            onClick={() => {
              reset();
              setOperation("register");
            }}
          >
            Register
          </Button>
          <Button
            data-testid="bridge-op-remove"
            aria-pressed={operation === "remove"}
            disabled={busy || !actions.canRemove}
            aria-disabled={!actions.canRemove}
            title={!actions.canRemove ? actions.reasons.join("; ") : undefined}
            onClick={() => {
              reset();
              setOperation("remove");
            }}
          >
            Remove
          </Button>
        </ActionBar>
      </div>

      {operation && !canRun ? (
        <div className="warn-block" data-testid="bridge-op-disabled">
          {operation === "register" ? "Register" : "Remove"} is not eligible:
          <ul className="omo-sys-list mono">
            {disabledReasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {operation && canRun ? (
        <div className="omo-sys-pad">
          <ActionBar>
            <Button
              data-testid="bridge-preview-btn"
              disabled={busy}
              onClick={() => void runPreview()}
            >
              {busy ? "Working…" : `Preview ${operation}`}
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                reset();
                setOperation(null);
              }}
            >
              Cancel
            </Button>
          </ActionBar>
        </div>
      ) : null}

      {formError ? (
        <div className="error" role="alert" data-testid="bridge-op-error">
          {formError}
        </div>
      ) : null}

      {preview && preview.ok ? (
        <div
          className="omo-sys-preview"
          data-testid="bridge-preview"
          role="status"
          aria-live="polite"
        >
          <div className="section-title">
            Preview — {preview.operation} (redacted)
          </div>
          <dl className="row-kv">
            <dt>Target file</dt>
            <dd className="mono mux-break">{preview.targetPath}</dd>
            <dt>Format</dt>
            <dd className="mono">{preview.targetFormat}</dd>
            <dt>Baseline hash</dt>
            <dd className="mono mux-break">{preview.baselineHash}</dd>
            <dt>Proposed hash</dt>
            <dd className="mono mux-break">{preview.proposedHash}</dd>
            {preview.port !== undefined ? (
              <>
                <dt>Port</dt>
                <dd className="mono">{preview.port}</dd>
              </>
            ) : null}
            {preview.registrationTransport ? (
              <>
                <dt>Registration transport</dt>
                <dd className="mono">{preview.registrationTransport}</dd>
              </>
            ) : null}
            {preview.transportMode ? (
              <>
                <dt>Transport mode</dt>
                <dd className="mono">{preview.transportMode}</dd>
              </>
            ) : null}
            {preview.nonceFingerprint ? (
              <>
                <dt>Nonce fingerprint</dt>
                <dd className="mono mux-break">{preview.nonceFingerprint}</dd>
              </>
            ) : null}
          </dl>

          <div className="section-title">Redacted patch</div>
          <pre className="msg-pre diff-patch">{preview.diff || "(no diff)"}</pre>

          <p className="omo-sys-note">
            <strong>No runtime action will be taken.</strong> Apply writes the
            config only; activation requires a separate explicit restart.
          </p>

          {!confirmOpen ? (
            <ActionBar>
              <Button
                variant="primary"
                data-testid="bridge-apply-btn"
                disabled={busy}
                onClick={() => setConfirmOpen(true)}
              >
                Apply
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  setPreview(null);
                  setOperation(null);
                }}
              >
                Discard preview
              </Button>
            </ActionBar>
          ) : (
            <div className="warn-block" data-testid="bridge-apply-confirm">
              Confirm applying the {preview.operation} operation. This writes
              the bridge registration to{" "}
              <span className="mono">{preview.targetPath}</span> only — no
              restart occurs.
              <ActionBar>
                <Button
                  variant="primary"
                  data-testid="bridge-apply-confirm-btn"
                  disabled={busy}
                  onClick={() => void runApply()}
                >
                  {busy ? "Applying…" : `Confirm ${preview.operation}`}
                </Button>
                <Button disabled={busy} onClick={() => setConfirmOpen(false)}>
                  Cancel
                </Button>
              </ActionBar>
            </div>
          )}
        </div>
      ) : null}

      <div aria-live="polite" role="status" data-testid="bridge-apply-status">
        {applyResult && applyResult.ok ? (
          <div className="info-block">
            Applied — revision{" "}
            <span className="mono">{applyResult.revisionId ?? "—"}</span>
            {applyResult.targetPath ? (
              <>
                {" "}
                written to <span className="mono mux-break">{applyResult.targetPath}</span>
              </>
            ) : null}
            . No runtime action was taken. An explicit restart is required to
            activate the bridge.
          </div>
        ) : null}
      </div>
      {appliedRevision ? null : null}
    </div>
  );
}

// ── Separate restart flow ──────────────────────────────────────────────

function RestartLayer({
  status,
  derivedIntent,
  onRestarted,
}: {
  status: TelemetryBridgeStatusDto;
  derivedIntent: DerivedIntent | null;
  onRestarted: () => void;
}) {
  const { actions, desired } = status;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BridgeRestartResultView | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // Only render the restart control when canRestart is true AND a safe intent
  // can be derived from authoritative actual state. If canRestart is true but
  // derivation is impossible, we report the contract gap instead of inventing
  // a control.
  if (!actions.canRestart) {
    return (
      <div data-testid="bridge-restart">
        <SectionIntro
          title="Restart"
          description="Restart is not eligible. The control plane can only restart the bridge when it owns the lifecycle, a committed config differs from the runtime, and the bridge DB/service is available."
        />
        {actions.reasons.length > 0 ? (
          <ul className="omo-sys-list mono">
            {actions.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : null}
        <div
          aria-live="polite"
          role="status"
          data-testid="bridge-restart-status"
        />
      </div>
    );
  }

  // Build the exact /restart request from the current real DTO/state.
  const buildRequest = (): BridgeRestartRequest | { gap: string } => {
    if (!derivedIntent) {
      return {
        gap:
          "canRestart is true but no safe activate/deactivate/recover intent could be derived from the current desired + runtime state. Report this contract gap — do not invent a control.",
      };
    }
    if (!desired) {
      return { gap: "canRestart is true but the desired state is missing." };
    }
    // expectedGeneration + expectedSourceHash + revisionId are required.
    if (desired.sourceHash === undefined || desired.revisionId === undefined) {
      return {
        gap:
          "canRestart is true but the desired state is missing sourceHash or revisionId — the restart precondition cannot be satisfied.",
      };
    }
    const req: BridgeRestartRequest = {
      intent: derivedIntent.intent,
      expectedGeneration: status.generation,
      expectedSourceHash: desired.sourceHash,
      revisionId: desired.revisionId,
      confirmation: "restart-owned-bridge",
    };
    // nonceFingerprint/port only when the DTO actually exposes them
    // (activate/recover). Omit for deactivate.
    if (derivedIntent.intent !== "deactivate") {
      if (desired.nonceFingerprint !== undefined) {
        req.nonceFingerprint = desired.nonceFingerprint;
      }
      if (desired.port !== undefined) {
        req.port = desired.port;
      }
    }
    return req;
  };

  const runRestart = async () => {
    const built = buildRequest();
    if ("gap" in built) {
      setFormError(built.gap);
      return;
    }
    setBusy(true);
    setFormError(null);
    setResult(null);
    try {
      const r = await fetch("/api/opencode/bridge/restart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(built),
      });
      const body = (await r.json()) as { ok: boolean; restart?: BridgeRestartResultView } | BridgeApiError;
      if (!r.ok || !("ok" in body) || !body.ok || !body.restart) {
        const err = "error" in body ? body.error : { code: "restart-failed", message: `Restart failed (${r.status})` };
        setFormError(`${err.code}: ${err.message}${err.action ? ` — ${err.action}` : ""}`);
        setConfirmOpen(false);
        return;
      }
      setResult(body.restart);
      setConfirmOpen(false);
      onRestarted();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
      setConfirmOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const built = buildRequest();
  const gap = "gap" in built ? built.gap : null;

  return (
    <div data-testid="bridge-restart">
      <SectionIntro
        title="Restart"
        description="A separate, explicit restart activates (or deactivates) the committed registration. Apply never restarts. The restart request is built from the current real DTO/state."
      />

      {derivedIntent ? (
        <Group>
          <SettingRow
            title="Derived intent"
            description={derivedIntent.description}
            control={<span className="pill">{derivedIntent.label}</span>}
          />
        </Group>
      ) : null}

      {gap ? (
        <div className="warn-block" data-testid="bridge-restart-gap">
          {gap}
        </div>
      ) : null}

      {!gap && derivedIntent ? (
        <>
          <dl className="row-kv" data-testid="bridge-restart-request">
            <dt>Intent</dt>
            <dd className="mono">{derivedIntent.intent}</dd>
            <dt>Expected generation</dt>
            <dd className="mono">{status.generation}</dd>
            {desired?.sourceHash ? (
              <>
                <dt>Expected source hash</dt>
                <dd className="mono mux-break">{desired.sourceHash}</dd>
              </>
            ) : null}
            {desired?.revisionId ? (
              <>
                <dt>Revision id</dt>
                <dd className="mono mux-break">{desired.revisionId}</dd>
              </>
            ) : null}
            {derivedIntent.intent !== "deactivate" && desired?.port !== undefined ? (
              <>
                <dt>Port</dt>
                <dd className="mono">{desired.port}</dd>
              </>
            ) : null}
            {derivedIntent.intent !== "deactivate" && desired?.nonceFingerprint ? (
              <>
                <dt>Nonce fingerprint</dt>
                <dd className="mono mux-break">{desired.nonceFingerprint}</dd>
              </>
            ) : null}
          </dl>

          {!confirmOpen ? (
            <div className="omo-sys-pad">
              <ActionBar>
                <Button
                  variant={derivedIntent.intent === "deactivate" ? "secondary" : "primary"}
                  className={
                    derivedIntent.intent === "deactivate" ? "omo-btn-danger" : undefined
                  }
                  data-testid="bridge-restart-btn"
                  disabled={busy}
                  onClick={() => setConfirmOpen(true)}
                >
                  {derivedIntent.label}
                </Button>
              </ActionBar>
            </div>
          ) : (
            <div className="warn-block" data-testid="bridge-restart-confirm">
              Confirm the {derivedIntent.intent} restart. This restarts the
              OpenCode process to apply the committed bridge registration.
              <ActionBar>
                <Button
                  variant={derivedIntent.intent === "deactivate" ? "secondary" : "primary"}
                  className={
                    derivedIntent.intent === "deactivate" ? "omo-btn-danger" : undefined
                  }
                  data-testid="bridge-restart-confirm-btn"
                  disabled={busy}
                  onClick={() => void runRestart()}
                >
                  {busy ? "Restarting…" : `Confirm ${derivedIntent.intent}`}
                </Button>
                <Button disabled={busy} onClick={() => setConfirmOpen(false)}>
                  Cancel
                </Button>
              </ActionBar>
            </div>
          )}
        </>
      ) : null}

      {formError ? (
        <div className="error" role="alert" data-testid="bridge-restart-error">
          {formError}
        </div>
      ) : null}
      <div aria-live="polite" role="status" data-testid="bridge-restart-status">
        {result && result.ok ? (
          <div className="info-block">
            Restart accepted. The backend is coming back up; the status will
            refresh automatically.
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── Restore flow ───────────────────────────────────────────────────────

function RestoreLayer({
  status,
  onRestored,
}: {
  status: TelemetryBridgeStatusDto;
  onRestored: () => void;
}) {
  const { actions, desired } = status;
  const [revisionId, setRevisionId] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BridgeRestoreDto | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // Restore is only actionable when the DTO provides enough valid revision
  // data/eligibility: canRestore + a committed desired state with a revisionId
  // + sourceHash. Otherwise show recovery status / next action without a
  // fake control.
  const eligible =
    actions.canRestore &&
    !!desired &&
    desired.stateDisposition === "committed" &&
    desired.revisionId !== undefined &&
    desired.sourceHash !== undefined;

  if (!actions.canRestore) {
    return (
      <div data-testid="bridge-restore">
        <SectionIntro
          title="Restore"
          description="Restore is not eligible. The control plane can only restore a bridge revision when it owns the lifecycle and the bridge DB/service is available."
        />
        {actions.reasons.length > 0 ? (
          <ul className="omo-sys-list mono">
            {actions.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : null}
        <div aria-live="polite" role="status" data-testid="bridge-restore-status" />
      </div>
    );
  }

  if (!eligible) {
    return (
      <div data-testid="bridge-restore">
        <SectionIntro title="Restore" />
        <div className="warn-block" data-testid="bridge-restore-recovery">
          Restore is eligible in principle, but the current desired state does
          not provide enough valid revision data (revisionId + sourceHash) to
          satisfy the restore precondition.
          {desired ? (
            <div className="omo-sys-quiet">
              State: {STATE_DISPOSITION_LABEL[desired.stateDisposition] ?? desired.stateDisposition}
              {desired.revisionId ? ` · revision ${desired.revisionId}` : " · no revision id"}
              {desired.sourceHash ? " · hash present" : " · no source hash"}.
            </div>
          ) : null}
          <div className="omo-sys-quiet">
            Next action: reconcile the bridge to a committed state, then retry.
          </div>
        </div>
        <div aria-live="polite" role="status" data-testid="bridge-restore-status" />
      </div>
    );
  }

  const runRestore = async () => {
    if (!desired || desired.revisionId === undefined || desired.sourceHash === undefined) return;
    const targetRevision = revisionId.trim() || desired.revisionId;
    setBusy(true);
    setFormError(null);
    setResult(null);
    try {
      const r = await fetch("/api/opencode/bridge/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          revisionId: targetRevision,
          expectedSourceHash: desired.sourceHash,
          confirmation: "restore",
        }),
      });
      const body = (await r.json()) as { ok: boolean; restore?: BridgeRestoreDto } | BridgeApiError;
      if (!r.ok || !("ok" in body) || !body.ok || !body.restore) {
        const err = "error" in body ? body.error : { code: "restore-failed", message: `Restore failed (${r.status})` };
        setFormError(`${err.code}: ${err.message}${err.action ? ` — ${err.action}` : ""}`);
        setConfirmOpen(false);
        return;
      }
      setResult(body.restore);
      setConfirmOpen(false);
      setRevisionId("");
      onRestored();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
      setConfirmOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="bridge-restore">
      <SectionIntro
        title="Restore"
        description="Restore a previously committed bridge revision. The expected source hash is sourced from the current desired state; the revision id defaults to the current committed revision and may be overridden."
      />
      <Group>
        <SettingRow
          title="Expected source hash"
          control={
            <span className="omo-sys-value omo-mono mux-break">{desired?.sourceHash ?? "—"}</span>
          }
        />
        <SettingRow
          title="Current revision"
          control={
            <span className="omo-sys-value omo-mono mux-break">{desired?.revisionId ?? "—"}</span>
          }
        />
        <SettingRow
          stacked
          title="Revision id to restore"
          control={
            <input
              type="text"
              className="mono omo-sys-input-wide"
              value={revisionId}
              placeholder={desired?.revisionId ?? ""}
              onChange={(e) => setRevisionId(e.target.value)}
              aria-label="Revision id to restore"
            />
          }
        />
      </Group>

      {!confirmOpen ? (
        <div className="omo-sys-pad">
          <ActionBar>
            <Button
              data-testid="bridge-restore-btn"
              disabled={busy}
              onClick={() => setConfirmOpen(true)}
            >
              Restore
            </Button>
          </ActionBar>
        </div>
      ) : (
        <div className="warn-block" data-testid="bridge-restore-confirm">
          Confirm restoring revision{" "}
          <span className="mono">{revisionId.trim() || desired?.revisionId || "—"}</span>.
          This rewrites the config to that revision’s snapshot — no restart
          occurs.
          <ActionBar>
            <Button
              variant="primary"
              data-testid="bridge-restore-confirm-btn"
              disabled={busy}
              onClick={() => void runRestore()}
            >
              {busy ? "Restoring…" : "Confirm restore"}
            </Button>
            <Button disabled={busy} onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
          </ActionBar>
        </div>
      )}

      {formError ? (
        <div className="error" role="alert" data-testid="bridge-restore-error">
          {formError}
        </div>
      ) : null}
      <div aria-live="polite" role="status" data-testid="bridge-restore-status">
        {result && result.ok ? (
          <div className="info-block">
            Restored revision{" "}
            <span className="mono">{result.revisionId ?? "—"}</span>. No runtime
            action was taken. An explicit restart is required to apply the
            restored state.
          </div>
        ) : null}
      </div>
    </div>
  );
}