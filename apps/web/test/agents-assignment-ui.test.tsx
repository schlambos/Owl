/**
 * Team roster assignment IA — grouped roster redesign.
 *
 * Five columns exactly: Agent | Model | Status | Source | Actions.
 * The default view (no explicit sort) groups rows by authoritative
 * metadata — Built-in Team / Custom Agents / Disabled / Native — with
 * group-default source values suppressed visually (but still disclosed
 * via aria-label + the provenance toggle). An explicit sort switches to
 * a flat comparison table.
 *
 * Covers compression/expansion (Assigned/Effected/Live layers), status
 * merging (fallbacks + adverse model health; quiet = empty, not dash),
 * source suppression & disclosure accessibility, ownership routes, and
 * the drawer/editor transitions. Semantic assertions only — no snapshots.
 *
 * The row entry action's final intended label is "Change Model"
 * (renamed from "Edit" during parallel polish); ENTRY_ACTION accepts the
 * transition label but tests never assert old-Edit-only semantics.
 */
import { describe, expect, test } from "bun:test";
import { fireEvent, screen, within } from "@testing-library/react";
import type { AgentsDto, DesiredAgent } from "@omo/shared";
import { AgentsPage } from "../src/pages/AgentsPage";
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
  mockFetch,
  poll,
  probeSummary,
  renderWithRouter,
  type World,
} from "./helpers";
import { ModelAvailabilityProvider } from "../src/models/ModelAvailabilityContext";
import { MemoryRouter } from "react-router-dom";
import { RuntimeProvider } from "../src/runtime/RuntimeContext";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";

function renderWithModels(ui: ReactNode, initialEntries: string[] = ["/agents"]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <RuntimeProvider>
        <ModelAvailabilityProvider>{ui}</ModelAvailabilityProvider>
      </RuntimeProvider>
    </MemoryRouter>,
  );
}

const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

/**
 * Row entry action into the model editor. Final intended label is
 * "Change Model"; "Edit" is accepted only while the parallel label
 * polish is in flight.
 */
const ENTRY_ACTION = /^(Change Model|Edit)$/;

/** Build a DesiredAgent with a single model string. */
function desiredAgent(model: string | undefined): DesiredAgent {
  return {
    name: "explorer",
    kind: "builtin",
    model,
    sourceIds: ["fixture"],
  };
}

/** Build an AgentsDto with preset + root desired config populated. */
function makeAgentsDtoWithDesired(opts: {
  preset?: string;
  presetAgents?: Record<string, DesiredAgent>;
  rootAgents?: Record<string, DesiredAgent>;
  rows: AgentsDto["rows"];
}): AgentsDto {
  const base = makeAgentsDto(opts.rows, opts.preset);
  base.desired.presets = opts.presetAgents
    ? { [opts.preset ?? "openai"]: opts.presetAgents }
    : {};
  base.desired.agents = opts.rootAgents ?? {};
  return base;
}

function headerLabels(): string[] {
  return Array.from(
    document.querySelectorAll("table.agents-table thead th"),
  ).map((th) => th.textContent?.replace(/[·▲▼]/g, "").trim() ?? "");
}

/** Agent row order, excluding roster group-header rows. */
function rowNames(): string[] {
  return Array.from(
    document.querySelectorAll("table.agents-table tbody tr[data-agent]"),
  ).map((tr) => tr.querySelector(".agent-name-btn")?.textContent ?? "");
}

/** Roster group header rows (default grouped view only). */
function groupHeaders(): Array<{ id: string; text: string }> {
  return Array.from(
    document.querySelectorAll("tr.team-roster-group"),
  ).map((tr) => ({
    id: tr.getAttribute("data-group") ?? "",
    text: tr.textContent ?? "",
  }));
}

describe("agents assignment IA — column structure", () => {
  test("exactly five headers: Agent | Model | Status | Source | Actions", async () => {
    const rows = [
      makeRow({
        name: "explorer",
        kind: "builtin",
        effectiveModel: "ollama-cloud/deepseek-v4-flash:0731",
        modelSourceStage: "preset",
      }),
    ];
    const dto = makeAgentsDtoWithDesired({
      preset: "openai",
      presetAgents: {
        explorer: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
      },
      rows,
    });
    mockFetch(baseRoutes({ agents: dto, providers: makeProvidersDto([]) }));
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    const ths = Array.from(
      document.querySelectorAll("table.agents-table thead th"),
    );
    expect(ths).toHaveLength(5);
    expect(headerLabels()).toEqual([
      "Agent",
      "Model",
      "Status",
      "Source",
      "Actions",
    ]);
    // Removed columns must not exist.
    for (const gone of ["Provider", "Fallbacks", "Probe", "Sessions"]) {
      expect(
        screen.queryByRole("columnheader", { name: gone }),
      ).toBeNull();
    }
  });
});

