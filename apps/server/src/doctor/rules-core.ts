/**
 * Rule groups. Each rule = pure function (input, ctx) → Diagnostic[].
 * Prerequisite-gated: when OpenCode REST is down, Live checks become "unknown".
 */

import type { Diagnostic, DiagnosticSeverity } from "./types";
import type { DoctorInput } from "./input";
import type { ProvenanceBundle } from "@omo/shared";
import { buildModelUsage } from "../models/usage";
import { splitModelKey } from "../models/constants";

export interface RuleContext {
  openCodeUp: boolean;
  lifecycleReady: boolean;
  lifecyclePending: boolean;
  configOk: boolean;
  nowMs: number;
}

const FRESH_WINDOW_MS = 60_000;
const STALE_WINDOW_MS = 3 * 60_000;

function d(
  partial: Omit<Diagnostic, "severity"> & { severity: DiagnosticSeverity },
): Diagnostic {
  return partial;
}

export function coreRules(input: DoctorInput, ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];

  out.push(d({
    id: "cp.revision-db",
    category: "control-plane",
    severity: input.cp.revisionDbOk ? "healthy" : "error",
    title: "Revision database",
    summary: input.cp.revisionDbOk
      ? "SQLite revision store accessible."
      : "Config write history unavailable — safe mutations would fail.",
    remediation: { action: "navigate", target: "/config", label: "Open Config" },
  }));

  const lifecycle = input.lifecycle;
  if (ctx.lifecyclePending) {
    out.push(d({
      id: "opencode.lifecycle",
      category: "opencode",
      severity: "info",
      title: `OpenCode ${lifecycle.status}`,
      summary: `${lifecycle.mode} mode · ${lifecycle.ownership} ownership · ${lifecycle.detail ?? "backend initialization in progress"}.`,
      live: { mode: lifecycle.mode, ownership: lifecycle.ownership, status: lifecycle.status, generation: lifecycle.generation },
    }));
  } else if (lifecycle.status === "failed") {
    const omoFailure = lifecycle.error?.code === "omo-registration-failed";
    out.push(d({
      id: omoFailure ? "omo.registration" : "opencode.lifecycle",
      category: omoFailure ? "omo" : "opencode",
      severity: "error",
      title: omoFailure
        ? "OMO registration failed"
        : lifecycle.mode === "managed"
          ? "Managed OpenCode failed"
          : "Attached OpenCode unavailable",
      summary: `${lifecycle.error?.message ?? "OpenCode lifecycle failed"}. ${lifecycle.error?.action ?? "Retry after correcting the backend."}`,
      live: { mode: lifecycle.mode, ownership: lifecycle.ownership, status: lifecycle.status, generation: lifecycle.generation },
      remediation: { action: "navigate", target: "/system", label: "Open System" },
    }));
  } else {
    out.push(d({
      id: "opencode.reachable",
      category: "opencode",
      severity: input.health.healthy ? "healthy" : "unknown",
      title: "OpenCode reachable",
      summary: input.health.healthy
        ? `OpenCode ${input.health.version ?? ""} responding (${lifecycle.mode}, ${lifecycle.ownership}).`
        : "OpenCode lifecycle is not active.",
      evidence: [{ label: "GET /global/health", kind: "rest-endpoint", value: JSON.stringify(input.health) }],
    }));
  }

  if (lifecycle.restart) {
    out.push(d({
      id: "opencode.restart",
      category: "opencode",
      severity: "info",
      title: "OpenCode restart scheduled",
      summary: `Attempt ${lifecycle.restart.attempt}/${lifecycle.restart.maxAttempts}${lifecycle.restart.nextRetryAt ? ` at ${lifecycle.restart.nextRetryAt}` : ""}.`,
      live: lifecycle.restart,
    }));
  }

  if (!ctx.lifecycleReady) return out;

  out.push(d({
    id: "runtime.staleness",
    category: "runtime",
    severity: !input.connection.stale ? "healthy" : input.connection.rest === "connected" ? "warning" : "error",
    title: "Runtime freshness",
    summary: !input.connection.stale
      ? "Live runtime synchronized via REST + SSE."
      : `Runtime may be stale (REST ${input.connection.rest}, SSE ${input.connection.sse}). Live diagnostics are qualified.`,
    live: {
      rest: input.connection.rest,
      sse: input.connection.sse,
      lastEventAt: input.connection.lastEventAt,
      lastReconcileAt: input.connection.lastReconcileAt,
    },
    evidence: [{ label: "RuntimeStore connection", kind: "runtime-store" }],
  }));

  if (input.connection.sse !== "connected" && input.connection.rest === "connected") {
    out.push(d({
      id: "runtime.sse-down",
      category: "runtime",
      severity: "warning",
      title: "OpenCode SSE disconnected",
      summary: "REST connected but event stream down. Live view updates on reconcile only.",
      remediation: { action: "navigate", target: "/system", label: "Open System" },
    }));
  }

  return out;
}

