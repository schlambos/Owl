import type { ModelProbeState, ModelProbeSummary } from "@omo/shared";

/**
 * Compact probe-state badge. Color is never the only signal: the state text
 * is always rendered. Freshness is a separate subtle label — it never bleeds
 * into the health color.
 */

const STATE_META: Record<ModelProbeState, { label: string; cls: string }> = {
  never: { label: "Not tested", cls: "" },
  running: { label: "Running", cls: "run" },
  healthy: { label: "Healthy", cls: "ok" },
  unauthorized: { label: "Unauthorized", cls: "bad" },
  "model-not-found": { label: "Model not found", cls: "bad" },
  "rate-limited": { label: "Rate limited", cls: "warn" },
  timeout: { label: "Timeout", cls: "warn" },
  "provider-disconnected": { label: "Provider disconnected", cls: "muted" },
  "opencode-disconnected": { label: "OpenCode disconnected", cls: "muted" },
  malformed: { label: "Malformed response", cls: "muted" },
  error: { label: "Error", cls: "muted" },
};

/** Short relative label, e.g. "14m ago". Matches ConnectionBar's convention. */
export function probeAgo(iso?: string): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const ms = Date.now() - t;
  if (ms < 0) return "just now";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function probeStateLabel(state: ModelProbeState): string {
  return STATE_META[state].label;
}

export function ProbeBadge(props: {
  probe: ModelProbeSummary;
  /** Include "· 812ms" inside the badge. Default true. */
  showLatency?: boolean;
  /** Include a separate freshness label ("14m ago" / "stale"). Default true. */
  showFreshness?: boolean;
  /**
   * Render the unprobed state as a quiet em dash instead of a filled badge.
   * For dense inventory rows where "Not tested" repeated across every row
   * reads as status noise; the label stays available to screen readers and
   * via the title tooltip. Other states render exactly as usual.
   */
  unprobedQuiet?: boolean;
}) {
  const { probe } = props;
  const showLatency = props.showLatency ?? true;
  const showFreshness = props.showFreshness ?? true;
  const meta = STATE_META[probe.state];

  if (props.unprobedQuiet && probe.state === "never") {
    return (
      <span className="probe-wrap" title="Probe state: not tested">
        <span className="probe-unprobed" aria-hidden="true">
          —
        </span>
        <span className="omo-sr-only">Not tested</span>
      </span>
    );
  }

  const parts: string[] = [meta.label];
  if (showLatency && probe.latencyMs != null) {
    parts.push(`${probe.latencyMs}ms`);
  }
  // Status/error codes only add signal for non-healthy outcomes.
  if (probe.state !== "healthy" && probe.state !== "running") {
    if (probe.statusCode != null) parts.push(String(probe.statusCode));
    else if (probe.errorCode) parts.push(probe.errorCode);
  }
  const text = parts.join(" · ");

  const freshLabel =
    probe.freshness === "stale"
      ? "stale"
      : probe.freshness === "fresh"
        ? probeAgo(probe.lastCompletedAt ?? probe.lastStartedAt)
        : null;

  const titleParts: string[] = [`Probe state: ${meta.label.toLowerCase()}`];
  if (probe.statusCode != null) titleParts.push(`status ${probe.statusCode}`);
  if (probe.errorCode) titleParts.push(`code ${probe.errorCode}`);
  if (probe.errorMessage) titleParts.push(probe.errorMessage);
  if (probe.responseModel) titleParts.push(`responded as ${probe.responseModel}`);
  if (freshLabel) titleParts.push(freshLabel);

  return (
    <span className="probe-wrap">
      <span
        className={`probe-badge ${meta.cls}`.trim()}
        title={titleParts.join(" · ")}
        aria-label={titleParts.join(", ")}
      >
        {probe.state === "running" ? (
          <span className="dot pulse" aria-hidden="true" />
        ) : null}
        {text}
      </span>
      {showFreshness && freshLabel ? (
        <span className="probe-freshness">{freshLabel}</span>
      ) : null}
    </span>
  );
}
