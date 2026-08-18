/**
 * Agent, capability, council, ACP, revision, security, session rules.
 */

import type { Diagnostic, DiagnosticSeverity } from "./types";
import type { DoctorInput } from "./input";
import type { RuleContext } from "./rules-core";
import { PROTECTED_AGENTS, DEFAULT_DISABLED_AGENTS } from "../omo/catalog";
import { OMO_TELEMETRY_ACCEPTED_SCHEMA_VERSIONS, OMO_TELEMETRY_SCHEMA_VERSION } from "../omo-runtime/types";
import type { TelemetryBridgeStatusDto } from "@omo/shared";

function d(partial: Omit<Diagnostic, never>): Diagnostic {
  return partial;
}

export function agentRules(input: DoctorInput, ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const p = input.provenance;
  if (!ctx.configOk || !p) return out;

  const liveByName = new Map(input.agents.map((a) => [a.name, a]));

  for (const agent of Object.values(p.agents)) {
    const live = liveByName.get(agent.name);
    const isDefaultDisabled =
      !p.rawMerged.disabled_agents && DEFAULT_DISABLED_AGENTS.includes(agent.name);

    if (PROTECTED_AGENTS.has(agent.name) && !agent.enabled) {
      out.push(d({
        id: `agent.${agent.name}.protected-disabled`,
        category: "agents",
        severity: "error",
        title: `${agent.name} disabled but protected`,
        summary: `Protected agent ${agent.name} must not be disabled.`,
        remediation: { action: "navigate", target: "/agents", label: "Open Agents" },
      }));
    }

    if (isDefaultDisabled) {
      out.push(d({
        id: `agent.${agent.name}.default-disabled`,
        category: "agents",
        severity: "info",
        title: `${agent.name} disabled by built-in default`,
        summary: `${agent.name} in DEFAULT_DISABLED_AGENTS. Enable requires removing from disabled_agents + configuring a model.`,
        desired: { enabled: false },
      }));
      continue;
    }

    if (agent.enabled && ctx.lifecycleReady && !live && agent.kind !== "custom") {
      if (agent.name === "observer") continue;
      out.push(d({
        id: `agent.${agent.name}.missing-live`,
        category: "agents",
        severity: "warning",
        title: `${agent.name} enabled but not in /agent`,
        summary: `Effective-enabled OMO agent ${agent.name} is not registered in OpenCode live agents.`,
        live: { registered: false },
        evidence: [{ label: "GET /agent", kind: "rest-endpoint" }],
        remediation: { action: "navigate", target: "/agents", label: "Open Agents" },
      }));
    }

    // model drift: effective vs live registered agent
    if (agent.enabled && live?.model) {
      const liveModel = `${live.model.providerID}/${live.model.modelID}`;
      const effModel = agent.modelPrimary;
      if (effModel && liveModel !== effModel) {
        out.push(d({
          id: `agent.${agent.name}.model-drift`,
          category: "agents",
          severity: input.connection.stale ? "unknown" : "warning",
          title: `${agent.name} live model differs from effective`,
          summary: input.connection.stale
            ? `Live differs from effective but runtime is stale — cannot qualify.`
            : `Live ${liveModel} vs effective ${effModel}. Cause unknown (not inferred as fallback).`,
          effective: { model: effModel, variant: agent.variant },
          live: { model: liveModel, variant: live.variant },
          evidence: [
            { label: `resolved agents.${agent.name}.model`, kind: "resolved-property" },
            { label: "GET /agent", kind: "rest-endpoint" },
          ],
          relatedDiagnosticIds: ["runtime.staleness"],
          remediation: { action: "navigate", target: "/agents", label: "Open Agents" },
        }));
      }
    }
  }

  return out;
}

