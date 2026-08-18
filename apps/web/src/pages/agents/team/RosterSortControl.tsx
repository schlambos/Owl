/**
 * Compact roster sort control. Explicit sort leaves grouped default order
 * and switches the table to flat comparison mode. Not an enterprise menu.
 */
import type { SortState } from "../presentation";

export const SORT_OPTIONS: ReadonlyArray<{
  id: string;
  label: string;
  sort: SortState | null;
}> = [
  { id: "default", label: "Default", sort: null },
  { id: "name", label: "Agent Name", sort: { key: "name", dir: "asc" } },
  { id: "provider", label: "Provider", sort: { key: "provider", dir: "asc" } },
  { id: "model", label: "Model", sort: { key: "model", dir: "asc" } },
  { id: "source", label: "Source", sort: { key: "source", dir: "asc" } },
  { id: "signals", label: "Issues First", sort: { key: "signals", dir: "asc" } },
];

function optionIdFor(sort: SortState | null): string {
  if (!sort) return "default";
  return SORT_OPTIONS.find((o) => o.sort?.key === sort.key)?.id ?? "default";
}

export function RosterSortControl(props: {
  sort: SortState | null;
  onChange: (sort: SortState | null) => void;
}) {
  const current = optionIdFor(props.sort);
  const canFlip = props.sort != null;

  return (
    <div className="team-roster-sort">
      <label className="team-roster-sort-label" htmlFor="team-roster-sort">
        Sort
      </label>
      <select
        id="team-roster-sort"
        className="team-roster-sort-select"
        value={current}
        onChange={(e) => {
          const next = SORT_OPTIONS.find((o) => o.id === e.target.value);
          props.onChange(next?.sort ?? null);
        }}
      >
        {SORT_OPTIONS.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {canFlip ? (
        <button
          type="button"
          className="team-roster-sort-dir"
          onClick={() => {
            if (!props.sort) return;
            props.onChange({
              key: props.sort.key,
              dir: props.sort.dir === "asc" ? "desc" : "asc",
            });
          }}
          aria-label={
            props.sort!.dir === "asc"
              ? "Sort descending"
              : "Sort ascending"
          }
        >
          <span aria-hidden="true">
            {props.sort!.dir === "asc" ? "Asc" : "Desc"}
          </span>
        </button>
      ) : null}
    </div>
  );
}
