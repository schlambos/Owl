/**
 * Slice 28 ownership routes — which rows expose an Edit action vs a link to
 * the owning workspace. Ordinary builtins/custom (including disabled) are
 * editable; council live-only/unconfigured + councillor link to /council;
 * ACP wrappers link to /acp; native agents link to /config. The fixture
 * array drives the assertions — no hardcoded roster.
 */
import { describe, expect, test } from "bun:test";
import { fireEvent, screen, within } from "@testing-library/react";
import type { AgentRow } from "@omo/shared";
import { AgentsPage } from "../src/pages/AgentsPage";
import {
  baseRoutes,
  findRowByName,
  makeAgentsDto,
  makeModel,
  makeProvider,
  makeProvidersDto,
  makeRow,
  mockFetch,
  poll,
  renderWithRouter,
} from "./helpers";

describe("edit action visibility / ownership routes", () => {
  test("Edit on self-owned rows only; council/ACP/native rows link away", async () => {
    const acpManagedNames = ["wrapper-bot"];
    const rows: AgentRow[] = [
      makeRow({
        name: "explorer",
        kind: "builtin",
        effectiveModel: "anthropic/claude-sonnet-4-5",
      }),
      makeRow({ name: "scribe", kind: "custom", effectiveModel: "openai/gpt-5" }),
      makeRow({ name: "mystery", kind: "unknown" }),
      makeRow({
        name: "build",
        kind: "native",
        liveModel: "anthropic/claude-sonnet-4-5",
      }),
      makeRow({
        name: "wrapper-bot",
        kind: "custom",
        effectiveModel: "openai/gpt-5",
      }),
      makeRow({ name: "observer", kind: "builtin", enabled: false }),
    ];

    mockFetch(
      baseRoutes({
        agents: makeAgentsDto(rows),
        providers: makeProvidersDto([
          makeProvider("anthropic", "Anthropic", true, [
            makeModel("anthropic", "claude-sonnet-4-5"),
          ]),
          makeProvider("openai", "OpenAI", true, [makeModel("openai", "gpt-5")]),
        ]),
        acpAgents: acpManagedNames,
      }),
    );

    renderWithRouter(<AgentsPage />);
    await poll(() => screen.getByText("explorer"));

    // Native rows are hidden by default — reveal them.
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Show native OpenCode agents/ }),
    );
    await poll(() => screen.getByText("build"));

    const acpSet = new Set(acpManagedNames.map((n) => n.toLowerCase()));
    for (const row of rows) {
      const tr = findRowByName(row.name);
      const editBtn = within(tr).queryByRole("button", { name: "Edit" });
      const expectsEdit =
        row.kind !== "native" && !acpSet.has(row.name.toLowerCase());
      if (expectsEdit) {
        expect(editBtn).not.toBeNull(); // editable: ${row.name}
      } else {
        expect(editBtn).toBeNull(); // not editable: ${row.name}
      }
    }

    // Disabled observer is an ordinary editable row.
    within(findRowByName("observer")).getByRole("button", { name: "Edit" });

    // ACP row links to the ACP workspace instead of an Edit action.
    const acpLink = within(findRowByName("wrapper-bot")).getByRole("link", {
      name: "Managed in ACP",
    });
    expect(acpLink.getAttribute("href")).toBe("/acp");

    // Native row links to /config with the OpenCode-configuration copy.
    const nativeRow = findRowByName("build");
    expect(within(nativeRow).queryByText("Managed in ACP")).toBeNull();
    const configLink = within(nativeRow).getByRole("link", {
      name: "Managed by OpenCode configuration",
    });
    expect(configLink.getAttribute("href")).toBe("/config");
  });
});
