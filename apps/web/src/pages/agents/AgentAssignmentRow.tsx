/**
 * AgentAssignmentRow — one row in the Team roster.
 *
 * Columns: Agent | Model | Status | Source | Actions.
 *
 * Interaction contract:
 *  - The visible agent-name BUTTON is the only detail opener. The <tr> is
 *    not clickable, has no role/tabIndex — tab sequence is natural:
 *    name → source → fallback/issues → Change Model → Caps/owner link.
 *  - Model compresses to one human line when layers agree; provider is
 *    clearly second, canonical id stays quiet secondary text.
 *    Divergence spends the visual budget: Assigned→Effective for override,
 *    Effective→Live for drift, all three for both. Override uses an arrow;
 *    runtime drift uses a refresh mark. Both stay text-labelled.
 *  - Status merges alignment differences, fallbacks, and adverse probes.
 *    Healthy and never-probed stay blank (no em dash).
 *  - Source is a human button with an independent inline path disclosure
 *    (aria-expanded/aria-controls) that never opens the drawer or touches
 *    the selection URL. Rows matching the group default collapse to a
 *    quiet "more" affordance — the group header states the shared source
 *    and the button's accessible name still carries the real label.
 *  - Actions: Change Model (+Caps secondary) for owned rows; otherwise a
 *    link to the owning workspace (Council / ACP / Config).
 */
import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../../components/ui/Button";
import {
  humanModelName,
  providerLabel,
  type AgentPresentation,
  type ProbeIssue,
} from "./presentation";
import { teamFocusPath } from "../team/session-state";
import { AlignmentStack } from "./team/AlignmentStack";
import { ObserverDisabledNote } from "./team/ObserverDisabledNote";

/**
 * Cross-nav (doc 34): an agent's Effective primary / fallback model links to
 * the selected Models view (`/models?model=<canonical>`). Quiet link styling;
 * navigation never triggers probes or mutations.
 */
function ModelLink(props: {
  model: string | undefined;
  catalogNames?: ReadonlyMap<string, string>;
  className?: string;
}) {
  if (!props.model) return <span>—</span>;
  return (
    <Link
      className={props.className ?? "team-model-link"}
      to={teamFocusPath("/models", { model: props.model })}
      title={props.model}
    >
      {humanModelName(props.model, props.catalogNames)}
    </Link>
  );
}

