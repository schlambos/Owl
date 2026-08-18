/**
 * Slice: Managed / Attach OpenCode lifecycle UI.
 *
 * Verifies the ownership-aware ConnectionBar, the System page lifecycle
 * panel, and the Doctor page backend cards:
 *   - managed/attached ownership pills
 *   - initializing/starting/waiting lifecycle wording
 *   - restarting distinguished from generic stale
 *   - managed-failed copy + Retry (when error.retryable)
 *   - attach-failed copy (no managed fallback implied)
 *   - dynamic URL surfaced + `opencode attach <url>` copy affordance
 *   - model inventory preserved across backend generation change
 *   - SSE `opencode.lifecycle.updated` + `opencode.backend.generation`
 *     advance the panel without a refetch storm.
 */
import { describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type {
  OpenCodeLifecycleState,
} from "@omo/shared";
import { ConnectionBar } from "../src/components/ConnectionBar";
import { DoctorPage } from "../src/pages/DoctorPage";
import { SystemPage } from "../src/pages/SystemPage";
import { AgentsPage } from "../src/pages/AgentsPage";
import { ModelAvailabilityProvider } from "../src/models/ModelAvailabilityContext";
import { RuntimeProvider } from "../src/runtime/RuntimeContext";
import {
  baseRoutes,
  dispatchCpEvent,
  findRowByName,
  makeAgentsDto,
  makeLifecycle,
  makeModel,
  makeModelInventoryDto,
  makeProvider,
  makeProvidersDto,
  makeRow,
  mockFetch,
  poll,
  renderWithRuntime,
  type World,
} from "./helpers";

const NOW = "2026-08-13T00:00:00.000Z";
const ATTACHED_BASE = "http://127.0.0.1:7777";

async function openConnectionPopover() {
  await poll(() => screen.getByTestId("connection-trigger"));
  fireEvent.click(screen.getByTestId("connection-trigger"));
}

function worldWith(lifecycle: OpenCodeLifecycleState, extra: Partial<World> = {}): World {
  return {
    agents: { rows: [], desired: { sources: [], agents: {}, presets: {}, globals: {}, raw: {} }, effective: { agents: {}, disabledAgents: [], backgroundJobs: {}, fallback: {}, warnings: [], sources: [] }, liveAgents: [] },
    providers: { providers: [], connected: [], fetchedAt: NOW },
    lifecycle,
    ...extra,
  };
}

describe("lifecycle — ConnectionBar ownership pills", () => {
  test("managed connected: pills, version, dynamic URL, no restart/failed", async () => {
    mockFetch(baseRoutes(worldWith(makeLifecycle())));
    renderWithRuntime(
      <MemoryRouter>
        <ConnectionBar />
      </MemoryRouter>,
    );

    await openConnectionPopover();
    await poll(() => {
      screen.getByTestId("connection-bar");
      screen.getByTestId("lifecycle-status-pill");
    });

    expect(screen.getByTestId("lifecycle-status-pill").textContent).toBe("Connected");
    expect(screen.getByTestId("lifecycle-mode-pill").textContent).toBe("Managed");
    expect(screen.getByTestId("lifecycle-ownership-pill").textContent).toBe("Control Plane");
    expect(screen.queryByTestId("lifecycle-restart-pill")).toBeNull();
    expect(screen.queryByTestId("lifecycle-failed-pill")).toBeNull();
    expect(screen.getByTestId("lifecycle-base-url").textContent).toBe(
      "http://127.0.0.1:4096",
    );
  });

  test("attached: pills + dynamic external URL surfaced", async () => {
    mockFetch(
      baseRoutes(
        worldWith(
          makeLifecycle({
            mode: "attach",
            ownership: "external",
            baseUrl: ATTACHED_BASE,
            version: "1.20.0",
            generation: 2,
          }),
        ),
      ),
    );
    renderWithRuntime(
      <MemoryRouter>
        <ConnectionBar />
      </MemoryRouter>,
    );

    await openConnectionPopover();
    await poll(() => screen.getByTestId("lifecycle-status-pill"));
    expect(screen.getByTestId("lifecycle-mode-pill").textContent).toBe("Attached");
    expect(screen.getByTestId("lifecycle-ownership-pill").textContent).toBe("External");
    expect(screen.getByTestId("lifecycle-base-url").textContent).toBe(ATTACHED_BASE);
  });

  test("starting + waiting wording shown", async () => {
    mockFetch(
      baseRoutes(
        worldWith(
          makeLifecycle({
            status: "starting",
            baseUrl: undefined,
            ready: {
              health: false,
              configProviders: false,
              providers: false,
              agents: false,
              omo: true,
              omoExpected: true,
              rest: false,
              sse: false,
            },
          }),
        ),
      ),
    );
    renderWithRuntime(
      <MemoryRouter>
        <ConnectionBar />
      </MemoryRouter>,
    );
    await openConnectionPopover();
    await poll(() => screen.getByTestId("lifecycle-status-pill"));
    expect(screen.getByTestId("lifecycle-status-pill").textContent).toBe("Starting");
  });

  test("waiting-health wording shown", async () => {
    mockFetch(
      baseRoutes(
        worldWith(
          makeLifecycle({
            status: "waiting-health",
            baseUrl: "http://127.0.0.1:4096",
            ready: {
              health: false,
              configProviders: false,
              providers: false,
              agents: false,
              omo: true,
              omoExpected: true,
              rest: false,
              sse: false,
            },
          }),
        ),
      ),
    );
    renderWithRuntime(
      <MemoryRouter>
        <ConnectionBar />
      </MemoryRouter>,
    );
    await openConnectionPopover();
    await poll(() => screen.getByTestId("lifecycle-status-pill"));
    expect(screen.getByTestId("lifecycle-status-pill").textContent).toBe(
      "Waiting for health",
    );
  });

  test("intentional restart: restart pill + counter, no 'stale'", async () => {
    mockFetch(
      baseRoutes(
        worldWith(
          makeLifecycle({
            status: "restarting",
            baseUrl: "http://127.0.0.1:4096",
            ready: {
              health: false,
              configProviders: false,
              providers: false,
              agents: false,
              omo: true,
              omoExpected: true,
              rest: false,
              sse: false,
            },
            restart: {
              attempt: 2,
              maxAttempts: 5,
              nextRetryAt: "2026-08-13T00:00:02.000Z",
              lastReason: "connection lost",
            },
          }),
        ),
      ),
    );
    renderWithRuntime(
      <MemoryRouter>
        <ConnectionBar />
      </MemoryRouter>,
    );
    await openConnectionPopover();
    await poll(() => screen.getByTestId("lifecycle-restart-pill"));
    const restartPill = screen.getByTestId("lifecycle-restart-pill");
    expect(restartPill.textContent).toContain("Restart");
    expect(restartPill.textContent).toContain("2/5");
    // Title includes the next attempt time but locale-dependent; assert
    // only that the marker is present.
    expect(restartPill.title).toMatch(/Next attempt at/);

    // Generic stale pill must NOT appear while we are intentionally
    // restarting — that is the entire point of the new wording.
    expect(screen.queryByText(/stale possible/i)).toBeNull();
  });

  test("failed: failed pill surfaces distinct from stale", async () => {
    mockFetch(
      baseRoutes(
        worldWith(
          makeLifecycle({
            status: "failed",
            baseUrl: undefined,
            ready: {
              health: false,
              configProviders: false,
              providers: false,
              agents: false,
              omo: true,
              omoExpected: true,
              rest: false,
              sse: false,
            },
            error: {
              code: "managed-restart-exhausted",
              message: "startup failed",
              action: "Inspect startup error, then Retry.",
              retryable: true,
              at: NOW,
            },
          }),
        ),
      ),
    );
    renderWithRuntime(
      <MemoryRouter>
        <ConnectionBar />
      </MemoryRouter>,
    );
    await openConnectionPopover();
    await poll(() => screen.getByTestId("lifecycle-failed-pill"));
    expect(screen.getByTestId("lifecycle-failed-pill").textContent).toBe("Backend failed");
  });
});

describe("lifecycle — System page panel", () => {
  test("managed connected: dynamic URL, attach command, version, generation", async () => {
    mockFetch(
      baseRoutes(
        worldWith(
          makeLifecycle({
            mode: "managed",
            ownership: "control-plane",
            baseUrl: "http://127.0.0.1:4096",
            version: "1.18.14",
            generation: 3,
          }),
        ),
      ),
    );
    renderWithRuntime(
      <MemoryRouter initialEntries={["/system"]}>
        <SystemPage />
      </MemoryRouter>,
    );

    await poll(() => screen.getByRole("button", { name: "OpenCode Backend" }));
    fireEvent.click(screen.getByRole("button", { name: "OpenCode Backend" }));

    await poll(() => {
      screen.getByTestId("lifecycle-panel");
      screen.getByTestId("lifecycle-base-url-value");
    });
    expect(screen.getByTestId("lifecycle-mode").textContent).toBe("Managed");
    expect(screen.getByTestId("lifecycle-ownership").textContent).toBe("Control Plane");
    expect(screen.getByTestId("lifecycle-version").textContent).toBe("1.18.14");
    expect(screen.getByTestId("lifecycle-base-url-value").textContent).toBe(
      "http://127.0.0.1:4096",
    );
    // Attach command for connected Managed backend.
    expect(screen.getByTestId("lifecycle-attach-command").textContent).toBe(
      "opencode attach http://127.0.0.1:4096",
    );
    // Readiness rows render.
    expect(screen.getByTestId("readiness-health").dataset.ready).toBe("true");
    expect(screen.getByTestId("readiness-rest").dataset.ready).toBe("true");
    expect(screen.getByTestId("readiness-sse").dataset.ready).toBe("true");
  });

  test("attach command copy button announces Copied via aria-live", async () => {
    let writeText = 0;
    const originalDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (_s: string) => {
          writeText += 1;
        },
      },
    });
    try {
      mockFetch(
        baseRoutes(
          worldWith(
            makeLifecycle({
              mode: "managed",
              ownership: "control-plane",
              baseUrl: "http://127.0.0.1:4096",
              version: "1.18.14",
            }),
          ),
        ),
      );
      renderWithRuntime(
        <MemoryRouter initialEntries={["/system"]}>
          <SystemPage />
        </MemoryRouter>,
      );
      await poll(() => screen.getByRole("button", { name: "OpenCode Backend" }));
      fireEvent.click(screen.getByRole("button", { name: "OpenCode Backend" }));
      await poll(() => screen.getByTestId("lifecycle-attach-copy"));
      fireEvent.click(screen.getByTestId("lifecycle-attach-copy"));
      await poll(() => {
        expect(screen.getByTestId("lifecycle-attach-copy").textContent).toBe(
          "Copied",
        );
      });
      expect(writeText).toBe(1);
      const status = screen.getByTestId("lifecycle-attach-copy-status").textContent ?? "";
      expect(status).toContain("Copied opencode attach http://127.0.0.1:4096");
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(navigator, "clipboard", originalDescriptor);
      } else {
        delete (navigator as unknown as { clipboard?: unknown }).clipboard;
      }
    }
  });

  test("managed-failed: 'Managed OpenCode failed to start' + Retry when retryable", async () => {
    const lifecycle = makeLifecycle({
      mode: "managed",
      ownership: "control-plane",
      status: "failed",
      baseUrl: undefined,
      ready: {
        health: false,
        configProviders: false,
        providers: false,
        agents: false,
        omo: true,
        omoExpected: true,
        rest: false,
        sse: false,
      },
      error: {
        code: "managed-restart-exhausted",
        message: "startup failed",
        action: "Inspect startup error, then Retry.",
        retryable: true,
        at: NOW,
      },
    });
    const mock = mockFetch(
      baseRoutes(
        worldWith(lifecycle, {
          retryLifecycle: () => ({
            ok: true,
            lifecycle: { ...lifecycle, status: "restarting", error: undefined, restart: { attempt: 1, maxAttempts: 5 } },
          }),
        }),
      ),
    );
    renderWithRuntime(
      <MemoryRouter initialEntries={["/system"]}>
        <SystemPage />
      </MemoryRouter>,
    );
    await poll(() => screen.getByRole("button", { name: "OpenCode Backend" }));
    fireEvent.click(screen.getByRole("button", { name: "OpenCode Backend" }));

    await poll(() => screen.getByTestId("lifecycle-failure"));
    const failure = screen.getByTestId("lifecycle-failure");
    expect(failure.dataset.mode).toBe("managed");
    expect(failure.textContent).toContain("Managed OpenCode failed to start");
    expect(failure.textContent).toContain("Inspect startup error");

    fireEvent.click(screen.getByTestId("lifecycle-retry"));
    await poll(() =>
      expect(mock.callsTo("/api/opencode/lifecycle/retry", "POST")).toHaveLength(1),
    );
    await poll(() => screen.getByTestId("lifecycle-retry-notice"));
    expect(screen.getByTestId("lifecycle-retry-notice").textContent).toContain(
      "Retry accepted",
    );
  });

  test("managed-failed without retryable: no Retry button", async () => {
    mockFetch(
      baseRoutes(
        worldWith(
          makeLifecycle({
            mode: "managed",
            status: "failed",
            baseUrl: undefined,
            ready: {
              health: false,
              configProviders: false,
              providers: false,
              agents: false,
              omo: true,
              omoExpected: true,
              rest: false,
              sse: false,
            },
            error: {
              code: "preferred-port-collision",
              message: "loopback port 4096 is occupied",
              action: "Free loopback port 4096.",
              retryable: false,
              at: NOW,
            },
          }),
        ),
      ),
    );
    renderWithRuntime(
      <MemoryRouter initialEntries={["/system"]}>
        <SystemPage />
      </MemoryRouter>,
    );
    await poll(() => screen.getByRole("button", { name: "OpenCode Backend" }));
    fireEvent.click(screen.getByRole("button", { name: "OpenCode Backend" }));
    await poll(() => screen.getByTestId("lifecycle-failure"));
    expect(screen.queryByTestId("lifecycle-retry")).toBeNull();
  });

  test("attached-failed: copy 'Unable to reach configured OpenCode backend', no managed implication", async () => {
    mockFetch(
      baseRoutes(
        worldWith(
          makeLifecycle({
            mode: "attach",
            ownership: "external",
            status: "failed",
            baseUrl: ATTACHED_BASE,
            ready: {
              health: false,
              configProviders: false,
              providers: false,
              agents: false,
              omo: true,
              omoExpected: true,
              rest: false,
              sse: false,
            },
            error: {
              code: "attach-unavailable",
              message: "ECONNREFUSED",
              action: "Restore external OpenCode, then Retry.",
              retryable: true,
              at: NOW,
            },
          }),
        ),
      ),
    );
    renderWithRuntime(
      <MemoryRouter initialEntries={["/system"]}>
        <SystemPage />
      </MemoryRouter>,
    );
    await poll(() => screen.getByRole("button", { name: "OpenCode Backend" }));
    fireEvent.click(screen.getByRole("button", { name: "OpenCode Backend" }));

    await poll(() => screen.getByTestId("lifecycle-failure"));
    const failure = screen.getByTestId("lifecycle-failure");
    expect(failure.dataset.mode).toBe("attach");
    expect(failure.textContent).toContain(
      "Unable to reach configured OpenCode backend",
    );
    // Never imply a managed fallback.
    expect(failure.textContent).not.toMatch(/Managed/);
    // Retry still available because error.retryable is true.
    expect(screen.queryByTestId("lifecycle-retry")).not.toBeNull();
  });

  test("restarting state: panel renders restart counter + restarting note", async () => {
    mockFetch(
      baseRoutes(
        worldWith(
          makeLifecycle({
            status: "restarting",
            baseUrl: "http://127.0.0.1:4096",
            ready: {
              health: false,
              configProviders: false,
              providers: false,
              agents: false,
              omo: true,
              omoExpected: true,
              rest: false,
              sse: false,
            },
            restart: {
              attempt: 3,
              maxAttempts: 5,
              nextRetryAt: "2026-08-13T00:00:30.000Z",
            },
          }),
        ),
      ),
    );
    renderWithRuntime(
      <MemoryRouter initialEntries={["/system"]}>
        <SystemPage />
      </MemoryRouter>,
    );
    await poll(() => screen.getByRole("button", { name: "OpenCode Backend" }));
    fireEvent.click(screen.getByRole("button", { name: "OpenCode Backend" }));

    await poll(() => screen.getByTestId("lifecycle-restart"));
    expect(screen.getByTestId("lifecycle-restart").textContent).toContain("3/5");
    expect(screen.getByTestId("lifecycle-restarting-note").textContent).toContain(
      "Restarting rather than stale",
    );
  });

  test("authConfigured marker surfaces when Basic auth environment is set", async () => {
    mockFetch(
      baseRoutes(
        worldWith(makeLifecycle({ authConfigured: true })),
      ),
    );
    renderWithRuntime(
      <MemoryRouter initialEntries={["/system"]}>
        <SystemPage />
      </MemoryRouter>,
    );
    await poll(() => screen.getByRole("button", { name: "OpenCode Backend" }));
    fireEvent.click(screen.getByRole("button", { name: "OpenCode Backend" }));
    await poll(() => screen.getByTestId("lifecycle-auth"));
    expect(screen.getByTestId("lifecycle-auth").textContent).toBe(
      "Basic auth configured",
    );
  });

  test("preserves configured model selectors across backend generation change", async () => {
    // Configured (desired/effective) agent model must survive a backend
    // generation change: the live inventory refetches, the configured
    // value stays rendered.
    const row = makeRow({
      name: "explorer",
      kind: "builtin",
      effectiveModel: "anthropic/claude-sonnet-4-5",
      modelSourceStage: "preset",
    });
    const world = worldWith(makeLifecycle({ generation: 1 }), {
      agents: makeAgentsDto([row]),
      providers: makeProvidersDto([
        makeProvider("anthropic", "Anthropic", true, [
          makeModel("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
        ]),
      ]),
      models: makeModelInventoryDto(),
    });
    const mock = mockFetch(baseRoutes(world));
    render(
      <RuntimeProvider>
        <ModelAvailabilityProvider>
          <MemoryRouter>
            <AgentsPage />
          </MemoryRouter>
        </ModelAvailabilityProvider>
      </RuntimeProvider>,
    );
    await poll(() => screen.getByText("explorer"));
    await poll(() => screen.getByText("Claude Sonnet 4.5"));
    const runtimeFetchesBefore = mock.callsTo("/api/runtime").length;
    const inventoryFetchesBefore = mock.callsTo("/api/models").length;

    // Backend generation bump (e.g. managed restart onto the same port).
    await act(async () => {
      dispatchCpEvent("opencode.backend.generation", {
        type: "opencode.backend.generation",
        generation: 2,
        baseUrl: "http://127.0.0.1:4096",
        ownership: "control-plane",
        at: NOW,
      });
    });

    // Live runtime + inventory were refetched via existing mechanisms.
    await poll(() =>
      expect(mock.callsTo("/api/runtime").length).toBeGreaterThan(
        runtimeFetchesBefore,
      ),
    );
    await poll(() =>
      expect(mock.callsTo("/api/models").length).toBeGreaterThan(
        inventoryFetchesBefore,
      ),
    );

    // The configured model is still rendered — nothing was cleared while
    // the new backend was coming up.
    screen.getByText("Claude Sonnet 4.5");
    expect(findRowByName("explorer").textContent).toContain("Anthropic");
  });

  test("initial lifecycle fetch happens on mount", async () => {
    const mock = mockFetch(baseRoutes(worldWith(makeLifecycle())));
    renderWithRuntime(
      <MemoryRouter initialEntries={["/system"]}>
        <SystemPage />
      </MemoryRouter>,
    );
    await poll(() => screen.getByRole("button", { name: "OpenCode Backend" }));
    fireEvent.click(screen.getByRole("button", { name: "OpenCode Backend" }));
    await poll(() => screen.getByTestId("lifecycle-base-url-value"));
    expect(mock.callsTo("/api/opencode/lifecycle").length).toBeGreaterThanOrEqual(1);
  });
});

