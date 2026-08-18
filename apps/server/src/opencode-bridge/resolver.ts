/**
 * Slice 17 hardened — Authorized candidate resolver + candidate gate.
 *
 * Oracle decision 2 (blocking fix): compare every valid authorized
 * candidate with a plugin property against the sanitized effective plugin
 * sequence first; require exactly one exact match. Do NOT reject merely
 * because both json/jsonc exist. Zero/multiple matches block.
 * Malformed/symlink/scope-escaping candidate errors conservatively block
 * provenance rather than being ignored.
 *
 * Oracle decision 5: source entry has lexical/normalized identity, form,
 * identityKind, allowlisted bridge options, span. Effective entry has
 * form/effectiveIdentity/identityKind/bridge fingerprint.
 *
 * Oracle decision 12: no raw plugin identities in errors. SourceKind from
 * candidate.kind not substring classification.
 */

import { existsSync, realpathSync, readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { parseTree, findNodeAtLocation, getNodeValue, type Node } from "jsonc-parser";
import { createHash } from "node:crypto";
import type {
  BridgeAdvisory,
  BridgeError,
  ConfigSourceKind,
  EffectivePluginView,
  ResolverResult,
  SourceCandidate,
  SourcePluginEntry,
  IdentityKind,
  PluginForm,
  BridgeOptions,
} from "./types";
import {
  detectIdentityKind,
  normalizePathIdentity,
  isWithinRoots,
  realpathRoots,
  realpathIfExists,
  arePluginEntriesEquivalent,
} from "./canonical";
import { parseBridgeOptions } from "./extractor";

export interface ResolverOptions {
  opencodeConfigDir: string;
  /** Target OpenCode/OMO project root (candidate sources, project-local state). */
  projectDirectory: string;
  /**
   * Owl install root. Canonical bridge identity for source↔effective
   * equivalence is `<owlInstallDirectory>/packages/omo-telemetry-bridge`,
   * independent of the target project directory.
   */
  owlInstallDirectory: string;
  authorizedRoots: string[];
}

interface CandidateCheckResult {
  candidate?: SourceCandidate;
  error?: BridgeError;
  advisory?: BridgeAdvisory;
}

/**
 * Resolve all authorized source candidates (config-dir + project-root,
 * both .json and .jsonc). Returns candidates that exist, parse, and are
 * under authorized roots with no symlink escape.
 *
 * Malformed/symlink/scope-escaping candidate errors are collected and
 * conservatively block provenance.
 */
export function resolveSourceCandidates(
  opts: ResolverOptions,
): { candidates: SourceCandidate[]; errors: BridgeError[]; advisories: BridgeAdvisory[] } {
  const errors: BridgeError[] = [];
  const advisories: BridgeAdvisory[] = [];
  const candidates: SourceCandidate[] = [];

  const realRoots = realpathRoots(opts.authorizedRoots);
  const realConfigDir = realpathIfExists(opts.opencodeConfigDir);
  const realProjectDir = realpathIfExists(opts.projectDirectory);

  const bases: Array<{ base: string; kind: ConfigSourceKind }> = [
    { base: join(realConfigDir, "opencode"), kind: "opencode-config-dir" },
    { base: join(realProjectDir, "opencode"), kind: "project-root" },
  ];

  for (const { base, kind } of bases) {
    for (const ext of [".json", ".jsonc"] as const) {
      const path = `${base}${ext}`;
      const checked = checkCandidate(path, realRoots, kind);
      if (checked.advisory) advisories.push(checked.advisory);
      if (checked.error) {
        errors.push(checked.error);
        continue;
      }
      if (checked.candidate) candidates.push(checked.candidate);
    }
  }

  return { candidates, errors, advisories };
}

function checkCandidate(path: string, roots: string[], kind: ConfigSourceKind): CandidateCheckResult {
  // Lexical authorization (no FS).
  if (!isWithinRoots(path, roots)) {
    return { error: { code: "env-scope-unproven", message: "Candidate path outside authorized roots." } };
  }

  if (!existsSync(path)) return {}; // absent is not an error

  // Symlink check on the file itself.
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const real = realpathSync(path);
      if (!isWithinRoots(real, roots)) {
        return {
          advisory: { kind: "symlink-escape", message: "Candidate file is a symlink escaping authorized roots." },
          error: { code: "env-scope-unproven", message: "Candidate symlink escapes authorized roots." },
        };
      }
      // Use realpath for the candidate path.
      path = real;
    }
  } catch {
    return { error: { code: "source-unproven", message: "Candidate stat failed." } };
  }

  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return { error: { code: "source-unproven", message: "Candidate read failed." } };
  }

  const parseResult = parseCandidateText(text);
  if (parseResult.error) return { error: parseResult.error };

  const pluginEntries = extractSourcePluginEntries(text, parseResult.root!);
  if (pluginEntries.error) return { error: pluginEntries.error };

  const hash = createHash("sha256").update(text).digest("hex");
  return {
    candidate: {
      root: roots.find((r) => isWithinRoots(path, [r])) ?? roots[0]!,
      path,
      kind,
      format: path.endsWith(".jsonc") ? "jsonc" : "json",
      text,
      hash,
      pluginEntries: pluginEntries.entries!,
    },
  };
}

