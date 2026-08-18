/**
 * Team topology view — Agents (doc 34).
 *
 * Effective-first roster over the shared Team topology:
 *  - eligibility: OMO built-ins + custom only (native / ACP wrappers /
 *    councillor excluded; council coordinator only with a normal Effective
 *    assignment) via `./team/topology`;
 *  - `Show disabled` eligibility gate (default OFF) runs BEFORE facet
 *    filters/search/sort and never touches TeamHeader counts or the
 *    Models/Providers universes;
 *  - filters `all|overrides|runtime-drift|model-issues|custom`; sorts default
 *    team order + name|model|provider|source|signals|kind;
 *  - focus params `model`/`provider` constrain by Effective primary OR
 *    fallback; `agent` opens the drawer only when valid; visible Clear focus;
 *  - URL + sessionStorage state via `./team/session-state`.
 *
 * The detail drawer, Change Model editor, and capabilities workflow are
 * preserved unchanged.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { useRuntime } from "../runtime/RuntimeContext";
import { AgentEditModal } from "./AgentEditModal";
import { CapabilityEditModal } from "./CapabilityEditModal";
import {
  groupRoster,
  type AgentPresentation,
} from "./agents/presentation";
import { AgentAssignmentRow } from "./agents/AgentAssignmentRow";
import { AgentDetailDrawer } from "./agents/AgentDetailDrawer";
import { RosterGroupHeader } from "./agents/team/RosterGroupHeader";
import { RosterLegend } from "./agents/team/RosterLegend";
import {
  TeamClearFocus,
  TeamFilterChips,
  TeamHeader,
  TeamSortControl,
  TeamSortableHeader,
  useTeamTopology,
  useTeamView,
} from "./team/TeamHeader";
import {
  applyTeamAgentsView,
  TEAM_AGENT_FILTER_IDS,
  TEAM_AGENT_FILTER_LABELS,
  TEAM_AGENT_SORT_IDS,
  TEAM_AGENT_SORT_LABELS,
  type TeamAgentFilterId,
  type TeamAgentSortId,
  type TeamSort,
} from "./team/topology";
import "../styles/agents.css";
import "../styles/team-roster.css";

/** Find a row trigger button by data attribute (focus-return targets). */
function findTrigger(
  kind: "detail" | "edit" | "caps",
  name: string,
): HTMLElement | null {
  const els = document.querySelectorAll<HTMLElement>(`[data-${kind}-trigger]`);
  for (const el of Array.from(els)) {
    if (el.getAttribute(`data-${kind}-trigger`) === name) return el;
  }
  return null;
}

/** Focus `model`: the agent's Effective primary OR any fallback matches. */
function matchesModelFocus(r: AgentPresentation, key: string): boolean {
  return r.effective.model === key || r.effective.fallbacks.includes(key);
}

/** Focus `provider`: Effective primary OR fallback under that provider. */
function matchesProviderFocus(r: AgentPresentation, providerId: string): boolean {
  const prefix = `${providerId}/`;
  return (
    (r.effective.model != null && r.effective.model.startsWith(prefix)) ||
    r.effective.fallbacks.some((f) => f.startsWith(prefix))
  );
}

