import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { LiveProvider } from "@omo/shared";
import type { ModelAvailabilityContextValue } from "../../../models/ModelAvailabilityContext";
import { ProbeBadge } from "../../../models/ProbeBadge";
import type { ChainEntryState } from "./types";
import { entryRawId, probeOf, splitModelId } from "./model-utils";

export function ModelBrowser(props: {
  entry: ChainEntryState;
  providers: readonly LiveProvider[];
  catalogFilter: string;
  onCatalogFilter: (value: string) => void;
  avail: ModelAvailabilityContextValue | null;
  currentMissing: boolean;
  providerMissing: boolean;
  models: LiveProvider["models"];
  onProvider: (providerId: string) => void;
  onModel: (modelId: string) => void;
  filterId?: string;
}) {
  const listId = useId();
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const connected = props.providers.filter((p) => p.connected);
  const unavailable = props.providers.filter((p) => !p.connected);

  // Results default to the SELECTED provider only; a search query is the
  // explicit way to broaden across providers (indicated below the field).
  const needle = props.catalogFilter.trim().toLowerCase();
  const providerScoped = needle === "" && !!props.entry.providerId;

  const results = useMemo(() => {
    const rows: Array<{
      providerId: string;
      providerName: string;
      connected: boolean;
      modelId: string;
      displayName: string;
      current: boolean;
    }> = [];
    const scanned = providerScoped
      ? props.providers.filter((p) => p.id === props.entry.providerId)
      : props.providers;
    for (const p of scanned) {
      for (const m of p.models) {
        const display = m.name && m.name !== m.id ? m.name : m.id;
        const hay = `${display} ${p.name} ${p.id} ${m.id}`.toLowerCase();
        if (needle && !hay.includes(needle)) continue;
        rows.push({
          providerId: p.id,
          providerName: p.name,
          connected: p.connected,
          modelId: m.id,
          displayName: display,
          current:
            p.id === props.entry.providerId && m.id === props.entry.modelId,
        });
      }
    }
    if (props.currentMissing && props.entry.providerId && props.entry.modelId) {
      const already = rows.some(
        (r) =>
          r.providerId === props.entry.providerId &&
          r.modelId === props.entry.modelId,
      );
      if (!already) {
        const hay = `${props.entry.modelId} ${props.entry.providerId}`.toLowerCase();
        if (!needle || hay.includes(needle)) {
          const p = props.providers.find((x) => x.id === props.entry.providerId);
          rows.unshift({
            providerId: props.entry.providerId,
            providerName: p?.name ?? props.entry.providerId,
            connected: p?.connected ?? false,
            modelId: props.entry.modelId,
            displayName: props.entry.modelId,
            current: true,
          });
        }
      }
    }
    rows.sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1;
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      const byName = a.displayName.localeCompare(b.displayName);
      if (byName !== 0) return byName;
      return a.providerName.localeCompare(b.providerName);
    });
    return rows;
  }, [
    props.providers,
    props.catalogFilter,
    props.entry.providerId,
    props.entry.modelId,
    props.currentMissing,
    providerScoped,
  ]);

  useEffect(() => {
    const idx = results.findIndex((r) => r.current);
    setActiveIndex(idx >= 0 ? idx : 0);
  }, [results, props.entry.providerId, props.entry.modelId, props.catalogFilter]);

  const selectAt = (i: number) => {
    const row = results[i];
    if (!row) return;
    if (row.providerId !== props.entry.providerId) {
      props.onProvider(row.providerId);
    }
    props.onModel(row.modelId);
  };

  const focusResult = (i: number) => {
    listRef.current
      ?.querySelectorAll<HTMLElement>("[data-ame-result]")
      [i]?.focus();
  };

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.min(results.length - 1, activeIndex + 1);
      setActiveIndex(next);
      focusResult(next);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.max(0, activeIndex - 1);
      setActiveIndex(next);
      focusResult(next);
    } else if (e.key === "Enter") {
      e.preventDefault();
      selectAt(activeIndex);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
      focusResult(0);
    } else if (e.key === "End") {
      e.preventDefault();
      const last = results.length - 1;
      setActiveIndex(last);
      focusResult(last);
    }
  };

  const selectedRaw = entryRawId(props.entry);
  const selectedParts = selectedRaw ? splitModelId(selectedRaw) : null;

  // Visible scope indication: provider-scoped by default; a query is the
  // only path to cross-provider results, and that is stated too.
  const scopedProvider = props.entry.providerId
    ? props.providers.find((p) => p.id === props.entry.providerId)
    : undefined;
  const scopeNote = needle
    ? props.entry.providerId
      ? "Search active — matching every provider"
      : null
    : scopedProvider
      ? `Showing ${scopedProvider.name} models · search to match other providers`
      : null;

  return (
    <div className="ame-browser">
      <div className="ame-provider-board" role="group" aria-label="Providers">
        {connected.length > 0 ? (
          <div className="ame-provider-group">
            <h3 className="ame-provider-heading">Connected</h3>
            <div className="ame-provider-chips">
              {connected.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={
                    p.id === props.entry.providerId
                      ? "ame-provider-chip is-selected"
                      : "ame-provider-chip"
                  }
                  aria-pressed={p.id === props.entry.providerId}
                  onClick={() => props.onProvider(p.id)}
                >
                  <span className="ame-provider-name">{p.name}</span>
                  <span className="ame-provider-meta">
                    {p.id} · {p.modelCount}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {unavailable.length > 0 ? (
          <div className="ame-provider-group">
            <h3 className="ame-provider-heading">Configured / Unavailable</h3>
            <div className="ame-provider-chips">
              {unavailable.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={
                    p.id === props.entry.providerId
                      ? "ame-provider-chip is-selected is-unavailable"
                      : "ame-provider-chip is-unavailable"
                  }
                  aria-pressed={p.id === props.entry.providerId}
                  onClick={() => props.onProvider(p.id)}
                >
                  <span className="ame-provider-name">{p.name}</span>
                  <span className="ame-provider-meta">
                    {p.id} · {p.modelCount} · unavailable
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {props.providerMissing && props.entry.providerId ? (
          <p className="ame-quiet-note">
            Current provider <span className="mono">{props.entry.providerId}</span>{" "}
            is not in the live catalog and remains selectable.
          </p>
        ) : null}
      </div>

      <label className="ame-search-label" htmlFor={props.filterId ?? listId + "-q"}>
        Search models
        <input
          id={props.filterId ?? listId + "-q"}
          className="agents-catalog-filter"
          placeholder="Filter providers / models…"
          value={props.catalogFilter}
          onChange={(e) => props.onCatalogFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && results.length > 0) {
              e.preventDefault();
              focusResult(activeIndex);
            }
          }}
        />
      </label>

      {scopeNote ? <p className="ame-results-scope">{scopeNote}</p> : null}

      <div
        className="ame-results"
        id={listId}
        aria-label={
          providerScoped
            ? `Advertised models — ${scopedProvider?.name ?? props.entry.providerId}`
            : "Advertised models"
        }
        ref={listRef}
        onKeyDown={onListKeyDown}
      >
        {results.length === 0 ? (
          <div className="muted ame-results-empty">
            {props.catalogFilter
              ? `No models match “${props.catalogFilter}”.`
              : props.entry.providerId
                ? "No advertised models for this provider. Search to match other providers."
                : "Choose a provider or search across the live catalog."}
          </div>
        ) : (
          results.map((row, i) => {
            const av = probeOf(props.avail, {
              providerId: row.providerId,
              modelId: row.modelId,
            });
            const selected =
              row.providerId === props.entry.providerId &&
              row.modelId === props.entry.modelId;
            return (
              <button
                key={`${row.providerId}/${row.modelId}`}
                type="button"
                data-ame-result=""
                aria-current={selected ? "true" : undefined}
                className={selected ? "ame-result is-selected" : "ame-result"}
                tabIndex={i === activeIndex ? 0 : -1}
                onClick={() => selectAt(i)}
              >
                <span className="ame-result-main">
                  <span className="ame-result-name">{row.displayName}</span>
                  <span className="ame-result-provider">
                    {row.providerName}
                    {!row.connected ? " · unavailable" : ""}
                    {row.current && props.currentMissing
                      ? " · current — not currently advertised"
                      : ""}
                  </span>
                </span>
                <span className="ame-result-side">
                  <span className="ame-result-id mono">
                    {row.providerId}/{row.modelId}
                  </span>
                  {av ? (
                    <ProbeBadge
                      probe={av.probe}
                      showLatency={false}
                      showFreshness={false}
                    />
                  ) : null}
                </span>
              </button>
            );
          })
        )}
      </div>
      {selectedParts ? (
        <p className="ame-selected-hint muted">
          Selected{" "}
          <span className="mono">
            {selectedParts.providerId}/{selectedParts.modelId}
          </span>
        </p>
      ) : null}
    </div>
  );
}
