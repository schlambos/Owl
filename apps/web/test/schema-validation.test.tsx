/**
 * OMO-Slim schema-validation UI surfaces:
 *
 * (a) edit preview shows the schema-invalid block and gates Apply when the
 *     simulation's schemaValidation.ok is false;
 * (c) a schema-valid preview keeps Apply enabled and shows the valid state;
 * (b) the global banner renders when /api/omo/schema reports an invalid
 *     user config (or an unavailable schema);
 * (d) the System workspace SCHEMA panel renders version + validity.
 */
import { describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ConfigMutation } from "@omo/shared";
import { AgentEditModal } from "../src/pages/AgentEditModal";
import { SchemaStatusBanner } from "../src/components/SchemaStatusBanner";
import { SystemPage } from "../src/pages/SystemPage";
import type {
  OmoSchemaStatus,
  SimulationResult,
} from "@omo/shared";
import {
  baseRoutes,
  makeAgentsDto,
  makeModel,
  makeProvider,
  makeProvidersDto,
  makeRow,
  makeSimulation,
  mockFetch,
  poll,
  renderWithRuntime,
  type FetchCall,
} from "./helpers";

// ── (a)/(c) schema validation in the edit preview ───────────────────

const SCHEMA_INVALID_ISSUE = {
  path: "agents.explorer.model",
  keyword: "type",
  message:
    "standalone model must be a string with sibling variant — {id,variant} is only valid inside a fallback array",
};

function simulatedWithSchema(ok: boolean) {
  return (call: FetchCall): SimulationResult => {
    const s = makeSimulation({
      mutation: call.body as ConfigMutation,
    }) as SimulationResult;
    s.schemaValidation = {
      ok,
      packageVersion: "2.3.4",
      issues: ok ? [] : [SCHEMA_INVALID_ISSUE],
    };
    return s;
  };
}

