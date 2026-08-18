/**
 * Quiet always-visible key for Assigned / Effective / Live.
 * Plain language only — no new semantics.
 */
export function RosterLegend() {
  return (
    <p className="team-roster-legend">
      <span className="team-roster-legend-title">How to read a row</span>
      <span>
        <strong>Assigned</strong> is what you configured.
      </span>
      <span>
        <strong>Effective</strong> is what OMO actually resolves.
      </span>
      <span>
        <strong>Live</strong> is what OpenCode is running now.
      </span>
    </p>
  );
}
