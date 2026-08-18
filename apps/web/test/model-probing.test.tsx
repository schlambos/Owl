/**
 * Slice 15 §75 — Models workspace interaction tests (Lane 5b).
 *
 * Covers cases 1–13: table columns and probe states (1–3, 13), provider
 * summary cards (4), single probe without confirmation (5), batch
 * confirmation dialog semantics (6), provider-scoped batch (7),
 * client-computed effective set (8), queue panel (9), disconnected gating
 * (10), detail drawer (11), filters (12).
 *
 * Mounting: ModelsPage requires useModelAvailability (throwing variant), so
 * tests wrap the page in RuntimeProvider + ModelAvailabilityProvider exactly
 * as App.tsx does.
 */
import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type {
  ModelInventoryDto,
  ModelProbeSummary,
  RuntimeConnection,
} from "@omo/shared";
import { ModelsPage } from "../src/pages/ModelsPage";
import { ModelAvailabilityProvider } from "../src/models/ModelAvailabilityContext";
import { RuntimeProvider } from "../src/runtime/RuntimeContext";
import {
  baseRoutes,
  findRowByName,
  makeAgentsDto,
  makeModel,
  makeModelAvailability,
  makeModelInventoryDto,
  makeOverview,
  makeProvider,
  makeProvidersDto,
  makeQueueItem,
  makeQueueSnapshot,
  makeRuntimeState,
  makeProviderDiagnostics,
  makeProbeRun,
  makeUsageRef,
  mockFetch,
  poll,
  probeSummary,
  type World,
} from "./helpers";

function renderWithModels(ui: ReactNode) {
  return render(
    <RuntimeProvider>
      <ModelAvailabilityProvider>{ui}</ModelAvailabilityProvider>
    </RuntimeProvider>,
  );
}

const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

/** Canonical inventory used by most tests (see case mapping per test). */
function stdInventory(): ModelInventoryDto {
  return makeModelInventoryDto({
    models: [
      makeModelAvailability({
        providerId: "anthropic",
        modelId: "claude-sonnet-4-5",
        probe: probeSummary({
          state: "healthy",
          freshness: "fresh",
          latencyMs: 812,
          statusCode: 200,
          lastStartedAt: isoAgo(301_000),
          lastCompletedAt: isoAgo(300_000),
        }),
        capabilities: {
          state: "known",
          tools: true,
          vision: true,
          reasoning: true,
          source: "opencode:/config/providers",
          // Present in the payload to prove the UI never renders them.
          structuredOutput: true,
          toolIds: ["toolA"],
        },
        limit: { context: 200_000, output: 64_000 },
        usage: [
          makeUsageRef({ kind: "agent-primary", ownerId: "explorer", label: "Explorer" }),
          makeUsageRef({ kind: "agent-fallback", ownerId: "oracle", label: "Oracle", fallback: true }),
          makeUsageRef({ kind: "council-member", ownerId: "trio", label: "Trio preset" }),
          makeUsageRef({ kind: "acp-wrapper", ownerId: "acp-code", label: "ACP code" }),
        ],
      }),
      makeModelAvailability({
        providerId: "openai",
        modelId: "gpt-5",
        probe: probeSummary({
          state: "unauthorized",
          freshness: "fresh",
          statusCode: 403,
          errorMessage: "invalid API key",
          lastCompletedAt: isoAgo(600_000),
        }),
        capabilities: { state: "partial", tools: true, source: "opencode:/provider" },
        usage: [
          makeUsageRef({ kind: "agent-fallback", ownerId: "oracle", label: "Oracle", fallback: true }),
        ],
      }),
      makeModelAvailability({
        providerId: "ollama",
        modelId: "llama-3.3-70b",
      }),
      makeModelAvailability({
        providerId: "anthropic",
        modelId: "claude-opus-4-1",
        probe: probeSummary({
          state: "rate-limited",
          freshness: "fresh",
          statusCode: 429,
          lastCompletedAt: isoAgo(900_000),
        }),
      }),
      makeModelAvailability({
        providerId: "google",
        modelId: "gemini-2.5-pro",
        provider: { known: true, connected: false },
        probe: probeSummary({
          state: "running",
          freshness: "stale",
          lastStartedAt: isoAgo(5_000),
        }),
      }),
      makeModelAvailability({
        providerId: "local",
        modelId: "my-fine-tune",
        advertised: false,
        probe: probeSummary({
          state: "healthy",
          freshness: "stale",
          latencyMs: 55,
          statusCode: 200,
          lastCompletedAt: isoAgo(7_200_000),
        }),
      }),
    ],
    providers: [
      makeProviderDiagnostics({
        providerId: "anthropic",
        name: "Anthropic",
        advertisedCount: 2,
        referencedCount: 1,
        authMethods: [
          { type: "oauth", label: "OAuth" },
          { type: "api-key", label: "API key" },
        ],
        lastSuccessfulProbeAt: isoAgo(300_000),
      }),
      makeProviderDiagnostics({
        providerId: "openai",
        name: "OpenAI",
        advertisedCount: 1,
        referencedCount: 1,
        recentRateLimitCount: 3,
        lastSuccessfulProbeAt: isoAgo(600_000),
      }),
      makeProviderDiagnostics({ providerId: "ollama", name: "Ollama", advertisedCount: 1 }),
      makeProviderDiagnostics({ providerId: "google", name: "Google", connected: false, advertisedCount: 1 }),
      makeProviderDiagnostics({ providerId: "local", name: "Local", advertisedCount: 0 }),
    ],
  });
}

