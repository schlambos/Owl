/**
 * Diverged Assigned / Effective / Live stack.
 *
 * Override uses an arrow (Assigned → Effective). Runtime drift uses a
 * refresh mark (Effective ↻ Live). Both stay text-labelled so color is
 * never the only cue. No emoji decoration.
 */
import type { ReactNode } from "react";

export function AlignmentStack(props: {
  assigned?: ReactNode;
  effective?: ReactNode;
  live?: ReactNode;
  showAssigned: boolean;
  showLive: boolean;
  overridden: boolean;
  drifted: boolean;
}) {
  return (
    <div className="team-align-stack">
      {props.showAssigned ? (
        <div className="layer team-align-layer">
          <span className="layer-label">Assigned</span>
          <span className="layer-value">{props.assigned}</span>
        </div>
      ) : null}
      {props.showAssigned && props.overridden ? (
        <div className="team-align-cue is-override">
          <span aria-hidden="true" className="team-align-symbol">
            →
          </span>
          <span className="team-align-cue-text">Assignment overridden</span>
        </div>
      ) : null}
      <div className="layer team-align-layer">
        <span className="layer-label">Effective</span>
        <span className="layer-value">{props.effective}</span>
      </div>
      {props.showLive && props.drifted ? (
        <div className="team-align-cue is-drift">
          <span aria-hidden="true" className="team-align-symbol">
            ↻
          </span>
          <span className="team-align-cue-text">Runtime drift</span>
        </div>
      ) : null}
      {props.showLive ? (
        <div className="layer team-align-layer">
          <span className="layer-label">Live</span>
          <span className="layer-value">{props.live}</span>
        </div>
      ) : null}
    </div>
  );
}
