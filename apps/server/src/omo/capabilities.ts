/**
 * OMO skill/MCP list semantics + permission summary.
 * parseList verified from oh-my-opencode-slim dist:
 *
 * if empty → []
 * deny includes * → []
 * allow includes * → allAvailable - deny
 * else → allow ∩ allAvailable - deny
 *
 * Skill permissions (getSkillPermissionsForAgent): when skillList set,
 * start * = deny, then * / !name / name; disabled_skills forced deny.
 */

import type {
  AgentCapabilitySummary,
  AgentPermissionConfig,
  CapabilityInventory,
  ListExpressionSemantic,
  PermissionDecision,
  PermissionRule,
  ProvenanceBundle,
} from "@omo/shared";

export const KNOWN_TOOLS = [
  "read",
  "edit",
  "glob",
  "grep",
  "list",
  "bash",
  "task",
  "external_directory",
  "lsp",
  "skill",
  "todowrite",
  "question",
  "webfetch",
  "websearch",
  "codesearch",
  "doom_loop",
] as const;

/** Exact OMO parseList */
export function parseList(
  items: string[] | undefined | null,
  allAvailable: string[],
): string[] {
  if (!items || items.length === 0) return [];
  const allow = items.filter((i) => !i.startsWith("!"));
  const deny = items
    .filter((i) => i.startsWith("!"))
    .map((i) => i.slice(1));
  if (deny.includes("*")) return [];
  if (allow.includes("*")) {
    return allAvailable.filter((item) => !deny.includes(item));
  }
  return allow.filter(
    (item) => !deny.includes(item) && allAvailable.includes(item),
  );
}

export function interpretListExpression(
  configured: string[] | undefined,
  allAvailable: string[],
  globallyDisabled: string[],
): ListExpressionSemantic {
  const gdis = new Set(globallyDisabled);
  if (configured === undefined) {
    return {
      mode: "unset",
      allowed: [],
      denied: [...globallyDisabled],
      configuredUnknown: [],
      globallyDisabled: [...globallyDisabled],
    };
  }
  const allow = configured.filter((i) => !i.startsWith("!"));
  const deny = configured
    .filter((i) => i.startsWith("!"))
    .map((i) => i.slice(1));
  const configuredUnknown = allow
    .filter((a) => a !== "*")
    .filter((a) => !allAvailable.includes(a));

  if (deny.includes("*") || (allow.length === 0 && deny.length === 0)) {
    // empty array or !*
    const mode: ListExpressionSemantic["mode"] =
      deny.includes("*") || configured.length === 0 ? "none" : "none";
    return {
      mode,
      configured,
      allowed: [],
      denied: [...new Set([...allAvailable, ...deny, ...globallyDisabled])],
      configuredUnknown,
      globallyDisabled: [...globallyDisabled],
    };
  }

  let allowed = parseList(configured, allAvailable);
  // global disable always removes
  allowed = allowed.filter((a) => !gdis.has(a));

  const denied = [
    ...deny.filter((d) => d !== "*"),
    ...globallyDisabled,
    ...allAvailable.filter((a) => !allowed.includes(a) && allow.includes("*")),
  ];

  const mode: ListExpressionSemantic["mode"] = allow.includes("*")
    ? "all"
    : allowed.length === 0
      ? "none"
      : "selective";

  return {
    mode,
    configured,
    allowed,
    denied: [...new Set(denied)],
    configuredUnknown,
    globallyDisabled: [...globallyDisabled],
  };
}

/** Skill permission map from OMO getSkillPermissionsForAgent (skillList branch) */
export function skillPermissionMap(
  skillList: string[] | undefined,
  disabledSkills: string[],
  agentName: string,
): Record<string, PermissionDecision> {
  const disabled = new Set(disabledSkills);
  if (!skillList) {
    // default: orchestrator * allow else deny — without CUSTOM_SKILLS dump
    return {
      "*": agentName === "orchestrator" ? "allow" : "deny",
    };
  }
  const permissions: Record<string, PermissionDecision> = { "*": "deny" };
  for (const name of skillList) {
    if (name === "*") permissions["*"] = "allow";
    else if (name.startsWith("!")) permissions[name.slice(1)] = "deny";
    else if (!disabled.has(name)) permissions[name] = "allow";
  }
  for (const name of disabled) permissions[name] = "deny";
  return permissions;
}

function isDecision(v: unknown): v is PermissionDecision {
  return v === "allow" || v === "ask" || v === "deny";
}

export function summarizeToolPermission(
  rule: PermissionRule | undefined,
): PermissionDecision | "patterned" | "unset" {
  if (rule === undefined) return "unset";
  if (isDecision(rule)) return rule;
  if (typeof rule === "object" && rule) {
    const vals = Object.values(rule);
    if (vals.length === 0) return "unset";
    if (vals.every((v) => v === vals[0]) && isDecision(vals[0])) {
      return vals[0]!;
    }
    return "patterned";
  }
  return "unset";
}