export function capabilityRules(input: DoctorInput, ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (!ctx.lifecycleReady) return out;
  const cap = input.capabilities;
  if (!cap) return out;

  // MCP: allowed but disconnected
  for (const a of cap.agents) {
    for (const mcp of a.mcps.allowed) {
      const rt = cap.mcps.find((m) => m.name === mcp);
      if (rt && rt.runtimeStatus !== "connected") {
        out.push(d({
          id: `caps.${a.agent}.mcp.${mcp}.disconnected`,
          category: "mcp",
          severity: "warning",
          title: `${mcp} allowed for ${a.agent} but not connected`,
          summary: `Agent ${a.agent} has effective MCP access to ${mcp}; OpenCode MCP status: ${rt.runtimeStatus ?? "unknown"}.`,
          live: { status: rt.runtimeStatus },
          evidence: [{ label: "GET /mcp", kind: "rest-endpoint", value: rt.runtimeStatus }],
          remediation: { action: "navigate", target: "/capabilities", label: "Open Capabilities" },
        }));
      }
    }
  }

  // globally disabled but agent-allowed
  for (const a of cap.agents) {
    for (const mcp of a.mcps.globallyDisabled) {
      const wouldAllow = (cap.mcps.some((m) => m.name === mcp) &&
        (a.mcps.configured ?? []).some((x) => x === mcp || x === "*"));
      if (wouldAllow) {
        out.push(d({
          id: `caps.${a.agent}.mcp.${mcp}.global-disabled`,
          category: "capabilities",
          severity: "info",
          title: `${mcp} globally disabled`,
          summary: `${a.agent} expression would allow ${mcp}; disabled_mcps wins.`,
          remediation: { action: "navigate", target: "/system", label: "Open System" },
        }));
      }
    }
    for (const s of a.skills.configuredUnknown) {
      out.push(d({
        id: `caps.${a.agent}.skill.${s}.unknown`,
        category: "capabilities",
        severity: "info",
        title: `${a.agent} configures undiscovered skill "${s}"`,
        summary: `Configured but not discovered via /skill or skill dirs. Raw config preserved.`,
        remediation: { action: "navigate", target: "/capabilities", label: "Open Capabilities" },
      }));
    }
  }

  return out;
}

export function councilRules(input: DoctorInput, ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const c = input.council;
  if (!c) return out;

  if (c.defaultMissing) {
    out.push(d({
      id: "council.default-missing",
      category: "council",
      severity: "error",
      title: "Default councillor preset missing",
      summary: `default_preset "${c.default_preset}" has no matching configured preset.`,
      effective: { default: c.default_preset },
      remediation: { action: "navigate", target: "/council", label: "Open Council" },
    }));
  }

  for (const w of c.warnings) {
    out.push(d({
      id: `council.warn.${w.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}`,
      category: "council",
      severity: "warning",
      title: "Council warning",
      summary: w,
      remediation: { action: "navigate", target: "/council", label: "Open Council" },
    }));
  }

  for (const def of c.deprecated) {
    out.push(d({
      id: `council.legacy.${def.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}`,
      category: "council",
      severity: "info",
      title: "Legacy council field",
      summary: def,
    }));
  }

  return out;
}

export function acpRules(input: DoctorInput, ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const acp = input.acp;
  if (!acp) return out;

  for (const a of acp.agents) {
    if (!a.command) {
      out.push(d({
        id: `acp.${a.name}.missing-command`,
        category: "acp",
        severity: "error",
        title: `${a.name} missing command`,
        summary: `ACP agent ${a.name} has no required command.`,
        remediation: { action: "navigate", target: "/acp", label: "Open ACP" },
      }));
      continue;
    }

    if (a.commandResolution?.status === "not-resolved") {
      out.push(d({
        id: `acp.${a.name}.command-unresolved`,
        category: "acp",
        severity: "warning",
        title: `${a.name} command not resolvable`,
        summary: `Cannot resolve "${a.command}" in control-plane environment. May still run on OMO host.`,
        remediation: { action: "navigate", target: "/acp", label: "Open ACP" },
      }));
    }

    if (a.cwdAuthorized === false) {
      out.push(d({
        id: `acp.${a.name}.cwd-outer-scope`,
        category: "acp",
        severity: "info",
        title: `${a.name} cwd outside scope`,
        summary: `Working directory outside authorized control-plane scope — not inspected.`,
        remediation: { action: "navigate", target: "/acp", label: "Open ACP" },
      }));
    }

    if (a.disabled) {
      out.push(d({
        id: `acp.${a.name}.disabled`,
        category: "acp",
        severity: "info",
        title: `${a.name} in disabled_agents`,
        summary: `ACP agent present in config but disabled.`,
      }));
    }
  }

  return out;
}