describe("agents assignment IA — compression & expansion", () => {
  test("aligned row compresses: one human model line + quiet provider/canonical", async () => {
    const rows = [
      makeRow({
        name: "explorer",
        kind: "builtin",
        effectiveModel: "ollama-cloud/deepseek-v4-flash:0731",
        effectiveVariant: "high",
        liveModel: "ollama-cloud/deepseek-v4-flash:0731",
        liveVariant: "high",
        modelSourceStage: "preset",
      }),
    ];
    const dto = makeAgentsDtoWithDesired({
      preset: "openai",
      presetAgents: {
        explorer: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
      },
      rows,
    });

    mockFetch(
      baseRoutes({
        agents: dto,
        providers: makeProvidersDto([
          makeProvider("ollama-cloud", "Ollama Cloud", true, [
            makeModel(
              "ollama-cloud",
              "deepseek-v4-flash:0731",
              "DeepSeek V4 Flash 0731",
            ),
          ]),
        ]),
      }),
    );
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    const row = findRowByName("explorer");
    const cells = row.querySelectorAll("td");
    const modelCell = cells[1]!;
    // One human model line with the agent variant.
    expect(modelCell.textContent).toContain("DeepSeek V4 Flash 0731");
    expect(modelCell.textContent).toContain("high");
    // No "Assigned"/"Effective"/"Live" labels in an aligned row.
    expect(modelCell.textContent).not.toMatch(/Assigned/);
    expect(modelCell.textContent).not.toMatch(/Effective/);
    expect(modelCell.textContent).not.toMatch(/Live/);
    // Aligned rows carry no alignment status either.
    const statusCell = cells[2]!;
    expect(statusCell.textContent).not.toContain("Assignment overridden");
    expect(statusCell.textContent).not.toContain("Runtime drift");
    expect(statusCell.querySelector(".team-status-quiet")).toBeTruthy();
    // Provider + canonical id are quiet but VISIBLE secondary text (never
    // tooltip-only).
    const quiet = modelCell.querySelector(".model-canonical");
    expect(quiet?.textContent).toContain("Ollama Cloud");
    expect(quiet?.textContent).toContain("ollama-cloud/deepseek-v4-flash:0731");
    // Full canonical id also on the cell title for long names.
    expect(
      modelCell.querySelector(".model-cell")?.getAttribute("title"),
    ).toBe("ollama-cloud/deepseek-v4-flash:0731");
  });

  test("Assigned ≠ Effective expands to Assigned + Effective + Assignment overridden", async () => {
    const rows = [
      makeRow({
        name: "explorer",
        kind: "builtin",
        effectiveModel: "openai/gpt-5.6-sol",
        effectiveVariant: "max",
        liveModel: "openai/gpt-5.6-sol",
        liveVariant: "max",
        modelSourceStage: "root-agent",
      }),
    ];
    const dto = makeAgentsDtoWithDesired({
      preset: "openai",
      presetAgents: {
        explorer: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
      },
      rootAgents: {
        explorer: desiredAgent("openai/gpt-5.6-sol"),
      },
      rows,
    });

    mockFetch(baseRoutes({ agents: dto, providers: makeProvidersDto([]) }));
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    const row = findRowByName("explorer");
    const cells = row.querySelectorAll("td");
    const modelCell = cells[1]!;
    expect(modelCell.textContent).toContain("Assigned");
    expect(modelCell.textContent).toContain("Effective");
    expect(modelCell.textContent).not.toMatch(/\bLive\b/);
    expect(modelCell.textContent).toContain("gpt-5.6-sol");
    expect(modelCell.textContent).toContain("deepseek-v4-flash:0731");
    expect(modelCell.textContent).toContain("Assignment overridden");
    expect(modelCell.textContent).not.toContain("Runtime drift");
    // Status column carries the override pill (and only that pill).
    const statusCell = cells[2]!;
    expect(statusCell.textContent).toContain("Assignment overridden");
    expect(statusCell.textContent).not.toContain("Runtime drift");
  });

  test("Effective ≠ Live expands to Effective + Live + Runtime drift", async () => {
    const rows = [
      makeRow({
        name: "fixer",
        kind: "builtin",
        desiredModel: "ollama-cloud/kimi-k3",
        effectiveModel: "ollama-cloud/kimi-k3",
        effectiveVariant: "xhigh",
        liveModel: "alibaba-token-plan/qwen3.8-max",
        liveVariant: "xhigh",
        modelSourceStage: "preset",
      }),
    ];
    const dto = makeAgentsDtoWithDesired({
      preset: "openai",
      presetAgents: { fixer: desiredAgent("ollama-cloud/kimi-k3") },
      rows,
    });

    mockFetch(baseRoutes({ agents: dto, providers: makeProvidersDto([]) }));
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("fixer"));

    const cells = findRowByName("fixer").querySelectorAll("td");
    const modelCell = cells[1]!;
    expect(modelCell.textContent).toContain("Effective");
    expect(modelCell.textContent).toContain("Live");
    expect(modelCell.textContent).not.toContain("Assigned");
    expect(modelCell.textContent).toContain("Runtime drift");
    expect(modelCell.textContent).not.toContain("Assignment overridden");
    expect(modelCell.textContent).toContain("kimi-k3");
    expect(modelCell.textContent).toContain("qwen3.8-max");
    // Status column carries the drift pill (and only that pill).
    const statusCell = cells[2]!;
    expect(statusCell.textContent).toContain("Runtime drift");
    expect(statusCell.textContent).not.toContain("Assignment overridden");
  });

  test("both: all three layers + both distinct labels", async () => {
    const rows = [
      makeRow({
        name: "critic",
        kind: "custom",
        desiredModel: "xai/grok-4.5",
        effectiveModel: "xai/grok-4.5",
        effectiveVariant: "xhigh",
        liveModel: "alibaba-token-plan/qwen3.8-max",
        liveVariant: "xhigh",
        modelSourceStage: "root-agent",
      }),
    ];
    const dto = makeAgentsDtoWithDesired({
      preset: "openai",
      presetAgents: { critic: desiredAgent("openai/gpt-5.6") },
      rootAgents: { critic: desiredAgent("xai/grok-4.5") },
      rows,
    });

    mockFetch(baseRoutes({ agents: dto, providers: makeProvidersDto([]) }));
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("critic"));

    const cells = findRowByName("critic").querySelectorAll("td");
    const modelCell = cells[1]!;
    expect(modelCell.textContent).toContain("Assigned");
    expect(modelCell.textContent).toContain("Effective");
    expect(modelCell.textContent).toContain("Live");
    expect(modelCell.textContent).toContain("Assignment overridden");
    expect(modelCell.textContent).toContain("Runtime drift");
    // Status column carries both pills.
    const statusCell = cells[2]!;
    expect(statusCell.textContent).toContain("Assignment overridden");
    expect(statusCell.textContent).toContain("Runtime drift");
  });
});

