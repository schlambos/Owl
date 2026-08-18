/**
 * Slice 14.5 §30 — model catalog behavior inside AgentEditModal:
 * connected/disconnected grouping, advertised models, filter narrowing,
 * unadvertised current model kept selectable, manual escape hatch.
 */
import { describe, expect, test } from "bun:test";
import { fireEvent, screen } from "@testing-library/react";
import { AgentEditModal } from "../src/pages/AgentEditModal";
import {
  baseRoutes,
  makeAgentsDto,
  makeModel,
  makeProvider,
  makeProvidersDto,
  makeRow,
  mockFetch,
  poll,
  renderWithRuntime,
} from "./helpers";

describe("model catalog in edit modal (slice §30)", () => {
  test("grouping, filtering, unadvertised current model, manual entry", async () => {
    // Current model is NOT advertised by any provider.
    const row = makeRow({
      name: "explorer",
      kind: "builtin",
      effectiveModel: "anthropic/claude-legacy",
    });
    const providers = makeProvidersDto([
      makeProvider("anthropic", "Anthropic", true, [
        makeModel("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
        makeModel("anthropic", "claude-opus-4-1", "Claude Opus 4.1"),
      ]),
      makeProvider("openai", "OpenAI", false, [makeModel("openai", "gpt-5", "GPT-5")]),
    ]);

    mockFetch(
      baseRoutes({
        agents: makeAgentsDto([row]),
        providers,
        provenanceModel: { found: false },
        provenanceVariant: { found: false },
      }),
    );

    renderWithRuntime(
      <AgentEditModal
        agent="explorer"
        row={row}
        initialModel={row.effectiveModel}
        onClose={() => {}}
        onApplied={() => {}}
      />,
    );

    // Sync on the live catalog: this option only exists once provenance and
    // providers loaded and the chain was seeded in catalog mode.
    await poll(() => screen.getByRole("option", { name: /Anthropic \(anthropic\)/ }));

    // Connected provider is labeled connected; disconnected one too.
    const connectedGroup = screen.getByRole("group", { name: "Connected" });
    expect(connectedGroup.textContent).toContain("Anthropic (anthropic)");
    const disconnectedGroup = screen.getByRole("group", {
      name: "Disconnected / configured",
    });
    expect(disconnectedGroup.textContent).toContain("OpenAI (openai)");

    const [providerSelect, modelSelect] = screen.getAllByRole(
      "combobox",
    ) as HTMLSelectElement[];
    expect(providerSelect.value).toBe("anthropic");

    // Advertised models of the selected provider appear in the model select.
    screen.getByRole("option", { name: /claude-sonnet-4-5/ });
    screen.getByRole("option", { name: /claude-opus-4-1/ });

    // The unadvertised current model remains present and selected.
    expect(modelSelect.value).toBe("claude-legacy");
    screen.getByRole("option", {
      name: /claude-legacy \(current — not currently advertised\)/,
    });

    // Typing in the filter narrows providers and models.
    const filter = screen.getByPlaceholderText("Filter providers / models…");
    fireEvent.change(filter, { target: { value: "opus" } });
    expect(screen.queryByRole("option", { name: /OpenAI \(openai\)/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /claude-sonnet-4-5/ })).toBeNull();
    screen.getByRole("option", { name: /claude-opus-4-1/ });
    fireEvent.change(filter, { target: { value: "" } });

    // Manual escape hatch: switch entry to manual mode.
    fireEvent.click(screen.getByRole("button", { name: "manual" }));
    const manualInput = screen.getByPlaceholderText(
      "provider/model",
    ) as HTMLInputElement;
    screen.getByText("not in live catalog");

    // Entering an unlisted provider/model is warned but not blocked.
    fireEvent.change(manualInput, {
      target: { value: "openrouter/llama-3.3-70b" },
    });
    expect(manualInput.value).toBe("openrouter/llama-3.3-70b");
    screen.getByText("not in live catalog"); // warn pill persists
    expect(
      (screen.getByRole("button", { name: "Preview changes" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});
