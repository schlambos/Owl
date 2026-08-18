/**
 * Slice 18 D3 — serializable raw Preview/Commit contract fixtures.
 *
 * Import from `@omo/shared` as
 *     RAW_PREVIEW_CONTRACT_FIXTURE,
 *     RAW_COMMIT_CONTRACT_FIXTURE,
 *     isRawPreviewResponse / isRawCommitResponse.
 *
 * Server route tests serialize handleRawConfigRoutes output against the
 * same guards. Designer/web binds Monaco to this envelope only.
 */

import type { RawCommitResponse, RawPreviewResponse } from "./index";

export const RAW_PREVIEW_CONTRACT_FIXTURE: RawPreviewResponse = {
  ok: true,
  canApply: true,
  sourceId: "user-omo",
  source: {
    exists: true,
    sha256: "aaa",
    format: "jsonc",
    mtimeMs: 1,
    generation: 1,
  },
  candidateSha256: "bbb",
  target: {
    scope: "user",
    path: "/authorized/user/oh-my-opencode-slim.jsonc",
    format: "jsonc",
    exists: true,
    createOnApplyOnly: false,
  },
  schemaValidation: {
    ok: true,
    packageVersion: "2.2.10",
    schemaHash: "ccc",
    issues: [],
  },
  semanticValidation: { ok: true, issues: [] },
  textDiff: {
    text: "--- a/oh-my-opencode-slim.jsonc\n+++ b/oh-my-opencode-slim.jsonc\n",
    truncated: false,
  },
  sourceChanges: [
    { path: "compactSidebar", op: "replace", before: true, after: false },
  ],
  desiredChanges: [
    { path: "compactSidebar", op: "replace", before: true, after: false },
  ],
  effectiveChanges: [
    { path: "compactSidebar", op: "replace", before: true, after: false },
  ],
  provenanceChanges: [
    {
      path: "compactSidebar",
      before: { sourceId: "user-omo", stage: "user-config", value: true },
      after: { sourceId: "user-omo", stage: "user-config", value: false },
    },
  ],
  warnings: [],
  errors: [],
  schemaCacheKey: "oh-my-opencode-slim@2.2.10-ccc",
  schemaGeneration: 1,
  liveUnchangedNote:
    "Live runtime is unchanged until OpenCode reloads this configuration.",
  semanticSummaries: {
    capabilities: { changed: false, notes: [] },
    prompts: { changed: false, notes: [] },
    presets: { changed: false, notes: [] },
    council: { changed: false, notes: [] },
    acp: { changed: false, notes: [] },
    interview: { changed: false, notes: [] },
    customAgents: { changed: false, notes: [] },
  },
  crossLinks: [
    {
      kind: "doctor-raw",
      href: "/config?tab=raw&sourceId=user-omo&path=compactSidebar",
      label: "Open compactSidebar in Raw",
      path: "compactSidebar",
    },
  ],
};

export const RAW_COMMIT_CONTRACT_FIXTURE: RawCommitResponse = {
  ok: true,
  status: 200,
  sourceId: "user-omo",
  preview: RAW_PREVIEW_CONTRACT_FIXTURE,
  revisionId: "rev_fixture",
  source: {
    exists: true,
    sha256: "bbb",
    format: "jsonc",
    mtimeMs: 2,
    generation: 2,
  },
  errors: [],
};

export const RAW_CONTRACT_USAGE =
  "packages/shared/src/raw-contract-fixture.ts — import fixtures + isRawPreviewResponse / isRawCommitResponse from @omo/shared. Client requests carry sourceId user-omo|project-omo only; never filesystem paths.";
