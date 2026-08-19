/**
 * Manage providers (/providers/manage) — desired + live joined by id.
 * Per-provider: connection/auth presence, config footprint, enablement
 * switch (via simulate → apply), project-masked and enable/disable-conflict
 * warnings, and links into the edit and model-blocking surfaces. Apply is
 * disabled whenever the write target is masked or blocked, with the reason
 * shown plainly.
 */
import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { StatusDot } from "../components/ui/StatusDot";
import { formatTimestamp } from "../format";
import { useProviderData } from "../providers/useProviderData";
import {
  joinManage,
  providerDisplayName,
  sourceLabel,
  writeTargetMeta,
} from "../providers/format";
import { SecretStatus } from "../providers/SecretStatus";
import { EnablementControl } from "../providers/EnablementControl";
import "../styles/agents.css";
import "../styles/team-roster.css";
import "../styles/providers.css";

export function ProviderManagementPage() {
  const { manage, loading, error, refresh } = useProviderData();

  const rows = manage ? joinManage(manage) : [];
  const writeTarget = manage?.writeTarget;

  return (
    <div className="prov-page" data-testid="provider-management-page">
      <PageHeader
        title="Manage providers"
        meta={
          manage
            ? `${rows.length} provider${rows.length === 1 ? "" : "s"} · ${writeTargetMeta(writeTarget)} · ${formatTimestamp(manage.fetchedAt)}`
            : undefined
        }
        onRefresh={() => void refresh()}
        loading={loading}
      />

      <div className="prov-actions prov-top-actions">
        <Link className="omo-btn omo-btn-primary omo-btn-md" to="/providers/add">
          Add provider
        </Link>
        <Link className="omo-btn omo-btn-secondary omo-btn-md" to="/providers">
          Providers
        </Link>
      </div>

      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}

      {manage?.liveIssue ? (
        <div className="warn-block" role="status">
          Live provider data unavailable: {manage.liveIssue}
        </div>
      ) : null}

      {writeTarget?.kind === "project-masked" ? (
        <div className="warn-block" role="status">
          Config writes are masked by the project config. {writeTarget.reason}
        </div>
      ) : null}
      {writeTarget?.kind === "blocked" ? (
        <div className="warn-block" role="status">
          Config writes are unavailable. {writeTarget.reason}
        </div>
      ) : null}

      {manage && manage.projectMaskedProviders.length > 0 ? (
        <div className="info-block" role="status">
          Project-masked:{" "}
          {manage.projectMaskedProviders.map((id) => (
            <code key={id} className="mono">
              {id}
            </code>
          ))}
          . User-level writes for these providers are shadowed by the project
          config.
        </div>
      ) : null}

      <div className="agents-table-surface prov-table-surface">
        <table className="data prov-table" role="table">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Auth</th>
              <th>Connection</th>
              <th>Source</th>
              <th>Config</th>
              <th>Enablement</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} data-provider={row.id}>
                <td>
                  <div className="prov-name-cell">
                    <span className="prov-name">{providerDisplayName(row)}</span>
                    {row.desired?.custom ? (
                      <span className="pill">Custom</span>
                    ) : null}
                    {row.desired?.projectMasked ? (
                      <span
                        className="pill warn"
                        title="Also declared in the project config; user-level writes are shadowed."
                      >
                        Project masked
                      </span>
                    ) : null}
                    <div className="mono muted">{row.id}</div>
                  </div>
                </td>
                <td>
                  <SecretStatus row={row} />
                </td>
                <td>
                  {row.live ? (
                    <span className="team-conn">
                      <StatusDot tone={row.live.connected ? "ok" : "bad"} />
                      {row.live.connected ? "Connected" : "Not connected"}
                    </span>
                  ) : (
                    <span className="muted">Not reported</span>
                  )}
                </td>
                <td>
                  {row.live?.source ? (
                    sourceLabel(row.live.source)
                  ) : row.desired?.custom ? (
                    "Custom"
                  ) : (
                    <span className="muted">Not reported</span>
                  )}
                </td>
                <td>
                  {row.desired?.inConfig ? (
                    <span>
                      {row.desired.models.length} model
                      {row.desired.models.length === 1 ? "" : "s"} ·{" "}
                      {row.desired.blacklist.length} blocked
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  <EnablementControl
                    row={row}
                    writeTarget={writeTarget}
                    onApplied={() => void refresh()}
                    compact
                  />
                </td>
                <td className="prov-actions-cell">
                  <Link className="omo-btn omo-btn-secondary omo-btn-sm" to={`/providers/${encodeURIComponent(row.id)}/edit`}>
                    Edit
                  </Link>
                  <Link className="omo-btn omo-btn-secondary omo-btn-sm" to={`/providers/${encodeURIComponent(row.id)}/models`}>
                    Models
                  </Link>
                </td>
              </tr>
            ))}
            {rows.length === 0 && manage ? (
              <tr>
                <td colSpan={7} className="muted">
                  No providers reported.{" "}
                  <Link to="/providers/add">Add a provider</Link>.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {writeTarget?.kind === "opencode-config-dir" ||
      writeTarget?.kind === "create" ? (
        <p className="muted prov-write-target">
          Changes apply to <span className="mono">{writeTarget.path}</span>{" "}
          after review.
        </p>
      ) : null}
    </div>
  );
}