export function AgentAssignmentRow(props: {
  row: AgentPresentation;
  selected: boolean;
  onOpenDetail: () => void;
  onEdit: () => void;
  onEditCaps?: () => void;
  /** provider/model → OpenCode catalog name. Never invent names. */
  catalogNames?: ReadonlyMap<string, string>;
  /** provider id → display name (when OpenCode supplies one). */
  providerNames?: ReadonlyMap<string, string>;
  /**
   * When true, the source badge is quiet (group header already states the
   * shared default). Path disclosure remains available.
   */
  hideSource?: boolean;
}) {
  const { row } = props;
  const [fallbacksOpen, setFallbacksOpen] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const uid = useId();
  const fallbackListId = `${uid}-fallbacks`;
  const issueListId = `${uid}-issues`;

  const aligned = row.alignment === "aligned";
  const unconfigured =
    row.alignment === "unconfigured" || row.alignment === "unconfigured-live";
  const showLiveLayer =
    row.alignment === "runtime-drift" ||
    row.alignment === "both" ||
    row.alignment === "unconfigured-live";
  const showAssignedLayer =
    row.alignment === "assignment-override" || row.alignment === "both";
  const overridden =
    row.alignment === "assignment-override" || row.alignment === "both";
  const drifted =
    row.alignment === "runtime-drift" || row.alignment === "both";
  const hasStatus =
    overridden ||
    drifted ||
    row.alignment === "unconfigured-live" ||
    row.fallbackCount > 0 ||
    row.probeIssueCount > 0 ||
    row.primaryProbeRunning;

  return (
    <tr
      className={`${aligned ? "aligned-row" : "diverged-row"} ${
        props.selected ? "selected" : ""
      }`}
      data-agent={row.name}
    >
      {/* ── Agent ── name button is the ONLY detail opener. */}
      <td className="team-agent-col">
        <button
          type="button"
          className="agent-name-btn"
          aria-expanded={props.selected}
          aria-controls="agent-detail-drawer"
          data-detail-trigger={row.name}
          onClick={props.onOpenDetail}
        >
          {row.name}
        </button>
        <div className="agent-cell-state">
          {row.isDisabled ? (
            <span className="pill bad">Disabled</span>
          ) : null}
          {row.isCustom ? <span className="pill">Custom</span> : null}
          {row.kind === "native" ? <span className="pill">Native</span> : null}
        </div>
        {row.name === "observer" && row.isDisabled ? (
          <ObserverDisabledNote />
        ) : null}
      </td>

      {/* ── Model ── one line when aligned; layers + cues on divergence. */}
      <td className="team-model-col">
        {aligned ? (
          <div className="model-cell" title={row.effective.model ?? ""}>
            <span className="model-primary">
              <ModelLink
                model={row.effective.model}
                catalogNames={props.catalogNames}
                className="team-model-link model-primary-link"
              />
              {row.effective.variant ? (
                <span className="model-variant">
                  {" · "}
                  {row.effective.variant}
                </span>
              ) : null}
            </span>
            {row.effective.model ? (
              <span className="model-canonical">
                <span className="model-provider">
                  {providerLabel(row.effective.model, props.providerNames)}
                </span>
                {" · "}
                <span className="model-id">{row.effective.model}</span>
              </span>
            ) : null}
          </div>
        ) : unconfigured ? (
          <div className="model-cell">
            {row.alignment === "unconfigured-live" ? (
              <div className="layer">
                <span className="layer-label">Live</span>
                <span className="layer-value" title={row.live.model}>
                  {humanModelName(row.live.model, props.catalogNames)}
                  {row.live.variant ? ` · ${row.live.variant}` : ""}
                </span>
              </div>
            ) : (
              <span className="muted">Unconfigured</span>
            )}
          </div>
        ) : (
          <div className="model-cell">
            <AlignmentStack
              showAssigned={showAssignedLayer}
              showLive={showLiveLayer}
              overridden={overridden}
              drifted={drifted}
              assigned={
                <span title={row.assigned.model}>
                  {humanModelName(row.assigned.model, props.catalogNames)}
                  {row.assigned.variant ? ` · ${row.assigned.variant}` : ""}
                </span>
              }
              effective={
                <span title={row.effective.model}>
                  <ModelLink
                    model={row.effective.model}
                    catalogNames={props.catalogNames}
                    className="team-model-link"
                  />
                  {row.effective.variant ? ` · ${row.effective.variant}` : ""}
                </span>
              }
              live={
                <span title={row.live.model}>
                  {humanModelName(row.live.model, props.catalogNames)}
                  {row.live.variant ? ` · ${row.live.variant}` : ""}
                </span>
              }
            />
          </div>
        )}
      </td>

      {/* ── Status ── alignment + fallbacks + adverse probes. Quiet if none. */}
      <td className="team-status-col">
        <div className="signals-cell team-status-cell">
          {overridden ? (
            <span className="alignment-pill assignment-override">
              Assignment overridden
            </span>
          ) : null}
          {drifted ? (
            <span className="alignment-pill runtime-drift">
              Runtime drift
            </span>
          ) : null}
          {row.alignment === "unconfigured-live" ? (
            <span className="alignment-pill unconfigured-live">
              No assignment (live only)
            </span>
          ) : null}

          {row.fallbackCount > 0 ? (
            <>
              <button
                type="button"
                className="fallback-count"
                onClick={() => setFallbacksOpen((o) => !o)}
                aria-expanded={fallbacksOpen}
                aria-controls={fallbackListId}
                aria-label={`${row.fallbackCount} fallback${row.fallbackCount === 1 ? "" : "s"} configured. Toggle ordered chain.`}
                title="Toggle ordered fallback chain"
              >
                +{row.fallbackCount} fallback{row.fallbackCount === 1 ? "" : "s"}
              </button>
              {fallbacksOpen ? (
                  <div className="fallback-chain" id={fallbackListId}>
                    <strong>Ordered fallback chain</strong>
                    <ol>
                      {row.effective.fallbacks.map((f, i) => (
                        <li key={`${i}-${f}`} title={f}>
                          <ModelLink
                            model={f}
                            catalogNames={props.catalogNames}
                            className="team-model-link"
                          />
                        </li>
                      ))}
                    </ol>
                  </div>
              ) : null}
            </>
          ) : null}

          {row.probeIssueCount > 0 ? (
            <>
              <IssueLine
                issue={row.probeIssues[0]!}
                catalogNames={props.catalogNames}
              />
              {row.probeIssueCount > 1 ? (
                <>
                  <button
                    type="button"
                    className="signal-more"
                    onClick={() => setIssuesOpen((o) => !o)}
                    aria-expanded={issuesOpen}
                    aria-controls={issueListId}
                  >
                    +{row.probeIssueCount - 1} more
                  </button>
                  {issuesOpen ? (
                    <ul className="signal-issue-list" id={issueListId}>
                      {row.probeIssues.slice(1).map((iss, i) => (
                        <li key={`${i}-${iss.model}`}>
                          <IssueLine
                            issue={iss}
                            catalogNames={props.catalogNames}
                          />
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : null}
            </>
          ) : row.primaryProbeRunning ? (
            <span className="signal-testing">Testing</span>
          ) : null}

          {!hasStatus ? <span className="team-status-quiet" /> : null}
        </div>
      </td>

      {/* ── Source ── human label; independent inline path disclosure.
          Folded under Agent at ~1024 via CSS grid on the row. */}
      <td className="team-source-col">
        <SourceDisclosure row={row} suppressed={!!props.hideSource} />
      </td>

      {/* ── Actions ── Change Model (+Caps) for owned rows; workspace links otherwise. */}
      <td className="team-actions-col">
        {row.canEdit ? (
          <div className="agents-row-actions">
            <Button
              variant="secondary"
              size="sm"
              data-edit-trigger={row.name}
              onClick={props.onEdit}
            >
              Change Model
            </Button>
            {props.onEditCaps ? (
              <Button
                size="sm"
                data-caps-trigger={row.name}
                onClick={() => props.onEditCaps?.()}
                aria-label={`Edit capabilities for ${row.name}`}
              >
                Caps
              </Button>
            ) : null}
          </div>
        ) : row.owner === "council" ? (
          <Link className="owner-link" to="/council">
            Managed in Council
          </Link>
        ) : row.owner === "acp" ? (
          <Link className="owner-link" to="/acp">
            Managed in ACP
          </Link>
        ) : row.owner === "native" ? (
          <Link
            className="owner-link"
            to="/config"
            title={row.editHint}
          >
            Managed by OpenCode configuration
          </Link>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
    </tr>
  );
}

function SourceDisclosure(props: {
  row: AgentPresentation;
  suppressed: boolean;
}) {
  const { row, suppressed } = props;
  const [open, setOpen] = useState(false);
  const uid = useId();
  const sourceDetailId = `${uid}-source`;

  return (
    <>
      <button
        type="button"
        className={`source-badge ${sourceBadgeClass(row)}${
          suppressed ? " is-suppressed" : ""
        }`}
        onClick={() => setOpen((o) => !o)}
        title={
          suppressed
            ? `Same as group — ${row.sourceDetail || row.sourceLabel}`
            : row.sourceDetail || row.sourceLabel
        }
        aria-expanded={open}
        aria-controls={sourceDetailId}
        aria-label={`${row.sourceLabel}. Toggle provenance path.`}
      >
        {suppressed ? (
          /* Quiet collapse — the group header states the shared source; the
           * accessible name above still carries the row's real label. */
          <span className="source-more">Same as group</span>
        ) : (
          row.sourceLabel
        )}
      </button>
      {open ? (
        <div className="source-detail" id={sourceDetailId}>
          {row.sourceDetail || row.sourceLabel}
        </div>
      ) : null}
    </>
  );
}

/** One adverse model-health line: label + role + quiet model tail. */
function IssueLine(props: {
  issue: ProbeIssue;
  catalogNames?: ReadonlyMap<string, string>;
}) {
  const { issue } = props;
  return (
    <span
      className={`probe-inline ${issue.class}`}
      title={`${issue.role === "primary" ? "Primary" : "Fallback"} model ${issue.model}: ${issue.label}`}
    >
      {issue.label}
      <span className="probe-inline-model">
        {issue.role === "fallback" ? "fallback " : ""}
        {humanModelName(issue.model, props.catalogNames)}
      </span>
    </span>
  );
}

function sourceBadgeClass(row: AgentPresentation): string {
  if (row.sourceStage === "preset") return "preset";
  if (row.sourceStage === "root-agent") {
    return row.isCustom ? "custom" : "root";
  }
  if (row.sourceStage === "project-config") return "project";
  if (row.sourceStage === "user-config") return "custom";
  if (row.sourceStage === "builtin") return "builtin";
  if (
    row.isBuiltinOmo &&
    (row.name === "council" || row.name === "councillor")
  )
    return "council";
  return "builtin";
}
