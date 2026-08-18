/**
 * ACP agent lifecycle: inventory, mutations, command probing.
 *
 * Verified installed semantics (2.2.10):
 * - acpAgents.<name>: { command*, args[]=default [], env=default {}, cwd?,
 *   description?, prompt?, orchestratorPrompt?, wrapperModel (provider/model),
 *   timeoutMs (int 0..MAX, default 0 = disabled), permissionMode (ask|allow|reject, default ask) }
 * - strict schema (additionalProperties false) — only these fields persist
 * - name regex /^[a-z][a-z0-9_-]*$/i; conflicts with builtins/aliases/custom agents rejected
 * - acpAgents deep-merges per-field across scopes
 * - wrapper agent = same name; model = wrapperModel ?? fallbackModel ?? oracle default
 */

import { existsSync, readFileSync } from "node:fs";
import type { ServerConfig } from "../config";
import { assertSafeWritePath, resolveWriteTarget } from "./paths";
import {
  applyJsoncPathEdit,
  getAtPath,
  parseConfigText,
} from "./jsonc-edit";
import type { RevisionStore } from "./revisions";
import { resolveCommand, type CommandResolution } from "../acp/command";
import { isSecretKey, maskEnv, secretKeyCount } from "./secrets";
import {
  BUILTIN_OMO_AGENTS,
  type OmoCandidateProducer,
  type SchemaValidationSummary,
} from "@omo/shared";
import {
  expectedSourceFromHash,
  fingerprintScope,
  previewOmoCandidate,
  previewThenCommit,
  type OmoTransactionDeps,
} from "./transaction";

export type AcpFieldOp =
  | { operation: "unchanged" }
  | { operation: "set"; value: unknown }
  | { operation: "remove" };

export interface AcpAgentFields {
  command?: AcpFieldOp;
  args?: AcpFieldOp;
  env?: AcpFieldOp;
  cwd?: AcpFieldOp;
  description?: AcpFieldOp;
  prompt?: AcpFieldOp;
  orchestratorPrompt?: AcpFieldOp;
  wrapperModel?: AcpFieldOp;
  timeoutMs?: AcpFieldOp;
  permissionMode?: AcpFieldOp;
}

export interface AcpMutation {
  kind: "acp";
  scope: "user" | "project";
  create?: { name: string; cloneFrom?: string; fields?: AcpAgentFields };
  update?: { name: string; fields: AcpAgentFields };
  rename?: { oldName: string; newName: string };
  delete?: { name: string };
  expectedSourceHash?: string;
}

export interface AcpMutationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  revisionId?: string;
  targetPath?: string;
  textDiff?: string;
  effectiveChanges?: Array<{ path: string; before: unknown; after: unknown }>;
  commandResolution?: CommandResolution;
  /** Installed-schema gate result for the full candidate document. */
  schemaValidation?: SchemaValidationSummary;
}

const ACP_NAME_RE = /^[a-z][a-z0-9_-]*$/i;
const MAX_TIMEOUT = 2147483647;
const KNOWN_BUILTIN_AND_ALIASES = new Set<string>([
  ...BUILTIN_OMO_AGENTS,
  "build",
  "plan",
  "compaction",
  "summary",
  "title",
]);

const MODEL_ID_RE = /^[^/\s]+\/[^\s]+$/;

function validateAgentName(
  name: string,
  cfg: ServerConfig,
  beforeObj: Record<string, unknown>,
  excludeSelf?: string,
): string[] {
  const errors: string[] = [];
  if (!ACP_NAME_RE.test(name)) {
    errors.push(
      `ACP agent name '${name}' must match /^[a-z][a-z0-9_-]*$/i (network agent identifier)`,
    );
    return errors;
  }
  if (KNOWN_BUILTIN_AND_ALIASES.has(name) && name !== excludeSelf) {
    errors.push(`ACP agent '${name}' conflicts with a built-in agent name`);
  }
  const agents = (beforeObj.agents ?? {}) as Record<string, unknown>;
  if (agents[name] && name !== excludeSelf) {
    errors.push(`ACP agent '${name}' conflicts with a custom agent of the same name`);
  }
  return errors;
}

