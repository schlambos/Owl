/**
 * Accessible full-width group header row. States count and, when one
 * source dominates the group, that default source.
 */
import type { RosterGroup } from "../presentation";

export function RosterGroupHeader(props: {
  group: RosterGroup;
  colSpan: number;
}) {
  const { group, colSpan } = props;
  const countLabel = `${group.rows.length} ${
    group.rows.length === 1 ? "agent" : "agents"
  }`;
  const source = group.defaultSource
    ? group.rows.length > 1
      ? `Default source ${group.defaultSource}`
      : group.defaultSource
    : undefined;

  return (
    <tr className="team-roster-group" data-group={group.id}>
      <th scope="rowgroup" colSpan={colSpan}>
        <span className="team-roster-group-label">{group.label}</span>
        <span className="team-roster-group-count"> · {countLabel}</span>
        {source ? (
          <span className="team-roster-group-source"> · {source}</span>
        ) : null}
      </th>
    </tr>
  );
}
