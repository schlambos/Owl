/**
 * Team roster sorting — grouped default vs explicit flat comparison.
 *
 * Four sortable columns (Agent/name, Model, Status/signals, Source/source)
 * plus a non-sortable Actions header. The visible Sort control adds the
 * two comparison-only modes: Provider (no dedicated column) and
 * Issues First (signals severity), alongside Default which restores the
 * grouped roster order (Built-in Team / Custom Agents / Disabled /
 * Native).
 *
 * Covers the header click cycle (asc → desc → restore), per-key behavior
 * including Provider and Issues First, grouped default and flat modes,
 * the missing-last invariant, and aria-sort.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
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
import { RuntimeProvider } from "../src/runtime/RuntimeContext";

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

beforeEach(() => {
  window.sessionStorage.clear();
});

function desiredAgent(model: string | undefined): DesiredAgent {
  return { name: "explorer", kind: "builtin", model, sourceIds: ["fixture"] };
}

function makeDtoWithDesired(opts: {
  preset?: string;
  presetAgents?: Record<string, DesiredAgent>;
  rootAgents?: Record<string, DesiredAgent>;
  rows: AgentsDto["rows"];
}) {
  const base = makeAgentsDto(opts.rows, opts.preset);
  base.desired.presets = opts.presetAgents
    ? { [opts.preset ?? "openai"]: opts.presetAgents }
    : {};
  base.desired.agents = opts.rootAgents ?? {};
  return base;
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

/** The visible Sort control <select> (labelled "Sort"). */
function sortSelect(): HTMLSelectElement {
  return screen.getByLabelText("Sort") as HTMLSelectElement;
}

