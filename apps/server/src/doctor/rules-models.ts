/**
 * Probe-aware model diagnostics (Slice 15, Lane 2).
 *
 * ALL rules are advisory and consume persisted/derived data only
 * (ModelAvailability[] + ProviderDiagnostics[] from the composed inventory).
 * Nothing here invokes probes or any OpenCode HTTP call. Freshness uses
 * classifyFreshness semantics (PROBE_FRESHNESS_MS = 24h), pre-computed into
 * ModelAvailability.probe.freshness by the inventory composer.
 *
 * Severity policy (only warning/error degrade overall):
 *  - never-probed → NO diagnostic; stale-only → NO diagnostic
 *  - errorCode "aborted" latest probe → silent (non-actionable)
 *  - fresh unauthorized / model-not-found on ACTIVE agent primary → warning;
 *    Orchestrator primary escalates to error UNLESS a configured fallback
 *    has a fresh healthy probe (then warning with fallback evidence);
 *    Oracle primary is warning (never error).
 *  - fresh rate-limited → info; Orchestrator/Oracle primary → warning;
 *    provider-level recentRateLimitCount>0 → ONE info diagnostic/provider
 *  - fresh timeout on active primary → warning (uncertainty wording);
 *    otherwise info
 *  - provider/opencode-disconnected probe states with the provider CURRENTLY
 *    disconnected → suppressed per-model; ONE provider-root info diagnostic
 *    related to provider.<pid>.disconnected-active (no double-warn)
 *  - inactive (disabled agent / inactive-preset-only) fresh failures → info
 *  - referenced-but-unadvertised → active: warning (advisory), inactive: info
 *  - tool capability mismatch (envelope non-empty + capabilities known +
 *    tools===false) → warning; unknown/partial → silent
 *  - observer enabled + capabilities.vision===false explicitly → warning;
 *    unknown → silent
 */

import type {
  ModelAvailability,
  ModelProbeState,
  ModelUsageReference,
} from "@omo/shared";
import { modelKey } from "../models/constants";
import type { DoctorInput } from "./input";
import type { RuleContext } from "./rules-core";
import type {
  Diagnostic,
  DiagnosticEvidence,
  DiagnosticSeverity,
  ModelHealthCounts,
} from "./types";

/** Failing terminal probe states (excludes never/running/healthy). */
const FAILING_STATES: ModelProbeState[] = [
  "unauthorized",
  "model-not-found",
  "rate-limited",
  "timeout",
  "provider-disconnected",
  "opencode-disconnected",
  "malformed",
  "error",
];

/** Probe states that mean "the provider/OpenCode path was down at probe time". */
const CONNECTIVITY_PROBE_STATES: ModelProbeState[] = [
  "provider-disconnected",
  "opencode-disconnected",
];

function slug(s: string): string {
  const x = s.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return x || "x";
}

function usageSummary(refs: ModelUsageReference[], cap = 6): string {
  const active = refs.filter((r) => r.active);
  const list = (active.length > 0 ? active : refs).map(
    (r) => `${r.ownerId}${r.fallback ? " (fallback)" : ""}${r.active ? "" : " (inactive)"}`,
  );
  return `${list.slice(0, cap).join(", ")}${list.length > cap ? `, +${list.length - cap} more` : ""}`;
}

function probeEvidence(m: ModelAvailability): DiagnosticEvidence[] {
  const p = m.probe;
  const ev: DiagnosticEvidence[] = [
    { label: "probe state", kind: "observation", value: `${p.state} (${p.freshness})` },
  ];
  if (p.statusCode !== undefined) {
    ev.push({ label: "status code", kind: "observation", value: String(p.statusCode) });
  }
  if (p.errorCode !== undefined) {
    ev.push({ label: "error code", kind: "observation", value: p.errorCode });
  }
  if (p.errorMessage !== undefined) {
    // Already sanitized at probe persistence time.
    ev.push({ label: "sanitized error", kind: "observation", value: p.errorMessage });
  }
  if (p.latencyMs !== undefined) {
    ev.push({ label: "probe latency", kind: "observation", value: `${p.latencyMs}ms` });
  }
  if (p.lastCompletedAt !== undefined) {
    ev.push({ label: "last completed", kind: "observation", value: p.lastCompletedAt });
  }
  ev.push({
    label: "advertised",
    kind: "observation",
    value: m.advertised ? `yes (${m.providerId} catalog)` : "no",
  });
  const capSource =
    m.capabilities.source !== "none" ? ` (${m.capabilities.source})` : "";
  ev.push({
    label: "capabilities",
    kind: "observation",
    value: `${m.capabilities.state}${capSource}`,
  });
  return ev;
}

