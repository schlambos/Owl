/**
 * Document validation facade — the single entry point used by every config
 * writer, the Doctor engine, and the /api/omo/schema status endpoint.
 *
 * Pipeline: parse (for text inputs) → AJV against the installed schema →
 * supplemental dist-parity checks. Unavailable schema → fail-closed summary
 * (writers must refuse; readers continue).
 */

import { existsSync, readFileSync } from "node:fs";
import type { ErrorObject } from "ajv";
import type { OmoSchemaStatus } from "@omo/shared";
import type { ServerConfig } from "../config";
import { parseConfigText } from "../cfgwrite/jsonc-edit";
import { resolveWriteTarget } from "../cfgwrite/paths";
import {
  publicSchemaCacheKey,
  schemaGenerationFor,
} from "./authority";
import { getValidator } from "./loader";
import { parityIssues } from "./parity";
import { syntaxSummary, unavailableSummary } from "./errors";
import type {
  SchemaContext,
  SchemaValidationIssue,
  SchemaValidationSummary,
} from "./types";

export { getValidator, _clearValidatorCache } from "./loader";
export { parityIssues } from "./parity";
export {
  getInstalledSchemaDocument,
  loadInstalledSchema,
  publicSchemaCacheKey,
  schemaGenerationFor,
} from "./authority";

const MAX_ISSUES = 50;

/** Build the schema context for a writer: package discovery + env override. */
export function schemaContextFor(cfg: ServerConfig): SchemaContext {
  return {
    opencodeConfigDir: cfg.opencodeConfigDir,
    authorizedRoots: cfg.authorizedRoots,
  };
}

/** "/agents/critic/model" → "agents.critic.model"; "/a/1/model" → "a.1.model" */
function instancePathToDot(instancePath: string): string {
  if (!instancePath) return "";
  return instancePath
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
    .join(".");
}

function ajvErrorToIssue(e: ErrorObject): SchemaValidationIssue {
  const params = (e.params ?? {}) as Record<string, unknown>;
  let expected: string | undefined;
  if (typeof params.type === "string") expected = params.type;
  else if (e.keyword === "enum" && Array.isArray(params.allowedValues))
    expected = `one of ${params.allowedValues.map(String).join(", ")}`;
  else if (e.keyword === "additionalProperties" && typeof params.additionalProperty === "string")
    expected = `no additional property "${params.additionalProperty}"`;
  else if (e.keyword === "pattern" && typeof params.pattern === "string")
    expected = `pattern ${params.pattern}`;
  else if (e.keyword === "required" && typeof params.missingProperty === "string")
    expected = `required property "${params.missingProperty}"`;
  else if (typeof params.limit === "number")
    expected = `limit ${params.limit}`;

  const issue: SchemaValidationIssue = {
    path: instancePathToDot(e.instancePath ?? ""),
    keyword: e.keyword,
    message: e.message ?? `${e.keyword} failed`,
    ...(expected !== undefined ? { expected } : {}),
  };
  // `data` is the offending value when available — keep small scalars only.
  const received = (e as { data?: unknown }).data;
  if (
    received !== undefined &&
    (typeof received === "string" ||
      typeof received === "number" ||
      typeof received === "boolean" ||
      received === null)
  ) {
    issue.received = received;
  }
  return issue;
}

/** Validate a parsed candidate document against the installed schema. */
export function validateDocument(
  candidate: unknown,
  ctx: SchemaContext,
): SchemaValidationSummary {
  const handle = getValidator(ctx);
  if (!handle.available || !handle.run) {
    return unavailableSummary({
      detail: handle.error,
      packageVersion: handle.packageVersion,
      schemaHash: handle.schemaHash,
    });
  }

  let issues: SchemaValidationIssue[] = [];
  const errors = handle.run(candidate);
  if (errors && errors.length) {
    issues = errors.map(ajvErrorToIssue);
  }
  // Supplemental dist-parity checks (JSON Schema under-expresses these).
  issues.push(...parityIssues(candidate));

  let truncated = false;
  if (issues.length > MAX_ISSUES) {
    truncated = true;
    issues = issues.slice(0, MAX_ISSUES);
  }
  if (truncated) {
    issues.push({
      path: "",
      keyword: "truncation",
      message: `Issue list truncated to ${MAX_ISSUES} entries.`,
    });
  }

  return {
    ok: issues.length === 0,
    packageVersion: handle.packageVersion,
    schemaHash: handle.schemaHash,
    issues,
  };
}

