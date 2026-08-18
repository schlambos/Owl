import { Link } from "react-router-dom";
import { useOmoSchemaStatus } from "../hooks/useOmoSchemaStatus";
import type { SchemaValidationIssue } from "@omo/shared";

function IssueList(props: { issues: SchemaValidationIssue[] }) {
  const shown = props.issues.slice(0, 3);
  return (
    <ul className="mono schema-banner-issues">
      {shown.map((iss, i) => (
        <li key={i}>
          <span>{iss.path || "(root)"}</span> — {iss.message}
        </li>
      ))}
      {props.issues.length > shown.length ? (
        <li className="muted">
          …and {props.issues.length - shown.length} more
        </li>
      ) : null}
    </ul>
  );
}

/**
 * Global invalid-config safety banner. Renders at the top of the app shell:
 *
 * - hard state (user config fails the installed schema): writes are gated
 *   per-edit, but a mutation that repairs the file will preview as valid and
 *   is applyable — the banner is a status warning, never a navigation block.
 * - milder state (schema package unavailable): writes are blocked globally.
 *
 * Hidden while loading, on fetch failure, or when the config is valid.
 */
export function SchemaStatusBanner() {
  const { status } = useOmoSchemaStatus();
  if (!status) return null;

  if (!status.available) {
    return (
      <div
        className="warn-block schema-banner"
        role="alert"
        data-testid="schema-status-banner"
      >
        <strong>Installed OMO-Slim schema unavailable</strong> — configuration
        writes are blocked.
        {status.error ? (
          <span className="muted"> Detail: {status.error}</span>
        ) : null}
      </div>
    );
  }

  if (status.userConfig.valid !== false) return null;

  return (
    <div
      className="error schema-banner schema-banner-invalid"
      role="alert"
      data-testid="schema-status-banner"
    >
      <div>
        <strong>OMO configuration is invalid.</strong>
      </div>
      <div className="schema-banner-copy">
        Configuration writes are disabled until the current file is repaired or
        a proposed mutation produces a schema-valid candidate. You can still
        use the editor — a change that repairs the file will preview as valid
        and can then be applied.
      </div>
      {status.userConfig.issues.length > 0 ? (
        <IssueList issues={status.userConfig.issues} />
      ) : null}
      <div className="schema-banner-action">
        <Link
          to={
            status.userConfig.issues[0]?.path
              ? `/config?tab=raw&sourceId=user-omo&path=${encodeURIComponent(status.userConfig.issues[0].path)}`
              : "/config?tab=raw&sourceId=user-omo"
          }
          className="mono"
        >
          Open Raw Config to repair
        </Link>
      </div>
    </div>
  );
}
