/**
 * Slice 18 D4 — current-installed-schema coverage classification.
 *
 * Walks the authorized installed schema document (never a static copy,
 * never the config `$schema` URL). Every current meaningful leaf/template
 * must classify. Companion is never editable. Typed Interview requires the
 * current version/hash/source audit.
 */

import { createHash } from "node:crypto";
import type { InstalledSchemaSnapshot } from "./authority";
import {
  AUDITED_INTERVIEW_FIELD_NAMES,
  AUDITED_INTERVIEW_PACKAGE_VERSION,
  AUDITED_INTERVIEW_SCHEMA_HASH,
  extractInterviewSchemaFields,
  interviewFieldsMatchAudited,
} from "./introspect";

export const COVERAGE_CLASSES = [
  "typed-editable",
  "raw-editable",
  "read-only-companion",
  "unsupported-installed-version",
  "deprecated",
  "runtime-limited",
] as const;

export type CoverageClass = (typeof COVERAGE_CLASSES)[number];

export type CoverageMatrixLabel =
  | "Structured + Raw"
  | "Raw only"
  | "Read-only intentionally"
  | "Deprecated"
  | "Unsupported"
  | "Runtime-limited";

export interface CoverageEntry {
  path: string;
  schemaType: string;
  classification: CoverageClass;
  matrix: CoverageMatrixLabel;
  defaultValue?: unknown;
  enumValues?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  notes: string[];
}

export interface CoverageAudit {
  ok: boolean;
  errors: string[];
  packageVersion?: string;
  schemaHash?: string;
  cacheKey?: string;
  schemaPath?: string;
  interviewTyped: boolean;
  entries: CoverageEntry[];
  unclassified: string[];
  topLevel: string[];
}

const STRUCTURED_EXACT = new Set([
  "preset",
  "setDefaultAgent",
  "compactSidebar",
  "stripOrchestratorModel",
  "autoUpdate",
  "presets",
  "agents",
  "disabled_agents",
  "image_routing",
  "disabled_mcps",
  "disabled_tools",
  "disabled_skills",
  "backgroundJobs",
  "fallback",
  "webfetch",
  "council",
  "acpAgents",
  "multiplexer",
]);

const STRUCTURED_PREFIXES = [
  "backgroundJobs.",
  "fallback.",
  "webfetch.",
  "council.",
  "acpAgents.",
  "multiplexer.",
  "interview.",
  "agents.<name>.",
  "presets.<name>.",
];

