/**
  * Policy workspaces — Presets, Capabilities, Prompts, CapabilityEditModal.
  *
  * Visual migration must preserve CRUD / matrix / composition behavior and
  * move CapabilityEditModal onto FocusTrapDialog. Semantic assertions only.
  */
import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { AgentPromptDetail, CapabilityInventory } from "@omo/shared";
import { CapabilitiesPage } from "../src/pages/CapabilitiesPage";
import { CapabilityEditModal } from "../src/pages/CapabilityEditModal";
import { PresetsPage } from "../src/pages/PresetsPage";
import { PromptsPage } from "../src/pages/PromptsPage";
import {
  EDIT_STATE,
  makeSimulation,
  mockFetch,
  poll,
  type Route,
} from "./helpers";

function renderPage(ui: React.ReactElement, path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>,
  );
}

function presetInventory() {
  return {
    configuredPreset: "openai",
    envPreset: undefined,
    effectiveStartupPreset: "openai",
    runtimePreset: {
      known: false,
      mechanism: "Runtime preset is not exposed by OMO.",
    },
    warnings: ["Runtime preset state is unknown."],
    presets: [
      {
        name: "openai",
        sourceScopes: ["user"],
        configuredActive: true,
        runtimeStateKnown: false,
        agentCount: 1,
        maskedFieldCount: 1,
        warnings: ["Explorer model is masked by a root override."],
        agents: [
          {
            agent: "explorer",
            presetValue: {
              model: "openai/gpt-x",
              variant: "default",
              temperature: 0.2,
              skills: ["*"],
              mcps: ["context7"],
            },
            maskedFields: ["model"],
            runtimeSwitchWouldChange: ["model"],
          },
        ],
        raw: { explorer: { model: "openai/gpt-x" } },
      },
      {
        name: "local",
        sourceScopes: ["user"],
        configuredActive: false,
        runtimeStateKnown: false,
        agentCount: 1,
        maskedFieldCount: 0,
        warnings: [],
        agents: [
          {
            agent: "explorer",
            presetValue: { model: "ollama/qwen" },
            maskedFields: [],
            runtimeSwitchWouldChange: [],
          },
        ],
        raw: { explorer: { model: "ollama/qwen" } },
      },
    ],
  };
}

function capabilityInventory(): CapabilityInventory {
  return {
    tools: ["read", "edit", "bash"],
    skills: [
      { name: "codemap", installed: true, globallyDisabled: false },
      { name: "simplify", installed: true, globallyDisabled: true },
    ],
    mcps: [
      { name: "context7", runtimeStatus: "connected", globallyDisabled: false },
    ],
    agents: [
      {
        agent: "explorer",
        temperature: 0.1,
        permissionSummary: "read-only",
        permission: { read: "allow", edit: "deny", bash: "ask" },
        tools: {
          read: "allow",
          edit: "deny",
          bash: "ask",
          task: "unset",
        },
        skills: {
          mode: "selective",
          configured: ["codemap"],
          allowed: ["codemap"],
          denied: ["simplify"],
          configuredUnknown: [],
          globallyDisabled: ["simplify"],
        },
        mcps: {
          mode: "selective",
          configured: ["context7"],
          allowed: ["context7"],
          denied: [],
          configuredUnknown: [],
          globallyDisabled: [],
        },
      },
      {
        agent: "oracle",
        permissionSummary: "ask",
        tools: { read: "allow", edit: "ask" },
        skills: {
          mode: "all",
          allowed: ["codemap"],
          denied: [],
          configuredUnknown: [],
          globallyDisabled: ["simplify"],
        },
        mcps: {
          mode: "none",
          allowed: [],
          denied: ["context7"],
          configuredUnknown: [],
          globallyDisabled: [],
        },
      },
    ],
    globals: {
      disabled_skills: ["simplify"],
      disabled_mcps: [],
      disabled_tools: [],
      disabled_agents: ["observer"],
    },
  };
}