export function omoRules(input: DoctorInput, ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (!ctx.lifecycleReady) return out;

  const disabled = input.environment.OH_MY_OPENCODE_SLIM_DISABLE;
  const intentionallyDisabled =
    disabled !== undefined &&
    !["", "0", "false", "no", "off"].includes(disabled.trim().toLowerCase());
  if (intentionallyDisabled) {
    out.push(d({
      id: "omo.registration",
      category: "omo",
      severity: "info",
      title: "OMO registration intentionally disabled",
      summary: "OH_MY_OPENCODE_SLIM_DISABLE intentionally suppresses OMO registration; lifecycle readiness does not require OMO agents.",
      evidence: [{ label: "env OH_MY_OPENCODE_SLIM_DISABLE", kind: "observation" }],
    }));
    return out;
  }

  const names = new Set(input.agents.map((a) => a.name));
  const hasOrchestrator = names.has("orchestrator");
  const omoAgents = ["explorer", "librarian", "oracle", "designer", "fixer"].filter((n) => names.has(n));

  out.push(d({
    id: "omo.registration",
    category: "omo",
    severity: hasOrchestrator && omoAgents.length >= 3 ? "healthy" : "error",
    title: "OMO registration in OpenCode",
    summary:
      hasOrchestrator && omoAgents.length >= 3
        ? `OMO agents registered (${omoAgents.length + 1}+ specialist agents visible).`
        : `OMO agents not fully registered in /agent. Expected orchestrator + specialists.`,
    live: { orchestrator: hasOrchestrator, specialists: omoAgents },
    evidence: [{ label: "GET /agent", kind: "rest-endpoint" }],
  }));

  if (input.packageHint || input.omoManifestVersion) {
    const pkg = input.packageHint?.match(/@(.*)$/)?.[1];
    const manifest = input.omoManifestVersion;
    const same = pkg && manifest && pkg.replace(/^\^/, "") === manifest;
    out.push(d({
      id: "omo.version-skew",
      category: "version",
      severity: same || !pkg || !manifest ? "info" : "info",
      title: "OMO package / skills-manifest versions",
      summary: `package ${pkg ?? "?"} · skills manifest ${manifest ?? "?"}${same ? " — aligned" : " — metadata differs; no functional failure observed"}`,
      desired: { package: pkg, manifest },
    }));
  }

  return out;
}

