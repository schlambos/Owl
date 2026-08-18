import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentPromptDetail, PromptSourceState } from "@omo/shared";
import { PageHeader } from "../components/PageHeader";
import { Button } from "../components/ui/Button";
import { StatusBadge } from "../components/ui/StatusBadge";
import { cx } from "../components/ui/cx";
import "../styles/policy.css";

function sourceLabel(s: PromptSourceState): string {
  if (s.kind === "inline") return "Inline agents prompt";
  if (s.kind === "builtin") return "Built-in OMO prompt";
  return s.path ?? s.id;
}

type PromptView = "source" | "effective" | "diff";

export function PromptsPage() {
  const [agents, setAgents] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentPromptDetail | null>(null);
  const [editing, setEditing] = useState<PromptSourceState | "new" | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editScope, setEditScope] = useState<"user" | "project">("user");
  const [editFileType, setEditFileType] = useState<"replacement" | "append">(
    "append",
  );
  const [sim, setSim] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [view, setView] = useState<PromptView>("source");

  const loadList = useCallback(async () => {
    const r = await fetch("/api/prompts");
    const d = (await r.json()) as { agents: string[] };
    setAgents(d.agents);
    if (!selected && d.agents[0]) setSelected(d.agents[0]);
  }, [selected]);

  const loadDetail = useCallback(async (agent: string) => {
    const r = await fetch(`/api/prompts/${encodeURIComponent(agent)}`);
    setDetail((await r.json()) as AgentPromptDetail);
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (selected) void loadDetail(selected);
  }, [selected, loadDetail]);

  const list = useMemo(() => {
    const n = filter.trim().toLowerCase();
    return agents.filter((a) => !n || a.toLowerCase().includes(n));
  }, [agents, filter]);

  const beginEdit = (s: PromptSourceState | "new") => {
    setEditing(s);
    setSim(null);
    setView("source");
    if (s === "new") {
      setEditScope("user");
      setEditFileType("append");
      setEditContent("");
      return;
    }
    setEditScope((s.scope === "project" ? "project" : "user") as "user" | "project");
    setEditFileType(s.kind === "append" ? "append" : "replacement");
    void fetchFullText(s);
  };

  const fetchFullText = async (s: PromptSourceState) => {
    if (!s.path || !s.exists) {
      setEditContent("");
      return;
    }
    // reuse provenance prompt endpoint for text
    const r = await fetch(
      `/api/agents/${encodeURIComponent(selected!)}/prompts?text=1`,
    );
    const d = await r.json();
    const src = (d.sources ?? []).find(
      (x: { path?: string }) => x.path === s.path,
    );
    setEditContent(src?.content ?? "");
  };

  const preview = async () => {
    if (!selected) return;
    setError(null);
    const preset =
      editScope === "user" || editScope === "project"
        ? detail && (detail as { base?: { preset?: string } }).base?.preset
        : undefined;
    // use current preset for preset-specific creation toggle
    void preset;
    const mut = {
      kind: "prompt-file",
      scope: editScope,
      agent: selected,
      fileType: editFileType,
      operation: "set",
      content: editContent,
    };
    const r = await fetch("/api/config/prompt/simulate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mut),
    });
    const d = await r.json();
    setSim(d);
    if (!d.ok) setError((d.errors || []).join("; "));
    else setView("diff");
  };

  const apply = async () => {
    if (!selected || !sim || !(sim as { ok?: boolean }).ok) return;
    const mut = {
      kind: "prompt-file",
      scope: editScope,
      agent: selected,
      fileType: editFileType,
      operation: "set",
      content: editContent,
      expectedSourceHash:
        editing && editing !== "new" ? editing.hash : undefined,
    };
    const r = await fetch("/api/config/prompt/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mut),
    });
    const d = await r.json();
    if (!d.ok) {
      setError((d.errors || []).join("; "));
      return;
    }
    setEditing(null);
    setSim(null);
    await loadDetail(selected);
  };

  const deleteFile = async (s: PromptSourceState) => {
    if (!selected || !s.path) return;
    const mut = {
      kind: "prompt-file",
      scope: s.scope ?? "user",
      preset: s.preset,
      agent: selected,
      fileType: s.kind === "append" ? "append" : "replacement",
      operation: "delete",
      expectedSourceHash: s.hash,
    };
    const r = await fetch("/api/config/prompt/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mut),
    });
    const d = await r.json();
    if (!d.ok) {
      setError((d.errors || []).join("; "));
      return;
    }
    await loadDetail(selected);
  };

  const simOk = Boolean(sim && (sim as { ok?: boolean }).ok);
  const simDiff = String((sim as { textDiff?: string } | null)?.textDiff ?? "");

  return (
    <div className="omo-policy">
      <PageHeader
        title="Prompts"
        meta={
          detail
            ? `${detail.effectiveChars ?? 0} chars · ${detail.effectiveLines ?? 0} lines`
            : undefined
        }
      />
      {error ? <div className="error">{error}</div> : null}

      <div className="omo-policy-frame">
        <aside className="omo-policy-side">
          <label className="omo-sr-only" htmlFor="prompt-agent-filter">
            Filter agents
          </label>
          <input
            id="prompt-agent-filter"
            className="omo-policy-search"
            type="search"
            autoComplete="off"
            spellCheck={false}
            placeholder="Filter agents…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="omo-policy-list">
            {list.map((a) => (
              <button
                key={a}
                type="button"
                className="omo-policy-row"
                aria-current={selected === a ? "true" : undefined}
                onClick={() => {
                  setSelected(a);
                  setEditing(null);
                  setSim(null);
                  setView("source");
                }}
              >
                <span className="omo-policy-row-title">{a}</span>
              </button>
            ))}
          </div>
        </aside>

        <section className="omo-policy-pane">
          {!detail ? (
            <p className="omo-policy-empty">Select an agent.</p>
          ) : (
            <>
              <div className="omo-policy-head">
                <div className="omo-policy-head-text">
                  <h2 className="omo-policy-title">{detail.agent}</h2>
                  <p className="omo-policy-quiet">{detail.compositionRule}</p>
                </div>
                <div
                  className="omo-policy-tabs"
                  role="tablist"
                  aria-label="Prompt view"
                >
                  {(
                    [
                      { id: "source", label: "Source" },
                      { id: "effective", label: "Effective" },
                      { id: "diff", label: "Diff" },
                    ] as const
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      className="omo-policy-tab"
                      aria-selected={view === tab.id}
                      disabled={tab.id === "diff" && !sim}
                      onClick={() => setView(tab.id)}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>

              {view === "source" ? (
                <>
                  <div className="omo-policy-inset">
                    <h2>Effective base</h2>
                    <p>
                      <StatusBadge tone="ok">{detail.base?.kind}</StatusBadge>{" "}
                      {sourceLabel(
                        detail.base ?? {
                          id: "none",
                          kind: "builtin",
                          agent: detail.agent,
                          exists: false,
                          active: false,
                        },
                      )}
                    </p>
                    <h2>Active append</h2>
                    <p>
                      {detail.append ? (
                        <>
                          <StatusBadge tone="ok">append</StatusBadge>{" "}
                          {sourceLabel(detail.append)}
                        </>
                      ) : (
                        <span className="muted">none</span>
                      )}
                    </p>
                  </div>

                  <div className="omo-policy-section">
                    <h3 className="omo-policy-kicker">Sources</h3>
                    <div className="omo-policy-table-wrap omo-policy-table-wrap-inset">
                      <table className="data omo-policy-table">
                        <thead>
                          <tr>
                            <th>Kind</th>
                            <th>Scope</th>
                            <th>Status</th>
                            <th>Path</th>
                            <th>Size</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.sources.map((s) => (
                            <tr key={s.id}>
                              <td>{s.kind}</td>
                              <td>
                                {s.scope}
                                {s.preset ? ` / ${s.preset}` : ""}
                              </td>
                              <td>
                                {s.active ? (
                                  <StatusBadge tone="ok">active</StatusBadge>
                                ) : s.exists ? (
                                  <StatusBadge tone="warn">shadowed</StatusBadge>
                                ) : (
                                  <StatusBadge>missing</StatusBadge>
                                )}
                                {s.reason ? (
                                  <div className="omo-policy-reason">{s.reason}</div>
                                ) : null}
                              </td>
                              <td className="omo-mono">{s.path ?? "—"}</td>
                              <td className="omo-mono">
                                {s.chars != null ? `${s.chars}c` : "—"}
                              </td>
                              <td>
                                {s.kind === "replacement" || s.kind === "append" ? (
                                  <div className="omo-policy-inline-actions">
                                    <Button size="sm" onClick={() => beginEdit(s)}>
                                      Edit
                                    </Button>
                                    {s.exists ? (
                                      <Button
                                        size="sm"
                                        onClick={() => void deleteFile(s)}
                                      >
                                        Delete
                                      </Button>
                                    ) : null}
                                  </div>
                                ) : null}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="omo-policy-toolbar">
                    <Button onClick={() => beginEdit("new")}>
                      Create prompt file
                    </Button>
                  </div>
                </>
              ) : null}

              {view === "effective" ? (
                detail.effectiveText ? (
                  <div className="omo-policy-section">
                    <h3 className="omo-policy-kicker">Final effective text</h3>
                    <pre className="omo-policy-pre">{detail.effectiveText}</pre>
                  </div>
                ) : (
                  <p className="omo-policy-quiet">No effective text available.</p>
                )
              ) : null}

              {view === "diff" ? (
                sim ? (
                  <div className="omo-policy-section">
                    <h3 className="omo-policy-kicker">Preview diff</h3>
                    <pre className="omo-policy-pre">{simDiff}</pre>
                  </div>
                ) : (
                  <p className="omo-policy-quiet">
                    Preview a prompt edit to see the diff.
                  </p>
                )
              ) : null}

              {detail.warnings.map((w, i) => (
                <div key={i} className="warn-block">
                  {w}
                </div>
              ))}
            </>
          )}

          {editing !== null ? (
            <div className="omo-policy-inset">
              <h2>
                {editing === "new" ? "Create" : "Edit"} prompt file
              </h2>
              <div className="omo-policy-toolbar">
                <label className="omo-policy-choice">
                  Scope
                  <select
                    className="omo-policy-select"
                    value={editScope}
                    onChange={(e) =>
                      setEditScope(e.target.value as "user" | "project")
                    }
                  >
                    <option value="user">user</option>
                    <option value="project">project</option>
                  </select>
                </label>
                <label className="omo-policy-choice">
                  Type
                  <select
                    className="omo-policy-select"
                    value={editFileType}
                    onChange={(e) =>
                      setEditFileType(e.target.value as "replacement" | "append")
                    }
                  >
                    <option value="replacement">replacement</option>
                    <option value="append">append</option>
                  </select>
                </label>
              </div>
              <textarea
                className={cx("omo-policy-textarea", "omo-policy-editor", "omo-mono")}
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                placeholder="# prompt content"
              />
              <div className="omo-policy-toolbar">
                <Button onClick={() => void preview()}>Preview</Button>
                <Button
                  variant="primary"
                  disabled={!simOk}
                  onClick={() => void apply()}
                >
                  Apply
                </Button>
              </div>
              {sim ? (
                <pre className="omo-policy-pre">{simDiff}</pre>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