function parseCandidateText(text: string): { root?: Node; error?: BridgeError } {
  const errors: { error: number; offset: number; length: number }[] = [];
  const root = parseTree(text, errors as never, { allowTrailingComma: true });
  if (errors.length) {
    return { error: { code: "source-unproven", message: `JSONC parse error at offset ${errors[0]!.offset}.` } };
  }
  if (!root) {
    return { error: { code: "source-unproven", message: "Empty/unparseable config." } };
  }
  return { root };
}

/**
 * Extract plugin entries from source text with AST offset spans.
 * Oracle decision 5: string | [string, options]. Remove {path, options}.
 */
function extractSourcePluginEntries(
  text: string,
  root: Node,
): { entries?: SourcePluginEntry[]; error?: BridgeError } {
  const pluginNode = findNodeAtLocation(root, ["plugin"]);
  if (!pluginNode) return { entries: [] };
  if (pluginNode.type !== "array") {
    return { error: { code: "plugin-shape-unsupported", message: "plugin property is not an array in source." } };
  }

  const entries: SourcePluginEntry[] = [];
  const children = pluginNode.children ?? [];
  for (const child of children) {
    if (!child) continue;
    const value = getNodeValue(child);

    if (typeof value === "string") {
      const identityKind = detectIdentityKind(value);
      if (identityKind === null) {
        return { error: { code: "plugin-shape-unsupported", message: "Source plugin entry string has unrecognized identity kind." } };
      }
      const norm = normalizePathIdentity(value, ["/"]); // roots not needed for npm
      entries.push({
        form: "string" as PluginForm,
        identity: value,
        normalizedIdentity: norm.path ?? value,
        identityKind,
        offset: child.offset,
        length: child.length,
      });
    } else if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && isPlainObject(value[1])) {
      const identity = value[0] as string;
      const options = value[1] as Record<string, unknown>;
      const identityKind = detectIdentityKind(identity);
      if (identityKind === null) {
        return { error: { code: "plugin-shape-unsupported", message: "Source plugin tuple identity has unrecognized kind." } };
      }
      const norm = normalizePathIdentity(identity, ["/"]);
      const bridgeOpts = parseBridgeOptions(options);
      entries.push({
        form: "tuple" as PluginForm,
        identity,
        normalizedIdentity: norm.path ?? identity,
        identityKind,
        bridgeOptions: Object.keys(bridgeOpts).length > 0 ? bridgeOpts : undefined,
        offset: child.offset,
        length: child.length,
      });
    } else {
      return { error: { code: "plugin-shape-unsupported", message: "Source plugin entry is not string or tuple." } };
    }
  }
  return { entries };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * PURE source-candidate snapshot parser: text → parsed plugin entries with
 * no filesystem access. Combines parseCandidateText +
 * extractSourcePluginEntries with identical semantics. Used by the strict
 * drift inventory over already-read snapshots; ordinary resolver behavior is
 * unchanged.
 */