describe("agents sort — default order", () => {
  test("default order: orchestrator before explorer before custom A–Z", async () => {
    const rows = [
      makeRow({
        name: "orchestrator",
        kind: "builtin",
        effectiveModel: "xai/grok-4.5",
        modelSourceStage: "preset",
      }),
      makeRow({
        name: "explorer",
        kind: "builtin",
        effectiveModel: "ollama-cloud/deepseek-v4-flash:0731",
        modelSourceStage: "preset",
      }),
      makeRow({ name: "alpha", kind: "custom", effectiveModel: "openai/gpt-5" }),
      makeRow({ name: "beta", kind: "custom", effectiveModel: "openai/gpt-5" }),
    ];
    const dto = makeDtoWithDesired({
      preset: "openai",
      presetAgents: {
        orchestrator: desiredAgent("xai/grok-4.5"),
        explorer: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
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

    expect(rowNames()).toEqual([
      "orchestrator",
      "explorer",
      "alpha",
      "beta",
    ]);
    expect(document.querySelectorAll('[aria-sort="ascending"]').length).toBe(0);
    expect(document.querySelectorAll('[aria-sort="descending"]').length).toBe(0);
  });
});

describe("agents sort — grouped default vs flat explicit sort", () => {
  test("default (no sort): roster is grouped with accessible group headers", async () => {
    const rows = [
      makeRow({
        name: "explorer",
        kind: "builtin",
        effectiveModel: "ollama-cloud/deepseek-v4-flash:0731",
        modelSourceStage: "preset",
      }),
      makeRow({
        name: "alpha",
        kind: "custom",
        effectiveModel: "openai/gpt-5",
        modelSourceStage: "root-agent",
      }),
    ];
    const dto = makeDtoWithDesired({
      preset: "openai",
      presetAgents: {
        explorer: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
      },
      rootAgents: { alpha: desiredAgent("openai/gpt-5") },
      rows,
    });

    mockFetch(baseRoutes({ agents: dto, providers: makeProvidersDto([]) }));
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    const table = document.querySelector("table.agents-table")!;
    expect(table.className).toContain("is-grouped");
    const groups = groupHeaders();
    expect(groups.map((g) => g.id)).toEqual(["builtin", "custom"]);
    expect(groups[0]!.text).toContain("Built-in Team");
    expect(groups[0]!.text).toContain("1 agent");
    expect(groups[1]!.text).toContain("Custom Agents");
  });

  test("explicit sort flattens the roster; Default restores groups", async () => {
    // Two builtin rows sharing the same preset source.
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
    ];
    const dto = makeDtoWithDesired({
      preset: "openai",
      presetAgents: {
        explorer: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
        librarian: desiredAgent("ollama-cloud/kimi-k3"),
      },
      rows,
    });

    mockFetch(baseRoutes({ agents: dto, providers: makeProvidersDto([]) }));
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    // Grouped default: shared source is suppressed visually.
    expect(
      within(findRowByName("explorer")).getByText("Same as group"),
    ).toBeTruthy();

    // Any explicit sort (here: Agent Name) switches to flat comparison…
    fireEvent.click(screen.getByRole("button", { name: /^Sort by agent/i }));
    await poll(() =>
      screen.getByRole("button", { name: /agent, sorted ascending/i }),
    );
    const table = document.querySelector("table.agents-table")!;
    expect(table.className).toContain("is-flat");
    expect(groupHeaders()).toHaveLength(0);
    expect(rowNames()).toEqual(["explorer", "librarian"]);
    // …and suppression lifts — each badge shows its own source label.
    const explorerBadge = within(findRowByName("explorer")).getByRole("button", {
      name: /^Preset: openai\. Toggle provenance path\.$/,
    });
    expect(explorerBadge.textContent).toContain("Preset: openai");
    expect(explorerBadge.className).not.toContain("is-suppressed");

    // Default restores the grouped roster.
    fireEvent.change(sortSelect(), { target: { value: "default" } });
    await poll(() => {
      expect(groupHeaders().map((g) => g.id)).toEqual(["builtin"]);
      expect(rowNames()).toEqual(["explorer", "librarian"]);
    });
    expect(
      document.querySelector("table.agents-table")!.className,
    ).toContain("is-grouped");
  });
});

describe("agents sort — agent name", () => {
  test("click Agent header: asc → desc → restore default", async () => {
    const rows = [
      makeRow({
        name: "explorer",
        kind: "builtin",
        effectiveModel: "ollama-cloud/deepseek-v4-flash:0731",
        modelSourceStage: "preset",
      }),
      makeRow({
        name: "orchestrator",
        kind: "builtin",
        effectiveModel: "xai/grok-4.5",
        modelSourceStage: "preset",
      }),
      makeRow({ name: "alpha", kind: "custom", effectiveModel: "openai/gpt-5" }),
    ];
    const dto = makeDtoWithDesired({
      preset: "openai",
      presetAgents: {
        explorer: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
        orchestrator: desiredAgent("xai/grok-4.5"),
      },
      rootAgents: { alpha: desiredAgent("openai/gpt-5") },
      rows,
    });

    mockFetch(baseRoutes({ agents: dto, providers: makeProvidersDto([]) }));
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    const agentHeader = screen.getByRole("button", { name: /Sort by agent/i });
    fireEvent.click(agentHeader);
    await poll(() => screen.getByRole("button", { name: /sorted ascending/i }));
    expect(rowNames()).toEqual(["alpha", "explorer", "orchestrator"]);

    fireEvent.click(agentHeader);
    await poll(() => screen.getByRole("button", { name: /sorted descending/i }));
    expect(rowNames()).toEqual(["orchestrator", "explorer", "alpha"]);

    fireEvent.click(agentHeader);
    await poll(() => screen.getByRole("button", { name: /^Sort by agent/i }));
    // Restored → grouped default (builtin declared order, custom after).
    expect(rowNames()).toEqual(["orchestrator", "explorer", "alpha"]);
  });
});

describe("agents sort — model column", () => {
  test("click Model: asc by catalog name → desc → restore", async () => {
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
        effectiveModel: "openai/gpt-5.6-sol",
        modelSourceStage: "preset",
      }),
    ];
    const dto = makeDtoWithDesired({
      preset: "openai",
      presetAgents: {
        explorer: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
        fixer: desiredAgent("openai/gpt-5.6-sol"),
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
              "DeepSeek V4 Flash",
            ),
          ]),
          makeProvider("openai", "OpenAI", true, [
            makeModel("openai", "gpt-5.6-sol", "GPT-5.6 Sol"),
          ]),
        ]),
      }),
    );
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    const modelBtn = screen.getByRole("button", { name: /^Sort by model/i });
    fireEvent.click(modelBtn);
    await poll(() => screen.getByRole("button", { name: /sorted ascending/i }));
    // Asc by catalog name: "DeepSeek V4 Flash" < "GPT-5.6 Sol"
    expect(rowNames()).toEqual(["explorer", "fixer"]);

    fireEvent.click(modelBtn);
    await poll(() => screen.getByRole("button", { name: /sorted descending/i }));
    expect(rowNames()).toEqual(["fixer", "explorer"]);

    fireEvent.click(modelBtn);
    await poll(() => screen.getByRole("button", { name: /^Sort by model/i }));
    expect(rowNames()).toEqual(["explorer", "fixer"]);
  });
});

