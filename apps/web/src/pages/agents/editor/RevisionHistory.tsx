import { Fragment } from "react";
import type { ConfigRevision } from "@omo/shared";

export function RevisionHistory(props: {
  agent: string;
  open: boolean;
  loading: boolean;
  revisions: ConfigRevision[] | null;
  confirmRevId: string | null;
  restoreBusy: boolean;
  onOpen: () => void;
  onClose: () => void;
  onToggleConfirm: (id: string) => void;
  onRestore: (id: string) => void;
}) {
  return (
    <details className="ame-advanced ame-revisions">
      <summary>Revision history — {props.agent}</summary>
      <div className="card">
        <h2>Revision history — {props.agent}</h2>
        {!props.open ? (
          <button
            type="button"
            className="expand-toggle"
            onClick={() => void props.onOpen()}
          >
            ▸ Show revision history (upsert snapshots for this agent)
          </button>
        ) : (
          <>
            <button
              type="button"
              className="expand-toggle"
              onClick={props.onClose}
            >
              ▾ Hide revision history
            </button>
            {props.loading ? (
              <p className="muted">Loading…</p>
            ) : props.revisions && props.revisions.length > 0 ? (
              <table className="data">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Kind</th>
                    <th>Change</th>
                    <th>File</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {props.revisions.map((r) => (
                    <Fragment key={r.id}>
                      <tr>
                        <td className="mono">
                          {r.timestamp.replace("T", " ").slice(0, 19)}
                        </td>
                        <td>
                          <span className="pill">{r.mutationKind}</span>
                        </td>
                        <td className="mono">
                          {r.oldValue ?? "—"} → {r.newValue ?? "—"}
                        </td>
                        <td className="mono">{r.targetPath}</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-xs"
                            disabled={props.restoreBusy}
                            onClick={() => props.onToggleConfirm(r.id)}
                          >
                            Restore
                          </button>
                        </td>
                      </tr>
                      {props.confirmRevId === r.id ? (
                        <tr>
                          <td colSpan={5}>
                            <div className="warn-block">
                              Restores the <strong>whole file</strong>{" "}
                              <span className="mono">{r.targetPath}</span> to
                              its pre-mutation snapshot — any later changes
                              in that file will be reverted. The live/OpenCode
                              model stays authoritative until reload/session
                              lifecycle.{" "}
                              <button
                                type="button"
                                className="btn btn-xs"
                                disabled={props.restoreBusy}
                                onClick={() => void props.onRestore(r.id)}
                              >
                                Confirm restore
                              </button>{" "}
                              <button
                                type="button"
                                className="btn btn-xs"
                                onClick={() => props.onToggleConfirm(r.id)}
                              >
                                Cancel
                              </button>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted">No recorded revisions for this agent.</p>
            )}
          </>
        )}
      </div>
    </details>
  );
}
