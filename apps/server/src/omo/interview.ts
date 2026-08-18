/**
 * Interview subsystem state (read-only, Slice 13; typed-capability D0, Slice 18).
 *
 * Re-verified against installed oh-my-opencode-slim@2.2.10
 * (schema SHA-256 947ac72a9035e0b7d7ce80c6e8f16ccdf930677b6b80b61d83b054cedbd30e8b):
 * - InterviewConfigSchema (zod, not strict, unknown keys stripped):
 *   dist/index.js:18778-18784
 *   maxQuestions int 1–10 default 2; outputFolder string minLen 1 default
 *   "interview"; autoOpenBrowser boolean default true; port int 0–65535
 *   default 0; dashboard boolean default false.
 * - normalizeOutputFolder (dist/index.js:28996-28999) trims, then strips
 *   leading/trailing slashes, empty → "interview"; resolved =
 *   path.join(ctx.directory, normalized) (29000-29002) — absolute paths are
 *   neutralized by the strip, so output always stays under the project root.
 *   Control plane never stats/reads/readdirs the resolved destination.
 * - autoOpenBrowser auto-disabled when NODE_ENV==="test" or truthy
 *   CI/BUN_TEST/VITEST/JEST_WORKER_ID (dist/index.js:32812-32818); spawn
 *   open/xdg-open/cmd start is OMO runtime only — control plane never opens.
 * - port 0 = OS-assigned (per-session mode, 127.0.0.1 only); >0 implies
 *   dashboard mode; dashboardEnabled = dashboard===true || port>0
 *   (dist/index.js:33907-33916); default dashboard port 43211 when dashboard
 *   true and port 0 (dist/index.js:31268).
 * - /interview is a registered OpenCode COMMAND (not a tool); one lazy HTTP
 *   server per plugin instance; server never closed on plugin dispose;
 *   runtime state not exposed via OpenCode server APIs.
 * - Manager config captured at plugin init (dist/index.js:40955) → restart
 *   required for changes. Typed writes stay closed unless installed
 *   version+hash+field set+source semantics match this audit.
 */

import { join } from "node:path";
import type {
  InterviewFieldMetadata,
  InterviewTypedCapability,
  ProvenanceBundle,
  ResolvedProperty,
  SourceFingerprint,
} from "@omo/shared";
import type { ServerConfig } from "../config";
import { isWithinAuthorizedRoots } from "../config";
import {
  loadInstalledSchema,
  publicSchemaCacheKey,
} from "../omo-schema/authority";
import {
  AUDITED_INTERVIEW_FIELD_NAMES,
  AUDITED_INTERVIEW_PACKAGE_VERSION,
  AUDITED_INTERVIEW_SCHEMA_HASH,
  extractInterviewSchemaFields,
  interviewFieldsMatchAudited,
} from "../omo-schema/introspect";
import { schemaContextFor } from "../omo-schema/validator";
import {
  builtinLeaf,
  rawScopeFragments,
  type SubsystemFieldSpec,
} from "./companion";

/** Frozen catalog of the 5 verified InterviewConfigSchema fields. */
export const INTERVIEW_FIELDS: Record<string, SubsystemFieldSpec> = Object.freeze({
  maxQuestions: {
    name: "maxQuestions",
    schemaType: "integer",
    defaultValue: 2,
    minimum: 1,
    maximum: 10,
  },
  outputFolder: {
    name: "outputFolder",
    schemaType: "string",
    defaultValue: "interview",
    // schema minLength 1; runtime normalizeOutputFolder also trims slashes.
  },
  autoOpenBrowser: {
    name: "autoOpenBrowser",
    schemaType: "boolean",
    defaultValue: true,
  },
  port: {
    name: "port",
    schemaType: "integer",
    defaultValue: 0,
    minimum: 0,
    maximum: 65535,
  },
  dashboard: {
    name: "dashboard",
    schemaType: "boolean",
    defaultValue: false,
  },
});

