/**
 * Slice 16 multiplexer UI (requirements 46–53):
 *
 * 46 — System → Multiplexer is URL-addressable and renders Desired /
 *      Effective / source per field with provenance.
 * 47 — Runtime Observation: neutral Unavailable when the bridge is absent;
 *      authoritative table + topology only where mappings are real.
 * 48 — Typed edit: simulate → preview (target, paths, diff, schema
 *      validation, "No runtime action will be taken.") → apply → revision →
 *      guarded restore; hash conflict forces a re-preview.
 * 49 — Per-field relevance labels follow the exact backend semantics
 *      (tmux/zellij/herdr/kitty/cmux/none/auto); configured-but-inactive
 *      values stay inspectable.
 * 50 — Session Inspector shows a Multiplexer card only when a mapping exists.
 * 51 — OMO Jobs panel: `type paneId` when mapped, "Terminal Unavailable"
 *      otherwise, nothing when the mapping is unobservable.
 * 52 — Prohibited runtime controls are absent; forms/tables keep accessible
 *      semantics (labels, column headers, aria-live).
 * 53 — Doctor multiplexer warnings deep-link to /system?section=multiplexer.
 */
import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import type {
  MultiplexerSessionRecord,
  MultiplexerSystemDto,
  SessionDetail,
} from "@omo/shared";
import { SystemPage } from "../src/pages/SystemPage";
import { DoctorPage } from "../src/pages/DoctorPage";
import { AgentsPage } from "../src/pages/AgentsPage";
import { OverviewPage } from "../src/pages/OverviewPage";
import { SessionInspector } from "../src/pages/sessions/SessionInspector";
import { OmoJobsPanel } from "../src/pages/sessions/OmoJobsPanel";
import type { OmoRuntimeSnapshot } from "../src/pages/omo-runtime-types";
import {
  baseRoutes,
  makeAgentsDto,
  makeMultiplexerSystem,
  makeProvidersDto,
  makeRow,
  mockFetch,
  poll,
  renderWithRouter,
  EDIT_STATE,
  OMO_RUNTIME_SNAPSHOT,
  OMO_SCHEMA_OK,
  MUX_UNAVAILABLE,
  type FetchCall,
  type Route,
} from "./helpers";

// ── Fixtures ─────────────────────────────────────────────────────────

const SESSION_ID = "ses_child1";
const PARENT_ID = "ses_root1";

const MUX_RECORD: MultiplexerSessionRecord = {
  sessionId: SESSION_ID,
  paneId: "%5",
  parentSessionId: PARENT_ID,
  known: true,
  spawning: false,
  closing: false,
  permanentlyClosed: false,
};

/** tmux effective, bridge connected, one real session mapping. */
function muxMapped(
  overrides: Partial<MultiplexerSystemDto> = {},
): MultiplexerSystemDto {
  const base = makeMultiplexerSystem();
  return makeMultiplexerSystem({
    configured: { type: "tmux" },
    effective: {
      type: "tmux",
      layout: "main-vertical",
      main_pane_size: 60,
      zellij_pane_mode: "agent-tab",
    },
    provenance: {
      properties: {
        "multiplexer.type": {
          path: "multiplexer.type",
          value: "tmux",
          winner: {
            value: "tmux",
            sourceId: "user-config",
            sourceLabel: "user config",
            sourcePath: "/tmp/owl-fixture/opencode/omo.json",
            stage: "user-config",
            order: 1,
          },
          overridden: [],
          reason: "fixture",
        },
      },
      builtinDefaults: [
        "multiplexer.layout",
        "multiplexer.main_pane_size",
        "multiplexer.zellij_pane_mode",
      ],
    },
    availability: {
      ...base.availability,
      tmux: { command: "tmux", status: "resolved", path: "/opt/homebrew/bin/tmux" },
    },
    runtime: {
      stores: {
        sessions: [MUX_RECORD],
        cmux: [],
        counts: { sessions: 1, knownSessions: 1 },
      },
      mapping: {
        bySessionId: { [SESSION_ID]: MUX_RECORD },
        mappedJobs: ["task-1"],
        unmappedJobs: ["task-2"],
        unavailable: false,
        stale: false,
        graceAppliedMs: 60000,
      },
      bridgeSchemaVersion: 2,
      bridgeConnected: true,
    },
    ...overrides,
  });
}