function renderModal(simulateOk: boolean) {
  const row = makeRow({
    name: "explorer",
    kind: "builtin",
    effectiveModel: "anthropic/claude-sonnet-4-5",
  });
  const providers = makeProvidersDto([
    makeProvider("anthropic", "Anthropic", true, [
      makeModel("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
    ]),
  ]);
  mockFetch(
    baseRoutes({
      agents: makeAgentsDto([row]),
      providers,
      provenanceModel: { found: false },
      provenanceVariant: { found: false },
      simulate: simulatedWithSchema(simulateOk),
    }),
  );
  renderWithRuntime(
    <AgentEditModal
      agent="explorer"
      row={row}
      initialModel={row.effectiveModel}
      onClose={() => {}}
      onApplied={() => {}}
    />,
  );
}

async function clickPreview() {
  await poll(() =>
    screen.getByRole("heading", { name: /Change model — explorer/ }),
  );
  // Wait for the chain to seed (catalog options exist) before previewing.
  await poll(() =>
    screen.getByRole("option", { name: /Anthropic \(anthropic\) — 1 models/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
  await poll(() => screen.getByText("Preview — model"));
}

describe("schema validation in the edit preview", () => {
  test("(a) schema-invalid simulation: block + issues shown, Apply disabled", async () => {
    renderModal(false);
    await clickPreview();

    // The validation block shows the heading, the invalid state, and each
    // issue as "path — message".
    const blocks = screen.getAllByTestId("schema-validation");
    expect(blocks).toHaveLength(1);
    const block = blocks[0]!;
    within(block).getByText("OMO-Slim schema validation");
    within(block).getByText("✕ Invalid");
    within(block).getByText(/agents\.explorer\.model/);
    within(block).getByText(/only valid inside a fallback array/);

    // Raw details are hidden behind the expandable toggle.
    expect(block.querySelector("pre")).toBeNull();
    fireEvent.click(
      within(block).getByRole("button", { name: /Raw schema details/ }),
    );
    expect(block.querySelector("pre")?.textContent ?? "").toContain(
      "agents.explorer.model",
    );

    // Apply stays disabled despite an otherwise-ok simulation.
    expect(
      (screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("(c) schema-valid simulation: valid state shown, Apply enabled", async () => {
    renderModal(true);
    await clickPreview();

    const blocks = screen.getAllByTestId("schema-validation");
    expect(blocks).toHaveLength(1);
    within(blocks[0]!).getByText(/✓ Valid against installed schema 2\.3\.4/);

    await poll(() =>
      expect(
        (screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  });
});

// ── (b) global invalid-config banner ────────────────────────────────

const SCHEMA_STATUS_INVALID: OmoSchemaStatus = {
  available: true,
  packageVersion: "2.3.4",
  userConfig: {
    present: true,
    valid: false,
    issues: [
      { path: "agents.orchestrator.model", message: "must be a string" },
      { path: "fallback.maxRetries", message: "must be integer" },
    ],
  },
  projectConfig: { present: false, valid: null, issues: [] },
};

function renderBanner(status: OmoSchemaStatus) {
  mockFetch([{ prefix: "/api/omo/schema", body: status }]);
  render(
    <MemoryRouter>
      <SchemaStatusBanner />
    </MemoryRouter>,
  );
}

describe("global schema-status banner", () => {
  test("invalid user config: hard banner + issue paths + repair guidance", async () => {
    renderBanner(SCHEMA_STATUS_INVALID);

    await poll(() => screen.getByText("OMO configuration is invalid."));
    const banner = screen.getByTestId("schema-status-banner");
    expect(banner.getAttribute("role")).toBe("alert");
    within(banner).getByText(/Configuration writes are disabled until/);
    within(banner).getByText(/You can still use the editor/);
    within(banner).getByText(/agents\.orchestrator\.model/);
    within(banner).getByText(/fallback\.maxRetries/);
    // Navigation is never blocked — a repair route is offered, not enforced.
    within(banner).getByRole("link");
  });

  test("schema unavailable: milder warning", async () => {
    renderBanner({
      available: false,
      error: "schema.json not found in oh-my-opencode-slim@2.3.4",
      userConfig: { present: true, valid: null, issues: [] },
      projectConfig: { present: false, valid: null, issues: [] },
    });

    await poll(() =>
      screen.getByText(/Installed OMO-Slim schema unavailable/),
    );
    screen.getByText(/configuration writes are blocked/);
  });

  test("valid user config: no banner", async () => {
    renderBanner({
      available: true,
      packageVersion: "2.3.4",
      userConfig: { present: true, valid: true, issues: [] },
      projectConfig: { present: false, valid: null, issues: [] },
    });

    // Flush the hook's fetch inside act; the banner must never appear.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.queryByTestId("schema-status-banner")).toBeNull();
  });
});

// ── (d) SCHEMA health panel in the config workspace ─────────────────

describe("System workspace SCHEMA panel", () => {
  test("renders package version, schema state, and config validity", async () => {
    mockFetch([
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
      { prefix: "/api/system/companion", status: 404 },
      { prefix: "/api/system/interview", status: 404 },
      {
        prefix: "/api/omo/schema",
        body: {
          available: true,
          packageVersion: "2.3.4",
          schemaPath: "/node_modules/oh-my-opencode-slim/dist/schema.json",
          schemaHash: "sha256:fixture",
          userConfig: { present: true, valid: false, issues: [] },
          projectConfig: { present: false, valid: null, issues: [] },
        } satisfies OmoSchemaStatus,
      },
    ]);
    render(
      <MemoryRouter>
        <SystemPage />
      </MemoryRouter>,
    );

    // Open the SCHEMA section via the accessible section chooser (Schema is
    // outside the current group, so it is not a section-index button here).
    await poll(() => screen.getByLabelText("Section"));
    fireEvent.change(screen.getByLabelText("Section"), {
      target: { value: "schema" },
    });

    await poll(() => {
      const panel = screen.getByTestId("schema-health");
      within(panel).getByText("2.3.4");
      within(panel).getByText("Loaded");
      within(panel).getByText("Invalid");
      within(panel).getByText("Not present");
    });
  });
});