export const DEFAULT_DASHBOARD_PORT = 43211;

export interface InterviewEffective {
  maxQuestions: number;
  outputFolder: string;
  autoOpenBrowser: boolean;
  port: number;
  dashboard: boolean;
}

export const INTERVIEW_FIELD_METADATA: InterviewFieldMetadata[] = [
  {
    name: "maxQuestions",
    schemaType: "integer",
    defaultValue: 2,
    minimum: 1,
    maximum: 10,
  },
  {
    name: "outputFolder",
    schemaType: "string",
    defaultValue: "interview",
    minLength: 1,
  },
  {
    name: "autoOpenBrowser",
    schemaType: "boolean",
    defaultValue: true,
    description:
      "Automatically open the interview UI in your default browser during interactive runs. Disabled automatically in tests and CI.",
  },
  {
    name: "port",
    schemaType: "integer",
    defaultValue: 0,
    minimum: 0,
    maximum: 65535,
  },
  {
    name: "dashboard",
    schemaType: "boolean",
    defaultValue: false,
  },
];

export interface InterviewState {
  fields: Record<string, SubsystemFieldSpec>;
  fieldMetadata: InterviewFieldMetadata[];
  typedCapability: InterviewTypedCapability;
  restartRequired: true;
  runtimeAction: "none";
  desired: Record<string, unknown> | null;
  effective: InterviewEffective;
  properties: Record<string, ResolvedProperty>;
  raw: { user?: Record<string, unknown>; project?: Record<string, unknown> };
  fingerprints?: { user: SourceFingerprint; project: SourceFingerprint };
  server: {
    mode: "per-session" | "dashboard";
    bindHost: "127.0.0.1";
    configuredPort: number;
    portMeaning: string;
    defaultDashboardPort: typeof DEFAULT_DASHBOARD_PORT;
    dashboardDerived: { enabled: boolean; via: "explicit" | "port" | "no" };
    browser: { autoOpen: boolean; autoDisabledInAutomated: boolean };
    notes: string[];
  };
  output: {
    configuredFolder: string;
    normalizedFolder: string;
    resolvedPath: string;
    withinAuthorizedScope: boolean;
    /** never list output contents */
    inspected: false;
    /** never stat the output folder */
    exists: null;
  };
  runtime: { observable: false; reasonUnavailable: string };
  invocation: { mechanism: "command"; name: "/interview"; note: string };
  warnings: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Runtime normalizeOutputFolder (dist/index.js:28996-28999):
 * trim, strip leading/trailing slashes, empty → "interview".
 * Metadata only — never stats/reads the resolved destination.
 */
export function normalizeOutputFolder(v: string): string {
  const stripped = v.trim().replace(/^\/+|\/+$/g, "");
  return stripped.length > 0 ? stripped : "interview";
}

export function resolveInterviewTypedCapability(
  cfg?: Pick<ServerConfig, "opencodeConfigDir" | "authorizedRoots">,
): InterviewTypedCapability {
  const closed = (
    reason: string,
    extra: Partial<InterviewTypedCapability> = {},
  ): InterviewTypedCapability => ({
    available: false,
    reason,
    installedFields: extra.installedFields ?? [],
    auditedFields: [...AUDITED_INTERVIEW_FIELD_NAMES],
    ...extra,
  });

  if (!cfg) {
    return closed("schema-context-unavailable");
  }

  const snap = loadInstalledSchema(schemaContextFor(cfg as ServerConfig), cfg as ServerConfig);
  if (!snap.available) {
    return closed(snap.error, {
      packageVersion: snap.packageVersion,
      schemaHash: snap.schemaHash,
      cacheKey: snap.cacheKey,
    });
  }

  const extracted = extractInterviewSchemaFields(snap.schema);
  const match = interviewFieldsMatchAudited(extracted);
  const extra = {
    packageVersion: snap.packageVersion,
    schemaHash: snap.schemaHash,
    cacheKey: snap.cacheKey ?? publicSchemaCacheKey(snap.packageVersion, snap.schemaHash),
    installedFields: extracted.fieldNames,
  };

  if (snap.packageVersion !== AUDITED_INTERVIEW_PACKAGE_VERSION) {
    return closed(
      `interview-version-mismatch: installed=${snap.packageVersion} audited=${AUDITED_INTERVIEW_PACKAGE_VERSION}`,
      extra,
    );
  }
  if (snap.schemaHash !== AUDITED_INTERVIEW_SCHEMA_HASH) {
    return closed(
      `interview-schema-hash-mismatch: installed=${snap.schemaHash} audited=${AUDITED_INTERVIEW_SCHEMA_HASH}`,
      extra,
    );
  }
  if (!match.ok) {
    return closed(match.reason, extra);
  }

  return {
    available: true,
    packageVersion: snap.packageVersion,
    schemaHash: snap.schemaHash,
    cacheKey: extra.cacheKey,
    installedFields: extracted.fieldNames,
    auditedFields: [...AUDITED_INTERVIEW_FIELD_NAMES],
  };
}

/**
 * Installed `isTruthyEnvFlag` (dist/index.js:32806-32811): empty/undefined is
 * false; `"0"` and case-insensitive `"false"` are false; any other string is
 * true. `isAutomatedRuntime` (32812-32814) uses that for CI/BUN_TEST/VITEST
 * and treats a *defined* `JEST_WORKER_ID` (including `""`) as automated.
 */
export function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) return false;
  return value !== "0" && value.toLowerCase() !== "false";
}

