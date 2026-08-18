import { useEffect, useRef, useState } from "react";
import type {
  ResolvedProperty,
  SchemaValidationSummary,
  SimulationResult,
} from "@omo/shared";
import type { ModelAvailabilityContextValue } from "../../../models/ModelAvailabilityContext";
import { SchemaValidationBlock } from "./SchemaValidationBlock";
import type { ProbeCandidate } from "./types";
import {
  fallbackCountOf,
  primaryIdOf,
  probeCodeSuffix,
  probeOf,
  PROBE_FAILURE_STATES,
} from "./model-utils";
import { probeStateLabel } from "../../../models/ProbeBadge";

function PreviewProbeAdvisory(props: {
  candidate: ProbeCandidate | null;
  avail: ModelAvailabilityContextValue | null;
}) {
  const { candidate, avail } = props;
  if (!avail || avail.loading || !candidate) return null;
  const av = probeOf(avail, candidate);
  const probe = av?.probe;
  if (!probe || probe.state === "never") {
    return (
      <div className="info-block">Selected model has never been probed.</div>
    );
  }
  if (probe.freshness === "fresh" && PROBE_FAILURE_STATES.has(probe.state)) {
    return (
      <div className="warn-block">
        Selected model was explicitly probed and failed. Last probe:{" "}
        {probeStateLabel(probe.state)}
        {probeCodeSuffix(av)}. You may still save this configuration.
      </div>
    );
  }
  return null;
}

function changeLine(before: string, after: string): string {
  if (before === after) return `${after} (unchanged)`;
  return `${before} → ${after}`;
}

function SimTechnical(props: {
  sim: SimulationResult;
  targetDesc: string;
  liveModel?: string;
  maskedWinner?: ResolvedProperty | null;
}) {
  const { sim } = props;
  return (
    <>
      <dl className="row-kv">
        <dt>Agent</dt>
        <dd>
          {"agent" in sim.mutation
            ? (sim.mutation as { agent: string }).agent
            : "—"}
        </dd>
        <dt>Target</dt>
        <dd>
          {props.targetDesc} · scope {sim.scope}
        </dd>
        <dt>File</dt>
        <dd>{sim.targetPath}</dd>
        <dt>JSON path</dt>
        <dd>{sim.jsonPath.join(".")}</dd>
        <dt>Creates file</dt>
        <dd>{sim.createsFile ? "yes" : "no"}</dd>
        <dt>Current</dt>
        <dd>{JSON.stringify(sim.currentValue)}</dd>
        <dt>Proposed</dt>
        <dd>{JSON.stringify(sim.proposedValue)}</dd>
        <dt>Effective before</dt>
        <dd>{JSON.stringify(sim.effectiveBefore)}</dd>
        <dt>Effective after</dt>
        <dd>{JSON.stringify(sim.effectiveAfter)}</dd>
        <dt>Live</dt>
        <dd>
          {props.liveModel ?? "—"}{" "}
          <span className="sim-live-note">(runtime — stays authoritative)</span>
        </dd>
      </dl>
      {sim.masked ? (
        <div className="warn-block">
          This write is <strong>masked</strong> — a higher-precedence source
          currently wins
          {props.maskedWinner?.winner
            ? ` (${props.maskedWinner.winner.stage} · ${props.maskedWinner.winner.sourcePath})`
            : ""}
          . Effective model may not change. {props.maskedWinner?.reason ?? ""}
        </div>
      ) : null}
      {sim.schemaValidation ? (
        <SchemaValidationBlock sv={sim.schemaValidation} />
      ) : null}
      {sim.warnings.map((w, i) => (
        <div key={i} className="error">
          {w}
        </div>
      ))}
      <p className="muted">{sim.liveNote}</p>
      <p className="muted">
        Existing sessions retain their recorded model; this applies on
        OMO/OpenCode reload/session lifecycle.
      </p>
    </>
  );
}

