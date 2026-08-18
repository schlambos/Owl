/**
 * Phase 1 foundation: grouped top nav, theme persistence, connection
 * popover, and Reconcile. Semantic assertions only — no CSS-class checks.
 */
import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ConnectionBar } from "../src/components/ConnectionBar";
import { AppShell } from "../src/components/layout/AppShell";
import { ThemeProvider } from "../src/components/layout/ThemeProvider";
import {
  THEME_STORAGE_KEY,
  applyTheme,
  persistTheme,
  readStoredTheme,
} from "../src/components/layout/theme";
import {
  NAV_GROUPS,
  groupForPath,
  isChildActive,
  isGroupActive,
  pathnameOf,
} from "../src/components/layout/nav";
import {
  baseRoutes,
  makeAgentsDto,
  makeLifecycle,
  makeProvidersDto,
  mockFetch,
  poll,
  renderWithRuntime,
} from "./helpers";

const ROUTES = [
  "/",
  "/agents",
  "/models",
  "/providers",
  "/sessions",
  "/doctor",
  "/presets",
  "/capabilities",
  "/prompts",
  "/config",
  "/system",
] as const;

// Doc 34: /council and /acp are standalone routes (dependency links only),
// not Team segments and not members of any primary group.
const STANDALONE_ROUTES = ["/council", "/acp"] as const;

function installMatchMedia(matchesMax799: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const matches =
        query.includes("max-width: 799px") || query.includes("max-width:799px")
          ? matchesMax799
          : false;
      return {
        matches,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent() {
          return false;
        },
      };
    },
  });
}