export function automatedRuntimeEnv(
  env: Record<string, string | undefined>,
): boolean {
  return (
    env.NODE_ENV === "test" ||
    isTruthyEnvFlag(env.CI) ||
    isTruthyEnvFlag(env.BUN_TEST) ||
    isTruthyEnvFlag(env.VITEST) ||
    env.JEST_WORKER_ID !== undefined
  );
}

function interviewPortMeaning(
  port: number,
  dashboard: boolean,
): string {
  if (port > 0) return `Configured dashboard port (${port})`;
  if (dashboard) {
    return `Installed default dashboard port (${DEFAULT_DASHBOARD_PORT})`;
  }
  return "OS-assigned ephemeral port when /interview server first starts";
}

export function buildInterviewState(
  bundle: ProvenanceBundle,
  ctxDirectory: string,
  authorizedRoots: string[],
  env: Record<string, string | undefined> = process.env,
  opts?: {
    cfg?: Pick<ServerConfig, "opencodeConfigDir" | "authorizedRoots">;
    fingerprints?: { user: SourceFingerprint; project: SourceFingerprint };
  },
): InterviewState {
  const warnings: string[] = [];
  const merged = bundle.rawMerged.interview;
  const desired = isPlainObject(merged) ? merged : null;
  const d = desired ?? {};

  const effective: InterviewEffective = {
    maxQuestions: 2,
    outputFolder: "interview",
    autoOpenBrowser: true,
    port: 0,
    dashboard: false,
  };

  if (d.maxQuestions !== undefined) {
    if (
      typeof d.maxQuestions === "number" &&
      Number.isInteger(d.maxQuestions) &&
      d.maxQuestions >= 1 &&
      d.maxQuestions <= 10
    ) {
      effective.maxQuestions = d.maxQuestions;
    } else {
      warnings.push(
        "interview.maxQuestions must be an integer 1–10; value ignored (effective: 2)",
      );
    }
  }

  if (d.outputFolder !== undefined) {
    if (typeof d.outputFolder === "string" && d.outputFolder.length >= 1) {
      effective.outputFolder = d.outputFolder;
    } else {
      warnings.push(
        'interview.outputFolder must be a non-empty string; value ignored (effective: "interview")',
      );
    }
  }

  if (d.autoOpenBrowser !== undefined) {
    if (d.autoOpenBrowser === true || d.autoOpenBrowser === false) {
      effective.autoOpenBrowser = d.autoOpenBrowser;
    } else {
      warnings.push(
        "interview.autoOpenBrowser must be a boolean; value ignored (effective: true)",
      );
    }
  }

  if (d.port !== undefined) {
    if (
      typeof d.port === "number" &&
      Number.isInteger(d.port) &&
      d.port >= 0 &&
      d.port <= 65535
    ) {
      effective.port = d.port;
    } else {
      warnings.push(
        "interview.port must be an integer 0–65535; value ignored (effective: 0)",
      );
    }
  }

  if (d.dashboard !== undefined) {
    if (d.dashboard === true || d.dashboard === false) {
      effective.dashboard = d.dashboard;
    } else {
      warnings.push(
        "interview.dashboard must be a boolean; value ignored (effective: false)",
      );
    }
  }

  const properties: Record<string, ResolvedProperty> = {};
  for (const spec of Object.values(INTERVIEW_FIELDS)) {
    const path = `interview.${spec.name}`;
    properties[path] =
      bundle.properties[path] ?? builtinLeaf(path, spec.defaultValue ?? null);
  }

  const dashboardEnabled = effective.dashboard === true || effective.port > 0;
  const via: "explicit" | "port" | "no" =
    effective.dashboard === true ? "explicit" : effective.port > 0 ? "port" : "no";

  const notes = [
    "/interview is a registered OpenCode command, not a tool (installed tools list has no interview tool)",
    "One lazy HTTP server per plugin instance; started on first /interview run",
    "Interview server is never closed on plugin dispose",
    "Resume is restricted to paths under the project root",
    "Server binds 127.0.0.1 only",
    "Config captured at plugin init — OpenCode restart required for changes",
  ];
  const automated = automatedRuntimeEnv(env);
  if (effective.autoOpenBrowser && automated) {
    notes.push(
      "autoOpenBrowser is auto-disabled in automated runtimes (NODE_ENV=test or truthy CI/BUN_TEST/VITEST/JEST_WORKER_ID)",
    );
  }
  if (dashboardEnabled && effective.port === 0) {
    notes.push(
      `dashboard enabled with port 0 → OMO uses default dashboard port ${DEFAULT_DASHBOARD_PORT}`,
    );
  }

  const normalizedFolder = normalizeOutputFolder(effective.outputFolder);
  const resolvedPath = join(ctxDirectory, normalizedFolder);

  const typedCapability = resolveInterviewTypedCapability(opts?.cfg);

  return {
    fields: INTERVIEW_FIELDS,
    fieldMetadata: INTERVIEW_FIELD_METADATA,
    typedCapability,
    restartRequired: true,
    runtimeAction: "none",
    desired,
    effective,
    properties,
    raw: rawScopeFragments(bundle, "interview"),
    ...(opts?.fingerprints ? { fingerprints: opts.fingerprints } : {}),
    server: {
      mode: dashboardEnabled ? "dashboard" : "per-session",
      bindHost: "127.0.0.1",
      configuredPort: effective.port,
      portMeaning: interviewPortMeaning(effective.port, effective.dashboard),
      defaultDashboardPort: DEFAULT_DASHBOARD_PORT,
      dashboardDerived: { enabled: dashboardEnabled, via },
      browser: {
        autoOpen: effective.autoOpenBrowser,
        autoDisabledInAutomated: automated,
      },
      notes,
    },
    output: {
      configuredFolder: effective.outputFolder,
      normalizedFolder,
      resolvedPath,
      withinAuthorizedScope: isWithinAuthorizedRoots(
        resolvedPath,
        authorizedRoots,
      ),
      inspected: false,
      exists: null,
    },
    runtime: {
      observable: false,
      reasonUnavailable:
        "/interview runs lazily inside the OMO plugin; interview/server runtime state is not exposed via OpenCode server APIs",
    },
    invocation: {
      mechanism: "command",
      name: "/interview",
      note: "registered via config hook command table; handled by command.execute.before",
    },
    warnings,
  };
}
