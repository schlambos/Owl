/**
 * Doctor engine: assemble input, evaluate rules, cache snapshot,
 * invalidate on generation changes. Read-only.
 */

import type { Diagnostic } from "./types";
import type {
  DoctorCategorySummary,
  DoctorSnapshot,
} from "./types";
import type { DoctorInput } from "./input";
import {
  computeOverall,
  countBySeverity,
  dedupeDiagnostics,
  sortDiagnostics,
} from "./severity";
import {
  coreRules,
  omoRules,
  configRules,
  schemaRules,
  promptRules,
  providerModelRules,
  type RuleContext,
} from "./rules-core";
import {
  agentRules,
  capabilityRules,
  councilRules,
  acpRules,
  companionRules,
  interviewRules,
  sessionRules,
  revisionSecurityRules,
  telemetryRules,
  multiplexerRules,
  bridgeLifecycleRules,
} from "./rules-groups";
import { computeModelHealth, modelProbeRules } from "./rules-models";
import type { DiagnosticCategory } from "./types";

export interface DoctorInputProvider {
  (): DoctorInput;
}

export class DoctorEngine {
  private snapshot: DoctorSnapshot | null = null;
  private lastInputGeneration = "";

  constructor(private provide: DoctorInputProvider) {}

  private generation(input: DoctorInput): string {
    return [
      input.generatedAt,
      input.cp.configGeneration,
      input.connection.lastEventAt ?? "",
      input.connection.lastReconcileAt ?? "",
      input.revisions.count ?? "",
    ].join("|");
  }

  evaluate(input: DoctorInput): DoctorSnapshot {
    const ctx: RuleContext = {
      openCodeUp: input.lifecycle.status === "connected" && !!input.health.healthy,
      lifecycleReady: input.lifecycle.status === "connected",
      lifecyclePending: [
        "initializing",
        "starting",
        "waiting-health",
        "waiting-runtime",
        "restarting",
      ].includes(input.lifecycle.status),
      configOk: input.config.loadOk,
      nowMs: Date.now(),
    };

    const diagnostics: Diagnostic[] = [
      ...coreRules(input, ctx),
      ...omoRules(input, ctx),
      ...configRules(input, ctx),
      ...schemaRules(input, ctx),
      ...providerModelRules(input, ctx),
      ...modelProbeRules(input, ctx),
      ...agentRules(input, ctx),
      ...promptRules(input, ctx),
      ...capabilityRules(input, ctx),
      ...councilRules(input, ctx),
      ...acpRules(input, ctx),
      ...companionRules(input, ctx),
      ...interviewRules(input, ctx),
      ...sessionRules(input, ctx),
      ...revisionSecurityRules(input, ctx),
      ...telemetryRules(input, ctx),
      ...multiplexerRules(input, ctx),
      ...bridgeLifecycleRules(input, ctx),
    ];

    const sorted = sortDiagnostics(dedupeDiagnostics(diagnostics));
    const counts = countBySeverity(sorted);
    const categories = summarizeCategories(sorted);

    return {
      generatedAt: input.generatedAt,
      overall: computeOverall(sorted),
      counts,
      categories,
      diagnostics: sorted,
      ...(input.modelInventory
        ? { modelHealth: computeModelHealth(input.modelInventory.models) }
        : {}),
      system: {
        openCodeVersion: input.health.version,
        omoPackageVersion: input.packageHint?.match(/@(.*)$/)?.[1]?.replace(/^\^/, ""),
        omoManifestVersion: input.omoManifestVersion,
        activeConfiguredPreset: input.provenance?.preset,
        runtimePresetKnown: input.provenance?.runtimePreset?.known ?? false,
        configGeneration: input.cp.configGeneration,
        runtimeStale: input.connection.stale,
        lastEventAt: input.connection.lastEventAt,
        lastReconcileAt: input.connection.lastReconcileAt,
        backendMode: input.lifecycle.mode,
        backendOwnership: input.lifecycle.ownership,
        backendStatus: input.lifecycle.status,
        backendGeneration: input.lifecycle.generation,
      },
    };
  }

  getSnapshot(force = false): DoctorSnapshot {
    const input = this.provide();
    const gen = this.generation(input);
    if (!force && this.snapshot && gen === this.lastInputGeneration) {
      return this.snapshot;
    }
    const snap = this.evaluate(input);
    // Keep deterministic generatedAt from input; don't churn the timestamp on cache hits
    this.snapshot = snap;
    this.lastInputGeneration = gen;
    return snap;
  }

  invalidate(): void {
    this.snapshot = null;
    this.lastInputGeneration = "";
  }
}

function summarizeCategories(d: Diagnostic[]): DoctorCategorySummary[] {
  const map = new Map<DiagnosticCategory, DoctorCategorySummary>();
  for (const item of d) {
    let s = map.get(item.category);
    if (!s) {
      s = {
        category: item.category,
        healthy: 0,
        info: 0,
        warning: 0,
        error: 0,
        unknown: 0,
      };
      map.set(item.category, s);
    }
    s[item.severity]++;
  }
  return [...map.values()].sort((a, b) => a.category.localeCompare(b.category));
}
