/**
 * Slice 15 §75 — probe-state integration tests (Lane 5b).
 *
 * Covers cases 14–23: AgentEditModal probe badges + Test action + advisories
 * (14–19), AgentsPage Status column incl. optional-context degradation (20),
 * CouncilPage member probe column incl. inactive presets (21), AcpPage
 * wrapper-model probe vs handshake (22), SessionsPage control-plane probe
 * session toggle (23).
 *
 * These surfaces are mounted with ModelAvailabilityProvider explicitly —
 * existing tests mount with only RuntimeProvider and rely on the optional
 * degrade path, verified here as case 20.
 */
import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { AcpPage } from "../src/pages/AcpPage";
import { AgentEditModal } from "../src/pages/AgentEditModal";
import { AgentsPage } from "../src/pages/AgentsPage";
import { CouncilPage } from "../src/pages/CouncilPage";
import { SessionsPage } from "../src/pages/SessionsPage";
import { ModelAvailabilityProvider } from "../src/models/ModelAvailabilityContext";
import { RuntimeProvider } from "../src/runtime/RuntimeContext";
import {
  baseRoutes,
  findRowByName,
  makeAgentsDto,
  makeModel,
  makeModelAvailability,
  makeModelInventoryDto,
  makeProvider,
  makeProvidersDto,
  makeRow,
  makeRuntimeState,
  mockFetch,
  poll,
  probeSummary,
  renderWithRouter,
  type World,
} from "./helpers";

function renderWithModels(ui: ReactNode) {
  return render(
    <MemoryRouter initialEntries={["/agents"]}>
      <RuntimeProvider>
        <ModelAvailabilityProvider>{ui}</ModelAvailabilityProvider>
      </RuntimeProvider>
    </MemoryRouter>,
  );
}

const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

