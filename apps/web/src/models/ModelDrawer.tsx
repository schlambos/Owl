import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type {
  ModelAvailabilityDetail,
  ModelUsageReference,
} from "@omo/shared";
import { api } from "../api";
import { teamFocusPath } from "../pages/team/session-state";
import { FocusTrapDialog } from "../components/FocusTrapDialog";
import { Button } from "../components/ui/Button";
import { StatusBadge } from "../components/ui/StatusBadge";
import { ProbeBadge, probeStateLabel } from "./ProbeBadge";
import { useModelAvailability } from "./ModelAvailabilityContext";
import {
  ago,
  capabilityCell,
  MODEL_DRAWER_TITLE_ID,
  modelDisplayName,
} from "./presentation";

export function ModelDrawer(props: {
  providerId: string;
  modelId: string;
  displayName?: string;
  /** Bumps on each model-probes.updated SSE event → refetch history. */
  generation: number;
  disabledReason?: string;
  busy: boolean;
  onProbe: () => void;
  onClose: () => void;
  returnFocus?: () => HTMLElement | null;
  /**
   * Active eligible OMO agent names (doc 34). When provided, eligible agent
   * usage refs link to the focused Agents view; ineligible owners (native,
   * ACP wrappers, disabled) render as plain text — only eligible agents are
   * Agents focus targets. Council/ACP refs always link to their workspaces.
   */
  eligibleAgents?: ReadonlySet<string>;
}) {
  const { providerId, modelId, generation, disabledReason } = props;
  const { getModel } = useModelAvailability();
  const [detail, setDetail] = useState<ModelAvailabilityDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    setDetail(null);
    setDetailError(null);
    api
      .modelDetail(providerId, modelId)
      .then((d) => {
        if (!dead) setDetail(d);
      })
      .catch((e) => {
        if (!dead) setDetailError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      dead = true;
    };
  }, [providerId, modelId, generation]);

  const model = getModel(providerId, modelId) ?? detail?.availability ?? null;
  const title = modelDisplayName(modelId, props.displayName);

  const history = useMemo(() => {
    const runs = [...(detail?.history ?? [])];
    runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return runs;
  }, [detail]);

  const usageGroups = useMemo(() => {
    if (!model) return null;
    const agents = new Map<
      string,
      { primary: boolean; fallbacks: ModelUsageReference[] }
    >();
    const council: ModelUsageReference[] = [];
    const acp: ModelUsageReference[] = [];
    for (const u of model.usage) {
      if (u.kind === "agent-primary" || u.kind === "agent-fallback") {
        const g = agents.get(u.ownerId) ?? { primary: false, fallbacks: [] };
        if (u.kind === "agent-primary") g.primary = true;
        else g.fallbacks.push(u);
        agents.set(u.ownerId, g);
      } else if (u.kind === "council-member") council.push(u);
      else acp.push(u);
    }
    return { agents, council, acp };
  }, [model]);

  const cap = model?.capabilities;
  const capSource =
    cap?.source && cap.source !== "none" ? "OpenCode catalog" : "Unknown";

  return (
    <FocusTrapDialog
      variant="sheet"
      labelledBy={MODEL_DRAWER_TITLE_ID}
      onClose={props.onClose}
      returnFocus={props.returnFocus}
      className="drawer omo-models-drawer"
    >
      <div id="model-detail-drawer">
        <div className="omo-models-drawer-head">
          <div>
            <h2
              className="omo-models-drawer-title"
              id={MODEL_DRAWER_TITLE_ID}
              tabIndex={-1}
              aria-label={`Model detail ${providerId}/${modelId}`}
            >
              {title}
            </h2>
            <div className="omo-models-drawer-id">
              {title !== modelId ? `${providerId}/${modelId}` : providerId}
            </div>
          </div>
          <Button size="sm" onClick={props.onClose}>
            Close
          </Button>
        </div>

        {detailError ? <div className="error">{detailError}</div> : null}
        {!model && !detailError ? (
          <p className="omo-quiet">Loading model detail…</p>
        ) : null}

        {model ? (
          <>
            <div className="omo-models-drawer-badges">
              <StatusBadge tone={model.provider.connected ? "ok" : "bad"}>
                provider{" "}
                {model.provider.connected ? "connected" : "not connected"}
              </StatusBadge>
              {model.advertised ? (
                <span className="omo-badge">advertised</span>
              ) : (
                <span className="omo-badge">manual</span>
              )}
            </div>

            <section className="omo-models-section">
              <h3 className="omo-models-section-title">Probe</h3>
              <ProbeBadge probe={model.probe} />
              <dl className="omo-models-kv">
                <dt>state</dt>
                <dd>{probeStateLabel(model.probe.state)}</dd>
                <dt>latency</dt>
                <dd>
                  {model.probe.latencyMs != null
                    ? `${model.probe.latencyMs}ms`
                    : "—"}
                </dd>
                <dt>status / code</dt>
                <dd>
                  {model.probe.statusCode != null
                    ? String(model.probe.statusCode)
                    : (model.probe.errorCode ?? "—")}
                </dd>
                {model.probe.errorMessage ? (
                  <>
                    <dt>message</dt>
                    <dd>{model.probe.errorMessage}</dd>
                  </>
                ) : null}
                <dt>completed</dt>
                <dd>
                  {model.probe.lastCompletedAt
                    ? ago(model.probe.lastCompletedAt)
                    : "—"}
                </dd>
              </dl>
            </section>

            <section className="omo-models-section">
              <h3 className="omo-models-section-title">
                Recent probe history
                {history.length > 0
                  ? ` (${Math.min(5, history.length)} of ${history.length})`
                  : ""}
              </h3>
              {history.length === 0 ? (
                <p className="omo-quiet">No probe runs recorded.</p>
              ) : (
                <div className="omo-models-table-wrap">
                  <table className="omo-models-table">
                    <thead>
                      <tr>
                        <th>State</th>
                        <th>Latency</th>
                        <th>Status</th>
                        <th>When</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.slice(0, 5).map((h) => (
                        <tr key={h.id}>
                          <td>{probeStateLabel(h.state)}</td>
                          <td className="omo-mono">
                            {h.latencyMs != null ? `${h.latencyMs}ms` : "—"}
                          </td>
                          <td className="omo-mono">
                            {h.statusCode != null
                              ? String(h.statusCode)
                              : (h.errorCode ?? "—")}
                          </td>
                          <td className="omo-mono">{ago(h.startedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="omo-models-section">
              <h3 className="omo-models-section-title">Configured use</h3>
              {!usageGroups || model.usage.length === 0 ? (
                <p className="omo-quiet">
                  Not referenced by any agent, council preset, or ACP wrapper.
                </p>
              ) : (
                <dl className="omo-models-kv">
                  {usageGroups.agents.size > 0 ? (
                    <>
                      <dt>Agents</dt>
                      <dd>
                        {[...usageGroups.agents.entries()].map(
                          ([owner, g], i) => (
                            <div key={i}>
                              {props.eligibleAgents?.has(owner) ? (
                                <Link
                                  className="omo-drawer-ref"
                                  to={teamFocusPath("/agents", {
                                    model: `${providerId}/${modelId}`,
                                    agent: owner,
                                  })}
                                >
                                  {owner}
                                </Link>
                              ) : (
                                owner
                              )}
                              {g.primary ? " — primary" : ""}
                              {g.fallbacks.map((f, fi) => (
                                <span key={fi}>
                                  {" "}
                                  — fallback #{fi + 1}
                                  {!f.active ? " (inactive)" : ""}
                                </span>
                              ))}
                            </div>
                          ),
                        )}
                      </dd>
                    </>
                  ) : null}
                  {usageGroups.council.length > 0 ? (
                    <>
                      <dt>Council</dt>
                      <dd>
                        {usageGroups.council.map((u, i) => (
                          <div key={i}>
                            <Link className="omo-drawer-ref" to="/council">
                              {u.label || u.ownerId}
                            </Link>{" "}
                            <span
                              className={`omo-badge ${u.active ? "omo-badge-ok" : ""}`}
                            >
                              {u.active ? "active" : "inactive"}
                            </span>
                          </div>
                        ))}
                      </dd>
                    </>
                  ) : null}
                  {usageGroups.acp.length > 0 ? (
                    <>
                      <dt>ACP wrappers</dt>
                      <dd>
                        {usageGroups.acp.map((u, i) => (
                          <div key={i}>
                            <Link className="omo-drawer-ref" to="/acp">
                              {u.label || u.ownerId}
                            </Link>{" "}
                            <span
                              className={`omo-badge ${u.active ? "omo-badge-ok" : ""}`}
                            >
                              {u.active ? "active" : "inactive"}
                            </span>
                          </div>
                        ))}
                      </dd>
                    </>
                  ) : null}
                </dl>
              )}
            </section>

            <section className="omo-models-section">
              <h3 className="omo-models-section-title">
                Capabilities ({capSource})
              </h3>
              <dl className="omo-models-kv">
                <dt>Tools</dt>
                <dd>{capabilityCell(cap?.tools)}</dd>
                <dt>Vision</dt>
                <dd>{capabilityCell(cap?.vision)}</dd>
                <dt>Reasoning</dt>
                <dd>{capabilityCell(cap?.reasoning)}</dd>
                {model.limit?.context != null ? (
                  <>
                    <dt>Context limit</dt>
                    <dd>{model.limit.context.toLocaleString()} tokens</dd>
                  </>
                ) : null}
                {model.limit?.output != null ? (
                  <>
                    <dt>Output limit</dt>
                    <dd>{model.limit.output.toLocaleString()} tokens</dd>
                  </>
                ) : null}
              </dl>
            </section>

            <div className="omo-models-drawer-actions">
              <Button
                disabled={Boolean(disabledReason) || props.busy}
                title={disabledReason ?? "Probe this model through OpenCode"}
                onClick={props.onProbe}
              >
                {props.busy ? "Queuing…" : "Probe Model"}
              </Button>
              {disabledReason ? (
                <span className="omo-models-disabled-reason">
                  {disabledReason}
                </span>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </FocusTrapDialog>
  );
}
