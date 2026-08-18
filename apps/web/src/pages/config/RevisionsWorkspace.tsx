import { Button } from "../../components/ui/Button";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { Surface } from "../../components/ui/Surface";
import { formatTimestamp } from "../../format";
import { OmoMonacoDiff } from "../../monaco/OmoMonacoEditor";
import { shortHash, type OmoRevisionDetail, type OmoRevisionListItem } from "./raw-contract";

export function RevisionsWorkspace(props: {
  items: OmoRevisionListItem[];
  selected: OmoRevisionDetail | null;
  busy: boolean;
  restorePreviewOk: boolean;
  onSelect: (id: string) => void;
  onPreviewRestore: () => void;
  onRestore: () => void;
}) {
  return (
    <div className="omo-config-stack" data-testid="config-revisions">
      <div className="omo-config-table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>When</th>
              <th>Kind</th>
              <th>Hashes</th>
              <th>Restore</th>
            </tr>
          </thead>
          <tbody>
            {props.items.map((item) => (
              <tr key={item.id}>
                <td>
                  <button
                    type="button"
                    className="linkish"
                    data-testid={`config-revision-${item.id}`}
                    onClick={() => props.onSelect(item.id)}
                  >
                    {formatTimestamp(item.timestamp) || item.id}
                  </button>
                </td>
                <td className="omo-mono">{item.kindLabel || item.mutationKind || "—"}</td>
                <td className="omo-mono">
                  <span title={item.oldHash} translate="no">
                    {shortHash(item.oldHash)}
                  </span>
                  {" → "}
                  <span title={item.newHash} translate="no">
                    {shortHash(item.newHash)}
                  </span>
                </td>
                <td>
                  {item.restoreEligible ? (
                    <StatusBadge tone="ok">eligible</StatusBadge>
                  ) : (
                    <StatusBadge tone="warn">unavailable</StatusBadge>
                  )}
                </td>
              </tr>
            ))}
            {props.items.length === 0 ? (
              <tr>
                <td colSpan={4} className="omo-config-empty">
                  No committed OMO revisions for this source.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {props.selected ? (
        <Surface className="omo-config-revision omo-config-surface" data-testid="config-revision-detail">
          <h2>Revision {props.selected.id}</h2>
          <dl className="omo-config-kv">
            <dt>Target</dt>
            <dd className="omo-mono omo-config-break" title={props.selected.path}>
              {props.selected.path}
            </dd>
            <dt>Schema</dt>
            <dd className="omo-mono">
              {props.selected.schemaPackageVersion ?? "—"} ·{" "}
              <span title={props.selected.schemaHash ?? undefined} translate="no">
                {shortHash(props.selected.schemaHash)}
              </span>
            </dd>
            <dt>Restore</dt>
            <dd>
              {props.selected.restoreEligible
                ? "eligible against the current schema"
                : "unavailable — historical text remains inspectable"}
            </dd>
          </dl>
          <OmoMonacoDiff
            originalUri={`inmemory://omo-control/revision/${props.selected.id}/before`}
            original={props.selected.beforeContent}
            modifiedUri={`inmemory://omo-control/revision/${props.selected.id}/after`}
            modified={props.selected.afterContent}
            ariaLabel={`Revision ${props.selected.id} before and after`}
            testId="config-revision-diff"
          />
          <div className="omo-config-actions">
            <Button
              data-testid="config-restore-preview"
              disabled={props.busy || !props.selected.restoreEligible}
              onClick={props.onPreviewRestore}
            >
              Restore Preview
            </Button>
            <Button
              variant="primary"
              data-testid="config-restore"
              disabled={props.busy || !props.restorePreviewOk || !props.selected.restoreEligible}
              onClick={props.onRestore}
            >
              Restore
            </Button>
          </div>
        </Surface>
      ) : null}
    </div>
  );
}