export function companionRules(input: DoctorInput, _ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const c = input.companion;
  if (!c) return out;

  if (!c.effective.enabled) {
    out.push(d({
      id: "companion.disabled",
      category: "companion",
      severity: "healthy",
      title: "Companion disabled",
      summary: "Companion enabled !== true — no binary launch (external native binary subsystem idle).",
      effective: { enabled: false },
    }));
  } else if (c.binary.withinAuthorizedScope && c.binary.inspected && c.binary.exists === false) {
    out.push(d({
      id: "companion.enabled",
      category: "companion",
      severity: "warning",
      title: "Companion enabled but binary not found",
      summary: `Companion enabled but binary missing at ${c.binary.resolutionSource} path ${c.binary.configuredPath ?? c.binary.defaultPath}. OMO logs and no-ops; install the companion binary or fix binaryPath.`,
      effective: { enabled: true, binary: c.binary },
      evidence: [{ label: "existsSync probe (installed OMO behavior)", kind: "observation", value: String(c.binary.exists) }],
    }));
  } else if (!c.binary.withinAuthorizedScope) {
    out.push(d({
      id: "companion.enabled",
      category: "companion",
      severity: "info",
      title: "Companion binary outside authorized scope",
      summary: `Companion enabled; binary path ${c.binary.configuredPath ?? c.binary.defaultPath} is outside authorized control-plane scope — executable validation not performed.`,
      effective: { enabled: true, binary: c.binary },
    }));
  } else {
    out.push(d({
      id: "companion.enabled",
      category: "companion",
      severity: "healthy",
      title: "Companion enabled",
      summary: `Companion enabled; binary found at ${c.binary.configuredPath ?? c.binary.defaultPath}. Launch state itself is not observable via OpenCode APIs.`,
      effective: { enabled: true, binary: c.binary },
    }));
  }

  if (c.desired) {
    for (const key of Object.keys(c.desired)) {
      if (!(key in c.fields)) {
        out.push(d({
          id: `companion.unknown-field.${key.replace(/[^a-z0-9]+/gi, "-")}`,
          category: "companion",
          severity: "info",
          title: `Unknown companion field "${key}"`,
          summary: "Raw key preserved but unsupported by installed CompanionConfigSchema; stripped by OMO zod (schema not strict).",
          desired: { [key]: c.desired[key] },
        }));
      }
    }
    for (const f of ["position", "size", "gifPack", "loopStyle"] as const) {
      const spec = c.fields[f];
      const v = c.desired[f];
      if (
        v !== undefined &&
        spec?.enumValues &&
        !(typeof v === "string" && spec.enumValues.includes(v))
      ) {
        out.push(d({
          id: `companion.invalid-enum.${f}`,
          category: "companion",
          severity: "warning",
          title: `companion.${f} outside enum`,
          summary: `companion.${f}=${JSON.stringify(v)} not in [${spec.enumValues.join(", ")}]; value ignored; effective = ${JSON.stringify(spec.defaultValue)}.`,
          desired: { [f]: v },
          effective: { [f]: spec.defaultValue },
        }));
      }
    }
  }

  return out;
}

export function interviewRules(input: DoctorInput, _ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const iv = input.interview;
  if (!iv) return out;

  if (iv.warnings.length === 0) {
    out.push(d({
      id: "interview.valid",
      category: "interview",
      severity: "healthy",
      title: "Interview config valid",
      summary: `Interview configuration valid (${iv.server.mode} mode, bind ${iv.server.bindHost}). Invocation via /interview command; runtime state not observable.`,
      effective: iv.effective,
    }));
  } else {
    for (const w of iv.warnings) {
      const field = (w.match(/^interview\.([A-Za-z]+)/) ?? [])[1];
      const issuePath = field ? `interview.${field}` : "interview";
      const winner = field
        ? iv.properties[`interview.${field}`]?.winner.stage
        : undefined;
      const sourceId =
        winner === "project-config" ? "project-omo" : "user-omo";
      out.push(d({
        id: `interview.invalid-field.${w.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}`,
        category: "interview",
        severity: "warning",
        title: "Interview field warning",
        summary: w,
        sourceId,
        issuePath,
        remediation: {
          action: "navigate",
          target: `/config?tab=raw&sourceId=${sourceId}&path=${encodeURIComponent(issuePath)}`,
          label: "Open Interview field in Raw",
        },
      }));
    }
  }

  if (iv.desired) {
    for (const key of Object.keys(iv.desired)) {
      if (!(key in iv.fields)) {
        out.push(d({
          id: `interview.unknown-field.${key.replace(/[^a-z0-9]+/gi, "-")}`,
          category: "interview",
          severity: "info",
          title: `Unknown interview field "${key}"`,
          summary: "Raw key preserved but unsupported by installed InterviewConfigSchema; stripped by OMO zod (schema not strict).",
          desired: { [key]: iv.desired[key] },
        }));
      }
    }
  }

  if (!iv.output.withinAuthorizedScope) {
    out.push(d({
      id: "interview.output-scope",
      category: "interview",
      severity: "info",
      title: "Interview output outside authorized scope",
      summary: `Interview output folder ${iv.output.resolvedPath} resolves outside authorized control-plane scope; not inspected.`,
      effective: { output: iv.output },
    }));
  }

  return out;
}