export function modelProbeRules(
  input: DoctorInput,
  ctx: RuleContext,
): Diagnostic[] {
  const inv = input.modelInventory;
  if (!inv || !ctx.lifecycleReady) return [];
  const out: Diagnostic[] = [];

  // agent name → fallback model availabilities (for Orchestrator escalation)
  const fallbacksByAgent = new Map<string, ModelAvailability[]>();
  for (const m of inv.models) {
    for (const ref of m.usage) {
      if (ref.kind !== "agent-fallback") continue;
      const list = fallbacksByAgent.get(ref.ownerId) ?? [];
      list.push(m);
      fallbacksByAgent.set(ref.ownerId, list);
    }
  }
  const hasFreshHealthy = (m: ModelAvailability | undefined): boolean =>
    !!m && m.probe.state === "healthy" && m.probe.freshness === "fresh";

  // ── Rule 8: provider currently disconnected → suppress per-model noise ──
  const suppressed = new Set<string>();
  for (const p of inv.providers) {
    if (p.connected) continue;
    const blocked = inv.models.filter(
      (m) =>
        m.providerId === p.providerId &&
        m.probe.freshness === "fresh" &&
        CONNECTIVITY_PROBE_STATES.includes(m.probe.state),
    );
    if (blocked.length === 0) continue;
    for (const m of blocked) suppressed.add(modelKey(m.providerId, m.modelId));
    out.push({
      id: `provider.${slug(p.providerId)}.probes-blocked-disconnected`,
      category: "models",
      severity: "info",
      title: `${p.name ?? p.providerId}: recent probes blocked by provider disconnect`,
      summary: `${blocked.length} model probe(s) for ${p.providerId} recorded provider/opencode-disconnected within the last 24h. Root cause is provider connectivity, not the models themselves — see the provider diagnostic.`,
      evidence: blocked.slice(0, 6).map((m) => ({
        label: m.modelId,
        kind: "observation",
        value: `${m.probe.state} @ ${m.probe.lastCompletedAt ?? "?"}`,
      })),
      // Root-cause diagnostic emitted by providerModelRules when the
      // provider has active usage; harmless reference otherwise.
      relatedDiagnosticIds: [`provider.${p.providerId}.disconnected-active`],
      remediation: { action: "navigate", target: "/models", label: "Open Models" },
    });
  }

  // ── Rule 6 (provider part): rate-limit roll-up, at most one per provider ──
  for (const p of inv.providers) {
    if (p.recentRateLimitCount > 0) {
      out.push({
        id: `provider.${slug(p.providerId)}.recent-rate-limited`,
        category: "models",
        severity: "info",
        title: `${p.name ?? p.providerId}: recent rate limits`,
        summary: `${p.recentRateLimitCount} probe run(s) for ${p.providerId} hit provider rate limits in the last 24h.`,
        evidence: [
          {
            label: "rate-limited probes (24h)",
            kind: "observation",
            value: String(p.recentRateLimitCount),
          },
        ],
        remediation: { action: "navigate", target: "/models", label: "Open Models" },
      });
    }
  }

  // ── Per-model probe rules ────────────────────────────────────────────────
  for (const m of inv.models) {
    const refs = m.usage;
    if (refs.length === 0) continue; // unreferenced history — silent
    const st = m.probe.state;
    if (st === "never" || st === "running") continue; // rule 1 (never) / in-flight
    if (m.probe.freshness !== "fresh") continue; // rule 1 (stale-only)
    if (st === "healthy") continue;
    if (m.probe.errorCode === "aborted") continue; // rule 2
    if (suppressed.has(modelKey(m.providerId, m.modelId))) continue; // rule 8

    const activePrimaryRefs = refs.filter(
      (r) => r.kind === "agent-primary" && r.active,
    );
    const hasActiveUsage = refs.some((r) => r.active);
    const baseId = `model.${slug(m.providerId)}.${slug(m.modelId)}`;
    const evidence = probeEvidence(m);
    evidence.push({
      label: "usage",
      kind: "resolved-property",
      value: usageSummary(refs),
    });

    const push = (
      suffix: string,
      severity: DiagnosticSeverity,
      title: string,
      summary: string,
      extra: Partial<Diagnostic> = {},
    ) => {
      out.push({
        id: `${baseId}.${suffix}`,
        category: "models",
        severity,
        title,
        summary,
        evidence: [...evidence, ...(extra.evidence ?? [])],
        live: {
          state: st,
          freshness: m.probe.freshness,
          statusCode: m.probe.statusCode,
          errorCode: m.probe.errorCode,
          latencyMs: m.probe.latencyMs,
          lastCompletedAt: m.probe.lastCompletedAt,
          advertised: m.advertised,
        },
        remediation: extra.remediation ?? {
          action: "navigate",
          target: "/models",
          label: "Open Models",
        },
        ...(extra.relatedDiagnosticIds
          ? { relatedDiagnosticIds: extra.relatedDiagnosticIds }
          : {}),
      });
    };

    switch (st) {
      case "unauthorized":
      case "model-not-found": {
        if (activePrimaryRefs.length === 0) {
          // Active fallback-only usage: conservative silence; inactive: rule 5.
          if (!hasActiveUsage) {
            push(`probe-${st}`, "info", `${m.providerId}/${m.modelId}: probe ${st}`, `Referenced (inactive) model probed as ${st}: ${m.probe.errorMessage ?? ""}`.trim());
          }
          break;
        }
        const owners = activePrimaryRefs.map((r) => r.ownerId);
        const orchestrator = owners.includes("orchestrator");
        if (orchestrator) {
          const fbs = fallbacksByAgent.get("orchestrator") ?? [];
          const goodFbs = fbs.filter(hasFreshHealthy);
          const fbEvidence: DiagnosticEvidence[] = fbs.map((f) => ({
            label: `fallback ${f.providerId}/${f.modelId}`,
            kind: "observation",
            value: `${f.probe.state} (${f.probe.freshness})`,
          }));
          if (goodFbs.length > 0) {
            push(
              `probe-${st}`,
              "warning",
              `Orchestrator primary ${m.providerId}/${m.modelId}: probe ${st}`,
              `Orchestrator's primary model probes as ${st} (${m.probe.errorMessage ?? "no detail"}), but ${goodFbs.length} configured fallback(s) have a fresh healthy probe — Orchestrator can degrade gracefully.`,
              { evidence: fbEvidence },
            );
          } else {
            push(
              `probe-${st}`,
              "error",
              `Orchestrator primary ${m.providerId}/${m.modelId}: probe ${st}`,
              `Orchestrator's primary model probes as ${st} (${m.probe.errorMessage ?? "no detail"}) and NO configured fallback has a fresh healthy probe. The Orchestrator is likely unable to run.`,
              { evidence: fbEvidence },
            );
          }
        } else {
          // Includes Oracle — always warning, never error (rule 4).
          push(
            `probe-${st}`,
            "warning",
            `${m.providerId}/${m.modelId}: active primary probe ${st}`,
            `Active primary for ${owners.join(", ")} probes as ${st}: ${m.probe.errorMessage ?? "no detail"}.`,
          );
        }
        break;
      }

      case "rate-limited": {
        const hot = activePrimaryRefs.filter(
          (r) => r.ownerId === "orchestrator" || r.ownerId === "oracle",
        );
        if (hot.length > 0) {
          push(
            "probe-rate-limited",
            "warning",
            `${m.providerId}/${m.modelId}: rate limited (${hot.map((r) => r.ownerId).join(", ")})`,
            `Active ${hot.map((r) => r.ownerId).join("/")} primary hit provider rate limits on probe within the last 24h.`,
          );
        } else {
          push(
            "probe-rate-limited",
            "info",
            `${m.providerId}/${m.modelId}: rate limited`,
            `Referenced model hit provider rate limits on probe within the last 24h.`,
          );
        }
        break;
      }

      case "timeout": {
        if (activePrimaryRefs.length > 0) {
          push(
            "probe-timeout",
            "warning",
            `${m.providerId}/${m.modelId}: probe timed out`,
            `Active primary for ${activePrimaryRefs.map((r) => r.ownerId).join(", ")} — probe exceeded the 20s deadline. This may be transient (provider slowness); the model state is uncertain, not proven broken.`,
          );
        } else {
          push(
            "probe-timeout",
            "info",
            `${m.providerId}/${m.modelId}: probe timed out`,
            `Referenced model probe exceeded the 20s deadline — may be transient; state uncertain.`,
          );
        }
        break;
      }

      default: {
        // error / malformed / connectivity states (unsuppressed): rule 5.
        if (!hasActiveUsage) {
          push(
            `probe-${st}`,
            "info",
            `${m.providerId}/${m.modelId}: probe ${st}`,
            `Referenced (inactive) model probed as ${st}: ${m.probe.errorMessage ?? ""}`.trim(),
          );
        }
        // Active usage with generic fresh failure: conservative silence.
        break;
      }
    }
  }

  // ── Rule 9: referenced-but-unadvertised ─────────────────────────────────
  if (ctx.openCodeUp) {
    for (const m of inv.models) {
      if (m.usage.length === 0 || m.advertised) continue;
      const active = m.usage.some((r) => r.active);
      out.push({
        id: `model.${slug(m.providerId)}.${slug(m.modelId)}.unadvertised`,
        category: "models",
        severity: active ? "warning" : "info",
        title: `${m.providerId}/${m.modelId}: not advertised by OpenCode catalog`,
        summary: `Referenced by configuration (${usageSummary(m.usage)}) but not advertised by the OpenCode catalog; may still work — probe to verify.`,
        evidence: [
          { label: "advertised", kind: "observation", value: "no" },
          { label: "usage", kind: "resolved-property", value: usageSummary(m.usage) },
          ...(m.probe.lastCompletedAt
            ? [
                {
                  label: "last probe",
                  kind: "observation" as const,
                  value: `${m.probe.state} (${m.probe.freshness}) @ ${m.probe.lastCompletedAt}`,
                },
              ]
            : []),
        ],
        remediation: { action: "navigate", target: "/models", label: "Open Models" },
      });
    }
  }

  // ── Rule 10: tool-capability mismatch (effective envelope only) ──────────
  {
    const capByAgent = new Map(
      (input.capabilities?.agents ?? []).map((c) => [c.agent, c]),
    );
    for (const m of inv.models) {
      if (m.capabilities.state !== "known" || m.capabilities.tools !== false) {
        continue;
      }
      const agentsWithTools = [
        ...new Set(
          m.usage
            .filter((r) => r.kind === "agent-primary" && r.active)
            .map((r) => r.ownerId),
        ),
      ].filter((name) => {
        const caps = capByAgent.get(name);
        if (!caps) return false;
        // Effective envelope: every tool NOT denied is available (OMO/OpenCode
        // defaults allow unset tools). "deny" is the only absence of permission.
        return Object.values(caps.tools).some((decision) => decision !== "deny");
      });
      if (agentsWithTools.length === 0) continue;
      out.push({
        id: `model.${slug(m.providerId)}.${slug(m.modelId)}.capability-tools`,
        category: "models",
        severity: "warning",
        title: `${m.providerId}/${m.modelId}: catalog reports no tool-call support`,
        summary: `Used as primary by ${agentsWithTools.join(", ")} whose effective tool envelope is non-empty, but the OpenCode catalog reports toolcall=false for this model. Tool-driven work will likely fail; unknown/partial capability data never triggers this.`,
        evidence: [
          { label: "capabilities", kind: "observation", value: `known, tools=false (${m.capabilities.source})` },
          { label: "affected agents", kind: "resolved-property", value: agentsWithTools.join(", ") },
        ],
        remediation: { action: "navigate", target: "/agents", label: "Open Agents" },
      });
    }
  }

  // ── Rule 11: observer vision (explicit false only) ───────────────────────
  {
    for (const m of inv.models) {
      const observerRef = m.usage.find(
        (r) => r.kind === "agent-primary" && r.ownerId === "observer" && r.active,
      );
      if (!observerRef) continue;
      if (m.capabilities.state !== "known") continue; // unknown/partial → silent
      if (m.capabilities.vision !== false) continue; // explicit false only
      out.push({
        id: `model.${slug(m.providerId)}.${slug(m.modelId)}.observer-vision`,
        category: "models",
        severity: "warning",
        title: `${m.providerId}/${m.modelId}: Observer model reports no vision input`,
        summary: `Observer is enabled and uses this model as primary, but the OpenCode catalog reports image input unsupported (input.image=false). Image routing/observation will likely fail.`,
        evidence: [
          { label: "capabilities", kind: "observation", value: `known, vision=false (${m.capabilities.source})` },
          { label: "observer", kind: "resolved-property", value: "enabled (effective)" },
        ],
        remediation: { action: "navigate", target: "/agents", label: "Open Agents" },
      });
    }
  }

  return out;
}

/**
 * Compact model-health roll-up for DoctorSnapshot + /api/doctor/summary.
 * neverTested is informational and must never be rendered as alarming.
 */
export function computeModelHealth(
  models: ModelAvailability[],
): ModelHealthCounts {
  let referenced = 0;
  let probed = 0;
  let healthy = 0;
  let freshFailing = 0;
  let neverTested = 0;
  for (const m of models) {
    if (m.configured) referenced++;
    if (m.probe.lastCompletedAt !== undefined) probed++;
    if (m.probe.state === "healthy") healthy++;
    if (
      m.probe.freshness === "fresh" &&
      FAILING_STATES.includes(m.probe.state) &&
      m.probe.errorCode !== "aborted"
    ) {
      freshFailing++;
    }
    if (m.configured && m.probe.state === "never") neverTested++;
  }
  return { referenced, probed, healthy, freshFailing, neverTested };
}