/**
 * Validate candidate config TEXT: parse JSONC, then validate the document.
 * Syntax errors are reported as issues with path "" and keyword "syntax".
 */
export function validateCandidateText(
  text: string,
  ctx: SchemaContext,
): SchemaValidationSummary {
  let doc: unknown;
  try {
    doc = parseConfigText(text);
  } catch (e) {
    const handle = getValidator(ctx);
    const summary = syntaxSummary(e instanceof Error ? e.message : String(e));
    summary.packageVersion = handle.packageVersion;
    summary.schemaHash = handle.schemaHash;
    if (!handle.available) summary.unavailable = true;
    return summary;
  }
  return validateDocument(doc, ctx);
}

/**
 * Single facade used by all writers before any config write. Currently an
 * alias of validateCandidateText — writers decide the error mapping from the
 * returned summary. Centralizes: no per-module handwritten schema logic.
 */
export function assertSchemaValidCandidate(
  text: string,
  ctx: SchemaContext,
): SchemaValidationSummary {
  return validateCandidateText(text, ctx);
}

/**
 * Validate an existing on-disk config file (Doctor / status endpoint).
 * Caller handles the absent-file case (`present: false`).
 */
export function validateConfigFile(
  path: string,
  ctx: SchemaContext,
): SchemaValidationSummary {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (e) {
    return {
      ok: false,
      issues: [
        {
          path: "",
          keyword: "syntax",
          message: `Config file unreadable: ${e instanceof Error ? e.message : String(e)}`,
        },
      ],
    };
  }
  return validateCandidateText(text, ctx);
}

function fileStatus(
  target: { path: string; exists: boolean },
  ctx: SchemaContext,
): OmoSchemaStatus["userConfig"] {
  if (!target.exists || !existsSync(target.path)) {
    return { present: false, valid: null, issues: [] };
  }
  const summary = validateConfigFile(target.path, ctx);
  return { present: true, valid: summary.ok, issues: summary.issues };
}

/**
 * Status for GET /api/omo/schema + Doctor input. Never throws.
 */
export function getOmoSchemaStatus(cfg: ServerConfig): OmoSchemaStatus {
  try {
    const ctx = schemaContextFor(cfg);
    const handle = getValidator(ctx);
    const userTarget = resolveWriteTarget(cfg, "user");
    const projectTarget = resolveWriteTarget(cfg, "project");
    const cacheKey =
      handle.cacheKey ??
      (handle.schemaHash
        ? publicSchemaCacheKey(handle.packageVersion, handle.schemaHash)
        : undefined);
    const base: OmoSchemaStatus = {
      available: handle.available,
      packageVersion: handle.packageVersion,
      schemaPath: handle.schemaPath,
      schemaHash: handle.schemaHash,
      cacheKey,
      schemaGeneration: cacheKey ? schemaGenerationFor(cacheKey) : undefined,
      sourceGeneration: 0,
      current: true,
      writeCapability: handle.available ? "open" : "closed",
      userConfig: fileStatus(userTarget, ctx),
      projectConfig: fileStatus(projectTarget, ctx),
    };
    if (!handle.available) {
      base.error = handle.error ?? "installed schema unavailable";
    }
    return base;
  } catch (e) {
    return {
      available: false,
      writeCapability: "closed",
      current: true,
      sourceGeneration: 0,
      userConfig: { present: false, valid: null, issues: [] },
      projectConfig: { present: false, valid: null, issues: [] },
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
