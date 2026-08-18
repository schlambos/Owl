import { useCallback, useEffect, useState, type ReactNode } from "react";
import { PageHeader } from "../components/PageHeader";
import { useModelAvailabilityOptional } from "../models/ModelAvailabilityContext";
import { ProbeBadge } from "../models/ProbeBadge";
import "../styles/specialists.css";

interface Member {
  name: string;
  modelPrimary?: string;
  chainLength?: number;
  variant?: string;
  hasPrompt: boolean;
  promptChars?: number;
  prompt?: string;
  warnings: string[];
}

interface Preset {
  name: string;
  sourceScopes: string[];
  isDefault: boolean;
  memberCount: number;
  uniqueModels: number;
  providers: string[];
  members: Member[];
  raw: Record<string, unknown>;
  empty: boolean;
}

interface CouncilData {
  default_preset?: string;
  effective_default_preset: string;
  defaultMissing: boolean;
  presets: Preset[];
  coordinator: { agent: string; note: string };
  deprecated: string[];
  warnings: string[];
}

export function CouncilPage() {
  const avail = useModelAvailabilityOptional();
  const [data, setData] = useState<CouncilData | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [newPreset, setNewPreset] = useState("");
  const [newMember, setNewMember] = useState("");
  const [newModel, setNewModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [runtimeSessions, setRuntimeSessions] = useState<
    Array<{ id: string; agent?: string; title?: string; status?: string }>
  >([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [inv, rt] = await Promise.all([
        fetch("/api/council").then((r) => r.json()),
        fetch("/api/council/runtime").then((r) => r.json()),
      ]);
      setData(inv);
      setRuntimeSessions(rt.sessions ?? []);
      if (!selected && inv.presets?.[0]) setSelected(inv.presets[0].name);
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

  const hash = async () => {
    const st = await fetch("/api/config/edit-state").then((r) => r.json());
    return st.user.hash;
  };

  const act = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/config/council/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "council",
          scope: "user",
          expectedSourceHash: await hash(),
          ...body,
        }),
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

  const createPreset = async (clone = false) => {
    if (!newPreset.trim()) return;
    await act({
      presetCreate: {
        name: newPreset.trim(),
        ...(clone && selected ? { cloneFrom: selected } : {}),
      },
    });
    setNewPreset("");
  };

  const addMember = async () => {
    if (!selected || !newMember.trim() || !newModel.trim()) return;
    await act({
      members: {
        preset: selected,
        ops: [
          {
            member: newMember.trim(),
            operation: "create",
            model: { operation: "set", value: newModel.trim() },
          },
        ],
      },
    });
    setNewMember("");
    setNewModel("");
  };

  const deleteMember = async (member: string) => {
    if (!selected) return;
    await act({
      members: { preset: selected, ops: [{ member, operation: "delete" }] },
    });
  };

  const setDefault = async () => {
    if (!selected) return;
    await act({ defaultPreset: { operation: "set", value: selected } });
  };

  const deletePreset = async () => {
    if (!selected) return;
    await act({ presetDelete: { name: selected } });
  };

  const visiblePresets = (data?.presets ?? []).filter((p) =>
    p.name.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  return (
    <div className="omo-spec">
      <PageHeader
        title="Council"
        meta={
          data
            ? `default ${data.effective_default_preset} · ${data.presets.length} presets`
            : undefined
        }
        onRefresh={() => void load()}
        loading={loading}
      />
      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}
      {data?.warnings.map((w, i) => (
        <div key={`w-${i}`} className="omo-spec-warn" role="status">
          {w}
        </div>
      ))}
      {data?.deprecated.map((w, i) => (
        <div key={`d-${i}`} className="omo-spec-warn" role="status">
          {w}
        </div>
      ))}

      {/* Coordinator / councillor distinction: the coordinator is a normal
          council agent edited elsewhere — this surface manages councillors. */}
      <div className="omo-spec-intro">
        <h2 className="omo-spec-intro-title">Coordinator / synthesis</h2>
        <p>{data?.coordinator.note}</p>
        <p>
          Configured as normal <code>council</code> agent. Edit via Agents /
          Prompts / Capabilities workspaces.
        </p>
      </div>

      <div className="omo-spec-frame">
        <aside className="omo-spec-side" aria-label="Councillor presets">
          <div className="omo-spec-side-head">
            <span>Presets</span>
            <span className="omo-spec-count">{visiblePresets.length}</span>
          </div>
          <input
            className="omo-spec-input"
            type="search"
            placeholder="Filter presets…"
            aria-label="Filter presets"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="omo-spec-list">
            {visiblePresets.map((p) => (
              <button
                key={p.name}
                type="button"
                className="omo-spec-row"
                aria-current={selected === p.name ? "true" : undefined}
                onClick={() => setSelected(p.name)}
              >
                <span className="omo-spec-row-title">
                  {p.name}
                  {p.isDefault ? <span className="pill ok">default</span> : null}
                </span>
                <span className="omo-spec-row-meta">
                  {p.memberCount} members · {p.uniqueModels} models
                </span>
                <span className="omo-spec-row-foot">
                  <span className="pill">{p.sourceScopes.join("+") || "—"}</span>
                </span>
              </button>
            ))}
            {visiblePresets.length === 0 ? (
              <div className="omo-spec-list-empty">
                No presets match.
              </div>
            ) : null}
          </div>
          <div className="omo-spec-create">
            <input
              className="omo-spec-input"
              placeholder="new preset"
              aria-label="New preset name"
              value={newPreset}
              onChange={(e) => setNewPreset(e.target.value)}
            />
            <div className="omo-spec-create-actions">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void createPreset(false)}
              >
                + Empty
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy || !selected}
                onClick={() => void createPreset(true)}
              >
                Clone
              </button>
            </div>
          </div>
        </aside>

        <section className="omo-spec-pane">
          {!preset ? (
            <div className="omo-spec-detail-empty">
              Select a councillor preset.
            </div>
          ) : (
            <>
              <div className="omo-spec-head">
                <div className="omo-spec-head-text">
                  <h2 className="omo-spec-title">{preset.name}</h2>
                  <div className="omo-spec-badges">
                    {preset.isDefault ? (
                      <span className="pill ok">default preset</span>
                    ) : null}
                    <span className="pill">{preset.memberCount} members</span>
                    <span className="pill">
                      {preset.providers.join(" / ") || "no providers"}
                    </span>
                  </div>
                </div>
                <div className="toolbar">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => void setDefault()}
                  >
                    Set default
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => void deletePreset()}
                  >
                    Delete
                  </button>
                </div>
              </div>

              <div className="omo-spec-body">
                <div className="section-title">Members</div>
                <div className="omo-spec-table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Member</th>
                        <th>Model</th>
                        <th>Probe</th>
                        <th>Chain</th>
                        <th>Variant</th>
                        <th>Prompt</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {preset.members.map((m) => {
                        // Reduced emphasis for members of non-default
                        // (inactive) presets; badges are probe evidence
                        // only — no auto-testing.
                        const dim = preset.isDefault ? "" : "probe-dim";
                        let probeCell: ReactNode = (
                          <span className="muted">—</span>
                        );
                        const raw = m.modelPrimary;
                        if (raw && avail) {
                          const slash = raw.indexOf("/");
                          if (slash > 0) {
                            const av = avail.getModel(
                              raw.slice(0, slash),
                              raw.slice(slash + 1),
                            );
                            probeCell = av ? (
                              <ProbeBadge probe={av.probe} showFreshness={false} />
                            ) : (
                              <span className="muted">Not tested</span>
                            );
                          }
                        }
                        return (
                          <tr
                            key={m.name}
                            className={
                              m.warnings.length > 0
                                ? "omo-spec-row-problem"
                                : undefined
                            }
                          >
                            <td>
                              <div className="omo-spec-member-name">{m.name}</div>
                              {m.warnings.map((w, i) => (
                                <div key={i} className="omo-spec-member-warn">
                                  {w}
                                </div>
                              ))}
                            </td>
                            <td className="mono">{m.modelPrimary ?? "—"}</td>
                            <td>
                              <span className={dim || undefined}>{probeCell}</span>
                            </td>
                            <td className="mono">{m.chainLength ?? 1}</td>
                            <td className="mono">{m.variant ?? "—"}</td>
                            <td>
                              {m.hasPrompt ? (
                                <span className="pill ok">{m.promptChars}c</span>
                              ) : (
                                <span className="muted">—</span>
                              )}
                            </td>
                            <td>
                              <button
                                type="button"
                                className="btn btn-xs"
                                onClick={() => void deleteMember(m.name)}
                              >
                                Delete
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                      {preset.members.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="muted">
                            Empty preset
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>

                <div className="omo-spec-panel">
                  <h3>Add member</h3>
                  <div className="omo-spec-form-row">
                    <input
                      className="omo-spec-input"
                      placeholder="member name"
                      aria-label="Member name"
                      value={newMember}
                      onChange={(e) => setNewMember(e.target.value)}
                    />
                    <input
                      className="omo-spec-input mono"
                      placeholder="provider/model"
                      aria-label="Provider and model"
                      value={newModel}
                      onChange={(e) => setNewModel(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => void addMember()}
                    >
                      Add
                    </button>
                  </div>
                </div>

                <div className="section-title">Raw desired</div>
                <pre className="msg-pre raw-json">{JSON.stringify(preset.raw, null, 2)}</pre>
              </div>
            </>
          )}
        </section>
      </div>

      <div className="section-title">Runtime — council-related sessions</div>
      <div className="omo-spec-table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>ID</th>
              <th>Agent</th>
              <th>Title</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {runtimeSessions.slice(0, 20).map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.id.slice(0, 14)}…</td>
                <td>{s.agent}</td>
                <td>{s.title}</td>
                <td>{s.status ?? "—"}</td>
              </tr>
            ))}
            {runtimeSessions.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted">
                  No council/councillor sessions currently visible. Member
                  identity not exposed by OpenCode.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