export function parseSourceCandidateSnapshot(
  text: string,
): { entries: SourcePluginEntry[] } | { error: BridgeError } {
  const parsed = parseCandidateText(text);
  if (parsed.error !== undefined || parsed.root === undefined) {
    return {
      error: parsed.error ?? {
        code: "source-unproven",
        message: "Empty/unparseable config.",
      },
    };
  }
  const extracted = extractSourcePluginEntries(text, parsed.root);
  if (extracted.error !== undefined || extracted.entries === undefined) {
    return {
      error: extracted.error ?? {
        code: "plugin-shape-unsupported",
        message: "Source plugin entries could not be extracted.",
      },
    };
  }
  return { entries: extracted.entries };
}

/**
 * DRIFT-STRICT snapshot parser (Oracle drift correction). Used ONLY by the
 * drift-acceptance inventory; the ordinary resolver path above is unchanged.
 *
 * Strict rules:
 *  1. The root AST node must be exactly an object (array/scalar roots
 *     rejected).
 *  2. Top-level property nodes are enumerated BEFORE any plugin lookup;
 *     EVERY duplicate top-level property name is rejected (including a
 *     duplicate `plugin`) — never relying on runtime first/last-wins
 *     semantics.
 *  3. Only after strict root/unique-key validation are supported plugin
 *     entries extracted (same shape rules as the ordinary parser).
 *
 * Errors carry stable codes and redacted messages only — never raw
 * candidate contents or identities.
 */
export function parseDriftCandidateSnapshot(
  text: string,
): { entries: SourcePluginEntry[] } | { error: BridgeError } {
  const errors: { error: number; offset: number; length: number }[] = [];
  const root = parseTree(text, errors as never, { allowTrailingComma: true });
  if (errors.length) {
    return { error: { code: "source-unproven", message: "Candidate content is not parseable." } };
  }
  if (!root || root.type !== "object") {
    return { error: { code: "source-unproven", message: "Candidate root is not an object." } };
  }
  const seen = new Set<string>();
  for (const child of root.children ?? []) {
    if (!child || child.type !== "property") continue;
    const keyNode = child.children?.[0];
    const name = keyNode !== undefined ? String(getNodeValue(keyNode)) : "";
    if (seen.has(name)) {
      return {
        error: { code: "source-unproven", message: "Candidate has duplicate top-level keys." },
      };
    }
    seen.add(name);
  }
  return parseSourceCandidateSnapshot(text);
}

/**
 * Candidate gate + source-proven predicate.
 *
 * Oracle decision 2: compare every valid authorized candidate with a
 * plugin property against the sanitized effective plugin sequence first;
 * require exactly one exact match. Do NOT reject merely because both
 * json/jsonc exist. Zero/multiple matches block.
 *
 * Exact match = exact ordered (form, effectiveIdentity/identity, identityKind)
 * sequence match between source and effective.
 */
