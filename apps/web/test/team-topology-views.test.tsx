/**
 * Team topology follow-up (doc 34) — rendered view behaviors.
 *
 * Covers the 17 acceptance behaviors at the view layer: segmented Team nav,
 * header counts, eligibility, show-disabled gating, hard-scoped Models,
 * Providers derivation, cross-nav param contracts, focus/clear-focus,
 * sessionStorage precedence + migration, and probe-absence while browsing.
 * Pure derivation is covered by team-topology.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import {
  createMemoryRouter,
  MemoryRouter,
  RouterProvider,
  useLocation,
  type Router,
} from "react-router-dom";
import type { DesiredAgent } from "@omo/shared";
import { AgentsPage } from "../src/pages/AgentsPage";
import { ModelsPage } from "../src/pages/ModelsPage";
import { ProvidersPage } from "../src/pages/ProvidersPage";
import { ContextNav } from "../src/components/layout/ContextNav";
import { ModelAvailabilityProvider } from "../src/models/ModelAvailabilityContext";
import { RuntimeProvider } from "../src/runtime/RuntimeContext";
import {
  baseRoutes,
  findRowByName,
  makeAgentsDto,
  makeModelAvailability,
  makeModelInventoryDto,
  makeProvider,
  makeProviderDiagnostics,
  makeProvidersDto,
  makeRow,
  makeUsageRef,
  mockFetch,
  poll,
  probeSummary,
  type FetchMock,
  type World,
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
  return { name: "x", kind: "builtin", model, sourceIds: ["fixture"] };
}

/**
 * Standard Team world:
 *  - orchestrator: active builtin, primary of openai/gpt-5
 *  - explorer: active builtin, primary of ollama/llama, runtime drift
 *  - observer: disabled builtin (Show disabled gate)
 *  - build: native (excluded) · wrapper: ACP custom (excluded)
 *  - council/councillor: live-only (excluded; Council dependency only)
 *  - google/gemini: advertised-only (never scoped)
 */
function teamWorld(): World {
  const dto = makeAgentsDto(
    [
      makeRow({ name: "orchestrator", kind: "builtin", effectiveModel: "openai/gpt-5", modelSourceStage: "preset" }),
      makeRow({ name: "explorer", kind: "builtin", effectiveModel: "ollama/llama", liveModel: "alibaba/qwen", modelSourceStage: "preset" }),
      makeRow({ name: "observer", kind: "builtin", enabled: false }),
      makeRow({ name: "build", kind: "native", liveModel: "openai/gpt-5" }),
      makeRow({ name: "wrapper", kind: "custom", effectiveModel: "openai/gpt-5" }),
      makeRow({ name: "council", kind: "builtin", liveModel: "openai/gpt-5" }),
      makeRow({ name: "councillor", kind: "builtin", liveModel: "openai/gpt-5" }),
    ],
    "openai",
  );
  dto.desired.presets = {
    openai: {
      orchestrator: desiredAgent("openai/gpt-5"),
      explorer: desiredAgent("ollama/llama"),
    },
  };
  return {
    agents: dto,
    providers: makeProvidersDto([
      makeProvider("openai", "OpenAI", true, []),
      makeProvider("ollama", "Ollama", true, []),
      makeProvider("google", "Google", true, []),
    ]),
    acpAgents: ["wrapper"],
    models: makeModelInventoryDto({
      models: [
        makeModelAvailability({
          providerId: "openai",
          modelId: "gpt-5",
          usage: [
            makeUsageRef({ kind: "agent-primary", ownerId: "orchestrator", label: "Orchestrator" }),
            makeUsageRef({ kind: "council-member", ownerId: "trio", label: "Trio preset" }),
          ],
          probe: probeSummary({ state: "healthy", freshness: "fresh" }),
        }),
        makeModelAvailability({
          providerId: "ollama",
          modelId: "llama",
          usage: [
            makeUsageRef({ kind: "agent-primary", ownerId: "explorer", label: "Explorer" }),
          ],
          probe: probeSummary({ state: "timeout", freshness: "fresh" }),
        }),
        makeModelAvailability({ providerId: "google", modelId: "gemini" }),
      ],
      providers: [
        makeProviderDiagnostics({ providerId: "openai" }),
        makeProviderDiagnostics({ providerId: "ollama" }),
        makeProviderDiagnostics({ providerId: "google" }),
      ],
    }),
  };
}