describe("agents assignment IA — status (fallbacks + model health)", () => {
  test("+N fallbacks with independent ordered disclosure (aria-expanded)", async () => {
    const rows = [
      makeRow({
        name: "explorer",
        kind: "builtin",
        effectiveModel: "ollama-cloud/deepseek-v4-flash:0731",
        modelSourceStage: "preset",
      }),
    ];
    const dto = makeAgentsDtoWithDesired({
      preset: "openai",
      presetAgents: {
        explorer: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
      },
      rows,
    });
    dto.effective.agents.explorer = {
      name: "explorer",
      kind: "builtin",
      enabled: true,
      modelPrimary: "ollama-cloud/deepseek-v4-flash:0731",
      modelFallbacks: ["openai/gpt-5", "anthropic/claude-sonnet-4-5"],
      skills: [],
      mcps: [],
      hasInlinePrompt: false,
      hasOrchestratorPrompt: false,
      provenance: [],
      fieldProvenance: {},
    };

    mockFetch(baseRoutes({ agents: dto, providers: makeProvidersDto([]) }));
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    const row = findRowByName("explorer");
    // Fallbacks live in the Status cell (index 2).
    const status = row.querySelectorAll("td")[2]!;
    const fbBtn = within(status).getByRole("button", { name: /2 fallbacks/ });
    expect(fbBtn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(fbBtn);
    await poll(() => screen.getByText("Ordered fallback chain"));
    expect(fbBtn.getAttribute("aria-expanded")).toBe("true");
    const listId = fbBtn.getAttribute("aria-controls");
    expect(listId).toBeTruthy();
    const items = document.querySelectorAll(`#${listId} li`);
    expect(items).toHaveLength(2);
    expect(items[0]?.getAttribute("title")).toBe("openai/gpt-5");
    expect(items[1]?.getAttribute("title")).toBe("anthropic/claude-sonnet-4-5");
    // Independent: opening the chain must NOT open the drawer.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("primary + fallback adverse issues: first issue + '+N more'", async () => {
    const world: World = {
      agents: makeAgentsDtoWithDesired({
        preset: "openai",
        presetAgents: {
          fixer: desiredAgent("ollama-cloud/kimi-k3"),
        },
        rows: [
          makeRow({
            name: "fixer",
            kind: "builtin",
            effectiveModel: "ollama-cloud/kimi-k3",
            modelSourceStage: "preset",
          }),
        ],
      }),
      providers: makeProvidersDto([]),
      models: makeModelInventoryDto({
        models: [
          makeModelAvailability({
            providerId: "ollama-cloud",
            modelId: "kimi-k3",
            probe: probeSummary({
              state: "timeout",
              freshness: "fresh",
              lastCompletedAt: isoAgo(60_000),
            }),
          }),
          makeModelAvailability({
            providerId: "openai",
            modelId: "gpt-5",
            probe: probeSummary({
              state: "provider-disconnected",
              freshness: "fresh",
              lastCompletedAt: isoAgo(60_000),
            }),
          }),
        ],
      }),
    };
    world.agents.effective.agents.fixer = {
      name: "fixer",
      kind: "builtin",
      enabled: true,
      modelPrimary: "ollama-cloud/kimi-k3",
      modelFallbacks: ["openai/gpt-5"],
      skills: [],
      mcps: [],
      hasInlinePrompt: false,
      hasOrchestratorPrompt: false,
      provenance: [],
      fieldProvenance: {},
    };

    mockFetch(baseRoutes(world));
    renderWithModels(<AgentsPage />);
    await poll(() => screen.getByText("fixer"));

    const status = findRowByName("fixer").querySelectorAll("td")[2]!;
    // First issue (primary timeout) is visible…
    expect(status.textContent).toContain("Timeout");
    // …the fallback disconnect is behind "+1 more".
    expect(status.textContent).not.toContain("Provider disconnected");
    const more = within(status as HTMLElement).getByRole("button", {
      name: "+1 more",
    });
    fireEvent.click(more);
    await poll(() => {
      expect(status.textContent).toContain("Provider disconnected");
    });
    expect(more.getAttribute("aria-expanded")).toBe("true");
  });

  test("healthy and never-probed are quiet (empty, not dash); running primary says Testing", async () => {
    const world: World = {
      agents: makeAgentsDtoWithDesired({
        preset: "openai",
        presetAgents: {
          explorer: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
          fixer: desiredAgent("ollama-cloud/kimi-k3"),
          oracle: desiredAgent("openai/gpt-5.6-sol"),
        },
        rows: [
          makeRow({
            name: "explorer",
            kind: "builtin",
            effectiveModel: "ollama-cloud/deepseek-v4-flash:0731",
            modelSourceStage: "preset",
          }),
          makeRow({
            name: "fixer",
            kind: "builtin",
            effectiveModel: "ollama-cloud/kimi-k3",
            modelSourceStage: "preset",
          }),
          makeRow({
            name: "oracle",
            kind: "builtin",
            effectiveModel: "openai/gpt-5.6-sol",
            modelSourceStage: "preset",
          }),
        ],
      }),
      providers: makeProvidersDto([]),
      models: makeModelInventoryDto({
        models: [
          makeModelAvailability({
            providerId: "ollama-cloud",
            modelId: "deepseek-v4-flash:0731",
            probe: probeSummary({
              state: "healthy",
              freshness: "fresh",
              latencyMs: 812,
              lastCompletedAt: isoAgo(60_000),
            }),
          }),
          makeModelAvailability({
            providerId: "ollama-cloud",
            modelId: "kimi-k3",
            probe: probeSummary({ state: "never", freshness: "never" }),
          }),
          makeModelAvailability({
            providerId: "openai",
            modelId: "gpt-5.6-sol",
            probe: probeSummary({
              state: "running",
              freshness: "stale",
              lastStartedAt: isoAgo(1_000),
            }),
          }),
        ],
      }),
    };

    mockFetch(baseRoutes(world));
    renderWithModels(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    // Healthy primary: quiet status is EMPTY — never a dash, never "Healthy".
    const explorerStatus = findRowByName("explorer").querySelectorAll("td")[2]!;
    expect(explorerStatus.textContent?.trim()).toBe("");
    expect(explorerStatus.querySelector(".team-status-quiet")).toBeTruthy();
    expect(
      within(findRowByName("explorer")).queryByText("Healthy"),
    ).toBeNull();
    expect(document.querySelector(".probe-badge")).toBeNull();

    // Never-probed primary: equally quiet (no "Not tested").
    const fixerStatus = findRowByName("fixer").querySelectorAll("td")[2]!;
    expect(fixerStatus.textContent?.trim()).toBe("");
    expect(fixerStatus.querySelector(".team-status-quiet")).toBeTruthy();
    expect(
      within(findRowByName("fixer")).queryByText("Not tested"),
    ).toBeNull();

    // Running primary: quiet "Testing", and NOT counted as a model issue.
    const oracleStatus = findRowByName("oracle").querySelectorAll("td")[2]!;
    expect(oracleStatus.textContent).toContain("Testing");
    const issuesChip = screen.getByRole("radio", { name: /Model Issues, 0/ });
    expect(issuesChip).toBeTruthy();
  });
});

describe("agents assignment IA — ownership", () => {
  test("disabled Observer is an ordinary editable row (entry action + Caps) in the Disabled group", async () => {
    const rows = [makeRow({ name: "observer", kind: "builtin", enabled: false })];
    const dto = makeAgentsDtoWithDesired({ preset: "openai", rows });

    mockFetch(baseRoutes({ agents: dto, providers: makeProvidersDto([]) }));
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("observer"));

    const row = findRowByName("observer");
    within(row).getByText("Disabled");
    within(row).getByText("Unconfigured");
    within(row).getByRole("button", { name: ENTRY_ACTION });
    within(row).getByRole("button", { name: /Edit capabilities for observer/ });
    // Grouped by state, not kind: the disabled builtin lands in the
    // Disabled group and the Built-in Team group is omitted entirely.
    const groups = groupHeaders();
    expect(groups.map((g) => g.id)).toEqual(["disabled"]);
    expect(groups[0]!.text).toContain("Disabled");
  });

  test("council WITH a normal effective assignment is editable", async () => {
    const rows = [
      makeRow({
        name: "council",
        kind: "builtin",
        effectiveModel: "xai/grok-4.5",
        modelSourceStage: "preset",
      }),
    ];
    const dto = makeAgentsDtoWithDesired({
      preset: "openai",
      presetAgents: { council: desiredAgent("xai/grok-4.5") },
      rows,
    });
    mockFetch(baseRoutes({ agents: dto, providers: makeProvidersDto([]) }));
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("council"));

    const row = findRowByName("council");
    within(row).getByRole("button", { name: ENTRY_ACTION });
    expect(within(row).queryByRole("link")).toBeNull();
  });

  test("council live-only and councillor link to /council", async () => {
    const rows = [
      makeRow({ name: "council", kind: "builtin", liveModel: "xai/grok-4.5" }),
      makeRow({
        name: "councillor",
        kind: "builtin",
        liveModel: "xai/grok-4.5",
      }),
    ];
    const dto = makeAgentsDtoWithDesired({ preset: "openai", rows });
    mockFetch(baseRoutes({ agents: dto, providers: makeProvidersDto([]) }));
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("council"));

    for (const name of ["council", "councillor"]) {
      const row = findRowByName(name);
      within(row).getByText("No assignment (live only)");
      expect(within(row).queryByText("Runtime drift")).toBeNull();
      expect(
        within(row).queryByRole("button", { name: ENTRY_ACTION }),
      ).toBeNull();
      const link = within(row).getByRole("link", { name: "Managed in Council" });
      expect(link.getAttribute("href")).toBe("/council");
    }
  });

  test("ACP wrapper links to /acp; native links to /config with explanation", async () => {
    const rows = [
      makeRow({
        name: "wrapper-bot",
        kind: "custom",
        effectiveModel: "openai/gpt-5",
      }),
      makeRow({
        name: "build",
        kind: "native",
        liveModel: "anthropic/claude-sonnet-4-5",
      }),
    ];
    mockFetch(
      baseRoutes({
        agents: makeAgentsDto(rows),
        providers: makeProvidersDto([]),
        acpAgents: ["wrapper-bot"],
      }),
    );
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("wrapper-bot"));

    const acpRow = findRowByName("wrapper-bot");
    expect(
      within(acpRow).queryByRole("button", { name: ENTRY_ACTION }),
    ).toBeNull();
    const acpLink = within(acpRow).getByRole("link", {
      name: "Managed in ACP",
    });
    expect(acpLink.getAttribute("href")).toBe("/acp");

    // Native rows hidden by default — reveal them.
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Show native OpenCode agents/ }),
    );
    await poll(() => screen.getByText("build"));
    const nativeRow = findRowByName("build");
    within(nativeRow).getByText("Native");
    expect(
      within(nativeRow).queryByRole("button", { name: ENTRY_ACTION }),
    ).toBeNull();
    const configLink = within(nativeRow).getByRole("link", {
      name: "Managed by OpenCode configuration",
    });
    expect(configLink.getAttribute("href")).toBe("/config");
    // Native rows group together once revealed.
    const nativeGroup = groupHeaders().find((g) => g.id === "native");
    expect(nativeGroup?.text).toContain("Native");
  });

  test("custom agent shows Custom pill + entry action", async () => {
    const rows = [
      makeRow({
        name: "scribe",
        kind: "custom",
        effectiveModel: "openai/gpt-5-mini",
        modelSourceStage: "root-agent",
      }),
    ];
    const dto = makeAgentsDtoWithDesired({
      preset: "openai",
      rootAgents: { scribe: desiredAgent("openai/gpt-5-mini") },
      rows,
    });

    mockFetch(baseRoutes({ agents: dto, providers: makeProvidersDto([]) }));
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("scribe"));

    const row = findRowByName("scribe");
    within(row).getByText("Custom");
    within(row).getByRole("button", { name: ENTRY_ACTION });
  });
});

