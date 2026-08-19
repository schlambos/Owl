/**
 * Team topology view — Providers (doc 34).
 *
 * Providers derive ONLY from the scoped Models set — a provider with no
 * scoped model never appears. Dense expandable parent rows (no cards):
 * name + quiet id, connected text+dot, `LiveProvider.source` only (else
 * "Not reported"), unique active eligible OMO agent count/links, scoped
 * model count/links, Council/ACP dependency labels, and a probe/issues
 * roll-up. The disclosure lists full agent/model/dependency detail plus the
 * evidence behind `custom-configured`. No secrets, tokens, or internals.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import { StatusDot } from "../components/ui/StatusDot";
import { useRuntime } from "../runtime/RuntimeContext";
import {
  TeamClearFocus,
  TeamFilterChips,
  TeamHeader,
  TeamSortControl,
  TeamSortableHeader,
  useTeamTopology,
  useTeamView,
} from "./team/TeamHeader";
import { teamFocusPath } from "./team/session-state";
import {
  applyTeamProvidersView,
  TEAM_PROVIDER_FILTER_IDS,
  TEAM_PROVIDER_FILTER_LABELS,
  TEAM_PROVIDER_SORT_IDS,
  TEAM_PROVIDER_SORT_LABELS,
  type TeamProviderGroup,
  type TeamProviderSortId,
  type TeamSort,
} from "./team/topology";
import type { TeamNameMaps } from "./team/topology";
import { catalogNameFor, modelDisplayName } from "../models/presentation";
import "../styles/agents.css";
import "../styles/team-roster.css";

export function ProvidersPage() {
  const { loading, refreshAll } = useRuntime();
  const { topology, names } = useTeamTopology();
  const view = useTeamView("providers");
  const { controls, focus, hasFocus, commit, clearFocus } = view;

  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  // A provider focus auto-expands its row (transient, never persisted).
  const isOpen = (id: string) => open.has(id) || focus.provider === id;
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const result = useMemo(
    () =>
      applyTeamProvidersView(
        topology.providers,
        {
          filter: controls.filter,
          q: controls.q,
          sort: (controls.sort ?? {
            id: "name",
            dir: "asc",
          }) as TeamSort<TeamProviderSortId>,
        },
        names,
      ),
    [topology.providers, controls.filter, controls.q, controls.sort, names],
  );

  const sort = (controls.sort ?? {
    id: "name",
    dir: "asc",
  }) as TeamSort<TeamProviderSortId>;

  const onHeaderSort = (id: TeamProviderSortId) => {
    if (sort.id !== id) commit({ sort: { id, dir: "asc" } });
    else if (sort.dir === "asc") commit({ sort: { id, dir: "desc" } });
    else commit({ sort: { id: "name", dir: "asc" } });
  };

  return (
    <div className="team-view team-providers-page">
      <TeamHeader
        topology={topology}
        onRefresh={() => void refreshAll()}
        loading={loading}
      />

      <div className="omo-sr-only" aria-live="polite">
        {result.rows.length} of {topology.providers.length} provider
        {topology.providers.length === 1 ? "" : "s"} shown
        {controls.q ? ` matching “${controls.q}”` : ""}
        {controls.filter !== "all" ? `, filter ${controls.filter}` : ""}
        {`, sorted by ${sort.id} ${sort.dir}`}
      </div>

      <div className="agents-toolbar team-roster-toolbar">
        <input
          className="agents-search"
          type="search"
          placeholder="Search provider, model, source, or dependent…"
          value={controls.q}
          onChange={(e) => commit({ q: e.target.value })}
          aria-label="Search providers"
        />
        <TeamFilterChips
          ariaLabel="Provider filters"
          filter={controls.filter}
          ids={TEAM_PROVIDER_FILTER_IDS}
          labels={TEAM_PROVIDER_FILTER_LABELS}
          counts={result.filterCounts}
          onChange={(id) => commit({ filter: id })}
        />
        <TeamSortControl<TeamProviderSortId>
          sort={sort}
          defaultSort={{ id: "name", dir: "asc" }}
          ids={TEAM_PROVIDER_SORT_IDS}
          labels={TEAM_PROVIDER_SORT_LABELS}
          onChange={(s) => commit({ sort: s ?? { id: "name", dir: "asc" } })}
        />
        <TeamClearFocus hasFocus={hasFocus} onClear={clearFocus} />
        <span className="team-providers-manage-links">
          <Link
            className="omo-btn omo-btn-secondary omo-btn-md"
            to="/providers/manage"
          >
            Manage providers
          </Link>
          <Link
            className="omo-btn omo-btn-primary omo-btn-md"
            to="/providers/add"
          >
            Add provider
          </Link>
        </span>
      </div>

      <div className="agents-table-surface team-roster-surface">
        <table className="agents-table team-roster-table is-flat team-providers-table" role="table">
          <thead>
            <tr>
              <TeamSortableHeader
                columnId="provider"
                label="Provider"
                sortId={"name" as TeamProviderSortId}
                sort={sort}
                onSort={onHeaderSort}
              />
              <TeamSortableHeader
                columnId="connection"
                label="Connection"
                sortId={"connection" as TeamProviderSortId}
                sort={sort}
                onSort={onHeaderSort}
              />
              <TeamSortableHeader
                columnId="source"
                label="Source"
                sortId={"source" as TeamProviderSortId}
                sort={sort}
                onSort={onHeaderSort}
              />
              <TeamSortableHeader
                columnId="agents"
                label="Agents"
                sortId={"agents" as TeamProviderSortId}
                sort={sort}
                onSort={onHeaderSort}
              />
              <TeamSortableHeader
                columnId="models"
                label="Models"
                sortId={"models" as TeamProviderSortId}
                sort={sort}
                onSort={onHeaderSort}
              />
              <TeamSortableHeader
                columnId="issues"
                label="Issues"
                sortId={"issues" as TeamProviderSortId}
                sort={sort}
                onSort={onHeaderSort}
              />
            </tr>
          </thead>
          <tbody>
            {result.rows.map((g) => (
              <ProviderRows
                key={g.providerId}
                g={g}
                names={names}
                open={isOpen(g.providerId)}
                onToggle={() => toggle(g.providerId)}
              />
            ))}
            {result.rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="agents-empty team-topology-empty">
                  {topology.providers.length === 0
                    ? "No providers in the active Effective topology."
                    : hasFocus
                      ? "No scoped provider matches the current focus."
                      : "No providers match the current filter."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProviderRows(props: {
  g: TeamProviderGroup;
  names: TeamNameMaps;
  open: boolean;
  onToggle: () => void;
}) {
  const { g, names } = props;
  const detailsId = `team-provider-details-${g.providerId}`;
  return (
    <>
      <tr data-provider={g.providerId}>
        <td className="team-provider-col">
          <button
            type="button"
            className="team-provider-toggle"
            aria-expanded={props.open}
            aria-controls={detailsId}
            aria-label={`${g.displayName}. Toggle scoped models and dependents.`}
            onClick={props.onToggle}
          >
            <ChevronDown
              size={14}
              className="team-chev"
              data-open={props.open}
              aria-hidden="true"
            />
          </button>
          <span className="team-provider-name">{g.displayName}</span>
          <span className="model-canonical">{g.providerId}</span>
        </td>
        <td>
          <span className="team-conn">
            <StatusDot tone={g.connected ? "ok" : "bad"} />
            {g.connected ? "Connected" : "Not connected"}
          </span>
        </td>
        <td>
          <span className={g.source ? undefined : "muted"}>
            {g.sourceLabel}
          </span>
        </td>
        <td>
          <span className="team-refs-cell">
            {g.agentCount > 0 ? (
              <Link
                className="team-ref is-primary"
                to={teamFocusPath("/agents", { provider: g.providerId })}
                title={`Unique active eligible agents using ${g.providerId}`}
              >
                {g.agentCount} agent{g.agentCount === 1 ? "" : "s"}
              </Link>
            ) : (
              <span className="team-status-quiet" />
            )}
            {g.council.length > 0 ? (
              <Link className="team-ref is-council" to="/council" title={g.council.map((c) => c.ownerId).join(", ")}>
                Council
              </Link>
            ) : null}
            {g.acp.length > 0 ? (
              <Link className="team-ref is-acp" to="/acp" title={g.acp.map((c) => c.ownerId).join(", ")}>
                ACP
              </Link>
            ) : null}
          </span>
        </td>
        <td>
          <Link
            className="team-ref"
            to={teamFocusPath("/models", { provider: g.providerId })}
            title={`Scoped models of ${g.providerId}`}
          >
            {g.modelCount} model{g.modelCount === 1 ? "" : "s"}
          </Link>
        </td>
        <td>
          {g.hasIssues ? (
            <span className="probe-inline warn">
              {g.issueCount} issue{g.issueCount === 1 ? "" : "s"}
            </span>
          ) : (
            <span className="team-status-quiet" />
          )}
        </td>
      </tr>
      {props.open ? (
        <tr className="team-provider-details-row">
          <td colSpan={6} id={detailsId}>
            <div className="team-provider-details">
              <section>
                <h3>Eligible agents</h3>
                {g.agents.length === 0 ? (
                  <p className="muted">No eligible OMO agents.</p>
                ) : (
                  <ul>
                    {g.agents.map((a) => (
                      <li key={a.ownerId}>
                        <Link
                          to={teamFocusPath("/agents", {
                            provider: g.providerId,
                            agent: a.ownerId,
                          })}
                        >
                          {a.ownerId}
                        </Link>{" "}
                        <span className="muted">
                          {a.roles.join(" + ")}
                          {a.liveDrift ? " · runtime drift" : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section>
                <h3>Scoped models</h3>
                <ul>
                  {g.models.map((m) => (
                    <li key={m.key}>
                      <Link
                        to={teamFocusPath("/models", {
                          provider: g.providerId,
                          model: m.key,
                        })}
                        title={m.key}
                      >
                        {modelDisplayName(
                          m.modelId,
                          catalogNameFor(m.providerId, m.modelId, names.catalogNames),
                        )}
                      </Link>{" "}
                      <span className="muted">
                        {m.hasIssues ? `· ${m.probe.state}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
              <section>
                <h3>Dependencies</h3>
                {g.council.length === 0 && g.acp.length === 0 ? (
                  <p className="muted">No Council or ACP dependencies.</p>
                ) : (
                  <ul>
                    {g.council.map((c) => (
                      <li key={c.ownerId}>
                        <Link to="/council">{c.label || c.ownerId}</Link>{" "}
                        <span className="muted">Council</span>
                      </li>
                    ))}
                    {g.acp.map((c) => (
                      <li key={c.ownerId}>
                        <Link to="/acp">{c.label || c.ownerId}</Link>{" "}
                        <span className="muted">ACP</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section>
                <h3>Configuration evidence</h3>
                {g.customConfiguredEvidence.length === 0 ? (
                  <p className="muted">No custom-configuration evidence.</p>
                ) : (
                  <ul>
                    {g.customConfiguredEvidence.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