export function resolveAuthorizedCandidate(
  opts: ResolverOptions,
  effectiveView: EffectivePluginView,
): ResolverResult {
  const { candidates, errors, advisories } = resolveSourceCandidates(opts);
  const allErrors = [...errors];

  for (const a of advisories) {
    if (a.kind === "symlink-escape" || a.kind === "root-escape") {
      allErrors.push({ code: "env-scope-unproven", message: a.message });
    }
  }

  if (effectiveView.unavailable || effectiveView.invalid) {
    allErrors.push({ code: "source-unproven", message: "Effective plugin view unavailable or invalid." });
    return { status: "blocked", errors: allErrors };
  }

  if (candidates.length === 0) {
    allErrors.push({ code: "source-unproven", message: "No authorized source candidate found." });
    return { status: "blocked", errors: allErrors };
  }

  // Compare every candidate against the effective view. Require exactly
  // one exact match. Canonical bridge equivalence uses the Owl install
  // root, not the target project directory.
  const matches: SourceCandidate[] = [];
  for (const candidate of candidates) {
    const match = exactSequenceMatch(
      candidate.pluginEntries,
      effectiveView.entries,
      opts.owlInstallDirectory,
      opts.authorizedRoots,
    );
    if (match.ok) {
      matches.push(candidate);
    }
  }

  if (matches.length === 0) {
    allErrors.push({ code: "source-unproven", message: "No source candidate matches the effective plugin sequence." });
    return { status: "blocked", errors: allErrors };
  }

  if (matches.length > 1) {
    allErrors.push({ code: "config-ambiguous", message: `Multiple source candidates match the effective plugin sequence (${matches.length}).` });
    return { status: "blocked", errors: allErrors };
  }

  const candidate = matches[0]!;

  // Find the bridge entry (if any) for management.
  const effectiveBridge = effectiveView.entries.find((e) => e.bridge);

  if (!effectiveBridge) {
    return { status: "proven", candidate, bridgeEntry: null };
  }

  // Multiple bridge entries in effective view → duplicate-effective.
  const effectiveBridges = effectiveView.entries.filter((e) => e.bridge);
  if (effectiveBridges.length > 1) {
    allErrors.push({ code: "duplicate-effective", message: `Multiple bridge entries in effective view (${effectiveBridges.length}).` });
    return { status: "blocked", errors: allErrors };
  }

  // Find the corresponding source entry by canonical equivalence.
  const sourceBridge = candidate.pluginEntries.find((e) =>
    arePluginEntriesEquivalent(
      { identity: e.identity, identityKind: e.identityKind, form: e.form },
      { identity: effectiveBridge.effectiveIdentity, identityKind: effectiveBridge.identityKind, form: effectiveBridge.form },
      opts.owlInstallDirectory,
      opts.authorizedRoots,
    ),
  );
  if (!sourceBridge) {
    allErrors.push({ code: "source-unproven", message: "Bridge entry present in effective view but not in source." });
    return { status: "blocked", errors: allErrors };
  }

  // Duplicate bridge entries in source → duplicate-config.
  const sourceBridges = candidate.pluginEntries.filter((e) =>
    arePluginEntriesEquivalent(
      { identity: e.identity, identityKind: e.identityKind, form: e.form },
      { identity: effectiveBridge.effectiveIdentity, identityKind: effectiveBridge.identityKind, form: effectiveBridge.form },
      opts.owlInstallDirectory,
      opts.authorizedRoots,
    ),
  );
  if (sourceBridges.length > 1) {
    allErrors.push({ code: "duplicate-config", message: `Duplicate bridge entries in source (${sourceBridges.length}).` });
    return { status: "blocked", errors: allErrors };
  }

  return { status: "proven", candidate, bridgeEntry: sourceBridge };
}

/**
 * Exact ordered sequence match between source and effective plugin entries.
 * Uses canonical bridge equivalence (against the Owl install root) for the
 * managed bridge, and exact lexical match for ordinary plugins.
 */
function exactSequenceMatch(
  source: SourcePluginEntry[],
  effective: EffectivePluginView["entries"],
  owlInstallRoot: string,
  authorizedRoots: string[],
): { ok: true } | { ok: false } {
  if (source.length !== effective.length) return { ok: false };
  for (let i = 0; i < source.length; i++) {
    const s = source[i]!;
    const e = effective[i]!;
    if (s.form !== e.form) return { ok: false };
    if (
      !arePluginEntriesEquivalent(
        { identity: s.identity, identityKind: s.identityKind, form: s.form },
        { identity: e.effectiveIdentity, identityKind: e.identityKind, form: e.form },
        owlInstallRoot,
        authorizedRoots,
      )
    ) {
      return { ok: false };
    }
  }
  return { ok: true };
}

// ── Advisory remote schema (never authority) ──────────────────────────

export async function fetchAdvisoryRemoteSchema(
  fetchImpl: typeof fetch = fetch,
): Promise<BridgeAdvisory[]> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetchImpl("https://opencode.ai/config.json", {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timer);
    if (!res.ok) {
      return [{ kind: "remote-schema", message: `Advisory remote schema unreachable (HTTP ${res.status}). Not an authority.` }];
    }
    return [{ kind: "remote-schema", message: "Advisory remote schema reachable. Not an authority for writes." }];
  } catch {
    return [{ kind: "remote-schema", message: "Advisory remote schema fetch failed. Not an authority." }];
  }
}