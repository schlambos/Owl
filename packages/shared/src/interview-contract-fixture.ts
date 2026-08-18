/**
 * Serializable Interview Preview/Commit contract fixture (Slice 18 D2).
 *
 * Pure data + type-level contract. Web tests and the designer lane can
 * import this without pulling server runtime. Server route tests serialize
 * real `handleInterviewConfigRoutes` output and assert the same shape via
 * `isInterviewPreviewResponse` / `isInterviewCommitResponse`.
 *
 * Designer follow-up:
 *   import {
 *     INTERVIEW_COMMIT_CONTRACT_FIXTURE,
 *     INTERVIEW_PREVIEW_CONTRACT_FIXTURE,
 *     isInterviewCommitResponse,
 *     isInterviewPreviewResponse,
 *   } from "@omo/shared";
 */

import type {
  InterviewCommitResponse,
  InterviewPreviewResponse,
} from "./index";

const SOURCE = {
  exists: true,
  sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  format: "jsonc" as const,
  mtimeMs: 1,
  generation: 7,
};

const TARGET = {
  scope: "user" as const,
  path: "/authorized/oh-my-opencode-slim.jsonc",
  format: "jsonc" as const,
  exists: true,
  createOnApplyOnly: false,
};

const SEMANTICS = {
  effective: {
    maxQuestions: 2,
    outputFolder: "interview",
    autoOpenBrowser: true,
    port: 0,
    dashboard: false,
  },
  server: {
    mode: "per-session" as const,
    bindHost: "127.0.0.1" as const,
    configuredPort: 0,
    portMeaning: "OS-assigned ephemeral port when /interview server first starts",
    defaultDashboardPort: 43211,
    dashboardDerived: { enabled: false, via: "no" as const },
    browser: { autoOpen: true, autoDisabledInAutomated: false },
    notes: [],
  },
  output: {
    configuredFolder: "interview",
    normalizedFolder: "interview",
    resolvedPath: "/authorized/project/interview",
    withinAuthorizedScope: true,
    inspected: false as const,
    exists: null,
  },
};

export const INTERVIEW_PREVIEW_CONTRACT_FIXTURE: InterviewPreviewResponse = {
  ok: true,
  canApply: true,
  source: SOURCE,
  candidateSha256:
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  target: TARGET,
  schemaValidation: { ok: true, issues: [] },
  semanticValidation: { ok: true, issues: [] },
  textDiff: { text: "@@\n-  \"maxQuestions\": 2\n+  \"maxQuestions\": 7\n", truncated: false },
  sourceChanges: [
    { path: "interview.maxQuestions", op: "replace", before: 2, after: 7 },
  ],
  desiredChanges: [
    { path: "interview.maxQuestions", op: "replace", before: 2, after: 7 },
  ],
  effectiveChanges: [
    { path: "interview.maxQuestions", op: "replace", before: 2, after: 7 },
  ],
  provenanceChanges: [
    {
      path: "interview.maxQuestions",
      before: { sourceId: "builtin", stage: "builtin", value: 2 },
      after: { sourceId: "user:x", stage: "user-config", value: 7 },
    },
  ],
  warnings: [],
  errors: [],
  typedCapability: {
    available: true,
    packageVersion: "2.2.10",
    schemaHash:
      "947ac72a9035e0b7d7ce80c6e8f16ccdf930677b6b80b61d83b054cedbd30e8b",
    cacheKey:
      "oh-my-opencode-slim@2.2.10-947ac72a9035e0b7d7ce80c6e8f16ccdf930677b6b80b61d83b054cedbd30e8b",
    installedFields: [
      "maxQuestions",
      "outputFolder",
      "autoOpenBrowser",
      "port",
      "dashboard",
    ],
    auditedFields: [
      "maxQuestions",
      "outputFolder",
      "autoOpenBrowser",
      "port",
      "dashboard",
    ],
  },
  restartRequired: true,
  runtimeAction: "none",
  interview: {
    before: SEMANTICS,
    after: {
      ...SEMANTICS,
      effective: { ...SEMANTICS.effective, maxQuestions: 7 },
    },
  },
};

export const INTERVIEW_COMMIT_CONTRACT_FIXTURE: InterviewCommitResponse = {
  ok: true,
  status: 200,
  preview: INTERVIEW_PREVIEW_CONTRACT_FIXTURE,
  revisionId: "rev_fixture",
  source: {
    ...SOURCE,
    sha256: INTERVIEW_PREVIEW_CONTRACT_FIXTURE.candidateSha256!,
  },
  errors: [],
  typedCapability: INTERVIEW_PREVIEW_CONTRACT_FIXTURE.typedCapability,
  restartRequired: true,
  runtimeAction: "none",
  interview: INTERVIEW_PREVIEW_CONTRACT_FIXTURE.interview,
};

export const INTERVIEW_CONTRACT_USAGE =
  "packages/shared/src/interview-contract-fixture.ts — import fixtures + isInterviewPreviewResponse / isInterviewCommitResponse from @omo/shared. Server route tests serialize handleInterviewConfigRoutes output against the same guards.";