function SimCard(props: {
  title: string;
  sim: SimulationResult;
  targetDesc: string;
  liveModel?: string;
  maskedWinner?: ResolvedProperty | null;
  leadSummary?: boolean;
  variantBefore?: string;
  variantAfter?: string;
}) {
  const { sim } = props;
  const [tab, setTab] = useState<"summary" | "impact" | "diff" | "schema">(
    "summary",
  );
  const agent =
    "agent" in sim.mutation
      ? (sim.mutation as { agent: string }).agent
      : "—";
  const modelBefore =
    primaryIdOf(sim.effectiveBefore) ??
    primaryIdOf(sim.currentValue) ??
    "—";
  const modelAfter =
    primaryIdOf(sim.effectiveAfter) ??
    primaryIdOf(sim.proposedValue) ??
    "—";
  const fallbacksBefore = fallbackCountOf(
    sim.effectiveBefore ?? sim.currentValue,
  );
  const fallbacksAfter = fallbackCountOf(
    sim.effectiveAfter ?? sim.proposedValue,
  );
  const schema = sim.schemaValidation;
  const schemaLabel = !schema
    ? "not reported"
    : schema.unavailable
      ? "unavailable"
      : schema.ok
        ? "valid"
        : "invalid";

  return (
    <div className="card ame-preview-card">
      <h2 tabIndex={-1}>{props.title}</h2>
      {props.leadSummary ? (
        <>
          <dl className="ame-summary-dl">
            <div>
              <dt>Agent</dt>
              <dd className="mono">{agent}</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd className="mono">{changeLine(modelBefore, modelAfter)}</dd>
            </div>
            <div>
              <dt>Variant</dt>
              <dd className="mono">
                {changeLine(
                  props.variantBefore?.trim() || "none",
                  props.variantAfter?.trim() || "none",
                )}
              </dd>
            </div>
            <div>
              <dt>Fallbacks</dt>
              <dd>
                {fallbacksBefore === fallbacksAfter
                  ? `${fallbacksAfter} (unchanged)`
                  : `${fallbacksBefore} → ${fallbacksAfter}`}
              </dd>
            </div>
            <div>
              <dt>Stored in</dt>
              <dd>{props.targetDesc}</dd>
            </div>
            <div>
              <dt>Schema</dt>
              <dd>{schemaLabel}</dd>
            </div>
          </dl>
          <div className="ame-preview-tabs" role="tablist" aria-label="Preview details">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "summary"}
              className={tab === "summary" ? "tab active" : "tab"}
              onClick={() => setTab("summary")}
            >
              Summary
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "impact"}
              className={tab === "impact" ? "tab active" : "tab"}
              onClick={() => setTab("impact")}
            >
              Effective impact
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "diff"}
              className={tab === "diff" ? "tab active" : "tab"}
              onClick={() => setTab("diff")}
            >
              Source diff
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "schema"}
              className={tab === "schema" ? "tab active" : "tab"}
              onClick={() => setTab("schema")}
            >
              Validation
            </button>
          </div>
          {tab === "summary" ? (
            <SimTechnical
              sim={sim}
              targetDesc={props.targetDesc}
              liveModel={props.liveModel}
              maskedWinner={props.maskedWinner}
            />
          ) : null}
          {tab === "impact" ? (
            <dl className="row-kv">
              <dt>Effective before</dt>
              <dd>{JSON.stringify(sim.effectiveBefore)}</dd>
              <dt>Effective after</dt>
              <dd>{JSON.stringify(sim.effectiveAfter)}</dd>
              <dt>Masked</dt>
              <dd>{sim.masked ? "yes" : "no"}</dd>
            </dl>
          ) : null}
          {tab === "diff" ? (
            <>
              <div className="section-title">Text diff</div>
              <pre className="msg-pre diff-patch">{sim.textDiff}</pre>
            </>
          ) : null}
          {tab === "schema" && schema ? (
            <SchemaValidationBlock sv={schema} />
          ) : tab === "schema" ? (
            <p className="muted">No schema report on this preview.</p>
          ) : null}
        </>
      ) : (
        <>
          <SimTechnical
            sim={sim}
            targetDesc={props.targetDesc}
            liveModel={props.liveModel}
            maskedWinner={props.maskedWinner}
          />
          <div className="section-title">Text diff</div>
          <pre className="msg-pre diff-patch">{sim.textDiff}</pre>
        </>
      )}
    </div>
  );
}

export function PreviewPanel(props: {
  sim: SimulationResult;
  simVariant: SimulationResult | null;
  editVariantToo: boolean;
  targetDesc: string;
  liveModel?: string;
  maskedWinner?: ResolvedProperty | null;
  applySchemaValidation: SchemaValidationSummary | null;
  candidate: ProbeCandidate | null;
  avail: ModelAvailabilityContextValue | null;
  variantBefore?: string;
  variantAfter?: string;
}) {
  const stackRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const heading = stackRef.current?.querySelector<HTMLElement>("h2");
    heading?.focus?.();
  }, [props.sim]);

  return (
    <div className="ame-preview-stack" aria-live="polite" ref={stackRef}>
      {props.applySchemaValidation ? (
        <SchemaValidationBlock
          title="OMO-Slim schema validation — apply rejected"
          sv={props.applySchemaValidation}
        />
      ) : null}
      <PreviewProbeAdvisory candidate={props.candidate} avail={props.avail} />
      <SimCard
        title="Preview — model"
        sim={props.sim}
        targetDesc={props.targetDesc}
        liveModel={props.liveModel}
        maskedWinner={props.maskedWinner}
        leadSummary
        variantBefore={props.variantBefore}
        variantAfter={props.editVariantToo ? props.variantAfter : props.variantBefore}
      />
      {props.editVariantToo && props.simVariant ? (
        <SimCard
          title="Preview — agent variant"
          sim={props.simVariant}
          targetDesc={props.targetDesc}
        />
      ) : null}
    </div>
  );
}