export function AgentsPage() {
  const { agents: data, loading, refreshAll } = useRuntime();
  const { topology, names } = useTeamTopology();

  // Agent focus validation activates only once the AgentsDto has loaded;
  // before that the focus param is kept (session-state contract).
  const isAgentFocusValid = useCallback(
    (name: string) => topology.agents.activeNames.has(name),
    [topology.agents.activeNames],
  );
  const view = useTeamView("agents", {
    isAgentFocusValid: data ? isAgentFocusValid : undefined,
  });
  const { controls, focus, hasFocus, commit, clearFocus, setFocus } = view;

  const [editing, setEditing] = useState<string | null>(null);
  const [editingCaps, setEditingCaps] = useState<string | null>(null);
  /** Where the open editor should return focus: row Edit button vs row
   *  detail (name) trigger when opened from the drawer. */
  const editReturnKind = useRef<"edit" | "detail">("edit");

  // Show-disabled gate → focus constraint → facets/search → sort.
  const gated = useMemo(() => {
    const base = controls.showDisabled
      ? topology.agents
      : { ...topology.agents, disabled: [] as AgentPresentation[] };
    return base;
  }, [topology.agents, controls.showDisabled]);

  const focused = useMemo(() => {
    let rows = controls.showDisabled
      ? [...gated.active, ...gated.disabled]
      : gated.active;
    if (focus.model) {
      const key = focus.model;
      rows = rows.filter((r) => matchesModelFocus(r, key));
    }
    if (focus.provider) {
      const id = focus.provider;
      rows = rows.filter((r) => matchesProviderFocus(r, id));
    }
    return rows;
  }, [gated, controls.showDisabled, focus.model, focus.provider]);

  const result = useMemo(
    () =>
      applyTeamAgentsView(
        {
          active: focused.filter((r) => !r.isDisabled),
          disabled: focused.filter((r) => r.isDisabled),
          activeNames: topology.agents.activeNames,
        },
        {
          showDisabled: controls.showDisabled,
          filter: controls.filter as TeamAgentFilterId,
          q: controls.q,
          sort: controls.sort as TeamSort<TeamAgentSortId> | null,
        },
        names,
      ),
    [focused, controls.showDisabled, controls.filter, controls.q, controls.sort, topology.agents.activeNames, names],
  );

  const grouped = useMemo(
    () => (controls.sort == null ? groupRoster(result.rows) : null),
    [result.rows, controls.sort],
  );

  const onHeaderSort = (id: TeamAgentSortId) => {
    const cur = controls.sort as TeamSort<TeamAgentSortId> | null;
    if (cur?.id !== id) commit({ sort: { id, dir: "asc" } });
    else if (cur.dir === "asc") commit({ sort: { id, dir: "desc" } });
    else commit({ sort: null });
  };

  // Drawer selection = valid agent focus.
  const selected = focus.agent ?? null;
  const selectedRow = useMemo(() => {
    if (!data || !selected) return null;
    const row = data.rows.find((r) => r.name === selected);
    const pres =
      topology.agents.active.find((p) => p.name === selected) ??
      topology.agents.disabled.find((p) => p.name === selected);
    if (!row || !pres) return null;
    return { row, pres };
  }, [data, selected, topology.agents]);

  /** Direct row Edit → editor returns focus to the row Edit button. */
  const openEditorDirect = (name: string) => {
    editReturnKind.current = "edit";
    setEditing(name);
  };

  /** Drawer Edit → drawer closes FIRST (no nested dialogs); the editor
   *  returns focus to the row's detail (name) trigger. */
  const openEditorFromDrawer = (name: string) => {
    editReturnKind.current = "detail";
    setFocus({ ...focus, agent: undefined });
    setEditing(name);
  };

  const editingPresentation = editing
    ? (topology.agents.active.find((p) => p.name === editing) ??
      topology.agents.disabled.find((p) => p.name === editing))
    : undefined;

  const gatedTotal = result.activeShown + result.disabledShown +
    (result.filterCounts.all - result.activeShown - result.disabledShown);

  return (
    <div className="agents-page team-view">
      <TeamHeader
        topology={topology}
        onRefresh={() => void refreshAll()}
        loading={loading}
      />

      <div className="omo-sr-only" aria-live="polite">
        {result.rows.length} of {gatedTotal} agent
        {gatedTotal === 1 ? "" : "s"} shown
        {controls.q ? ` matching “${controls.q}”` : ""}
        {controls.filter !== "all" ? `, filter ${controls.filter}` : ""}
        {controls.sort
          ? `, sorted by ${controls.sort.id} ${controls.sort.dir}`
          : ", grouped default order"}
        {controls.showDisabled ? `, disabled shown ${result.disabledShown}` : ""}
      </div>

      <RosterLegend />

      {/* Compact toolbar: search + filter chips + sort + show disabled. */}
      <div className="agents-toolbar team-roster-toolbar">
        <input
          className="agents-search"
          type="search"
          placeholder="Search agent, model, provider, canonical id, source, or fallback…"
          value={controls.q}
          onChange={(e) => commit({ q: e.target.value })}
          aria-label="Search agents"
        />
        <TeamFilterChips
          ariaLabel="Agent filters"
          filter={controls.filter}
          ids={TEAM_AGENT_FILTER_IDS}
          labels={TEAM_AGENT_FILTER_LABELS}
          counts={result.filterCounts}
          onChange={(id) => commit({ filter: id })}
        />
        <TeamSortControl<TeamAgentSortId>
          sort={controls.sort as TeamSort<TeamAgentSortId> | null}
          defaultSort={null}
          ids={TEAM_AGENT_SORT_IDS}
          labels={TEAM_AGENT_SORT_LABELS}
          onChange={(s) => commit({ sort: s })}
        />
        <label className="agents-native-toggle team-show-disabled">
          <input
            type="checkbox"
            checked={controls.showDisabled}
            onChange={(e) => commit({ showDisabled: e.target.checked })}
          />{" "}
          Show disabled
        </label>
        {controls.showDisabled ? (
          <span
            className="team-disabled-shown"
            data-testid="agents-disabled-shown"
          >
            disabled shown:{" "}
            <span className="summary-num">{result.disabledShown}</span>
          </span>
        ) : null}
        <TeamClearFocus hasFocus={hasFocus} onClear={clearFocus} />
      </div>

      {/* Roster — Agent → Model → Status → Source → Actions. */}
      <div className="agents-table-surface team-roster-surface">
        <table
          className={`agents-table team-roster-table ${
            grouped ? "is-grouped" : "is-flat"
          }`}
          role="table"
        >
          <thead>
            <tr>
              <TeamSortableHeader
                columnId="agent"
                label="Agent"
                sortId={"name" as TeamAgentSortId}
                sort={controls.sort as TeamSort<TeamAgentSortId> | null}
                onSort={onHeaderSort}
              />
              <TeamSortableHeader
                columnId="assignment"
                label="Model"
                sortId={"model" as TeamAgentSortId}
                sort={controls.sort as TeamSort<TeamAgentSortId> | null}
                onSort={onHeaderSort}
              />
              <TeamSortableHeader
                columnId="signals"
                label="Status"
                sortId={"signals" as TeamAgentSortId}
                sort={controls.sort as TeamSort<TeamAgentSortId> | null}
                onSort={onHeaderSort}
              />
              <TeamSortableHeader
                columnId="source"
                label="Source"
                sortId={"source" as TeamAgentSortId}
                sort={controls.sort as TeamSort<TeamAgentSortId> | null}
                onSort={onHeaderSort}
              />
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="agents-empty">
                  {hasFocus
                    ? "No eligible agents match the current focus."
                    : "No agents match the current filter."}
                </td>
              </tr>
            ) : grouped ? (
              grouped.map((group) => (
                <RosterSection
                  key={group.id}
                  group={group}
                  names={names}
                  selected={selected}
                  onOpenDetail={(name) => setFocus({ ...focus, agent: name })}
                  onEdit={openEditorDirect}
                  onEditCaps={setEditingCaps}
                />
              ))
            ) : (
              result.rows.map((r) => (
                <AgentAssignmentRow
                  key={r.name}
                  row={r}
                  catalogNames={names.catalogNames}
                  providerNames={names.providerNames}
                  selected={selected === r.name}
                  onOpenDetail={() => setFocus({ ...focus, agent: r.name })}
                  onEdit={() => openEditorDirect(r.name)}
                  onEditCaps={
                    r.canEdit ? () => setEditingCaps(r.name) : undefined
                  }
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Right-docked drawer (true modal side-sheet; list stays visible
          but inert; does NOT shrink the list). */}
      {selectedRow ? (
        <AgentDetailDrawer
          row={selectedRow.row}
          presentation={selectedRow.pres}
          onClose={() => setFocus({ ...focus, agent: undefined })}
          onEdit={
            selectedRow.pres.canEdit ? openEditorFromDrawer : undefined
          }
          editHint={
            selectedRow.pres.isAcp
              ? "Model managed in the ACP workspace — edit the wrapper there."
              : selectedRow.row.kind === "native"
                ? "Native OpenCode agent — managed in OpenCode."
                : undefined
          }
          returnFocus={() =>
            selected ? findTrigger("detail", selected) : null
          }
        />
      ) : null}

      {editing ? (
        <AgentEditModal
          agent={editing}
          row={data?.rows.find((r) => r.name === editing)}
          assigned={editingPresentation?.assigned}
          initialModel={
            data?.rows.find((r) => r.name === editing)?.effectiveModel ??
            data?.rows.find((r) => r.name === editing)?.desiredModel
          }
          initialVariant={
            data?.rows.find((r) => r.name === editing)?.effectiveVariant
          }
          returnFocus={() => findTrigger(editReturnKind.current, editing)}
          onClose={() => setEditing(null)}
          onApplied={() => void refreshAll()}
        />
      ) : null}
      {editingCaps ? (
        <CapabilityEditModal
          agent={editingCaps}
          onClose={() => setEditingCaps(null)}
          onApplied={() => void refreshAll()}
          returnFocus={() => findTrigger("caps", editingCaps)}
        />
      ) : null}
    </div>
  );
}

function RosterSection(props: {
  group: ReturnType<typeof groupRoster>[number];
  names: { catalogNames?: ReadonlyMap<string, string>; providerNames?: ReadonlyMap<string, string> };
  selected: string | null;
  onOpenDetail: (name: string) => void;
  onEdit: (name: string) => void;
  onEditCaps: (name: string) => void;
}) {
  const { group } = props;
  return (
    <>
      <RosterGroupHeader group={group} colSpan={5} />
      {group.rows.map((r) => (
        <AgentAssignmentRow
          key={r.name}
          row={r}
          catalogNames={props.names.catalogNames}
          providerNames={props.names.providerNames}
          selected={props.selected === r.name}
          hideSource={
            group.rows.length > 1 &&
            !!group.defaultSource &&
            r.sourceLabel === group.defaultSource
          }
          onOpenDetail={() => props.onOpenDetail(r.name)}
          onEdit={() => props.onEdit(r.name)}
          onEditCaps={
            r.canEdit ? () => props.onEditCaps(r.name) : undefined
          }
        />
      ))}
    </>
  );
}
