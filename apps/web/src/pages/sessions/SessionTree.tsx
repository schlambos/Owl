import type { LiveSession } from "@omo/shared";
import { StatusDot, type StatusTone } from "../../components/ui/StatusDot";

/** Session status label → quiet tone (idle healthy, busy/retry active, error). */
export function statusTone(status?: string): StatusTone {
  if (!status || status === "idle") return "ok";
  if (status === "busy" || status === "retry") return "warn";
  if (status === "error") return "bad";
  return "neutral";
}

function statusTextClass(status?: string): string {
  const tone = statusTone(status);
  return `omo-sess-status ${tone !== "neutral" ? tone : ""}`;
}

function TreeNode(props: {
  s: LiveSession;
  depth: number;
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const { s, depth, selectedId, onSelect } = props;
  const selected = s.id === selectedId;
  const st = s.status ?? "idle";
  return (
    <div>
      <button
        type="button"
        role="option"
        className="omo-sess-row"
        data-depth={depth}
        aria-selected={selected}
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(s.id)}
      >
        <StatusDot tone={statusTone(st)} />
        <span className="omo-sess-row-title">
          {s.agent ? `${s.agent}` : "session"}
          {s.parentID ? "" : " · root"}
        </span>
        <span className="omo-sess-row-meta">
          {(s.title || s.id).slice(0, 42)}
          {(s.title || s.id).length > 42 ? "…" : ""}
        </span>
        {s.controlPlaneProbe ? (
          <span className="omo-badge" title="Control-plane model probe session">
            CP probe
          </span>
        ) : null}
        <span className={statusTextClass(st)}>{st}</span>
      </button>
      {s.children?.map((c) => (
        <TreeNode
          key={c.id}
          s={c}
          depth={depth + 1}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

export function SessionTree(props: {
  roots: LiveSession[];
  selectedId?: string;
  onSelect: (id: string) => void;
  filter: string;
}) {
  const needle = props.filter.trim().toLowerCase();

  const filterTree = (nodes: LiveSession[]): LiveSession[] => {
    if (!needle) return nodes;
    const match = (s: LiveSession): boolean => {
      const hay = [s.id, s.title, s.agent, s.status, s.directory, s.model?.id]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(needle) || (s.children?.some(match) ?? false);
    };
    return nodes
      .map((n) => ({
        ...n,
        children: n.children ? filterTree(n.children) : [],
      }))
      .filter((n) => match(n) || (n.children && n.children.length > 0));
  };

  const roots = filterTree(props.roots);

  return (
    <nav className="omo-sess-tree" aria-label="Session tree">
      <div role="listbox" aria-label="Sessions">
        {roots.map((s) => (
          <TreeNode
            key={s.id}
            s={s}
            depth={0}
            selectedId={props.selectedId}
            onSelect={props.onSelect}
          />
        ))}
        {roots.length === 0 ? (
          <div className="omo-sess-tree-empty">No sessions.</div>
        ) : null}
      </div>
    </nav>
  );
}
