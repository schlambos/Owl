/**
 * Virtual candidate diffs for OMO JSON transactions (Slice 18 D1).
 * No filesystem writes. Caps and truncation are explicit.
 */

import { findNodeAtLocation, getNodeValue, parseTree } from "jsonc-parser";
import type {
  BoundedTextDiff,
  DiffTruncation,
  JsonChange,
  ProvenanceBundle,
  ProvenanceChange,
  RawSemanticSummaries,
  RawSemanticSummary,
  ResolvedProperty,
} from "@omo/shared";
import {
  MAX_DIFF_CHANGE_ENTRIES,
  MAX_DIFF_VALUE_PREVIEW_BYTES,
  MAX_TEXT_DIFF_BYTES,
} from "@omo/shared";
import { parseOmoDocument, unifiedDiff } from "./jsonc-edit";

export type CompanionProjection =
  | { present: false }
  | { present: true; value: unknown };

export type CompanionPolicyResult =
  | { ok: true }
  | { ok: false; changedPaths: string[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function truncateUtf8(text: string, maxBytes: number): {
  text: string;
  truncated: boolean;
  omittedBytes?: number;
} {
  const bytes = Buffer.byteLength(text, "utf-8");
  if (bytes <= maxBytes) return { text, truncated: false };
  let end = Math.min(text.length, maxBytes);
  let sliced = text.slice(0, end);
  while (end > 0 && Buffer.byteLength(sliced, "utf-8") > maxBytes) {
    end -= 1;
    sliced = text.slice(0, end);
  }
  return {
    text: sliced,
    truncated: true,
    omittedBytes: bytes - Buffer.byteLength(sliced, "utf-8"),
  };
}

function previewValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (Buffer.byteLength(text, "utf-8") <= MAX_DIFF_VALUE_PREVIEW_BYTES) return value;
  if (typeof value === "string") {
    const cut = truncateUtf8(value, MAX_DIFF_VALUE_PREVIEW_BYTES);
    return `${cut.text}…`;
  }
  const cut = truncateUtf8(text, MAX_DIFF_VALUE_PREVIEW_BYTES);
  return {
    truncated: true,
    omittedBytes: cut.omittedBytes,
  };
}

/** Canonical JSON so object key order does not affect structural equality. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function collectLeaves(
  value: unknown,
  prefix: string,
  out: Map<string, unknown>,
): void {
  if (value === undefined) return;
  if (Array.isArray(value) || !isPlainObject(value)) {
    if (prefix) out.set(prefix, value);
    return;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) {
    if (prefix) out.set(prefix, value);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${k}` : k;
    collectLeaves(v, next, out);
  }
}

export function jsonChanges(
  before: unknown,
  after: unknown,
  root = "",
): JsonChange[] {
  const beforeLeaves = new Map<string, unknown>();
  const afterLeaves = new Map<string, unknown>();
  collectLeaves(before, root, beforeLeaves);
  collectLeaves(after, root, afterLeaves);
  const paths = new Set([...beforeLeaves.keys(), ...afterLeaves.keys()]);
  const changes: JsonChange[] = [];
  for (const path of [...paths].sort()) {
    const hasB = beforeLeaves.has(path);
    const hasA = afterLeaves.has(path);
    const b = beforeLeaves.get(path);
    const a = afterLeaves.get(path);
    if (hasB && hasA && canonicalJson(b) === canonicalJson(a)) continue;
    if (!hasB && hasA) {
      changes.push({ path, op: "add", after: previewValue(a) });
    } else if (hasB && !hasA) {
      changes.push({ path, op: "remove", before: previewValue(b) });
    } else {
      changes.push({
        path,
        op: "replace",
        before: previewValue(b),
        after: previewValue(a),
      });
    }
  }
  return changes;
}

export function provenanceChanges(
  before: Record<string, ResolvedProperty>,
  after: Record<string, ResolvedProperty>,
): ProvenanceChange[] {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: ProvenanceChange[] = [];
  for (const path of [...paths].sort()) {
    const b = before[path];
    const a = after[path];
    const same =
      canonicalJson(b?.value) === canonicalJson(a?.value) &&
      b?.winner.sourceId === a?.winner.sourceId &&
      b?.winner.stage === a?.winner.stage;
    if (same) continue;
    out.push({
      path,
      before: b
        ? { sourceId: b.winner.sourceId, stage: b.winner.stage, value: previewValue(b.value) }
        : undefined,
      after: a
        ? { sourceId: a.winner.sourceId, stage: a.winner.stage, value: previewValue(a.value) }
        : undefined,
    });
  }
  return out;
}

export function boundChangeList<T>(
  items: T[],
): { items: T[]; truncation?: DiffTruncation } {
  if (items.length <= MAX_DIFF_CHANGE_ENTRIES) {
    return { items };
  }
  return {
    items: items.slice(0, MAX_DIFF_CHANGE_ENTRIES),
    truncation: {
      truncated: true,
      omittedChangeEntries: items.length - MAX_DIFF_CHANGE_ENTRIES,
      fullSourceAvailableInEditor: true,
    },
  };
}

export function boundTextDiff(
  before: string,
  after: string,
  fileLabel: string,
): BoundedTextDiff {
  const text = unifiedDiff(before, after, fileLabel);
  return truncateUtf8(text, MAX_TEXT_DIFF_BYTES);
}

export function projectCompanion(doc: Record<string, unknown>): CompanionProjection {
  if (!Object.prototype.hasOwnProperty.call(doc, "companion")) {
    return { present: false };
  }
  return { present: true, value: doc.companion };
}

function companionPaths(before: CompanionProjection, after: CompanionProjection): string[] {
  if (!before.present && !after.present) return [];
  if (!before.present && after.present) return ["companion"];
  if (before.present && !after.present) return ["companion"];
  const changes = jsonChanges(
    { companion: before.present ? before.value : undefined },
    { companion: after.present ? after.value : undefined },
  );
  return changes.map((c) => c.path || "companion");
}

/**
 * Companion is read-only. Absent / null / {} / populated are distinct.
 * Structural equality (canonical JSON) allows pure reformatting.
 */
export function companionPolicy(
  beforeDoc: Record<string, unknown>,
  afterDoc: Record<string, unknown>,
): CompanionPolicyResult {
  const before = projectCompanion(beforeDoc);
  const after = projectCompanion(afterDoc);
  if (canonicalJson(before) === canonicalJson(after)) {
    return { ok: true };
  }
  const changedPaths = companionPaths(before, after);
  return {
    ok: false,
    changedPaths: changedPaths.length ? changedPaths : ["companion"],
  };
}

/**
 * Best-effort Companion projection from possibly invalid current text.
 * Returns `"unproven"` when the parse tree cannot establish whether
 * Companion is absent or unchanged.
 */
export function bestEffortCompanion(
  text: string,
): CompanionProjection | "unproven" {
  const parsed = parseOmoDocument(text, "jsonc");
  if (parsed.ok) return projectCompanion(parsed.document);
  const errors: { error: number; offset: number; length: number }[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true });
  if (!tree || tree.type !== "object") return "unproven";
  const node = findNodeAtLocation(tree, ["companion"]);
  if (!node) {
    const keys = (tree.children ?? [])
      .map((c) => c.children?.[0]?.value)
      .filter((v): v is string => typeof v === "string");
    if (keys.length === 0 && errors.length) return "unproven";
    return { present: false };
  }
  try {
    return { present: true, value: getNodeValue(node) };
  } catch {
    return "unproven";
  }
}

