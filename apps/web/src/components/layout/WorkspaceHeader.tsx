import type { ReactNode } from "react";

export function WorkspaceHeader(props: {
  title: string;
  description?: string;
  meta?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="omo-workspace-header">
      <div>
        <h1>{props.title}</h1>
        {props.description ? (
          <p className="omo-workspace-desc">{props.description}</p>
        ) : null}
        {props.meta ? <div className="omo-workspace-meta">{props.meta}</div> : null}
      </div>
      {props.actions ? (
        <div className="omo-workspace-actions">{props.actions}</div>
      ) : null}
    </header>
  );
}
