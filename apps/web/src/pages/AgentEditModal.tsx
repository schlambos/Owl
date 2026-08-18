import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentRow,
  ApplyResult,
  ConfigMutation,
  ConfigRevision,
  ConfigWriteScope,
  ModelChainEntry,
  ResolvedProperty,
  SchemaValidationSummary,
  SimulationResult,
} from "@omo/shared";
import { notifyOmoSchemaStatusRefresh } from "../hooks/useOmoSchemaStatus";
import { api } from "../api";
import { FocusTrapDialog } from "../components/FocusTrapDialog";
import { Button } from "../components/ui/Button";
import {
  useModelAvailabilityOptional,
} from "../models/ModelAvailabilityContext";
import { probeAgo, probeStateLabel } from "../models/ProbeBadge";
import { useRuntime } from "../runtime/RuntimeContext";
import { AssignmentLocation } from "./agents/editor/AssignmentLocation";
import { CurrentAssignment } from "./agents/editor/CurrentAssignment";
import { FallbackModelsSection } from "./agents/editor/FallbackModelsSection";
import { PreviewPanel } from "./agents/editor/PreviewPanel";
import { PrimaryModelSection } from "./agents/editor/PrimaryModelSection";
import { RevisionHistory } from "./agents/editor/RevisionHistory";
import { SchemaValidationBlock } from "./agents/editor/SchemaValidationBlock";
import {
  destinationForWinner,
  destDescription,
  entryCandidate,
  entryRawId,
  probeCodeSuffix,
  probeOf,
  PROBE_FAILURE_STATES,
  seedEntry,
  serializeEntry,
} from "./agents/editor/model-utils";
import type {
  ChainEntryState,
  DestKind,
  EditStateResponse,
  ProbeCandidate,
  ProvenanceLookup,
} from "./agents/editor/types";
import { STAGE_RANK, VARIANT_DATALIST_ID } from "./agents/editor/types";
import "../styles/agents.css";
import "../styles/agent-model-editor.css";

export const AGENT_EDIT_TITLE_ID = "agent-edit-modal-title";

