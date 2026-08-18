/**
 * Team topology views — shared chrome + state hooks (doc 34).
 *
 * The three Team routes (`/agents`, `/models`, `/providers`) are analytical
 * views over ONE normalized Effective-first topology. This module owns the
 * shared half of that contract:
 *
 *  - `useTeamTopology` — memoized topology from RuntimeContext (agents +
 *    providers DTOs), ModelAvailabilityContext (inventory/probes), the
 *    existing `/api/acp` inventory fetch, and the live catalog name maps.
 *    No duplicate runtime state, no waterfalls: one fetch per source, all
 *    derivations pure (`./topology`).
 *  - `useTeamView` — URL + sessionStorage control state via `./session-state`
 *    (URL wins; focus transient; cleaned params applied with replace).
 *  - `TeamHeader` — title + active-Effective counts ONLY (doc 34).
 *  - Small dense toolbar primitives (filter chips, sort control, sortable
 *    header, clear-focus) reused by all three views. No cards, no new
 *    visual system — existing Antigravity tokens/classes only.
 */
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "../../components/ui/Button";
import { WorkspaceHeader } from "../../components/layout/WorkspaceHeader";
import { useModelAvailabilityOptional } from "../../models/ModelAvailabilityContext";
import { useRuntime } from "../../runtime/RuntimeContext";
import {
  clearTeamFocus,
  commitTeamControls,
  hydrateTeamView,
  setTeamFocus,
  type TeamControlPatch,
  type TeamFocusState,
  type TeamRouteControls,
  type TeamViewRoute,
} from "./session-state";
import type { TeamSort } from "./session-state";
import type { ProbeLookup } from "../agents/presentation";
import {
  buildTeamTopology,
  formatTeamHeaderCounts,
  type TeamNameMaps,
  type TeamTopology,
} from "./topology";

// ── Topology hook ────────────────────────────────────────────────────

export interface UseTeamTopologyResult {
  topology: TeamTopology;
  names: TeamNameMaps;
  /** True once the AgentsDto arrived — agent focus validation activates. */
  agentsReady: boolean;
}

/**
 * One memoized Team topology per mounted route. Sources stay exactly the
 * existing plumbing: `useRuntime` (agents/providers), the optional model
 * availability context (inventory + probes), `/api/acp` (wrapper inventory),
 * and the live OpenCode catalog for display names.
 */
