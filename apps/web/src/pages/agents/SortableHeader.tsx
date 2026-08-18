/**
 * SortableHeader — a single `<th>` containing a sort button.
 *
 * Indicators are text (▲/▼) plus an `aria-sort` on the active column.
 * No color-only signals. Each header is its own column with its own
 * sort key and its own click cycle (none → asc → desc → none).
 */
import type { SortDir, SortKey, SortState } from "./presentation";

export function SortableHeader(props: {
  /** Stable id for the column (used in tests / aria-sort). */
  columnId: string;
  /** Visible column label. */
  label: string;
  /** This column's sort key. */
  sortKey: SortKey;
  /** Current sort state (null = default order). */
  sort: SortState | null;
  onSort: (key: SortKey) => void;
}) {
  const { sortKey, sort, onSort, label, columnId } = props;
  const isActive = sort?.key === sortKey;
  const ariaSort: "ascending" | "descending" | "none" = isActive
    ? sort!.dir === "asc"
      ? "ascending"
      : "descending"
    : "none";

  return (
    <th aria-sort={ariaSort} data-column={columnId}>
      <button
        type="button"
        className="sort-btn"
        onClick={() => onSort(sortKey)}
        aria-label={ariaLabel(label, sortKey, sort)}
      >
        {label}
        <SortIndicator
          visible={isActive}
          dir={isActive ? sort!.dir : null}
        />
      </button>
    </th>
  );
}

function ariaLabel(
  label: string,
  key: SortKey,
  sort: SortState | null,
): string {
  const isActive = sort?.key === key;
  if (!isActive) return `Sort by ${label.toLowerCase()}`;
  const dirText = sort!.dir === "asc" ? "ascending" : "descending";
  const next =
    sort!.dir === "asc" ? "sort descending" : "restore default order";
  return `${label}, sorted ${dirText}. Click to ${next}.`;
}

function SortIndicator(props: {
  visible: boolean;
  dir: SortDir | null;
}) {
  if (!props.visible) {
    return (
      <span className="sort-indicator" aria-hidden="true">
        ·
      </span>
    );
  }
  return (
    <span className="sort-indicator active" aria-hidden="true">
      {props.dir === "asc" ? "▲" : "▼"}
    </span>
  );
}