/** Live catalog: anthropic (connected) + openai (connected). */
const LIVE_PROVIDERS = makeProvidersDto([
  makeProvider("anthropic", "Anthropic", true, [
    makeModel("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
  ]),
  makeProvider("openai", "OpenAI", true, [makeModel("openai", "gpt-5", "GPT-5")]),
]);

const ROW = makeRow({
  name: "explorer",
  kind: "builtin",
  effectiveModel: "anthropic/claude-sonnet-4-5",
});

function worldWith(
  models: Parameters<typeof makeModelInventoryDto>[0]["models"],
  overrides: Partial<World> = {},
): World {
  return {
    agents: makeAgentsDto([ROW]),
    providers: LIVE_PROVIDERS,
    models: makeModelInventoryDto({ models }),
    ...overrides,
  };
}

function renderModal(world: World) {
  mockFetch(baseRoutes(world));
  return renderWithModels(
    <AgentEditModal
      agent="explorer"
      row={ROW}
      initialModel={ROW.effectiveModel}
      onClose={() => {}}
      onApplied={() => {}}
    />,
  );
}

async function waitForCatalog() {
  await poll(() =>
    screen.getByRole("option", { name: /Anthropic \(anthropic\) — 1 models/ }),
  );
}

describe("probe integration — agent editor (slice 15 §75)", () => {
  // Case 14 — badges render in chain-probe cells, never inside <option>;
  // unknown model falls back to "Not tested".
  test("chain entries show probe badges outside option elements; manual unknown = Not tested", async () => {
    renderModal(
      worldWith([
        makeModelAvailability({
          providerId: "anthropic",
          modelId: "claude-sonnet-4-5",
          probe: probeSummary({
            state: "healthy",
            freshness: "fresh",
            latencyMs: 812,
            lastCompletedAt: isoAgo(300_000),
          }),
        }),
        makeModelAvailability({
          providerId: "openai",
          modelId: "gpt-5",
          probe: probeSummary({
            state: "unauthorized",
            freshness: "fresh",
            statusCode: 403,
            lastCompletedAt: isoAgo(300_000),
          }),
        }),
      ]),
    );
    await waitForCatalog();

    const cell = document.querySelector(".chain-probe")!;
    expect(cell.querySelector(".probe-badge")?.textContent).toContain("Healthy");
    expect(document.querySelector("option .probe-badge")).toBeNull();

    // Manual escape hatch with a model unknown to the inventory
    fireEvent.click(screen.getByRole("button", { name: "manual" }));
    fireEvent.change(screen.getByPlaceholderText("provider/model"), {
      target: { value: "acme/zz-9" },
    });
    await poll(() => {
      const c = document.querySelector(".chain-probe")!;
      expect(c.textContent).toContain("Not tested");
    });
  });

  // Case 15 — Test posts ONLY the probe endpoint (no simulate/apply) and
  // the badge follows running → result as the inventory refetches.
  test("Test button posts probe only; badge reflects queued→healthy after refetch", async () => {
    const world = worldWith([
      makeModelAvailability({
        providerId: "anthropic",
        modelId: "claude-sonnet-4-5",
      }),
    ]);
    const mock = mockFetch(baseRoutes(world));
    renderWithModels(
      <AgentEditModal
        agent="explorer"
        row={ROW}
        initialModel={ROW.effectiveModel}
        onClose={() => {}}
        onApplied={() => {}}
      />,
    );
    await waitForCatalog();
    expect(
      document.querySelector(".chain-probe .probe-badge")?.textContent,
    ).toContain("Not tested");

    // Swap inventory to "running" mid-flight of the first Test.
    world.probeSingle = (call) => {
      world.models = makeModelInventoryDto({
        models: [
          makeModelAvailability({
            providerId: "anthropic",
            modelId: "claude-sonnet-4-5",
            probe: probeSummary({
              state: "running",
              freshness: "stale",
              lastStartedAt: isoAgo(1_000),
            }),
          }),
        ],
      });
      const body = call.body as { providerId: string; modelId: string };
      return { id: "q-1", ...body, state: "pending", enqueuedAt: isoAgo(0) };
    };
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await poll(() => {
      expect(mock.callsTo("/api/models/probe", "POST")).toHaveLength(1);
      expect(
        document.querySelector(".chain-probe .probe-badge")?.textContent,
      ).toContain("Running");
    });
    expect(mock.callsTo("/api/config/simulate", "POST")).toHaveLength(0);
    expect(mock.callsTo("/api/config/apply", "POST")).toHaveLength(0);
    const firstBody = mock.callsTo("/api/models/probe", "POST")[0]!.body as {
      providerId: string;
      modelId: string;
      force: boolean;
    };
    expect(firstBody).toEqual({
      providerId: "anthropic",
      modelId: "claude-sonnet-4-5",
      force: true,
    });

    // Second refresh wave: probe completed healthy.
    world.probeSingle = (call) => {
      world.models = makeModelInventoryDto({
        models: [
          makeModelAvailability({
            providerId: "anthropic",
            modelId: "claude-sonnet-4-5",
            probe: probeSummary({
              state: "healthy",
              freshness: "fresh",
              latencyMs: 812,
              statusCode: 200,
              lastCompletedAt: isoAgo(1_000),
            }),
          }),
        ],
      });
      const body = call.body as { providerId: string; modelId: string };
      return { id: "q-2", ...body, state: "pending", enqueuedAt: isoAgo(0) };
    };
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await poll(() => {
      expect(
        document.querySelector(".chain-probe .probe-badge")?.textContent,
      ).toContain("Healthy");
    });
    // Still zero config-mutation calls across the whole flow.
    expect(mock.callsTo("/api/config/simulate", "POST")).toHaveLength(0);
    expect(mock.callsTo("/api/config/apply", "POST")).toHaveLength(0);
  });

  // Case 16 — unauthorized model remains selectable and savable; preview
  // shows the WARNING but Apply still works.
  test("unauthorized model: selectable, preview warns, Apply still saves", async () => {
    const mock = mockFetch(
      baseRoutes(
        worldWith([
          makeModelAvailability({
            providerId: "anthropic",
            modelId: "claude-sonnet-4-5",
          }),
          makeModelAvailability({
            providerId: "openai",
            modelId: "gpt-5",
            probe: probeSummary({
              state: "unauthorized",
              freshness: "fresh",
              statusCode: 403,
              lastCompletedAt: isoAgo(60_000),
            }),
          }),
        ]),
      ),
    );
    renderWithModels(
      <AgentEditModal
        agent="explorer"
        row={ROW}
        initialModel={ROW.effectiveModel}
        onClose={() => {}}
        onApplied={() => {}}
      />,
    );
    await waitForCatalog();

    const [providerSelect, modelSelect] = screen.getAllByRole(
      "combobox",
    ) as HTMLSelectElement[];
    fireEvent.change(providerSelect, { target: { value: "openai" } });
    fireEvent.change(modelSelect, { target: { value: "gpt-5" } });
    expect(modelSelect.value).toBe("gpt-5"); // NOT filtered/disabled

    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    // The chain-row badge ALSO renders "Unauthorized · 403" — scope the
    // advisory assertions to the warn-block element itself.
    await poll(() => {
      const warn = [...document.querySelectorAll(".warn-block")].find((el) =>
        el.textContent?.includes("Selected model was explicitly probed and failed"),
      );
      expect(warn).toBeTruthy();
      expect(warn!.textContent).toContain("Unauthorized · 403");
      expect(warn!.textContent).toContain("You may still save this configuration");
    });

    await poll(() =>
      expect(
        (screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await poll(() =>
      expect(mock.callsTo("/api/config/apply", "POST")).toHaveLength(1),
    );
    // NOTE: modal-closing is parent-driven (standalone mount keeps onClose a
    // no-op); the apply call above is the "still savable" proof.
  });

  // Case 17 — never-probed model → INFO advisory, Apply enabled.
  test("never-probed model: preview shows info advisory, Apply enabled", async () => {
    mockFetch(
      baseRoutes(
        worldWith([
          // inventory does NOT contain gpt-5 at all
          makeModelAvailability({
            providerId: "anthropic",
            modelId: "claude-sonnet-4-5",
          }),
        ]),
      ),
    );
    renderWithModels(
      <AgentEditModal
        agent="explorer"
        row={ROW}
        initialModel={ROW.effectiveModel}
        onClose={() => {}}
        onApplied={() => {}}
      />,
    );
    await waitForCatalog();

    const [providerSelect, modelSelect] = screen.getAllByRole(
      "combobox",
    ) as HTMLSelectElement[];
    fireEvent.change(providerSelect, { target: { value: "openai" } });
    fireEvent.change(modelSelect, { target: { value: "gpt-5" } });

    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    await poll(() =>
      screen.getByText(/Selected model has never been probed/),
    );
    await poll(() =>
      expect(
        (screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  });

  // Case 18 — provider disconnected: Test disabled with reason title;
  // Apply remains gated only on preview, NOT on probe state.
  test("disconnected provider: Test disabled with title, Apply unaffected", async () => {
    mockFetch(
      baseRoutes({
        agents: makeAgentsDto([
          makeRow({
            name: "explorer",
            kind: "builtin",
            effectiveModel: "openai/gpt-5",
          }),
        ]),
        providers: makeProvidersDto([
          makeProvider("openai", "OpenAI", false, [
            makeModel("openai", "gpt-5", "GPT-5"),
          ]),
        ]),
        models: makeModelInventoryDto({
          models: [
            makeModelAvailability({
              providerId: "openai",
              modelId: "gpt-5",
              provider: { known: true, connected: false },
            }),
          ],
        }),
      }),
    );
    renderWithModels(
      <AgentEditModal
        agent="explorer"
        row={makeRow({
          name: "explorer",
          kind: "builtin",
          effectiveModel: "openai/gpt-5",
        })}
        initialModel="openai/gpt-5"
        onClose={() => {}}
        onApplied={() => {}}
      />,
    );
    await poll(() =>
      screen.getByRole("option", { name: /OpenAI \(openai\) — 1 models/ }),
    );

    const testBtn = screen.getByRole("button", { name: "Test" }) as HTMLButtonElement;
    expect(testBtn.disabled).toBe(true);
    expect(testBtn.title).toBe("Provider is not connected in OpenCode");

    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    await poll(() => screen.getByText("Preview — model"));
    await poll(() =>
      expect(
        (screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  });

  // Case 19 — fallback chain: per-entry badges + semantic summary line.
  test("chain summary reports primary failure and healthy fallback with disclaimer", async () => {
    renderModal(
      worldWith([
        makeModelAvailability({
          providerId: "anthropic",
          modelId: "claude-sonnet-4-5",
          probe: probeSummary({
            state: "unauthorized",
            freshness: "fresh",
            statusCode: 403,
            lastCompletedAt: isoAgo(60_000),
          }),
        }),
        makeModelAvailability({
          providerId: "openai",
          modelId: "gpt-5",
          probe: probeSummary({
            state: "healthy",
            freshness: "fresh",
            latencyMs: 410,
            lastCompletedAt: isoAgo(300_000),
          }),
        }),
      ]),
    );
    await waitForCatalog();

    // Add a fallback and point it at the healthy openai/gpt-5.
    // NOTE: entry-variant <input list> nodes also expose the "combobox"
    // role under happy-dom, so scope <select>s per chain row instead of
    // indexing getAllByRole("combobox").
    fireEvent.click(screen.getByRole("button", { name: "Add fallback" }));
    const rows = document.querySelectorAll(".chain-row");
    const [p1, m1] = [
      ...(rows[1]!.querySelectorAll("select") as NodeListOf<HTMLSelectElement>),
    ];
    fireEvent.change(p1!, { target: { value: "openai" } });
    fireEvent.change(m1!, { target: { value: "gpt-5" } });

    await poll(() => {
      const badges = document.querySelectorAll(".chain-probe .probe-badge");
      expect(badges).toHaveLength(2);
      expect(badges[0]!.textContent).toContain("Unauthorized");
      expect(badges[1]!.textContent).toContain("Healthy");
    });

    screen.getByText(/Primary failed its last explicit probe \(Unauthorized · 403\)/);
    screen.getByText(/Fallback 1 last known healthy/);
    // The disclaimer text also appears in the section's static header
    // note — scope this assertion to the chain summary element itself.
    const chainNote = document.querySelector(".agents-chain-note");
    expect(chainNote).toBeTruthy();
    expect(chainNote?.textContent).toContain(
      "does not predict OMO runtime fallback behavior",
    );
  });
});

describe("probe integration — agents / council / acp / sessions (slice 15 §75)", () => {
  // Case 20a — AgentsPage Status column: healthy rows are quiet (no badge
  // text, empty — not a dash), failure states render a visible label.
  test("AgentsPage Status column is quiet on healthy; visible on failure", async () => {
    mockFetch(
      baseRoutes(
        worldWith([
          makeModelAvailability({
            providerId: "anthropic",
            modelId: "claude-sonnet-4-5",
            probe: probeSummary({
              state: "timeout",
              freshness: "fresh",
              lastCompletedAt: isoAgo(60_000),
            }),
          }),
        ]),
      ),
    );
    renderWithModels(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));
    screen.getByRole("columnheader", { name: /Status/ });
    // Failure renders a visible label.
    within(findRowByName("explorer")).getByText("Timeout");
  });

  // Case 20a-healthy — Healthy rows render no "Healthy" text; the row is silent.
  test("AgentsPage Status column is quiet when primary is healthy", async () => {
    mockFetch(
      baseRoutes(
        worldWith([
          makeModelAvailability({
            providerId: "anthropic",
            modelId: "claude-sonnet-4-5",
            probe: probeSummary({
              state: "healthy",
              freshness: "fresh",
              latencyMs: 812,
              lastCompletedAt: isoAgo(300_000),
            }),
          }),
        ]),
      ),
    );
    renderWithModels(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));
    screen.getByRole("columnheader", { name: /Status/ });
    expect(within(findRowByName("explorer")).queryByText("Healthy")).toBeNull();
    expect(document.querySelector(".probe-badge")).toBeNull();
  });

  // Case 20b — without ModelAvailabilityProvider the column degrades to a
  // quiet empty status (proves the optional-hook path used by existing
  // tests). Quiet is EMPTY — never a dash.
  test("AgentsPage Status column degrades to quiet-empty without availability context", async () => {
    mockFetch(
      baseRoutes({
        agents: makeAgentsDto([ROW]),
        providers: LIVE_PROVIDERS,
      }),
    );
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));
    screen.getByRole("columnheader", { name: /Status/ });
    expect(document.querySelector(".probe-badge")).toBeNull();
    const status = findRowByName("explorer").querySelectorAll("td")[2]!;
    expect(status.textContent?.trim()).toBe("");
    expect(status.querySelector(".team-status-quiet")).toBeTruthy();
    expect(status.textContent).not.toContain("Testing");
  });

  // Case 21 — CouncilPage member probe column, dimmed on inactive presets.
  test("Council members show probe badges; inactive preset rows dimmed", async () => {
    mockFetch([
      { prefix: "/api/council/runtime", body: { sessions: [] } },
      {
        prefix: "/api/council",
        body: {
          effective_default_preset: "trio",
          defaultMissing: false,
          presets: [
            {
              name: "trio",
              sourceScopes: ["user"],
              isDefault: true,
              memberCount: 1,
              uniqueModels: 1,
              providers: ["anthropic"],
              members: [
                {
                  name: "alpha",
                  modelPrimary: "anthropic/claude-sonnet-4-5",
                  hasPrompt: false,
                  warnings: [],
                },
              ],
              raw: {},
              empty: false,
            },
            {
              name: "duo",
              sourceScopes: ["user"],
              isDefault: false,
              memberCount: 1,
              uniqueModels: 1,
              providers: ["openai"],
              members: [
                {
                  name: "beta",
                  modelPrimary: "openai/gpt-5",
                  hasPrompt: false,
                  warnings: [],
                },
              ],
              raw: {},
              empty: false,
            },
          ],
          coordinator: { agent: "council", note: "fixture" },
          deprecated: [],
          warnings: [],
        },
      },
      ...baseRoutes(
        worldWith([
          makeModelAvailability({
            providerId: "anthropic",
            modelId: "claude-sonnet-4-5",
            probe: probeSummary({
              state: "healthy",
              freshness: "fresh",
              latencyMs: 812,
              lastCompletedAt: isoAgo(300_000),
            }),
          }),
          makeModelAvailability({
            providerId: "openai",
            modelId: "gpt-5",
            probe: probeSummary({
              state: "unauthorized",
              freshness: "fresh",
              statusCode: 403,
              lastCompletedAt: isoAgo(300_000),
            }),
          }),
        ]),
      ),
    ]);
    renderWithModels(<CouncilPage />);
    await poll(() => screen.getByText("alpha"));

    // Default preset: full-emphasis badge (latency included), no dim wrapper
    within(findRowByName("alpha")).getByText("Healthy · 812ms");
    expect(document.querySelector(".probe-dim")).toBeNull();

    // Inactive preset: badge present but dimmed
    fireEvent.click(screen.getByText("duo"));
    await poll(() => {
      within(findRowByName("beta")).getByText("Unauthorized · 403");
    });
    const dimRow = findRowByName("beta");
    expect(dimRow.querySelector(".probe-dim")).not.toBeNull();
    expect(dimRow.querySelector(".probe-dim .probe-badge")).not.toBeNull();
  });

  // Case 22 — AcpPage shows wrapper-model probe distinct from handshake.
  test("AcpPage shows wrapper model probe separately from handshake panel", async () => {
    mockFetch([
      { prefix: "/api/acp/runtime", body: { sessions: [] } },
      {
        prefix: "/api/acp/probe",
        method: "POST",
        body: {
          ok: true,
          started: true,
          handshake: true,
          agentInfo: { name: "acp-code", version: "1.0", protocolVersion: 1 },
          elapsedMs: 230,
          terminated: true,
        },
      },
      {
        prefix: "/api/acp",
        body: {
          note: "fixture",
          agents: [
            {
              name: "acp-code",
              sourceScopes: ["user"],
              config: {},
              envMasked: {},
              secretKeyCount: 0,
              command: "npx",
              wrapperModel: "openai/gpt-5",
              permissionMode: "denyAll",
              permission: "deny-all except acp_run",
              wrapperRegistered: true,
              warnings: [],
            },
          ],
        },
      },
      ...baseRoutes(
        worldWith([
          makeModelAvailability({
            providerId: "openai",
            modelId: "gpt-5",
            probe: probeSummary({
              state: "unauthorized",
              freshness: "fresh",
              statusCode: 403,
              lastCompletedAt: isoAgo(300_000),
            }),
          }),
        ]),
      ),
    ]);
    renderWithModels(<AcpPage />);
    await poll(() => screen.getByText("wrapper model probe"));
    within(screen.getByText("wrapper model probe").parentElement!.parentElement as HTMLElement);

    // The wrapper-model badge shows the model probe state…
    const badgeRow = screen.getByText("wrapper model probe");
    expect(badgeRow.parentElement?.textContent).toContain("Unauthorized"); // dd content via next sibling check below
    expect(
      (badgeRow.nextElementSibling?.textContent ?? "").includes("Unauthorized · 403"),
    ).toBe(true);

    // …which is a different signal from the ACP handshake probe panel.
    expect(screen.queryByText("Handshake probe")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Probe handshake" }));
    await poll(() => screen.getByText("Handshake probe"));
    // Both panels now coexist.
    screen.getByText("wrapper model probe");
    screen.getByText(/ok/);
  });

  // Case 23 — SessionsPage: CP probe sessions hidden by default; toggle
  // refetches with the include flag + shows CP probe pills; toggling off
  // with a probe session selected resets selection safely.
  test("sessions: CP probe toggle refetches, shows pills, resets selection", async () => {
    const normal = {
      id: "sess-normal",
      agent: "explorer",
      title: "Normal session",
      status: "idle",
    };
    const probe = {
      id: "sess-probe",
      agent: "prober",
      title: "probe openai/gpt-5",
      status: "idle",
      controlPlaneProbe: true,
    };
    const rt = makeRuntimeState();
    rt.sessions = {
      roots: [normal],
      flat: [normal],
      total: 1,
      byStatus: { idle: 1 },
    };
    const detail = (id: string) => ({
      id,
      exists: true,
      initialInstructionLabel: "none",
      messages: [],
      activity: [],
      diff: { files: [], totalAdditions: 0, totalDeletions: 0, empty: true },
      permissions: [],
      children: [],
      siblings: [],
      errors: [],
      fetchedAt: isoAgo(0),
    });
    const mock = mockFetch([
      { prefix: "/api/runtime", respond: () => rt },
      {
        prefix: "/api/sessions?includeControlPlaneProbes=1",
        body: {
          roots: [normal, probe],
          flat: [normal, probe],
          total: 2,
        },
      },
      { prefix: "/api/sessions/", respond: (url) => detail(url.split("/").pop()!) },
      ...baseRoutes(worldWith([])),
    ]);
    renderWithModels(<SessionsPage />);

    // Default: probe sessions hidden (runtime bootstrap has none).
    await poll(() =>
      expect(screen.getAllByText(/Normal session/).length).toBeGreaterThan(0),
    );
    expect(screen.queryByText("CP probe")).toBeNull();

    // Toggle on → refetch with include flag, probe row + pill appear.
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Show control-plane probe sessions/,
      }),
    );
    await poll(() => screen.getByText("CP probe"));
    screen.getByText(/probe openai\/gpt-5/);
    expect(
      mock.calls.filter((c) => c.url === "/api/sessions?includeControlPlaneProbes=1")
        .length,
    ).toBeGreaterThan(0);

    // Select the probe session, then toggle off → selection resets safely.
    fireEvent.click(screen.getByText(/probe openai\/gpt-5/).closest("button")!);
    await poll(() => {
      expect(
        screen.getByRole("option", { selected: true }).textContent,
      ).toContain("probe openai/gpt-5");
    });

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Show control-plane probe sessions/,
      }),
    );
    await poll(() => {
      expect(screen.queryByText("CP probe")).toBeNull();
      expect(
        screen.getByRole("option", { selected: true }).textContent,
      ).toContain("Normal session");
    });
  });
});