function validateFields(
  fields: AcpAgentFields,
  isCreate: boolean,
  existing: Record<string, unknown> | undefined,
): string[] {
  const errors: string[] = [];
  const finalCommand =
    fields.command?.operation === "set"
      ? fields.command.value
      : (existing?.command as string | undefined);
  if (fields.command?.operation === "remove")
    errors.push("command is required and cannot be removed");
  if (isCreate && finalCommand === undefined)
    errors.push("command is required to create an ACP agent");
  if (finalCommand !== undefined && typeof finalCommand !== "string")
    errors.push("command must be a string");
  if (typeof finalCommand === "string" && finalCommand.length === 0)
    errors.push("command must not be empty");
  if (typeof finalCommand === "string" && finalCommand.endsWith(" "))
    errors.push("command must not contain trailing whitespace");

  if (fields.args?.operation === "set") {
    const v = fields.args.value;
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
      errors.push("args must be an array of strings");
    }
  }
  if (fields.env?.operation === "set") {
    const v = fields.env.value;
    if (
      !v ||
      typeof v !== "object" ||
      Array.isArray(v) ||
      !Object.entries(v as Record<string, unknown>).every(
        ([k, val]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof val === "string",
      )
    ) {
      errors.push("env must be an object of key:string value:string");
    }
  }
  if (fields.cwd?.operation === "set") {
    const v = fields.cwd.value;
    if (typeof v !== "string" || v.length === 0)
      errors.push("cwd must be a non-empty string");
    if (typeof v === "string" && v.includes(".."))
      errors.push("cwd must not contain '..' traversals");
  }
  if (fields.wrapperModel?.operation === "set") {
    const v = fields.wrapperModel.value;
    if (typeof v !== "string" || !MODEL_ID_RE.test(v)) {
      errors.push("wrapperModel must be provider/model format");
    }
  }
  if (fields.timeoutMs?.operation === "set") {
    const v = fields.timeoutMs.value;
    if (
      typeof v !== "number" ||
      !Number.isInteger(v) ||
      v < 0 ||
      v > MAX_TIMEOUT
    ) {
      errors.push(`timeoutMs must be integer 0..${MAX_TIMEOUT}`);
    }
  }
  if (fields.permissionMode?.operation === "set") {
    const v = fields.permissionMode.value;
    if (v !== "ask" && v !== "allow" && v !== "reject") {
      errors.push("permissionMode must be ask | allow | reject");
    }
  }
  return errors;
}

function expandFieldsEdits(
  base: string[],
  fields: AcpAgentFields,
): Array<{ path: string[]; value: unknown }> {
  const edits: Array<{ path: string[]; value: unknown }> = [];
  const KEY_ORDER: Array<keyof AcpAgentFields> = [
    "command",
    "args",
    "env",
    "cwd",
    "description",
    "prompt",
    "orchestratorPrompt",
    "wrapperModel",
    "timeoutMs",
    "permissionMode",
  ];
  for (const k of KEY_ORDER) {
    const op = fields[k];
    if (!op || op.operation === "unchanged") continue;
    edits.push({
      path: [...base, k],
      value: op.operation === "remove" ? undefined : op.value,
    });
  }
  return edits;
}