export function permissionSummary(perm: AgentPermissionConfig | undefined): string {
  if (perm === undefined) return "unset (OMO/OpenCode defaults)";
  if (isDecision(perm)) return `global ${perm}`;
  const tools = Object.keys(perm);
  const patterned = tools.filter(
    (t) => summarizeToolPermission(perm[t] as PermissionRule) === "patterned",
  );
  return `object (${tools.length} keys${patterned.length ? `, ${patterned.length} patterned` : ""})`;
}

export function buildAgentCapabilitySummary(
  agent: string,
  cfg: {
    temperature?: number;
    skills?: string[];
    mcps?: string[];
    permission?: AgentPermissionConfig;
  },
  inventory: {
    skillNames: string[];
    mcpNames: string[];
    disabled_skills: string[];
    disabled_mcps: string[];
  },
): AgentCapabilitySummary {
  const skills = interpretListExpression(
    cfg.skills,
    inventory.skillNames,
    inventory.disabled_skills,
  );
  const mcps = interpretListExpression(
    cfg.mcps,
    inventory.mcpNames,
    inventory.disabled_mcps,
  );

  const tools: AgentCapabilitySummary["tools"] = {};
  const perm = cfg.permission;
  if (isDecision(perm)) {
    for (const t of KNOWN_TOOLS) tools[t] = perm;
  } else if (perm && typeof perm === "object") {
    for (const t of KNOWN_TOOLS) {
      tools[t] = summarizeToolPermission(perm[t] as PermissionRule | undefined);
    }
    for (const [k, v] of Object.entries(perm)) {
      if (!(k in tools)) {
        tools[k] = summarizeToolPermission(v as PermissionRule);
      }
    }
  } else {
    for (const t of KNOWN_TOOLS) tools[t] = "unset";
  }

  return {
    agent,
    temperature: cfg.temperature,
    skills,
    mcps,
    permission: cfg.permission,
    permissionSummary: permissionSummary(cfg.permission),
    tools,
  };
}

export function buildCapabilityInventory(opts: {
  provenance: ProvenanceBundle;
  skillNames: string[];
  mcpRuntime: Record<string, { status: string }>;
  toolIds?: string[];
}): CapabilityInventory {
  const g = opts.provenance.globals;
  const disabled_skills = Array.isArray(g.disabled_skills)
    ? (g.disabled_skills as string[])
    : [];
  const disabled_mcps = Array.isArray(g.disabled_mcps)
    ? (g.disabled_mcps as string[])
    : [];
  const disabled_tools = Array.isArray(g.disabled_tools)
    ? (g.disabled_tools as string[])
    : [];
  const disabled_agents = Array.isArray(g.disabled_agents)
    ? (g.disabled_agents as string[])
    : opts.provenance.agents
      ? Object.values(opts.provenance.agents)
          .filter((a) => !a.enabled)
          .map((a) => a.name)
      : [];

  const skillSet = new Set(opts.skillNames);
  // include configured unknowns in inventory as not installed
  for (const a of Object.values(opts.provenance.agents)) {
    for (const s of a.skills ?? []) {
      if (s !== "*" && !s.startsWith("!")) skillSet.add(s);
    }
  }

  const mcpNames = new Set([
    ...Object.keys(opts.mcpRuntime),
    ...Object.values(opts.provenance.agents).flatMap((a) =>
      (a.mcps ?? []).filter((m) => m !== "*" && !m.startsWith("!")),
    ),
  ]);

  const skills = [...skillSet].sort().map((name) => ({
    name,
    installed: opts.skillNames.includes(name),
    globallyDisabled: disabled_skills.includes(name),
  }));

  const mcps = [...mcpNames].sort().map((name) => ({
    name,
    runtimeStatus: opts.mcpRuntime[name]?.status,
    globallyDisabled: disabled_mcps.includes(name),
  }));

  const agents = Object.values(opts.provenance.agents).map((a) =>
    buildAgentCapabilitySummary(
      a.name,
      {
        temperature: a.temperature,
        skills: a.skills,
        mcps: a.mcps,
        permission: a.permission as AgentPermissionConfig | undefined,
      },
      {
        skillNames: [...skillSet],
        mcpNames: [...mcpNames],
        disabled_skills,
        disabled_mcps,
      },
    ),
  );

  return {
    skills,
    mcps,
    tools: [...KNOWN_TOOLS, ...(opts.toolIds ?? [])],
    agents,
    globals: {
      disabled_skills,
      disabled_mcps,
      disabled_tools,
      disabled_agents,
    },
  };
}

export function isCapabilityExpansion(
  before: AgentCapabilitySummary | undefined,
  after: AgentCapabilitySummary | undefined,
): string[] {
  const warnings: string[] = [];
  if (!before || !after) return warnings;
  for (const t of ["edit", "bash", "task"] as const) {
    const b = before.tools[t];
    const a = after.tools[t];
    if ((b === "deny" || b === "ask" || b === "unset") && a === "allow") {
      warnings.push(
        `CAPABILITY EXPANSION: ${after.agent}.${t} ${b} → allow`,
      );
    }
  }
  return warnings;
}
