/**
 * Resolve authorized config write destinations.
 * Browser never supplies absolute paths.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConfigWriteScope } from "@omo/shared";
import { assertAuthorizedPath, type ServerConfig } from "../config";

export interface ResolvedWriteTarget {
  scope: ConfigWriteScope;
  path: string;
  exists: boolean;
  format: "json" | "jsonc";
}

function findExisting(baseNoExt: string): string | null {
  const jsonc = `${baseNoExt}.jsonc`;
  const json = `${baseNoExt}.json`;
  // Prefer whichever exists; if both, OMO prefers jsonc — edit that one
  if (existsSync(jsonc)) return jsonc;
  if (existsSync(json)) return json;
  return null;
}

export function resolveWriteTarget(
  cfg: ServerConfig,
  scope: ConfigWriteScope,
  opts?: { createIfMissing?: boolean; preferJsonc?: boolean },
): ResolvedWriteTarget {
  const preferJsonc = opts?.preferJsonc !== false;
  let base: string;
  if (scope === "user") {
    base = join(cfg.opencodeConfigDir, "oh-my-opencode-slim");
  } else {
    base = join(cfg.projectDirectory, ".opencode", "oh-my-opencode-slim");
  }

  const existing = findExisting(base);
  if (existing) {
    assertAuthorizedPath(existing, cfg.authorizedRoots);
    return {
      scope,
      path: existing,
      exists: true,
      format: existing.endsWith(".jsonc") ? "jsonc" : "json",
    };
  }

  // New file
  const path = preferJsonc ? `${base}.jsonc` : `${base}.json`;
  // Ensure parent dir is under authorized root
  const parent = dirname(path);
  assertAuthorizedPath(parent, cfg.authorizedRoots);
  assertAuthorizedPath(path, cfg.authorizedRoots);

  if (!opts?.createIfMissing) {
    return {
      scope,
      path,
      exists: false,
      format: preferJsonc ? "jsonc" : "json",
    };
  }

  return {
    scope,
    path,
    exists: false,
    format: preferJsonc ? "jsonc" : "json",
  };
}

/** Canonical path must stay under authorized roots (no traversal). */
export function assertSafeWritePath(path: string, roots: string[]): string {
  assertAuthorizedPath(path, roots);
  let canonical = path;
  try {
    if (existsSync(path)) canonical = realpathSync(path);
    else {
      // resolve parent
      const parent = dirname(path);
      if (existsSync(parent)) {
        canonical = join(realpathSync(parent), path.split("/").pop()!);
      }
    }
  } catch {
    /* use original */
  }
  assertAuthorizedPath(canonical, roots);
  // Double-check no .. segments escape
  if (path.includes("..")) {
    throw new Error("Path traversal rejected");
  }
  return canonical;
}
