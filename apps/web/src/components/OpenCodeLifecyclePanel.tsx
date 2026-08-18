import { useCallback, useEffect, useState } from "react";
import type {
  OpenCodeLifecycleReadiness,
  OpenCodeLifecycleState,
  OpenCodeLifecycleStatus,
} from "@omo/shared";
import { Button } from "./ui/Button";
import { StatusBadge } from "./ui/StatusBadge";
import { useRuntime } from "../runtime/RuntimeContext";
import { ServiceHeader, SettingRow, Group } from "../pages/system/SystemPrimitives";

/**
 * Compact human label for a lifecycle status. We deliberately avoid the
 * raw enum names so end users see "Waiting for runtime" rather than
 * "waiting-runtime".
 */
const STATUS_LABEL: Record<OpenCodeLifecycleStatus, string> = {
  initializing: "Initializing",
  starting: "Starting",
  "waiting-health": "Waiting for health",
  "waiting-runtime": "Waiting for runtime",
  connected: "Connected",
  restarting: "Restarting",
  stopped: "Stopped",
  failed: "Failed",
};

const STATUS_TONE: Record<OpenCodeLifecycleStatus, "ok" | "warn" | "bad"> = {
  connected: "ok",
  initializing: "warn",
  starting: "warn",
  "waiting-health": "warn",
  "waiting-runtime": "warn",
  restarting: "warn",
  stopped: "bad",
  failed: "bad",
};

const READINESS_LABEL: Array<[keyof OpenCodeLifecycleReadiness, string]> = [
  ["health", "Health"],
  ["configProviders", "Config / providers"],
  ["providers", "Providers"],
  ["agents", "Agents"],
  ["omo", "OMO"],
  ["rest", "REST"],
  ["sse", "SSE"],
];

const READINESS_COPY = (
  ready: OpenCodeLifecycleReadiness,
  key: keyof OpenCodeLifecycleReadiness,
): string => {
  if (ready[key] === true) return "ready";
  if (key === "omo" && ready.omoExpected === false) return "intentionally off";
  return "not ready";
};

const READINESS_TONE = (
  ready: OpenCodeLifecycleReadiness,
  key: keyof OpenCodeLifecycleReadiness,
): "ok" | "warn" | "bad" => {
  if (key === "omo" && ready.omoExpected === false) return "warn";
  return ready[key] ? "ok" : "bad";
};

/**
 * Build the copy-able `opencode attach <url>` command for a given baseUrl.
 * Returns null when no URL is currently known — surfacing a fake URL would
 * mislead users into pointing their TUI at the wrong backend.
 */
function attachCommand(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  const trimmed = baseUrl.replace(/\/$/, "");
  if (!trimmed) return null;
  return `opencode attach ${trimmed}`;
}

/**
 * OpenCode backend lifecycle panel. Shows the dynamic base URL the control
 * plane is actually talking to, mode (Managed/Attached), ownership
 * (Control Plane/External), readiness stages, restart attempt counter,
 * sanitized failure summary, Basic auth configured marker, and the exact
 * `opencode attach <actual-url>` command for the connected backend.
 *
 * The panel surfaces the same source of truth (lifecycle state) for both
 * Managed and Attached modes but explains the failure modes distinctly:
 *   - Managed failure: backend owned by the control plane failed to start
 *     → user-visible Retry; no implication about an alternate runtime.
 *   - Attach failure: configured external backend unreachable → user-visible
 *     Retry; no managed fallback is implied.
 */
