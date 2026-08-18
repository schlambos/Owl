import type { LiveProvider } from "@omo/shared";
import type { ModelAvailabilityContextValue } from "../../../models/ModelAvailabilityContext";
import type { ChainEntryState, ProbeCandidate } from "./types";
import { VARIANT_DATALIST_ID } from "./types";
import { entryRawId, splitModelId } from "./model-utils";
import { ChainProbeCell } from "./ChainProbeCell";
import { ModelBrowser } from "./ModelBrowser";

export function PrimaryModelSection(props: {
  entry: ChainEntryState;
  providerGroups: {
    connected: LiveProvider[];
    disconnected: LiveProvider[];
    any: boolean;
  };
  allProviders: readonly LiveProvider[];
  catalogFilter: string;
  onCatalogFilter: (value: string) => void;
  models: LiveProvider["models"];
  currentMissing: boolean;
  providerMissing: boolean;
  avail: ModelAvailabilityContextValue | null;
  liveProviders: LiveProvider[];
  ocDisconnected: boolean;
  testing: boolean;
  onTest: (entry: ChainEntryState, cand: ProbeCandidate) => void;
  onUpdate: (patch: Partial<ChainEntryState>) => void;
  agentVariant: string;
  editVariantToo: boolean;
  onEditVariantToo: (next: boolean) => void;
  onAgentVariant: (next: string) => void;
  agentName: string;
  catalogLoading: boolean;
  filterEmpty: boolean;
}) {
  const { entry } = props;
  const selected = entryRawId(entry);

  return (
    <section className="card ame-section ame-primary" aria-labelledby="ame-primary-heading">
      <div className="ame-section-head">
        <div>
          <h2 id="ame-primary-heading">Primary Model</h2>
          <p className="agents-quiet-note">
            The model this agent should use. Fallback models are configured
            separately below.
          </p>
        </div>
      </div>

      <div className="chain-row ame-primary-row">
        <span className="muted chain-role-label">Primary</span>
        {entry.mode === "catalog" ? (
          <>
            <select
              value={entry.providerId}
              onChange={(e) =>
                props.onUpdate({
                  providerId: e.target.value,
                  modelId: "",
                })
              }
            >
              <option value="">Provider…</option>
              {entry.providerId && props.providerMissing ? (
                <option value={entry.providerId}>
                  {entry.providerId} (current — not in catalog)
                </option>
              ) : null}
              <optgroup label="Connected">
                {props.providerGroups.connected.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.id}) — {p.modelCount} models
                  </option>
                ))}
              </optgroup>
              <optgroup label="Disconnected / configured">
                {props.providerGroups.disconnected.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.id}) — {p.modelCount} models
                  </option>
                ))}
              </optgroup>
            </select>
            <select
              value={entry.modelId}
              disabled={!entry.providerId}
              onChange={(e) => props.onUpdate({ modelId: e.target.value })}
            >
              <option value="">
                {entry.providerId ? "Model…" : "pick provider first"}
              </option>
              {props.currentMissing ? (
                <option value={entry.modelId}>
                  {entry.modelId} (current — not currently advertised)
                </option>
              ) : null}
              {props.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                  {m.name && m.name !== m.id ? ` — ${m.name}` : ""}
                </option>
              ))}
            </select>
          </>
        ) : (
          <>
            <input
              className="mono"
              placeholder="provider/model"
              value={entry.manualId}
              onChange={(e) => props.onUpdate({ manualId: e.target.value })}
            />
            <span className="pill warn">not in live catalog</span>
          </>
        )}
        <ChainProbeCell
          entry={entry}
          avail={props.avail}
          liveProviders={props.liveProviders}
          ocDisconnected={props.ocDisconnected}
          busy={props.testing}
          onTest={props.onTest}
        />
        <input
          className="chain-variant-input"
          placeholder="Entry variant"
          title="Entry variant"
          list={VARIANT_DATALIST_ID}
          value={entry.variant}
          onChange={(e) => props.onUpdate({ variant: e.target.value })}
          aria-label="Primary entry variant"
        />
      </div>

      {entry.mode === "catalog" ? (
        <ModelBrowser
          entry={entry}
          providers={props.allProviders}
          catalogFilter={props.catalogFilter}
          onCatalogFilter={props.onCatalogFilter}
          avail={props.avail}
          currentMissing={props.currentMissing}
          providerMissing={props.providerMissing}
          models={props.models}
          onProvider={(providerId) =>
            props.onUpdate({ providerId, modelId: "" })
          }
          onModel={(modelId) => props.onUpdate({ modelId })}
        />
      ) : null}

      <div className="ame-selected-row">
        <div className="ame-selected-copy">
          <span className="ame-selected-kicker">Selected primary</span>
          <strong className="ame-selected-id mono">
            {selected || "No primary model selected"}
          </strong>
        </div>
      </div>

      <div className="ame-agent-variant">
        <h3 className="ame-subhead">Agent-level variant</h3>
        <p className="ame-quiet-note">
          Applies to the agent itself, not to an individual fallback entry.
          Stored as <span className="mono">agents.{props.agentName}.variant</span>.
        </p>
        <label className="muted">
          <input
            type="checkbox"
            checked={props.editVariantToo}
            onChange={(e) => props.onEditVariantToo(e.target.checked)}
          />{" "}
          Also change the agent-level variant (separate field from entry
          variants)
        </label>
        {props.editVariantToo ? (
          <input
            className="agents-variant-input"
            value={props.agentVariant}
            list={VARIANT_DATALIST_ID}
            onChange={(e) => props.onAgentVariant(e.target.value)}
            placeholder="leave blank to remove"
          />
        ) : (
          <p className="ame-variant-readout">
            Current agent variant:{" "}
            <span className="mono">
              {props.agentVariant.trim() || "none"}
            </span>
          </p>
        )}
      </div>

      <div className="ame-advanced">
        <h3 className="ame-subhead">Advanced</h3>
        <p className="ame-quiet-note">
          Manual provider/model entry for models that are not advertised in
          the live catalog.
        </p>
        <button
          type="button"
          className="linkish"
          title={
            entry.mode === "catalog"
              ? "Advanced: enter provider/model manually"
              : "Pick from the live catalog"
          }
          onClick={() => {
            if (entry.mode === "catalog") {
              props.onUpdate({
                mode: "manual",
                manualId: entryRawId(entry) || entry.manualId,
              });
            } else {
              const parts = splitModelId(entry.manualId.trim());
              props.onUpdate({
                mode: "catalog",
                providerId: parts.providerId,
                modelId: parts.modelId,
              });
            }
          }}
        >
          {entry.mode === "catalog" ? "manual" : "catalog"}
        </button>
      </div>

      {props.catalogLoading ? (
        <span className="muted"> Loading live catalog…</span>
      ) : null}
      {props.filterEmpty ? (
        <div className="muted">No providers match “{props.catalogFilter}”.</div>
      ) : null}
    </section>
  );
}