const JOBS: OmoRuntimeSnapshot = {
  ...OMO_RUNTIME_SNAPSHOT,
  jobs: [
    {
      taskId: "task-1",
      agent: "explorer",
      parentSessionId: PARENT_ID,
      childSessionId: SESSION_ID,
      state: "running",
      launchedAt: Date.now() - 60_000,
      source: "opencode-task-call",
    },
    {
      taskId: "task-2",
      agent: "librarian",
      parentSessionId: PARENT_ID,
      childSessionId: "ses_child2",
      state: "running",
      launchedAt: Date.now() - 30_000,
      source: "opencode-task-call",
    },
  ],
};

const SIM_OK = {
  ok: true,
  errors: [],
  warnings: [],
  targetPath: "/tmp/owl-fixture/opencode/omo.json",
  createsFile: false,
  currentHash: "user-hash-1",
  textDiff: '+  "multiplexer": {\n+    "type": "tmux"\n+  }',
  effectiveChanges: [{ path: "multiplexer.type", before: null, after: "tmux" }],
  schemaValidation: { ok: true, packageVersion: "2.2.10", issues: [] },
};

const APPLY_OK = {
  ...SIM_OK,
  revisionId: "rev-mux-1",
};

interface SystemWorld {
  mux?: MultiplexerSystemDto;
  omoRuntime?: OmoRuntimeSnapshot;
  simulate?: (call: FetchCall) => unknown;
  apply?: (call: FetchCall) => unknown;
  restore?: (call: FetchCall) => unknown;
}

function systemRoutes(world: SystemWorld): Route[] {
  return [
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
    { prefix: "/api/system/multiplexer", body: world.mux ?? MUX_UNAVAILABLE },
    { prefix: "/api/omo/schema", body: OMO_SCHEMA_OK },
    { prefix: "/api/omo/runtime", body: world.omoRuntime ?? OMO_RUNTIME_SNAPSHOT },
    { prefix: "/api/config/edit-state", body: EDIT_STATE },
    {
      prefix: "/api/config/global/simulate",
      method: "POST",
      respond: (_u, _i, call) =>
        world.simulate ? world.simulate(call) : SIM_OK,
    },
    {
      prefix: "/api/config/global/apply",
      method: "POST",
      respond: (_u, _i, call) => (world.apply ? world.apply(call) : APPLY_OK),
    },
    {
      prefix: "/api/config/revisions/",
      method: "POST",
      respond: (_u, _i, call) =>
        world.restore ? world.restore(call) : { ok: true },
    },
  ];
}

let lastSearch = "";
function LocationProbe() {
  lastSearch = useLocation().search;
  return null;
}

function renderSystem(world: SystemWorld, url = "/system?section=multiplexer") {
  const mock = mockFetch(systemRoutes(world));
  render(
    <MemoryRouter initialEntries={[url]}>
      <LocationProbe />
      <SystemPage />
    </MemoryRouter>,
  );
  return mock;
}

async function openMuxSection() {
  await poll(() => screen.getByTestId("mux-config"));
}

/** Choose Set/Remove on a field; when Set, pick the typed value. */
async function editField(field: string, action: string, value?: string) {
  const labels: Record<string, string> = {
    type: "Type",
    layout: "Layout",
    main_pane_size: "Main pane",
    zellij_pane_mode: "Zellij mode",
  };
  fireEvent.change(screen.getByLabelText(labels[field]!), {
    target: { value: action },
  });
  if (action === "set" && value !== undefined) {
    const valueLabels: Record<string, string> = {
      type: "Type value",
      layout: "Layout value",
      main_pane_size: "Main pane size percent",
      zellij_pane_mode: "Zellij mode value",
    };
    fireEvent.change(screen.getByLabelText(valueLabels[field]!), {
      target: { value },
    });
  }
}

