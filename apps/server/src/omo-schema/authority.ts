/**
 * Installed OMO-Slim schema authority (Slice 18 D0).
 *
 * Resolution is restricted to the authorized OpenCode config directory
 * (`loadServerConfig().opencodeConfigDir` / `SchemaContext.opencodeConfigDir`)
 * plus explicit test overrides. The config `$schema` URL is never fetched.
 *
 * Fail-closed: missing/unreadable/unauthorized package or schema closes
 * write capability. Reads and status remain available.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import {
  assertAuthorizedPath,
  isWithinAuthorizedRoots,
  type ServerConfig,
} from "../config";
import type { SchemaContext } from "./types";

export const INSTALLED_PACKAGE_NAME = "oh-my-opencode-slim";
export const INSTALLED_SCHEMA_BASENAME = "oh-my-opencode-slim.schema.json";

export interface InstalledSchemaSnapshot {
  available: true;
  packageName: string;
  packageVersion: string;
  schemaPath: string;
  packageManifestPath: string;
  schemaHash: string;
  cacheKey: string;
  schemaText: string;
  schema: Record<string, unknown>;
}

export interface InstalledSchemaUnavailable {
  available: false;
  error: string;
  schemaPath?: string;
  packageManifestPath?: string;
  packageVersion?: string;
  schemaHash?: string;
  cacheKey?: string;
}

export type InstalledSchemaAuthority =
  | InstalledSchemaSnapshot
  | InstalledSchemaUnavailable;

export interface InstalledSchemaDocument {
  available: true;
  packageVersion: string;
  schemaHash: string;
  cacheKey: string;
  schema: Record<string, unknown>;
}

export interface InstalledSchemaDocumentUnavailable {
  available: false;
  error: string;
  packageVersion?: string;
  schemaHash?: string;
  cacheKey?: string;
}

export type InstalledSchemaDocumentResult =
  | InstalledSchemaDocument
  | InstalledSchemaDocumentUnavailable;

const snapshotCache = new Map<string, InstalledSchemaAuthority>();
const MAX_SNAPSHOT_CACHE = 16;
let schemaGeneration = 0;
const generationByCacheKey = new Map<string, number>();

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function publicSchemaCacheKey(
  packageVersion: string | undefined,
  schemaHash: string,
): string {
  return `${INSTALLED_PACKAGE_NAME}@${packageVersion ?? "unknown"}-${schemaHash}`;
}

export function schemaGenerationFor(cacheKey: string): number {
  const existing = generationByCacheKey.get(cacheKey);
  if (existing !== undefined) return existing;
  schemaGeneration += 1;
  generationByCacheKey.set(cacheKey, schemaGeneration);
  return schemaGeneration;
}

function authorizePath(path: string, roots: string[]): string {
  if (path.includes("..")) {
    throw new Error("Path traversal rejected");
  }
  // Lexical containment FIRST — never stat/read an unauthorized path.
  assertAuthorizedPath(path, roots);
  let canonical = path;
  try {
    if (existsSync(path)) canonical = realpathSync(path);
  } catch {
    /* use original */
  }
  assertAuthorizedPath(canonical, roots);
  return canonical;
}

function authorizedRootsFor(
  ctx: SchemaContext,
  cfg?: ServerConfig,
): string[] | undefined {
  if (cfg?.authorizedRoots?.length) return cfg.authorizedRoots;
  if (ctx.authorizedRoots?.length) return ctx.authorizedRoots;
  if (ctx.opencodeConfigDir) return [ctx.opencodeConfigDir];
  return undefined;
}

function resolveInstalledPaths(
  ctx: SchemaContext,
): { schemaPath: string; packageManifestPath: string } | { error: string } {
  const envPath = process.env.OMO_SCHEMA_PATH?.trim();
  if (ctx.schemaPath || envPath) {
    const schemaPath = ctx.schemaPath ?? envPath!;
    return {
      schemaPath,
      packageManifestPath: join(dirname(schemaPath), "package.json"),
    };
  }
  if (!ctx.opencodeConfigDir) {
    return {
      error: "No schema location resolvable (no opencodeConfigDir given)",
    };
  }
  const pkgDir = join(
    ctx.opencodeConfigDir,
    "node_modules",
    INSTALLED_PACKAGE_NAME,
  );
  return {
    schemaPath: join(pkgDir, INSTALLED_SCHEMA_BASENAME),
    packageManifestPath: join(pkgDir, "package.json"),
  };
}