export function companionPolicyForRepair(
  beforeText: string,
  afterDoc: Record<string, unknown>,
): CompanionPolicyResult {
  const before = bestEffortCompanion(beforeText);
  if (before === "unproven") {
    return {
      ok: false,
      changedPaths: [
        "companion (unparseable current source; unchanged Companion cannot be proven)",
      ],
    };
  }
  const after = projectCompanion(afterDoc);
  if (canonicalJson(before) === canonicalJson(after)) return { ok: true };
  const changedPaths = companionPaths(before, after);
  return {
    ok: false,
    changedPaths: changedPaths.length ? changedPaths : ["companion"],
  };
}

function setNested(
  target: Record<string, unknown>,
  parts: string[],
  value: unknown,
): void {
  let cur: Record<string, unknown> = target;
  for (let i = 0; i < parts.length; i++) {
    const key = parts[i]!;
    if (i === parts.length - 1) {
      cur[key] = value;
      return;
    }
    const next = cur[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
}

/** Nested object of resolved property values for Effective diffs. */
export function effectiveValueTree(
  bundle: ProvenanceBundle,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [path, prop] of Object.entries(bundle.properties)) {
    if (!path) continue;
    setNested(out, path.split("."), prop.value);
  }
  return out;
}

function summaryFor(
  before: ProvenanceBundle,
  after: ProvenanceBundle,
  pred: (path: string) => boolean,
  label: string,
): RawSemanticSummary {
  const notes: string[] = [];
  const paths = new Set([
    ...Object.keys(before.properties),
    ...Object.keys(after.properties),
  ]);
  let changed = false;
  for (const path of [...paths].sort()) {
    if (!pred(path)) continue;
    const b = before.properties[path];
    const a = after.properties[path];
    if (canonicalJson(b?.value) === canonicalJson(a?.value)) continue;
    changed = true;
    notes.push(`${label}: ${path}`);
  }
  return { changed, notes };
}

export function rawSemanticSummaries(
  before: ProvenanceBundle,
  after: ProvenanceBundle,
): RawSemanticSummaries {
  const customBefore = new Set(
    Object.values(before.agents)
      .filter((a) => a.kind === "custom")
      .map((a) => a.name),
  );
  const customAfter = new Set(
    Object.values(after.agents)
      .filter((a) => a.kind === "custom")
      .map((a) => a.name),
  );
  const custom = new Set([...customBefore, ...customAfter]);
  return {
    capabilities: summaryFor(
      before,
      after,
      (p) =>
        p === "disabled_mcps" ||
        p === "disabled_skills" ||
        p === "disabled_tools" ||
        p === "disabled_agents" ||
        p.startsWith("disabled_mcps.") ||
        p.startsWith("disabled_skills.") ||
        p.startsWith("disabled_tools.") ||
        p.startsWith("disabled_agents."),
      "capabilities",
    ),
    prompts: {
      changed: Object.keys(before.prompts).some((name) => {
        const b = before.prompts[name];
        const a = after.prompts[name];
        return (
          b?.baseSource.path !== a?.baseSource.path ||
          b?.compositionRule !== a?.compositionRule ||
          canonicalJson(b?.appendSources) !== canonicalJson(a?.appendSources)
        );
      }),
      notes: Object.keys({ ...before.prompts, ...after.prompts })
        .filter((name) => {
          const b = before.prompts[name];
          const a = after.prompts[name];
          return (
            b?.baseSource.path !== a?.baseSource.path ||
            b?.compositionRule !== a?.compositionRule
          );
        })
        .map((name) => `prompts: ${name}`),
    },
    presets: summaryFor(
      before,
      after,
      (p) => p === "preset" || p.startsWith("presets."),
      "presets",
    ),
    council: summaryFor(before, after, (p) => p.startsWith("council."), "council"),
    acp: summaryFor(before, after, (p) => p.startsWith("acpAgents."), "acp"),
    interview: summaryFor(
      before,
      after,
      (p) => p.startsWith("interview."),
      "interview",
    ),
    customAgents: summaryFor(
      before,
      after,
      (p) => {
        if (!p.startsWith("agents.")) return false;
        const name = p.slice("agents.".length).split(".")[0] ?? "";
        return custom.has(name);
      },
      "custom-agent",
    ),
  };
}