export const produceAcpCandidate: OmoCandidateProducer<AcpMutation> = (input) => {
  const errors: string[] = [];
  const warnings: string[] = [];
  let commandResolution: CommandResolution | undefined;
  const acpAgents = (input.beforeDocument.acpAgents ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const edits: Array<{ path: string[]; value: unknown }> = [];
  const m = input.input;

  if (m.create) {
    const { name, cloneFrom, fields = {} } = m.create;
    errors.push(...validateAgentName(name, {} as ServerConfig, input.beforeDocument));
    if (acpAgents[name] !== undefined)
      errors.push(`ACP agent '${name}' already exists`);
    let base: Record<string, unknown> = {};
    if (cloneFrom) {
      const src = acpAgents[cloneFrom];
      if (!src) errors.push(`Clone source '${cloneFrom}' not found`);
      else base = JSON.parse(JSON.stringify(src));
    }
    const existingForValidate = { ...base };
    errors.push(
      ...validateFields(
        fields,
        !base.command && !fields.command?.operation,
        { ...existingForValidate, ...overrideFrom(fields) },
      ),
    );
    if (errors.length === 0) {
      const merged: Record<string, unknown> = { ...base };
      for (const e of expandFieldsEdits([], fields)) {
        const key = e.path[e.path.length - 1]!;
        if (e.value === undefined) delete merged[key];
        else merged[key] = e.value;
      }
      edits.push({ path: ["acpAgents", name], value: merged });
      const cmd = merged.command as string | undefined;
      if (cmd) commandResolution = resolveCommand(cmd);
    }
  }

  if (m.update) {
    const { name, fields } = m.update;
    const existing = acpAgents[name];
    if (!existing) errors.push(`ACP agent '${name}' not found`);
    else {
      if ("command" in fields && fields.command?.operation === "remove")
        errors.push("command is required and cannot be removed");
      errors.push(...validateFields(fields, false, existing));
      if (errors.length === 0) {
        edits.push(...expandFieldsEdits(["acpAgents", name], fields));
        const newCommand =
          fields.command?.operation === "set"
            ? (fields.command.value as string)
            : (existing.command as string | undefined);
        if (newCommand) commandResolution = resolveCommand(newCommand);
      }
    }
  }

  if (m.rename) {
    const { oldName, newName } = m.rename;
    const existing = acpAgents[oldName];
    if (!existing) errors.push(`ACP agent '${oldName}' not found`);
    errors.push(...validateAgentName(newName, {} as ServerConfig, input.beforeDocument));
    if (acpAgents[newName] !== undefined)
      errors.push(`ACP agent '${newName}' already exists`);
    if (errors.length === 0 && existing) {
      edits.push({ path: ["acpAgents", newName], value: JSON.parse(JSON.stringify(existing)) });
      edits.push({ path: ["acpAgents", oldName], value: undefined });
      warnings.push(
        `Renamed wrapper agent ${oldName} → ${newName}. Historical sessions keep original name.`,
      );
    }
  }

  if (m.delete) {
    const { name } = m.delete;
    if (acpAgents[name] === undefined) errors.push(`ACP agent '${name}' not found`);
    else edits.push({ path: ["acpAgents", name], value: undefined });
  }

  if (!errors.length && !edits.length) errors.push("No changes");
  let afterText = input.beforeText;
  if (!errors.length) {
    for (const e of edits) afterText = applyJsoncPathEdit(afterText, e.path, e.value);
  }
  const mutationLabel =
    m.create ? "acp-agent-create"
    : m.rename ? "acp-agent-rename"
    : m.delete ? "acp-agent-delete"
    : "acp-agent-update";
  const agentName =
    m.create?.name ?? m.rename?.oldName ?? m.delete?.name ?? m.update?.name;
  return {
    candidateText: afterText,
    featureErrors: errors,
    featureWarnings: warnings,
    intent: {
      kind: mutationLabel,
      summary: mutationLabel,
      propertyPaths: edits.map((e) => e.path.join(".")),
      mutationJson: redactSecrets(JSON.stringify(m)),
      agent: agentName,
      property: "acpAgents",
    },
  };
};

function acpDeps(cfg: ServerConfig, revisions?: RevisionStore): OmoTransactionDeps {
  return {
    cfg,
    revisions: revisions ?? ({
      available: true,
      isScopeWriteBlocked: () => false,
      recoverPendingOmo: () => [],
    } as unknown as RevisionStore),
  };
}

export function simulateAcp(
  cfg: ServerConfig,
  m: AcpMutation,
): AcpMutationResult & { currentHash?: string } {
  const deps = acpDeps(cfg);
  const live = fingerprintScope(deps, m.scope);
  const preview = previewOmoCandidate(
    deps,
    {
      scope: m.scope,
      expectedSource: expectedSourceFromHash(live, m.expectedSourceHash),
      input: m,
    },
    produceAcpCandidate,
  );
  const produced = produceAcpCandidate({
    scope: m.scope,
    beforeText: preview.beforeText,
    beforeDocument: preview.beforeDocument ?? {},
    format: preview.target.format,
    source: preview.source,
    input: m,
  });
  let commandResolution: CommandResolution | undefined;
  const after = preview.afterDocument ?? {};
  const acp = (after.acpAgents ?? {}) as Record<string, Record<string, unknown>>;
  const first = Object.values(acp)[0];
  if (typeof first?.command === "string") commandResolution = resolveCommand(first.command);
  const effectiveChanges = preview.sourceChanges.map((c) => ({
    path: c.path,
    before: c.before,
    after: c.after,
  }));
  if (commandResolution?.status === "not-resolved") {
    produced.featureWarnings.push(
      `Command not resolvable in control-plane environment (not probed inside binary). Configuration may still be valid for OMO host.`,
    );
  }
  if (!preview.ok) {
    return {
      ok: false,
      errors:
        preview.code === "stale-source"
          ? ["CONFIGURATION CHANGED EXTERNALLY"]
          : preview.errors,
      warnings: [...produced.featureWarnings, ...preview.warnings],
      currentHash: preview.source.sha256 ?? undefined,
      targetPath: preview.target.path,
      textDiff: preview.textDiff?.text,
      commandResolution,
      schemaValidation: preview.schemaValidation,
    };
  }
  return {
    ok: true,
    errors: [],
    warnings: [...produced.featureWarnings, ...preview.warnings],
    currentHash: preview.source.sha256 ?? undefined,
    targetPath: preview.target.path,
    textDiff: preview.textDiff?.text,
    effectiveChanges,
    commandResolution,
    schemaValidation: preview.schemaValidation,
  };
}

function overrideFrom(fields: AcpAgentFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, op] of Object.entries(fields)) {
    if (!op) continue;
    const o = op as AcpFieldOp;
    if (o.operation === "set") out[k] = o.value;
  }
  return out;
}