function renderChrome(entry: string) {
  mockFetch(
    baseRoutes({
      agents: makeAgentsDto([]),
      providers: makeProvidersDto([]),
      lifecycle: makeLifecycle(),
    }),
  );
  return renderWithRuntime(
    <ThemeProvider>
      <MemoryRouter initialEntries={[entry]}>
        <AppShell>
          <div>workspace</div>
        </AppShell>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

function currentIn(name: string | RegExp, container?: HTMLElement) {
  const root = container ?? document.body;
  const links = within(root instanceof HTMLElement ? root : document.body)
    .getAllByRole("link")
    .filter((el) => el.getAttribute("aria-current") === "page");
  const found = links.find((el) =>
    typeof name === "string"
      ? el.textContent === name
      : name.test(el.textContent ?? ""),
  );
  if (!found) {
    throw new Error(
      `No current link matching ${String(name)}. Current: ${links
        .map((l) => l.textContent)
        .join(", ")}`,
    );
  }
  return found;
}

describe("nav grouping", () => {
  test("every existing path maps to exactly one group", () => {
    for (const path of ROUTES) {
      expect(groupForPath(path)?.id).toBeDefined();
    }
    for (const path of STANDALONE_ROUTES) {
      expect(groupForPath(path)).toBeUndefined();
    }
    expect(pathnameOf("/config?tab=raw&sourceId=user-omo")).toBe("/config");
    expect(groupForPath("/config?tab=raw")?.id).toBe("policy");
    expect(isChildActive("/config", "/config?tab=raw")).toBe(true);
    expect(isGroupActive(NAV_GROUPS[1]!, "/models")).toBe(true);
    expect(isGroupActive(NAV_GROUPS[0]!, "/models")).toBe(false);
  });

  test("wide nav keeps labeled five-pill primary + secondary children", async () => {
    installMatchMedia(false);
    renderChrome("/agents?filter=overrides");

    await poll(() => screen.getByRole("navigation", { name: "Primary" }));
    const primary = screen.getByRole("navigation", { name: "Primary" });
    expect(
      within(primary)
        .getAllByRole("link")
        .map((el) => el.textContent),
    ).toEqual(["Overview", "Team", "Runtime", "Policy", "System"]);

    currentIn("Team", primary);
    expect(within(primary).getByRole("link", { name: "Team" }).getAttribute("href")).toBe(
      "/agents",
    );
    expect(within(primary).getByRole("link", { name: "Overview" }).getAttribute("href")).toBe(
      "/",
    );

    const secondary = screen.getByRole("navigation", { name: "Team pages" });
    expect(
      within(secondary)
        .getAllByRole("link")
        .map((el) => el.textContent),
    ).toEqual(["Agents", "Models", "Providers"]);
    currentIn("Agents", secondary);
    expect(within(secondary).getByRole("link", { name: "Agents" }).getAttribute("href")).toBe(
      "/agents",
    );
    expect(within(secondary).getByRole("link", { name: "Models" }).getAttribute("href")).toBe(
      "/models",
    );
  });

  test("group active follows child routes and keeps query strings on the page", async () => {
    installMatchMedia(false);
    renderChrome("/config?tab=raw&sourceId=user-omo");
    await poll(() => screen.getByRole("navigation", { name: "Primary" }));

    currentIn("Policy", screen.getByRole("navigation", { name: "Primary" }));
    const policy = screen.getByRole("navigation", { name: "Policy pages" });
    currentIn("Config", policy);
    expect(within(policy).getByRole("link", { name: "Config" }).getAttribute("href")).toBe(
      "/config",
    );
    expect(within(policy).getByRole("link", { name: "Presets" }).getAttribute("href")).toBe(
      "/presets",
    );
  });

  test("narrow viewport uses a Navigate disclosure instead of five pills", async () => {
    installMatchMedia(true);
    renderChrome("/sessions");
    await poll(() => screen.getByLabelText("Navigate, Runtime"));
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
    fireEvent.click(screen.getByLabelText("Navigate, Runtime"));
    await poll(() => screen.getByRole("navigation", { name: "Primary" }));
    currentIn("Runtime", screen.getByRole("navigation", { name: "Primary" }));
    currentIn(
      "Sessions",
      screen.getByRole("navigation", { name: "Runtime pages" }),
    );
  });
});

describe("theme persistence", () => {
  test("defaults to light and persists dark across apply/read", () => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    expect(readStoredTheme()).toBe("light");
    persistTheme("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(readStoredTheme()).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    applyTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  test("header toggle writes omo-control.theme.v1 and updates the document", async () => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    applyTheme("light");
    installMatchMedia(false);
    renderChrome("/");
    await poll(() => screen.getByRole("button", { name: "Use dark theme" }));
    fireEvent.click(screen.getByRole("button", { name: "Use dark theme" }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: "Use light theme" }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});

describe("connection popover", () => {
  test("compact trigger opens the existing lifecycle surface and Reconcile posts", async () => {
    const mock = mockFetch(
      baseRoutes({
        agents: makeAgentsDto([]),
        providers: makeProvidersDto([]),
        lifecycle: makeLifecycle(),
      }),
    );
    renderWithRuntime(
      <MemoryRouter>
        <ConnectionBar />
      </MemoryRouter>,
    );
    await poll(() => screen.getByTestId("connection-trigger"));
    const trigger = screen.getByTestId("connection-trigger");
    expect(trigger.textContent).toContain("OpenCode · Connected");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    trigger.focus();
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const dialog = screen.getByRole("dialog", { name: "OpenCode connection" });
    expect(dialog.hasAttribute("hidden")).toBe(false);
    expect(within(dialog).getByTestId("lifecycle-status-pill").textContent).toBe(
      "Connected",
    );
    expect(within(dialog).getByTestId("lifecycle-mode-pill").textContent).toBe(
      "Managed",
    );
    expect(within(dialog).getByTestId("lifecycle-ownership-pill").textContent).toBe(
      "Control Plane",
    );
    expect(within(dialog).getByTestId("lifecycle-base-url").textContent).toBe(
      "http://127.0.0.1:4096",
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Reconcile" }));
    await poll(() => {
      expect(mock.callsTo("/api/runtime/reconcile", "POST").length).toBe(1);
    });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  test("restarting and failed compact labels stay aligned with lifecycle", async () => {
    mockFetch(
      baseRoutes({
        agents: makeAgentsDto([]),
        providers: makeProvidersDto([]),
        lifecycle: makeLifecycle({
          status: "restarting",
          restart: { attempt: 1, maxAttempts: 5 },
        }),
      }),
    );
    const first = renderWithRuntime(
      <MemoryRouter>
        <ConnectionBar />
      </MemoryRouter>,
    );
    await poll(() => screen.getByText("OpenCode · Restarting"));
    first.unmount();

    mockFetch(
      baseRoutes({
        agents: makeAgentsDto([]),
        providers: makeProvidersDto([]),
        lifecycle: makeLifecycle({ status: "failed" }),
      }),
    );
    renderWithRuntime(
      <MemoryRouter>
        <ConnectionBar />
      </MemoryRouter>,
    );
    await poll(() => screen.getByText("OpenCode · Failed"));
  });
});
