/**
 * OMO-Slim installed-schema validation service — shared types.
 *
 * Fail-closed policy: when the installed schema cannot be loaded, ALL config
 * writes are blocked; reads/inspection continue.
 */

import type {
  SchemaValidationIssue,
  SchemaValidationSummary,
} from "@omo/shared";

export type { SchemaValidationIssue, SchemaValidationSummary };
export type { OmoSchemaStatus } from "@omo/shared";

/** Context used to locate the installed schema. */
export interface SchemaContext {
  /**
   * OpenCode config dir (e.g. ~/.config/opencode). The installed package is
   * discovered at `{dir}/node_modules/oh-my-opencode-slim/`.
   */
  opencodeConfigDir?: string;
  /**
   * Test override: direct path to a schema JSON file. Precedence:
   * explicit option > env OMO_SCHEMA_PATH > package discovery.
   */
  schemaPath?: string;
  /** Test override for the reported package version (sibling package.json wins otherwise). */
  packageVersion?: string;
  /**
   * Authorized filesystem roots. When present, the package manifest and
   * schema file must resolve under one of these roots before any read.
   */
  authorizedRoots?: string[];
}

/** Handle returned by the loader — either a compiled validator or an error. */
export interface SchemaValidatorHandle {
  available: boolean;
  schemaPath?: string;
  packageVersion?: string;
  schemaHash?: string;
  /** Public cache key `oh-my-opencode-slim@<version>-<hash>`. */
  cacheKey?: string;
  /**
   * Run the compiled root-document schema. Returns null when the document is
   * valid, otherwise AJV errors. Present iff available.
   */
  run?: (doc: unknown) => import("ajv").ErrorObject[] | null;
  error?: string;
}