describe("lifecycle — Doctor page backend card", () => {
  test("shows mode + ownership + status pills and Retry for retryable failure", async () => {
    const lifecycle = makeLifecycle({
      mode: "managed",
      ownership: "control-plane",
      status: "failed",
      baseUrl: undefined,
      ready: {
        health: false,
        configProviders: false,
        providers: false,
        agents: false,
        omo: true,
        omoExpected: true,
        rest: false,
        sse: false,
      },
      error: {
        code: "managed-restart-exhausted",
        message: "startup failed",
        action: "Inspect startup error, then Retry.",
        retryable: true,
        at: NOW,
      },
    });
    const mock = mockFetch(
      baseRoutes(
        worldWith(lifecycle, {
          retryLifecycle: () => ({
            ok: true,
            lifecycle: { ...lifecycle, status: "restarting", error: undefined },
          }),
        }),
      ),
    );
    renderWithRuntime(
      <MemoryRouter initialEntries={["/doctor"]}>
        <DoctorPage />
      </MemoryRouter>,
    );
    await poll(() => screen.getByTestId("doctor-backend-mode"));
    expect(screen.getByTestId("doctor-backend-status").textContent).toBe("failed");
    await poll(() => screen.getByTestId("doctor-failure"));
    expect(screen.getByTestId("doctor-failure").dataset.mode).toBe("managed");
    fireEvent.click(screen.getByTestId("doctor-retry"));
    await poll(() =>
      expect(mock.callsTo("/api/opencode/lifecycle/retry", "POST")).toHaveLength(1),
    );
  });

  test("restarting backend shows restarting note instead of stale", async () => {
    mockFetch(
      baseRoutes(
        worldWith(
          makeLifecycle({
            status: "restarting",
            baseUrl: "http://127.0.0.1:4096",
            ready: {
              health: false,
              configProviders: false,
              providers: false,
              agents: false,
              omo: true,
              omoExpected: true,
              rest: false,
              sse: false,
            },
            restart: { attempt: 1, maxAttempts: 5 },
          }),
        ),
      ),
    );
    renderWithRuntime(
      <MemoryRouter initialEntries={["/doctor"]}>
        <DoctorPage />
      </MemoryRouter>,
    );
    await poll(() => screen.getByTestId("doctor-restarting-note"));
    expect(screen.getByTestId("doctor-restarting-note").textContent).toContain(
      "Restarting rather than stale",
    );
  });

  test("attached-failed: warns (not errors) and labels correctly", async () => {
    mockFetch(
      baseRoutes(
        worldWith(
          makeLifecycle({
            mode: "attach",
            ownership: "external",
            status: "failed",
            baseUrl: ATTACHED_BASE,
            error: {
              code: "attach-unavailable",
              message: "ECONNREFUSED",
              action: "Restore external OpenCode, then Retry.",
              retryable: true,
              at: NOW,
            },
          }),
        ),
      ),
    );
    renderWithRuntime(
      <MemoryRouter initialEntries={["/doctor"]}>
        <DoctorPage />
      </MemoryRouter>,
    );
    await poll(() => screen.getByTestId("doctor-failure"));
    const failure = screen.getByTestId("doctor-failure");
    expect(failure.dataset.mode).toBe("attach");
    expect(failure.textContent).toContain(
      "Unable to reach configured OpenCode backend",
    );
  });
});

