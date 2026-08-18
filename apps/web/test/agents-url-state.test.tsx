/**
 * Agents route state (doc 34 follow-up) — URL + sessionStorage two-way state.
 *
 * filter  — valid TeamAgentFilterId, omitted when "all"
 * q       — omitted when empty; updates REPLACE (typing never spams history)
 * sort    — <name|model|provider|source|signals|kind>[:desc], omitted when
 *           default team order
 * disabled— disabled=1 when Show disabled is on, omitted when off
 * agent   — drawer focus (transient), omitted when closed/invalid
 * model/provider — focus constraints (transient)
 *
 * Control changes navigate REPLACE and persist to sessionStorage; focus
 * params never persist and are cleared by control changes; unknown params
 * preserved; migrations filter=disabled → disabled=1 and native=1 removal.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import {
  createMemoryRouter,
  RouterProvider,
  useLocation,
  type Router,
} from "react-router-dom";
import type { AgentsDto, DesiredAgent } from "@omo/shared";
import { AgentsPage } from "../src/pages/AgentsPage";
import { RuntimeProvider } from "../src/runtime/RuntimeContext";
import {
  baseRoutes,
  findRowByName,
  makeAgentsDto,
  makeProvidersDto,
  makeRow,
  mockFetch,
  poll,
} from "./helpers";

function LocationProbe() {
  const loc = useLocation();
  return (
    <div data-testid="loc">
      {loc.pathname}
      {loc.search}
    </div>
  );
}

function desiredAgent(model: string | undefined): DesiredAgent {
  return { name: "explorer", kind: "builtin", model, sourceIds: ["fixture"] };
}

function worldRows(): AgentsDto {
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
      liveModel: "alibaba-token-plan/qwen3.8-max",
      modelSourceStage: "preset",
    }),
    makeRow({
      name: "critic",
      kind: "custom",
      effectiveModel: "xai/grok-4.5",
      modelSourceStage: "root-agent",
    }),
    makeRow({ name: "observer", kind: "builtin", enabled: false }),
  ];
  const dto = makeAgentsDto(rows, "openai");
  dto.desired.presets = {
    openai: {
      explorer: desiredAgent("ollama-cloud/deepseek-v4-flash:0731"),
      fixer: desiredAgent("ollama-cloud/kimi-k3"),
      // critic is assigned in the preset but a root override wins → override.
      critic: desiredAgent("openai/gpt-5.6"),
    },
  };
  dto.desired.agents = { critic: desiredAgent("xai/grok-4.5") };
  return dto;
}

function setup(initial: string): { router: Router } {
  mockFetch(
    baseRoutes({ agents: worldRows(), providers: makeProvidersDto([]) }),
  );
  const router = createMemoryRouter(
    [
      {
        path: "/agents",
        element: (
          <>
            <LocationProbe />
            <AgentsPage />
          </>
        ),
      },
    ],
    { initialEntries: [initial] },
  );
  render(
    <RuntimeProvider>
      <RouterProvider router={router} />
    </RuntimeProvider>,
  );
  return { router };
}

function loc(): string {
  return screen.getByTestId("loc").textContent ?? "";
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("agents URL state — hydration", () => {
  test("filter/q/sort/disabled hydrate from the URL", async () => {
    setup("/agents?filter=overrides&q=critic&sort=name:desc&disabled=1");
    await poll(() => screen.getByText("critic"));

    expect(
      screen.getByRole("radio", { name: /Overrides,/ }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      (screen.getByRole("searchbox", { name: /Search agents/ }) as HTMLInputElement)
        .value,
    ).toBe("critic");
    const agentTh = screen
      .getByRole("button", { name: /agent, sorted descending/i })
      .closest("th");
    expect(agentTh?.getAttribute("aria-sort")).toBe("descending");
    expect(
      (screen.getByRole("checkbox", { name: /Show disabled/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  test("invalid filter/sort values are cleaned via replace and fall back to defaults", async () => {
    setup("/agents?filter=bogus&sort=probe:asc&foo=bar");
    await poll(() => screen.getByText("explorer"));
    await poll(() => expect(loc()).toBe("/agents?foo=bar"));
    expect(
      screen.getByRole("radio", { name: /^All,/ }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(document.querySelectorAll('[aria-sort="ascending"]').length).toBe(0);
  });

  test("migration: filter=disabled becomes disabled=1; native=1 removed", async () => {
    setup("/agents?filter=disabled&native=1&keep=1");
    await poll(() => screen.getByText("explorer"));
    await poll(() => expect(loc()).toBe("/agents?keep=1&disabled=1"));
    expect(
      (screen.getByRole("checkbox", { name: /Show disabled/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    // Disabled roster enters the working set through the migrated gate.
    await poll(() => screen.getByText("observer"));
  });

  test("invalid agent focus is cleaned up with replace after data load", async () => {
    setup("/agents?agent=ghost&foo=bar");
    await poll(() => screen.getByText("explorer"));
    await poll(() => expect(loc()).toBe("/agents?foo=bar"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("stored controls hydrate when the URL carries none", async () => {
    window.sessionStorage.setItem(
      "omo-control.team.v1.agents",
      JSON.stringify({ filter: "custom", q: "crit" }),
    );
    setup("/agents");
    await poll(() => screen.getByText("critic"));
    expect(
      screen.getByRole("radio", { name: /Custom,/ }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      (screen.getByRole("searchbox", { name: /Search agents/ }) as HTMLInputElement)
        .value,
    ).toBe("crit");
  });
});

describe("agents URL state — updates", () => {
  test("control changes replace, persist, and preserve unrelated params", async () => {
    const { router } = setup("/agents?foo=bar");
    await poll(() => screen.getByText("explorer"));

    fireEvent.click(screen.getByRole("radio", { name: /Runtime drift,/ }));
    await poll(() => expect(loc()).toBe("/agents?foo=bar&filter=runtime-drift"));
    expect(router.state.historyAction).toBe("REPLACE");

    fireEvent.click(screen.getByRole("checkbox", { name: /Show disabled/ }));
    await poll(() => expect(loc()).toContain("disabled=1"));
    expect(loc()).toContain("foo=bar");

    // Persisted for the tab session.
    const stored = JSON.parse(
      window.sessionStorage.getItem("omo-control.team.v1.agents") ?? "{}",
    );
    expect(stored.filter).toBe("runtime-drift");
    expect(stored.showDisabled).toBe(true);
  });

  test("q updates replace — typing never spams history", async () => {
    const { router } = setup("/agents");
    await poll(() => screen.getByText("explorer"));

    const search = screen.getByRole("searchbox", { name: /Search agents/ });
    fireEvent.change(search, { target: { value: "c" } });
    await poll(() => expect(loc()).toContain("q=c"));
    fireEvent.change(search, { target: { value: "critic" } });
    await poll(() => expect(loc()).toContain("q=critic"));
    expect(router.state.historyAction).toBe("REPLACE");
  });

  test("sort param cycles asc → desc → omitted (default team order)", async () => {
    setup("/agents");
    await poll(() => screen.getByText("explorer"));

    const btn = screen.getByRole("button", { name: /^Sort by source/i });
    fireEvent.click(btn);
    await poll(() => expect(loc()).toContain("sort=source"));
    fireEvent.click(screen.getByRole("button", { name: /source, sorted ascending/i }));
    await poll(() => expect(loc()).toContain("sort=source%3Adesc"));
    fireEvent.click(screen.getByRole("button", { name: /source, sorted descending/i }));
    await poll(() => expect(loc()).toBe("/agents"));
  });

  test("drawer open sets agent focus; Escape removes it (replace)", async () => {
    setup("/agents");
    await poll(() => screen.getByText("explorer"));

    fireEvent.click(
      within(findRowByName("explorer")).getByRole("button", { name: "explorer" }),
    );
    await poll(() => screen.getByRole("dialog"));
    expect(loc()).toContain("agent=explorer");

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await poll(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(loc()).toBe("/agents");
  });

  test("control change clears an active focus", async () => {
    setup("/agents?model=ollama-cloud/kimi-k3");
    await poll(() => screen.getByText("fixer"));
    // Focus constrains the roster (only fixer uses kimi-k3).
    expect(screen.queryByText("explorer")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /^All,/ }));
    await poll(() => {
      expect(loc()).not.toContain("model=");
      screen.getByText("explorer");
    });
  });
});
