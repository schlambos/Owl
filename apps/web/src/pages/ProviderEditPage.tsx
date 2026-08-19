/**
 * Edit provider (/providers/:id/edit) — identity + live state, enablement,
 * credential management (write-only key rotation, remove), OAuth, terminal
 * fallback, and a link into model blocking.
 *
 * v1 mutation kinds are add-custom / set-blacklist / set-enablement only —
 * there is no mutation for editing a custom provider's name or baseURL, so
 * those render read-only here with a pointer to raw config editing. No
 * invented mutation kinds.
 */
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { StatusDot } from "../components/ui/StatusDot";
import { formatTimestamp } from "../format";
import { useProviderData } from "../providers/useProviderData";
import {
  joinManage,
  providerDisplayName,
  sourceLabel,
} from "../providers/format";
import { ApiKeyForm } from "../providers/ApiKeyForm";
import { OAuthFlow, TuiFallback } from "../providers/OAuthFlow";
import { SecretStatus } from "../providers/SecretStatus";
import { EnablementControl } from "../providers/EnablementControl";
import { SettingRow } from "./system/SystemPrimitives";
import "../styles/system.css";
import "../styles/providers.css";

export function ProviderEditPage() {
  const { id = "" } = useParams();
  const { manage, loading, error, refresh } = useProviderData();
  const [authMode, setAuthMode] = useState<"api" | "oauth">("api");

  const row = manage ? joinManage(manage).find((r) => r.id === id) : undefined;
  const writeTarget = manage?.writeTarget;

  return (
    <div className="prov-page" data-testid="provider-edit-page">
      <PageHeader
        title={
          row ? `Edit ${providerDisplayName(row)}` : `Edit provider ${id}`
        }
        meta={manage ? `Fetched ${formatTimestamp(manage.fetchedAt)}` : undefined}
        onRefresh={() => void refresh()}
        loading={loading}
      />

      <div className="prov-actions prov-top-actions">
        <Link className="omo-btn omo-btn-secondary omo-btn-md" to="/providers/manage">
          Back to manage
        </Link>
        <Link
          className="omo-btn omo-btn-secondary omo-btn-md"
          to={`/providers/${encodeURIComponent(id)}/models`}
        >
          Block models
        </Link>
      </div>

      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}

      {manage && !row ? (
        <div className="warn-block" role="status">
          Provider <span className="mono">{id}</span> is not in the live or
          desired provider set. Add it first from{" "}
          <Link to="/providers/add">Add provider</Link>.
        </div>
      ) : null}

      {row ? (
        <>
          <section className="prov-section" aria-label="Provider identity">
            <div className="prov-identity-badges">
              <span className="pill mono">{row.id}</span>
              {row.desired?.custom ? <span className="pill">Custom</span> : null}
              {row.desired?.projectMasked ? (
                <span
                  className="pill warn"
                  title="Also declared in the project config; user-level writes are shadowed."
                >
                  Project masked
                </span>
              ) : null}
              {row.desired?.enableDisableConflict ? (
                <span
                  className="pill warn"
                  title="Listed in both enabled_providers and disabled_providers. Disabled wins."
                >
                  Enable/disable conflict
                </span>
              ) : null}
            </div>
            <SettingRow
              title="Connection"
              description={
                <>
                  <StatusDot tone={row.live?.connected ? "ok" : "bad"} />{" "}
                  {row.live
                    ? row.live.connected
                      ? "Connected"
                      : "Not connected"
                    : "Not reported"}
                  {row.live ? ` · ${row.live.modelCount} models live` : ""}
                </>
              }
            />
            <SettingRow
              title="Source"
              description={
                row.live?.source
                  ? sourceLabel(row.live.source)
                  : row.desired?.custom
                    ? "Custom"
                    : "Not reported"
              }
            />
            <SettingRow
              title="Credential"
              description={<SecretStatus row={row} />}
            />
            <SettingRow
              title="Name"
              description={
                row.desired?.name ?? row.live?.name ?? (
                  <span className="muted">Not set</span>
                )
              }
            />
            {row.desired?.baseURL ? (
              <SettingRow
                title="Base URL"
                description={<span className="mono">{row.desired.baseURL}</span>}
              />
            ) : null}
            {row.desired?.custom ? (
              <p className="muted prov-help">
                Name and base URL are fixed at add time (the custom provider
                entry is written once). To change them later, edit the config
                directly under <Link to="/config">Config</Link>.
              </p>
            ) : null}
          </section>

          <section className="prov-section" aria-label="Enablement">
            <h2 className="section-title">Enablement</h2>
            <EnablementControl
              row={row}
              writeTarget={writeTarget}
              onApplied={() => void refresh()}
            />
            {row.desired?.enableDisableConflict ? (
              <div className="warn-block" role="status">
                This provider is listed in both enabled_providers and
                disabled_providers. Disabled wins until the conflict is
                resolved in the config.
              </div>
            ) : null}
          </section>

          <section className="prov-section" aria-label="Credentials">
            <h2 className="section-title">Credentials</h2>
            <div className="prov-chip-row" role="group" aria-label="Auth method">
              <button
                type="button"
                className="prov-chip"
                aria-pressed={authMode === "api"}
                onClick={() => setAuthMode("api")}
              >
                API key
              </button>
              <button
                type="button"
                className="prov-chip"
                aria-pressed={authMode === "oauth"}
                onClick={() => setAuthMode("oauth")}
              >
                OAuth
              </button>
            </div>
            {authMode === "api" ? (
              <ApiKeyForm providerId={row.id} onChanged={() => void refresh()} />
            ) : (
              <OAuthFlow
                providerId={row.id}
                onDone={(ok) => {
                  if (ok) void refresh();
                }}
              />
            )}
            <TuiFallback providerId={row.id} />
          </section>

          <section className="prov-section" aria-label="Model blocking">
            <h2 className="section-title">Model blocking</h2>
            <p className="muted">
              {row.desired
                ? `${row.desired.models.length} configured model${row.desired.models.length === 1 ? "" : "s"} · ${row.desired.blacklist.length} blocked`
                : "This provider is not declared in the user-level config; model blocking applies to the user-level entry."}{" "}
              <Link to={`/providers/${encodeURIComponent(row.id)}/models`}>
                Open model blocking
              </Link>
              .
            </p>
          </section>
        </>
      ) : null}
    </div>
  );
}
