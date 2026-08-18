/**
 * Team topology view — Models (doc 34).
 *
 * HARD-SCOPED active Effective topology, not a default-filtered catalog:
 * rows come from `topology.models` only (active agent primary/fallback refs
 * of eligible agents, active Council and ACP refs). Advertised-only,
 * probe-history-only, Desired-only, Live-only, inactive and disabled-only
 * models never appear.
 *
 * Filters `all|primary|fallback|shared|issues|never-probed`; sorts
 * `model|provider|primary|fallback|probe|issues`. The catalog ProviderStrip,
 * batch-probe and queue chrome are gone; the existing single-model drawer
 * keeps its explicit probe safeguards and history. Drift stays an annotation
 * inside the Effective refs (↻ on the owning agent).
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { ModelDrawer } from "../models/ModelDrawer";
import { useModelAvailability } from "../models/ModelAvailabilityContext";
import { ProbeBadge } from "../models/ProbeBadge";
import {
  catalogNameFor,
  findModelTrigger,
  modelDisplayName,
} from "../models/presentation";
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
import { providerLabel } from "./agents/presentation";
import {
  applyTeamModelsView,
  findScopedTeamModel,
  TEAM_MODEL_FILTER_IDS,
  TEAM_MODEL_FILTER_LABELS,
  TEAM_MODEL_SORT_IDS,
  TEAM_MODEL_SORT_LABELS,
  type TeamAgentModelRef,
  type TeamDependencyModelRef,
  type TeamModelSortId,
  type TeamScopedModel,
  type TeamSort,
} from "./team/topology";
import type { TeamNameMaps } from "./team/topology";
import "../styles/agents.css";
import "../styles/team-roster.css";
import "../styles/models.css";

export function ModelsPage() {
  const { connection, probeGeneration } = useRuntime();
  const { refresh } = useModelAvailability();
  const { topology, names } = useTeamTopology();
  const view = useTeamView("models");
  const { controls, focus, hasFocus, commit, clearFocus } = view;

  const ocDisconnected = connection.rest === "disconnected";
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Provider focus constrains the visible scoped set; model focus opens the
  // drawer when the key is in the scoped universe (else topology-empty).
  const scoped = useMemo(
    () =>
      focus.provider
        ? topology.models.filter((m) => m.providerId === focus.provider)
        : topology.models,
    [topology.models, focus.provider],
  );

  const result = useMemo(
    () =>
      applyTeamModelsView(
        scoped,
        {
          filter: controls.filter,
          q: controls.q,
          sort: (controls.sort ?? {
            id: "model",
            dir: "asc",
          }) as TeamSort<TeamModelSortId>,
        },
        names,
      ),
    [scoped, controls.filter, controls.q, controls.sort, names],
  );

  const focusedModel = useMemo(
    () => findScopedTeamModel(topology.models, focus.model),
    [topology.models, focus.model],
  );

  const onHeaderSort = (id: TeamModelSortId) => {
    const cur = controls.sort as TeamSort<TeamModelSortId>;
    if (cur.id !== id) commit({ sort: { id, dir: "asc" } });
    else if (cur.dir === "asc") commit({ sort: { id, dir: "desc" } });
    else commit({ sort: { id: "model", dir: "asc" } });
  };

  const probeOne = async (m: TeamScopedModel) => {
    setBusyKey(m.key);
    setNotice(null);
    try {
      const res = await api.probeModel(m.providerId, m.modelId);
      setNotice(
        "skipped" in res && res.skipped === "fresh"
          ? `Skipped ${m.providerId}/${m.modelId} — a recent probe is fresh.`
          : `Probe queued: ${m.providerId}/${m.modelId}.`,
      );
      await refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  };

  // A model focus that is not in the scoped set shows the topology-empty
  // state with focus preserved (doc 34 cross-navigation contract).
  const modelFocusMissing = Boolean(focus.model) && !focusedModel;
  const visibleRows = modelFocusMissing ? [] : result.rows;

  const selected = focusedModel;
  const selectedDiag = selected
    ? topology.providers.find((p) => p.providerId === selected.providerId)
    : undefined;
  const selectedDisabledReason = ocDisconnected
    ? "OpenCode is disconnected"
    : selected && selected.providerConnected === false
      ? "Provider is not connected in OpenCode"
      : undefined;

  const sort = (controls.sort ?? {
    id: "model",
    dir: "asc",
  }) as TeamSort<TeamModelSortId>;

  return (
    <div className="omo-models team-view">
      <TeamHeader
        topology={topology}
        onRefresh={() => void refresh()}
        loading={false}
      />
      {ocDisconnected ? (
        <div className="warn-block">
          OpenCode is disconnected — inventory may be stale and probing is
          disabled.
        </div>
      ) : null}
      {notice ? (
        <p className="omo-models-notice muted" role="status">
          {notice}
        </p>
      ) : null}

      <div className="omo-sr-only" aria-live="polite">
        {result.rows.length} of {scoped.length} scoped model
        {scoped.length === 1 ? "" : "s"} shown
        {controls.q ? ` matching “${controls.q}”` : ""}
        {controls.filter !== "all" ? `, filter ${controls.filter}` : ""}
        {`, sorted by ${sort.id} ${sort.dir}`}
      </div>

      <div className="agents-toolbar team-roster-toolbar">
        <input
          className="agents-search"
          type="search"
          placeholder="Search model, provider, or usage…"
          value={controls.q}
          onChange={(e) => commit({ q: e.target.value })}
          aria-label="Search models"
        />
        <TeamFilterChips
          ariaLabel="Model filters"
          filter={controls.filter}
          ids={TEAM_MODEL_FILTER_IDS}
          labels={TEAM_MODEL_FILTER_LABELS}
          counts={result.filterCounts}
          onChange={(id) => commit({ filter: id })}
        />
        <TeamSortControl<TeamModelSortId>
          sort={sort}
          defaultSort={{ id: "model", dir: "asc" }}
          ids={TEAM_MODEL_SORT_IDS}
          labels={TEAM_MODEL_SORT_LABELS}
          onChange={(s) => commit({ sort: s ?? { id: "model", dir: "asc" } })}
        />
        <TeamClearFocus hasFocus={hasFocus} onClear={clearFocus} />
      </div>

      <div className="agents-table-surface team-roster-surface">
        <table className="agents-table team-roster-table is-flat team-models-table" role="table">
          <thead>
            <tr>
              <TeamSortableHeader
                columnId="model"
                label="Model"
                sortId={"model" as TeamModelSortId}
                sort={sort}
                onSort={onHeaderSort}
              />
              <TeamSortableHeader
                columnId="provider"
                label="Provider"
                sortId={"provider" as TeamModelSortId}
                sort={sort}
                onSort={onHeaderSort}
              />
              <TeamSortableHeader
                columnId="primary"
                label="Primary"
                sortId={"primary" as TeamModelSortId}
                sort={sort}
                onSort={onHeaderSort}
              />
              <TeamSortableHeader
                columnId="fallback"
                label="Fallback"
                sortId={"fallback" as TeamModelSortId}
                sort={sort}
                onSort={onHeaderSort}
              />
              <TeamSortableHeader
                columnId="probe"
                label="Probe"
                sortId={"probe" as TeamModelSortId}
                sort={sort}
                onSort={onHeaderSort}
              />
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((m) => (
              <ScopedModelRow
                key={m.key}
                m={m}
                names={names}
                selected={selected?.key === m.key}
                onOpen={() =>
                  view.setFocus({ ...focus, model: m.key })
                }
              />
            ))}
            {visibleRows.length === 0 ? (
              <tr>
                <td colSpan={5} className="agents-empty team-topology-empty">
                  {topology.models.length === 0
                    ? "No models in the active Effective topology."
                    : modelFocusMissing
                      ? "No scoped model matches the current focus."
                      : hasFocus
                        ? "No scoped model matches the current focus."
                        : "No models match the current filter."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {selected ? (
        <ModelDrawer
          providerId={selected.providerId}
          modelId={selected.modelId}
          displayName={catalogNameFor(
            selected.providerId,
            selected.modelId,
            names.catalogNames,
          )}
          generation={probeGeneration}
          disabledReason={selectedDisabledReason}
          busy={busyKey === selected.key}
          onProbe={() => void probeOne(selected)}
          onClose={() => view.setFocus({ ...focus, model: undefined })}
          returnFocus={() =>
            findModelTrigger(selected.providerId, selected.modelId)
          }
          eligibleAgents={topology.agents.activeNames}
        />
      ) : null}
    </div>
  );
}

function ScopedModelRow(props: {
  m: TeamScopedModel;
  names: TeamNameMaps;
  selected: boolean;
  onOpen: () => void;
}) {
  const { m, names } = props;
  const display = modelDisplayName(
    m.modelId,
    catalogNameFor(m.providerId, m.modelId, names.catalogNames),
  );
  return (
    <tr data-model-row={m.key}>
      <td className="team-model-name-col">
        <button
          type="button"
          className="agent-name-btn"
          data-model-trigger=""
          data-provider-id={m.providerId}
          data-model-id={m.modelId}
          aria-expanded={props.selected}
          aria-controls="model-detail-drawer"
          onClick={props.onOpen}
        >
          {display}
        </button>
        <span className="model-canonical">{m.key}</span>
      </td>
      <td>
        <Link
          className="owner-link team-provider-link"
          to={teamFocusPath("/providers", { provider: m.providerId })}
        >
          {providerLabel(m.key, names.providerNames) ?? m.providerId}
        </Link>
      </td>
      <td>
        <span className="team-refs-cell">
          {m.agentPrimary.map((r) => (
            <AgentRef key={r.ownerId} r={r} modelKey={m.key} />
          ))}
          {m.council.map((r) => (
            <DependencyRef key={r.ownerId} r={r} />
          ))}
          {m.acp.map((r) => (
            <DependencyRef key={r.ownerId} r={r} />
          ))}
          {m.counts.primary === 0 ? (
            <span className="team-status-quiet" />
          ) : null}
        </span>
      </td>
      <td>
        <span className="team-refs-cell">
          {m.agentFallback.map((r) => (
            <AgentRef key={r.ownerId} r={r} modelKey={m.key} />
          ))}
          {m.counts.fallback === 0 ? (
            <span className="team-status-quiet" />
          ) : null}
        </span>
      </td>
      <td>
        <span className="team-refs-cell">
          <ProbeBadge probe={m.probe} showLatency={false} unprobedQuiet />
          {m.probe.latencyMs != null ? (
            <span className="model-canonical">{m.probe.latencyMs}ms</span>
          ) : null}
        </span>
      </td>
    </tr>
  );
}

/** Eligible-agent usage ref → focused Agents (doc 34 cross-nav). */
function AgentRef(props: { r: TeamAgentModelRef; modelKey: string }) {
  const { r } = props;
  return (
    <Link
      className={`team-ref ${r.kind === "agent-primary" ? "is-primary" : "is-fallback"}`}
      to={teamFocusPath("/agents", { model: props.modelKey, agent: r.ownerId })}
      title={`${r.ownerId}${r.liveDrift ? " — runtime drift (Effective ≠ Live)" : ""}`}
    >
      {r.kind === "agent-fallback" ? `Fallback · ${r.label}` : r.label}
      {r.liveDrift ? (
        <span className="team-ref-drift" aria-label="runtime drift">
          {" "}
          ↻
        </span>
      ) : null}
    </Link>
  );
}

/** Council / ACP dependency ref → owning workspace (never Agents focus). */
function DependencyRef(props: { r: TeamDependencyModelRef }) {
  const { r } = props;
  const council = r.kind === "council-member";
  return (
    <Link
      className={`team-ref ${council ? "is-council" : "is-acp"}`}
      to={council ? "/council" : "/acp"}
      title={r.ownerId}
    >
      {council ? "Council" : "ACP"}
    </Link>
  );
}