describe("agents sort — source label", () => {
  test("click Source: sorts by human sourceLabel text", async () => {
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
    ];
    const dto = makeDtoWithDesired({
      preset: "openai",
      presetAgents: {
        explorer: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
        critic: desiredAgent("openai/gpt-5.6"), // masked by root override
      },
      rootAgents: { critic: desiredAgent("xai/grok-4.5") },
      rows,
    });

    mockFetch(baseRoutes({ agents: dto, providers: makeProvidersDto([]) }));
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    const btn = screen.getByRole("button", { name: /Sort by source/i });
    await poll(() => {
      expect(rowNames()).toEqual(["explorer", "critic"]); // role order
    });
    fireEvent.click(btn);
    await poll(() => {
      expect(rowNames()).toEqual(["explorer", "critic"]);
    });
    fireEvent.click(btn);
    await poll(() => {
      expect(rowNames()).toEqual(["critic", "explorer"]);
    });
    fireEvent.click(btn);
    await poll(() => {
      expect(rowNames()).toEqual(["explorer", "critic"]);
    });
  });
});

describe("agents sort — signals severity", () => {
  test("click Status header: adverse issues first (bad before warn), quiet rows last", async () => {
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
      makeRow({
        name: "oracle",
        kind: "builtin",
        effectiveModel: "openai/gpt-5.6-sol",
        modelSourceStage: "preset",
      }),
    ];
    const dto = makeDtoWithDesired({
      preset: "openai",
      presetAgents: {
        explorer: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
        fixer: desiredAgent("ollama-cloud/kimi-k3"),
        oracle: desiredAgent("openai/gpt-5.6-sol"),
      },
      rows,
    });

    const world: World = {
      agents: dto,
      providers: makeProvidersDto([]),
      models: makeModelInventoryDto({
        models: [
          makeModelAvailability({
            providerId: "ollama-cloud",
            modelId: "deepseek-v4-flash:0731",
            probe: probeSummary({ state: "never", freshness: "never" }),
          }),
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
            modelId: "gpt-5.6-sol",
            probe: probeSummary({
              state: "provider-disconnected",
              freshness: "fresh",
              lastCompletedAt: isoAgo(60_000),
            }),
          }),
        ],
      }),
    };

    mockFetch(baseRoutes(world));
    renderWithModels(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    // The Status column header carries the signals sort key.
    const btn = screen.getByRole("button", { name: /Sort by status/i });
    fireEvent.click(btn);
    await poll(() => screen.getByRole("button", { name: /sorted ascending/i }));
    // bad (timeout) first, then warn (provider-disconnected), quiet last.
    expect(rowNames()).toEqual(["fixer", "oracle", "explorer"]);

    fireEvent.click(btn);
    await poll(() => screen.getByRole("button", { name: /sorted descending/i }));
    // Desc flips severity, but the quiet row stays last (missing-last both ways).
    expect(rowNames()).toEqual(["oracle", "fixer", "explorer"]);
  });
});