export function applyAcp(
  cfg: ServerConfig,
  m: AcpMutation,
  revisions: RevisionStore,
): AcpMutationResult {
  const deps = acpDeps(cfg, revisions);
  const live = fingerprintScope(deps, m.scope);
  const commit = previewThenCommit(
    deps,
    {
      scope: m.scope,
      expectedSource: expectedSourceFromHash(live, m.expectedSourceHash),
      input: m,
    },
    produceAcpCandidate,
  );
  const effectiveChanges = commit.preview.sourceChanges.map((c) => ({
    path: c.path,
    before: c.before,
    after: c.after,
  }));
  let commandResolution: CommandResolution | undefined;
  const after = commit.preview.afterDocument ?? {};
  const acp = (after.acpAgents ?? {}) as Record<string, Record<string, unknown>>;
  const first = Object.values(acp)[0];
  if (typeof first?.command === "string") commandResolution = resolveCommand(first.command);
  if (!commit.ok) {
    return {
      ok: false,
      errors:
        commit.code === "stale-source"
          ? ["CONFIGURATION CHANGED EXTERNALLY"]
          : commit.errors,
      warnings: commit.preview.warnings,
      commandResolution,
      schemaValidation: commit.preview.schemaValidation,
    };
  }
  return {
    ok: true,
    errors: [],
    warnings: commit.preview.warnings,
    revisionId: commit.revisionId,
    targetPath: commit.preview.target.path,
    textDiff: commit.preview.textDiff?.text,
    effectiveChanges,
    commandResolution,
    schemaValidation: commit.preview.schemaValidation,
  };
}

/** Redact secret-like env values in text that may contain them (JSON/JSONC). */
export function redactSecrets(text: string): string {
  // find "key": "value" pairs where key matches secret pattern
  return text.replace(
    /("(?:[^"\\]|\\.)*(?:token|secret|password|passwd|api[_-]?key|auth|credential|private[_-]?key)(?:[^"\\]|\\.)*")(\s*:\s*)("(?:[^"\\]|\\.)*")/gi,
    (_m, key, sep, _val) => `${key}${sep}"[REDACTED]"`,
  );
}

// ── Inventory ─────────────────────────────────────────────────────────

export interface AcpAgentView {
  name: string;
  sourceScopes: Array<"user" | "project">;
  config: Record<string, unknown>;
  envMasked: Record<string, string>;
  secretKeyCount: number;
  command?: string;
  wrapperModel?: string;
  permissionMode?: string;
  timeoutMs?: number;
  permission: string;
  commandResolution?: CommandResolution;
  cwdAuthorized?: boolean | null;
  wrapperRegistered?: boolean;
  disabled?: boolean;
  warnings: string[];
}

export interface AcpInventory {
  agents: AcpAgentView[];
  note: string;
}

