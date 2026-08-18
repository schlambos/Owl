/**
 * Shared issue-construction helpers for the schema validation service.
 */

import type {
  SchemaValidationIssue,
  SchemaValidationSummary,
} from "./types";

/** Fail-closed issue used when the installed schema cannot be loaded. */
export function unavailableIssue(
  detail?: string,
  context: "write" | "inspect" = "write",
): SchemaValidationIssue {
  const base =
    "Cannot validate generated OMO configuration against installed schema.";
  return {
    path: "",
    keyword: "unavailable",
    message:
      context === "write"
        ? `${base} No write performed.${detail ? ` (${detail})` : ""}`
        : `${base}${detail ? ` (${detail})` : ""}`,
    expected: "readable oh-my-opencode-slim package under the OpenCode config dir",
  };
}

export function unavailableSummary(opts: {
  detail?: string;
  context?: "write" | "inspect";
  packageVersion?: string;
  schemaPath?: string;
  schemaHash?: string;
}): SchemaValidationSummary {
  return {
    ok: false,
    unavailable: true,
    packageVersion: opts.packageVersion,
    schemaHash: opts.schemaHash,
    issues: [unavailableIssue(opts.detail, opts.context ?? "write")],
  };
}

export function syntaxSummary(err: string): SchemaValidationSummary {
  return {
    ok: false,
    issues: [
      {
        path: "",
        keyword: "syntax",
        message: `Candidate is not parseable JSONC: ${err}`,
      },
    ],
  };
}
