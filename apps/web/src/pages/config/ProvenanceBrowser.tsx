import { useMemo, useState } from "react";
import type { ConfigSourceInventoryItem, ResolvedProperty } from "@omo/shared";
import { StatusBadge } from "../../components/ui/StatusBadge";

export interface ProvenancePayload {
  sources: ConfigSourceInventoryItem[];
  properties: Record<string, ResolvedProperty>;
  warnings: Array<{ level?: string; kind: string; message: string; path?: string }>;
  runtimePreset?: { known: boolean; note: string };
  preset?: string;
}

export function fmtVal(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export function ProvenanceBrowser(props: {
  data: ProvenancePayload | null;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const paths = useMemo(
    () =>
      Object.keys(props.data?.properties ?? {})
        .filter((p) => !filter || p.toLowerCase().includes(filter.toLowerCase()))
        .sort(),
    [props.data, filter],
  );
  const prop = props.selected && props.data ? props.data.properties[props.selected] : null;

  if (!props.data) {
    return <p className="omo-config-quiet">Loading provenance…</p>;
  }

  return (
    <div className="omo-config-split" data-testid="config-provenance-browser">
      <aside className="omo-config-side">
        <label className="omo-config-source" htmlFor="config-provenance-filter">
          <span className="omo-sr-only">Filter property path</span>
          <input
            id="config-provenance-filter"
            className="omo-config-filter"
            name="config-provenance-filter"
            type="search"
            autoComplete="off"
            spellCheck={false}
            placeholder="Filter property path…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </label>
        <div className="omo-config-list">
          {paths.map((p) => (
            <button
              key={p}
              type="button"
              className="omo-config-row"
              aria-current={props.selected === p ? "true" : undefined}
              onClick={() => props.onSelect(p)}
            >
              <span className="omo-config-row-path" title={p}>
                {p}
              </span>
              <StatusBadge>{props.data?.properties[p]?.winner.stage}</StatusBadge>
            </button>
          ))}
        </div>
      </aside>
      <section className="omo-config-pane">
        {!prop ? (
          <p className="omo-config-quiet">Select a property path.</p>
        ) : (
          <div className="omo-config-detail">
            <h2 className="omo-config-detail-title omo-mono">{prop.path}</h2>
            <dl className="omo-config-kv">
              <dt>Effective</dt>
              <dd className="omo-mono">
                <pre className="omo-config-pre">{fmtVal(prop.value)}</pre>
              </dd>
              <dt>Winner stage</dt>
              <dd>
                <StatusBadge tone="ok">{prop.winner.stage}</StatusBadge>
              </dd>
              <dt>Source path</dt>
              <dd className="omo-mono omo-config-break">{prop.winner.sourcePath}</dd>
              <dt>Source</dt>
              <dd className="omo-mono">{prop.winner.sourceLabel}</dd>
              <dt>Reason</dt>
              <dd>{prop.reason}</dd>
            </dl>
            <div className="omo-config-kicker">Candidates (low → high priority)</div>
            <div className="omo-config-table-wrap omo-config-table-wrap-inset">
              <table className="data">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Stage</th>
                    <th>Source path</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {[...prop.overridden].reverse().concat([prop.winner]).map((c, i) => (
                    <tr key={i}>
                      <td>{i + 1}</td>
                      <td>
                        <StatusBadge tone={c === prop.winner ? "ok" : "neutral"}>
                          {c.stage}
                          {c === prop.winner ? " WIN" : ""}
                        </StatusBadge>
                      </td>
                      <td className="omo-mono omo-config-break">{c.sourcePath}</td>
                      <td className="omo-mono omo-config-break">{fmtVal(c.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
