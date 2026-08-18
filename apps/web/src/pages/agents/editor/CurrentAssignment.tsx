import type {
  AgentRow,
  LiveProvider,
  PropertyCandidate,
  ResolvedProperty,
} from "@omo/shared";
import {
  formatModelRef,
  layerAlignment,
  type LayerAlignment,
} from "./model-utils";

/**
 * Human controlling-source label (Preset: name, Root override, Project
 * preset/override). Falls back to raw stage/scope only when the stage
 * has no established human vocabulary here.
 */
export function humanSourceLabel(winner: PropertyCandidate): string {
  switch (winner.stage) {
    case "preset": {
      const scope = winner.scope === "project" ? "Project preset" : "Preset";
      const m = /^presets\.([^.]+)\./.exec(winner.sourcePath);
      return m ? `${scope}: ${m[1]}` : scope;
    }
    case "root-agent":
      return winner.scope === "project" ? "Project override" : "Root override";
    case "project-config":
      return "Project override";
    case "user-config":
      return "User configuration";
    default:
      return `${winner.stage}${winner.scope ? ` · ${winner.scope}` : ""}`;
  }
}

function layerLine(
  label: string,
  model: string | undefined,
  variant: string | undefined,
  providers: readonly LiveProvider[],
  title?: string,
) {
  const ref = formatModelRef(model, providers);
  return (
    <div className="ame-layer">
      <span className="ame-layer-label">{label}</span>
      <div className="ame-layer-body" title={title ?? model ?? ""}>
        <span className="ame-layer-name">
          {ref ? ref.display : "—"}
          {variant ? <span className="ame-layer-variant"> · {variant}</span> : null}
        </span>
        {ref ? (
          <span className="ame-layer-id">
            {ref.provider} · <span className="mono">{ref.id}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}

function alignmentCopy(state: LayerAlignment): string {
  switch (state) {
    case "aligned":
      return "Assigned, effective, and live agree.";
    case "assignment-override":
      return "A higher-precedence config source is overriding the assigned model.";
    case "runtime-drift":
      return "The running session is using a different model than the effective configuration.";
    case "both":
      return "Config override and runtime drift are both present.";
    case "unconfigured":
      return "No model assignment is configured for this agent.";
    case "unconfigured-live":
      return "No configured assignment — only a live runtime model exists.";
    default:
      return "";
  }
}

export function CurrentAssignment(props: {
  agent: string;
  row: AgentRow;
  assigned?: { model?: string; variant?: string; sourcePath?: string };
  provModel: ResolvedProperty | null;
  providers: readonly LiveProvider[];
}) {
  const { row, assigned, providers } = props;
  const alignment = layerAlignment(
    assigned?.model,
    row.effectiveModel,
    row.liveModel,
  );
  const winner = props.provModel?.winner;
  const sourceLabel = winner
    ? humanSourceLabel(winner)
    : assigned?.sourcePath
      ? "configured source"
      : "defaults-only";
  const sourcePath = winner?.sourcePath ?? assigned?.sourcePath;
  const showOverride =
    alignment === "assignment-override" || alignment === "both";
  const showDrift = alignment === "runtime-drift" || alignment === "both";
  const unconfigured =
    alignment === "unconfigured" || alignment === "unconfigured-live";
  // Aligned = fully compressed: one model + compact agreement/source
  // confirmation. The labeled Assigned/Effective/Live layers expand only
  // for override / drift / both / unconfigured.
  const compact = alignment === "aligned";

  return (
    <section className="card ame-section ame-current" aria-labelledby="ame-current-heading">
      <h2 id="ame-current-heading">Current Assignment</h2>
      <p className="ame-current-agent">
        Changing the model for <span className="mono">{props.agent}</span>
      </p>

      {compact ? (
        <div className="ame-aligned">
          {layerLine(
            "Model",
            row.effectiveModel ?? assigned?.model,
            row.effectiveVariant ?? assigned?.variant,
            providers,
            assigned?.sourcePath,
          )}
          <p className="ame-confirm muted">
            Assigned, effective, and live agree · {sourceLabel}
          </p>
          {sourcePath ? (
            <p className="ame-source-path mono">{sourcePath}</p>
          ) : null}
        </div>
      ) : unconfigured ? (
        <div className="ame-progression">
          {alignment === "unconfigured-live"
            ? layerLine("Live", row.liveModel, row.liveVariant, providers)
            : (
              <p className="muted">No assigned, effective, or live model.</p>
            )}
          <p className="ame-confirm muted">{alignmentCopy(alignment)}</p>
        </div>
      ) : (
        <div className="ame-progression">
          {showOverride
            ? layerLine(
                "Configured",
                assigned?.model,
                assigned?.variant,
                providers,
                assigned?.sourcePath,
              )
            : null}
          {layerLine(
            "Effective",
            row.effectiveModel,
            row.effectiveVariant,
            providers,
          )}
          {showDrift
            ? layerLine("Live", row.liveModel, row.liveVariant, providers)
            : null}
          <div className="ame-align-pills">
            {showOverride ? (
              <span className="alignment-pill assignment-override">
                Assignment overridden
              </span>
            ) : null}
            {showDrift ? (
              <span className="alignment-pill runtime-drift">
                Runtime drift
              </span>
            ) : null}
          </div>
          <p className="ame-confirm muted">{alignmentCopy(alignment)}</p>
          {showOverride ? (
            <p className="ame-quiet-note">
              Assignment overridden means a different configuration source
              currently wins — not that the live session drifted on its own.
            </p>
          ) : null}
          {showDrift ? (
            <p className="ame-quiet-note">
              Runtime drift is the live session, not the stored assignment.
              Existing sessions keep their recorded model until reload.
            </p>
          ) : null}
        </div>
      )}

      {/* Labeled layer detail expands only when layers disagree or nothing
          is configured — the aligned summary above already names the one
          model and its source. */}
      {!compact ? (
        <dl className="row-kv ame-current-meta" aria-label="Assignment layers">
          <dt>Assigned</dt>
          <dd title={assigned?.sourcePath ?? ""}>
            {assigned?.model ?? "—"}
            {assigned?.variant ? ` (${assigned.variant})` : ""}
          </dd>
          <dt>Effective</dt>
          <dd>
            {row.effectiveModel ?? "—"}
            {row.effectiveVariant ? ` (${row.effectiveVariant})` : ""}
          </dd>
          <dt>Live</dt>
          <dd>
            {row.liveModel ?? "—"}
            {row.liveVariant ? ` (${row.liveVariant})` : ""}
          </dd>
          <dt>Source</dt>
          <dd>
            {sourceLabel}
            {sourcePath ? (
              <div className="ame-source-path mono">{sourcePath}</div>
            ) : null}
          </dd>
        </dl>
      ) : null}
    </section>
  );
}