// ── 46 · System desired/effective, URL-addressable ───────────────────

describe("46 · System → Multiplexer configuration", () => {
  test("URL-addressable: ?section=multiplexer renders desired/effective/source", async () => {
    renderSystem({ mux: muxMapped() });
    await openMuxSection();

    const config = screen.getByTestId("mux-config");
    // Effective row values and builtin defaults are visible.
    expect(within(config).getAllByText("main-vertical").length).toBeGreaterThan(0);
    // Desired (configured) type shown with user-config provenance pill.
    const desiredType = within(config).getByTestId("mux-desired-type");
    expect(desiredType.textContent).toContain("tmux");
    within(config).getByText("user config");
    // Unset fields fall back to builtin provenance.
    const desiredLayout = within(config).getByTestId("mux-desired-layout");
    expect(desiredLayout.textContent).toContain("(not set)");
    within(config).getAllByText("OMO default");
    // Accessible table semantics.
    expect(within(config).getAllByRole("columnheader")).toHaveLength(6);
    // Separate stage cards are never collapsed into one.
    screen.getByTestId("mux-availability");
    screen.getByTestId("mux-detection");
    screen.getByTestId("mux-runtime");
    screen.getByTestId("mux-capabilities");
    screen.getByTestId("mux-legacy");
  });

  test("section chooser updates the URL query state", async () => {
    renderSystem({ mux: muxMapped() }, "/system");
    // Multiplexer is outside the current group from Overview; the accessible
    // section chooser exposes it (and every other section) as one action.
    await poll(() => screen.getByLabelText("Section"));
    fireEvent.change(screen.getByLabelText("Section"), {
      target: { value: "multiplexer" },
    });
    await openMuxSection();
    expect(lastSearch).toContain("section=multiplexer");
  });
});

// ── 49 · conditional relevance labels ────────────────────────────────