export function schemaRules(input: DoctorInput, ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const s = input.schema;
  if (!s) return out; // composition failed → stay silent (conservative)
  const { status } = s;

  if (!status.available) {
    out.push(d({
      id: "config.schema",
      category: "config",
      severity: "warning",
      title: "Installed OMO-Slim schema unavailable",
      summary:
        `Cannot validate configuration against the installed oh-my-opencode-slim schema` +
        (status.error ? `: ${status.error}` : "") +
        ". All configuration writes are blocked (fail-closed); reads continue.",
      evidence: [{ label: "schema status", kind: "observation", value: status.error }],
      remediation: { action: "navigate", target: "/system?section=schema", label: "Open schema status" },
    }));
    return out;
  }

  if (status.userConfig.present && status.userConfig.valid === false) {
    const firstPath = status.userConfig.issues.find((i) => i.path)?.path ?? "";
    const listed = status.userConfig.issues
      .slice(0, 5)
      .map((i) => `${i.path ? `${i.path}: ` : ""}${i.message}`)
      .join(" · ");
    out.push(d({
      id: "config.schema",
      category: "config",
      severity: "error",
      title: "User OMO config rejected by installed schema",
      summary:
        `${status.userConfig.issues.length} schema issue(s): ${listed}` +
        (status.userConfig.issues.length > 5 ? " …" : "") +
        ". OMO-Slim may reject the complete configuration and fall back to defaults. " +
        "Repair via a schema-valid mutation or restore a valid revision.",
      desired: { issues: status.userConfig.issues.slice(0, 5) },
      evidence: [{ label: "installed schema", kind: "invariant", value: `oh-my-opencode-slim@${status.packageVersion ?? "?"}` }],
      sourceId: "user-omo",
      issuePath: firstPath,
      remediation: {
        action: "navigate",
        target: `/config?tab=raw&sourceId=user-omo&path=${encodeURIComponent(firstPath)}`,
        label: "Open Raw user source",
      },
    }));
  } else {
    out.push(d({
      id: "config.schema",
      category: "config",
      severity: "healthy",
      title: "Installed schema validation",
      summary:
        `User configuration validates against installed oh-my-opencode-slim@${status.packageVersion ?? "unknown"} schema.` +
        (status.userConfig.present ? "" : " (No user config file present.)"),
      evidence: [{ label: "schema hash", kind: "invariant", value: status.schemaHash?.slice(0, 12) }],
    }));
  }

  if (status.projectConfig.present && status.projectConfig.valid === false) {
    const firstPath = status.projectConfig.issues.find((i) => i.path)?.path ?? "";
    const listed = status.projectConfig.issues
      .slice(0, 5)
      .map((i) => `${i.path ? `${i.path}: ` : ""}${i.message}`)
      .join(" · ");
    out.push(d({
      id: "config.schema.project",
      category: "config",
      severity: "error",
      title: "Project OMO config rejected by installed schema",
      summary:
        `${status.projectConfig.issues.length} schema issue(s): ${listed}` +
        (status.projectConfig.issues.length > 5 ? " …" : "") +
        ". OMO-Slim may reject the complete configuration and fall back to defaults. " +
        "Repair via a schema-valid mutation or restore a valid revision.",
      sourceId: "project-omo",
      issuePath: firstPath,
      remediation: {
        action: "navigate",
        target: `/config?tab=raw&sourceId=project-omo&path=${encodeURIComponent(firstPath)}`,
        label: "Open Raw project source",
      },
    }));
  }

  if (s.revisionsIncompatible > 0) {
    out.push(d({
      id: "revisions.schema-incompat",
      category: "revisions",
      severity: "info",
      title: "Historical revisions incompatible with current schema",
      summary:
        `${s.revisionsIncompatible} historical revision(s) (of the latest ${s.revisionsScanned} scanned) ` +
        "contain configuration incompatible with the current installed schema; restore of those revisions will be blocked.",
      evidence: [{ label: "revision audit", kind: "observation", value: `scanned ${s.revisionsScanned}` }],
    }));
  }

  return out;
}

export function configRules(input: DoctorInput, ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (!input.config.loadOk) {
    out.push(d({
      id: "config.parse",
      category: "config",
      severity: "error",
      title: "Configuration resolution failed",
      summary: `OMO config resolver error: ${input.config.loadError ?? "unknown"}. Effective configuration cannot be computed.`,
      evidence: [{ label: "resolveProvenance", kind: "invariant", value: input.config.loadError }],
      remediation: { action: "navigate", target: "/config", label: "Open Config" },
    }));
    return out;
  }

  const p = input.provenance;
  if (!p) return out;

  out.push(d({
    id: "config.resolution",
    category: "config",
    severity: "healthy",
    title: "Configuration resolution",
    summary: `Desired→Effective resolved (${Object.keys(p.properties).length} properties).`,
  }));

  const userSource = p.sources.find((s) => s.kind === "user-omo");
  if (userSource) {
    out.push(d({
      id: "config.user-source",
      category: "config",
      severity: userSource.present ? "healthy" : "error",
      title: "User OMO config",
      summary: userSource.present
        ? `${userSource.path} loaded.`
        : "No user OMO config found.",
      sourcePaths: [userSource.path ?? ""],
      evidence: [{ label: "config source", kind: "config-source", value: userSource.detail }],
    }));
  }

  for (const w of p.warnings) {
    const sev: DiagnosticSeverity =
      w.level === "error" ? "error" : w.level === "warning" ? "warning" : "info";
    out.push(d({
      id: `config.warning.${w.kind}.${(w.path ?? "root").replace(/[^a-z0-9]+/gi, "-")}`,
      category: "config",
      severity: sev,
      title: w.kind,
      summary: w.message,
      sourcePaths: w.path ? [w.path] : [],
    }));
  }

  if (p.envPreset) {
    out.push(d({
      id: "config.env-preset-override",
      category: "config",
      severity: "info",
      title: "Environment preset override",
      summary: `OH_MY_OPENCODE_SLIM_PRESET="${p.envPreset}" masks configured preset${p.filePreset ? ` "${p.filePreset}"` : ""}.`,
      desired: { configured: p.filePreset },
      effective: { preset: p.preset },
      evidence: [{ label: "env OH_MY_OPENCODE_SLIM_PRESET", kind: "observation" }],
    }));
  }

  if (p.preset) {
    const names = collectPresetNames(p.properties);
    if (!names.has(p.preset)) {
      out.push(d({
        id: "config.active-preset-missing",
        category: "presets",
        severity: "error",
        title: "Active preset not found",
        summary: `Effective preset "${p.preset}" is not defined in presets.`,
        effective: { preset: p.preset },
        evidence: [{ label: "resolved preset", kind: "resolved-property" }],
        remediation: { action: "navigate", target: "/presets", label: "Open Presets" },
      }));
    }
  }

  return out;
}

