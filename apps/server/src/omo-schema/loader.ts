/**
 * Installed-schema loader + compiled-validator cache.
 *
 * Resolution is owned by `authority.ts` (authorized OpenCode config dir,
 * lexical path enforcement, no remote `$schema` fetch). This module compiles
 * AJV validators from the authorized snapshot.
 *
 * Cache / invalidation: the raw schema bytes and the sibling package.json
 * version are re-read on EVERY getValidator() call (cheap — the schema is
 * ~40KB), and the sha256 of the bytes is computed. The COMPILED AJV validator
 * is cached keyed by `schemaPath | version | hash`. Any change to the
 * installed package (version bump OR in-place schema rewrite) therefore
 * produces a fresh compile automatically — no file watchers needed. The
 * process can run indefinitely without going stale.
 *
 * Fail-closed: if the package.json or schema file is missing/unreadable/
 * unauthorized/invalid JSON, or AJV fails to compile it, the handle is
 * `available: false` and all config writes must refuse to write.
 */

import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";
import { loadInstalledSchema } from "./authority";
import type { SchemaContext, SchemaValidatorHandle } from "./types";

type CompiledRun = (doc: unknown) => ErrorObject[] | null;

/** schemaPath|version|hash → compiled validator runner */
const compiledCache = new Map<string, CompiledRun>();
const MAX_CACHE_ENTRIES = 16;

export function getValidator(ctx: SchemaContext = {}): SchemaValidatorHandle {
  const snap = loadInstalledSchema(ctx);
  if (!snap.available) {
    return {
      available: false,
      schemaPath: snap.schemaPath,
      packageVersion: snap.packageVersion,
      schemaHash: snap.schemaHash,
      cacheKey: snap.cacheKey,
      error: snap.error,
    };
  }

  const compileKey = `${snap.schemaPath}|${snap.packageVersion}|${snap.schemaHash}`;
  let run = compiledCache.get(compileKey);

  if (!run) {
    try {
      const ajv = new Ajv2020({
        allErrors: true,
        // Third-party schema: tolerate unknown keywords/formats instead of throwing.
        strict: false,
        validateSchema: false,
        allowUnionTypes: true,
      });
      const validate = ajv.compile(snap.schema);
      run = (doc: unknown): ErrorObject[] | null => {
        const ok = validate(doc);
        return ok ? null : ((validate.errors ?? []) as ErrorObject[]);
      };
      compiledCache.set(compileKey, run);
      if (compiledCache.size > MAX_CACHE_ENTRIES) {
        const oldest = compiledCache.keys().next().value;
        if (oldest) compiledCache.delete(oldest);
      }
    } catch (e) {
      return {
        available: false,
        schemaPath: snap.schemaPath,
        packageVersion: snap.packageVersion,
        schemaHash: snap.schemaHash,
        cacheKey: snap.cacheKey,
        error: `Schema compile failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  return {
    available: true,
    schemaPath: snap.schemaPath,
    packageVersion: snap.packageVersion,
    schemaHash: snap.schemaHash,
    cacheKey: snap.cacheKey,
    run,
  };
}

/** Test-only: drop all cached compiled validators. */
export function _clearValidatorCache(): void {
  compiledCache.clear();
}
