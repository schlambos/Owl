import { useCallback, useEffect, useMemo, useState } from "react";
import type { CapabilityInventory } from "@omo/shared";
import { PageHeader } from "../components/PageHeader";
import { Button } from "../components/ui/Button";
import { Surface } from "../components/ui/Surface";
import { cx } from "../components/ui/cx";
import "../styles/policy.css";

const TOOL_COLS = [
  "read",
  "edit",
  "bash",
  "task",
  "glob",
  "grep",
  "webfetch",
  "skill",
] as const;

function cell(v: string | undefined): { mark: string; cls: string } {
  if (v === "allow") return { mark: "Allow", cls: "is-ok" };
  if (v === "deny") return { mark: "Deny", cls: "is-bad" };
  if (v === "ask" || v === "patterned") return { mark: "Ask", cls: "is-warn" };
  return { mark: "Unset", cls: "is-unset" };
}

function skillMark(
  allowed: boolean,
  modeAll: boolean,
): { mark: string; cls: string } {
  if (allowed || modeAll) return { mark: "Allow", cls: "is-ok" };
  return { mark: "Deny", cls: "is-bad" };
}

export function CapabilitiesPage() {
  const [data, setData] = useState<CapabilityInventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<{
    agent: string;
    key: string;
    kind: "tool" | "skill" | "mcp";
  } | null>(null);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/capabilities");
      if (!r.ok) throw new Error(`capabilities → ${r.status}`);
      setData((await r.json()) as CapabilityInventory);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const agents = useMemo(() => {
    if (!data) return [];
    const n = filter.trim().toLowerCase();
    return data.agents.filter(
      (a) => !n || a.agent.toLowerCase().includes(n),
    );
  }, [data, filter]);

  const detail = useMemo(() => {
    if (!selected || !data) return null;
    const a = data.agents.find((x) => x.agent === selected.agent);
    if (!a) return null;
    if (selected.kind === "tool") {
      return {
        title: `${a.agent} → ${selected.key}`,
        lines: [
          `Effective: ${a.tools[selected.key] ?? "unset"}`,
          `Permission summary: ${a.permissionSummary}`,
          `Configured: ${JSON.stringify(a.permission ?? null, null, 2)}`,
        ],
      };
    }
    if (selected.kind === "skill") {
      const allowed = a.skills.allowed.includes(selected.key);
      const gdis = a.skills.globallyDisabled.includes(selected.key);
      return {
        title: `${a.agent} → skill ${selected.key}`,
        lines: [
          `Agent access: ${allowed ? "allowed" : "not allowed"}`,
          `Mode: ${a.skills.mode}`,
          `Configured: ${JSON.stringify(a.skills.configured ?? "(unset)")}`,
          gdis ? "Denied globally via disabled_skills" : "Not globally disabled",
          `Unknown configured: ${a.skills.configuredUnknown.join(", ") || "none"}`,
        ],
      };
    }
    const allowed = a.mcps.allowed.includes(selected.key);
    const rt = data.mcps.find((m) => m.name === selected.key);
    return {
      title: `${a.agent} → MCP ${selected.key}`,
      lines: [
        `Agent access: ${allowed ? "allowed" : "not allowed"}`,
        `Mode: ${a.mcps.mode}`,
        `Configured: ${JSON.stringify(a.mcps.configured ?? "(unset)")}`,
        `Runtime: ${rt?.runtimeStatus ?? "unknown"}`,
        rt?.globallyDisabled
          ? "Denied globally via disabled_mcps"
          : "Not globally disabled",
      ],
    };
  }, [selected, data]);

  return (
    <div className="omo-policy">
      <PageHeader
        title="Capabilities"
        meta={
          data
            ? `${data.agents.length} agents · ${data.skills.length} skills · ${data.mcps.length} mcps`
            : undefined
        }
        onRefresh={() => void load()}
        loading={loading}
      />
      {error ? <div className="error">{error}</div> : null}

      <div className="omo-policy-legend">
        <span className="omo-policy-legend-item">
          <span className="omo-policy-state is-ok">Allow</span>
          allow
        </span>
        <span className="omo-policy-legend-item">
          <span className="omo-policy-state is-warn">Ask</span>
          ask / patterned
        </span>
        <span className="omo-policy-legend-item">
          <span className="omo-policy-state is-bad">Deny</span>
          deny
        </span>
        <span className="omo-policy-legend-item">
          <span className="omo-policy-state is-faint">Unset</span>
          unset
        </span>
        <span>Click a cell for explanation</span>
      </div>

      {data ? (
        <Surface className="omo-policy-surface" padding="md">
          <h2 className="omo-policy-kicker">Global availability (read-only)</h2>
          <dl className="omo-policy-kv">
            <dt>disabled_skills</dt>
            <dd className="omo-mono">
              {data.globals.disabled_skills.join(", ") || "—"}
            </dd>
            <dt>disabled_mcps</dt>
            <dd className="omo-mono">
              {data.globals.disabled_mcps.join(", ") || "—"}
            </dd>
            <dt>disabled_tools</dt>
            <dd className="omo-mono">
              {data.globals.disabled_tools.join(", ") || "—"}
            </dd>
            <dt>disabled_agents</dt>
            <dd className="omo-mono">
              {data.globals.disabled_agents.join(", ") || "—"}
            </dd>
          </dl>
        </Surface>
      ) : null}

      <div className="omo-policy-toolbar">
        <label className="omo-sr-only" htmlFor="capability-agent-filter">
          Filter agents
        </label>
        <input
          id="capability-agent-filter"
          className="omo-policy-search"
          type="search"
          autoComplete="off"
          spellCheck={false}
          placeholder="Filter agents…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <Surface className="omo-policy-surface" padding="sm">
        <div className="omo-policy-stack">
          <div className="omo-policy-section">
            <h3 className="omo-policy-kicker">Tool matrix</h3>
            <div className="omo-policy-table-wrap omo-policy-table-wrap-inset omo-policy-matrix-wrap">
              <table className="data omo-policy-table omo-policy-matrix">
                <thead>
                  <tr>
                    <th>Agent</th>
                    {TOOL_COLS.map((t) => (
                      <th key={t}>{t}</th>
                    ))}
                    <th>temp</th>
                    <th>skills</th>
                    <th>mcps</th>
                  </tr>
                </thead>
                <tbody>
                  {agents.map((a) => (
                    <tr key={a.agent}>
                      <td>
                        <strong>{a.agent}</strong>
                      </td>
                      {TOOL_COLS.map((t) => {
                        const c = cell(a.tools[t]);
                        const isSelected =
                          selected?.agent === a.agent &&
                          selected.key === t &&
                          selected.kind === "tool";
                        return (
                          <td key={t}>
                            <button
                              type="button"
                              className={cx(
                                "omo-policy-cell",
                                c.cls,
                                isSelected && "is-selected",
                              )}
                              aria-pressed={isSelected}
                              onClick={() =>
                                setSelected({
                                  agent: a.agent,
                                  key: t,
                                  kind: "tool",
                                })
                              }
                            >
                              {c.mark}
                            </button>
                          </td>
                        );
                      })}
                      <td className="omo-mono">{a.temperature ?? "—"}</td>
                      <td className="omo-mono">
                        {a.skills.mode}
                        {a.skills.mode === "selective"
                          ? ` (${a.skills.allowed.length})`
                          : ""}
                      </td>
                      <td className="omo-mono">
                        {a.mcps.mode}
                        {a.mcps.allowed.length
                          ? ` ${a.mcps.allowed.slice(0, 3).join(",")}`
                          : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="omo-policy-section">
            <h3 className="omo-policy-kicker">Skills × agents (sample)</h3>
            <div className="omo-policy-table-wrap omo-policy-table-wrap-inset omo-policy-matrix-wrap">
              <table className="data omo-policy-table omo-policy-matrix">
                <thead>
                  <tr>
                    <th>Skill</th>
                    <th>Installed</th>
                    <th>Global</th>
                    {agents.slice(0, 8).map((a) => (
                      <th key={a.agent}>{a.agent.slice(0, 6)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(data?.skills ?? []).slice(0, 24).map((s) => (
                    <tr key={s.name}>
                      <td className="omo-mono">{s.name}</td>
                      <td>
                        <span
                          className={cx(
                            "omo-policy-state",
                            s.installed ? "is-ok" : "is-faint",
                          )}
                        >
                          {s.installed ? "installed" : "unknown"}
                        </span>
                      </td>
                      <td>
                        <span
                          className={cx(
                            "omo-policy-state",
                            s.globallyDisabled ? "is-bad" : "is-ok",
                          )}
                        >
                          {s.globallyDisabled ? "off" : "on"}
                        </span>
                      </td>
                      {agents.slice(0, 8).map((a) => {
                        const ok = a.skills.allowed.includes(s.name);
                        const modeAll =
                          a.skills.mode === "all" &&
                          !a.skills.denied.includes(s.name) &&
                          !s.globallyDisabled;
                        const c = skillMark(ok, modeAll);
                        const isSelected =
                          selected?.agent === a.agent &&
                          selected.key === s.name &&
                          selected.kind === "skill";
                        return (
                          <td key={a.agent}>
                            <button
                              type="button"
                              className={cx(
                                "omo-policy-cell",
                                c.cls,
                                isSelected && "is-selected",
                              )}
                              aria-pressed={isSelected}
                              onClick={() =>
                                setSelected({
                                  agent: a.agent,
                                  key: s.name,
                                  kind: "skill",
                                })
                              }
                            >
                              {c.mark}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="omo-policy-section">
            <h3 className="omo-policy-kicker">MCPs</h3>
            <div className="omo-policy-table-wrap omo-policy-table-wrap-inset omo-policy-matrix-wrap">
              <table className="data omo-policy-table omo-policy-matrix">
                <thead>
                  <tr>
                    <th>MCP</th>
                    <th>Runtime</th>
                    <th>Global</th>
                    {agents.slice(0, 8).map((a) => (
                      <th key={a.agent}>{a.agent.slice(0, 6)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(data?.mcps ?? []).map((m) => (
                    <tr key={m.name}>
                      <td className="omo-mono">{m.name}</td>
                      <td>
                        <span
                          className={cx(
                            "omo-policy-state",
                            m.runtimeStatus === "connected" ? "is-ok" : "is-warn",
                          )}
                        >
                          {m.runtimeStatus ?? "—"}
                        </span>
                      </td>
                      <td>
                        <span
                          className={cx(
                            "omo-policy-state",
                            m.globallyDisabled ? "is-bad" : "is-ok",
                          )}
                        >
                          {m.globallyDisabled ? "off" : "on"}
                        </span>
                      </td>
                      {agents.slice(0, 8).map((a) => {
                        const ok = a.mcps.allowed.includes(m.name);
                        const isSelected =
                          selected?.agent === a.agent &&
                          selected.key === m.name &&
                          selected.kind === "mcp";
                        return (
                          <td key={a.agent}>
                            <button
                              type="button"
                              className={cx(
                                "omo-policy-cell",
                                ok ? "is-ok" : "is-bad",
                                isSelected && "is-selected",
                              )}
                              aria-pressed={isSelected}
                              onClick={() =>
                                setSelected({
                                  agent: a.agent,
                                  key: m.name,
                                  kind: "mcp",
                                })
                              }
                            >
                              {ok ? "Allow" : "Deny"}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </Surface>

      {detail ? (
        <Surface className="omo-policy-surface" padding="md">
          <div className="omo-policy-head">
            <h2 className="omo-policy-title">{detail.title}</h2>
            <Button size="sm" onClick={() => setSelected(null)}>
              Close
            </Button>
          </div>
          {detail.lines.map((l, i) => (
            <pre key={i} className="omo-policy-pre omo-policy-pre-dim">
              {l}
            </pre>
          ))}
        </Surface>
      ) : null}
    </div>
  );
}