function promptDetail(agent: string): AgentPromptDetail {
  return {
    agent,
    compositionRule:
      "base = inline ?? replacement ?? builtin; append concatenated",
    effectiveChars: 24,
    effectiveLines: 2,
    effectiveText: "builtin explorer\n\nappend line",
    warnings: ["Inline prompt is shadowed by a replacement file."],
    orphanFiles: [],
    base: {
      id: "builtin",
      kind: "builtin",
      agent,
      exists: true,
      active: true,
    },
    append: {
      id: "user-append",
      kind: "append",
      scope: "user",
      agent,
      path: "~/.config/opencode/oh-my-opencode-slim/explorer_append.md",
      exists: true,
      active: true,
      chars: 11,
      hash: "append-hash",
    },
    sources: [
      {
        id: "builtin",
        kind: "builtin",
        agent,
        exists: true,
        active: false,
        reason: "shadowed by replacement",
      },
      {
        id: "inline",
        kind: "inline",
        agent,
        exists: true,
        active: false,
        reason: "replacement file has precedence",
      },
      {
        id: "user-replace",
        kind: "replacement",
        scope: "user",
        agent,
        path: "~/.config/opencode/oh-my-opencode-slim/explorer.md",
        exists: true,
        active: true,
        chars: 16,
        hash: "replace-hash",
      },
      {
        id: "user-append",
        kind: "append",
        scope: "user",
        agent,
        path: "~/.config/opencode/oh-my-opencode-slim/explorer_append.md",
        exists: true,
        active: true,
        chars: 11,
        hash: "append-hash",
      },
    ],
  };
}

function policyRoutes(extra: Route[] = []): Route[] {
  return [
    { prefix: "/api/presets/compare", body: { rows: [] } },
    {
      prefix: "/api/presets/openai/switch-impact",
      body: {
        impact: [
          {
            agent: "explorer",
            field: "model",
            before: "root/ex",
            after: "openai/gpt-x",
          },
        ],
      },
    },
    { prefix: "/api/presets/local/switch-impact", body: { impact: [] } },
    { prefix: "/api/presets", body: presetInventory() },
    { prefix: "/api/capabilities", body: capabilityInventory() },
    { prefix: "/api/prompts/explorer", body: promptDetail("explorer") },
    { prefix: "/api/prompts/oracle", body: promptDetail("oracle") },
    { prefix: "/api/prompts", body: { agents: ["explorer", "oracle"] } },
    { prefix: "/api/config/edit-state", body: EDIT_STATE },
    {
      prefix: "/api/omo/effective",
      body: {
        agents: {
          explorer: {
            temperature: 0.2,
            skills: ["codemap"],
            mcps: ["context7"],
            permission: { read: "allow" },
          },
        },
      },
    },
    {
      prefix: "/api/config/simulate",
      method: "POST",
      respond: (_url, _init, call) =>
        makeSimulation({
          mutation: call.body as never,
          textDiff: "capability preview",
          effectiveChanged: [
            { path: "agents.explorer.temperature", before: 0.1, after: 0.2 },
          ],
        }),
    },
    {
      prefix: "/api/config/apply",
      method: "POST",
      body: { ok: true, errors: [] },
    },
    {
      prefix: "/api/config/prompt/simulate",
      method: "POST",
      body: { ok: true, textDiff: "+ append line", errors: [] },
    },
    {
      prefix: "/api/config/prompt/apply",
      method: "POST",
      body: { ok: true, errors: [] },
    },
    {
      prefix: "/api/agents/explorer/prompts",
      body: {
        sources: [
          {
            path: "~/.config/opencode/oh-my-opencode-slim/explorer_append.md",
            content: "append line",
          },
        ],
      },
    },
    ...extra,
  ];
}