export function useTeamTopology(): UseTeamTopologyResult {
  const { agents, providers } = useRuntime();
  const avail = useModelAvailabilityOptional();

  const [acpNames, setAcpNames] = useState<readonly string[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/acp")
      .then((r) => r.json())
      .then((d: { agents?: Array<{ name: string }> }) => {
        if (cancelled) return;
        setAcpNames((d.agents ?? []).map((a) => a.name));
      })
      .catch(() => {
        /* ACP inventory unavailable — treat nothing as ACP-managed */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const names: TeamNameMaps = useMemo(() => {
    const catalogNames = new Map<string, string>();
    const providerNames = new Map<string, string>();
    for (const p of providers?.providers ?? []) {
      if (p.name && p.name !== p.id) providerNames.set(p.id, p.name);
      for (const m of p.models) {
        if (m.name && m.name !== m.id) catalogNames.set(`${p.id}/${m.id}`, m.name);
      }
    }
    return { catalogNames, providerNames };
  }, [providers]);

  const probe: ProbeLookup = useMemo(
    () => ({
      getProbe: (model) => {
        if (!model || !avail) return undefined;
        const i = model.indexOf("/");
        if (i < 0) return undefined;
        return avail.getModel(model.slice(0, i), model.slice(i + 1))?.probe;
      },
    }),
    [avail],
  );

  const topology = useMemo(
    () =>
      buildTeamTopology({
        agentsDto: agents,
        acpAgentNames: acpNames,
        probe,
        inventory: avail?.inventory ?? null,
        providersDto: providers,
      }),
    [agents, acpNames, probe, avail, providers],
  );

  return { topology, names, agentsReady: agents != null };
}

// ── Per-route view-state hook ────────────────────────────────────────

export interface TeamView<R extends TeamViewRoute> {
  controls: TeamRouteControls<R>;
  focus: TeamFocusState;
  hasFocus: boolean;
  searchParams: URLSearchParams;
  /** Deliberate control change: clears focus, persists, navigates replace. */
  commit: (patch: TeamControlPatch) => void;
  /** Visible Clear focus: removes focus params (replace), restores stored. */
  clearFocus: () => void;
  /** Same-route focus mutation (e.g. drawer open/close) — never persisted. */
  setFocus: (focus: TeamFocusState) => void;
}

export function useTeamView<R extends TeamViewRoute>(
  route: R,
  opts?: { isAgentFocusValid?: (name: string) => boolean },
): TeamView<R> {
  const [searchParams, setSearchParams] = useSearchParams();
  const isAgentFocusValid = opts?.isAgentFocusValid;

  const hydration = useMemo(
    () =>
      hydrateTeamView(
        route,
        searchParams,
        isAgentFocusValid ? { isAgentFocusValid } : undefined,
      ),
    [route, searchParams, isAgentFocusValid],
  );

  // Migration / invalid-known-value cleanup → replace, history stays clean.
  const cleaned = hydration.cleanedParams;
  useEffect(() => {
    if (cleaned) setSearchParams(cleaned, { replace: true });
  }, [cleaned, setSearchParams]);

  const commit = useCallback(
    (patch: TeamControlPatch) => {
      const { params } = commitTeamControls(
        route,
        searchParams,
        hydration.controls,
        patch,
      );
      setSearchParams(params, { replace: true });
    },
    [route, searchParams, hydration.controls, setSearchParams],
  );

  const clearFocus = useCallback(() => {
    setSearchParams(clearTeamFocus(searchParams), { replace: true });
  }, [searchParams, setSearchParams]);

  const setFocus = useCallback(
    (focus: TeamFocusState) => {
      setSearchParams(setTeamFocus(searchParams, focus), { replace: true });
    },
    [searchParams, setSearchParams],
  );

  return {
    controls: hydration.controls,
    focus: hydration.focus,
    hasFocus: hydration.hasFocus,
    searchParams,
    commit,
    clearFocus,
    setFocus,
  };
}

// ── Header ───────────────────────────────────────────────────────────

/**
 * Shared Team header: title + active-Effective counts only. Counts derive
 * from the active eligible topology and NEVER change with the Agents
 * Show-disabled toggle (that gate is view-local).
 */
export function TeamHeader(props: {
  topology: TeamTopology;
  onRefresh?: () => void;
  loading?: boolean;
}) {
  return (
    <WorkspaceHeader
      title="Team"
      meta={formatTeamHeaderCounts(props.topology.header)}
      actions={
        props.onRefresh ? (
          <Button onClick={props.onRefresh} disabled={props.loading}>
            {props.loading ? "Loading…" : "Refresh"}
          </Button>
        ) : undefined
      }
    />
  );
}

// ── Toolbar primitives ───────────────────────────────────────────────

/** Quiet radiogroup of count-carrying filter chips (existing pattern). */
export function TeamFilterChips(props: {
  ariaLabel: string;
  filter: string;
  ids: readonly string[];
  labels: Record<string, string>;
  counts: Record<string, number>;
  onChange: (id: string) => void;
}) {
  return (
    <div className="filter-chips" role="radiogroup" aria-label={props.ariaLabel}>
      {props.ids.map((id) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={props.filter === id}
          aria-label={`${props.labels[id]}, ${props.counts[id] ?? 0}`}
          className={`filter-chip ${props.filter === id ? "active" : ""}`}
          onClick={() => props.onChange(id)}
        >
          {props.labels[id]}
          <span className="count" aria-hidden="true">
            {props.counts[id] ?? 0}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Compact sort select + direction flip (existing roster pattern). */
export function TeamSortControl<S extends string>(props: {
  /** Resolved current sort (models/providers always carry their default). */
  sort: TeamSort<S> | null;
  /** Route default (null = Agents team order, omitted from URL). */
  defaultSort: TeamSort<S> | null;
  ids: readonly S[];
  labels: Record<S, string>;
  onChange: (sort: TeamSort<S> | null) => void;
}) {
  const { sort, defaultSort } = props;
  const currentId = sort?.id ?? defaultSort?.id ?? "";
  const atDefault =
    defaultSort == null
      ? sort == null
      : sort != null && sort.id === defaultSort.id && sort.dir === "asc";
  const canFlip = !atDefault && sort != null;
  const uid = useId();
  const selectId = `team-sort-${uid}`;

  return (
    <div className="team-roster-sort">
      <label className="team-roster-sort-label" htmlFor={selectId}>
        Sort
      </label>
      <select
        id={selectId}
        className="team-roster-sort-select"
        value={props.defaultSort == null ? (sort?.id ?? "default") : currentId}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "default") {
            props.onChange(null);
            return;
          }
          props.onChange({ id: v as S, dir: "asc" });
        }}
      >
        {props.defaultSort == null ? (
          <option value="default">Default</option>
        ) : null}
        {props.ids.map((id) => (
          <option key={id} value={id}>
            {props.labels[id]}
          </option>
        ))}
      </select>
      {canFlip ? (
        <button
          type="button"
          className="team-roster-sort-dir"
          onClick={() => {
            if (!sort) return;
            props.onChange({ id: sort.id, dir: sort.dir === "asc" ? "desc" : "asc" });
          }}
          aria-label={sort!.dir === "asc" ? "Sort descending" : "Sort ascending"}
        >
          <span aria-hidden="true">{sort!.dir === "asc" ? "Asc" : "Desc"}</span>
        </button>
      ) : null}
    </div>
  );
}

/**
 * Sortable `<th>` with the established click cycle (asc → desc → route
 * default) and text indicators. `aria-sort` only on sortable headers.
 */
export function TeamSortableHeader<S extends string>(props: {
  columnId: string;
  label: string;
  sortId: S;
  sort: TeamSort<S> | null;
  onSort: (sortId: S) => void;
}) {
  const { sortId, sort, label, columnId } = props;
  const isActive = sort?.id === sortId;
  const ariaSort: "ascending" | "descending" | "none" = isActive
    ? sort!.dir === "asc"
      ? "ascending"
      : "descending"
    : "none";
  const ariaLabel = !isActive
    ? `Sort by ${label.toLowerCase()}`
    : sort!.dir === "asc"
      ? `${label}, sorted ascending. Click to sort descending.`
      : `${label}, sorted descending. Click to restore default order.`;

  return (
    <th aria-sort={ariaSort} data-column={columnId}>
      <button
        type="button"
        className="sort-btn"
        onClick={() => props.onSort(sortId)}
        aria-label={ariaLabel}
      >
        {label}
        <span className={`sort-indicator ${isActive ? "active" : ""}`} aria-hidden="true">
          {isActive ? (sort!.dir === "asc" ? "▲" : "▼") : "·"}
        </span>
      </button>
    </th>
  );
}

/** Visible Clear focus affordance (only rendered with active focus). */
export function TeamClearFocus(props: { hasFocus: boolean; onClear: () => void }) {
  if (!props.hasFocus) return null;
  return (
    <button type="button" className="team-clear-focus" onClick={props.onClear}>
      Clear focus
    </button>
  );
}