export function sessionRules(input: DoctorInput, ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (!ctx.lifecycleReady) return out;

  const byStatus = new Map<string, number>();
  for (const s of input.sessions) {
    const st = s.status ?? "idle";
    byStatus.set(st, (byStatus.get(st) ?? 0) + 1);
  }

  out.push(d({
    id: "sessions.summary",
    category: "sessions",
    severity: "healthy",
    title: "Sessions",
    summary: `${input.sessions.length} sessions (${[...byStatus.entries()].map(([k, v]) => `${k}:${v}`).join(" ") || "none active"}).`,
    live: Object.fromEntries(byStatus),
  }));

  const errored = input.sessions.filter((s) => s.status === "error");
  if (errored.length) {
    out.push(d({
      id: "sessions.active-errors",
      category: "sessions",
      severity: "warning",
      title: `${errored.length} session(s) currently error`,
      summary: `${errored.slice(0, 5).map((s) => `${s.agent ?? "?"}`).join(", ")}${errored.length > 5 ? "…" : ""} in error state.`,
      live: errored.slice(0, 10).map((s) => ({ id: s.id, agent: s.agent })),
      remediation: { action: "navigate", target: "/sessions", label: "Open Sessions" },
    }));
  }

  for (const perm of input.permissions.slice(0, 5)) {
    out.push(d({
      id: `sessions.permission.${perm.id}`,
      category: "sessions",
      severity: "warning",
      title: `Outstanding permission: ${perm.permission ?? perm.id}`,
      summary: `${perm.sessionID ?? "?"} waiting: ${perm.permission ?? "?"} ${(perm.patterns ?? []).join(" ")}`,
      live: perm,
      remediation: { action: "navigate", target: "/sessions", label: "Open Sessions" },
    }));
  }

  return out;
}

export function revisionSecurityRules(input: DoctorInput, _ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];

  out.push(d({
    id: "revisions.reachable",
    category: "revisions",
    severity: input.revisions.reachable ? "healthy" : "error",
    title: "Revision system",
    summary: input.revisions.reachable
      ? `${input.revisions.count ?? 0} revisions recorded.`
      : "Revision DB unavailable — mutation safety degraded.",
    desired: { count: input.revisions.count },
  }));

  for (const scope of input.revisions.conflictScopes ?? []) {
    const sourceId = scope === "user" ? "user-omo" : "project-omo";
    out.push(d({
      id: `revisions.conflict.${scope}`,
      category: "revisions",
      severity: "error",
      title: "Pending revision conflict",
      summary: `A recovered pending ${scope} OMO revision diverged from the current source. Writes for that source are blocked until the conflict is inspected.`,
      sourceId,
      remediation: {
        action: "navigate",
        target: `/config?tab=revisions&sourceId=${sourceId}`,
        label: "Open revisions",
      },
    }));
  }

  const host = input.environment.OMO_CP_HOST;
  const loopback = ["127.0.0.1", "localhost", "::1", ""].includes(host);
  out.push(d({
    id: "security.bind-address",
    category: "security",
    severity: loopback ? "healthy" : "warning",
    title: "Control-plane bind address",
    summary: loopback
      ? "Listening on loopback only."
      : `Listening on ${host} — broader than localhost. Review exposure before config-write features.`,
    live: { host },
  }));

  return out;
}

