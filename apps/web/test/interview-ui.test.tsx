/**
 * Slice 18 D2 — System → Interview compact editor.
 *
 * Interaction only: editor open, source selection, set/remove payloads,
 * valid Preview, invalid Apply disable, stale 409, dashboard/port copy,
 * Apply/reload, no window.open or prohibited routes, Companion unchanged.
 */
import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type {
  InterviewMutationRequest,
  InterviewPreviewResponse,
  SourceFingerprint,
} from "@omo/shared";
import {
  INTERVIEW_COMMIT_CONTRACT_FIXTURE,
  INTERVIEW_PREVIEW_CONTRACT_FIXTURE,
  isInterviewCommitResponse,
  isInterviewPreviewResponse,
} from "@omo/shared";
import {
  InterviewContractError,
  parseInterviewApplyResponse,
  parseInterviewSimulateResponse,
} from "../src/api";
import { SystemPage } from "../src/pages/SystemPage";
import { InterviewSection } from "../src/pages/system/InterviewSection";
import {
  mockFetch,
  poll,
  type FetchCall,
  type Route,
} from "./helpers";

const USER_FP: SourceFingerprint = {
  exists: true,
  sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  format: "jsonc",
  mtimeMs: 1,
  generation: 3,
};

const PROJECT_FP: SourceFingerprint = {
  exists: false,
  sha256: null,
  format: "jsonc",
  mtimeMs: null,
  generation: 3,
};

const FIELD_METADATA = [
  { name: "maxQuestions", schemaType: "integer", defaultValue: 2, minimum: 1, maximum: 10 },
  { name: "outputFolder", schemaType: "string", defaultValue: "interview", minLength: 1 },
  { name: "autoOpenBrowser", schemaType: "boolean", defaultValue: true },
  { name: "port", schemaType: "integer", defaultValue: 0, minimum: 0, maximum: 65535 },
  { name: "dashboard", schemaType: "boolean", defaultValue: false },
] as const;

function leaf(
  path: string,
  value: unknown,
  stage: "builtin" | "user-config" | "project-config",
) {
  return {
    path,
    value,
    winner: {
      value,
      sourceId: stage,
      sourceLabel: stage === "builtin" ? "OMO default" : stage.replace("-", " "),
      sourcePath: path,
      stage,
      order: 1,
    },
    overridden: [],
    reason: "fixture",
  };
}