export function AgentEditModal(props: {
  agent: string;
  initialModel?: string;
  initialVariant?: string;
  /** Row from AgentsDto for the Effective / Live summary. */
  row?: AgentRow;
  /**
   * Assigned layer from the Agents page presentation model (base intentional
   * source). The Current state card uses THIS — never `row.desiredModel`,
   * which prefers root over preset and misrepresents the preset assignment.
   */
  assigned?: { model?: string; variant?: string; sourcePath?: string };
  /** Focus-return target getter (row Edit button or row detail trigger). */
  returnFocus?: () => HTMLElement | null;
  onClose: () => void;
  onApplied: () => void;
}) {
  const { providers, connection } = useRuntime();
  const avail = useModelAvailabilityOptional();
  const row = props.row ?? null;
  const ocDisconnected = connection.rest === "disconnected";
  const [testingKeys, setTestingKeys] = useState<ReadonlySet<number>>(
    new Set(),
  );

  const [editState, setEditState] = useState<EditStateResponse | null>(null);
  const [provModel, setProvModel] = useState<ResolvedProperty | null>(null);
  const [provVariant, setProvVariant] = useState<ResolvedProperty | null>(null);
  const [provLoaded, setProvLoaded] = useState(false);

  const [scope, setScope] = useState<ConfigWriteScope>("user");
  const [destKind, setDestKind] = useState<DestKind>("preset");
  const [destTouched, setDestTouched] = useState(false);

  const keyCounter = useRef(1);
  const nextKey = () => keyCounter.current++;
  const [focusFallbackKey, setFocusFallbackKey] = useState<number | null>(null);

  const knownProviders = useMemo(
    () => new Set((providers?.providers ?? []).map((p) => p.id)),
    [providers],
  );

  const [chain, setChain] = useState<ChainEntryState[]>(() => [
    seedEntry(keyCounter.current++, props.initialModel ?? "", "", new Set()),
  ]);
  const seededFromProv = useRef(false);

  const [agentVariant, setAgentVariant] = useState(props.initialVariant ?? "");
  const [editVariantToo, setEditVariantToo] = useState(false);

  const [sim, setSim] = useState<SimulationResult | null>(null);
  const [simVariant, setSimVariant] = useState<SimulationResult | null>(null);
  const [applySchemaValidation, setApplySchemaValidation] =
    useState<SchemaValidationSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflictMsg, setConflictMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [catalogFilter, setCatalogFilter] = useState("");

  const [revsOpen, setRevsOpen] = useState(false);
  const [revs, setRevs] = useState<ConfigRevision[] | null>(null);
  const [revsLoading, setRevsLoading] = useState(false);
  const [confirmRevId, setConfirmRevId] = useState<string | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);

  const touch = () => {
    setSim(null);
    setSimVariant(null);
    setConflictMsg(null);
    setApplySchemaValidation(null);
  };

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/config/edit-state").then(
        (r) => r.json() as Promise<EditStateResponse>,
      ),
      fetch(
        `/api/omo/provenance?path=${encodeURIComponent(`agents.${props.agent}.model`)}`,
      ).then((r) => r.json() as Promise<ProvenanceLookup>),
      fetch(
        `/api/omo/provenance?path=${encodeURIComponent(`agents.${props.agent}.variant`)}`,
      ).then((r) => r.json() as Promise<ProvenanceLookup>),
    ])
      .then(([es, pm, pv]) => {
        if (cancelled) return;
        setEditState(es);
        setProvModel(pm.found ? pm.property : null);
        setProvVariant(pv.found ? pv.property : null);
        setProvLoaded(true);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.agent]);

  useEffect(() => {
    if (!provLoaded || providers === null || seededFromProv.current) return;
    seededFromProv.current = true;

    const fallbackRaw =
      row?.effectiveModel ?? row?.desiredModel ?? props.initialModel ?? "";
    const rawVal = provModel?.winner.value ?? provModel?.value;
    const rawItems: unknown[] = Array.isArray(rawVal)
      ? rawVal
      : rawVal != null
        ? [rawVal]
        : [];
    const entries: ChainEntryState[] = [];
    for (const item of rawItems) {
      const raw =
        typeof item === "string"
          ? item
          : item && typeof item === "object"
            ? String((item as { id?: unknown }).id ?? "")
            : "";
      if (!raw) continue;
      const v =
        item && typeof item === "object"
          ? String((item as { variant?: unknown }).variant ?? "")
          : "";
      entries.push(seedEntry(nextKey(), raw, v, knownProviders));
    }
    setChain(
      entries.length > 0
        ? entries
        : [seedEntry(nextKey(), fallbackRaw, "", knownProviders)],
    );

    const winnerVariant = provVariant?.winner.value ?? provVariant?.value;
    if (typeof winnerVariant === "string") setAgentVariant(winnerVariant);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provLoaded, providers, provModel, provVariant, knownProviders]);

  useEffect(() => {
    if (!provLoaded || destTouched) return;
    const w = provModel?.winner;
    const d = w ? destinationForWinner(w) : null;
    if (d) {
      setScope(d.scope);
      setDestKind(d.kind);
    } else {
      setScope("user");
      setDestKind("preset");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provLoaded, provModel, destTouched]);

  const providerGroups = useMemo(() => {
    const all = providers?.providers ?? [];
    const needle = catalogFilter.trim().toLowerCase();
    const matches = (p: (typeof all)[number]) =>
      !needle ||
      p.id.toLowerCase().includes(needle) ||
      p.name.toLowerCase().includes(needle) ||
      p.models.some((m) => m.id.toLowerCase().includes(needle));
    const filtered = all.filter(matches);
    return {
      connected: filtered.filter((p) => p.connected),
      disconnected: filtered.filter((p) => !p.connected),
      any: filtered.length > 0,
    };
  }, [providers, catalogFilter]);

  const variantSuggestions = useMemo(() => {
    const s = new Set<string>();
    for (const e of chain) if (e.variant.trim()) s.add(e.variant.trim());
    if (row?.effectiveVariant) s.add(row.effectiveVariant);
    if (row?.liveVariant) s.add(row.liveVariant);
    const wv = provVariant?.winner.value ?? provVariant?.value;
    if (typeof wv === "string" && wv) s.add(wv);
    return [...s].sort();
  }, [chain, row, provVariant]);

  const modelsFor = (entry: ChainEntryState) => {
    const p = providers?.providers.find((x) => x.id === entry.providerId);
    if (!p) return { provider: null, models: [], currentMissing: false };
    const needle = catalogFilter.trim().toLowerCase();
    let ms = p.models;
    if (needle && ms.some((m) => m.id.toLowerCase().includes(needle))) {
      ms = ms.filter((m) => m.id.toLowerCase().includes(needle));
    }
    const currentMissing =
      entry.modelId !== "" && !p.models.some((m) => m.id === entry.modelId);
    return { provider: p, models: ms, currentMissing };
  };

  const serializedChain = chain
    .map(serializeEntry)
    .filter((e) => (typeof e === "string" ? e !== "" : e.id !== ""));
  const primaryMissing = serializedChain.length === 0;
  const primary = chain[0];
  const fallbacks = chain.slice(1);

  const buildModelMutation = (es: EditStateResponse): ConfigMutation => {
    const destination =
      destKind === "preset"
        ? { kind: "preset" as const, preset: es.preset || "openai" }
        : { kind: "root-agent" as const };
    const hash = scope === "user" ? es.user.hash : es.project.hash;
    const model: ModelChainEntry[] = serializedChain;
    return {
      kind: "agent-model",
      scope,
      destination,
      agent: props.agent,
      model,
      expectedSourceHash: hash ?? undefined,
    };
  };

  const buildVariantMutation = (es: EditStateResponse): ConfigMutation => {
    const destination =
      destKind === "preset"
        ? { kind: "preset" as const, preset: es.preset || "openai" }
        : { kind: "root-agent" as const };
    const hash = scope === "user" ? es.user.hash : es.project.hash;
    return {
      kind: "agent-variant",
      scope,
      destination,
      agent: props.agent,
      variant: agentVariant.trim() || null,
      expectedSourceHash: hash ?? undefined,
    };
  };

  const refreshEditState = async (): Promise<EditStateResponse> => {
    const es = (await fetch("/api/config/edit-state").then((r) =>
      r.json(),
    )) as EditStateResponse;
    setEditState(es);
    return es;
  };

  const simulate = async (mut: ConfigMutation): Promise<SimulationResult> => {
    const r = await fetch("/api/config/simulate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mut),
    });
    return (await r.json()) as SimulationResult;
  };

  const preview = async () => {
    setBusy(true);
    setError(null);
    setConflictMsg(null);
    setSim(null);
    setSimVariant(null);
    setApplySchemaValidation(null);
    try {
      const es = await refreshEditState();
      const s1 = await simulate(buildModelMutation(es));
      setSim(s1);
      if (!s1.ok) setError(s1.errors.join("; ") || "Simulation failed");
      if (editVariantToo) {
        const s2 = await simulate(buildVariantMutation(es));
        setSimVariant(s2);
        if (!s2.ok) {
          setError(
            (prev) =>
              prev ?? (s2.errors.join("; ") || "Variant simulation failed"),
          );
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!sim?.ok) {
      setError("Preview a valid model change first");
      return;
    }
    if (editVariantToo && !simVariant?.ok) {
      setError("Preview a valid variant change first");
      return;
    }
    setBusy(true);
    setError(null);
    setApplySchemaValidation(null);
    try {
      let es = await refreshEditState();
      const r1 = await fetch("/api/config/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildModelMutation(es)),
      });
      const d1 = (await r1.json()) as ApplyResult;
      if (!d1.ok) {
        if (r1.status === 409 || d1.conflict) {
          setConflictMsg(
            d1.conflict?.message ??
              "The target file changed since preview. Re-preview to continue.",
          );
          return;
        }
        if (d1.schemaValidation) setApplySchemaValidation(d1.schemaValidation);
        setError(d1.errors?.join("; ") || "Apply failed");
        return;
      }
      if (editVariantToo) {
        es = await refreshEditState();
        const vmut = buildVariantMutation(es);
        const s2 = await simulate(vmut);
        setSimVariant(s2);
        if (!s2.ok) {
          setError(
            `Model applied, but variant simulation failed: ${s2.errors.join("; ")}`,
          );
          notifyOmoSchemaStatusRefresh();
          props.onApplied();
          return;
        }
        const r2 = await fetch("/api/config/apply", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(vmut),
        });
        const d2 = (await r2.json()) as ApplyResult;
        if (!d2.ok) {
          if (r2.status === 409 || d2.conflict) {
            setConflictMsg(
              `Model applied; variant write conflicted: ${d2.conflict?.message ?? "target file changed. Re-preview to retry the variant."}`,
            );
            notifyOmoSchemaStatusRefresh();
            props.onApplied();
            return;
          }
          if (d2.schemaValidation)
            setApplySchemaValidation(d2.schemaValidation);
          setError(
            `Model applied; variant apply failed: ${(d2.errors ?? []).join("; ")}`,
          );
          notifyOmoSchemaStatusRefresh();
          props.onApplied();
          return;
        }
      }
      notifyOmoSchemaStatusRefresh();
      props.onApplied();
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const winnerDest = provModel?.winner
    ? destinationForWinner(provModel.winner)
    : null;

  const destDiffersFromWinner =
    winnerDest != null &&
    (scope !== winnerDest.scope || destKind !== winnerDest.kind);

  const maskedWarning = useMemo(() => {
    const w = provModel?.winner;
    if (!w || !provModel) return null;
    const winnerRank = STAGE_RANK[w.stage] ?? 0;
    const destRank = destKind === "root-agent" ? 50 : 40;
    if (destRank >= winnerRank) return null;
    return {
      sourcePath: w.sourcePath,
      reason: provModel.reason,
    };
  }, [provModel, destKind]);

  const openRevs = async () => {
    setRevsOpen(true);
    if (revs !== null) return;
    setRevsLoading(true);
    try {
      const d = (await fetch("/api/config/revisions").then((r) =>
        r.json(),
      )) as { revisions: ConfigRevision[] };
      setRevs(
        (d.revisions ?? []).filter((r) => r.agent === props.agent).slice(0, 5),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRevs([]);
    } finally {
      setRevsLoading(false);
    }
  };

  const restore = async (id: string) => {
    setRestoreBusy(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/config/revisions/${encodeURIComponent(id)}/restore`,
        { method: "POST" },
      );
      const d = (await r.json()) as {
        ok?: boolean;
        errors?: string[];
        error?: string;
      };
      if (!d.ok) {
        setError(d.errors?.join("; ") || d.error || "Restore failed");
        return;
      }
      notifyOmoSchemaStatusRefresh();
      props.onApplied();
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRestoreBusy(false);
    }
  };

  const updateEntry = (key: number, patch: Partial<ChainEntryState>) => {
    touch();
    setChain((c) => c.map((e) => (e.key === key ? { ...e, ...patch } : e)));
  };

  const moveEntry = (i: number, dir: -1 | 1) => {
    touch();
    setChain((c) => {
      const j = i + dir;
      if (j < 0 || j >= c.length) return c;
      if (i === 0 || j === 0) return c;
      const next = [...c];
      const tmp = next[i]!;
      next[i] = next[j]!;
      next[j] = tmp;
      return next;
    });
  };

  const testEntry = async (entry: ChainEntryState, cand: ProbeCandidate) => {
    setTestingKeys((prev) => new Set(prev).add(entry.key));
    try {
      await api.probeModel(cand.providerId, cand.modelId, true);
      await avail?.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTestingKeys((prev) => {
        const next = new Set(prev);
        next.delete(entry.key);
        return next;
      });
    }
  };

  const chainProbeSummary = useMemo(() => {
    if (!avail || avail.loading) return null;
    const candidates = chain.map(entryCandidate);
    const first = candidates[0];
    if (!first) return null;
    const parts: string[] = [];
    const pAv = probeOf(avail, first);
    const pState = pAv?.probe.state ?? "never";
    if (pState === "never") parts.push("Primary has not been tested.");
    else if (PROBE_FAILURE_STATES.has(pState))
      parts.push(
        `Primary failed its last explicit probe (${probeStateLabel(pState)}${probeCodeSuffix(pAv)}).`,
      );
    else if (pState === "healthy") parts.push("Primary last probed healthy.");
    else if (pState === "running")
      parts.push("Primary is currently being probed.");
    for (let i = 1; i < candidates.length; i++) {
      const c = candidates[i];
      if (!c) continue;
      const fAv = probeOf(avail, c);
      if (fAv?.probe.state === "healthy") {
        const when = probeAgo(fAv.probe.lastCompletedAt);
        parts.push(
          `Fallback ${i} last known healthy${when ? ` (${when})` : ""}.`,
        );
        break;
      }
    }
    if (parts.length === 0) return null;
    return parts.join(" ");
  }, [chain, avail]);

  const schemaBlocked =
    (sim?.schemaValidation != null && !sim.schemaValidation.ok) ||
    (applySchemaValidation != null && !applySchemaValidation.ok);
  const applyEnabled =
    !busy &&
    !!sim?.ok &&
    (!editVariantToo || !!simVariant?.ok) &&
    !schemaBlocked;
  const applyDisabledReason = primaryMissing
    ? "Primary model required."
    : !sim
      ? "Preview changes before applying this assignment."
      : !sim.ok
        ? "Preview a valid model change first."
        : editVariantToo && !simVariant?.ok
          ? "Preview a valid variant change first."
          : schemaBlocked
            ? "Proposed configuration fails the installed OMO-Slim schema."
            : busy
              ? "Working…"
              : null;

  const primaryModels = primary
    ? modelsFor(primary)
    : { provider: null, models: [], currentMissing: false };

  return (
    <FocusTrapDialog
      variant="modal"
      labelledBy={AGENT_EDIT_TITLE_ID}
      onClose={props.onClose}
      returnFocus={props.returnFocus}
      className="modal agents-edit-modal ame-dialog"
    >
      <div className="agents-edit-body ame-shell">
        <div className="inspector-head ame-head">
          <div>
            <h2
              className="inspector-title"
              id={AGENT_EDIT_TITLE_ID}
              tabIndex={-1}
            >
              Change model — <span className="mono">{props.agent}</span>
            </h2>
            <p className="ame-head-note">
              Edit → Preview changes → Apply Assignment. Existing sessions keep
              their recorded model until reload.
            </p>
          </div>
          <Button size="sm" onClick={props.onClose}>
            Close
          </Button>
        </div>

        <div className="ame-scroll">
          <div className="ame-live" aria-live="polite">
            {error ? <div className="error">{error}</div> : null}
            {conflictMsg ? (
              <div className="error">
                {conflictMsg}{" "}
                <button
                  type="button"
                  className="btn btn-xs"
                  onClick={() => void preview()}
                  disabled={busy || primaryMissing}
                >
                  Re-preview
                </button>
              </div>
            ) : null}
          </div>

          {row ? (
            <CurrentAssignment
              agent={props.agent}
              row={row}
              assigned={props.assigned}
              provModel={provModel}
              providers={providers?.providers ?? []}
            />
          ) : null}
          {!provLoaded ? <p className="muted">Loading provenance…</p> : null}

          <datalist id={VARIANT_DATALIST_ID}>
            {variantSuggestions.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>

          {primary ? (
            <PrimaryModelSection
              entry={primary}
              providerGroups={providerGroups}
              allProviders={providers?.providers ?? []}
              catalogFilter={catalogFilter}
              onCatalogFilter={setCatalogFilter}
              models={primaryModels.models}
              currentMissing={primaryModels.currentMissing}
              providerMissing={!!primary.providerId && !primaryModels.provider}
              avail={avail}
              liveProviders={providers?.providers ?? []}
              ocDisconnected={ocDisconnected}
              testing={testingKeys.has(primary.key)}
              onTest={(e2, cand) => void testEntry(e2, cand)}
              onUpdate={(patch) => updateEntry(primary.key, patch)}
              agentVariant={agentVariant}
              editVariantToo={editVariantToo}
              onEditVariantToo={(next) => {
                touch();
                setEditVariantToo(next);
              }}
              onAgentVariant={(next) => {
                touch();
                setAgentVariant(next);
              }}
              agentName={props.agent}
              catalogLoading={providers === null}
              filterEmpty={!providerGroups.any && !!providers}
            />
          ) : null}

          <FallbackModelsSection
            fallbacks={fallbacks}
            providerGroups={providerGroups}
            modelsFor={modelsFor}
            avail={avail}
            liveProviders={providers?.providers ?? []}
            ocDisconnected={ocDisconnected}
            testingKeys={testingKeys}
            onTest={(e2, cand) => void testEntry(e2, cand)}
            onUpdate={updateEntry}
            onMove={moveEntry}
            onRemove={(key) => {
              touch();
              setChain((c) =>
                c.length <= 1 ? c : c.filter((x) => x.key !== key),
              );
            }}
            onAdd={() => {
              touch();
              const key = nextKey();
              setFocusFallbackKey(key);
              setChain((c) => [
                ...c,
                {
                  key,
                  mode: "catalog",
                  providerId: "",
                  modelId: "",
                  manualId: "",
                  variant: "",
                },
              ]);
            }}
            focusKey={focusFallbackKey}
            chainProbeSummary={chainProbeSummary}
          />

          <AssignmentLocation
            agent={props.agent}
            scope={scope}
            destKind={destKind}
            editState={editState}
            winnerDest={winnerDest}
            destDiffersFromWinner={destDiffersFromWinner}
            maskedWarning={maskedWarning}
            provModel={provModel}
            onChange={(nextScope, nextKind) => {
              touch();
              setDestTouched(true);
              setScope(nextScope);
              setDestKind(nextKind);
            }}
            onUseControlling={() => {
              if (!winnerDest) return;
              touch();
              setDestTouched(true);
              setScope(winnerDest.scope);
              setDestKind(winnerDest.kind);
            }}
          />

          {applySchemaValidation && !sim ? (
            <SchemaValidationBlock
              title="OMO-Slim schema validation — apply rejected"
              sv={applySchemaValidation}
            />
          ) : null}
          {sim ? (
            <PreviewPanel
              sim={sim}
              simVariant={simVariant}
              editVariantToo={editVariantToo}
              targetDesc={destDescription(scope, destKind, editState?.preset)}
              liveModel={row?.liveModel}
              maskedWinner={provModel}
              applySchemaValidation={applySchemaValidation}
              candidate={primary ? entryCandidate(primary) : null}
              avail={avail}
              variantBefore={
                typeof (provVariant?.winner.value ?? provVariant?.value) ===
                "string"
                  ? String(provVariant?.winner.value ?? provVariant?.value)
                  : (props.initialVariant ?? "")
              }
              variantAfter={agentVariant}
            />
          ) : null}

          <RevisionHistory
            agent={props.agent}
            open={revsOpen}
            loading={revsLoading}
            revisions={revs}
            confirmRevId={confirmRevId}
            restoreBusy={restoreBusy}
            onOpen={() => void openRevs()}
            onClose={() => setRevsOpen(false)}
            onToggleConfirm={(id) =>
              setConfirmRevId(confirmRevId === id ? null : id)
            }
            onRestore={(id) => void restore(id)}
          />
        </div>

        <footer className="ame-footer">
          <div className="ame-footer-copy">
            {applyDisabledReason ? (
              <p className="ame-apply-reason">{applyDisabledReason}</p>
            ) : (
              <p className="ame-apply-reason is-ready">
                Ready to write {entryRawId(primary!) || "this assignment"} to{" "}
                {destDescription(scope, destKind, editState?.preset)}.
              </p>
            )}
            {primaryMissing ? (
              <span className="muted">Primary model required.</span>
            ) : null}
          </div>
          <div className="ame-footer-actions">
            <Button size="sm" onClick={props.onClose} disabled={busy}>
              Cancel
            </Button>
            <button
              type="button"
              className="btn"
              disabled={busy || primaryMissing}
              title={primaryMissing ? "Primary model is empty" : undefined}
              onClick={() => void preview()}
            >
              Preview changes
            </button>
            <button
              type="button"
              className="btn ame-apply"
              disabled={!applyEnabled}
              title={
                sim?.schemaValidation && !sim.schemaValidation.ok
                  ? "Proposed configuration fails the installed OMO-Slim schema"
                  : undefined
              }
              onClick={() => void apply()}
            >
              Apply Assignment
            </button>
          </div>
        </footer>
      </div>
    </FocusTrapDialog>
  );
}
