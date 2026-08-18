import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import { Button } from "../components/ui/Button";
import { StatusBadge } from "../components/ui/StatusBadge";
import { Surface } from "../components/ui/Surface";
import { cx } from "../components/ui/cx";
import "../styles/policy.css";

interface PresetAgentRow {
  agent: string;
  presetValue: Record<string, unknown>;
  rootOverride?: Record<string, unknown>;
  maskedFields: string[];
  runtimeSwitchWouldChange: string[];
}

interface PresetSummary {
  name: string;
  sourceScopes: string[];
  configuredActive: boolean;
  runtimeStateKnown: boolean;
  agentCount: number;
  maskedFieldCount: number;
  warnings: string[];
  agents: PresetAgentRow[];
  raw: Record<string, unknown>;
}

interface Inventory {
  presets: PresetSummary[];
  configuredPreset?: string;
  envPreset?: string;
  effectiveStartupPreset?: string;
  runtimePreset: { known: boolean; mechanism: string };
  warnings: string[];
}

type CompareMode = "desired" | "load-effective" | "runtime-switch";

const COMPARE_MODES: Array<{ id: CompareMode; label: string }> = [
  { id: "desired", label: "Desired" },
  { id: "load-effective", label: "Load-effective" },
  { id: "runtime-switch", label: "Runtime-switch" },
];