describe("lifecycle — SSE event handling", () => {
  test("opencode.lifecycle.updated drives restarting → live transition", async () => {
    const initial = makeLifecycle();
    mockFetch(baseRoutes(worldWith(initial)));
    renderWithRuntime(
      <MemoryRouter initialEntries={["/system"]}>
        <SystemPage />
      </MemoryRouter>,
    );
    await poll(() => screen.getByRole("button", { name: "OpenCode Backend" }));
    fireEvent.click(screen.getByRole("button", { name: "OpenCode Backend" }));
    await poll(() => screen.getByTestId("lifecycle-base-url-value"));
    expect(screen.getByTestId("lifecycle-base-url-value").textContent).toBe(
      "http://127.0.0.1:4096",
    );
    expect(screen.getByTestId("lifecycle-panel").getAttribute("data-status")).toBe(
      "connected",
    );

    // Backend drops into an intentional restart.
    await act(async () => {
      dispatchCpEvent("opencode.lifecycle.updated", {
        type: "opencode.lifecycle.updated",
        lifecycle: makeLifecycle({
          status: "restarting",
          restart: { attempt: 1, maxAttempts: 5 },
        }),
        at: NOW,
      });
    });
    await poll(() =>
      expect(
        screen.getByTestId("lifecycle-panel").getAttribute("data-status"),
      ).toBe("restarting"),
    );
    screen.getByTestId("lifecycle-restarting-note");

    // Restart completes — back to live without any manual refresh.
    await act(async () => {
      dispatchCpEvent("opencode.lifecycle.updated", {
        type: "opencode.lifecycle.updated",
        lifecycle: makeLifecycle({ generation: 2 }),
        at: NOW,
      });
    });
    await poll(() => {
      expect(
        screen.getByTestId("lifecycle-panel").getAttribute("data-status"),
      ).toBe("connected");
      expect(
        screen.queryByTestId("lifecycle-restarting-note"),
      ).toBeNull();
    });
  });

  test("opencode.backend.generation refetches live runtime + inventory", async () => {
    const initial = makeLifecycle({ generation: 1 });
    const world = worldWith(initial, {
      models: makeModelInventoryDto(),
    });
    const mock = mockFetch(baseRoutes(world));
    render(
      <RuntimeProvider>
        <ModelAvailabilityProvider>
          <MemoryRouter initialEntries={["/system"]}>
            <SystemPage />
          </MemoryRouter>
        </ModelAvailabilityProvider>
      </RuntimeProvider>,
    );
    await poll(() => screen.getByRole("button", { name: "OpenCode Backend" }));
    fireEvent.click(screen.getByRole("button", { name: "OpenCode Backend" }));
    await poll(() => screen.getByTestId("lifecycle-base-url-value"));

    const runtimeBefore = mock.callsTo("/api/runtime").length;
    const modelsBefore = mock.callsTo("/api/models").length;

    await act(async () => {
      dispatchCpEvent("opencode.backend.generation", {
        type: "opencode.backend.generation",
        generation: 2,
        baseUrl: "http://127.0.0.1:4096",
        ownership: "control-plane",
        at: NOW,
      });
    });

    await poll(() =>
      expect(mock.callsTo("/api/runtime").length).toBeGreaterThan(runtimeBefore),
    );
    await poll(() =>
      expect(mock.callsTo("/api/models").length).toBeGreaterThan(modelsBefore),
    );
  });
});