export function OpenCodeLifecyclePanel() {
  const { lifecycle, retryLifecycle, refreshAll } = useRuntime();
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryNotice, setRetryNotice] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );

  const lc: OpenCodeLifecycleState | null = lifecycle;
  const status = lc?.status;
  const statusTone = status ? STATUS_TONE[status] : "bad";
  const statusLabel = status ? STATUS_LABEL[status] : "Unknown";
  const attach = attachCommand(lc?.baseUrl);

  // Reset the copy feedback after a short delay so it never lingers.
  useEffect(() => {
    if (copyState === "idle") return;
    const t = setTimeout(() => setCopyState("idle"), 1800);
    return () => clearTimeout(t);
  }, [copyState]);

  const onCopyAttach = useCallback(async () => {
    if (!attach) return;
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === "function"
      ) {
        await navigator.clipboard.writeText(attach);
        setCopyState("copied");
      } else {
        setCopyState("failed");
      }
    } catch {
      setCopyState("failed");
    }
  }, [attach]);

  const onRetry = useCallback(async () => {
    if (!lc || !lc.error?.retryable) return;
    setRetryBusy(true);
    setRetryNotice(null);
    try {
      const next = await retryLifecycle();
      setRetryNotice(
        next.error
          ? "Retry accepted; awaiting backend update."
          : "Retry accepted.",
      );
      void refreshAll().catch(() => {
        /* ignore transient */
      });
    } catch (e) {
      setRetryNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setRetryBusy(false);
    }
  }, [lc, retryLifecycle, refreshAll]);

  if (!lc) {
    return (
      <div data-testid="lifecycle-panel" data-state="loading">
        <ServiceHeader title="OpenCode backend" description="Loading lifecycle…" />
      </div>
    );
  }

  const isManaged = lc.mode === "managed";
  const isAttached = lc.mode === "attach";
  const isRestarting = lc.status === "restarting";
  const isFailed = lc.status === "failed";
  const retryable = lc.error?.retryable === true;

  return (
    <div
      className="lifecycle-panel"
      data-testid="lifecycle-panel"
      data-mode={lc.mode}
      data-ownership={lc.ownership}
      data-status={lc.status}
    >
      <ServiceHeader
        title="OpenCode backend"
        description="Service status for the OpenCode process the control plane is talking to."
        badges={
          <>
            <StatusBadge tone={statusTone} testId="lifecycle-status">
              {statusLabel}
            </StatusBadge>
            <span
              className="pill"
              data-testid="lifecycle-mode"
              title={
                isManaged
                  ? "Control plane started and owns the OpenCode process"
                  : "Control plane reaches the OpenCode process via OPENCODE_BASE_URL"
              }
            >
              {isManaged ? "Managed" : "Attached"}
            </span>
            <span
              className="pill"
              data-testid="lifecycle-ownership"
              title={
                lc.ownership === "control-plane"
                  ? "Process lifecycle is owned by the control plane"
                  : "Process lifecycle is owned externally"
              }
            >
              {lc.ownership === "control-plane" ? "Control Plane" : "External"}
            </span>
            {lc.authConfigured ? (
              <span className="pill" data-testid="lifecycle-auth">
                Basic auth configured
              </span>
            ) : null}
          </>
        }
        meta={`generation ${lc.generation}`}
      />

      <Group title="Connection">
        <SettingRow
          title="Backend URL"
          control={
            <span className="omo-sys-value omo-mono" data-testid="lifecycle-base-url-value">
              {lc.baseUrl ?? "—"}
            </span>
          }
        />
        {lc.version ? (
          <SettingRow
            title="OpenCode version"
            control={
              <span className="omo-sys-value omo-mono" data-testid="lifecycle-version">
                {lc.version}
              </span>
            }
          />
        ) : null}
        <SettingRow
          title="Project"
          control={<span className="omo-sys-value omo-mono">{lc.projectDirectory || "—"}</span>}
        />
        <SettingRow
          title="Config dir"
          control={<span className="omo-sys-value omo-mono">{lc.configDirectory || "—"}</span>}
        />
        {lc.restart ? (
          <SettingRow
            title="Restart attempt"
            control={
              <span className="omo-sys-value omo-mono" data-testid="lifecycle-restart">
                {lc.restart.attempt}/{lc.restart.maxAttempts}
                {lc.restart.nextRetryAt
                  ? ` · next ${new Date(lc.restart.nextRetryAt).toLocaleTimeString()}`
                  : ""}
              </span>
            }
          />
        ) : null}
      </Group>

      {lc.detail ? <p className="omo-sys-note">{lc.detail}</p> : null}

      <Group title="Readiness">
        <div
          className="omo-sys-readiness"
          role="group"
          aria-label="OpenCode readiness stages"
        >
          {READINESS_LABEL.map(([key, label]) => (
            <span
              key={key}
              className="omo-sys-readiness-row"
              data-testid={`readiness-${key}`}
              data-ready={lc.ready[key] ? "true" : "false"}
            >
              <StatusBadge tone={READINESS_TONE(lc.ready, key)}>
                {READINESS_COPY(lc.ready, key)}
              </StatusBadge>
              <span className="omo-sys-readiness-label">{label}</span>
            </span>
          ))}
        </div>
      </Group>

      {/* Attach command — only meaningful for a live backend: connected
          Managed (control-plane-owned or reused preexisting) and connected
          Attached backends share this exact URL. */}
      {attach && lc.status === "connected" ? (
        <Group title="Use this URL with the TUI">
          <div className="omo-sys-attach">
            <div className="omo-sys-attach-row">
              <code
                className="omo-sys-attach-cmd"
                data-testid="lifecycle-attach-command"
              >
                {attach}
              </code>
              <Button
                data-testid="lifecycle-attach-copy"
                aria-live="polite"
                onClick={() => void onCopyAttach()}
                aria-label="Copy opencode attach command to clipboard"
              >
                {copyState === "copied" ? "Copied" : "Copy attach command"}
              </Button>
            </div>
            <p className="omo-sys-quiet">
              {isAttached
                ? "Sharing this backend: any local opencode session should use Attach with this URL."
                : "Plain opencode would start a separate, independent OpenCode runtime. Attach keeps the TUI on this same runtime."}
            </p>
            <div
              role="status"
              aria-live="polite"
              className="omo-sr-only"
              data-testid="lifecycle-attach-copy-status"
            >
              {copyState === "copied"
                ? `Copied ${attach} to clipboard.`
                : copyState === "failed"
                  ? "Clipboard copy failed — select the command manually."
                  : ""}
            </div>
          </div>
        </Group>
      ) : null}

      {/* Managed-attach failure messaging — distinct copy, distinct implications. */}
      {isFailed ? (
        <div
          className={isManaged ? "error" : "warn-block"}
          data-testid="lifecycle-failure"
          data-mode={lc.mode}
          role="alert"
        >
          <strong>
            {isManaged
              ? "Managed OpenCode failed to start"
              : "Unable to reach configured OpenCode backend"}
          </strong>
          {lc.error?.message ? (
            <div className="mono">{lc.error.message}</div>
          ) : null}
          {lc.error?.action ? (
            <div className="omo-sys-quiet">{lc.error.action}</div>
          ) : null}
          {retryable ? (
            <div className="omo-sys-actions">
              <Button
                variant="primary"
                data-testid="lifecycle-retry"
                onClick={() => void onRetry()}
                disabled={retryBusy}
                aria-label="Retry OpenCode backend"
              >
                {retryBusy ? "Retrying…" : "Retry"}
              </Button>
            </div>
          ) : null}
          {retryNotice ? (
            <div
              role="status"
              aria-live="polite"
              className="omo-sys-quiet"
              data-testid="lifecycle-retry-notice"
            >
              {retryNotice}
            </div>
          ) : null}
        </div>
      ) : isRestarting ? (
        <p className="omo-sys-note" data-testid="lifecycle-restarting-note">
          Restarting rather than stale: the control plane is bringing the
          OpenCode backend back up automatically.
        </p>
      ) : null}

      {/* Live region reserved for screen readers (status changes). */}
      <div
        role="status"
        aria-live="polite"
        className="omo-sr-only"
        data-testid="lifecycle-aria-status"
      >
        OpenCode backend is {statusLabel.toLowerCase()}.
        {isManaged ? " Managed by control plane." : " Attached from external."}
      </div>
    </div>
  );
}