function interviewDto(overrides: Record<string, unknown> = {}) {
  return {
    fieldMetadata: FIELD_METADATA,
    typedCapability: {
      available: true,
      packageVersion: "2.2.10",
      schemaHash: "947ac72a9035e0b7d7ce80c6e8f16ccdf930677b6b80b61d83b054cedbd30e8b",
      cacheKey: "2.2.10|947ac72a",
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
    desired: { maxQuestions: 2 },
    effective: {
      maxQuestions: 2,
      outputFolder: "interview",
      autoOpenBrowser: true,
      port: 0,
      dashboard: false,
    },
    properties: {
      "interview.maxQuestions": leaf("interview.maxQuestions", 2, "user-config"),
      "interview.outputFolder": leaf("interview.outputFolder", "interview", "builtin"),
      "interview.autoOpenBrowser": leaf("interview.autoOpenBrowser", true, "builtin"),
      "interview.port": leaf("interview.port", 0, "builtin"),
      "interview.dashboard": leaf("interview.dashboard", false, "builtin"),
    },
    raw: { user: { maxQuestions: 2 } },
    fingerprints: { user: USER_FP, project: PROJECT_FP },
    server: {
      mode: "per-session",
      bindHost: "127.0.0.1",
      configuredPort: 0,
      portMeaning: "OS-assigned ephemeral port when /interview server first starts",
      defaultDashboardPort: 43211,
      dashboardDerived: { enabled: false, via: "no" },
      browser: { autoOpen: true, autoDisabledInAutomated: true },
      notes: ["Config captured at plugin init — OpenCode restart required for changes"],
    },
    output: {
      configuredFolder: "interview",
      normalizedFolder: "interview",
      resolvedPath: "/Users/matt/Repos/omo-slim/interview",
      withinAuthorizedScope: true,
      inspected: false,
      exists: null,
    },
    runtime: {
      observable: false,
      reasonUnavailable: "interview/server runtime state is not exposed",
    },
    invocation: {
      mechanism: "command",
      name: "/interview",
      note: "registered via config hook command table",
    },
    warnings: [],
    ...overrides,
  };
}

function previewEnvelope(
  overrides: Partial<InterviewPreviewResponse> = {},
): InterviewPreviewResponse {
  return {
    ...INTERVIEW_PREVIEW_CONTRACT_FIXTURE,
    source: USER_FP,
    ...overrides,
  };
}

function commitEnvelope(
  preview: InterviewPreviewResponse = INTERVIEW_PREVIEW_CONTRACT_FIXTURE,
) {
  return {
    ...INTERVIEW_COMMIT_CONTRACT_FIXTURE,
    preview,
    source: preview.source,
  };
}

interface World {
  dto?: Record<string, unknown>;
  simulate?: (call: FetchCall) => unknown;
  apply?: (call: FetchCall) => unknown;
  simulateStatus?: number;
  applyStatus?: number;
}

function interviewRoutes(world: World): Route[] {
  return [
    { prefix: "/api/config/interview/simulate", method: "POST", status: world.simulateStatus ?? 200, respond: (_u, _i, call) => world.simulate?.(call) ?? previewEnvelope() },
    { prefix: "/api/config/interview/apply", method: "POST", status: world.applyStatus ?? 200, respond: (_u, _i, call) => world.apply?.(call) ?? commitEnvelope() },
    { prefix: "/api/config/interview", body: world.dto ?? interviewDto() },
    {
      prefix: "/api/system/globals",
      body: {
        globals: {},
        effective: {},
        live: { mcp: {}, agents: [] },
        environment: {},
        properties: {},
      },
    },
    { prefix: "/api/system/options", body: { catalog: [] } },
    {
      prefix: "/api/system/companion",
      body: {
        fields: { enabled: { name: "enabled", schemaType: "boolean", defaultValue: false } },
        desired: { enabled: false },
        effective: {
          enabled: false,
          position: "bottom-right",
          size: "medium",
          gifPack: "default",
          loopStyle: "classic",
          speed: 1,
          debug: false,
        },
        properties: {},
        raw: { user: { enabled: false } },
        binary: {
          defaultPath: "/tmp/companion",
          resolutionSource: "default",
          withinAuthorizedScope: false,
          inspected: false,
          exists: null,
        },
        runtime: { observable: false, reasonUnavailable: "not exposed" },
        activation: [],
        warnings: [],
      },
    },
    { prefix: "/api/system/multiplexer", status: 404 },
    {
      prefix: "/api/omo/schema",
      body: {
        available: true,
        packageVersion: "2.2.10",
        schemaHash: "947ac72a",
        userConfig: { present: true, valid: true, issues: [] },
        projectConfig: { present: false, valid: null, issues: [] },
      },
    },
  ];
}

function renderInterview(world: World = {}) {
  const mock = mockFetch(interviewRoutes(world));
  render(
    <MemoryRouter>
      <InterviewSection />
    </MemoryRouter>,
  );
  return mock;
}

function renderSystem(url: string, world: World = {}) {
  const mock = mockFetch(interviewRoutes(world));
  render(
    <MemoryRouter initialEntries={[url]}>
      <SystemPage />
    </MemoryRouter>,
  );
  return mock;
}

async function openEditor() {
  await poll(() => screen.getByTestId("interview-summary"));
  fireEvent.click(screen.getByTestId("interview-edit"));
  await poll(() => screen.getByTestId("interview-editor"));
}

function setAction(field: string, action: string) {
  fireEvent.change(screen.getByTestId(`interview-action-${field}`), {
    target: { value: action },
  });
}

describe("System → Interview compact editor", () => {
  test("summary rows and explicit Edit open the editor", async () => {
    renderInterview();
    await poll(() => screen.getByTestId("interview-summary"));
    expect(screen.getByTestId("interview-summary-questions").textContent).toContain("2");
    expect(screen.getByTestId("interview-summary-output").textContent).toContain("Not inspected");
    expect(screen.getByTestId("interview-summary-browser").textContent).toContain("does not open a browser");
    expect(screen.getByTestId("interview-summary-server").textContent).toContain("Automatic / OS assigned");
    expect(screen.getByTestId("interview-summary-dashboard").textContent).toContain("Off");
    expect(screen.getByTestId("interview-summary-source").textContent).toContain("user config");
    expect(screen.queryByTestId("interview-editor")).toBeNull();
    fireEvent.click(screen.getByTestId("interview-edit"));
    await poll(() => screen.getByTestId("interview-editor"));
    expect(screen.getByTestId("interview-scope")).toBeDefined();
  });

  test("source selection switches user/project fingerprint", async () => {
    renderInterview();
    await openEditor();
    expect(screen.getByTestId("interview-fingerprint").textContent).toContain("jsonc");
    expect(screen.getByTestId("interview-fingerprint").textContent).toContain("aaaaaaaaaaaa");
    fireEvent.change(screen.getByTestId("interview-scope"), {
      target: { value: "project" },
    });
    await poll(() =>
      expect(screen.getByTestId("interview-fingerprint").textContent).toContain("missing"),
    );
  });

  test("set and remove payloads use installed field operations and the source fingerprint", async () => {
    const mock = renderInterview();
    await openEditor();
    setAction("maxQuestions", "set");
    fireEvent.change(screen.getByLabelText("Questions value"), {
      target: { value: "4" },
    });
    setAction("dashboard", "remove");
    fireEvent.click(screen.getByTestId("interview-preview"));
    await poll(() => mock.callsTo("/api/config/interview/simulate", "POST").length === 1);
    const body = mock.callsTo("/api/config/interview/simulate", "POST")[0]!.body as InterviewMutationRequest;
    expect(body.scope).toBe("user");
    expect(body.expectedSource).toEqual(USER_FP);
    expect(body.operations).toEqual([
      { field: "maxQuestions", op: "set", value: 4 },
      { field: "dashboard", op: "remove" },
    ]);
    expect(body.expectedCandidateSha256).toBeUndefined();
  });

  test("valid Preview shows semantic, field, source/effective/provenance, and text diff", async () => {
    renderInterview({
      simulate: () => INTERVIEW_PREVIEW_CONTRACT_FIXTURE,
    });
    await openEditor();
    setAction("maxQuestions", "set");
    fireEvent.change(screen.getByLabelText("Questions value"), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByTestId("interview-preview"));
    await poll(() => screen.getByTestId("interview-preview-panel"));
    const panel = screen.getByTestId("interview-preview-panel");
    expect(panel.textContent).toContain("Field operations");
    expect(panel.textContent).toContain("Source impact");
    expect(panel.textContent).toContain("Desired impact");
    expect(panel.textContent).toContain("Effective impact");
    expect(panel.textContent).toContain("Provenance impact");
    expect(panel.textContent).toContain('"maxQuestions": 7');
    expect(panel.textContent).toContain("valid against installed schema");
    expect(screen.getByTestId("interview-runtime-action").textContent).toContain("none");
    expect(screen.getByTestId("interview-apply").hasAttribute("disabled")).toBe(false);
  });

  test("invalid preview keeps Apply disabled", async () => {
    renderInterview({
      simulate: () =>
        previewEnvelope({
          ok: false,
          canApply: false,
          schemaValidation: {
            ok: false,
            issues: [{ path: "interview.maxQuestions", message: "must be <= 10" }],
          },
          errors: ["schema-invalid"],
        }),
    });
    await openEditor();
    setAction("maxQuestions", "set");
    fireEvent.change(screen.getByLabelText("Questions value"), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByTestId("interview-preview"));
    await poll(() => screen.getByTestId("interview-preview-panel"));
    expect(screen.getByTestId("interview-apply").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("interview-schema-validation").textContent).toContain("invalid");
  });

  test("client range check blocks Preview for out-of-range questions", async () => {
    const mock = renderInterview();
    await openEditor();
    setAction("maxQuestions", "set");
    fireEvent.change(screen.getByLabelText("Questions value"), {
      target: { value: "11" },
    });
    fireEvent.click(screen.getByTestId("interview-preview"));
    await poll(
      () =>
        screen.getByTestId("interview-form-error").textContent?.includes("≤ 10") ===
        true,
    );
    expect(mock.callsTo("/api/config/interview/simulate", "POST")).toHaveLength(0);
  });

  test("stale 409 requires reload and a new preview before Apply", async () => {
    const mock = renderInterview({
      simulateStatus: 409,
      simulate: () =>
        previewEnvelope({
          ok: false,
          canApply: false,
          code: "stale-source",
          source: { ...USER_FP, generation: 9 },
          errors: ["stale-source"],
        }),
    });
    await openEditor();
    setAction("maxQuestions", "set");
    fireEvent.change(screen.getByLabelText("Questions value"), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByTestId("interview-preview"));
    await poll(() => screen.getByTestId("interview-stale"));
    expect(screen.queryByTestId("interview-apply")).toBeNull();
    fireEvent.click(screen.getByTestId("interview-reload"));
    await poll(() => mock.callsTo("/api/config/interview", "GET").length >= 2);
    expect(screen.queryByTestId("interview-stale")).toBeNull();
  });

  test("dashboard on + port 0 names default 43211; explicit port implies dashboard", async () => {
    renderInterview();
    await openEditor();
    setAction("dashboard", "set");
    fireEvent.change(screen.getByTestId("interview-value-dashboard"), {
      target: { value: "true" },
    });
    await poll(() => screen.getByTestId("interview-port-default"));
    expect(screen.getByTestId("interview-port-default").textContent).toContain("43211");
    setAction("port", "set");
    fireEvent.change(screen.getByTestId("interview-port-mode"), {
      target: { value: "custom" },
    });
    fireEvent.change(screen.getByLabelText("Server port"), {
      target: { value: "8080" },
    });
    await poll(() => screen.getByTestId("interview-port-implies-dashboard"));
    expect(screen.queryByTestId("interview-port-default")).toBeNull();
  });

  test("Preview→Apply uses the shared contract fixtures and nested commit envelope", async () => {
    const opened: string[] = [];
    const originalOpen = window.open;
    window.open = ((url?: string | URL) => {
      opened.push(String(url ?? ""));
      return null;
    }) as typeof window.open;

    try {
      expect(isInterviewPreviewResponse(INTERVIEW_PREVIEW_CONTRACT_FIXTURE)).toBe(true);
      expect(isInterviewCommitResponse(INTERVIEW_COMMIT_CONTRACT_FIXTURE)).toBe(true);
      const mock = renderInterview({
        simulate: () => INTERVIEW_PREVIEW_CONTRACT_FIXTURE,
        apply: () => INTERVIEW_COMMIT_CONTRACT_FIXTURE,
      });
      await openEditor();
      setAction("maxQuestions", "set");
      fireEvent.change(screen.getByLabelText("Questions value"), {
        target: { value: "7" },
      });
      fireEvent.click(screen.getByTestId("interview-preview"));
      await poll(() => screen.getByTestId("interview-preview-panel"));
      const panel = screen.getByTestId("interview-preview-panel");
      expect(panel.textContent).toContain("/authorized/oh-my-opencode-slim.jsonc");
      expect(panel.textContent).toContain('"maxQuestions": 7');
      expect(panel.textContent).toContain("Semantic validation");
      expect(panel.textContent).toContain("valid against installed schema");
      expect(screen.getByTestId("interview-runtime-action").textContent).toBe("none");
      expect(screen.getByTestId("interview-apply").hasAttribute("disabled")).toBe(false);
      fireEvent.click(screen.getByTestId("interview-apply"));
      await poll(() =>
        screen.getByTestId("interview-apply-status").textContent?.includes("rev_fixture") === true,
      );
      const applyBody = mock.callsTo("/api/config/interview/apply", "POST")[0]!
        .body as InterviewMutationRequest;
      expect(applyBody.expectedCandidateSha256).toBe(
        INTERVIEW_PREVIEW_CONTRACT_FIXTURE.candidateSha256,
      );
      expect(applyBody.operations).toEqual([
        { field: "maxQuestions", op: "set", value: 7 },
      ]);
      expect(mock.callsTo("/api/config/interview", "GET").length).toBeGreaterThan(1);
      const urls = mock.calls.map((c) => c.url);
      expect(urls.every((u) => u.startsWith("/api/config/interview"))).toBe(true);
      expect(urls.some((u) => u.includes("/interview/server"))).toBe(false);
      expect(urls.some((u) => u.includes("/api/models/probe"))).toBe(false);
      expect(urls.some((u) => u.includes("/api/runtime/reconcile"))).toBe(false);
      expect(urls.some((u) => u.includes("/api/opencode"))).toBe(false);
      expect(opened).toEqual([]);
    } finally {
      window.open = originalOpen;
    }
  });

  test("API parser accepts shared fixtures and rejects malformed payloads", () => {
    expect(parseInterviewSimulateResponse(INTERVIEW_PREVIEW_CONTRACT_FIXTURE)).toBe(
      INTERVIEW_PREVIEW_CONTRACT_FIXTURE,
    );
    expect(parseInterviewApplyResponse(INTERVIEW_COMMIT_CONTRACT_FIXTURE)).toBe(
      INTERVIEW_COMMIT_CONTRACT_FIXTURE,
    );
    expect(() => parseInterviewSimulateResponse({ ok: true })).toThrow(InterviewContractError);
    expect(() => parseInterviewApplyResponse(INTERVIEW_PREVIEW_CONTRACT_FIXTURE)).toThrow(
      InterviewContractError,
    );
    expect(() => parseInterviewApplyResponse({ ok: true, preview: {} })).toThrow(
      InterviewContractError,
    );
  });

  test("schema-unavailable keeps Interview read-only", async () => {
    renderInterview({
      dto: interviewDto({
        typedCapability: {
          available: false,
          reason: "schema-unavailable",
          installedFields: [],
          auditedFields: FIELD_METADATA.map((f) => f.name),
        },
      }),
    });
    await poll(() => screen.getByTestId("interview-readonly"));
    expect(screen.queryByTestId("interview-edit")).toBeNull();
    expect(screen.getByTestId("interview-closed").textContent).toContain("typed writes are closed");
  });

  test("invalid current Interview offers a Raw Config repair link", async () => {
    renderInterview({
      dto: interviewDto({
        warnings: ["interview.maxQuestions must be an integer 1–10; value ignored (effective: 2)"],
      }),
    });
    await poll(() => screen.getByTestId("interview-invalid-current"));
    const link = within(screen.getByTestId("interview-invalid-current")).getByRole("link");
    expect(link.getAttribute("href")).toBe(
      "/config?tab=raw&sourceId=user-omo&path=interview.maxQuestions",
    );
  });

  test("Interview editor controls are named and warn before discarding dirty edits", async () => {
    renderInterview();
    await openEditor();
    expect(screen.getByLabelText("Source")).toBeDefined();
    setAction("maxQuestions", "set");
    fireEvent.change(screen.getByLabelText("Questions value"), {
      target: { value: "4" },
    });
    const confirm = window.confirm;
    window.confirm = () => false;
    try {
      fireEvent.click(screen.getByTestId("interview-edit"));
      expect(screen.getByTestId("interview-editor")).toBeDefined();
    } finally {
      window.confirm = confirm;
    }
  });
});

describe("System → Companion stays read-only", () => {
  test("Companion copy stays read-only and has no Edit control", async () => {
    const mock = renderSystem("/system?section=companion");
    await poll(() => screen.getByText(/intentionally not developed further/));
    expect(screen.getByText(/supported fields · read-only/)).toBeDefined();
    expect(screen.queryByTestId("interview-edit")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(mock.callsTo("/api/config/interview", "GET")).toHaveLength(0);
    expect(mock.callsTo("/api/system/companion", "GET").length).toBeGreaterThan(0);
  });
});