export function blockageDiagnostic(category: Diagnostic["category"], reason: string): Diagnostic {
  return {
    id: `blocked.${category}`,
    category,
    severity: "unknown",
    title: `${category} not evaluated`,
    summary: reason,
    evidence: [{ label: "Blocked by prerequisite", kind: "limitation" }],
  };
}

// ── OMO runtime telemetry rules ────────────────────────────────────────────
// Conservative by construction:
// - absent omoTelemetry input → NO diagnostics (never guess);
// - info severities (bridge-down, job-errors, stale, no-activity) never
//   degrade overall health (severity.ts computeOverall);
// - only bridge-schema and job-orphan (plus OMO-declared job-timeout) may
//   warn; orphan warns only after the child session has been absent longer
//   than the grace window.

/** Orphan grace window: child must be absent longer before warning. */
export const TELEMETRY_ORPHAN_GRACE_MS = 60_000;
/** Job errors newer than this are reported as info by telemetry.job-error. */
export const TELEMETRY_ERROR_WINDOW_MS = 30 * 60_000;

export function telemetryRules(input: DoctorInput, ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const t = input.omoTelemetry;
  if (!t) return out; // telemetry unavailable → stay silent (conservative)

  // telemetry.activity — healthy with activity, info without.
  out.push(d({
    id: "telemetry.activity",
    category: "telemetry",
    severity: t.jobCount > 0 ? "healthy" : "info",
    title: t.jobCount > 0 ? "OMO job activity observed" : "No OMO job activity",
    summary:
      t.jobCount > 0
        ? `${t.jobCount} OMO background-job record(s) derived from persisted task tool parts.`
        : "No OMO task tool activity found in scanned sessions (nothing launched or persisted yet).",
    live: { jobCount: t.jobCount },
    evidence: [{ label: "GET /api/omo/runtime", kind: "rest-endpoint" }],
  }));

  // telemetry.bridge-down — info ONLY when configured but unreachable.
  // Unconfigured bridge is the normal default and produces nothing.
  if (t.bridgeConfigured && !t.bridgeConnected) {
    out.push(d({
      id: "telemetry.bridge-down",
      category: "telemetry",
      severity: "info",
      title: "OMO telemetry bridge configured but not reachable",
      summary:
        "Managed registration or explicit override endpoint is unreachable while derived jobs remain live. OMO globalThis stores unavailable; job telemetry from OpenCode messages still works.",
      evidence: [{ label: "GET /telemetry (bridge)", kind: "rest-endpoint" }],
    }));
  }

  // telemetry.bridge-schema — warning when the bridge reports a schema
  // version this server does not understand. Schemas 1, 2, and 3 are all
  // accepted (v3 is the current authoritative schema; v1/v2 are legacy
  // display-only).
  if (
    t.bridgeSchema !== undefined &&
    !OMO_TELEMETRY_ACCEPTED_SCHEMA_VERSIONS.has(t.bridgeSchema)
  ) {
    out.push(d({
      id: "telemetry.bridge-schema",
      category: "telemetry",
      severity: "warning",
      title: `Telemetry bridge schema v${t.bridgeSchema} not supported`,
      summary: `Bridge answered telemetrySchemaVersion ${t.bridgeSchema}; this server understands ${[...OMO_TELEMETRY_ACCEPTED_SCHEMA_VERSIONS].join(", ")}. Store fields may be dropped. Update the control plane or the bridge plugin.`,
      desired: { telemetrySchemaVersion: OMO_TELEMETRY_SCHEMA_VERSION },
      live: { telemetrySchemaVersion: t.bridgeSchema },
    }));
  }

  // telemetry.job-orphan — warning only after the child session has been
  // absent longer than the grace window (timestamps provided by the input;
  // unknown timestamps never warn).
  for (const taskId of t.orphanJobs) {
    const since = t.orphanMissingSince?.[taskId];
    if (since === undefined) continue;
    if (ctx.nowMs - since <= TELEMETRY_ORPHAN_GRACE_MS) continue;
    out.push(d({
      id: `telemetry.job-orphan.${taskId}`,
      category: "telemetry",
      severity: "warning",
      title: `OMO job ${taskId} has no child session`,
      summary: `Job ${taskId} references child session that has been absent from OpenCode for >${Math.round(TELEMETRY_ORPHAN_GRACE_MS / 1000)}s. The session may have been deleted; the record is kept until the 6h prune window.`,
      entityId: taskId,
      live: { missingSince: since },
      remediation: { action: "navigate", target: "/sessions", label: "Open Sessions" },
    }));
  }

  // telemetry.job-timeout — warning, ONLY for OMO-declared timedOut
  // ("Timed out after Nms" in status output, dist/index.js:24972).
  for (const taskId of t.timedOutJobs) {
    out.push(d({
      id: `telemetry.job-timeout.${taskId}`,
      category: "telemetry",
      severity: "warning",
      title: `OMO job ${taskId} timed out (OMO-declared)`,
      summary: `OMO reported "Timed out after …ms" for job ${taskId} while still in state running. The lane may still complete; OMO reuse gating is not replicated here.`,
      entityId: taskId,
      evidence: [{ label: "task status output", kind: "observation", value: "Timed out after Nms (dist/index.js:24972)" }],
    }));
  }

  // telemetry.job-error — info for errors within the recent window
  // (window applied by the input provider; info never degrades).
  if (t.recentErrors.length > 0) {
    out.push(d({
      id: "telemetry.job-errors",
      category: "telemetry",
      severity: "info",
      title: `${t.recentErrors.length} OMO job error(s) in the last 30 minutes`,
      summary: `Errored jobs: ${t.recentErrors.slice(0, 10).join(", ")}${t.recentErrors.length > 10 ? "…" : ""}. Inspect via GET /api/omo/jobs/:id.`,
      live: { recentErrors: t.recentErrors.slice(0, 20) },
    }));
  }

  // telemetry.stale — info when the telemetry snapshot is stale.
  if (t.stale) {
    out.push(d({
      id: "telemetry.stale",
      category: "telemetry",
      severity: "info",
      title: "OMO runtime telemetry stale",
      summary: "OpenCode connection for telemetry is degraded (rest+sse disconnected); job records reflect the last successful scan.",
      relatedDiagnosticIds: ["runtime.staleness"],
    }));
  }

  return out;
}