function readPackageVersion(manifestPath: string): string | undefined {
  try {
    if (!existsSync(manifestPath)) return undefined;
    const pkg = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      name?: string;
      version?: string;
    };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

function unavailable(
  error: string,
  extra: Partial<InstalledSchemaUnavailable> = {},
): InstalledSchemaUnavailable {
  return { available: false, error, ...extra };
}

/**
 * Load the authorized installed schema snapshot. Never fetches `$schema`.
 * Re-reads package + schema bytes on every call; compiled identity is
 * keyed by path|version|hash so version or in-place schema change
 * automatically produces a new cache key.
 */
export function loadInstalledSchema(
  ctx: SchemaContext = {},
  cfg?: ServerConfig,
): InstalledSchemaAuthority {
  const resolved = resolveInstalledPaths(ctx);
  if ("error" in resolved) return unavailable(resolved.error);

  const roots = authorizedRootsFor(ctx, cfg);
  let schemaPath = resolved.schemaPath;
  let packageManifestPath = resolved.packageManifestPath;

  // When authorized roots are present, EVERY resolution path — package
  // discovery and explicit schemaPath / OMO_SCHEMA_PATH — is lexically
  // authorized before exists/stat/read. Tests must include fixture roots.
  if (roots) {
    try {
      schemaPath = authorizePath(schemaPath, roots);
      assertAuthorizedPath(packageManifestPath, roots);
      if (existsSync(packageManifestPath)) {
        packageManifestPath = authorizePath(packageManifestPath, roots);
      }
    } catch (e) {
      return unavailable(
        `Filesystem path outside authorized scope: ${
          e instanceof Error ? e.message : String(e)
        }`,
        { schemaPath, packageManifestPath },
      );
    }
  }

  const packageVersion =
    ctx.packageVersion ??
    process.env.OMO_SCHEMA_PACKAGE_VERSION?.trim() ??
    readPackageVersion(packageManifestPath);

  let schemaText: string;
  try {
    if (!existsSync(schemaPath)) {
      return unavailable(`Schema file not found: ${schemaPath}`, {
        schemaPath,
        packageManifestPath,
        packageVersion,
      });
    }
    if (roots && !isWithinAuthorizedRoots(schemaPath, roots)) {
      return unavailable(
        `Schema file outside authorized scope: ${schemaPath}`,
        { schemaPath, packageManifestPath, packageVersion },
      );
    }
    schemaText = readFileSync(schemaPath, "utf-8");
  } catch (e) {
    return unavailable(
      `Schema file unreadable: ${e instanceof Error ? e.message : String(e)}`,
      { schemaPath, packageManifestPath, packageVersion },
    );
  }

  const schemaHash = sha256(schemaText);
  const cacheKey = publicSchemaCacheKey(packageVersion, schemaHash);
  const identityKey = `${schemaPath}|${packageVersion ?? ""}|${schemaHash}`;
  const cached = snapshotCache.get(identityKey);
  if (cached?.available) return cached;

  let schema: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(schemaText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return unavailable("Installed schema root must be an object", {
        schemaPath,
        packageManifestPath,
        packageVersion,
        schemaHash,
        cacheKey,
      });
    }
    schema = parsed as Record<string, unknown>;
  } catch (e) {
    return unavailable(
      `Installed schema is not valid JSON: ${
        e instanceof Error ? e.message : String(e)
      }`,
      {
        schemaPath,
        packageManifestPath,
        packageVersion,
        schemaHash,
        cacheKey,
      },
    );
  }

  const snapshot: InstalledSchemaSnapshot = {
    available: true,
    packageName: INSTALLED_PACKAGE_NAME,
    packageVersion: packageVersion ?? "unknown",
    schemaPath,
    packageManifestPath,
    schemaHash,
    cacheKey,
    schemaText,
    schema,
  };
  snapshotCache.set(identityKey, snapshot);
  if (snapshotCache.size > MAX_SNAPSHOT_CACHE) {
    const oldest = snapshotCache.keys().next().value;
    if (oldest) snapshotCache.delete(oldest);
  }
  return snapshot;
}

/** Document payload for GET /api/omo/schema/document. Never includes remote fetch. */
export function getInstalledSchemaDocument(
  ctx: SchemaContext = {},
  cfg?: ServerConfig,
): InstalledSchemaDocumentResult {
  const snap = loadInstalledSchema(ctx, cfg);
  if (!snap.available) {
    return {
      available: false,
      error: snap.error,
      packageVersion: snap.packageVersion,
      schemaHash: snap.schemaHash,
      cacheKey: snap.cacheKey,
    };
  }
  return {
    available: true,
    packageVersion: snap.packageVersion,
    schemaHash: snap.schemaHash,
    cacheKey: snap.cacheKey,
    schema: snap.schema,
  };
}

/** Test-only: drop cached snapshots. */
export function _clearAuthorityCache(): void {
  snapshotCache.clear();
}
