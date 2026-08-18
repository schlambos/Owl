/**
 * Team topology routes — URL + sessionStorage state (doc 34 "Persistence").
 *
 * Owns the per-tab control state for `/agents`, `/models` and `/providers`:
 *  - sessionStorage keys `omo-control.team.v1.agents|models|providers`
 *    (validated, key-versioned JSON per route: `{ filter, q, sort,
 *    showDisabled? }` with defaults OMITTED — an all-default state removes
 *    the key entirely);
 *  - URL parsing/normalization for `filter` / `q` / `sort`, Agents
 *    `disabled=1`, and focus params `model` / `provider` / `agent`;
 *  - migration (`filter=disabled` → `disabled=1`, `native=1` removed) and
 *    invalid-known-value cleanup via `replace`, preserving unknown params;
 *  - precedence: valid URL wins; missing controls use storage UNLESS valid
 *    focus is present, in which case they use defaults without overwriting
 *    storage; focus itself is NEVER persisted;
 *  - user control mutations clear focus first, then persist the deliberate
 *    state.
 *
 * The exact filter/sort id vocabularies live in `./topology` (single source
 * of truth); this module only validates against them. `./topology` never
 * imports this file, so there is no cycle.
 *
 * Browser guards: every sessionStorage access is wrapped — non-browser
 * (bun tests, SSR) and privacy-mode contexts degrade to "no storage" and
 * hydration still resolves from URL/defaults. URLSearchParams is used purely
 * as a data structure; navigation itself (push/replace) stays in the route
 * component.
 */
import {
  TEAM_AGENT_FILTER_IDS,
  TEAM_AGENT_SORT_IDS,
  TEAM_MODEL_DEFAULT_SORT,
  TEAM_MODEL_FILTER_IDS,
  TEAM_MODEL_SORT_IDS,
  TEAM_PROVIDER_DEFAULT_SORT,
  TEAM_PROVIDER_FILTER_IDS,
  TEAM_PROVIDER_SORT_IDS,
  type TeamAgentFilterId,
  type TeamAgentSortId,
  type TeamModelFilterId,
  type TeamModelSortId,
  type TeamProviderFilterId,
  type TeamProviderSortId,
  type TeamSort,
  type TeamSortDir,
} from "./topology";

export type { TeamSort, TeamSortDir } from "./topology";
export type {
  TeamAgentFilterId,
  TeamAgentSortId,
  TeamModelFilterId,
  TeamModelSortId,
  TeamProviderFilterId,
  TeamProviderSortId,
} from "./topology";

// ── Routes, storage keys, vocabularies ────────────────────────────────

export type TeamViewRoute = "agents" | "models" | "providers";

/** sessionStorage keys — current browser session only, per-tab (doc 34). */
export const TEAM_STORAGE_KEYS: Record<TeamViewRoute, string> = {
  agents: "omo-control.team.v1.agents",
  models: "omo-control.team.v1.models",
  providers: "omo-control.team.v1.providers",
};

export interface TeamRouteSpec<
  F extends string = string,
  S extends string = string,
> {
  readonly storageKey: string;
  readonly filterIds: readonly F[];
  readonly sortIds: readonly S[];
  /** `null` = default order omitted from URL (Agents team order). */
  readonly defaultSort: S | null;
  /** `showDisabled` exists only on Agents. */
  readonly supportsShowDisabled: boolean;
}

export const TEAM_ROUTE_SPECS: {
  readonly agents: TeamRouteSpec<TeamAgentFilterId, TeamAgentSortId>;
  readonly models: TeamRouteSpec<TeamModelFilterId, TeamModelSortId>;
  readonly providers: TeamRouteSpec<TeamProviderFilterId, TeamProviderSortId>;
} = {
  agents: {
    storageKey: TEAM_STORAGE_KEYS.agents,
    filterIds: TEAM_AGENT_FILTER_IDS,
    sortIds: TEAM_AGENT_SORT_IDS,
    defaultSort: null,
    supportsShowDisabled: true,
  },
  models: {
    storageKey: TEAM_STORAGE_KEYS.models,
    filterIds: TEAM_MODEL_FILTER_IDS,
    sortIds: TEAM_MODEL_SORT_IDS,
    defaultSort: TEAM_MODEL_DEFAULT_SORT,
    supportsShowDisabled: false,
  },
  providers: {
    storageKey: TEAM_STORAGE_KEYS.providers,
    filterIds: TEAM_PROVIDER_FILTER_IDS,
    sortIds: TEAM_PROVIDER_SORT_IDS,
    defaultSort: TEAM_PROVIDER_DEFAULT_SORT,
    supportsShowDisabled: false,
  },
};