describe("agents sort — visible Sort control (Provider / Issues First)", () => {
  test("control lists Default / Agent Name / Provider / Model / Source / Issues First / Kind", async () => {
    const rows = [
      makeRow({
        name: "explorer",
        kind: "builtin",
        effectiveModel: "ollama-cloud/deepseek-v4-flash:0731",
        modelSourceStage: "preset",
      }),
    ];
    const dto = makeDtoWithDesired({
      preset: "openai",
      presetAgents: {
        explorer: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
      },
      rows,
    });

    mockFetch(baseRoutes({ agents: dto, providers: makeProvidersDto([]) }));
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    const select = sortSelect();
    expect(select.value).toBe("default");
    expect(Array.from(select.options).map((o) => o.text)).toEqual([
      "Default",
      "Agent Name",
      "Provider",
      "Model",
      "Source",
      "Issues First",
      "Kind",
    ]);
    // Default → no direction flip button.
    expect(
      screen.queryByRole("button", { name: "Sort descending" }),
    ).toBeNull();
  });

  test("Provider sorts flat by provider label; flip button reverses", async () => {
    const rows = [
      makeRow({
        name: "critic",
        kind: "custom",
        effectiveModel: "xai/grok-4.5",
        modelSourceStage: "root-agent",
      }),
      makeRow({
        name: "explorer",
        kind: "builtin",
        effectiveModel: "ollama-cloud/deepseek-v4-flash:0731",
        modelSourceStage: "preset",
      }),
      makeRow({
        name: "fixer",
        kind: "builtin",
        effectiveModel: "openai/gpt-5.6-sol",
        modelSourceStage: "preset",
      }),
    ];
    const dto = makeDtoWithDesired({
      preset: "openai",
      presetAgents: {
        explorer: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
        fixer: desiredAgent("openai/gpt-5.6-sol"),
      },
      rootAgents: { critic: desiredAgent("xai/grok-4.5") },
      rows,
    });

    mockFetch(
      baseRoutes({
        agents: dto,
        providers: makeProvidersDto([
          // Display names differ from ids; xai has none → label "xai".
          makeProvider("ollama-cloud", "Ollama Cloud", true, []),
          makeProvider("openai", "OpenAI", true, []),
          makeProvider("xai", "xai", true, []),
        ]),
      }),
    );
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    fireEvent.change(sortSelect(), { target: { value: "provider" } });
    await poll(() => {
      // Asc by provider label: "Ollama Cloud" < "OpenAI" < "xai".
      expect(rowNames()).toEqual(["explorer", "fixer", "critic"]);
    });
    // Flat comparison mode — no group headers.
    expect(groupHeaders()).toHaveLength(0);
    expect(
      document.querySelector("table.agents-table")!.className,
    ).toContain("is-flat");
    // Provider has no dedicated column, so no header carries aria-sort.
    expect(document.querySelectorAll('[aria-sort="ascending"]').length).toBe(0);
    // Direction flip appears and reverses the order.
    const flip = screen.getByRole("button", { name: "Sort descending" });
    fireEvent.click(flip);
    await poll(() => {
      expect(rowNames()).toEqual(["critic", "fixer", "explorer"]);
    });
    expect(
      screen.getByRole("button", { name: "Sort ascending" }),
    ).toBeTruthy();
  });

  test("Issues First surfaces adverse rows first, quiet last (Status header aria-sort)", async () => {
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
      makeRow({
        name: "oracle",
        kind: "builtin",
        effectiveModel: "openai/gpt-5.6-sol",
        modelSourceStage: "preset",
      }),
    ];
    const dto = makeDtoWithDesired({
      preset: "openai",
      presetAgents: {
        explorer: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
        fixer: desiredAgent("ollama-cloud/kimi-k3"),
        oracle: desiredAgent("openai/gpt-5.6-sol"),
      },
      rows,
    });
    const world: World = {
      agents: dto,
      providers: makeProvidersDto([]),
      models: makeModelInventoryDto({
        models: [
          makeModelAvailability({
            providerId: "ollama-cloud",
            modelId: "deepseek-v4-flash:0731",
            probe: probeSummary({ state: "never", freshness: "never" }),
          }),
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
            modelId: "gpt-5.6-sol",
            probe: probeSummary({
              state: "rate-limited",
              freshness: "fresh",
              lastCompletedAt: isoAgo(60_000),
            }),
          }),
        ],
      }),
    };

    mockFetch(baseRoutes(world));
    renderWithModels(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    fireEvent.change(sortSelect(), { target: { value: "signals" } });
    await poll(() => {
      // bad (timeout) before warn (rate-limited); quiet (never) last.
      expect(rowNames()).toEqual(["fixer", "oracle", "explorer"]);
    });
    // Issues First drives the Status column's signals key → aria-sort.
    const statusTh = document.querySelector(
      'th[data-column="signals"]',
    );
    expect(statusTh?.getAttribute("aria-sort")).toBe("ascending");
  });
});