function collectPresetNames(properties: ProvenanceBundle["properties"]): Set<string> {
  const names = new Set<string>();
  for (const key of Object.keys(properties)) {
    const m = key.match(/^presets\.([^..\[\]]+)\./);
    if (m) names.add(m[1]!);
  }
  return names;
}

export function promptRules(input: DoctorInput, ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const p = input.provenance;
  if (!ctx.configOk || !p) return out;

  for (const [agent, prompt] of Object.entries(p.prompts)) {
    for (const s of prompt.sources) {
      if (s.contentLength !== undefined && !s.applied && s.kind === "replacement-file") {
        out.push(d({
          id: `prompt.${agent}.shadowed-replacement`,
          category: "prompts",
          severity: "info",
          title: "Shadowed replacement prompt",
          summary: `${agent}: ${s.path} shadowed — ${s.reason ?? "inline prompt wins"}.`,
          sourcePaths: [s.path ?? ""],
          remediation: { action: "navigate", target: "/prompts", label: "Open Prompts" },
        }));
      }
    }
    for (const w of prompt.warnings) {
      const wid = w.replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
      out.push(d({
        id: `prompt.${agent}.warn.${wid}`,
        category: "prompts",
        severity: "info",
        title: "Prompt note",
        summary: w,
        remediation: { action: "navigate", target: "/prompts", label: "Open Prompts" },
      }));
    }
  }

  for (const [agent, detail] of Object.entries(p.prompts)) {
    void detail;
    void agent;
  }

  return out;
}

export function providerModelRules(input: DoctorInput, ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (!ctx.lifecycleReady) return out;
  const p = input.provenance;
  const connected = new Set(input.providers.filter((x) => x.connected).map((x) => x.id));

  // Usage correlation single-sourced from models/usage.ts (Slice 15).
  // Behavior-preserving mapping to the legacy provider→who enumeration:
  //  - agent PRIMARY refs of ENABLED agents → "agents.<name>" (+ " (disconnected)")
  //  - agent fallbacks are NOT part of this rule's historical enumeration
  //  - council refs of the default/effective preset → "council.<preset>.<member>"
  //  - acp refs of enabled wrappers → "acp.<name>"
  const usage = new Map<string, Set<string>>();
  const recordUse = (provider: string, who: string) => {
    if (!usage.has(provider)) usage.set(provider, new Set());
    usage.get(provider)!.add(who);
  };

  if (ctx.configOk && p) {
    const usageMap = buildModelUsage({
      agents: p.agents,
      ...(input.council ? { council: input.council } : {}),
      ...(input.acp ? { acp: input.acp } : {}),
    });
    for (const [key, refs] of usageMap) {
      const provider = splitModelKey(key).providerId;
      for (const ref of refs) {
        if (!ref.active) continue;
        if (ref.kind === "agent-primary") {
          recordUse(
            provider,
            `agents.${ref.ownerId}${!connected.has(provider) ? " (disconnected)" : ""}`,
          );
        } else if (ref.kind === "council-member" || ref.kind === "acp-wrapper") {
          recordUse(provider, ref.ownerId);
        }
        // agent-fallback: intentionally excluded (legacy rule scope).
      }
    }
  }

  for (const [provider, users] of usage) {
    const isConnected = connected.has(provider);
    if (!isConnected) {
      out.push(d({
        id: `provider.${provider}.disconnected-active`,
        category: "providers",
        severity: "warning",
        title: `Provider ${provider} disconnected — used by active configuration`,
        summary: `Active configuration references ${provider} (${[...users].slice(0, 4).join(", ")}${users.size > 4 ? `, +${users.size - 4} more` : ""}) but OpenCode reports it disconnected.`,
        evidence: [
          { label: "GET /config/providers", kind: "rest-endpoint", value: `${provider} not in connected set` },
        ],
        remediation: { action: "navigate", target: "/models", label: "Open Models" },
      }));
    }
  }

  return out;
}