// ── Multiplexer rules (Slice 16) ───────────────────────────────────────────
// Conservative by design:
// - explicit backend command missing → warning;
// - configured/detected drift → info only if runtime detected authoritative;
// - missing bridge/runtime unavailable → no warning;
// - auto→none healthy/info; none healthy;
// - legacy modern conflict info/warning based exact ignored behavior;
// - missing mapping after grace warning only when authoritative.
// - Avoid warning for unobservable runtime.

export function multiplexerRules(input: DoctorInput, _ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const m = input.multiplexer;
  if (!m) return out; // multiplexer unavailable → stay silent (conservative)

  // multiplexer.explicit-backend-command-missing — warning
  if (m.explicitBackendCommandMissing) {
    out.push(d({
      id: "multiplexer.explicit-backend-command-missing",
      category: "agents",
      severity: "warning",
      title: "Configured multiplexer backend command not resolvable",
      summary: `multiplexer.type="${m.effectiveType}" but the backend command was not resolvable via command -v in the control-plane environment. May still run on the OMO host.`,
      desired: { type: m.configuredType },
      effective: { type: m.effectiveType },
      remediation: { action: "navigate", target: "/system", label: "Open System" },
    }));
  }

  // multiplexer.legacy-tmux — info (ignored, not alarming)
  if (m.legacyTmuxPresent) {
    out.push(d({
      id: "multiplexer.legacy-tmux-ignored",
      category: "agents",
      severity: "info",
      title: "Legacy top-level tmux config ignored",
      summary: "Legacy top-level tmux key present and ignored by OMO. Use multiplexer config instead (dist/index.js:18901-18911).",
      remediation: { action: "navigate", target: "/system", label: "Open System" },
    }));
  }

  // multiplexer.none — healthy
  if (m.effectiveType === "none") {
    out.push(d({
      id: "multiplexer.none",
      category: "agents",
      severity: "healthy",
      title: "Multiplexer disabled (none)",
      summary: "multiplexer.type=none — no external multiplexer backend in use.",
      effective: { type: "none" },
    }));
  }

  // multiplexer.auto-none — healthy/info (auto resolved to none)
  if (m.configuredType === "auto" && m.detectedType === null) {
    out.push(d({
      id: "multiplexer.auto-none",
      category: "agents",
      severity: "info",
      title: "Multiplexer auto detected no session",
      summary: "multiplexer.type=auto but no multiplexer environment signals detected; OMO disables the multiplexer at plugin init (dist/index.js:35570-35572).",
      desired: { type: "auto" },
      effective: { type: "auto" },
      live: { detectedType: null },
    }));
  }

  // multiplexer.auto-detected — healthy when auto detected a backend
  if (m.configuredType === "auto" && m.detectedType !== null) {
    out.push(d({
      id: "multiplexer.auto-detected",
      category: "agents",
      severity: "healthy",
      title: `Multiplexer auto detected ${m.detectedType}`,
      summary: `multiplexer.type=auto detected "${m.detectedType}" from environment signals. OMO resolves the concrete backend at plugin init.`,
      desired: { type: "auto" },
      effective: { type: "auto" },
      live: { detectedType: m.detectedType },
    }));
  }

  // multiplexer.missing-mapping-after-grace — warning only when authoritative
  // (runtime available + not stale + grace applied)
  if (m.graceApplied && m.unmappedJobsAfterGrace.length > 0) {
    out.push(d({
      id: "multiplexer.missing-mapping-after-grace",
      category: "agents",
      severity: "warning",
      title: `${m.unmappedJobsAfterGrace.length} OMO job(s) have no multiplexer session mapping`,
      summary: `Jobs ${m.unmappedJobsAfterGrace.slice(0, 10).join(", ")}${m.unmappedJobsAfterGrace.length > 10 ? "…" : ""} have no multiplexer session record after the 60s reconciliation grace. The multiplexer may not be enabled, or the sessions were created before the multiplexer manager started.`,
      remediation: { action: "navigate", target: "/sessions", label: "Open Sessions" },
    }));
  }

  // multiplexer.runtime-unavailable — no warning (conservative; unobservable)
  // Intentionally no diagnostic for runtimeUnavailable to avoid warning for
  // unobservable runtime.

  return out;
}