const RAW_ONLY_EXACT = new Set([
  "agents.<name>.options",
  "presets.<name>.<agent>.options",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function typeLabel(node: Record<string, unknown>): string {
  if (typeof node.type === "string") return node.type;
  if (Array.isArray(node.type)) return node.type.map(String).join("|");
  if (Array.isArray(node.anyOf)) {
    return (node.anyOf as unknown[])
      .map((alt) => (isPlainObject(alt) ? typeLabel(alt) : "unknown"))
      .join("|");
  }
  if (Array.isArray(node.enum)) return "enum";
  return "unknown";
}

function isStructuredPath(path: string): boolean {
  if (STRUCTURED_EXACT.has(path)) return true;
  if (RAW_ONLY_EXACT.has(path)) return false;
  if (path.startsWith("companion.")) return false;
  if (path === "fallback.runtimeOverride") return false;
  return STRUCTURED_PREFIXES.some((p) => path.startsWith(p));
}

export function classifyCoveragePath(
  path: string,
  interviewTyped: boolean,
): { classification: CoverageClass; matrix: CoverageMatrixLabel; notes: string[] } {
  const notes: string[] = [];
  if (path === "showStartupToast" || path.startsWith("council.master")) {
    return {
      classification: "unsupported-installed-version",
      matrix: "Unsupported",
      notes: ["Absent or reserved in the current installed schema"],
    };
  }
  if (path === "fallback.runtimeOverride") {
    return {
      classification: "deprecated",
      matrix: "Deprecated",
      notes: ["Installed schema marks this DEPRECATED / unused"],
    };
  }
  if (path === "companion" || path.startsWith("companion.")) {
    return {
      classification: "read-only-companion",
      matrix: "Read-only intentionally",
      notes: ["Companion remains read-only and is intentionally not developed further"],
    };
  }
  if (path === "interview" || path.startsWith("interview.")) {
    if (!interviewTyped) {
      return {
        classification: "unsupported-installed-version",
        matrix: "Unsupported",
        notes: ["Typed Interview writes stay closed until version/hash/source audit match"],
      };
    }
    return {
      classification: "typed-editable",
      matrix: "Structured + Raw",
      notes: [
        "Typed Interview set/remove through the D1 transaction; also raw-editable",
        "Runtime is not observable or controllable from the control plane",
      ],
    };
  }
  if (
    path.startsWith("opencode") ||
    path.includes("opencode.json") ||
    path.startsWith("prompt") ||
    path.includes("oh-my-opencode-slim/")
  ) {
    throw new Error(`Refusing to classify excluded domain as coverage: ${path}`);
  }
  if (RAW_ONLY_EXACT.has(path)) {
    notes.push("Opaque options bag — structured editors do not target this leaf");
    return { classification: "raw-editable", matrix: "Raw only", notes };
  }
  if (isStructuredPath(path)) {
    return { classification: "raw-editable", matrix: "Structured + Raw", notes };
  }
  return { classification: "raw-editable", matrix: "Raw only", notes };
}

interface WalkNode {
  path: string;
  node: Record<string, unknown>;
}

function pushLeaf(out: WalkNode[], path: string, node: Record<string, unknown>): void {
  out.push({ path, node });
}

/**
 * Meaningful current leaves/templates. Map objects emit one `<name>` /
 * `<agent>` / `<member>` template rather than inventing keys. Permission
 * tool maps collapse to the `permission` leaf.
 */
export function walkInstalledSchemaLeaves(
  schema: unknown,
): WalkNode[] {
  if (!isPlainObject(schema) || !isPlainObject(schema.properties)) return [];
  const out: WalkNode[] = [];
  const properties = schema.properties;

  const walkObject = (
    prefix: string,
    node: Record<string, unknown>,
    emitSelf: boolean,
  ): void => {
    const named = isPlainObject(node.properties) ? node.properties : null;
    const add = node.additionalProperties;
    if (prefix.endsWith(".permission") || prefix.endsWith(".options")) {
      if (prefix) pushLeaf(out, prefix, node);
      return;
    }
    if (named) {
      if (emitSelf && prefix) pushLeaf(out, prefix, node);
      for (const [key, child] of Object.entries(named)) {
        if (!isPlainObject(child)) continue;
        const next = prefix ? `${prefix}.${key}` : key;
        walkObject(next, child, true);
      }
      return;
    }
    if (isPlainObject(add)) {
      if (prefix === "presets") {
        pushLeaf(out, "presets", node);
        const agentTemplate = isPlainObject(add.additionalProperties)
          ? add.additionalProperties
          : add;
        walkObject("presets.<name>.<agent>", agentTemplate, false);
        return;
      }
      if (prefix === "agents") {
        pushLeaf(out, "agents", node);
        walkObject("agents.<name>", add, false);
        return;
      }
      if (prefix === "acpAgents") {
        walkObject("acpAgents.<name>", add, false);
        return;
      }
      if (prefix === "council.presets") {
        pushLeaf(out, "council.presets", node);
        const memberTemplate = isPlainObject(add.additionalProperties)
          ? add.additionalProperties
          : add;
        pushLeaf(out, "council.presets.<name>.<member>", memberTemplate);
        return;
      }
      pushLeaf(out, `${prefix}.<name>`, add);
      return;
    }
    if (prefix) pushLeaf(out, prefix, node);
  };

  for (const [key, child] of Object.entries(properties)) {
    if (!isPlainObject(child)) continue;
    walkObject(key, child, true);
  }
  return out;
}

function interviewTypedAvailable(snap: InstalledSchemaSnapshot): {
  ok: boolean;
  reason?: string;
} {
  if (snap.packageVersion !== AUDITED_INTERVIEW_PACKAGE_VERSION) {
    return {
      ok: false,
      reason: `interview-version-mismatch: installed=${snap.packageVersion} audited=${AUDITED_INTERVIEW_PACKAGE_VERSION}`,
    };
  }
  if (snap.schemaHash !== AUDITED_INTERVIEW_SCHEMA_HASH) {
    return {
      ok: false,
      reason: `interview-schema-hash-mismatch: installed=${snap.schemaHash} audited=${AUDITED_INTERVIEW_SCHEMA_HASH}`,
    };
  }
  const extracted = extractInterviewSchemaFields(snap.schema);
  const match = interviewFieldsMatchAudited(extracted);
  if (!match.ok) return { ok: false, reason: match.reason };
  const names = extracted.fieldNames;
  if (names.length !== AUDITED_INTERVIEW_FIELD_NAMES.length) {
    return { ok: false, reason: "interview-field-count-mismatch" };
  }
  return { ok: true };
}

export function auditInstalledSchemaCoverage(
  snap: InstalledSchemaSnapshot,
): CoverageAudit {
  const errors: string[] = [];
  const interview = interviewTypedAvailable(snap);
  const walked = walkInstalledSchemaLeaves(snap.schema);
  const entries: CoverageEntry[] = [];
  const unclassified: string[] = [];
  const seen = new Set<string>();

  const topLevel = isPlainObject(snap.schema.properties)
    ? Object.keys(snap.schema.properties)
    : [];

  for (const { path, node } of walked) {
    if (seen.has(path)) continue;
    seen.add(path);
    try {
      const classified = classifyCoveragePath(path, interview.ok);
      const enums = Array.isArray(node.enum) ? node.enum : undefined;
      entries.push({
        path,
        schemaType: typeLabel(node),
        classification: classified.classification,
        matrix: classified.matrix,
        ...(node.default !== undefined ? { defaultValue: node.default } : {}),
        ...(enums ? { enumValues: enums } : {}),
        ...(typeof node.minimum === "number" ? { minimum: node.minimum } : {}),
        ...(typeof node.maximum === "number" ? { maximum: node.maximum } : {}),
        ...(typeof node.minLength === "number" ? { minLength: node.minLength } : {}),
        notes: classified.notes,
      });
    } catch (e) {
      unclassified.push(path);
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  for (const e of entries) {
    if (e.path.startsWith("companion.") || e.path === "companion") {
      if (e.classification !== "read-only-companion") {
        errors.push(`Companion must be read-only: ${e.path} is ${e.classification}`);
      }
    }
    if (e.path.startsWith("interview.") && interview.ok) {
      if (e.classification !== "typed-editable") {
        errors.push(`Interview must be typed-editable under current audit: ${e.path}`);
      }
    }
    if (
      e.path.includes("opencode.json") ||
      e.path.startsWith("prompt-") ||
      e.path.startsWith("prompts.")
    ) {
      errors.push(`Raw coverage must not include OpenCode/prompt sources: ${e.path}`);
    }
  }

  if (!interview.ok) {
    errors.push(
      `Typed Interview writes are closed: ${interview.reason ?? "audit mismatch"}`,
    );
  }

  const interviewLeaves = entries.filter((e) => e.path.startsWith("interview."));
  if (interview.ok && interviewLeaves.length !== AUDITED_INTERVIEW_FIELD_NAMES.length) {
    errors.push(
      `Interview leaf count ${interviewLeaves.length} != audited ${AUDITED_INTERVIEW_FIELD_NAMES.length}`,
    );
  }

  if (unclassified.length) {
    errors.push(`Unclassified current fields: ${unclassified.join(", ")}`);
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));

  return {
    ok: errors.length === 0,
    errors,
    packageVersion: snap.packageVersion,
    schemaHash: snap.schemaHash,
    cacheKey: snap.cacheKey,
    schemaPath: snap.schemaPath,
    interviewTyped: interview.ok,
    entries,
    unclassified,
    topLevel,
  };
}

export function coverageMatrixByTopLevel(
  audit: CoverageAudit,
): Array<{ field: string; matrix: CoverageMatrixLabel; notes: string[] }> {
  const groups = new Map<string, CoverageEntry[]>();
  for (const e of audit.entries) {
    const top = e.path.split(".")[0] ?? e.path;
    const list = groups.get(top) ?? [];
    list.push(e);
    groups.set(top, list);
  }
  const out: Array<{ field: string; matrix: CoverageMatrixLabel; notes: string[] }> = [];
  for (const field of audit.topLevel) {
    const rows = groups.get(field) ?? [];
    const matrices = new Set(rows.map((r) => r.matrix));
    let matrix: CoverageMatrixLabel;
    if (matrices.has("Read-only intentionally")) matrix = "Read-only intentionally";
    else if (matrices.size === 1) matrix = [...matrices][0]!;
    else if (matrices.has("Deprecated") && matrices.has("Structured + Raw")) {
      matrix = "Structured + Raw";
    } else if (matrices.has("Structured + Raw")) matrix = "Structured + Raw";
    else matrix = [...matrices][0] ?? "Raw only";
    const notes = [...new Set(rows.flatMap((r) => r.notes))];
    if (matrices.has("Deprecated")) {
      notes.push("Contains deprecated nested field(s)");
    }
    out.push({ field, matrix, notes });
  }
  return out;
}

/** Identity of the audit *input* (package + schema bytes). Not an editor schema. */
export function auditInputIdentity(snap: InstalledSchemaSnapshot): string {
  return createHash("sha256")
    .update(`${snap.packageVersion}\n${snap.schemaHash}\n${snap.schemaText}`)
    .digest("hex");
}

export function formatCoverageMarkdown(audit: CoverageAudit): string {
  const lines: string[] = [];
  lines.push(`# Installed OMO schema coverage`);
  lines.push("");
  lines.push(`- Package: \`oh-my-opencode-slim@${audit.packageVersion ?? "unknown"}\``);
  lines.push(`- Schema SHA-256: \`${audit.schemaHash ?? "unknown"}\``);
  lines.push(`- Cache key: \`${audit.cacheKey ?? "unknown"}\``);
  lines.push(`- Typed Interview: ${audit.interviewTyped ? "open" : "closed"}`);
  lines.push("");
  lines.push("## Top-level matrix");
  lines.push("");
  lines.push("| Field | Coverage | Notes |");
  lines.push("|---|---|---|");
  for (const row of coverageMatrixByTopLevel(audit)) {
    lines.push(`| \`${row.field}\` | ${row.matrix} | ${row.notes.join("; ") || "—"} |`);
  }
  lines.push("");
  lines.push("## Current leaves / templates");
  lines.push("");
  lines.push("| Path | Type | Classification | Matrix |");
  lines.push("|---|---|---|---|");
  for (const e of audit.entries) {
    lines.push(
      `| \`${e.path}\` | \`${e.schemaType}\` | ${e.classification} | ${e.matrix} |`,
    );
  }
  return lines.join("\n");
}