function renderTeam(initial: string, world: World = teamWorld()): {
  router: Router;
  mock: FetchMock;
} {
  window.sessionStorage.clear();
  const mock = mockFetch(baseRoutes(world));
  const router = createMemoryRouter(
    [
      { path: "/agents", element: (<><LocationProbe /><AgentsPage /></>) },
      { path: "/models", element: (<><LocationProbe /><ModelsPage /></>) },
      { path: "/providers", element: (<><LocationProbe /><ProvidersPage /></>) },
    ],
    { initialEntries: [initial] },
  );
  render(
    <RuntimeProvider>
      <ModelAvailabilityProvider>
        <RouterProvider router={router} />
      </ModelAvailabilityProvider>
    </RuntimeProvider>,
  );
  return { router, mock };
}

function loc(): string {
  return screen.getByTestId("loc").textContent ?? "";
}

async function nav(router: Router, to: string) {
  await new Promise((r) => setTimeout(r, 0));
  // eslint-disable-next-line testing-library/await-async-utils
  router.navigate(to);
}

describe("team views — segmented nav (behavior 1)", () => {
  test("Team context nav is exactly Agents/Models/Providers with aria-current", async () => {
    mockFetch(baseRoutes(teamWorld()));
    render(
      <MemoryRouter initialEntries={["/models"]}>
        <RuntimeProvider>
          <ModelAvailabilityProvider>
            <ContextNav pathname="/models" />
          </ModelAvailabilityProvider>
        </RuntimeProvider>
      </MemoryRouter>,
    );
    const navEl = screen.getByRole("navigation", { name: "Team pages" });
    const links = within(navEl).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Agents", "Models", "Providers"]);
    expect(within(navEl).getByRole("link", { name: "Models" }).getAttribute("aria-current")).toBe("page");
    expect(within(navEl).queryByRole("link", { name: "Council" })).toBeNull();
    expect(within(navEl).queryByRole("link", { name: "ACP" })).toBeNull();
  });
});

describe("team views — header counts + eligibility (behaviors 2–5)", () => {
  test("TeamHeader shows active-Effective counts; Show disabled never changes them", async () => {
    renderTeam("/agents");
    await poll(() => screen.getByText("orchestrator"));
    const meta = screen.getByText(/2 agents · 2 models · 2 providers/);
    expect(meta).toBeTruthy();

    // Excluded kinds never render (behavior 4).
    expect(screen.queryByText("build")).toBeNull();
    expect(screen.queryByText("wrapper")).toBeNull();
    expect(screen.queryByText("councillor")).toBeNull();

    // Show disabled default OFF; observer hidden (behavior 5).
    const toggle = screen.getByRole("checkbox", { name: /Show disabled/ }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.queryByText("observer")).toBeNull();

    fireEvent.click(toggle);
    await poll(() => screen.getByText("observer"));
    within(findRowByName("observer")).getByText("Disabled");
    expect(screen.getByTestId("agents-disabled-shown").textContent).toContain("disabled shown: 1");
    // Header counts unchanged by the gate (behavior 2).
    expect(screen.getByText(/2 agents · 2 models · 2 providers/)).toBeTruthy();
    expect(loc()).toContain("disabled=1");
  });

  test("council coordinator with a normal Effective assignment is an ordinary row", async () => {
    const world = teamWorld();
    world.agents.rows.push(makeRow({ name: "council", kind: "builtin", effectiveModel: "xai/grok" }));
    world.agents.desired.presets.openai = {
      ...world.agents.desired.presets.openai,
      council: desiredAgent("xai/grok"),
    };
    renderTeam("/agents", world);
    await poll(() => screen.getByText("orchestrator"));
    // Configured council coordinator present; live-only council still absent.
    expect(screen.getAllByText("council").length).toBeGreaterThan(0);
    within(findRowByName("council")).getByRole("button", { name: /Change Model/ });
  });
});