function specOf(route: TeamViewRoute): TeamRouteSpec<string, string> {
  return TEAM_ROUTE_SPECS[route];
}

// ── Control state types ───────────────────────────────────────────────

/** Resolved controls for one route (defaults: filter "all", q "", default sort, showDisabled false). */
export interface TeamControls<
  F extends string = string,
  S extends string = string,
> {
  filter: F;
  q: string;
  /** null = Agents default team order; models/providers always resolve their default id. */
  sort: TeamSort<S> | null;
  /** Agents only; always false on models/providers. */
  showDisabled: boolean;
}

export type TeamRouteFilterId<R extends TeamViewRoute> =
  R extends "agents"
    ? TeamAgentFilterId
    : R extends "models"
      ? TeamModelFilterId
      : TeamProviderFilterId;

export type TeamRouteSortId<R extends TeamViewRoute> =
  R extends "agents"
    ? TeamAgentSortId
    : R extends "models"
      ? TeamModelSortId
      : TeamProviderSortId;

export type TeamRouteControls<R extends TeamViewRoute> = TeamControls<
  TeamRouteFilterId<R>,
  TeamRouteSortId<R>
>;

export const DEFAULT_TEAM_CONTROLS: TeamControls = {
  filter: "all",
  q: "",
  sort: null,
  showDisabled: false,
};

/** Transient focus params — never persisted. */
export interface TeamFocusState {
  /** Canonical `provider/model` key (single `model` param value). */
  model?: string;
  provider?: string;
  /** Active eligible agent name (the only valid Agents focus targets). */
  agent?: string;
}

// ── Sort value codec ──────────────────────────────────────────────────

/**
 * Parse a sort param/storage value: `id` (dir asc) or `id:asc` / `id:desc`.
 * Unknown id or direction suffix → null (invalid → cleaned from the URL).
 */
export function parseTeamSortValue(
  route: TeamViewRoute,
  raw: string | null | undefined,
): TeamSort<string> | null {
  if (raw == null || raw === "") return null;
  const spec = specOf(route);
  const i = raw.indexOf(":");
  const id = i < 0 ? raw : raw.slice(0, i);
  const dirRaw = i < 0 ? "asc" : raw.slice(i + 1);
  if (!spec.sortIds.includes(id)) return null;
  if (dirRaw !== "asc" && dirRaw !== "desc") return null;
  return { id, dir: dirRaw };
}

/** Serialize a sort to its compact param/storage value (`id` for asc, `id:desc` otherwise). */
export function teamSortParamValue(sort: TeamSort<string>): string {
  return sort.dir === "asc" ? sort.id : `${sort.id}:${sort.dir}`;
}

function normalizeSort(
  route: TeamViewRoute,
  sort: TeamSort<string> | null | undefined,
): TeamSort<string> | null {
  if (!sort) return null;
  if (!specOf(route).sortIds.includes(sort.id)) return null;
  return { id: sort.id, dir: sort.dir === "desc" ? "desc" : "asc" };
}

/** True when the sort equals the route default (→ omitted from URL/storage). */
function isDefaultSort(
  route: TeamViewRoute,
  sort: TeamSort<string> | null,
): boolean {
  const def = specOf(route).defaultSort;
  if (def == null) return sort == null;
  return sort != null && sort.id === def && sort.dir === "asc";
}

function defaultSortOf(route: TeamViewRoute): TeamSort<string> | null {
  const def = specOf(route).defaultSort;
  return def == null ? null : { id: def, dir: "asc" };
}

// ── sessionStorage (guarded for test/SSR contexts) ────────────────────

const MAX_STORED_LENGTH = 4096;

function safeSessionStorage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window) return null;
    const s = window.sessionStorage;
    if (!s || typeof s.getItem !== "function") return null;
    return s;
  } catch {
    // Privacy modes can throw on mere access — degrade to "no storage".
    return null;
  }
}