function stdWorld(): World {
  return {
    agents: makeAgentsDto([]),
    providers: makeProvidersDto([]),
    models: stdInventory(),
  };
}

async function waitForTable() {
  await poll(() => screen.getByText("claude-sonnet-4-5"));
}

/**
 * Expand one provider row in the provider strip and return the row (`li`).
 * Details (metrics, auth, probe action) live behind progressive disclosure.
 */
async function expandProvider(name: string): Promise<HTMLElement> {
  const toggle = screen.getByRole("button", { name: new RegExp(`^${name}\\b`) });
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  const row = toggle.closest("li") as HTMLElement;
  await poll(() => within(row).getByRole("button", { name: /Probe Referenced/ }));
  return row;
}

/** nextElementSibling text of a <dt> inside a dialog/panel. */
function ddFor(root: Element | HTMLElement, dtText: string): string | null {
  const dts = root.querySelectorAll("dt");
  for (const dt of dts) {
    if (dt.textContent?.trim() === dtText) {
      return dt.nextElementSibling?.textContent?.trim() ?? null;
    }
  }
  return null;
}

describe("models workspace (slice 15 §75)", () => {
  // Cases 1, 2, 3 — table columns are separate; states render correctly;
  // manual/unadvertised models stay listed.
  test("table renders separate Advertised/Referenced/Probe/Probe latency/Agents columns and all probe states", async () => {
    mockFetch(baseRoutes(stdWorld()));
    renderWithModels(<ModelsPage />);
    await waitForTable();

    for (const h of ["Model", "Provider", "Advertised", "Referenced", "Probe", "Probe latency", "Agents/Usage"]) {
      screen.getByRole("columnheader", { name: h });
    }

    // healthy + latency in separate columns; usage labels separate too
    const sonnet = findRowByName("claude-sonnet-4-5");
    within(sonnet).getByText("Healthy");
    within(sonnet).getByText("812ms");
    within(sonnet).getByText("Explorer");
    within(sonnet).getByText("Fallback · Oracle");

    // unauthorized includes the status code in the badge text
    within(findRowByName("gpt-5")).getByText("Unauthorized · 403");

    // never tested — quiet em dash, never a filled "Not tested" badge.
    // The label stays available to screen readers and via the title.
    const llama = findRowByName("llama-3.3-70b");
    within(llama).getAllByText("—"); // unprobed · unreferenced · no latency
    within(llama).getByTitle("Probe state: not tested");
    within(llama).getByTitle("Advertised in OpenCode catalog"); // advertised stays quiet

    // rate limited
    within(findRowByName("claude-opus-4-1")).getByText("Rate limited · 429");

    // running with a pulsing dot
    const gemini = findRowByName("gemini-2.5-pro");
    within(gemini).getByText("Running");
    expect(gemini.querySelector(".dot.pulse")).not.toBeNull();

    // manual/unadvertised: quiet "manual" pill, still listed
    const local = findRowByName("my-fine-tune");
    within(local).getByText("manual");
    within(local).getByTitle("Not advertised — referenced manually in configuration");

    // referenced reads as an inventory count, not a Yes/No status
    within(findRowByName("claude-sonnet-4-5")).getByText("4");
  });

  // Case 13 — stale/fresh freshness is a separate element, never color-blended.
  test("freshness renders as a separate label, badge keeps state color", async () => {
    mockFetch(baseRoutes(stdWorld()));
    renderWithModels(<ModelsPage />);
    await waitForTable();

    const localRow = findRowByName("my-fine-tune");
    const badge = localRow.querySelector(".probe-badge")!;
    const fresh = localRow.querySelector(".probe-freshness")!;
    expect(badge.textContent).toBe("Healthy");
    expect(badge.className).toContain("ok"); // still the healthy color
    expect(badge.className).not.toContain("warn");
    expect(fresh.textContent).toBe("stale");
    expect(fresh.closest(".probe-badge")).toBeNull(); // not inside the badge

    const sonnetRow = findRowByName("claude-sonnet-4-5");
    const sonnetFresh = sonnetRow.querySelector(".probe-freshness")!;
    expect(sonnetFresh.textContent).toBe("5m ago");
    expect(sonnetFresh.closest(".probe-badge")).toBeNull();
  });

  // Case 4 — provider strip: compact rows + progressive disclosure details.
  test("provider strip keeps connection, counts, auth, rate-limit behind disclosure", async () => {
    mockFetch(baseRoutes(stdWorld()));
    renderWithModels(<ModelsPage />);
    await waitForTable();

    // One compact row per provider; details collapsed by default.
    screen.getByRole("heading", { name: "Providers" });
    const rows = screen.getAllByRole("listitem");
    expect(rows.length).toBe(5);
    for (const t of screen.getAllByRole("button", { name: /^(Anthropic|OpenAI|Ollama|Google|Local)\b/ })) {
      expect(t.getAttribute("aria-expanded")).toBe("false");
    }

    // Row summary: id + inventory counts + problem markers stay visible.
    const anthropicToggle = screen.getByRole("button", { name: /^Anthropic\b/ });
    expect(anthropicToggle.textContent).toContain("anthropic");
    expect(anthropicToggle.textContent).toContain("2 models · 1 referenced");
    expect(anthropicToggle.textContent).toContain("1 healthy");
    expect(anthropicToggle.textContent).toContain("1 problem"); // opus rate-limited

    const openaiToggle = screen.getByRole("button", { name: /^OpenAI\b/ });
    expect(openaiToggle.textContent).toContain("rate-limited 3×");

    const googleToggle = screen.getByRole("button", { name: /^Google\b/ });
    expect(googleToggle.textContent).toContain("disconnected");

    // Expanded details preserve every card datum.
    const anthropic = await expandProvider("Anthropic");
    within(anthropic).getByText("Connected");
    within(anthropic).getByText("2 advertised · 1 referenced");
    within(anthropic).getByText("2 probed · 1 healthy · 0 not tested");
    within(anthropic).getByText("Auth: OAuth, API key"); // metadata only, no auth-state claim
    within(anthropic).getByText(/Last successful probe .*ago/);

    const openai = await expandProvider("OpenAI");
    within(openai).getByText("1 probed · 0 healthy · 0 not tested");
    within(openai).getByText("Rate-limited 3× recently");

    const google = await expandProvider("Google");
    within(google).getByText("Disconnected");
  });

  // Case 5 — single [Probe Model] posts directly, no confirmation dialog.
  test("drawer Probe Model posts single probe with no confirmation", async () => {
    const mock = mockFetch(baseRoutes(stdWorld()));
    renderWithModels(<ModelsPage />);
    await waitForTable();

    fireEvent.click(findRowByName("claude-sonnet-4-5"));
    await poll(() => screen.getByRole("dialog", { name: /Model detail anthropic\/claude-sonnet-4-5/ }));
    expect(screen.queryByText(/You are about to invoke/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Probe Model" }));
    await poll(() => screen.getByText(/Probe queued: anthropic\/claude-sonnet-4-5/));

    const calls = mock.callsTo("/api/models/probe", "POST");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({
      providerId: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
    // Still no confirmation dialog was shown anywhere in the flow.
    expect(screen.queryByText(/You are about to invoke/)).toBeNull();
    // And no config mutation endpoints were touched.
    expect(mock.callsTo("/api/config/simulate", "POST")).toHaveLength(0);
    expect(mock.callsTo("/api/config/apply", "POST")).toHaveLength(0);
  });

  // Case 6 — global batch confirmation dialog semantics.
  test("Probe Referenced batch dialog: quota copy, skip-fresh default on/off", async () => {
    const mock = mockFetch(baseRoutes(stdWorld()));
    renderWithModels(<ModelsPage />);
    await waitForTable();

    fireEvent.click(screen.getByRole("button", { name: "Probe Referenced (2)" }));
    await poll(() => screen.getByRole("dialog", { name: "Confirm probe batch" }));
    screen.getByText(/You are about to invoke 2 models through OpenCode/);
    screen.getByText(/This may consume provider quota/);
    const skip = screen.getByRole("checkbox", { name: "Skip recently tested models" }) as HTMLInputElement;
    expect(skip.checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Probe 2 Models" }));
    await poll(() => expect(mock.callsTo("/api/models/probe-batch", "POST")).toHaveLength(1));
    const first = mock.callsTo("/api/models/probe-batch", "POST")[0]!.body as {
      models: Array<{ providerId: string; modelId: string }>;
      skipRecentlyTested: boolean;
    };
    expect(first.skipRecentlyTested).toBe(true);
    expect(first.models).toHaveLength(2);
    // src posts the deduped availability objects; compare id pairs.
    const pairs = first.models.map((m) => ({ providerId: m.providerId, modelId: m.modelId }));
    expect(pairs).toContainEqual({ providerId: "anthropic", modelId: "claude-sonnet-4-5" });
    expect(pairs).toContainEqual({ providerId: "openai", modelId: "gpt-5" });

    // Re-open, uncheck "skip recently tested" → posts skipRecentlyTested:false
    fireEvent.click(screen.getByRole("button", { name: "Probe Referenced (2)" }));
    await poll(() => screen.getByRole("dialog", { name: "Confirm probe batch" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Skip recently tested models" }));
    fireEvent.click(screen.getByRole("button", { name: "Probe 2 Models" }));
    await poll(() => expect(mock.callsTo("/api/models/probe-batch", "POST")).toHaveLength(2));
    const second = mock.callsTo("/api/models/probe-batch", "POST")[1]!.body as {
      skipRecentlyTested: boolean;
    };
    expect(second.skipRecentlyTested).toBe(false);
  });

  // Case 7 — provider strip batch scopes to that provider's referenced models.
  test("provider row Probe Referenced posts only that provider's models", async () => {
    const mock = mockFetch(baseRoutes(stdWorld()));
    renderWithModels(<ModelsPage />);
    await waitForTable();

    const anthropic = await expandProvider("Anthropic");
    fireEvent.click(within(anthropic).getByRole("button", { name: "Probe Referenced (1)" }));
    await poll(() => screen.getByRole("dialog", { name: "Confirm probe batch" }));
    fireEvent.click(screen.getByRole("button", { name: "Probe 1 Models" }));
    await poll(() => expect(mock.callsTo("/api/models/probe-batch", "POST")).toHaveLength(1));
    const body = mock.callsTo("/api/models/probe-batch", "POST")[0]!.body as {
      models: Array<{ providerId: string; modelId: string }>;
    };
    expect(
      body.models.map((m) => ({ providerId: m.providerId, modelId: m.modelId })),
    ).toEqual([{ providerId: "anthropic", modelId: "claude-sonnet-4-5" }]);
  });

  // Case 8 — Probe Effective Models: active-usage-only set, deduped.
  test("Probe Effective Models excludes inactive usage references", async () => {
    const mock = mockFetch(
      baseRoutes({
        agents: makeAgentsDto([]),
        providers: makeProvidersDto([]),
        models: makeModelInventoryDto({
          models: [
            makeModelAvailability({
              providerId: "anthropic",
              modelId: "claude-sonnet-4-5",
              usage: [makeUsageRef({ kind: "agent-primary", active: true })],
            }),
            makeModelAvailability({
              providerId: "openai",
              modelId: "gpt-5",
              // council membership in an INACTIVE preset → excluded
              usage: [makeUsageRef({ kind: "council-member", ownerId: "duo", label: "Duo preset", active: false })],
            }),
            makeModelAvailability({
              providerId: "ollama",
              modelId: "llama-3.3-70b",
              usage: [makeUsageRef({ kind: "agent-fallback", ownerId: "oracle", label: "Oracle", fallback: true, active: true })],
            }),
          ],
          providers: [
            makeProviderDiagnostics({ providerId: "anthropic" }),
            makeProviderDiagnostics({ providerId: "openai", name: "OpenAI" }),
            makeProviderDiagnostics({ providerId: "ollama", name: "Ollama" }),
          ],
        }),
      }),
    );
    renderWithModels(<ModelsPage />);
    await waitForTable();

    fireEvent.click(screen.getByRole("button", { name: "Probe Effective Models (2)" }));
    await poll(() => screen.getByRole("dialog", { name: "Confirm probe batch" }));
    fireEvent.click(screen.getByRole("button", { name: "Probe 2 Models" }));
    await poll(() => expect(mock.callsTo("/api/models/probe-batch", "POST")).toHaveLength(1));
    const body = mock.callsTo("/api/models/probe-batch", "POST")[0]!.body as {
      models: Array<{ providerId: string; modelId: string }>;
    };
    const pairs = body.models.map((m) => ({ providerId: m.providerId, modelId: m.modelId }));
    expect(pairs).toContainEqual({ providerId: "anthropic", modelId: "claude-sonnet-4-5" });
    expect(pairs).toContainEqual({ providerId: "ollama", modelId: "llama-3.3-70b" });
    expect(pairs).not.toContainEqual({ providerId: "openai", modelId: "gpt-5" });
  });

  // Case 9 — queue panel: pending Cancel + running Abort via cancel endpoint.
  test("queue panel commit: Cancel pending, Abort running", async () => {
    const world = stdWorld();
    world.models = makeModelInventoryDto({
      ...world.models!,
      queue: makeQueueSnapshot({
        running: [
          makeQueueItem({
            id: "q-run-1",
            state: "running",
            startedAt: isoAgo(10_000),
          }),
        ],
        pending: [
          makeQueueItem({
            id: "q-pend-9",
            providerId: "openai",
            modelId: "gpt-5",
          }),
        ],
      }),
    });
    const mock = mockFetch(baseRoutes(world));
    renderWithModels(<ModelsPage />);
    await waitForTable();

    await poll(() => screen.getByText(/Probe queue — 1 running · 1 pending · concurrency 2/));
    screen.getByRole("button", { name: "Abort" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await poll(() =>
      expect(mock.callsTo("/api/models/probes/q-pend-9/cancel", "POST")).toHaveLength(1),
    );
  });

  // Case 10a — OpenCode disconnected: banner + probe buttons disabled w/ reason.
  test("OpenCode disconnected disables all probe buttons with reason", async () => {
    const DISC: RuntimeConnection = {
      rest: "disconnected",
      sse: "disconnected",
      stale: true,
      opencodeBaseUrl: "http://127.0.0.1:4096",
    };
    const rt = makeRuntimeState();
    rt.connection = DISC;
    const ov = makeOverview();
    ov.connection = DISC;
    mockFetch([
      { prefix: "/api/runtime", respond: () => rt },
      { prefix: "/api/overview", respond: () => ov },
      ...baseRoutes(stdWorld()),
    ]);
    renderWithModels(<ModelsPage />);
    await waitForTable();

    screen.getByText(/OpenCode is disconnected — inventory may be stale/);
    const globalBtn = screen.getByRole("button", { name: "Probe Referenced (2)" }) as HTMLButtonElement;
    expect(globalBtn.disabled).toBe(true);
    expect(globalBtn.title).toBe("OpenCode is disconnected");

    const anthropic = await expandProvider("Anthropic");
    const rowBtn = within(anthropic).getByRole("button", { name: /Probe Referenced/ }) as HTMLButtonElement;
    expect(rowBtn.disabled).toBe(true);
    expect(rowBtn.title).toBe("OpenCode is disconnected");
  });

  // Case 10b — provider disconnected: that provider's probe affordances off.
  test("provider disconnected disables that provider's probe buttons", async () => {
    const inv = stdInventory();
    inv.providers = inv.providers.map((p) =>
      p.providerId === "local" ? { ...p, connected: false } : p,
    );
    inv.models = inv.models.map((m) =>
      m.providerId === "local"
        ? {
            ...m,
            provider: { known: true, connected: false },
            usage: [makeUsageRef()], // referenced → disable comes from disconnect, not count
          }
        : m,
    );
    const world = stdWorld();
    world.models = inv;
    mockFetch(baseRoutes(world));
    renderWithModels(<ModelsPage />);
    await waitForTable();

    const local = await expandProvider("Local");
    const rowBtn = within(local).getByRole("button", { name: /Probe Referenced/ }) as HTMLButtonElement;
    expect(rowBtn.disabled).toBe(true);
    expect(rowBtn.title).toBe("Provider is not connected in OpenCode");

    fireEvent.click(findRowByName("my-fine-tune"));
    await poll(() => screen.getByRole("dialog", { name: /Model detail local\/my-fine-tune/ }));
    const drawer = screen.getByRole("dialog", { name: /Model detail local\/my-fine-tune/ });
    const probeBtn = within(drawer).getByRole("button", { name: "Probe Model" }) as HTMLButtonElement;
    expect(probeBtn.disabled).toBe(true);
    expect(probeBtn.title).toBe("Provider is not connected in OpenCode");
    within(drawer).getByText("Provider is not connected in OpenCode");
  });

  // Case 11 — detail drawer contents (and nothing it must never show).
  test("drawer shows probe state, history, usage groups, capabilities; never structured-output/tool-ids", async () => {
    const world = stdWorld();
    world.modelHistory = (providerId, modelId) =>
      providerId === "anthropic" && modelId === "claude-sonnet-4-5"
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
        : [];
    mockFetch(baseRoutes(world));
    renderWithModels(<ModelsPage />);
    await waitForTable();

    fireEvent.click(findRowByName("claude-sonnet-4-5"));
    const drawer = await poll(() =>
      screen.getByRole("dialog", { name: /Model detail anthropic\/claude-sonnet-4-5/ }),
    ).then(() => screen.getByRole("dialog", { name: /Model detail anthropic\/claude-sonnet-4-5/ }));

    // Probe state + latency (badge shows "Healthy · 812ms"); exact column
    // label "Probe latency" lives on the table header (page stays mounted
    // behind the inert sheet).
    within(drawer).getByText("Healthy · 812ms");
    expect(
      document.querySelector('th') &&
        Array.from(document.querySelectorAll("th")).some(
          (th) => th.textContent === "Probe latency",
        ),
    ).toBe(true);
    expect(ddFor(drawer, "latency")).toBe("812ms");
    expect(ddFor(drawer, "completed")).toBe("5m ago");

    // Recent probe history: state / status / relative time, 2 of 2
    await poll(() => within(drawer).getByText(/Recent probe history \(2 of 2\)/));
    within(drawer).getByText("Unauthorized");
    within(drawer).getByText("403");
    expect(within(drawer).getAllByText(/ago/).length).toBeGreaterThan(0);
    expect(within(drawer).getAllByText("Healthy").length).toBeGreaterThan(0);

    // Configured use, grouped (owner + role render as separate nodes →
    // use a function matcher over whole-element content)
    within(drawer).getByText("Agents");
    within(drawer).getByText((_, el) => el?.textContent === "explorer — primary");
    expect(
      within(drawer).getAllByText(
        (_, el) => el?.textContent?.includes("oracle — fallback #1") ?? false,
      ).length,
    ).toBeGreaterThan(0);
    within(drawer).getByText("Council");
    within(drawer).getByText(/Trio preset/);
    within(drawer).getByText("ACP wrappers");
    within(drawer).getByText(/ACP code/);

    // Capabilities: Yes/No + source label; limits
    within(drawer).getByText("Capabilities (OpenCode catalog)");
    expect(ddFor(drawer, "Tools")).toBe("Yes");
    expect(ddFor(drawer, "Vision")).toBe("Yes");
    expect(ddFor(drawer, "Reasoning")).toBe("Yes");
    within(drawer).getByText(/200,000 tokens|200000 tokens/);

    // NEVER structured-output / tool-id claims
    expect(drawer.textContent).not.toMatch(/structured output/i);
    expect(drawer.textContent).not.toMatch(/toolA/);
  });

  // Case 12 — filters: probe-state, usage-kind, connected-only.
  test("probe-state, usage-kind and connected-only filters narrow rows", async () => {
    mockFetch(baseRoutes(stdWorld()));
    renderWithModels(<ModelsPage />);
    await waitForTable();

    // probe-state filter: Unauthorized → only gpt-5 remains
    fireEvent.click(screen.getByRole("checkbox", { name: "Unauthorized" }));
    await poll(() => {
      screen.getByText("gpt-5");
      expect(screen.queryByText("claude-sonnet-4-5")).toBeNull();
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Unauthorized" }));

    // usage-kind: fallback-only → gpt-5 (fallback usage, no primary)
    fireEvent.change(screen.getByLabelText("Filter by usage kind"), {
      target: { value: "fallback-only" },
    });
    await poll(() => {
      screen.getByText("gpt-5");
      expect(screen.queryByText("claude-sonnet-4-5")).toBeNull();
    });

    // usage-kind: council → sonnet (council-member usage in fixture)
    fireEvent.change(screen.getByLabelText("Filter by usage kind"), {
      target: { value: "council" },
    });
    await poll(() => {
      screen.getByText("claude-sonnet-4-5");
      expect(screen.queryByText("gpt-5")).toBeNull();
    });
    fireEvent.change(screen.getByLabelText("Filter by usage kind"), {
      target: { value: "all" },
    });
    await waitForTable();

    // connected-only: google is disconnected in the fixture → row hidden
    fireEvent.click(screen.getByRole("checkbox", { name: "Connected only" }));
    await poll(() => {
      expect(screen.queryByText("gemini-2.5-pro")).toBeNull();
      screen.getByText("claude-sonnet-4-5");
    });
  });
});

describe("models workspace accessibility + presentation", () => {
  test("drawer uses FocusTrapDialog: heading focus, trap, Escape, focus return", async () => {
    mockFetch(baseRoutes(stdWorld()));
    renderWithModels(<ModelsPage />);
    await waitForTable();

    const trigger = within(findRowByName("claude-sonnet-4-5")).getByRole(
      "button",
      { name: "claude-sonnet-4-5" },
    );
    fireEvent.click(trigger);
    await poll(() =>
      screen.getByRole("dialog", {
        name: /Model detail anthropic\/claude-sonnet-4-5/,
      }),
    );
    const drawer = screen.getByRole("dialog", {
      name: /Model detail anthropic\/claude-sonnet-4-5/,
    });
    expect(drawer.getAttribute("aria-modal")).toBe("true");
    const heading = document.getElementById("model-detail-drawer-title");
    expect(document.activeElement).toBe(heading);

    const close = within(drawer).getByRole("button", { name: "Close" });
    const probe = within(drawer).getByRole("button", { name: "Probe Model" });
    probe.focus();
    fireEvent.keyDown(probe, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(probe);

    fireEvent.keyDown(drawer, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", {
        name: /Model detail anthropic\/claude-sonnet-4-5/,
      }),
    ).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test("batch confirmation uses FocusTrapDialog and Escape closes when idle", async () => {
    mockFetch(baseRoutes(stdWorld()));
    renderWithModels(<ModelsPage />);
    await waitForTable();

    const open = screen.getByRole("button", { name: "Probe Referenced (2)" });
    fireEvent.click(open);
    await poll(() =>
      screen.getByRole("dialog", { name: "Confirm probe batch" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Confirm probe batch" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(
      document.getElementById("model-batch-dialog-title"),
    );
    expect(document.querySelector(".ftd-backdrop.ftd-modal")).toBeTruthy();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Confirm probe batch" })).toBeNull();
    expect(document.activeElement === open).toBe(true);
  });

  test("catalog display name is primary; technical id stays visible and searchable", async () => {
    mockFetch([
      {
        prefix: "/api/providers",
        respond: () =>
          makeProvidersDto([
            makeProvider("anthropic", "Anthropic", true, [
              makeModel("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
            ]),
          ]),
      },
      ...baseRoutes(stdWorld()),
    ]);
    renderWithModels(<ModelsPage />);
    await waitForTable();

    const row = findRowByName("claude-sonnet-4-5");
    within(row).getByRole("button", { name: "Claude Sonnet 4.5" });
    within(row).getByText("claude-sonnet-4-5");

    fireEvent.change(
      screen.getByLabelText("Filter provider, model, or usage"),
      { target: { value: "sonnet 4.5" } },
    );
    await poll(() => {
      screen.getByRole("button", { name: "Claude Sonnet 4.5" });
      expect(screen.queryByText("gpt-5")).toBeNull();
    });
  });
});

