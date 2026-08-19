/**
 * Model blocking (/providers/:id/models) — tick = allow, untick = block.
 * Applies set-blacklist with the unticked ids. Works against the models the
 * user-level config declares for the provider; providers with no user-level
 * model list get an honest explanation rather than an empty editor.
 */
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { Button } from "../components/ui/Button";
import { formatTimestamp } from "../format";
import { useProviderData } from "../providers/useProviderData";
import { joinManage, providerDisplayName } from "../providers/format";
import { MutationFlow } from "../providers/MutationFlow";
import "../styles/providers.css";

export function ProviderBlacklistPage() {
  const { id = "" } = useParams();
  const { manage, loading, error, refresh } = useProviderData();

  const row = manage ? joinManage(manage).find((r) => r.id === id) : undefined;
  const desired = row?.desired ?? null;
  const writeTarget = manage?.writeTarget;

  const models = useMemo(() => desired?.models ?? [], [desired]);
  const baseBlacklist = useMemo(
    () => new Set(desired?.blacklist ?? []),
    [desired],
  );
  const [blocked, setBlocked] = useState<Set<string> | null>(null);

  // Local working set; initialized from the desired state once loaded.
  const current = useMemo(() => {
    if (blocked) return blocked;
    return baseBlacklist;
  }, [blocked, baseBlacklist]);

  const dirty = useMemo(() => {
    if (current.size !== baseBlacklist.size) return true;
    for (const m of current) if (!baseBlacklist.has(m)) return true;
    return false;
  }, [current, baseBlacklist]);

  const toggle = (modelId: string, allow: boolean) => {
    const next = new Set(current);
    if (allow) next.delete(modelId);
    else next.add(modelId);
    setBlocked(next);
  };

  const setAll = (allow: boolean) => {
    setBlocked(allow ? new Set() : new Set(models.map((m) => m.id)));
  };

  return (
    <div className="prov-page" data-testid="provider-blacklist-page">
      <PageHeader
        title={
          row
            ? `Models — ${providerDisplayName(row)}`
            : `Models — ${id}`
        }
        meta={
          manage
            ? `${models.length} configured model${models.length === 1 ? "" : "s"} · fetched ${formatTimestamp(manage.fetchedAt)}`
            : undefined
        }
        onRefresh={() => {
          setBlocked(null);
          void refresh();
        }}
        loading={loading}
      />

      <div className="prov-actions prov-top-actions">
        <Link
          className="omo-btn omo-btn-secondary omo-btn-md"
          to={`/providers/${encodeURIComponent(id)}/edit`}
        >
          Back to edit
        </Link>
        <Link className="omo-btn omo-btn-secondary omo-btn-md" to="/providers/manage">
          Manage providers
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
          desired provider set.
        </div>
      ) : null}

      {row && !desired?.inConfig ? (
        <div className="info-block" role="status">
          This provider is not declared in the user-level config, so there is
          no model list to block against. Model blocking writes
          provider.&lt;id&gt;.blacklist into the user-level config.
        </div>
      ) : null}

      {desired?.projectMasked ? (
        <div className="warn-block" role="status">
          This provider is also declared in the project config; user-level
          changes may be shadowed by the project values.
        </div>
      ) : null}

      {desired?.inConfig && models.length === 0 ? (
        <div className="info-block" role="status">
          The user-level entry declares no models for this provider.
        </div>
      ) : null}

      {desired?.inConfig && models.length > 0 ? (
        <>
          <p className="muted">
            Ticked models are allowed. Untick to block: blocked models go to{" "}
            <span className="mono">provider.{row?.id}.blacklist</span>.
          </p>
          <div className="prov-actions">
            <Button size="sm" onClick={() => setAll(true)}>
              Allow all
            </Button>
            <Button size="sm" onClick={() => setAll(false)}>
              Block all
            </Button>
          </div>

          <div className="prov-model-list" role="group" aria-label="Model allowlist">
            {models.map((m) => {
              const allowed = !current.has(m.id);
              const rowId = `blk-${m.id}`;
              return (
                <label className="prov-model-row" key={m.id} htmlFor={rowId}>
                  <input
                    id={rowId}
                    type="checkbox"
                    checked={allowed}
                    onChange={(e) => toggle(m.id, e.target.checked)}
                    aria-label={`Allow ${m.name ?? m.id}`}
                  />
                  <span className="prov-model-name">{m.name ?? m.id}</span>
                  {m.name && m.name !== m.id ? (
                    <span className="mono muted">{m.id}</span>
                  ) : null}
                  {!allowed ? (
                    <span className="pill warn">Blocked</span>
                  ) : null}
                </label>
              );
            })}
          </div>

          {dirty && row ? (
            <MutationFlow
              mutation={{
                kind: "set-blacklist",
                providerId: row.id,
                blacklist: Array.from(current).sort(),
              }}
              writeTarget={writeTarget}
              onApplied={() => {
                setBlocked(null);
                void refresh();
              }}
              onCancel={() => setBlocked(null)}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
