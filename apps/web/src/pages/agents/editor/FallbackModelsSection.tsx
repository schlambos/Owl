import { useEffect, useRef, type RefObject } from "react";
import type { LiveProvider } from "@omo/shared";
import type { ModelAvailabilityContextValue } from "../../../models/ModelAvailabilityContext";
import type { ChainEntryState, ProbeCandidate } from "./types";
import { VARIANT_DATALIST_ID } from "./types";
import { entryRawId, splitModelId } from "./model-utils";
import { ChainProbeCell } from "./ChainProbeCell";

function FallbackRow(props: {
  entry: ChainEntryState;
  /** 1-based display index among fallbacks. */
  index: number;
  /** 0-based index in the full chain (primary is 0). */
  chainIndex: number;
  chainLength: number;
  providerGroups: {
    connected: LiveProvider[];
    disconnected: LiveProvider[];
  };
  models: LiveProvider["models"];
  currentMissing: boolean;
  providerMissing: boolean;
  avail: ModelAvailabilityContextValue | null;
  liveProviders: LiveProvider[];
  ocDisconnected: boolean;
  testing: boolean;
  onTest: (entry: ChainEntryState, cand: ProbeCandidate) => void;
  onUpdate: (key: number, patch: Partial<ChainEntryState>) => void;
  onMove: (index: number, dir: -1 | 1) => void;
  onRemove: (key: number) => void;
  autoFocus?: boolean;
}) {
  const { entry, index } = props;
  const firstControl = useRef<HTMLSelectElement | HTMLInputElement | null>(null);
  useEffect(() => {
    if (props.autoFocus) firstControl.current?.focus();
  }, [props.autoFocus]);

  return (
    <div className="chain-row ame-fallback-row" data-fallback-index={index}>
      <span className="muted chain-role-label">Fallback {index}</span>
      {entry.mode === "catalog" ? (
        <>
          <select
            ref={firstControl as RefObject<HTMLSelectElement>}
            value={entry.providerId}
            onChange={(e) =>
              props.onUpdate(entry.key, {
                providerId: e.target.value,
                modelId: "",
              })
            }
            aria-label={`Fallback ${index} provider`}
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
            onChange={(e) =>
              props.onUpdate(entry.key, { modelId: e.target.value })
            }
            aria-label={`Fallback ${index} model`}
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
            ref={firstControl as RefObject<HTMLInputElement>}
            className="mono"
            placeholder="provider/model"
            value={entry.manualId}
            onChange={(e) =>
              props.onUpdate(entry.key, { manualId: e.target.value })
            }
            aria-label={`Fallback ${index} manual model`}
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
        onChange={(e) =>
          props.onUpdate(entry.key, { variant: e.target.value })
        }
        aria-label={`Fallback ${index} entry variant`}
      />
      <button
        type="button"
        className="btn btn-xs"
        title="Move up"
        aria-label={`Move fallback ${index} up`}
        disabled={props.chainIndex <= 1}
        onClick={() => props.onMove(props.chainIndex, -1)}
      >
        ↑
      </button>
      <button
        type="button"
        className="btn btn-xs"
        title="Move down"
        aria-label={`Move fallback ${index} down`}
        disabled={props.chainIndex >= props.chainLength - 1}
        onClick={() => props.onMove(props.chainIndex, 1)}
      >
        ↓
      </button>
      <button
        type="button"
        className="btn btn-xs"
        title="Remove entry"
        aria-label={`Remove fallback ${index}`}
        onClick={() => props.onRemove(entry.key)}
      >
        ×
      </button>
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
            props.onUpdate(entry.key, {
              mode: "manual",
              manualId: entryRawId(entry) || entry.manualId,
            });
          } else {
            const parts = splitModelId(entry.manualId.trim());
            props.onUpdate(entry.key, {
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
  );
}

export function FallbackModelsSection(props: {
  fallbacks: ChainEntryState[];
  providerGroups: {
    connected: LiveProvider[];
    disconnected: LiveProvider[];
    any: boolean;
  };
  modelsFor: (entry: ChainEntryState) => {
    provider: LiveProvider | null;
    models: LiveProvider["models"];
    currentMissing: boolean;
  };
  avail: ModelAvailabilityContextValue | null;
  liveProviders: LiveProvider[];
  ocDisconnected: boolean;
  testingKeys: ReadonlySet<number>;
  onTest: (entry: ChainEntryState, cand: ProbeCandidate) => void;
  onUpdate: (key: number, patch: Partial<ChainEntryState>) => void;
  onMove: (index: number, dir: -1 | 1) => void;
  onRemove: (key: number) => void;
  onAdd: () => void;
  focusKey: number | null;
  chainProbeSummary: string | null;
}) {
  return (
    <section className="card ame-section ame-fallbacks" aria-labelledby="ame-fallback-heading">
      <div className="ame-section-head">
        <div>
          <h2 id="ame-fallback-heading">Fallback Models</h2>
          <p className="agents-quiet-note">
            Tried in order if the primary model cannot be used. Probe evidence
            does not predict OMO runtime fallback behavior.
          </p>
        </div>
        <button type="button" className="btn" onClick={props.onAdd}>
          Add fallback
        </button>
      </div>

      {props.fallbacks.length === 0 ? (
        <p className="ame-empty muted">
          No fallbacks. The agent uses only the primary model.
        </p>
      ) : (
        <ol className="ame-fallback-list">
          {props.fallbacks.map((entry, i) => {
            const { provider, models, currentMissing } = props.modelsFor(entry);
            return (
              <li key={entry.key}>
                <FallbackRow
                  entry={entry}
                  index={i + 1}
                  chainIndex={i + 1}
                  chainLength={props.fallbacks.length + 1}
                  providerGroups={props.providerGroups}
                  models={models}
                  currentMissing={currentMissing}
                  providerMissing={!!entry.providerId && !provider}
                  avail={props.avail}
                  liveProviders={props.liveProviders}
                  ocDisconnected={props.ocDisconnected}
                  testing={props.testingKeys.has(entry.key)}
                  onTest={props.onTest}
                  onUpdate={props.onUpdate}
                  onMove={props.onMove}
                  onRemove={props.onRemove}
                  autoFocus={props.focusKey === entry.key}
                />
              </li>
            );
          })}
        </ol>
      )}

      {props.chainProbeSummary ? (
        <p className="agents-chain-note">
          {props.chainProbeSummary} Probe evidence only — it does not predict
          OMO runtime fallback behavior.
        </p>
      ) : null}
    </section>
  );
}