describe("Presets workspace", () => {
  test("search / list / detail preserve configured + runtime-unknown + CRUD", async () => {
    const fetchMock = mockFetch(policyRoutes());
    renderPage(<PresetsPage />, "/presets");
    await poll(() => screen.getByRole("heading", { name: "openai" }));

    expect(screen.getByText(/configured openai/)).toBeTruthy();
    expect(screen.getAllByText("runtime unknown").length).toBeGreaterThan(0);
    expect(screen.getByText("Runtime preset is not exposed by OMO.")).toBeTruthy();
    expect(screen.getByText("Explorer model is masked by a root override.")).toBeTruthy();
    expect(screen.getByText("openai/gpt-x")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Masked fields" })).toBeTruthy();
    expect(document.querySelector(".pill.warn")?.textContent).toBe("model");
    expect(screen.getByRole("columnheader", { name: "Load-effective" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Runtime-switch" })).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("Search presets…"), {
      target: { value: "loc" },
    });
    expect(screen.getByRole("button", { name: /local/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /openai/ })).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("Search presets…"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: /local/ }));
    await poll(() => screen.getByRole("heading", { name: "local" }));
    expect(screen.getByText("ollama/qwen")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("new preset name"), {
      target: { value: "scratch" },
    });
    fireEvent.click(screen.getByRole("button", { name: "+ Empty" }));
    await poll(() =>
      expect(
        fetchMock.callsTo("/api/config/preset/create", "POST").length,
      ).toBe(1),
    );
    const create = fetchMock.callsTo("/api/config/preset/create", "POST")[0]!;
    expect(create.body).toMatchObject({
      scope: "user",
      name: "scratch",
      initial: { mode: "empty" },
    });

    fireEvent.change(screen.getByPlaceholderText("new preset name"), {
      target: { value: "cloned" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Clone" }));
    await poll(() =>
      expect(
        fetchMock.callsTo("/api/config/preset/create", "POST").length,
      ).toBe(2),
    );
    expect(
      fetchMock.callsTo("/api/config/preset/create", "POST")[1]?.body,
    ).toMatchObject({
      name: "cloned",
      initial: { mode: "clone", sourcePreset: "local" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Set configured" }));
    await poll(() =>
      expect(
        fetchMock.callsTo("/api/config/preset/set-configured", "POST").length,
      ).toBe(1),
    );

    document.querySelectorAll("[style]").forEach((el) => {
      expect((el as HTMLElement).getAttribute("style")).toBeNull();
    });
  });

  test("compare mode toggle requests the selected semantics", async () => {
    const fetchMock = mockFetch(policyRoutes());
    renderPage(<PresetsPage />, "/presets");
    await poll(() => screen.getByRole("heading", { name: "openai" }));

    fireEvent.change(screen.getByLabelText("Compare against"), {
      target: { value: "local" },
    });
    await poll(() =>
      expect(
        fetchMock.callsTo("/api/presets/compare").some((c) =>
          c.url.includes("mode=desired"),
        ),
      ).toBe(true),
    );

    fireEvent.click(screen.getByRole("tab", { name: "Runtime-switch" }));
    await poll(() =>
      expect(
        fetchMock.callsTo("/api/presets/compare").some((c) =>
          c.url.includes("mode=runtime-switch"),
        ),
      ).toBe(true),
    );
  });
});

describe("Capabilities workspace", () => {
  test("dense matrix preserves permission / skill / MCP / global-disable logic", async () => {
    mockFetch(policyRoutes());
    renderPage(<CapabilitiesPage />, "/capabilities");
    await poll(() => screen.getByText("Tool matrix"));

    expect(screen.getByText("disabled_skills")).toBeTruthy();
    expect(screen.getAllByText("simplify").length).toBeGreaterThan(0);
    expect(screen.getByText("observer")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Allow" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Ask" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Deny" }).length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole("button", { name: "Ask" })[0]!);
    await poll(() => screen.getByText("explorer → bash"));
    expect(screen.getByText(/Permission summary: read-only/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("explorer → bash")).toBeNull();

    const skillAllow = screen.getAllByRole("button", { name: "Allow" }).find(
      (btn) => btn.closest("tr")?.textContent?.includes("codemap"),
    );
    expect(skillAllow).toBeTruthy();
    fireEvent.click(skillAllow!);
    await poll(() => screen.getByText("explorer → skill codemap"));
    expect(screen.getByText(/Agent access: allowed/)).toBeTruthy();
    expect(screen.getByText(/Not globally disabled/)).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("Filter agents…"), {
      target: { value: "ora" },
    });
    expect(screen.getAllByText("oracle").length).toBeGreaterThan(0);
    expect(screen.queryByText("explorer")).toBeNull();

    document.querySelectorAll("[style]").forEach((el) => {
      expect((el as HTMLElement).getAttribute("style")).toBeNull();
    });
  });
});

describe("CapabilityEditModal", () => {
  test("uses FocusTrapDialog and previews without applying", async () => {
    const fetchMock = mockFetch(policyRoutes());
    const onClose = () => undefined;
    const onApplied = () => {
      throw new Error("apply must not run in this test");
    };
    render(
      <CapabilityEditModal
        agent="explorer"
        onClose={onClose}
        onApplied={onApplied}
      />,
    );
    await poll(() => screen.getByRole("dialog"));

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("capability-edit-title");
    expect(document.querySelector(".ftd-backdrop.ftd-modal")).toBeTruthy();
    expect(document.querySelector(".modal-backdrop")).toBeNull();
    expect(document.activeElement).toBe(
      document.getElementById("capability-edit-title"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await poll(() => screen.getByText("capability preview"));
    expect(fetchMock.callsTo("/api/config/simulate", "POST").length).toBe(1);
    expect(fetchMock.callsTo("/api/config/apply", "POST").length).toBe(0);
    expect(
      (screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled,
    ).toBe(false);

    fireEvent.keyDown(dialog, { key: "Escape" });
  });
});

describe("Prompts workspace", () => {
  test("source / effective / diff preserve composition and preview/apply", async () => {
    const fetchMock = mockFetch(policyRoutes());
    renderPage(<PromptsPage />, "/prompts");
    await poll(() => screen.getByRole("heading", { name: "explorer" }));

    expect(
      screen.getByText(
        "base = inline ?? replacement ?? builtin; append concatenated",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Built-in OMO prompt")).toBeTruthy();
    expect(screen.getAllByText("active").length).toBeGreaterThan(0);
    expect(screen.getAllByText("shadowed").length).toBeGreaterThan(0);
    expect(
      screen.getByText("Inline prompt is shadowed by a replacement file."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Effective" }));
    expect(screen.getByText(/builtin explorer/)).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Source" }));
    const appendRow = screen
      .getAllByRole("row")
      .find((row) => row.textContent?.includes("explorer_append.md"));
    expect(appendRow).toBeTruthy();
    fireEvent.click(
      appendRow!.querySelector("button") as HTMLButtonElement,
    );
    await poll(() => screen.getByPlaceholderText("# prompt content"));
    fireEvent.change(screen.getByPlaceholderText("# prompt content"), {
      target: { value: "new append" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await poll(() => screen.getByRole("tab", { name: "Diff" }));
    expect(fetchMock.callsTo("/api/config/prompt/simulate", "POST").length).toBe(
      1,
    );
    expect(screen.getAllByText("+ append line").length).toBeGreaterThan(0);
    expect(fetchMock.callsTo("/api/config/prompt/apply", "POST").length).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await poll(() =>
      expect(
        fetchMock.callsTo("/api/config/prompt/apply", "POST").length,
      ).toBe(1),
    );
    expect(
      fetchMock.callsTo("/api/config/prompt/apply", "POST")[0]?.body,
    ).toMatchObject({
      kind: "prompt-file",
      agent: "explorer",
      fileType: "append",
      operation: "set",
      content: "new append",
    });

    document.querySelectorAll("[style]").forEach((el) => {
      expect((el as HTMLElement).getAttribute("style")).toBeNull();
    });
  });
});
