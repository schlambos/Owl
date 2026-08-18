#!/usr/bin/env bun
/**
 * Slice 18 D4 — audit the CURRENT installed OMO-Slim schema.
 *
 * Authority is only the authorized package under the active OpenCode
 * config directory (`loadServerConfig().opencodeConfigDir`). The config
 * `$schema` URL is never fetched. A static schema copy is never
 * authoritative.
 *
 * Usage:
 *   bun run audit:omo-schema
 *   bun run scripts/audit-installed-omo-schema.ts --json
 */

import { loadServerConfig } from "../apps/server/src/config";
import { loadInstalledSchema } from "../apps/server/src/omo-schema/authority";
import {
  auditInputIdentity,
  auditInstalledSchemaCoverage,
  formatCoverageMarkdown,
} from "../apps/server/src/omo-schema/coverage";
import { schemaContextFor } from "../apps/server/src/omo-schema/validator";

const json = process.argv.includes("--json");

const cfg = loadServerConfig();
const snap = loadInstalledSchema(schemaContextFor(cfg), cfg);
if (!snap.available) {
  console.error("Installed OMO-Slim schema unavailable — audit fail-closed.");
  console.error(snap.error);
  process.exit(2);
}

const audit = auditInstalledSchemaCoverage(snap);
const inputHash = auditInputIdentity(snap);

if (json) {
  console.log(
    JSON.stringify(
      {
        inputHash,
        authority: {
          packageVersion: snap.packageVersion,
          schemaHash: snap.schemaHash,
          cacheKey: snap.cacheKey,
          schemaPath: snap.schemaPath,
          packageManifestPath: snap.packageManifestPath,
        },
        audit,
      },
      null,
      2,
    ),
  );
} else {
  console.log(formatCoverageMarkdown(audit));
  console.log("");
  console.log(`Audit input hash: ${inputHash}`);
  console.log(`Authority path: ${snap.schemaPath}`);
}

if (!audit.ok) {
  console.error("");
  console.error("Coverage audit FAILED:");
  for (const e of audit.errors) console.error(`- ${e}`);
  process.exit(1);
}