function safeGetItem(key: string): string | null {
  const s = safeSessionStorage();
  if (!s) return null;
  try {
    return s.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key: string, value: string): void {
  const s = safeSessionStorage();
  if (!s) return;
  try {
    s.setItem(key, value);
  } catch {
    /* quota/blocked — persistence is best-effort */
  }
}

function safeRemoveItem(key: string): void {
  const s = safeSessionStorage();
  if (!s) return;
  try {
    s.removeItem(key);
  } catch {
    /* ignore */
  }
}

/**
 * Parse + validate one stored route object. Known fields are validated
 * individually (invalid fields fall back to defaults — the rest of the
 * object survives); corrupt/non-object payloads are rejected wholesale.
 * Returns null when nothing valid is stored.
 */
function parseStoredControls(
  route: TeamViewRoute,
  raw: string | null,
): TeamControls | null {
  if (typeof raw !== "string" || !raw || raw.length > MAX_STORED_LENGTH) {
    return null;
  }
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const spec = specOf(route);
  const filter =
    typeof o.filter === "string" && spec.filterIds.includes(o.filter)
      ? o.filter
      : "all";
  const q = typeof o.q === "string" ? o.q.trim() : "";
  const sort =
    typeof o.sort === "string"
      ? parseTeamSortValue(route, o.sort)
      : null;
  const showDisabled = spec.supportsShowDisabled && o.showDisabled === true;
  return {
    filter,
    q,
    sort: sort ?? defaultSortOf(route),
    showDisabled,
  };
}

/** Read + validate the stored per-tab state; null when absent/corrupt. */
export function loadTeamControls<R extends TeamViewRoute>(
  route: R,
): TeamRouteControls<R> | null {
  const raw = safeGetItem(TEAM_ROUTE_SPECS[route].storageKey);
  const parsed = parseStoredControls(route, raw);
  return (parsed as TeamRouteControls<R> | null) ?? null;
}

/**
 * Persist the deliberate control state. Defaults are OMITTED; an all-default
 * state removes the key entirely. Focus is never part of the payload. No-op
 * outside a browser session (tests/SSR).
 */
export function saveTeamControls<R extends TeamViewRoute>(
  route: R,
  controls: TeamRouteControls<R>,
): void {
  const spec = specOf(route);
  const c = controls as unknown as TeamControls;
  const o: Record<string, unknown> = {};
  const filter =
    typeof c.filter === "string" && spec.filterIds.includes(c.filter)
      ? c.filter
      : "all";
  if (filter !== "all") o.filter = filter;
  const q = typeof c.q === "string" ? c.q.trim() : "";
  if (q) o.q = q;
  const sort = normalizeSort(route, c.sort);
  if (sort != null && !isDefaultSort(route, sort)) {
    o.sort = teamSortParamValue(sort);
  }
  if (spec.supportsShowDisabled && c.showDisabled === true) {
    o.showDisabled = true;
  }
  const key = spec.storageKey;
  if (Object.keys(o).length === 0) {
    safeRemoveItem(key);
    return;
  }
  safeSetItem(key, JSON.stringify(o));
}

// ── URL hydration ─────────────────────────────────────────────────────

export interface TeamHydrationOptions {
  /**
   * Eligibility predicate for the `agent` focus param (from topology —
   * active eligible agents only). While route data is still loading, call
   * without it (focus is kept); re-hydrate with it once data arrives and an
   * invalid agent focus is removed via `cleanedParams` (replace).
   */
  isAgentFocusValid?: (agentName: string) => boolean;
}

export interface TeamHydration<R extends TeamViewRoute = TeamViewRoute> {
  route: R;
  /** Resolved controls: valid URL > storage > defaults (focus-aware). */
  controls: TeamRouteControls<R>;
  /** Validated focus params (kept, never persisted). */
  focus: TeamFocusState;
  /** Any valid focus param present. */
  hasFocus: boolean;
  /**
   * Non-null when the URL needed migration/cleanup (invalid known values,
   * `filter=disabled` migration, `native=1` removal, invalid `agent` focus,
   * blank `model`/`provider`/`q`). Navigate with REPLACE to these params;
   * null means the URL is already clean. Unknown params are preserved.
   */
  cleanedParams: URLSearchParams | null;
}

function toParams(
  params: URLSearchParams | string | null | undefined,
): URLSearchParams {
  if (params == null) return new URLSearchParams();
  return new URLSearchParams(params);
}

/**
 * Hydrate one Team route's view state from URL + sessionStorage.
 *
 * Precedence per control: valid URL value → stored value (only when NO valid
 * focus is present) → default. With valid focus present, missing controls
 * use DEFAULTS and storage is never read-for-display nor overwritten.
 *
 * Migration + cleanup (collected into `cleanedParams`, applied by the caller
 * via replace):
 *  - `filter=disabled` → `disabled=1` on Agents (filter param removed);
 *    on models/providers it is simply an invalid filter → removed.
 *  - `native=1` removed (native agents are excluded by eligibility now).
 *  - invalid `filter` / `sort` / blank `q` / non-`1` `disabled` removed.
 *  - invalid `agent` focus (per `isAgentFocusValid`) removed; `model` /
 *    `provider` focus values are kept when non-empty even if not in the
 *    scoped set (the view shows its topology-empty state, focus preserved).
 *  - unknown params are preserved untouched.
 */
export function hydrateTeamView<R extends TeamViewRoute>(
  route: R,
  params: URLSearchParams | string | null | undefined,
  opts?: TeamHydrationOptions,
): TeamHydration<R> {
  const spec = specOf(route);
  const p = toParams(params);
  let changed = false;

  // Migration: filter=disabled → disabled=1 (Agents) ; native=1 removed.
  if (p.get("filter") === "disabled") {
    if (spec.supportsShowDisabled) p.set("disabled", "1");
    p.delete("filter");
    changed = true;
  }
  if (p.has("native")) {
    p.delete("native");
    changed = true;
  }

  // filter
  let urlFilter: string | null = null;
  const rawFilter = p.get("filter");
  if (rawFilter != null) {
    if (spec.filterIds.includes(rawFilter)) {
      urlFilter = rawFilter;
    } else {
      p.delete("filter");
      changed = true;
    }
  }

  // sort
  let urlSort: TeamSort<string> | null = null;
  const rawSort = p.get("sort");
  if (rawSort != null) {
    urlSort = parseTeamSortValue(route, rawSort);
    if (urlSort == null) {
      p.delete("sort");
      changed = true;
    }
  }

  // q (blank/whitespace-only is invalid → default)
  let urlQ: string | null = null;
  const rawQ = p.get("q");
  if (rawQ != null) {
    const trimmed = rawQ.trim();
    if (trimmed) {
      urlQ = trimmed;
    } else {
      p.delete("q");
      changed = true;
    }
  }

  // disabled=1 (Agents only; other values removed)
  let urlShowDisabled: boolean | null = null;
  if (spec.supportsShowDisabled) {
    const rawDisabled = p.get("disabled");
    if (rawDisabled != null) {
      if (rawDisabled === "1") {
        urlShowDisabled = true;
      } else {
        p.delete("disabled");
        changed = true;
      }
    }
  }

  // Focus params.
  const focus: TeamFocusState = {};
  const rawModel = p.get("model");
  if (rawModel != null) {
    const trimmed = rawModel.trim();
    if (trimmed) {
      focus.model = trimmed;
    } else {
      p.delete("model");
      changed = true;
    }
  }
  const rawProvider = p.get("provider");
  if (rawProvider != null) {
    const trimmed = rawProvider.trim();
    if (trimmed) {
      focus.provider = trimmed;
    } else {
      p.delete("provider");
      changed = true;
    }
  }
  const rawAgent = p.get("agent");
  if (rawAgent != null) {
    const trimmed = rawAgent.trim();
    if (!trimmed) {
      p.delete("agent");
      changed = true;
    } else if (opts?.isAgentFocusValid && !opts.isAgentFocusValid(trimmed)) {
      p.delete("agent");
      changed = true;
    } else {
      focus.agent = trimmed;
    }
  }

  const hasFocus =
    focus.model != null || focus.provider != null || focus.agent != null;

  // Storage is consulted only when no valid focus is present; hydration
  // NEVER writes storage (focus does not overwrite the stored tab state).
  const stored = hasFocus ? null : loadTeamControls(route);

  const controls: TeamControls = {
    filter: urlFilter ?? stored?.filter ?? DEFAULT_TEAM_CONTROLS.filter,
    q: urlQ ?? stored?.q ?? DEFAULT_TEAM_CONTROLS.q,
    sort:
      urlSort ??
      stored?.sort ??
      (stored == null ? defaultSortOf(route) : stored.sort),
    showDisabled:
      urlShowDisabled ??
      stored?.showDisabled ??
      DEFAULT_TEAM_CONTROLS.showDisabled,
  };

  return {
    route,
    controls: controls as unknown as TeamRouteControls<R>,
    focus,
    hasFocus,
    cleanedParams: changed ? p : null,
  };
}

// ── Query mutation helpers ────────────────────────────────────────────

/** Patch of deliberate user control changes (values validated per route). */
export interface TeamControlPatch {
  filter?: string;
  q?: string;
  /** null = restore default order (Agents team order). */
  sort?: TeamSort<string> | null;
  showDisabled?: boolean;
}

/**
 * Apply a user-initiated control change (filter/q/sort/showDisabled).
 *
 * Semantics (doc 34): user controls FIRST clear focus (`model`/`provider`/
 * `agent`), then the deliberate state is written into the URL params
 * (defaults removed) and persisted to sessionStorage. Returns the next
 * params — navigate with REPLACE (focus removal must not spam history) —
 * and the resolved controls to feed the view. Storage writes are no-ops
 * outside a browser session.
 */
export function commitTeamControls<R extends TeamViewRoute>(
  route: R,
  params: URLSearchParams | string | null | undefined,
  current: TeamRouteControls<R>,
  patch: TeamControlPatch,
): { params: URLSearchParams; controls: TeamRouteControls<R> } {
  const spec = specOf(route);
  const p = toParams(params);
  // 1. Clear focus.
  p.delete("model");
  p.delete("provider");
  p.delete("agent");

  const cur = current as unknown as TeamControls;
  // 2. Resolve the next deliberate state.
  const filter =
    patch.filter !== undefined ? patch.filter : cur.filter;
  const q = patch.q !== undefined ? patch.q : cur.q;
  const sort =
    patch.sort !== undefined ? patch.sort : cur.sort;
  const showDisabled =
    patch.showDisabled !== undefined ? patch.showDisabled : cur.showDisabled;

  const validFilter =
    typeof filter === "string" && spec.filterIds.includes(filter)
      ? filter
      : "all";
  const trimmedQ = typeof q === "string" ? q.trim() : "";
  const validSort = normalizeSort(route, sort);

  // 3. Write into the URL (default values removed).
  if (validFilter === "all") p.delete("filter");
  else p.set("filter", validFilter);
  if (trimmedQ) p.set("q", trimmedQ);
  else p.delete("q");
  if (validSort == null || isDefaultSort(route, validSort)) {
    p.delete("sort");
  } else {
    p.set("sort", teamSortParamValue(validSort));
  }
  if (spec.supportsShowDisabled) {
    if (showDisabled === true) p.set("disabled", "1");
    else p.delete("disabled");
  }

  const controls: TeamControls = {
    filter: validFilter,
    q: trimmedQ,
    sort: validSort ?? defaultSortOf(route),
    showDisabled: spec.supportsShowDisabled && showDisabled === true,
  };

  // 4. Persist the deliberate state.
  saveTeamControls(route, controls as unknown as TeamRouteControls<R>);

  return {
    params: p,
    controls: controls as unknown as TeamRouteControls<R>,
  };
}

/**
 * Visible `Clear focus`: removes `model`/`provider`/`agent` (navigate with
 * REPLACE) while preserving every unrelated param. Storage is untouched —
 * after this navigation, controls absent from the URL resolve from the
 * stored tab state again (restoring it).
 */
export function clearTeamFocus(
  params: URLSearchParams | string | null | undefined,
): URLSearchParams {
  const p = toParams(params);
  p.delete("model");
  p.delete("provider");
  p.delete("agent");
  return p;
}

/**
 * Build focus-navigation params: the provided focus triple REPLACES any
 * existing focus params; control params (`filter`/`q`/`sort`/`disabled`)
 * and unknown params are left untouched, and nothing is persisted — focus
 * navigation never saves state.
 */
export function setTeamFocus(
  params: URLSearchParams | string | null | undefined,
  focus: TeamFocusState,
): URLSearchParams {
  const p = toParams(params);
  for (const key of ["model", "provider", "agent"] as const) {
    const v = focus[key];
    if (typeof v === "string" && v.trim()) p.set(key, v.trim());
    else p.delete(key);
  }
  return p;
}

/** Convenience for cross-nav links: `/models?model=openai/gpt-x` etc. */
export function teamFocusPath(path: string, focus: TeamFocusState): string {
  const qs = setTeamFocus(new URLSearchParams(), focus).toString();
  return qs ? `${path}?${qs}` : path;
}
