/**
 * Team topology Models route (doc 34) — scoped drawer + single-model probe.
 *
 * The Models view is HARD-SCOPED to active Effective topology, not the full
 * catalog. This suite covers the retained single-model probe safeguards:
 *  - hard-scoped rows only (advertised-only / history-only models excluded);
 *  - the scoped ModelDrawer opens via `?model=` focus and shows probe state
 *    + recent history;
 *  - the explicit single-model probe posts to `/api/models/probe` (never the
 *    removed batch endpoint) and never touches config mutation endpoints;
 *  - focus is preserved and cleared via the visible Clear focus affordance.
 *
 * Mounting: ModelsPage uses useSearchParams (route-backed) and
 * useModelAvailability, so tests wrap it in MemoryRouter + RuntimeProvider +
 * ModelAvailabilityProvider exactly as App.tsx does.
 */
import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { ModelsPage } from "../src/pages/ModelsPage";
import { ModelAvailabilityProvider } from "../src/models/ModelAvailabilityContext";
import { RuntimeProvider } from "../src/runtime/RuntimeContext";
import {
  baseRoutes,
  makeAgentsDto,
  makeModelAvailability,
  makeModelInventoryDto,
  makeProvider,
  makeProviderDiagnostics,
  makeProvidersDto,
  makeProbeRun,
  makeRow,
  makeUsageRef,
  mockFetch,
  poll,
  probeSummary,
  type World,
} from "./helpers";

function renderModels(ui: ReactNode, initialEntries: string[] = ["/models"]) {
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
 * Standard Team world for the Models route:
 *  - orchestrator: active builtin, primary of openai/gpt-5 (healthy)
 *  - explorer: active builtin, primary of ollama/llama (timeout)
 *  - google/gemini: advertised-only → never scoped
 *  - openai/gpt-5 also carries an active Council dependency ref.
 */
function modelsWorld(): World {
  const dto = makeAgentsDto(
    [
      makeRow({ name: "orchestrator", kind: "builtin", effectiveModel: "openai/gpt-5", modelSourceStage: "preset" }),
      makeRow({ name: "explorer", kind: "builtin", effectiveModel: "ollama/llama", modelSourceStage: "preset" }),
    ],
    "openai",
  );
  dto.desired.presets = {
    openai: {
      orchestrator: { name: "orchestrator", kind: "builtin", model: "openai/gpt-5", sourceIds: ["fixture"] },
      explorer: { name: "explorer", kind: "builtin", model: "ollama/llama", sourceIds: ["fixture"] },
    },
  };
  return {
    agents: dto,
    providers: makeProvidersDto([
      makeProvider("openai", "OpenAI", true, []),
      makeProvider("ollama", "Ollama", true, []),
      makeProvider("google", "Google", true, []),
    ]),
    models: makeModelInventoryDto({
      models: [
        makeModelAvailability({
          providerId: "openai",
          modelId: "gpt-5",
          usage: [
            makeUsageRef({ kind: "agent-primary", ownerId: "orchestrator", label: "Orchestrator" }),
            makeUsageRef({ kind: "council-member", ownerId: "trio", label: "Trio preset" }),
          ],
          probe: probeSummary({ state: "healthy", freshness: "fresh", latencyMs: 812, lastCompletedAt: isoAgo(60_000) }),
        }),
        makeModelAvailability({
          providerId: "ollama",
          modelId: "llama",
          usage: [makeUsageRef({ kind: "agent-primary", ownerId: "explorer", label: "Explorer" })],
          probe: probeSummary({ state: "timeout", freshness: "fresh", lastCompletedAt: isoAgo(60_000) }),
        }),
        makeModelAvailability({ providerId: "google", modelId: "gemini" }),
      ],
      providers: [
        makeProviderDiagnostics({ providerId: "openai" }),
        makeProviderDiagnostics({ providerId: "ollama" }),
        makeProviderDiagnostics({ providerId: "google" }),
      ],
    }),
    modelHistory: (providerId, modelId) =>
      providerId === "openai" && modelId === "gpt-5"
        ? [
            makeProbeRun({
              id: "run-a",
              providerId,
              modelId,
              state: "healthy",
              latencyMs: 812,
              statusCode: 200,
              startedAt: isoAgo(300_000),
            }),
            makeProbeRun({
              id: "run-b",
              providerId,
              modelId,
              state: "unauthorized",
              latencyMs: 210,
              statusCode: 403,
              errorMessage: "invalid API key",
              startedAt: isoAgo(7_200_000),
            }),
          ]
        : [],
  };
}

describe("models route — hard-scoped Effective topology (doc 34)", () => {
  test("scoped rows only; advertised-only models never appear", async () => {
    mockFetch(baseRoutes(modelsWorld()));
    renderModels(<ModelsPage />);
    await poll(() => screen.getByText("gpt-5"));

    // Scoped models render.
    screen.getByText("gpt-5");
    screen.getByText("llama");
    // Advertised-only model is out of scope.
    expect(screen.queryByText("gemini")).toBeNull();
    // Catalog chrome is gone (behavior 9).
    expect(screen.queryByRole("button", { name: /Probe Referenced/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Probe Effective Models/ })).toBeNull();
    expect(screen.queryByText(/Probe queue/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Providers" })).toBeNull();
  });

  test("scoped drawer opens via model focus and shows probe state + history", async () => {
    mockFetch(baseRoutes(modelsWorld()));
    renderModels(<ModelsPage />, ["/models?model=openai/gpt-5"]);
    const drawer = await poll(() =>
      screen.getByRole("dialog", { name: /Model detail openai\/gpt-5/ }),
    ).then(() => screen.getByRole("dialog", { name: /Model detail openai\/gpt-5/ }));

    // Probe state renders in the drawer.
    within(drawer).getByText("Healthy · 812ms");
    // Recent probe history (2 of 2) with the adverse run surfaced.
    await poll(() => within(drawer).getByText(/Recent probe history \(2 of 2\)/));
    within(drawer).getByText("Unauthorized");
    within(drawer).getByText("403");
    // Council dependency is labeled separately.
    within(drawer).getByText("Council");
    within(drawer).getByText(/Trio preset/);
  });

  test("explicit single-model probe posts to /api/models/probe, never batch or config", async () => {
    const mock = mockFetch(baseRoutes(modelsWorld()));
    renderModels(<ModelsPage />, ["/models?model=openai/gpt-5"]);
    await poll(() => screen.getByRole("dialog", { name: /Model detail openai\/gpt-5/ }));

    fireEvent.click(screen.getByRole("button", { name: "Probe Model" }));
    await poll(() => screen.getByText(/Probe queued: openai\/gpt-5/));

    const calls = mock.callsTo("/api/models/probe", "POST");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ providerId: "openai", modelId: "gpt-5" });
    // No batch invocation, no config mutation.
    expect(mock.callsTo("/api/models/probe-batch", "POST")).toHaveLength(0);
    expect(mock.callsTo("/api/config/simulate", "POST")).toHaveLength(0);
    expect(mock.callsTo("/api/config/apply", "POST")).toHaveLength(0);
  });

  test("unknown model focus shows topology-empty; Clear focus restores", async () => {
    mockFetch(baseRoutes(modelsWorld()));
    renderModels(<ModelsPage />, ["/models?model=ghost/nope"]);
    await poll(() => screen.getByText(/No scoped model matches the current focus/));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Clear focus" }));
    await poll(() => screen.getByText("gpt-5"));
  });
});
