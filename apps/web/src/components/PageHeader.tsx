import { WorkspaceHeader } from "./layout/WorkspaceHeader";
import { Button } from "./ui/Button";

export function PageHeader(props: {
  title: string;
  meta?: string;
  onRefresh?: () => void;
  loading?: boolean;
}) {
  return (
    <WorkspaceHeader
      title={props.title}
      meta={props.meta}
      actions={
        props.onRefresh ? (
          <Button onClick={props.onRefresh} disabled={props.loading}>
            {props.loading ? "Loading…" : "Refresh"}
          </Button>
        ) : null
      }
    />
  );
}
