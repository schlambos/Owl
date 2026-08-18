/**
 * Slice 18 D3 — Configuration workspace.
 *
 * Mocks the Monaco factory. Asserts sourceId requests, shared Preview/Commit
 * fixtures, dirty/stale/Apply gating, revisions, Doctor query, schema
 * unavailable, 2 MiB guard, and no prohibited routes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { RawMutationRequest, RawSourceLoadResponse, SourceFingerprint } from "@omo/shared";
import {
  MAX_OMO_CANDIDATE_BYTES,
  RAW_COMMIT_CONTRACT_FIXTURE,
  RAW_PREVIEW_CONTRACT_FIXTURE,
  isRawCommitResponse,
  isRawPreviewResponse,
} from "@omo/shared";
import {
  RawContractError,
  parseRawApplyResponse,
  parseRawSimulateResponse,
} from "../src/api";
import { ConfigPage } from "../src/pages/ConfigPage";
import { DoctorPage } from "../src/pages/DoctorPage";
import {
  jsonDiagnosticsOptions,
  schemaRegistrationKey,
  setOmoMonacoFactory,
  type OmoMonacoFactory,
  type OmoMonacoSchemaOptions,
} from "../src/monaco/omo-config-editor";
import { sourceModelUri } from "../src/pages/config/raw-contract";
import {
  dispatchCpEvent,
  lastEventSource,
  makeOverview,
  makeRuntimeState,
  mockFetch,
  poll,
  renderWithRuntime,
  type FetchCall,
  type Route,
} from "./helpers";

const USER_FP: SourceFingerprint = {
  exists: true,
  sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  format: "jsonc",
  mtimeMs: 1,
  generation: 4,
};

const PROJECT_FP: SourceFingerprint = {
  exists: false,
  sha256: null,
  format: "jsonc",
  mtimeMs: null,
  generation: 4,
};

const USER_TEXT = `{
  "preset": "local",
  "agents": { "explorer": { "model": "openai/gpt-x" } },
  "compactSidebar": true
}
`;

const SCHEMA = {
  available: true,
  packageVersion: "2.2.10",
  schemaHash: "947ac72a9035e0b7d7ce80c6e8f16ccdf930677b6b80b61d83b054cedbd30e8b",
  cacheKey:
    "oh-my-opencode-slim@2.2.10-947ac72a9035e0b7d7ce80c6e8f16ccdf930677b6b80b61d83b054cedbd30e8b",
};

const PREVIEW = {
  ...RAW_PREVIEW_CONTRACT_FIXTURE,
  source: USER_FP,
  candidateSha256: RAW_PREVIEW_CONTRACT_FIXTURE.candidateSha256,
  schemaCacheKey: SCHEMA.cacheKey,
};

const COMMIT = {
  ...RAW_COMMIT_CONTRACT_FIXTURE,
  preview: PREVIEW,
  revisionId: "rev-raw-1",
  source: { ...USER_FP, sha256: PREVIEW.candidateSha256 },
};

function installMonacoMock() {
  const schemas: OmoMonacoSchemaOptions[] = [];
  const factory: OmoMonacoFactory = {
    mountEditor(el, options, onChange) {
      el.dataset.uri = options.uri;
      el.dataset.format = options.format;
      el.dataset.readonly = options.readOnly ? "true" : "false";
      const input = document.createElement("textarea");
      input.dataset.testid = "monaco-textarea";
      input.value = options.value;
      input.readOnly = options.readOnly === true;
      input.addEventListener("input", () => onChange(input.value));
      el.append(input);
      return {
        getValue: () => input.value,
        setValue: (value) => {
          input.value = value;
        },
        setWordWrap: (enabled) => {
          el.dataset.wrap = enabled ? "on" : "off";
        },
        revealPath: (path) => {
          el.dataset.reveal = path;
        },
        dispose: () => {
          el.replaceChildren();
        },
      };
    },
    mountDiff(el, original, modified) {
      el.dataset.originalUri = original.uri;
      el.dataset.modifiedUri = modified.uri;
      el.textContent = `${original.value} => ${modified.value}`;
      return { dispose: () => el.replaceChildren() };
    },
    registerSchema(options) {
      schemas.push(options);
      factory.lastSchemaKey = schemaRegistrationKey(options);
    },
  };
  setOmoMonacoFactory(factory);
  return { factory, schemas };
}

afterEach(() => setOmoMonacoFactory(null));

interface World {
  userText?: string;
  userIssues?: Array<{ path: string; message: string }>;
  projectExists?: boolean;
  schemaAvailable?: boolean;
  simulate?: (call: FetchCall) => unknown;
  apply?: (call: FetchCall) => unknown;
  simulateStatus?: number;
  applyStatus?: number;
  compare?: unknown;
  revisions?: unknown;
  revision?: unknown;
}

function rawUser(world: World): RawSourceLoadResponse {
  const issues = world.userIssues ?? [];
  return {
    ok: true,
    sourceId: "user-omo",
    scope: "user",
    exists: true,
    format: "jsonc",
    createOnApplyOnly: false,
    path: "/Users/matt/.config/opencode/oh-my-opencode-slim.jsonc",
    fingerprint: USER_FP,
    text: world.userText ?? USER_TEXT,
    byteLength: USER_TEXT.length,
    syntax: { ok: issues.length === 0, issues: issues.map((i) => ({ ...i })) },
    schemaValidation: {
      ok: issues.length === 0,
      packageVersion: "2.2.10",
      schemaHash: SCHEMA.schemaHash,
      issues,
    },
    schema: {
      available: world.schemaAvailable !== false,
      packageVersion: "2.2.10",
      schemaHash: SCHEMA.schemaHash,
      cacheKey: SCHEMA.cacheKey,
      error: world.schemaAvailable === false ? "installed schema unavailable" : undefined,
    },
    effectiveResolutionAvailable: world.schemaAvailable !== false,
    writeCapability: world.schemaAvailable === false ? "closed" : "open",
    errors: [],
  };
}

function routes(world: World): Route[] {
  return [
    { prefix: "/api/runtime", body: makeRuntimeState() },
    { prefix: "/api/overview", body: makeOverview() },
    { prefix: "/api/agents", body: { agents: [] } },
    { prefix: "/api/providers", body: { providers: [] } },
    {
      prefix: "/api/opencode/lifecycle",
      body: {
        mode: "managed",
        ownership: "control-plane",
        status: "connected",
        baseUrl: "http://127.0.0.1:4096",
        generation: 1,
        projectDirectory: "/Users/matt/Repos/omo-slim",
        configDirectory: "/Users/matt/.config/opencode",
        authConfigured: false,
        ready: {
          health: true,
          configProviders: true,
          providers: true,
          agents: true,
          omo: true,
          omoExpected: true,
          rest: true,
          sse: true,
        },
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
    {
      prefix: "/api/omo/provenance",
      body: {
        preset: "local",
        sources: [
          { id: "user", label: "User OMO", kind: "user-omo", present: true, path: rawUser(world).path },
          { id: "project", label: "Project OMO", kind: "project-omo", present: false, path: null },
        ],
        properties: {
          compactSidebar: {
            path: "compactSidebar",
            value: true,
            winner: {
              value: true,
              sourceId: "user",
              sourceLabel: "user config",
              sourcePath: "compactSidebar",
              stage: "user-config",
              order: 1,
            },
            overridden: [],
            reason: "fixture",
          },
        },
        warnings: [],
      },
    },
    {
      prefix: "/api/omo/schema/document",
      status: world.schemaAvailable === false ? 503 : 200,
      body:
        world.schemaAvailable === false
          ? { available: false, error: "installed schema unavailable" }
          : { available: true, ...SCHEMA, schema: { type: "object" } },
    },
    {
      prefix: "/api/omo/schema",
      body: {
        available: world.schemaAvailable !== false,
        ...SCHEMA,
        userConfig: {
          present: true,
          valid: !(world.userIssues && world.userIssues.length > 0),
          issues: world.userIssues ?? [],
        },
        projectConfig: { present: false, valid: null, issues: [] },
        error: world.schemaAvailable === false ? "installed schema unavailable" : undefined,
      },
    },
    {
      prefix: "/api/config/raw/simulate",
      method: "POST",
      status: world.simulateStatus ?? 200,
      respond: (_u, _i, call) => world.simulate?.(call) ?? PREVIEW,
    },
    {
      prefix: "/api/config/raw/apply",
      method: "POST",
      status: world.applyStatus ?? 200,
      respond: (_u, _i, call) => world.apply?.(call) ?? COMMIT,
    },
    {
      prefix: "/api/config/raw/compare",
      method: "POST",
      respond: () =>
        world.compare ?? {
          ok: true,
          sourceId: "user-omo",
          fingerprint: { ...USER_FP, generation: 9, sha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" },
          currentText: USER_TEXT.replace("true", "false"),
          textDiff: { text: "changed", truncated: false },
          errors: [],
        },
    },
    {
      prefix: "/api/config/raw",
      respond: (url) => {
        const sourceId = new URLSearchParams(url.split("?")[1] ?? "").get("sourceId");
        if (sourceId === "project-omo") {
          return {
            ok: true,
            sourceId: "project-omo",
            scope: "project",
            exists: world.projectExists === true,
            format: "jsonc",
            createOnApplyOnly: true,
            path: "/Users/matt/Repos/omo-slim/.opencode/oh-my-opencode-slim.jsonc",
            fingerprint: PROJECT_FP,
            text: "{}\n",
            byteLength: 3,
            syntax: { ok: true, issues: [] },
            schema: {
              available: world.schemaAvailable !== false,
              ...SCHEMA,
            },
            effectiveResolutionAvailable: world.schemaAvailable !== false,
            writeCapability: world.schemaAvailable === false ? "closed" : "open",
            errors: [],
          } satisfies RawSourceLoadResponse;
        }
        return rawUser(world);
      },
    },
    {
      prefix: "/api/config/omo-revisions/",
      method: "POST",
      respond: (url) =>
        url.includes("simulate-restore")
          ? RAW_PREVIEW_CONTRACT_FIXTURE
          : RAW_COMMIT_CONTRACT_FIXTURE,
    },
    {
      prefix: "/api/config/omo-revisions/",
      body:
        world.revision ?? {
          id: "rev-raw-0",
          timestamp: "2026-01-01T00:00:00.000Z",
          sourceId: "user-omo",
          scope: "user",
          state: "committed",
          mutationKind: "Raw OMO configuration edit",
          kindLabel: "Raw OMO configuration edit",
          oldHash: "old",
          newHash: "new",
          restoreEligible: true,
          path: rawUser(world).path,
          format: "jsonc",
          beforeContent: USER_TEXT,
          afterContent: USER_TEXT.replace("true", "false"),
          semanticChangedPaths: ["compactSidebar"],
          currentSchemaCompatible: true,
          schemaPackageVersion: "2.2.10",
          schemaHash: "947ac72a",
        },
    },
    {
      prefix: "/api/config/omo-revisions",
      body: {
        revisions: world.revisions ?? [
          {
            id: "rev-raw-0",
            timestamp: "2026-01-01T00:00:00.000Z",
            sourceId: "user-omo",
            scope: "user",
            state: "committed",
            mutationKind: "Raw OMO configuration edit",
            kindLabel: "Raw OMO configuration edit",
            oldHash: "old",
            newHash: "new",
            restoreEligible: true,
          },
          {
            id: "rev-old",
            timestamp: "2025-01-01T00:00:00.000Z",
            sourceId: "user-omo",
            scope: "user",
            state: "committed",
            mutationKind: "Raw OMO configuration edit",
            kindLabel: "Raw OMO configuration edit",
            oldHash: "older",
            newHash: "old",
            restoreEligible: false,
          },
        ],
      },
    },
    {
      prefix: "/api/doctor",
      body: {
        generatedAt: "2026-01-01T00:00:00.000Z",
        overall: "degraded",
        counts: { healthy: 0, info: 0, warning: 1, error: 0, unknown: 0 },
        categories: [],
        diagnostics: [
          {
            id: "config.invalid-user",
            category: "config",
            severity: "warning",
            title: "User OMO invalid",
            summary: "user schema invalid",
            sourcePaths: ["compactSidebar"],
            remediation: {
              action: "open",
              target: "/config?tab=raw&sourceId=user-omo&path=compactSidebar",
              label: "Open Raw Config",
            },
          },
        ],
        system: { runtimeStale: false, runtimePresetKnown: false },
      },
    },
  ];
}

function renderConfig(url = "/config", world: World = {}) {
  const monaco = installMonacoMock();
  const mock = mockFetch(routes(world));
  render(
    <MemoryRouter initialEntries={[url]}>
      <ConfigPage />
    </MemoryRouter>,
  );
  return { mock, monaco };
}

async function renderConfigLive(url = "/config?tab=raw", world: World = {}) {
  let previous: ReturnType<typeof lastEventSource> | null = null;
  try {
    previous = lastEventSource();
  } catch {
    previous = null;
  }
  const monaco = installMonacoMock();
  const mock = mockFetch(routes(world));
  renderWithRuntime(
    <MemoryRouter initialEntries={[url]}>
      <ConfigPage />
    </MemoryRouter>,
  );
  await poll(() => screen.getByTestId("omo-monaco-editor"));
  await poll(() => {
    const es = lastEventSource();
    if (es === previous) throw new Error("EventSource not open");
  });
  return { mock, monaco };
}

async function emitSourcesChanged(partial: Parameters<typeof sourcesChanged>[0]) {
  act(() => {
    dispatchCpEvent("config.sources.changed", sourcesChanged(partial));
  });
}

function sourcesChanged(partial: {
  user?: SourceFingerprint;
  project?: SourceFingerprint;
  ownApplyBySource?: { "user-omo"?: boolean; "project-omo"?: boolean };
  schemaChanged?: boolean;
}) {
  return {
    type: "config.sources.changed" as const,
    at: "2026-01-01T00:00:01.000Z",
    generation: 8,
    sources: {
      "user-omo": partial.user ?? USER_FP,
      "project-omo": partial.project ?? PROJECT_FP,
    },
    schema: { ...SCHEMA, changed: partial.schemaChanged === true },
    ownApplyBySource: {
      "user-omo": partial.ownApplyBySource?.["user-omo"] === true,
      "project-omo": partial.ownApplyBySource?.["project-omo"] === true,
    },
  };
}

describe("Configuration workspace", () => {
  test("API parser accepts shared raw fixtures and rejects malformed payloads", () => {
    expect(isRawPreviewResponse(RAW_PREVIEW_CONTRACT_FIXTURE)).toBe(true);
    expect(isRawCommitResponse(RAW_COMMIT_CONTRACT_FIXTURE)).toBe(true);
    expect(parseRawSimulateResponse(RAW_PREVIEW_CONTRACT_FIXTURE)).toBe(
      RAW_PREVIEW_CONTRACT_FIXTURE,
    );
    expect(parseRawApplyResponse(RAW_COMMIT_CONTRACT_FIXTURE)).toBe(
      RAW_COMMIT_CONTRACT_FIXTURE,
    );
    expect(() => parseRawSimulateResponse({ ok: true })).toThrow(RawContractError);
    expect(() => parseRawApplyResponse(RAW_PREVIEW_CONTRACT_FIXTURE)).toThrow(RawContractError);
  });

  test("source selector loads user/project and missing project is explicit create-only", async () => {
    const { mock } = renderConfig("/config");
    await poll(() => screen.getByTestId("config-sources"));
    expect(screen.getByTestId("config-scope").textContent).toContain("User OMO");
    expect(mock.callsTo("/api/config/raw", "GET")[0]?.url).toContain("sourceId=user-omo");
    fireEvent.change(screen.getByTestId("config-scope"), { target: { value: "project-omo" } });
    await poll(() => screen.getByTestId("config-project-missing"));
    expect(screen.getByTestId("config-create-project-sources")).toBeDefined();
    fireEvent.click(screen.getByTestId("config-tab-raw"));
    await poll(() => screen.getByTestId("config-missing-project"));
    expect(screen.getByTestId("config-create-project")).toBeDefined();
    expect(screen.queryByTestId("config-missing-user")).toBeNull();
  });

  test("raw editor uses exact model URI, format, schema key, and dirty state", async () => {
    const { monaco } = renderConfig("/config?tab=raw&sourceId=user-omo");
    await poll(() => screen.getByTestId("omo-monaco-editor"));
    const host = screen.getByTestId("omo-monaco-editor");
    expect(host.getAttribute("data-uri")).toBe(sourceModelUri("user-omo", "jsonc"));
    expect(host.getAttribute("data-format")).toBe("jsonc");
    expect(monaco.factory.lastSchemaKey).toContain("oh-my-opencode-slim@2.2.10-947ac72a");
    expect(monaco.factory.lastSchemaKey).toContain("jsonc");
    const area = within(host).getByTestId("monaco-textarea") as HTMLTextAreaElement;
    fireEvent.input(area, { target: { value: USER_TEXT.replace("true", "false") } });
    await poll(() => screen.getByTestId("config-dirty"));
  });

  test("load→Preview→Apply uses the exact shared contract shape", async () => {
    const { mock } = renderConfig("/config?tab=raw", {
      simulate: () => RAW_PREVIEW_CONTRACT_FIXTURE,
      apply: () => RAW_COMMIT_CONTRACT_FIXTURE,
    });
    await poll(() => screen.getByTestId("omo-monaco-editor"));
    const area = within(screen.getByTestId("omo-monaco-editor")).getByTestId(
      "monaco-textarea",
    ) as HTMLTextAreaElement;
    fireEvent.input(area, { target: { value: USER_TEXT.replace("true", "false") } });
    fireEvent.click(screen.getByTestId("config-preview"));
    await poll(() => screen.getByTestId("config-preview-panel"));
    expect(screen.getByTestId("config-apply").hasAttribute("disabled")).toBe(false);
    expect(screen.getByTestId("config-source-diff")).toBeDefined();
    fireEvent.click(screen.getByTestId("config-preview-tab-semantic"));
    expect(screen.getByTestId("config-semantic").textContent).toContain(
      "Live runtime is unchanged",
    );
    fireEvent.click(screen.getByTestId("config-preview-tab-effective"));
    expect(screen.getByTestId("config-effective-diff").textContent).toContain("compactSidebar");
    fireEvent.click(screen.getByTestId("config-preview-tab-provenance"));
    expect(screen.getByTestId("config-provenance-diff").textContent).toContain("user-config");
    fireEvent.click(screen.getByTestId("config-preview-tab-validation"));
    expect(screen.getByTestId("config-validation").textContent).toContain("valid");
    const sim = mock.callsTo("/api/config/raw/simulate", "POST")[0]!.body as RawMutationRequest;
    expect(sim.sourceId).toBe("user-omo");
    expect(sim.expectedSchemaCacheKey).toBe(SCHEMA.cacheKey);
    expect("scope" in sim).toBe(false);
    expect("path" in sim).toBe(false);
    fireEvent.click(screen.getByTestId("config-apply"));
    await poll(() =>
      screen.getByTestId("config-applied").textContent?.includes("rev_fixture") === true,
    );
    const apply = mock.callsTo("/api/config/raw/apply", "POST")[0]!.body as RawMutationRequest;
    expect(apply.sourceId).toBe("user-omo");
    expect(apply.expectedCandidateSha256).toBe(RAW_PREVIEW_CONTRACT_FIXTURE.candidateSha256);
    expect(apply.expectedSchemaCacheKey).toBe(SCHEMA.cacheKey);
  });

  test("invalid Preview disables Apply", async () => {
    renderConfig("/config?tab=raw", {
      simulate: () => ({
        ...PREVIEW,
        ok: false,
        canApply: false,
        schemaValidation: {
          ok: false,
          issues: [{ path: "agents.explorer.model", message: "invalid shape" }],
        },
      }),
    });
    await poll(() => screen.getByTestId("config-preview"));
    fireEvent.click(screen.getByTestId("config-preview"));
    await poll(() => screen.getByTestId("config-preview-panel"));
    expect(screen.getByTestId("config-apply").hasAttribute("disabled")).toBe(true);
  });

  test("stale 409 offers Compare/Reload and never force-writes", async () => {
    const { mock } = renderConfig("/config?tab=raw", {
      simulateStatus: 409,
      simulate: () => ({ ...PREVIEW, ok: false, canApply: false, code: "stale-source" }),
    });
    await poll(() => screen.getByTestId("config-preview"));
    fireEvent.click(screen.getByTestId("config-preview"));
    await poll(() => screen.getByTestId("config-stale"));
    fireEvent.click(screen.getByTestId("config-compare"));
    await poll(() => screen.getByTestId("config-compare-panel"));
    expect(mock.callsTo("/api/config/raw/compare", "POST")[0]!.body).toMatchObject({
      sourceId: "user-omo",
    });
    expect(mock.callsTo("/api/config/raw/apply", "POST")).toHaveLength(0);
  });

  test("invalid current text stays editable and can Preview a repair", async () => {
    renderConfig("/config?tab=raw", {
      userIssues: [{ path: "agents.explorer.model", message: "invalid shape" }],
    });
    await poll(() => screen.getByTestId("config-invalid-current"));
    const area = within(screen.getByTestId("omo-monaco-editor")).getByTestId(
      "monaco-textarea",
    ) as HTMLTextAreaElement;
    expect(area.readOnly).toBe(false);
    fireEvent.input(area, { target: { value: USER_TEXT } });
    fireEvent.click(screen.getByTestId("config-preview"));
    await poll(() => screen.getByTestId("config-preview-panel"));
  });

  test("schema unavailable is read-only with the fail-closed message", async () => {
    renderConfig("/config?tab=raw", { schemaAvailable: false });
    await poll(() => screen.getByTestId("config-version-banner"));
    expect(screen.getByTestId("config-version-banner").textContent).toContain(
      "configuration writes are blocked",
    );
    fireEvent.click(screen.getByTestId("config-tab-schema"));
    await poll(() => screen.getByTestId("config-schema-unavailable"));
    fireEvent.click(screen.getByTestId("config-tab-raw"));
    await poll(() => screen.getByTestId("omo-monaco-editor"));
    expect(screen.getByTestId("omo-monaco-editor").getAttribute("data-readonly")).toBe("true");
    expect(screen.getByTestId("config-preview").hasAttribute("disabled")).toBe(true);
  });

  test("2 MiB client guard blocks Preview", async () => {
    const { mock } = renderConfig("/config?tab=raw");
    await poll(() => screen.getByTestId("omo-monaco-editor"));
    const huge = "x".repeat(MAX_OMO_CANDIDATE_BYTES + 8);
    const area = within(screen.getByTestId("omo-monaco-editor")).getByTestId(
      "monaco-textarea",
    ) as HTMLTextAreaElement;
    fireEvent.input(area, { target: { value: huge } });
    await poll(() => screen.getByTestId("config-oversize"));
    expect(screen.getByTestId("config-preview").hasAttribute("disabled")).toBe(true);
    expect(mock.callsTo("/api/config/raw/simulate", "POST")).toHaveLength(0);
  });

  test("revisions show diff and restore remains gated when ineligible", async () => {
    renderConfig("/config?tab=revisions");
    await poll(() => screen.getByTestId("config-revisions"));
    fireEvent.click(screen.getByTestId("config-revision-rev-raw-0"));
    await poll(() => screen.getByTestId("config-revision-detail"));
    expect(screen.getByTestId("config-revision-diff")).toBeDefined();
    expect(screen.getByTestId("config-restore").hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByTestId("config-restore-preview"));
    await poll(() => screen.getByTestId("config-restore").hasAttribute("disabled") === false);
  });

  test("Doctor remediation preserves raw tab/sourceId/path query", async () => {
    mockFetch(routes({}));
    renderWithRuntime(
      <MemoryRouter>
        <DoctorPage />
      </MemoryRouter>,
    );
    await poll(() => screen.getByText("User OMO invalid"));
    fireEvent.click(screen.getByText("User OMO invalid"));
    await poll(() => screen.getByText("Open Raw Config"));
    expect(screen.getByText("Open Raw Config").getAttribute("href")).toBe(
      "/config?tab=raw&sourceId=user-omo&path=compactSidebar",
    );
  });

  test("raw workspace honors Doctor path query and never calls prohibited routes", async () => {
    const opened: string[] = [];
    const originalOpen = window.open;
    window.open = ((url?: string | URL) => {
      opened.push(String(url ?? ""));
      return null;
    }) as typeof window.open;
    try {
      const { mock, monaco } = renderConfig("/config?tab=raw&sourceId=user-omo&path=compactSidebar");
      await poll(() => screen.getByTestId("omo-monaco-editor"));
      expect(screen.getByTestId("omo-monaco-editor").getAttribute("data-uri")).toBe(
        "file:///omo-control/user/oh-my-opencode-slim.jsonc",
      );
      const urls = mock.calls.map((c) => c.url);
      expect(urls.some((u) => u.includes("sourceId=user-omo"))).toBe(true);
      expect(urls.some((u) => u.includes("scope="))).toBe(false);
      expect(urls.some((u) => u.includes("/api/models/probe"))).toBe(false);
      expect(urls.some((u) => u.includes("/api/runtime/reconcile"))).toBe(false);
      expect(urls.some((u) => u.includes("/api/opencode"))).toBe(false);
      expect(opened).toEqual([]);
      const opts = monaco.schemas[0];
      expect(opts).toBeDefined();
      const diag = jsonDiagnosticsOptions(opts!);
      expect(diag.allowComments).toBe(true);
      expect(diag.comments).toBe("ignore");
    } finally {
      window.open = originalOpen;
    }
  });

  test("external active-source change invalidates Preview and disables Apply", async () => {
    await renderConfigLive();
    const area = within(screen.getByTestId("omo-monaco-editor")).getByTestId(
      "monaco-textarea",
    ) as HTMLTextAreaElement;
    fireEvent.input(area, { target: { value: USER_TEXT.replace("true", "false") } });
    fireEvent.click(screen.getByTestId("config-preview"));
    await poll(() => screen.getByTestId("config-apply"));
    expect(screen.getByTestId("config-apply").hasAttribute("disabled")).toBe(false);
    await emitSourcesChanged({
      user: { ...USER_FP, sha256: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", generation: 9 },
      ownApplyBySource: { "user-omo": false, "project-omo": false },
    });
    await poll(() => screen.getByTestId("config-stale"));
    expect(screen.queryByTestId("config-apply")).toBeNull();
    expect(screen.getByTestId("config-preview").hasAttribute("disabled")).toBe(true);
    expect(area.value).toContain("false");
  });

  test("own Apply for the viewed clean draft does not false-stale", async () => {
    const { mock } = await renderConfigLive();
    expect(screen.queryByTestId("config-dirty")).toBeNull();
    const before = mock.callsTo("/api/config/raw", "GET").length;
    await emitSourcesChanged({
      user: { ...USER_FP, sha256: PREVIEW.candidateSha256!, generation: 5 },
      ownApplyBySource: { "user-omo": true, "project-omo": false },
    });
    await poll(() => {
      if (mock.callsTo("/api/config/raw", "GET").length <= before) {
        throw new Error("viewed source was not refreshed after own Apply");
      }
    });
    expect(screen.queryByTestId("config-stale")).toBeNull();
    expect(screen.queryByTestId("config-dirty")).toBeNull();
  });

  test("sibling own Apply does not overwrite a dirty active draft", async () => {
    const { mock } = await renderConfigLive();
    const area = within(screen.getByTestId("omo-monaco-editor")).getByTestId(
      "monaco-textarea",
    ) as HTMLTextAreaElement;
    const dirty = USER_TEXT.replace("true", "false");
    fireEvent.input(area, { target: { value: dirty } });
    await poll(() => screen.getByTestId("config-dirty"));
    const before = mock.callsTo("/api/config/raw", "GET").length;
    await emitSourcesChanged({
      user: USER_FP,
      project: { ...PROJECT_FP, exists: true, sha256: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", generation: 6 },
      ownApplyBySource: { "user-omo": false, "project-omo": true },
    });
    await poll(() => screen.getByTestId("config-dirty"));
    expect(area.value).toBe(dirty);
    expect(screen.queryByTestId("config-stale")).toBeNull();
    expect(mock.callsTo("/api/config/raw", "GET").length).toBe(before);
  });

  test("own Apply on viewed source with a newly dirty draft keeps the draft and offers stale choices", async () => {
    const { mock } = await renderConfigLive();
    const area = within(screen.getByTestId("omo-monaco-editor")).getByTestId(
      "monaco-textarea",
    ) as HTMLTextAreaElement;
    const later = USER_TEXT.replace("true", "false").replace("local", "quality");
    fireEvent.input(area, { target: { value: later } });
    await poll(() => screen.getByTestId("config-dirty"));
    const before = mock.callsTo("/api/config/raw", "GET").length;
    await emitSourcesChanged({
      user: { ...USER_FP, sha256: PREVIEW.candidateSha256!, generation: 5 },
      ownApplyBySource: { "user-omo": true, "project-omo": false },
    });
    await poll(() => screen.getByTestId("config-stale"));
    expect(area.value).toBe(later);
    expect(screen.getByTestId("config-compare")).toBeDefined();
    expect(screen.getByTestId("config-reload")).toBeDefined();
    expect(mock.callsTo("/api/config/raw", "GET").length).toBe(before);
  });

  test("workspace tabs preserve sourceId and path query state", async () => {
    renderConfig("/config?tab=provenance&sourceId=project-omo&path=agents.explorer.model");
    await poll(() => screen.getByTestId("config-provenance-browser"));
    expect(screen.getByTestId("config-tab-provenance").getAttribute("aria-current")).toBe(
      "page",
    );
    expect((screen.getByTestId("config-scope") as HTMLSelectElement).value).toBe(
      "project-omo",
    );
    fireEvent.click(screen.getByTestId("config-tab-revisions"));
    await poll(() => screen.getByTestId("config-revisions"));
    expect(screen.getByTestId("config-tab-revisions").getAttribute("aria-current")).toBe(
      "page",
    );
    expect((screen.getByTestId("config-scope") as HTMLSelectElement).value).toBe(
      "project-omo",
    );
    fireEvent.click(screen.getByTestId("config-tab-raw"));
    await poll(() => screen.getByTestId("omo-monaco-editor"));
    expect(screen.getByTestId("config-tab-raw").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("omo-monaco-editor").getAttribute("data-uri")).toBe(
      sourceModelUri("project-omo", "jsonc"),
    );
    expect(screen.getByTestId("omo-monaco-editor").getAttribute("data-reveal")).toBe(
      "agents.explorer.model",
    );
  });

  test("raw editor, source, and tabs expose accessible names and live status", async () => {
    renderConfig("/config?tab=raw");
    await poll(() => screen.getByTestId("omo-monaco-editor"));
    expect(screen.getByLabelText("Source")).toBeDefined();
    expect(screen.getByTestId("config-tabs").getAttribute("aria-label")).toBe(
      "Configuration views",
    );
    expect(screen.getByTestId("config-tab-raw").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("omo-monaco-editor").getAttribute("aria-label")).toContain(
      "User OMO configuration editor",
    );
    const area = within(screen.getByTestId("omo-monaco-editor")).getByTestId(
      "monaco-textarea",
    ) as HTMLTextAreaElement;
    fireEvent.input(area, { target: { value: USER_TEXT.replace("true", "false") } });
    await poll(() => screen.getByTestId("config-dirty"));
  });
});