describe("49 · per-field relevance follows backend semantics", () => {
  test("tmux main-vertical: layout + main size active, zellij mode inactive", async () => {
    renderSystem({ mux: muxMapped() });
    await openMuxSection();
    expect(screen.getByTestId("mux-relevance-layout").textContent).toContain(
      "applies — tmux window layout",
    );
    expect(
      screen.getByTestId("mux-relevance-main_pane_size").textContent,
    ).toContain("applies — tmux main-vertical");
    expect(
      screen.getByTestId("mux-relevance-zellij_pane_mode").textContent,
    ).toContain("configured but inactive — only applies to zellij");
  });

  test("tmux tiled: main pane size not used; configured value stays inspectable", async () => {
    renderSystem({
      mux: muxMapped({
        configured: { type: "tmux", main_pane_size: 70 },
        effective: {
          type: "tmux",
          layout: "tiled",
          main_pane_size: 70,
          zellij_pane_mode: "agent-tab",
        },
      }),
    });
    await openMuxSection();
    expect(
      screen.getByTestId("mux-relevance-main_pane_size").textContent,
    ).toContain("not used — tmux tiled has no main pane");
    // Configured-but-inactive value is still visible, labeled honestly.
    const desired = screen.getByTestId("mux-desired-main_pane_size");
    expect(desired.textContent).toContain("70");
    expect(desired.textContent).toContain("configured · inactive");
  });

  test("cmux: layout ignored; zellij: constructor receives size but does not use it", async () => {
    renderSystem({
      mux: muxMapped({
        configured: { type: "cmux" },
        effective: {
          type: "cmux",
          layout: "main-vertical",
          main_pane_size: 60,
          zellij_pane_mode: "agent-tab",
        },
      }),
    });
    await openMuxSection();
    expect(screen.getByTestId("mux-relevance-layout").textContent).toContain(
      "ignored — cmux does not use layout",
    );
    expect(
      screen.getByTestId("mux-relevance-main_pane_size").textContent,
    ).toContain("ignored by cmux");

    renderSystem({
      mux: muxMapped({
        configured: { type: "zellij" },
        effective: {
          type: "zellij",
          layout: "main-vertical",
          main_pane_size: 60,
          zellij_pane_mode: "agent-tab",
        },
      }),
    });
    await poll(() =>
      expect(
        screen.getAllByTestId("mux-relevance-main_pane_size").pop()!.textContent,
      ).toContain("received by the zellij constructor but not used"),
    );
    expect(
      screen.getAllByTestId("mux-relevance-zellij_pane_mode").pop()!.textContent,
    ).toContain("applies — zellij pane placement");
  });

  test("auto: relevance resolves through detection; no signal → unknown", async () => {
    renderSystem({
      mux: makeMultiplexerSystem({
        configured: { type: "auto" },
        effective: {
          type: "auto",
          layout: "main-vertical",
          main_pane_size: 60,
          zellij_pane_mode: "agent-tab",
        },
        detection: {
          signals: { TMUX: "/tmp/tmux-501/default,1,0" },
          resolvedType: "tmux",
          insideSession: true,
          order: [{ match: "TMUX", type: "tmux" }],
        },
      }),
    });
    await openMuxSection();
    expect(screen.getByTestId("mux-relevance-layout").textContent).toContain(
      "applies — tmux window layout (auto → tmux)",
    );
    // Detection card shows which signals are set — never their values.
    const detection = screen.getByTestId("mux-detection");
    expect(detection.textContent).toContain("TMUX");
    expect(detection.textContent).not.toContain("/tmp/tmux-501");
  });

  test("auto with no detected backend: relevance unknown", async () => {
    renderSystem({
      mux: makeMultiplexerSystem({
        effective: {
          type: "auto",
          layout: "main-vertical",
          main_pane_size: 60,
          zellij_pane_mode: "agent-tab",
        },
      }),
    });
    await openMuxSection();
    expect(screen.getByTestId("mux-relevance-layout").textContent).toContain(
      "unknown — auto detected no backend",
    );
    expect(
      screen.getByTestId("mux-relevance-main_pane_size").textContent,
    ).toContain("only tmux main-horizontal/main-vertical use this value");
  });
});

// ── 47 · runtime observation ─────────────────────────────────────────

describe("47 · runtime observation", () => {
  test("bridge absent: neutral Unavailable, no table, no topology, no health warning", async () => {
    renderSystem({ mux: MUX_UNAVAILABLE, omoRuntime: JOBS });
    await openMuxSection();
    const unavailable = screen.getByTestId("mux-runtime-unavailable");
    expect(unavailable.textContent).toContain("Unavailable");
    expect(unavailable.textContent).toContain("not a health warning");
    expect(screen.queryByTestId("mux-runtime-table")).toBeNull();
    expect(screen.queryByTestId("mux-topology")).toBeNull();
  });

  test("authoritative mapping: full table + branch topology from real records", async () => {
    renderSystem({ mux: muxMapped(), omoRuntime: JOBS });
    await openMuxSection();

    const table = screen.getByTestId("mux-runtime-table");
    const headers = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual([
      "OpenCode Session",
      "Agent",
      "OMO Job",
      "Multiplexer",
      "Session/Pane",
      "State",
    ]);
    const row = within(table)
      .getAllByRole("row")
      .find((r) => r.textContent?.includes(SESSION_ID))!;
    expect(row.textContent).toContain("explorer");
    expect(row.textContent).toContain("task-1");
    expect(row.textContent).toContain("tmux");
    expect(row.textContent).toContain("%5");
    expect(row.textContent).toContain("known");

    const topo = screen.getByTestId("mux-topology");
    expect(topo.textContent).toContain("Orchestrator/main");
    expect(topo.textContent).toContain(PARENT_ID);
    expect(topo.textContent).toContain("explorer");
    expect(topo.textContent).toContain("tmux %5");
    // Unmapped jobs never appear in the topology.
    expect(topo.textContent).not.toContain("librarian");

    // Counts from the bridge snapshot.
    const runtime = screen.getByTestId("mux-runtime");
    expect(runtime.textContent).toContain("sessions 1");
    expect(runtime.textContent).toContain("1 mapped · 1 unmapped");
  });
});