export function PresetsPage() {
  const [data, setData] = useState<Inventory | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [compare, setCompare] = useState<string | null>(null);
  const [compareMode, setCompareMode] = useState<CompareMode>("desired");
  const [compareResult, setCompareResult] = useState<{
    rows: Array<{ agent: string; field: string; aValue: unknown; bValue: unknown }>;
  } | null>(null);
  const [impact, setImpact] = useState<
    Array<{ agent: string; field: string; before: unknown; after: unknown }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/presets");
      if (!r.ok) throw new Error(`presets → ${r.status}`);
      const d = (await r.json()) as Inventory;
      setData(d);
      if (!selected && d.presets[0]) setSelected(d.presets[0].name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [selected]);

  useEffect(() => {
    void load();
  }, [load]);

  const preset = data?.presets.find((p) => p.name === selected) ?? null;

  const loadCompare = useCallback(async () => {
    if (!selected || !compare) return;
    const r = await fetch(
      `/api/presets/compare?a=${encodeURIComponent(selected)}&b=${encodeURIComponent(compare)}&mode=${compareMode}`,
    );
    setCompareResult(await r.json());
  }, [selected, compare, compareMode]);

  useEffect(() => {
    void loadCompare();
  }, [loadCompare]);

  const loadImpact = useCallback(async () => {
    if (!selected) return;
    const r = await fetch(
      `/api/presets/${encodeURIComponent(selected)}/switch-impact`,
    );
    const d = await r.json();
    setImpact(d.impact ?? []);
  }, [selected]);

  useEffect(() => {
    void loadImpact();
  }, [loadImpact]);

  const hash = async (scope: "user" | "project") => {
    const st = await fetch("/api/config/edit-state").then((r) => r.json());
    return scope === "user" ? st.user.hash : st.project.hash;
  };

  const act = async (path: string, body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!d.ok) {
        setError((d.errors || []).join("; "));
        return;
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const createEmpty = async () => {
    if (!newName.trim()) return;
    await act("/api/config/preset/create", {
      scope: "user",
      name: newName.trim(),
      initial: { mode: "empty" },
      expectedSourceHash: await hash("user"),
    });
    setNewName("");
  };

  const clone = async () => {
    if (!selected || !newName.trim()) return;
    await act("/api/config/preset/create", {
      scope: "user",
      name: newName.trim(),
      initial: { mode: "clone", sourcePreset: selected },
      expectedSourceHash: await hash("user"),
    });
    setNewName("");
  };

  const rename = async () => {
    if (!selected || !newName.trim()) return;
    await act("/api/config/preset/rename", {
      scope: "user",
      oldName: selected,
      newName: newName.trim(),
      updateConfigured: true,
      expectedSourceHash: await hash("user"),
    });
    setNewName("");
  };

  const remove = async () => {
    if (!selected) return;
    await act("/api/config/preset/delete", {
      scope: "user",
      name: selected,
      expectedSourceHash: await hash("user"),
    });
  };

  const setConfigured = async () => {
    if (!selected) return;
    await act("/api/config/preset/set-configured", {
      scope: "user",
      value: selected,
      expectedSourceHash: await hash("user"),
    });
  };

  const presetNames = useMemo(
    () => (data?.presets ?? []).map((p) => p.name),
    [data],
  );

  const visiblePresets = useMemo(() => {
    const n = query.trim().toLowerCase();
    return (data?.presets ?? []).filter(
      (p) => !n || p.name.toLowerCase().includes(n),
    );
  }, [data, query]);

  return (
    <div className="omo-policy">
      <PageHeader
        title="Presets"
        meta={
          data
            ? `configured ${data.configuredPreset ?? "—"} · env ${data.envPreset ?? "—"} · runtime unknown`
            : undefined
        }
        onRefresh={() => void load()}
        loading={loading}
      />
      {error ? <div className="error">{error}</div> : null}

      {data?.warnings?.map((w, i) => (
        <div key={i} className="warn-block">
          {w}
        </div>
      ))}

      <Surface className="omo-policy-surface" padding="md">
        <h2 className="omo-policy-kicker">Runtime preset</h2>
        <p className="omo-policy-quiet">{data?.runtimePreset.mechanism}</p>
      </Surface>

      <div className="omo-policy-frame">
        <aside className="omo-policy-side">
          <label className="omo-sr-only" htmlFor="preset-search">
            Search presets
          </label>
          <input
            id="preset-search"
            className="omo-policy-search"
            type="search"
            autoComplete="off"
            spellCheck={false}
            placeholder="Search presets…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="omo-policy-list">
            {visiblePresets.map((p) => (
              <button
                key={p.name}
                type="button"
                className="omo-policy-row"
                aria-current={selected === p.name ? "true" : undefined}
                onClick={() => setSelected(p.name)}
              >
                <span className="omo-policy-row-head">
                  <span className="omo-policy-row-title">{p.name}</span>
                  {p.configuredActive ? (
                    <StatusBadge tone="ok">configured</StatusBadge>
                  ) : null}
                </span>
                <span className="omo-policy-row-meta">
                  {p.agentCount} agents
                  {p.maskedFieldCount ? ` · ${p.maskedFieldCount} masked` : ""}
                  {p.sourceScopes.length
                    ? ` · ${p.sourceScopes.join("+")}`
                    : ""}
                </span>
              </button>
            ))}
          </div>
          <div className="omo-policy-composer">
            <label className="omo-sr-only" htmlFor="preset-new-name">
              New preset name
            </label>
            <input
              id="preset-new-name"
              className="omo-policy-input"
              placeholder="new preset name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <div className="omo-policy-toolbar">
              <Button size="sm" disabled={busy} onClick={() => void createEmpty()}>
                + Empty
              </Button>
              <Button
                size="sm"
                disabled={busy || !selected}
                onClick={() => void clone()}
              >
                Clone
              </Button>
              <Button
                size="sm"
                disabled={busy || !selected}
                onClick={() => void rename()}
              >
                Rename
              </Button>
            </div>
          </div>
        </aside>

        <section className="omo-policy-pane">
          {!preset ? (
            <p className="omo-policy-empty">Select a preset.</p>
          ) : (
            <>
              <div className="omo-policy-head">
                <div className="omo-policy-head-text">
                  <h2 className="omo-policy-title">{preset.name}</h2>
                  <div className="omo-policy-badges">
                    {preset.configuredActive ? (
                      <StatusBadge tone="ok">configured active</StatusBadge>
                    ) : null}
                    <StatusBadge tone="warn">runtime unknown</StatusBadge>
                    <StatusBadge>
                      {preset.sourceScopes.join(" + ") || "none"}
                    </StatusBadge>
                  </div>
                </div>
                <div className="omo-policy-toolbar">
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void setConfigured()}
                  >
                    Set configured
                  </Button>
                  <Button size="sm" disabled={busy} onClick={() => void remove()}>
                    Delete
                  </Button>
                </div>
              </div>

              {preset.warnings.map((w, i) => (
                <div key={i} className="warn-block">
                  {w}
                </div>
              ))}

              <div className="omo-policy-section">
                <h3 className="omo-policy-kicker">Agents</h3>
                <div className="omo-policy-table-wrap omo-policy-table-wrap-inset">
                  <table className="data omo-policy-table">
                    <thead>
                      <tr>
                        <th>Agent</th>
                        <th>Model</th>
                        <th>Variant</th>
                        <th>Temp</th>
                        <th>Skills</th>
                        <th>MCPs</th>
                        <th>Masked fields</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preset.agents.map((a) => (
                        <tr key={a.agent}>
                          <td>
                            <strong>{a.agent}</strong>
                          </td>
                          <td className="omo-mono">
                            {String(a.presetValue.model ?? "—")}
                          </td>
                          <td className="omo-mono">
                            {String(a.presetValue.variant ?? "—")}
                          </td>
                          <td className="omo-mono">
                            {String(a.presetValue.temperature ?? "—")}
                          </td>
                          <td className="omo-mono">
                            {Array.isArray(a.presetValue.skills)
                              ? JSON.stringify(a.presetValue.skills)
                              : "—"}
                          </td>
                          <td className="omo-mono">
                            {Array.isArray(a.presetValue.mcps)
                              ? JSON.stringify(a.presetValue.mcps)
                              : "—"}
                          </td>
                          <td>
                            {a.maskedFields.length ? (
                              <span className="pill warn">
                                {a.maskedFields.join(", ")}
                              </span>
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                      ))}
                      {preset.agents.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="omo-policy-empty-cell">
                            Empty preset
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="omo-policy-section">
                <h3 className="omo-policy-kicker">
                  Runtime switch impact (/preset — preset wins)
                </h3>
                {impact.length === 0 ? (
                  <p className="omo-policy-quiet">
                    No field changes if activated at runtime.
                  </p>
                ) : (
                  <div className="omo-policy-table-wrap omo-policy-table-wrap-inset">
                    <table className="data omo-policy-table">
                      <thead>
                        <tr>
                          <th>Agent</th>
                          <th>Field</th>
                          <th>Load-effective</th>
                          <th>Runtime-switch</th>
                        </tr>
                      </thead>
                      <tbody>
                        {impact.map((r, i) => (
                          <tr key={i}>
                            <td>{r.agent}</td>
                            <td>{r.field}</td>
                            <td className="omo-mono">{JSON.stringify(r.before)}</td>
                            <td className="omo-mono">{JSON.stringify(r.after)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="omo-policy-section">
                <h3 className="omo-policy-kicker">Compare</h3>
                <div className="omo-policy-toolbar">
                  <label className="omo-sr-only" htmlFor="preset-compare-target">
                    Compare against
                  </label>
                  <select
                    id="preset-compare-target"
                    className="omo-policy-select"
                    value={compare ?? ""}
                    onChange={(e) => setCompare(e.target.value || null)}
                  >
                    <option value="">Choose preset…</option>
                    {presetNames
                      .filter((n) => n !== selected)
                      .map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                  </select>
                  <div className="omo-policy-tabs" role="tablist" aria-label="Compare mode">
                    {COMPARE_MODES.map((mode) => (
                      <button
                        key={mode.id}
                        type="button"
                        role="tab"
                        className="omo-policy-tab"
                        aria-selected={compareMode === mode.id}
                        onClick={() => setCompareMode(mode.id)}
                      >
                        {mode.label}
                      </button>
                    ))}
                  </div>
                </div>
                {compareResult ? (
                  <div className="omo-policy-table-wrap omo-policy-table-wrap-inset">
                    <table className="data omo-policy-table">
                      <thead>
                        <tr>
                          <th>Agent</th>
                          <th>Field</th>
                          <th>{selected}</th>
                          <th>{compare}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {compareResult.rows.map((r, i) => (
                          <tr key={i}>
                            <td>{r.agent}</td>
                            <td>{r.field}</td>
                            <td className="omo-mono">{JSON.stringify(r.aValue)}</td>
                            <td className="omo-mono">{JSON.stringify(r.bValue)}</td>
                          </tr>
                        ))}
                        {compareResult.rows.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="omo-policy-empty-cell">
                              No differences
                            </td>
                          </tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </div>

              <div className="omo-policy-section">
                <h3 className="omo-policy-kicker">Raw desired preset</h3>
                <pre className={cx("omo-policy-pre", "omo-policy-pre-raw")}>
                  {JSON.stringify(preset.raw, null, 2)}
                </pre>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