describe("agents assignment IA — source labels & disclosure", () => {
  test("source button reveals path inline; never opens drawer or selects", async () => {
    const rows = [
      makeRow({
        name: "explorer",
        kind: "builtin",
        effectiveModel: "ollama-cloud/deepseek-v4-flash:0731",
        modelSourceStage: "preset",
      }),
    ];
    const dto = makeAgentsDtoWithDesired({
      preset: "openai",
      presetAgents: {
        explorer: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
      },
      rows,
    });

    mockFetch(baseRoutes({ agents: dto, providers: makeProvidersDto([]) }));
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    const row = findRowByName("explorer");
    const badge = within(row).getByRole("button", {
      name: /Preset: openai/,
    });
    expect(badge.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(badge);
    await poll(() =>
      expect(row.textContent).toContain("presets.openai.explorer.model"),
    );
    expect(badge.getAttribute("aria-expanded")).toBe("true");
    expect(badge.getAttribute("aria-controls")).toBeTruthy();
    // Independent: no drawer, no row selection.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(row.className).not.toContain("selected");
  });

  test("root override shows 'Root override' label", async () => {
    const rows = [
      makeRow({
        name: "critic",
        kind: "custom",
        effectiveModel: "xai/grok-4.5",
        modelSourceStage: "root-agent",
      }),
    ];
    const dto = makeAgentsDtoWithDesired({
      preset: "openai",
      presetAgents: { critic: desiredAgent("openai/gpt-5.6") },
      rootAgents: { critic: desiredAgent("xai/grok-4.5") },
      rows,
    });

    mockFetch(baseRoutes({ agents: dto, providers: makeProvidersDto([]) }));
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("critic"));

    within(findRowByName("critic")).getByText("Root override");
  });

  test("group-default source is suppressed visually but stays accessible + disclosable", async () => {
    // Three Built-in Team rows: two share "Preset: openai" (the group
    // default), one diverges with a root override.
    const rows = [
      makeRow({
        name: "explorer",
        kind: "builtin",
        effectiveModel: "ollama-cloud/deepseek-v4-flash:0731",
        modelSourceStage: "preset",
      }),
      makeRow({
        name: "librarian",
        kind: "builtin",
        effectiveModel: "ollama-cloud/kimi-k3",
        modelSourceStage: "preset",
      }),
      makeRow({
        name: "oracle",
        kind: "builtin",
        effectiveModel: "xai/grok-4.5",
        modelSourceStage: "root-agent",
      }),
    ];
    const dto = makeAgentsDtoWithDesired({
      preset: "openai",
      presetAgents: {
        explorer: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
        librarian: desiredAgent("ollama-cloud/kimi-k3"),
        oracle: desiredAgent("openai/gpt-5.6"),
      },
      rootAgents: { oracle: desiredAgent("xai/grok-4.5") },
      rows,
    });

    mockFetch(baseRoutes({ agents: dto, providers: makeProvidersDto([]) }));
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    // The group header announces the shared default source.
    const headers = groupHeaders();
    expect(headers.map((g) => g.id)).toEqual(["builtin"]);
    expect(headers[0]!.text).toContain("Built-in Team");
    expect(headers[0]!.text).toContain("3 agents");
    expect(headers[0]!.text).toContain("Default source Preset: openai");

    // Suppressed badge: visible text collapses to "Same as group"…
    const explorerRow = findRowByName("explorer");
    const suppressed = within(explorerRow).getByRole("button", {
      name: /^Preset: openai\. Toggle provenance path\.$/,
    });
    expect(suppressed.textContent).toBe("Same as group");
    expect(suppressed.className).toContain("is-suppressed");
    // …but the real source remains in the accessible name, and the
    // provenance disclosure still works from the suppressed badge.
    expect(suppressed.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(suppressed);
    await poll(() =>
      expect(explorerRow.textContent).toContain("presets.openai.explorer.model"),
    );
    expect(suppressed.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("dialog")).toBeNull();

    const librarianRow = findRowByName("librarian");
    const librarianBadge = within(librarianRow).getByRole("button", {
      name: /^Preset: openai\. Toggle provenance path\.$/,
    });
    expect(librarianBadge.textContent).toBe("Same as group");

    // The divergent row in the same group keeps its own label.
    const oracleBadge = within(findRowByName("oracle")).getByRole("button", {
      name: /^Root override\. Toggle provenance path\.$/,
    });
    expect(oracleBadge.textContent).toContain("Root override");
    expect(oracleBadge.className).not.toContain("is-suppressed");
  });
});

describe("agents assignment IA — detail drawer & editor transitions", () => {
  function twoAgentWorld() {
    const rows = [
      makeRow({
        name: "explorer",
        kind: "builtin",
        effectiveModel: "ollama-cloud/deepseek-v4-flash:0731",
        sessionCount: 23,
        modelSourceStage: "preset",
      }),
      makeRow({
        name: "librarian",
        kind: "builtin",
        effectiveModel: "ollama-cloud/deepseek-v4-flash:0731",
        modelSourceStage: "preset",
      }),
    ];
    const dto = makeAgentsDtoWithDesired({
      preset: "openai",
      presetAgents: {
        explorer: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
        librarian: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
      },
      rows,
    });
    return dto;
  }

  test("name button is the only detail opener (aria-expanded/controls); drawer shows sessions", async () => {
    mockFetch(
      baseRoutes({
        agents: twoAgentWorld(),
        providers: makeProvidersDto([]),
      }),
    );
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    const row = findRowByName("explorer");
    // The <tr> is inert — no click role/tabIndex; the name is a real button.
    expect(row.getAttribute("tabindex")).toBeNull();
    const nameBtn = within(row).getByRole("button", { name: "explorer" });
    expect(nameBtn.getAttribute("aria-expanded")).toBe("false");
    expect(nameBtn.getAttribute("aria-controls")).toBe("agent-detail-drawer");

    fireEvent.click(nameBtn);
    await poll(() => screen.getByRole("dialog"));
    expect(nameBtn.getAttribute("aria-expanded")).toBe("true");
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe(
      "agent-detail-drawer-title",
    );
    // Sessions live in the drawer, not the table.
    within(dialog).getByText("Sessions");
    expect(within(dialog).getByText("23")).toBeTruthy();
    // Exactly one dialog — no nesting.
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  test("direct entry action opens the editor; focus returns to the row trigger on close", async () => {
    mockFetch(
      baseRoutes({
        agents: twoAgentWorld(),
        providers: makeProvidersDto([]),
      }),
    );
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    const entryBtn = within(findRowByName("librarian")).getByRole("button", {
      name: ENTRY_ACTION,
    });
    entryBtn.focus();
    fireEvent.click(entryBtn);
    await poll(() =>
      screen.getByRole("heading", { name: /Change model — librarian/ }),
    );
    // No drawer — the editor is the only dialog.
    expect(screen.getAllByRole("dialog")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await poll(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(entryBtn);
  });

  test("drawer entry closes the drawer first; editor returns focus to the name trigger", async () => {
    mockFetch(
      baseRoutes({
        agents: twoAgentWorld(),
        providers: makeProvidersDto([]),
      }),
    );
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    const nameBtn = within(findRowByName("explorer")).getByRole("button", {
      name: "explorer",
    });
    fireEvent.click(nameBtn);
    await poll(() => screen.getByRole("dialog"));

    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: ENTRY_ACTION,
      }),
    );
    // Drawer closed, editor open — still exactly one dialog, no nesting.
    await poll(() =>
      screen.getByRole("heading", { name: /Change model — explorer/ }),
    );
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.queryByText("Field provenance")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await poll(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(nameBtn);
  });

  test("Caps opens the capability modal; focus returns to the Caps trigger on close", async () => {
    mockFetch(
      baseRoutes({
        agents: twoAgentWorld(),
        providers: makeProvidersDto([]),
      }),
    );
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    const capsBtn = within(findRowByName("explorer")).getByRole("button", {
      name: /Edit capabilities for explorer/,
    });
    capsBtn.focus();
    fireEvent.click(capsBtn);
    await poll(() =>
      screen.getByRole("heading", { name: /Edit capabilities — explorer/ }),
    );
    expect(screen.getAllByRole("dialog")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await poll(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(capsBtn);
  });

  test("modal Current state Assigned comes from the presentation, never row.desiredModel", async () => {
    // Root override wins (desiredModel would report the ROOT model), but the
    // preset assignment is the real Assigned.
    const rows = [
      makeRow({
        name: "explorer",
        kind: "builtin",
        desiredModel: "openai/gpt-5.6-sol", // what desiredModelForAgent reports (root-preferred)
        effectiveModel: "openai/gpt-5.6-sol",
        modelSourceStage: "root-agent",
      }),
    ];
    const dto = makeAgentsDtoWithDesired({
      preset: "openai",
      presetAgents: {
        explorer: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
      },
      rootAgents: { explorer: desiredAgent("openai/gpt-5.6-sol") },
      rows,
    });
    mockFetch(baseRoutes({ agents: dto, providers: makeProvidersDto([]) }));
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    fireEvent.click(
      within(findRowByName("explorer")).getByRole("button", {
        name: ENTRY_ACTION,
      }),
    );
    await poll(() =>
      screen.getByRole("heading", { name: /Change model — explorer/ }),
    );
    const dialog = screen.getByRole("dialog");
    const assignedDt = within(dialog).getByText("Assigned");
    const assignedDd = assignedDt.nextElementSibling;
    expect(assignedDd?.textContent).toContain(
      "ollama-cloud/deepseek-v4-flash:0731",
    );
    expect(assignedDd?.textContent).not.toContain("gpt-5.6-sol");
  });
});

describe("agents assignment IA — filters & search", () => {
  test("filter Overrides narrows to root-agent / project / user-config", async () => {
    const rows = [
      makeRow({
        name: "explorer",
        kind: "builtin",
        effectiveModel: "ollama-cloud/deepseek-v4-flash:0731",
        modelSourceStage: "preset",
      }),
      makeRow({
        name: "critic",
        kind: "custom",
        effectiveModel: "xai/grok-4.5",
        modelSourceStage: "root-agent",
      }),
      makeRow({
        name: "fixer-high",
        kind: "custom",
        effectiveModel: "openai/gpt-5.6-sol",
        modelSourceStage: "root-agent",
      }),
    ];
    const dto = makeAgentsDtoWithDesired({
      preset: "openai",
      presetAgents: {
        explorer: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
      },
      rootAgents: {
        critic: desiredAgent("xai/grok-4.5"),
        "fixer-high": desiredAgent("openai/gpt-5.6-sol"),
      },
      rows,
    });

    mockFetch(baseRoutes({ agents: dto, providers: makeProvidersDto([]) }));
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    fireEvent.click(screen.getByRole("radio", { name: /Overrides/ }));
    await poll(() => {
      expect(screen.queryByText("explorer")).toBeNull();
      screen.getByText("critic");
      screen.getByText("fixer-high");
    });
  });

  test("filter Runtime Drift narrows to drifted rows", async () => {
    const rows = [
      makeRow({
        name: "explorer",
        kind: "builtin",
        effectiveModel: "ollama-cloud/deepseek-v4-flash:0731",
        liveModel: "ollama-cloud/deepseek-v4-flash:0731",
        modelSourceStage: "preset",
      }),
      makeRow({
        name: "fixer",
        kind: "builtin",
        effectiveModel: "ollama-cloud/kimi-k3",
        liveModel: "alibaba-token-plan/qwen3.8-max",
        modelSourceStage: "preset",
      }),
    ];
    const dto = makeAgentsDtoWithDesired({
      preset: "openai",
      presetAgents: {
        explorer: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
        fixer: desiredAgent("ollama-cloud/kimi-k3"),
      },
      rows,
    });

    mockFetch(baseRoutes({ agents: dto, providers: makeProvidersDto([]) }));
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    fireEvent.click(screen.getByRole("radio", { name: /Runtime Drift/ }));
    await poll(() => {
      expect(screen.queryByText("explorer")).toBeNull();
      screen.getByText("fixer");
    });
  });

  test("filter Model Issues uses hasModelIssue (fallback issue counts)", async () => {
    const world: World = {
      agents: makeAgentsDtoWithDesired({
        preset: "openai",
        presetAgents: {
          explorer: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
          fixer: desiredAgent("ollama-cloud/kimi-k3"),
        },
        rows: [
          makeRow({
            name: "explorer",
            kind: "builtin",
            effectiveModel: "ollama-cloud/deepseek-v4-flash:0731",
            modelSourceStage: "preset",
          }),
          makeRow({
            name: "fixer",
            kind: "builtin",
            effectiveModel: "ollama-cloud/kimi-k3",
            modelSourceStage: "preset",
          }),
        ],
      }),
      providers: makeProvidersDto([]),
      models: makeModelInventoryDto({
        models: [
          makeModelAvailability({
            providerId: "ollama-cloud",
            modelId: "deepseek-v4-flash:0731",
            probe: probeSummary({
              state: "healthy",
              freshness: "fresh",
              lastCompletedAt: isoAgo(60_000),
            }),
          }),
          makeModelAvailability({
            providerId: "ollama-cloud",
            modelId: "kimi-k3",
            probe: probeSummary({
              state: "healthy",
              freshness: "fresh",
              lastCompletedAt: isoAgo(60_000),
            }),
          }),
          // The FALLBACK is unhealthy — the agent still counts as an issue.
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
        ],
      }),
    };
    world.agents.effective.agents.fixer = {
      name: "fixer",
      kind: "builtin",
      enabled: true,
      modelPrimary: "ollama-cloud/kimi-k3",
      modelFallbacks: ["openai/gpt-5"],
      skills: [],
      mcps: [],
      hasInlinePrompt: false,
      hasOrchestratorPrompt: false,
      provenance: [],
      fieldProvenance: {},
    };

    mockFetch(baseRoutes(world));
    renderWithModels(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    fireEvent.click(screen.getByRole("radio", { name: /Model Issues/ }));
    await poll(() => {
      expect(screen.queryByText("explorer")).toBeNull();
      screen.getByText("fixer");
    });
  });

  test("search matches agent, model, provider, canonical, source, and fallback ids", async () => {
    const rows = [
      makeRow({
        name: "explorer",
        kind: "builtin",
        effectiveModel: "ollama-cloud/deepseek-v4-flash:0731",
        modelSourceStage: "preset",
      }),
      makeRow({
        name: "fixer",
        kind: "builtin",
        effectiveModel: "ollama-cloud/kimi-k3",
        modelSourceStage: "preset",
      }),
    ];
    const dto = makeAgentsDtoWithDesired({
      preset: "openai",
      presetAgents: {
        explorer: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
        fixer: desiredAgent("ollama-cloud/kimi-k3"),
      },
      rows,
    });
    dto.effective.agents.explorer = {
      name: "explorer",
      kind: "builtin",
      enabled: true,
      modelPrimary: "ollama-cloud/deepseek-v4-flash:0731",
      modelFallbacks: ["anthropic/claude-opus-4-1"],
      skills: [],
      mcps: [],
      hasInlinePrompt: false,
      hasOrchestratorPrompt: false,
      provenance: [],
      fieldProvenance: {},
    };

    mockFetch(
      baseRoutes({
        agents: dto,
        providers: makeProvidersDto([
          // Catalog display names so canonical-vs-tail search is distinct.
          makeProvider("ollama-cloud", "Ollama Cloud", true, [
            makeModel(
              "ollama-cloud",
              "deepseek-v4-flash:0731",
              "DeepSeek V4 Flash 0731",
            ),
            makeModel("ollama-cloud", "kimi-k3", "Kimi K3"),
          ]),
        ]),
      }),
    );
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    const search = screen.getByRole("searchbox", { name: /Search agents/ });

    // by model id
    fireEvent.change(search, { target: { value: "kimi" } });
    await poll(() => {
      expect(screen.queryByText("explorer")).toBeNull();
      screen.getByText("fixer");
    });

    // by agent name
    fireEvent.change(search, { target: { value: "explorer" } });
    await poll(() => {
      expect(screen.queryByText("fixer")).toBeNull();
      screen.getByText("explorer");
    });

    // by provider id (part of the canonical model id)
    fireEvent.change(search, { target: { value: "ollama-cloud" } });
    await poll(() => {
      screen.getByText("explorer");
      screen.getByText("fixer");
    });

    // by full canonical id
    fireEvent.change(search, {
      target: { value: "ollama-cloud/deepseek-v4-flash:0731" },
    });
    await poll(() => {
      screen.getByText("explorer");
      expect(screen.queryByText("fixer")).toBeNull();
    });

    // by catalog display name (distinct from the id tail)
    fireEvent.change(search, { target: { value: "DeepSeek V4 Flash" } });
    await poll(() => {
      screen.getByText("explorer");
      expect(screen.queryByText("fixer")).toBeNull();
    });

    // by source label
    fireEvent.change(search, { target: { value: "Preset: openai" } });
    await poll(() => {
      screen.getByText("explorer");
      screen.getByText("fixer");
    });

    // by fallback id (only explorer has the opus fallback)
    fireEvent.change(search, { target: { value: "claude-opus" } });
    await poll(() => {
      screen.getByText("explorer");
      expect(screen.queryByText("fixer")).toBeNull();
    });
  });
});

describe("agents assignment IA — long ids", () => {
  test("long model identifiers truncate; canonical id visible quiet + title", async () => {
    const rows = [
      makeRow({
        name: "explorer",
        kind: "builtin",
        effectiveModel: "ollama-cloud/deepseek-v4-flash:0731",
        modelSourceStage: "preset",
      }),
    ];
    const dto = makeAgentsDtoWithDesired({
      preset: "openai",
      presetAgents: {
        explorer: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
      },
      rows,
    });

    mockFetch(baseRoutes({ agents: dto, providers: makeProvidersDto([]) }));
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    const row = findRowByName("explorer");
    const modelCell = row.querySelectorAll("td")[1]!;
    // Tail of the canonical id is the human line (no catalog name here).
    expect(modelCell.textContent).toContain("deepseek-v4-flash:0731");
    // The full canonical id is visible in the quiet secondary line AND the
    // cell title — never tooltip-only.
    expect(
      modelCell.querySelector(".model-canonical")?.textContent,
    ).toContain("ollama-cloud/deepseek-v4-flash:0731");
    expect(
      modelCell.querySelector(".model-cell")?.getAttribute("title"),
    ).toBe("ollama-cloud/deepseek-v4-flash:0731");
  });
});

describe("agents assignment IA — Change Model entry action", () => {
  test("row entry action opens the change-model editor for that agent", async () => {
    const rows = [
      makeRow({
        name: "explorer",
        kind: "builtin",
        effectiveModel: "ollama-cloud/deepseek-v4-flash:0731",
        modelSourceStage: "preset",
      }),
    ];
    const dto = makeAgentsDtoWithDesired({
      preset: "openai",
      presetAgents: {
        explorer: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
      },
      rows,
    });

    mockFetch(baseRoutes({ agents: dto, providers: makeProvidersDto([]) }));
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    // Final intended label is "Change Model" (transition: "Edit"). The
    // button is the row's primary entry into the model editor.
    const entryBtn = within(findRowByName("explorer")).getByRole("button", {
      name: ENTRY_ACTION,
    });
    fireEvent.click(entryBtn);
    await poll(() =>
      screen.getByRole("heading", { name: /Change model — explorer/ }),
    );
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });
});

describe("agents assignment IA — grouped default order & summary", () => {
  test("default groups: Built-in Team in declared order first, then Custom Agents A–Z", async () => {
    const rows = [
      makeRow({ name: "alpha", kind: "custom", effectiveModel: "openai/gpt-5" }),
      makeRow({
        name: "explorer",
        kind: "builtin",
        effectiveModel: "ollama-cloud/deepseek-v4-flash:0731",
      }),
      makeRow({
        name: "orchestrator",
        kind: "builtin",
        effectiveModel: "xai/grok-4.5",
      }),
      makeRow({ name: "beta", kind: "custom", effectiveModel: "openai/gpt-5" }),
      makeRow({
        name: "librarian",
        kind: "builtin",
        effectiveModel: "ollama-cloud/deepseek-v4-flash:0731",
      }),
    ];
    const dto = makeAgentsDtoWithDesired({
      preset: "openai",
      presetAgents: {
        explorer: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
        orchestrator: desiredAgent("xai/grok-4.5"),
        librarian: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
      },
      rootAgents: {
        alpha: desiredAgent("openai/gpt-5"),
        beta: desiredAgent("openai/gpt-5"),
      },
      rows,
    });

    mockFetch(baseRoutes({ agents: dto, providers: makeProvidersDto([]) }));
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    // Agent rows: builtin declared order first, custom A–Z after.
    expect(rowNames()).toEqual([
      "orchestrator",
      "explorer",
      "librarian",
      "alpha",
      "beta",
    ]);
    // Grouped by metadata: exactly two groups, in roster order.
    const groups = groupHeaders();
    expect(groups.map((g) => g.id)).toEqual(["builtin", "custom"]);
    expect(groups[0]!.text).toContain("Built-in Team");
    expect(groups[0]!.text).toContain("3 agents");
    expect(groups[1]!.text).toContain("Custom Agents");
    expect(groups[1]!.text).toContain("2 agents");
  });

  test("summary counts surface on filter chips + live region (grouped default)", async () => {
    const rows = [
      makeRow({
        name: "explorer",
        kind: "builtin",
        effectiveModel: "ollama-cloud/deepseek-v4-flash:0731",
        liveModel: "ollama-cloud/deepseek-v4-flash:0731",
        modelSourceStage: "preset",
      }),
      makeRow({
        name: "critic",
        kind: "custom",
        effectiveModel: "xai/grok-4.5",
        liveModel: "alibaba-token-plan/qwen3.8-max",
        modelSourceStage: "root-agent",
      }),
    ];
    const dto = makeAgentsDtoWithDesired({
      preset: "openai",
      presetAgents: {
        explorer: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
      },
      rootAgents: { critic: desiredAgent("xai/grok-4.5") },
      rows,
    });

    mockFetch(baseRoutes({ agents: dto, providers: makeProvidersDto([]) }));
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    // Filter chips carry the summary counts (what would match if clicked).
    expect(
      screen.getByRole("radio", { name: /^All, 2$/ }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByRole("radio", { name: /Overrides, 1/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("radio", { name: /Runtime Drift, 1/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("radio", { name: /Model Issues, 0/ }),
    ).toBeTruthy();
    // The polite live region announces scope + grouped default order.
    const live = document.querySelector(
      '.omo-sr-only[aria-live="polite"]',
    );
    expect(live?.textContent).toContain("2 of 2 agents shown");
    expect(live?.textContent).toContain("grouped default order");
  });
});