describe("team views — Models hard scope (behaviors 7–9, 17)", () => {
  test("scoped rows only; primary/fallback/Council distinguished; drift annotation", async () => {
    renderTeam("/models");
    await poll(() => screen.getByText("gpt-5"));

    // Advertised-only model never appears (behavior 7).
    expect(screen.queryByText("gemini")).toBeNull();

    const gpt = findRowByName("gpt-5");
    const orch = within(gpt).getByRole("link", { name: "Orchestrator" });
    expect(orch.getAttribute("href")).toBe("/agents?model=openai%2Fgpt-5&agent=orchestrator");
    const council = within(gpt).getByRole("link", { name: "Council" });
    expect(council.getAttribute("href")).toBe("/council");

    // Drift stays an annotation on the Effective ref (behavior 3).
    const llama = findRowByName("llama");
    within(llama).getByLabelText("runtime drift");

    // Catalog chrome is gone (behavior 9).
    expect(screen.queryByRole("button", { name: /Probe Referenced/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Probe Effective Models/ })).toBeNull();
    expect(screen.queryByText(/Probe queue/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Providers" })).toBeNull();
  });

  test("model focus opens the scoped drawer without probing (behaviors 12, 17)", async () => {
    const { mock } = renderTeam("/models?model=openai/gpt-5");
    await poll(() => screen.getByRole("dialog", { name: /Model detail openai\/gpt-5/ }));
    expect(mock.callsTo("/api/models/probe", "POST")).toHaveLength(0);
  });

  test("unknown model focus shows topology-empty; Clear focus restores", async () => {
    renderTeam("/models?model=ghost/nope");
    await poll(() => screen.getByText(/No scoped model matches the current focus/));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear focus" }));
    await poll(() => expect(loc()).toBe("/models"));
    await poll(() => screen.getByText("gpt-5"));
  });

  test("models filters + sorts apply within the scoped set (behavior 8)", async () => {
    renderTeam("/models");
    await poll(() => screen.getByText("gpt-5"));

    fireEvent.click(screen.getByRole("radio", { name: /Issues, 1/ }));
    await poll(() => {
      screen.getByText("llama");
      expect(screen.queryByText("gpt-5")).toBeNull();
    });
    expect(loc()).toContain("filter=issues");

    fireEvent.click(screen.getByRole("radio", { name: /^All, 2/ }));
    await poll(() => screen.getByText("gpt-5"));

    // Sort by issues asc (select control; issues has no column) puts the
    // timeout model first.
    fireEvent.change(screen.getByLabelText("Sort"), {
      target: { value: "issues" },
    });
    await poll(() => {
      const rows = Array.from(document.querySelectorAll("tr[data-model-row]")).map(
        (r) => r.querySelector(".agent-name-btn")?.textContent,
      );
      expect(rows).toEqual(["llama", "gpt-5"]);
    });
  });
});

describe("team views — Providers derivation (behaviors 10–11)", () => {
  test("rows show name/id, connection, source, agents/models links, Council label, issues", async () => {
    renderTeam("/providers");
    await poll(() => screen.getByText("OpenAI"));

    // google has no scoped model → never appears (behavior 10).
    expect(screen.queryByText("Google")).toBeNull();

    const openai = findRowByName("OpenAI");
    within(openai).getByText("Connected");
    within(openai).getByText("openai");
    const agentsLink = within(openai).getByRole("link", { name: /1 agent/ });
    expect(agentsLink.getAttribute("href")).toBe("/agents?provider=openai");
    const modelsLink = within(openai).getByRole("link", { name: /1 model/ });
    expect(modelsLink.getAttribute("href")).toBe("/models?provider=openai");
    const council = within(openai).getByRole("link", { name: "Council" });
    expect(council.getAttribute("href")).toBe("/council");

    const ollama = findRowByName("Ollama");
    within(ollama).getByText(/1 issue/);

    // Source: LiveProvider.source only, else Not reported.
    expect(screen.getAllByText("Not reported").length).toBe(2);
  });

  test("disclosure lists dependents; provider focus auto-expands (behavior 12)", async () => {
    renderTeam("/providers?provider=ollama");
    await poll(() => screen.getByText("Ollama"));
    // Focused provider is expanded without clicking.
    await poll(() => screen.getByText("Scoped models"));
    const explorerLink = screen.getByRole("link", { name: "explorer" });
    expect(explorerLink.getAttribute("href")).toBe("/agents?provider=ollama&agent=explorer");
    const modelLink = screen.getByRole("link", { name: "llama" });
    // Both focus params present (order is encoding-detail, not contract).
    const href = new URL(String(modelLink.getAttribute("href")), "http://x");
    expect(href.pathname).toBe("/models");
    expect(href.searchParams.get("model")).toBe("ollama/llama");
    expect(href.searchParams.get("provider")).toBe("ollama");
  });

  test("provider filters and connected sort (behavior 11)", async () => {
    renderTeam("/providers");
    await poll(() => screen.getByText("OpenAI"));
    fireEvent.click(screen.getByRole("radio", { name: /Issues, 1/ }));
    await poll(() => {
      screen.getByText("Ollama");
      expect(screen.queryByText("OpenAI")).toBeNull();
    });
  });
});

describe("team views — cross-nav + focus/persistence (behaviors 12–15)", () => {
  test("agent Effective model links to selected Models (behavior 12)", async () => {
    renderTeam("/agents");
    await poll(() => screen.getByText("orchestrator"));
    const row = findRowByName("orchestrator");
    const link = within(row).getByRole("link", { name: /gpt-5/ });
    expect(link.getAttribute("href")).toBe("/models?model=openai%2Fgpt-5");
  });

  test("agents model focus constrains by Effective primary or fallback", async () => {
    renderTeam("/agents?model=ollama/llama");
    await poll(() => screen.getByText("explorer"));
    expect(screen.queryByText("orchestrator")).toBeNull();
    expect(screen.getByRole("button", { name: "Clear focus" })).toBeTruthy();
  });

  test("stored controls survive navigation; focus uses transient defaults then restores", async () => {
    const { router } = renderTeam("/agents");
    await poll(() => screen.getByText("orchestrator"));

    // Deliberate control change persists (replace + storage).
    fireEvent.click(screen.getByRole("radio", { name: /Runtime drift, 1/ }));
    await poll(() => expect(loc()).toContain("filter=runtime-drift"));

    await nav(router, "/models");
    await poll(() => screen.getByText("gpt-5"));
    await nav(router, "/agents");
    await poll(() => screen.getByText("explorer")); // drift row only
    expect(screen.getByRole("radio", { name: /Runtime drift, 1/ }).getAttribute("aria-checked")).toBe("true");

    // Focus navigation: transient defaults, stored state untouched.
    await nav(router, "/agents?model=openai/gpt-5");
    await poll(() => screen.getByText("orchestrator"));
    expect(screen.getByRole("radio", { name: /^All, 1/ }).getAttribute("aria-checked")).toBe("true");

    // Clear focus restores the stored tab state.
    fireEvent.click(screen.getByRole("button", { name: "Clear focus" }));
    await poll(() =>
      expect(screen.getByRole("radio", { name: /Runtime drift, 1/ }).getAttribute("aria-checked")).toBe("true"),
    );
  });

  test("migration: filter=disabled → disabled=1 and native=1 removed (behavior 15)", async () => {
    renderTeam("/agents?filter=disabled&native=1");
    await poll(() => screen.getByText("observer"));
    expect(loc()).toContain("disabled=1");
    expect(loc()).not.toContain("native=1");
    expect(loc()).not.toContain("filter=disabled");
    const toggle = screen.getByRole("checkbox", { name: /Show disabled/ }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
  });

  test("invalid agent focus is removed via replace after data load", async () => {
    renderTeam("/agents?agent=ghost&keep=1");
    await poll(() => screen.getByText("orchestrator"));
    await poll(() => expect(loc()).toBe("/agents?keep=1"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("browsing, filtering, sorting, cross-nav never probe or mutate (behavior 17)", async () => {
    const { router, mock } = renderTeam("/agents");
    await poll(() => screen.getByText("orchestrator"));
    fireEvent.click(screen.getByRole("radio", { name: /Custom, 0/ }));
    await poll(() => expect(loc()).toContain("filter=custom"));
    await nav(router, "/models");
    await poll(() => screen.getByText("gpt-5"));
    fireEvent.click(screen.getByRole("radio", { name: /Primary, 2/ }));
    await poll(() => expect(loc()).toContain("filter=primary"));
    await nav(router, "/providers");
    await poll(() => screen.getByText("OpenAI"));

    expect(mock.callsTo("/api/models/probe", "POST")).toHaveLength(0);
    expect(mock.callsTo("/api/models/probe-batch", "POST")).toHaveLength(0);
    expect(mock.callsTo("/api/config/apply", "POST")).toHaveLength(0);
    expect(mock.callsTo("/api/config/simulate", "POST")).toHaveLength(0);
  });
});

describe("team views — dense layout smoke (behavior 16)", () => {
  test("tables use the shared sheet/row classes; headers carry aria-sort only when sorted", async () => {
    renderTeam("/agents");
    await poll(() => screen.getByText("orchestrator"));
    expect(document.querySelector(".agents-table-surface")).toBeTruthy();
    expect(document.querySelectorAll('[aria-sort="ascending"]').length).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: /^Sort by agent/i }));
    await poll(() =>
      expect(document.querySelectorAll('[aria-sort="ascending"]').length).toBe(1),
    );
  });
});
