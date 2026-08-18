import { useEffect, useId, useRef, useState } from "react";
import type {
  OpenCodeLifecycleMode,
  OpenCodeLifecycleOwnership,
  OpenCodeLifecycleStatus,
  RuntimeConnection,
} from "@omo/shared";
import { useRuntime } from "../runtime/RuntimeContext";
import { Button } from "./ui/Button";
import { StatusBadge } from "./ui/StatusBadge";
import { StatusDot, type StatusTone } from "./ui/StatusDot";

function ago(iso?: string): string {
  if (!iso) return "—";
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms) || ms < 0) return "—";
  if (ms < 1000) return "just now";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3600_000)}h ago`;
}

function pillFor(state: string): StatusTone {
  if (state === "connected" || state === "live") return "ok";
  if (state === "connecting" || state === "reconnecting") return "warn";
  return "bad";
}

function labelRest(c: RuntimeConnection): string {
  if (c.rest === "connected") return "Connected";
  if (c.rest === "connecting") return "Connecting";
  if (c.rest === "reconnecting") return "Reconnecting";
  return "Disconnected";
}

function labelSse(c: RuntimeConnection): string {
  if (c.sse === "connected") return "Live";
  if (c.sse === "connecting") return "Connecting";
  if (c.sse === "reconnecting") return "Reconnecting";
  return "Disconnected";
}

function lifecyclePill(status: OpenCodeLifecycleStatus): StatusTone {
  switch (status) {
    case "connected":
      return "ok";
    case "starting":
    case "initializing":
    case "waiting-health":
    case "waiting-runtime":
    case "restarting":
      return "warn";
    case "failed":
    case "stopped":
      return "bad";
  }
}

const LIFECYCLE_STATUS_LABEL: Record<OpenCodeLifecycleStatus, string> = {
  initializing: "Initializing",
  starting: "Starting",
  "waiting-health": "Waiting for health",
  "waiting-runtime": "Waiting for runtime",
  connected: "Connected",
  restarting: "Restarting",
  stopped: "Stopped",
  failed: "Failed",
};

const MODE_LABEL: Record<OpenCodeLifecycleMode, string> = {
  managed: "Managed",
  attach: "Attached",
};

const OWNERSHIP_LABEL: Record<OpenCodeLifecycleOwnership, string> = {
  "control-plane": "Control Plane",
  external: "External",
};

function compactStatus(
  status: OpenCodeLifecycleStatus | undefined,
  rest: RuntimeConnection["rest"],
): "Connected" | "Restarting" | "Failed" {
  if (status === "restarting") return "Restarting";
  if (status === "failed" || status === "stopped") return "Failed";
  if (status === "connected" || rest === "connected") return "Connected";
  if (
    status === "starting" ||
    status === "initializing" ||
    status === "waiting-health" ||
    status === "waiting-runtime"
  ) {
    return "Restarting";
  }
  return "Failed";
}

function compactTone(
  label: ReturnType<typeof compactStatus>,
): StatusTone {
  if (label === "Connected") return "ok";
  if (label === "Restarting") return "warn";
  return "bad";
}

/**
 * Compact OpenCode connection trigger + popover.
 *
 * The trigger is `OpenCode · Connected/Restarting/Failed`. The popover keeps
 * the previous ConnectionBar lifecycle/mode/ownership/URL/REST/SSE/control
 * SSE/stale/timestamps/session count/Reconcile surface.
 */
export function ConnectionBar() {
  const {
    connection,
    cpSse,
    lastCpEventAt,
    reconcile,
    runtime,
    lifecycle,
  } = useRuntime();
  const c = connection;
  const status = lifecycle?.status;
  const pillTone = status ? lifecyclePill(status) : null;
  const statusLabel = status
    ? LIFECYCLE_STATUS_LABEL[status]
    : c.rest === "connected"
      ? "Online"
      : "Offline";
  const modeLabel = lifecycle ? MODE_LABEL[lifecycle.mode] : null;
  const ownershipLabel = lifecycle ? OWNERSHIP_LABEL[lifecycle.ownership] : null;
  const compact = compactStatus(status, c.rest);
  const compactToneValue = compactTone(compact);

  const dynamicUrl =
    lifecycle?.baseUrl ?? runtime?.baseUrl ?? c.opencodeBaseUrl ?? "";
  const restartInfo = lifecycle?.restart;

  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        wrapRef.current?.contains(event.target)
      ) {
        return;
      }
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="omo-conn-wrap" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="omo-conn-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        data-testid="connection-trigger"
      >
        <StatusDot tone={compactToneValue} />
        <span className="omo-conn-trigger-label">OpenCode · {compact}</span>
      </button>
      {open ? (
      <div
        id={panelId}
        role="dialog"
        aria-label="OpenCode connection"
        className="omo-conn-popover"
      >
          <div className="conn-bar" data-testid="connection-bar">
            <div className="omo-conn-panel">
              <div className="omo-conn-head conn-items">
                <span className="conn-label">OpenCode</span>
                {pillTone ? (
                  <StatusBadge
                    tone={pillTone}
                    testId="lifecycle-status-pill"
                    title={
                      restartInfo
                        ? `Restart attempt ${restartInfo.attempt}/${restartInfo.maxAttempts}`
                        : undefined
                    }
                  >
                    {statusLabel}
                  </StatusBadge>
                ) : (
                  <StatusBadge tone={c.rest === "connected" ? "ok" : "bad"}>
                    {statusLabel}
                  </StatusBadge>
                )}
                {modeLabel ? (
                  <span
                    className="omo-badge"
                    data-testid="lifecycle-mode-pill"
                    title={
                      lifecycle?.mode === "managed"
                        ? "OpenCode process is started and owned by the control plane"
                        : "OpenCode is reached via OPENCODE_BASE_URL — the control plane does not own its lifecycle"
                    }
                  >
                    {modeLabel}
                  </span>
                ) : null}
                {ownershipLabel ? (
                  <span
                    className="omo-badge"
                    data-testid="lifecycle-ownership-pill"
                    title={
                      lifecycle?.ownership === "control-plane"
                        ? "Backend process lifecycle is owned by the control plane"
                        : "Backend lifecycle is owned by an external process"
                    }
                  >
                    {ownershipLabel}
                  </span>
                ) : null}
                {status === "restarting" && restartInfo ? (
                  <StatusBadge
                    tone="warn"
                    testId="lifecycle-restart-pill"
                    title={
                      restartInfo.nextRetryAt
                        ? `Next attempt at ${new Date(restartInfo.nextRetryAt).toLocaleTimeString()}`
                        : "Backend is being restarted by the control plane"
                    }
                  >
                    Restart {restartInfo.attempt}/{restartInfo.maxAttempts}
                  </StatusBadge>
                ) : null}
                {status === "failed" ? (
                  <StatusBadge
                    tone="bad"
                    testId="lifecycle-failed-pill"
                    title={lifecycle?.error?.message ?? "OpenCode backend failed"}
                  >
                    Backend failed
                  </StatusBadge>
                ) : null}
              </div>

              <dl className="omo-conn-rows">
                <div className="omo-conn-row">
                  <dt>REST</dt>
                  <dd>
                    <StatusBadge tone={pillFor(c.rest)}>
                      {labelRest(c)}
                    </StatusBadge>
                  </dd>
                </div>
                <div className="omo-conn-row">
                  <dt>SSE</dt>
                  <dd>
                    <StatusBadge tone={pillFor(c.sse)}>
                      {labelSse(c)}
                    </StatusBadge>
                  </dd>
                </div>
                <div className="omo-conn-row">
                  <dt>Control plane</dt>
                  <dd>
                    <StatusBadge tone={pillFor(cpSse)}>
                      {cpSse === "live" ? "Live" : cpSse}
                    </StatusBadge>
                  </dd>
                </div>
                <div className="omo-conn-row">
                  <dt>URL</dt>
                  <dd
                    className="omo-mono conn-meta"
                    data-testid="lifecycle-base-url"
                  >
                    {dynamicUrl || "—"}
                  </dd>
                </div>
                <div className="omo-conn-row">
                  <dt>Stale</dt>
                  <dd>{c.stale ? "Yes" : "No"}</dd>
                </div>
                <div className="omo-conn-row">
                  <dt>Last OC event</dt>
                  <dd className="omo-mono conn-meta">{ago(c.lastEventAt)}</dd>
                </div>
                <div className="omo-conn-row">
                  <dt>Reconciled</dt>
                  <dd className="omo-mono conn-meta">
                    {ago(c.lastReconcileAt)}
                  </dd>
                </div>
                <div className="omo-conn-row">
                  <dt>UI event</dt>
                  <dd className="omo-mono conn-meta">{ago(lastCpEventAt)}</dd>
                </div>
                {runtime ? (
                  <div className="omo-conn-row">
                    <dt>Sessions</dt>
                    <dd className="omo-mono conn-meta">{runtime.sessions.total}</dd>
                  </div>
                ) : null}
              </dl>

              <div className="omo-conn-actions">
                <Button onClick={() => void reconcile()}>Reconcile</Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
