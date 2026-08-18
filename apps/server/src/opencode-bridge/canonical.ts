/**
 * Slice 17 hardened — Canonical managed bridge identity normalization.
 *
 * The managed telemetry bridge lives at a fixed realpath under the Owl
 * install root's `packages/omo-telemetry-bridge` (NOT under the target
 * OpenCode/OMO project). Only absolute paths or file:// URLs that resolve
 * to that exact realpath are recognized as the managed bridge.
 * Relative/npm/ambiguous bridge-looking identities block management.
 *
 * Oracle decision 5: identity kind (npm|path|file-url) is separate from
 * form (string|tuple). Canonical detection by authorized-root realpath,
 * not by options.
 */

import { realpathSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { BridgeAdvisory, BridgeError, IdentityKind } from "./types";

/**
 * Compute the canonical managed bridge directory realpath from the Owl
 * install root. The bridge package is installed at
 * `<owlInstallDirectory>/packages/omo-telemetry-bridge`; the target
 * project directory is irrelevant to bridge package identity.
 */
export function canonicalBridgeDir(owlInstallRoot: string): string {
  const joined = resolvePath(owlInstallRoot, "packages", "omo-telemetry-bridge");
  try {
    if (existsSync(joined)) return realpathSync(joined);
  } catch {
    /* fall through */
  }
  return joined;
}

/**
 * Detect the identity kind from a lexical identity string. Does NOT
 * touch the filesystem.
 *
 * Oracle decision 5 / Defect 9:
 * Relative paths are a path form for lexical source matching, but unresolved
 * for canonical bridge equivalence. Unrelated valid relative plugins
 * (e.g. ./scripts/foo.js) are recognized as "path" and not rejected outright.
 */
export function detectIdentityKind(identity: string): IdentityKind | null {
  const trimmed = identity.trim();
  if (trimmed.startsWith("file://")) return "file-url";
  if (isAbsolute(trimmed)) return "path";
  if (
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith(".\\") ||
    trimmed.startsWith("..\\")
  ) {
    return "path";
  }
  // npm package: scoped or bare, optionally with @version.
  if (/^@?[a-zA-Z0-9][a-zA-Z0-9._-]*(\/[a-zA-Z0-9._-]+)?(@[^/]+)?$/.test(trimmed)) {
    return "npm";
  }
  // Other relative or filesystem paths with separators / extensions
  if (trimmed.includes("/") || trimmed.includes("\\") || /\.(?:[cm]?[jt]sx?|json)$/i.test(trimmed)) {
    return "path";
  }
  return null;
}

/**
 * Normalize an identity string into an absolute filesystem path.
 * Only path and file-url identities are normalizable. npm/relative/
 * ambiguous return null.
 */
export function normalizePathIdentity(
  identity: string,
  authorizedRoots: string[],
): { path: string } | { path: null; reason: "not-path-like" | "outside-roots" } {
  const trimmed = identity.trim();
  let candidate: string;

  if (trimmed.startsWith("file://")) {
    try {
      candidate = fileURLToPath(trimmed);
    } catch {
      return { path: null, reason: "not-path-like" };
    }
  } else if (isAbsolute(trimmed)) {
    candidate = trimmed;
  } else {
    return { path: null, reason: "not-path-like" };
  }

  candidate = candidate.replace(/\/+$/, "");

  if (!isWithinRoots(candidate, authorizedRoots)) {
    return { path: null, reason: "outside-roots" };
  }

  return { path: candidate };
}

export interface CanonicalBridgeResult {
  isCanonical: boolean;
  isBridgeLikeButNotCanonical: boolean;
  realpath: string | null;
  advisories: BridgeAdvisory[];
  errors: BridgeError[];
}

export function resolveCanonicalBridge(
  identity: string,
  owlInstallRoot: string,
  authorizedRoots: string[],
): CanonicalBridgeResult {
  const advisories: BridgeAdvisory[] = [];
  const errors: BridgeError[] = [];
  const canonicalDir = canonicalBridgeDir(owlInstallRoot);
  const isBridgeName =
    identity.includes("omo-telemetry-bridge") ||
    identity.includes("telemetry-bridge") ||
    identity.includes("omo-bridge");

  const normalized = normalizePathIdentity(identity, authorizedRoots);
  if (normalized.path === null) {
    if (normalized.reason === "outside-roots") {
      advisories.push({
        kind: "root-escape",
        message: "Bridge-looking identity resolves outside authorized roots.",
      });
      if (isBridgeName) {
        errors.push({ code: "env-scope-unproven", message: "Bridge-looking identity resolves outside authorized roots." });
      }
    } else if (isBridgeName) {
      advisories.push({
        kind: "ambiguous-path",
        message: "Bridge-looking relative or non-path identity is unmanaged.",
      });
    }
    return {
      isCanonical: false,
      isBridgeLikeButNotCanonical: isBridgeName,
      realpath: null,
      advisories,
      errors,
    };
  }

  let realpath: string;
  try {
    if (!existsSync(normalized.path)) {
      return {
        isCanonical: false,
        isBridgeLikeButNotCanonical: isBridgeName,
        realpath: null,
        advisories,
        errors,
      };
    }
    realpath = realpathSync(normalized.path);
  } catch {
    return {
      isCanonical: false,
      isBridgeLikeButNotCanonical: isBridgeName,
      realpath: null,
      advisories,
      errors,
    };
  }

  const realRoots = realpathRoots(authorizedRoots);
  if (!isWithinRoots(realpath, realRoots)) {
    advisories.push({ kind: "symlink-escape", message: "Bridge identity realpath escapes authorized roots." });
    errors.push({ code: "env-scope-unproven", message: "Bridge identity realpath escapes authorized roots." });
    return { isCanonical: false, isBridgeLikeButNotCanonical: true, realpath, advisories, errors };
  }

  let canonicalReal: string;
  try {
    canonicalReal = existsSync(canonicalDir) ? realpathSync(canonicalDir) : canonicalDir;
  } catch {
    canonicalReal = canonicalDir;
  }

  const isCanonical = realpath === canonicalReal;
  return {
    isCanonical,
    isBridgeLikeButNotCanonical: isCanonical ? false : isBridgeName,
    realpath,
    advisories,
    errors,
  };
}

/**
 * Detect duplicate/equivalent bridge entries within a list of identities.
 * Two entries are equivalent when their realpaths match the canonical
 * bridge dir. Does NOT auto-delete — only reports.
 */
export function detectDuplicateBridgeEntries(
  identities: string[],
  owlInstallRoot: string,
  authorizedRoots: string[],
): { canonicalCount: number; equivalentIndices: number[] } {
  const canonicalDir = canonicalBridgeDir(owlInstallRoot);
  let canonicalReal: string;
  try {
    canonicalReal = existsSync(canonicalDir) ? realpathSync(canonicalDir) : canonicalDir;
  } catch {
    canonicalReal = canonicalDir;
  }

  const equivalentIndices: number[] = [];
  for (let i = 0; i < identities.length; i++) {
    const id = identities[i]!;
    const norm = normalizePathIdentity(id, authorizedRoots);
    if (norm.path === null) continue;
    try {
      if (!existsSync(norm.path)) continue;
      const rp = realpathSync(norm.path);
      if (rp === canonicalReal) equivalentIndices.push(i);
    } catch {
      /* skip */
    }
  }
  return { canonicalCount: equivalentIndices.length, equivalentIndices };
}

/**
 * Check whether two plugin entries (from source and/or effective view) are
 * equivalent.
 *
 * Rules:
 * 1. Form (string vs tuple) must match when forms are known.
 * 2. Exact lexical identity + identityKind match is equivalent for any plugin.
 * 3. FOR THE ONE MANAGED CANONICAL BRIDGE ONLY: source and effective entries
 *    with distinct lexical forms (path ↔ file-url, or reverse) are equivalent
 *    IFF BOTH independently resolve through `resolveCanonicalBridge` to the
 *    exact canonical package realpath under the Owl install root and
 *    authorized roots.
 * 4. Arbitrary non-canonical path/file-url identities do NOT become equivalent.
 * 5. Relative/escaping/malformed/unresolvable identities fail closed (return false).
 */
export function arePluginEntriesEquivalent(
  entryA: { identity: string; identityKind: IdentityKind; form?: string },
  entryB: { identity: string; identityKind: IdentityKind; form?: string },
  owlInstallRoot: string,
  authorizedRoots: string[],
): boolean {
  if (entryA.form !== undefined && entryB.form !== undefined && entryA.form !== entryB.form) {
    return false;
  }
  if (entryA.identity === entryB.identity && entryA.identityKind === entryB.identityKind) {
    return true;
  }
  // Canonical bridge equivalence across path ↔ file-url
  if (
    (entryA.identityKind === "path" || entryA.identityKind === "file-url") &&
    (entryB.identityKind === "path" || entryB.identityKind === "file-url")
  ) {
    const resA = resolveCanonicalBridge(entryA.identity, owlInstallRoot, authorizedRoots);
    if (!resA.isCanonical || resA.realpath === null) return false;
    const resB = resolveCanonicalBridge(entryB.identity, owlInstallRoot, authorizedRoots);
    if (!resB.isCanonical || resB.realpath === null) return false;
    return resA.realpath === resB.realpath;
  }
  return false;
}

// ── Internal helpers ──────────────────────────────────────────────────

export function isWithinRoots(path: string, roots: string[]): boolean {
  const normalized = path.replace(/\\/g, "/");
  return roots.some((root) => {
    const r = root.replace(/\\/g, "/").replace(/\/$/, "");
    return normalized === r || normalized.startsWith(r + "/");
  });
}

export function realpathRoots(roots: string[]): string[] {
  return roots.map((r) => {
    try {
      if (existsSync(r)) return realpathSync(r);
    } catch {
      /* fall through */
    }
    return r;
  });
}

export function realpathIfExists(p: string): string {
  try {
    if (existsSync(p)) return realpathSync(p);
  } catch {
    /* fall through */
  }
  return p;
}