/** Raw (unmasked, merged) ACP agent config for internal probe use only. */
export function getRawAcpAgent(
  cfg: ServerConfig,
  name: string,
): Record<string, unknown> | null {
  const load = (scope: "user" | "project") => {
    const t = resolveWriteTarget(cfg, scope);
    if (!t.exists) return {} as Record<string, unknown>;
    try {
      return parseConfigText(readFileSync(t.path, "utf-8")) as Record<string, unknown>;
    } catch {
      return {} as Record<string, unknown>;
    }
  };
  const userAcp = ((load("user").acpAgents ?? {}) as Record<string, Record<string, unknown>>)[name];
  const projectAcp = ((load("project").acpAgents ?? {}) as Record<string, Record<string, unknown>>)[name];
  if (!userAcp && !projectAcp) return null;
  const merged = { ...(userAcp ?? {}) };
  for (const [k, v] of Object.entries(projectAcp ?? {})) {
    merged[k] = v && typeof v === "object" && !Array.isArray(v) && merged[k] && typeof merged[k] === "object" && !Array.isArray(merged[k])
      ? { ...(merged[k] as Record<string, unknown>), ...(v as Record<string, unknown>) }
      : v;
  }
  return merged;
}

export function buildAcpInventory(
  cfg: ServerConfig,
  liveAgentNames: string[],
  probe = true,
): AcpInventory {
  const load = (scope: "user" | "project") => {
    const t = resolveWriteTarget(cfg, scope);
    if (!t.exists) return {} as Record<string, unknown>;
    try {
      return parseConfigText(readFileSync(t.path, "utf-8")) as Record<string, unknown>;
    } catch {
      return {} as Record<string, unknown>;
    }
  };
  const user = load("user");
  const project = load("project");
  const userAcp = (user.acpAgents ?? {}) as Record<string, Record<string, unknown>>;
  const projectAcp = (project.acpAgents ?? {}) as Record<string, Record<string, unknown>>;

  const disabled = Array.isArray((user.disabled_agents ?? project.disabled_agents) as string[] | undefined)
    ? ((user.disabled_agents ?? project.disabled_agents) as string[])
    : [];

  const names = new Set([...Object.keys(userAcp), ...Object.keys(projectAcp)]);
  const agents: AcpAgentView[] = [...names].sort().map((name) => {
    const merged = { ...(userAcp[name] ?? {}) } as Record<string, unknown>;
    // field-level deep merge from project over user
    for (const [k, v] of Object.entries(projectAcp[name] ?? {})) {
      if (
        v && typeof v === "object" && !Array.isArray(v) &&
        merged[k] && typeof merged[k] === "object" && !Array.isArray(merged[k])
      ) {
        merged[k] = { ...(merged[k] as Record<string, unknown>), ...(v as Record<string, unknown>) };
      } else {
        merged[k] = v;
      }
    }
    const warnings: string[] = [];
    const command = merged.command as string | undefined;
    let commandResolution: CommandResolution | undefined;
    if (probe && command) {
      commandResolution = resolveCommand(command);
      if (commandResolution.status === "not-resolved") {
        warnings.push("Command not resolvable in control-plane environment");
      }
    }
    if (!command) warnings.push("Missing required command");

    let cwdAuthorized: boolean | null = null;
    const cwd = merged.cwd as string | undefined;
    if (cwd) {
      cwdAuthorized = cfg.authorizedRoots.some(
        (r) => cwd === r || cwd.startsWith(r.replace(/\/$/, "") + "/"),
      );
      if (!cwdAuthorized) {
        warnings.push(
          `cwd outside authorized control-plane scope — will not be inspected`,
        );
      }
    }

    const env = (merged.env ?? {}) as Record<string, string>;
    return {
      name,
      sourceScopes: [
        ...(userAcp[name] ? ["user" as const] : []),
        ...(projectAcp[name] ? ["project" as const] : []),
      ],
      config: { ...merged, env: maskEnv(env) },
      envMasked: maskEnv(env),
      secretKeyCount: secretKeyCount(env),
      command,
      wrapperModel: merged.wrapperModel as string | undefined,
      permissionMode: (merged.permissionMode as string | undefined) ?? "ask",
      timeoutMs: typeof merged.timeoutMs === "number" ? (merged.timeoutMs as number) : 0,
      permission: "acp_run only (wrapper restriction built into OMO)",
      commandResolution,
      cwdAuthorized,
      wrapperRegistered: liveAgentNames.includes(name),
      disabled: disabled.includes(name),
      warnings,
    };
  });

  return {
    agents,
    note:
      "ACP wrappers delegate to external ACP-compatible processes via acp_run. External agent's internal model is not observable by OMO/control plane.",
  };
}