// ── 48 · typed edit: preview → apply → restore ───────────────────────

describe("48 · edit configuration flow", () => {
  async function previewTypeToTmux(world: SystemWorld = {}) {
    const mock = renderSystem(world);
    await openMuxSection();
    await editField("type", "set", "tmux");
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    await poll(() => screen.getByTestId("mux-preview"));
    return mock;
  }

  test("preview shows target, exact paths, diff, schema validation, no-runtime note", async () => {
    const mock = await previewTypeToTmux();

    // Simulate request carries the exact writer contract.
    const simCalls = mock.callsTo("/api/config/global/simulate", "POST");
    expect(simCalls).toHaveLength(1);
    const body = simCalls[0]!.body as Record<string, unknown>;
    expect(body.kind).toBe("global-settings");
    expect(body.scope).toBe("user");
    expect(body.expectedSourceHash).toBe("user-hash-1");
    expect(body.multiplexer).toEqual({
      type: { operation: "set", value: "tmux" },
    });

    const preview = screen.getByTestId("mux-preview");
    // aria-live async surface.
    expect(preview.getAttribute("aria-live")).toBe("polite");
    expect(preview.textContent).toContain("/tmp/owl-fixture/opencode/omo.json");
    expect(preview.textContent).toContain("multiplexer.type");
    expect(preview.textContent).toContain("(not set)");
    expect(preview.textContent).toContain("tmux");
    // Effective before from the DTO; effective after honestly re-resolved.
    expect(preview.textContent).toContain("type none");
    expect(preview.textContent).toContain(
      "re-resolved from all config sources after the write",
    );
    // Exact diff + schema validation + activation honesty.
    expect(preview.textContent).toContain('"type": "tmux"');
    within(screen.getByTestId("mux-schema-validation")).getByText(
      /valid against installed schema 2\.2\.10/,
    );
    expect(preview.textContent).toContain("no hot reload");
    expect(preview.textContent).toContain("No runtime action will be taken.");
    // No raw generic JSON dump.
    expect(preview.querySelector(".raw-json")).toBeNull();
  });

  test("apply exposes the revision; restore goes through the guarded route", async () => {
    const mock = await previewTypeToTmux();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await poll(() =>
      expect(screen.getByTestId("mux-apply-status").textContent).toContain(
        "rev-mux-1",
      ),
    );
    const applyCalls = mock.callsTo("/api/config/global/apply", "POST");
    expect(applyCalls).toHaveLength(1);
    expect(
      (applyCalls[0]!.body as { multiplexer: unknown }).multiplexer,
    ).toEqual({ type: { operation: "set", value: "tmux" } });

    // Restore is a two-step guarded flow.
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm restore" }));
    await poll(() =>
      expect(screen.getByTestId("mux-apply-status").textContent).toContain(
        "Restored revision rev-mux-1.",
      ),
    );
    expect(
      mock.callsTo("/api/config/revisions/rev-mux-1/restore", "POST"),
    ).toHaveLength(1);
  });

  test("hash conflict on simulate requires re-preview; on apply discards the preview", async () => {
    const conflict = { ok: false, errors: ["CONFIGURATION CHANGED EXTERNALLY"], warnings: [] };
    const mock = renderSystem({
      simulate: () => conflict,
    });
    await openMuxSection();
    await editField("type", "set", "tmux");
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    await poll(() =>
      screen.getByText(/preview again before applying/),
    );
    expect(screen.queryByTestId("mux-preview")).toBeNull();

    // Apply-time conflict: preview was valid, then the file changed.
    const mock2 = renderSystem({
      apply: () => conflict,
    });
    await poll(() => screen.getAllByTestId("mux-config").length >= 2);
    const sections = screen.getAllByTestId("mux-edit");
    const section = sections[sections.length - 1]!;
    fireEvent.change(within(section).getByLabelText("Type"), {
      target: { value: "set" },
    });
    fireEvent.change(within(section).getByLabelText("Type value"), {
      target: { value: "tmux" },
    });
    fireEvent.click(
      within(section).getByRole("button", { name: "Preview changes" }),
    );
    await poll(() => within(section).getByTestId("mux-preview"));
    fireEvent.click(within(section).getByRole("button", { name: "Apply" }));
    await poll(() =>
      within(section).getByText(/preview again before applying/),
    );
    expect(within(section).queryByTestId("mux-preview")).toBeNull();
    expect(mock2.callsTo("/api/config/global/apply", "POST")).toHaveLength(1);
  });

  test("schema-invalid preview blocks Apply", async () => {
    await previewTypeToTmux({
      simulate: () => ({
        ...SIM_OK,
        schemaValidation: {
          ok: false,
          packageVersion: "2.2.10",
          issues: [{ path: "multiplexer.type", message: "bad enum" }],
        },
      }),
    });
    const block = screen.getByTestId("mux-schema-validation");
    within(block).getByText(/multiplexer\.type/);
    expect(
      (screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("main pane size is guarded to 20–80 before any request", async () => {
    const mock = renderSystem({});
    await openMuxSection();
    await editField("main_pane_size", "set", "90");
    // Native constraint validation (min 20 / max 80) blocks the submit, exactly
    // as in a real browser — no request is ever made.
    const input = screen.getByLabelText(
      "Main pane size percent",
    ) as HTMLInputElement;
    expect(input.validity.rangeOverflow).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(mock.callsTo("/api/config/global/simulate", "POST")).toHaveLength(0);

    // The custom validator is the fallback when the native guard does not
    // apply (e.g. an empty value submits as not-a-number).
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    await poll(() => screen.getByRole("alert"));
    expect(screen.getByRole("alert").textContent).toContain(
      "must be a number",
    );
    expect(mock.callsTo("/api/config/global/simulate", "POST")).toHaveLength(0);
  });

  test("remove override sends a remove op", async () => {
    const mock = renderSystem({ mux: muxMapped() });
    await openMuxSection();
    await editField("type", "remove");
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    await poll(() => screen.getByTestId("mux-preview"));
    const body = mock.callsTo("/api/config/global/simulate", "POST")[0]!
      .body as { multiplexer: unknown };
    expect(body.multiplexer).toEqual({ type: { operation: "remove" } });
    expect(screen.getByTestId("mux-preview").textContent).toContain(
      "(removed — inherits)",
    );
  });
});

// ── 52 · prohibited controls + accessibility ─────────────────────────

describe("52 · no runtime controls, accessible semantics", () => {
  test("no restart/session/pane/attach controls anywhere in the section", async () => {
    renderSystem({ mux: muxMapped(), omoRuntime: JOBS });
    await openMuxSection();
    const section = screen.getByTestId("mux-section");
    const forbidden = /restart|attach|kill|spawn|close pane|detach|send keys/i;
    for (const el of within(section).getAllByRole("button")) {
      expect(forbidden.test(el.textContent ?? "")).toBe(false);
    }
    expect(forbidden.test(section.textContent ?? "")).toBe(false);
  });

  test("editor controls are labeled; status regions are aria-live", async () => {
    renderSystem({ mux: muxMapped() });
    await openMuxSection();
    // Every per-field action select has an associated label.
    screen.getByLabelText("Type");
    screen.getByLabelText("Layout");
    screen.getByLabelText("Main pane");
    screen.getByLabelText("Zellij mode");
    // Apply status region announces asynchronously.
    expect(
      screen.getByTestId("mux-apply-status").getAttribute("aria-live"),
    ).toBe("polite");
  });
});

// ── 50 · session inspector mapping ───────────────────────────────────

describe("50 · session inspector multiplexer section", () => {
  const detail: SessionDetail = {
    id: SESSION_ID,
    title: "child session",
    agent: "explorer",
    status: "idle",
    initialInstructionLabel: "Initial instruction",
    messages: [],
    activity: [],
    diff: { empty: true, files: [], totalAdditions: 0, totalDeletions: 0 },
    permissions: [],
    children: [],
    siblings: [],
    exists: true,
    errors: [],
  };

  function renderInspector(mux: MultiplexerSystemDto) {
    mockFetch([
      { prefix: "/api/sessions/", body: detail },
      { prefix: "/api/system/multiplexer", body: mux },
      { prefix: "/api/omo/runtime", body: JOBS },
      ...baseRoutes({
        agents: makeAgentsDto([]),
        providers: makeProvidersDto([]),
      }),
    ]);
    renderWithRouter(
      <SessionInspector sessionId={SESSION_ID} onSelect={() => {}} />,
      ["/sessions"],
    );
  }

  test("mapping exists: type/pane/state from the DTO", async () => {
    renderInspector(muxMapped());
    await poll(() => screen.getByTestId("session-multiplexer"));
    const card = screen.getByTestId("session-multiplexer");
    expect(card.textContent).toContain("tmux");
    expect(card.textContent).toContain(SESSION_ID);
    expect(card.textContent).toContain("%5");
    expect(card.textContent).toContain("known");
    expect(card.textContent).toContain("bridge v2");
  });

  test("no mapping: the section is omitted entirely (no fake fields)", async () => {
    renderInspector(
      muxMapped({
        runtime: {
          stores: { sessions: [], cmux: [], counts: {} },
          mapping: {
            bySessionId: {},
            mappedJobs: [],
            unmappedJobs: ["task-1", "task-2"],
            unavailable: false,
            stale: false,
          },
          bridgeConnected: true,
        },
      }),
    );
    // Wait for the inspector + multiplexer fetch to settle.
    await poll(() => screen.getByText(/child session/));
    await poll(() => screen.getByText("Hierarchy"));
    expect(screen.queryByTestId("session-multiplexer")).toBeNull();
  });
});

// ── 51 · OMO jobs panel terminal mapping ─────────────────────────────

describe("51 · OMO jobs panel terminal", () => {
  function renderJobs(mux: MultiplexerSystemDto) {
    mockFetch([
      { prefix: "/api/omo/runtime", body: JOBS },
      { prefix: "/api/system/multiplexer", body: mux },
    ]);
    render(<OmoJobsPanel onSelect={() => {}} />);
  }

  test("mapped job shows `type paneId`; unmapped shows Terminal Unavailable", async () => {
    renderJobs(muxMapped());
    await poll(() => screen.getAllByTestId("job-terminal"));
    const terminals = screen.getAllByTestId("job-terminal");
    const texts = terminals.map((t) => t.textContent);
    expect(texts).toContain("tmux %5");
    expect(texts).toContain("Terminal Unavailable");
  });

  test("mapping unobservable: no terminal line at all", async () => {
    renderJobs(MUX_UNAVAILABLE);
    await poll(() => screen.getByText(/explorer/));
    expect(screen.queryByTestId("job-terminal")).toBeNull();
  });
});

// ── 53 · doctor deep-link ────────────────────────────────────────────

describe("53 · doctor multiplexer warning navigation", () => {
  function doctorPayload() {
    return {
      generatedAt: "2026-01-01T00:00:00.000Z",
      overall: "degraded",
      counts: { healthy: 0, info: 0, warning: 1, error: 0, unknown: 0 },
      categories: [{ category: "agents", healthy: 0, info: 0, warning: 1, error: 0, unknown: 0 }],
      diagnostics: [
        {
          id: "multiplexer.explicit-backend-command-missing",
          category: "agents",
          severity: "warning",
          title: "Configured multiplexer backend command not resolvable",
          summary: "tmux not resolvable.",
          remediation: { action: "navigate", target: "/system", label: "Open System" },
        },
        {
          id: "agents.model-drift",
          category: "agents",
          severity: "warning",
          title: "Model drift",
          summary: "drift.",
          remediation: { action: "navigate", target: "/system", label: "Open System" },
        },
      ],
      system: { runtimeStale: false, runtimePresetKnown: false, configGeneration: 1 },
    };
  }

  test("multiplexer diagnostics link to the Multiplexer section; others keep their target", async () => {
    mockFetch([
      { prefix: "/api/doctor", body: doctorPayload() },
      ...baseRoutes({
        agents: makeAgentsDto([]),
        providers: makeProvidersDto([]),
      }),
    ]);
    renderWithRouter(<DoctorPage />, ["/doctor"]);

    await poll(() =>
      screen.getByText("Configured multiplexer backend command not resolvable"),
    );
    fireEvent.click(
      screen.getByText("Configured multiplexer backend command not resolvable"),
    );
    await poll(() => screen.getByRole("link", { name: "Open System" }));
    expect(
      screen.getByRole("link", { name: "Open System" }).getAttribute("href"),
    ).toBe("/system?section=multiplexer");

    fireEvent.click(screen.getByText("Model drift"));
    await poll(() => screen.getByRole("link", { name: "Open System" }));
    expect(
      screen.getByRole("link", { name: "Open System" }).getAttribute("href"),
    ).toBe("/system");
  });
});

// ── agents summary + overview compact line (supporting requirements) ─

describe("agents + overview multiplexer summaries", () => {
  test("agents: tracked terminal mappings counted only when live/authoritative", async () => {
    mockFetch(
      baseRoutes({
        agents: makeAgentsDto([makeRow({ name: "explorer", kind: "builtin" })]),
        providers: makeProvidersDto([]),
        multiplexer: muxMapped(),
      }),
    );
    renderWithRouter(<AgentsPage />, ["/agents"]);
    await poll(() => screen.getByTestId("agents-tracked-mappings"));
    expect(
      screen.getByTestId("agents-tracked-mappings").textContent,
    ).toContain("1 tracked terminal mapping");
    expect(
      screen.getByTestId("agents-tracked-mappings").textContent,
    ).not.toContain("active");
  });

  test("agents: stale mapping is not counted", async () => {
    mockFetch(
      baseRoutes({
        agents: makeAgentsDto([makeRow({ name: "explorer", kind: "builtin" })]),
        providers: makeProvidersDto([]),
        multiplexer: muxMapped({
          runtime: {
            ...muxMapped().runtime,
            mapping: { ...muxMapped().runtime.mapping, stale: true },
          },
        }),
      }),
    );
    renderWithRouter(<AgentsPage />, ["/agents"]);
    await poll(() => screen.getByText(/outside preset/));
    expect(screen.queryByTestId("agents-tracked-mappings")).toBeNull();
  });

  test("overview: compact line only when observable", async () => {
    mockFetch(
      baseRoutes({
        agents: makeAgentsDto([]),
        providers: makeProvidersDto([]),
        multiplexer: muxMapped(),
      }),
    );
    renderWithRouter(<OverviewPage />, ["/"]);
    await poll(() => screen.getByTestId("overview-multiplexer"));
    expect(screen.getByTestId("overview-multiplexer").textContent).toContain(
      "Multiplexer tmux · 1 mapped OMO jobs · 1 tracked panes",
    );
  });

  test("overview: nothing rendered when unobservable", async () => {
    mockFetch(
      baseRoutes({
        agents: makeAgentsDto([]),
        providers: makeProvidersDto([]),
        multiplexer: MUX_UNAVAILABLE,
      }),
    );
    renderWithRouter(<OverviewPage />, ["/"]);
    await poll(() => screen.getByText(/OMO Config/));
    expect(screen.queryByTestId("overview-multiplexer")).toBeNull();
  });
});