describe("agents sort — column structure", () => {
  test("four sortable <th> columns with sort keys; removed keys are gone", async () => {
    const rows = [
      makeRow({
        name: "explorer",
        kind: "builtin",
        effectiveModel: "ollama-cloud/deepseek-v4-flash:0731",
        modelSourceStage: "preset",
      }),
    ];
    const dto = makeDtoWithDesired({
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

    // data-column ids are stable; visible labels are Agent/Model/Status/
    // Source, so the header aria-labels follow the visible label.
    const sortable: Array<[string, string]> = [
      ["agent", "agent"],
      ["assignment", "model"],
      ["signals", "status"],
      ["source", "source"],
    ];
    for (const [columnId, label] of sortable) {
      const th = ths.find((t) => t.getAttribute("data-column") === columnId);
      expect(th).toBeTruthy();
      const btn = th?.querySelector("button");
      expect(btn).toBeTruthy();
      expect(btn?.getAttribute("aria-label") ?? "").toMatch(
        new RegExp(`^Sort by ${label}`, "i"),
      );
    }
    // Removed sort keys have no header.
    for (const gone of ["provider", "fallbacks", "probe", "sessions"]) {
      expect(
        ths.find((t) => t.getAttribute("data-column") === gone),
      ).toBeUndefined();
    }
  });

  test("Actions header is not a sort control (no <button> in that th)", async () => {
    const rows = [
      makeRow({
        name: "explorer",
        kind: "builtin",
        effectiveModel: "ollama-cloud/deepseek-v4-flash:0731",
        modelSourceStage: "preset",
      }),
    ];
    const dto = makeDtoWithDesired({
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
    const actionsTh = ths.find((th) => th.textContent?.trim() === "Actions");
    expect(actionsTh).toBeTruthy();
    expect(actionsTh?.querySelector("button")).toBeNull();
  });
});

describe("agents sort — missing values last", () => {
  test("missing model sorts last in BOTH directions", async () => {
    const rows = [
      makeRow({
        name: "explorer",
        kind: "builtin",
        effectiveModel: "ollama-cloud/deepseek-v4-flash:0731",
        modelSourceStage: "preset",
      }),
      // Eligible custom agent with no effective model (missing model value).
      makeRow({ name: "ghost", kind: "custom" }),
    ];
    const dto = makeDtoWithDesired({
      preset: "openai",
      presetAgents: {
        explorer: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
      },
      rows,
    });

    mockFetch(baseRoutes({ agents: dto, providers: makeProvidersDto([]) }));
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    const modelBtn = screen.getByRole("button", { name: /Sort by model/i });
    fireEvent.click(modelBtn);
    await poll(() => screen.getByRole("button", { name: /sorted ascending/i }));
    expect(rowNames()).toEqual(["explorer", "ghost"]);

    fireEvent.click(modelBtn);
    await poll(() => screen.getByRole("button", { name: /sorted descending/i }));
    expect(rowNames()).toEqual(["explorer", "ghost"]);
  });
});

describe("agents sort — aria-sort", () => {
  test("active column gets aria-sort=ascending|descending; others stay 'none'", async () => {
    const rows = [
      makeRow({
        name: "explorer",
        kind: "builtin",
        effectiveModel: "ollama-cloud/deepseek-v4-flash:0731",
        modelSourceStage: "preset",
      }),
    ];
    const dto = makeDtoWithDesired({
      preset: "openai",
      presetAgents: {
        explorer: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
      },
      rows,
    });

    mockFetch(baseRoutes({ agents: dto, providers: makeProvidersDto([]) }));
    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    const agentBtn = screen.getByRole("button", { name: /Sort by agent/i });
    fireEvent.click(agentBtn);
    await poll(() => screen.getByRole("button", { name: /sorted ascending/i }));
    const agentTh = agentBtn.closest("th");
    expect(agentTh?.getAttribute("aria-sort")).toBe("ascending");
    const ths = Array.from(
      document.querySelectorAll("table.agents-table thead th"),
    );
    const sortedThs = ths.filter(
      (th) =>
        th.getAttribute("aria-sort") === "ascending" ||
        th.getAttribute("aria-sort") === "descending",
    );
    expect(sortedThs).toHaveLength(1);
  });
});