// ── Telemetry bridge lifecycle rules (Slice 17) ────────────────────────────
//
// Policy (requirement 11):
// - unconfigured neutral (no diagnostic);
// - source unproven/override unmanaged informational;
// - invalid override warning;
// - registered-awaiting-restart informational;
// - configured/unreachable informational;
// - schema/identity mismatch warning;
// - duplicate registration warning;
// - bridge absence never degrades derived jobs;
// - deep bridge disconnected distinct from derived OMO telemetry.
// - Link to System telemetry section.
//
// Conservative by construction: absent bridgeStatus input → NO diagnostics.
// Info severities never degrade overall health.

export function bridgeLifecycleRules(input: DoctorInput, _ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const b = input.bridgeStatus;
  if (!b) return out; // bridge status unavailable → stay silent (conservative)

  // bridge.unconfigured — neutral (no diagnostic). Override absent + no
  // committed desired state + not registered → neutral, no diagnostic.

  // bridge.override-invalid — warning (invalid OMO_BRIDGE_BASE_URL).
  if (b.override.present && b.override.invalid) {
    out.push(d({
      id: "bridge.override-invalid",
      category: "telemetry",
      severity: "warning",
      title: "Invalid OMO_BRIDGE_BASE_URL override",
      summary: `OMO_BRIDGE_BASE_URL is set but invalid: ${b.override.invalidReason ?? "validation failed"}. The override is ignored; no network request is made. Fix or unset the override.`,
      effective: { override: b.override },
      remediation: { action: "navigate", target: "/system", label: "Open System" },
    }));
  }

  // bridge.override-unmanaged — informational (valid override opts out of management).
  if (b.override.present && !b.override.invalid && b.override.optsOutOfManagement) {
    out.push(d({
      id: "bridge.override-unmanaged",
      category: "telemetry",
      severity: "info",
      title: "Telemetry bridge override active (unmanaged)",
      summary: "OMO_BRIDGE_BASE_URL override is active. The bridge is observed but not managed by the control plane. Registration preview/apply are disabled.",
      effective: { override: b.override },
      remediation: { action: "navigate", target: "/system", label: "Open System" },
    }));
  }

  // bridge.source-unproven — informational (source not proven/absent).
  if (b.source && b.source.schemaGateMode === "blocked") {
    out.push(d({
      id: "bridge.source-unproven",
      category: "telemetry",
      severity: "info",
      title: "Telemetry bridge source not proven",
      summary: "The OpenCode config source could not be proven. Bridge management actions are blocked until the source is resolvable.",
      effective: { source: b.source },
      remediation: { action: "navigate", target: "/system", label: "Open System" },
    }));
  }

  // bridge.registered-awaiting-restart — informational.
  // Committed enabled state but runtime not active → restart required.
  if (b.restartRequired && b.desired?.enabled && b.desired.stateDisposition === "committed") {
    out.push(d({
      id: "bridge.registered-awaiting-restart",
      category: "telemetry",
      severity: "info",
      title: "Telemetry bridge registered, awaiting restart",
      summary: "The bridge plugin is registered in the OpenCode config but the runtime is not active. An explicit restart is required to activate the bridge.",
      effective: { runtime: b.runtime, desired: b.desired },
      remediation: { action: "navigate", target: "/system", label: "Open System" },
    }));
  }

  // bridge.configured-unreachable — informational.
  // Desired enabled + committed but runtime failed/unavailable.
  if (b.desired?.enabled && b.desired.stateDisposition === "committed" &&
      (b.runtime === "failed" || b.runtime === "unavailable")) {
    out.push(d({
      id: "bridge.configured-unreachable",
      category: "telemetry",
      severity: "info",
      title: "Telemetry bridge configured but unreachable",
      summary: "The bridge is committed in config but the bridge endpoint is unreachable. The bridge plugin may not be loaded, or the port differs.",
      effective: { runtime: b.runtime },
      remediation: { action: "navigate", target: "/system", label: "Open System" },
    }));
  }

  // bridge.schema-identity-mismatch — warning.
  // Compatibility incompatible → schema/identity mismatch.
  if (b.compatibility === "incompatible") {
    out.push(d({
      id: "bridge.schema-identity-mismatch",
      category: "telemetry",
      severity: "warning",
      title: "Telemetry bridge schema/identity mismatch",
      summary: "The bridge responded but its identity (fingerprint, origin, or schema version) does not match the committed activation state. The bridge may be stale or from a different generation.",
      effective: { compatibility: b.compatibility, runtime: b.runtime },
      ...(b.error !== undefined ? { evidence: [{ label: "verify reason", kind: "observation", value: b.error }] } : {}),
      remediation: { action: "navigate", target: "/system", label: "Open System" },
    }));
  }

  // bridge.duplicate-registration — warning.
  if (b.registration === "duplicate" || b.duplicates.inSource || b.duplicates.inEffective) {
    out.push(d({
      id: "bridge.duplicate-registration",
      category: "telemetry",
      severity: "warning",
      title: "Duplicate telemetry bridge registration",
      summary: "Multiple bridge plugin entries detected in the OpenCode config. Remove the duplicate entry to restore single-source management.",
      effective: { registration: b.registration, duplicates: b.duplicates },
      remediation: { action: "navigate", target: "/system", label: "Open System" },
    }));
  }

  // bridge.deep-disconnected — informational (distinct from derived OMO telemetry).
  // Bridge backend not connected, distinct from OMO job telemetry.
  if (!b.backendConnected && b.desired?.enabled && b.desired.stateDisposition === "committed") {
    out.push(d({
      id: "bridge.deep-disconnected",
      category: "telemetry",
      severity: "info",
      title: "Telemetry bridge backend disconnected",
      summary: "The telemetry bridge backend is disconnected. Deep bridge telemetry (stores, capabilities) is unavailable. Derived OMO job telemetry from OpenCode messages is unaffected and continues independently.",
      effective: { backendConnected: false, runtime: b.runtime },
      relatedDiagnosticIds: ["telemetry.activity"],
      remediation: { action: "navigate", target: "/system", label: "Open System" },
    }));
  }

  return out;
}
