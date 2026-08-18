/**
 * End-to-end agent edit workflow through the real component path:
 * AgentsPage row → AgentEditModal → catalog pick → preview (simulate) →
 * Apply Assignment, with a fully mocked fetch route table.
 *
 * Covers the Change-Model/editor interaction semantics:
 *  - Current Assignment header (aligned compression + divergence layers)
 *  - provider/model selection seeding from the row's effective model
 *  - preview leads with the semantic summary; technical diff behind its tab
 *  - apply gated on a successful preview; one-entry array payload
 *  - intended accessible action labels ('Preview changes' / 'Apply Assignment')
 *  - 409 write conflict → Re-preview → apply succeeds
 *
 * Uses `poll(...)` instead of RTL findBy/waitFor — see helpers.tsx.
 */
import { describe, expect, test } from "bun:test";
import { fireEvent, screen, within } from "@testing-library/react";
import type { AgentsDto, AgentRow, ConfigMutation } from "@omo/shared";
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

/** The apply action's intended (and current) accessible label. */
function applyButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: "Apply Assignment",
  }) as HTMLButtonElement;
}

/** The preview card element ("Preview — model" SimCard). */
function previewCard(): HTMLElement {
  return screen.getByText("Preview — model").closest(
    ".ame-preview-card",
  ) as HTMLElement;
}

/** The Current Assignment section (scoped by its heading). */
function currentAssignmentSection(): HTMLElement {
  return screen.getByRole("heading", { name: "Current Assignment" }).closest(
    "section",
  ) as HTMLElement;
}

function agentModelBody(call: { body: unknown }) {
  return call.body as Extract<ConfigMutation, { kind: "agent-model" }>;
}

/** Open the Change Model modal for one row via its row action. */
async function openEditor(name: string) {
  await poll(() => screen.getByText(name));
  fireEvent.click(
    within(findRowByName(name)).getByRole("button", { name: "Change Model" }),
  );
  await poll(() =>
    screen.getByRole("heading", { name: new RegExp(`Change model — ${name}`) }),
  );
}

describe("agent edit workflow (Change Model editor)", () => {
  test("row Change Model → catalog pick → semantic preview → Apply Assignment (one-entry array)", async () => {
    const rows = [
      makeRow({
        name: "explorer",
        kind: "builtin",
        effectiveModel: "anthropic/claude-sonnet-4-5",
        modelSourceStage: "preset",
      }),
      makeRow({ name: "scribe", kind: "custom", effectiveModel: "openai/gpt-5-mini" }),
      makeRow({
        name: "build",
        kind: "native",
        liveModel: "anthropic/claude-sonnet-4-5",
      }),
    ];
    const providers = makeProvidersDto([
      makeProvider("anthropic", "Anthropic", true, [
        makeModel("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
        makeModel("anthropic", "claude-opus-4-1", "Claude Opus 4.1"),
      ]),
      makeProvider("openai", "OpenAI", true, [
        makeModel("openai", "gpt-5", "GPT-5"),
        makeModel("openai", "gpt-5-mini", "GPT-5 mini"),
      ]),
    ]);

    const mock = mockFetch(
      baseRoutes({
        agents: makeAgentsDto(rows),
        providers,
        provenanceModel: { found: false },
        provenanceVariant: { found: false },
      }),
    );

    renderWithRouter(<AgentsPage />);

    // Rows render; open the modal via the explorer row's Change Model action.
    await openEditor("explorer");

    // Current Assignment header is present for the edited agent (this row is
    // layer-aligned, so it compresses to a single Model line).
    const current = currentAssignmentSection();
    within(current).getByText("Model");
    within(current).getByText(/Assigned, effective, and live agree/);

    // Sync on the live catalog: catalog options only exist once provenance
    // AND providers have loaded and the chain was seeded in catalog mode.
    await poll(() => {
      screen.getByRole("option", { name: /Anthropic \(anthropic\) — 2 models/ });
      screen.getByRole("option", { name: /OpenAI \(openai\) — 2 models/ });
    });

    const [providerSelect, modelSelect] = screen.getAllByRole(
      "combobox",
    ) as HTMLSelectElement[];
    // Chain was seeded from the row's effective model.
    expect(providerSelect.value).toBe("anthropic");
    expect(modelSelect.value).toBe("claude-sonnet-4-5");

    // Apply Assignment is gated on a successful preview.
    expect(applyButton().disabled).toBe(true);

    // Pick another provider, then one of its advertised models.
    fireEvent.change(providerSelect, { target: { value: "openai" } });
    fireEvent.change(modelSelect, { target: { value: "gpt-5" } });

    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));

    // ── Preview leads with the SEMANTIC summary, before any technical diff ──
    let card!: HTMLElement;
    await poll(() => {
      card = previewCard();
      within(card).getByText("anthropic/claude-sonnet-4-5 → openai/gpt-5");
    });
    // Human-summary rows: the Model change line, where it is Stored in, the
    // fallback count, and the schema verdict.
    within(card).getByText("Stored in");
    within(card).getByText('the user preset "openai"');
    within(card).getByText("0 (unchanged)");
    within(card).getByText("not reported");
    // The semantic summary block precedes the technical detail tabs.
    const tabs = within(card).getByRole("tablist", { name: "Preview details" });
    within(tabs).getByRole("tab", { name: "Summary" });
    within(tabs).getByRole("tab", { name: "Effective impact" });
    within(tabs).getByRole("tab", { name: "Source diff" });
    within(tabs).getByRole("tab", { name: "Validation" });
    const summaryDl = card.querySelector(".ame-summary-dl")!;
    expect(
      summaryDl.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The raw source diff is NOT exposed before its own tab.
    expect(card.querySelector("pre.diff-patch")).toBeNull();
    fireEvent.click(within(tabs).getByRole("tab", { name: "Source diff" }));
    await poll(() => {
      const pre = card.querySelector("pre.diff-patch");
      expect(pre?.textContent ?? "").toContain("openai/gpt-5");
      expect(pre?.textContent ?? "").toContain("anthropic/claude-sonnet-4-5");
    });

    await poll(() => expect(applyButton().disabled).toBe(false));
    fireEvent.click(applyButton());

    // Apply succeeds → modal closes.
    await poll(() =>
      expect(
        screen.queryByRole("heading", { name: /Change model/ }),
      ).toBeNull(),
    );

    // Exactly one apply call carrying the expected agent-model mutation.
    const applyCalls = mock.callsTo("/api/config/apply", "POST");
    expect(applyCalls).toHaveLength(1);
    const body = agentModelBody(applyCalls[0]!);
    expect(body.kind).toBe("agent-model");
    expect(body.agent).toBe("explorer");
    // model is ALWAYS an array — even for a 1-entry chain — so a variant
    // entry never becomes a bare {id,variant} standalone object (which the
    // installed OMO-Slim schema rejects outside a fallback array). The
    // server canonicalizes 1 entry → "model": "<id>" + sibling "variant".
    expect(body.model).toEqual(["openai/gpt-5"]);
    expect(body.scope).toBe("user");
    expect(body.destination).toEqual({ kind: "preset", preset: "openai" });

    // Variant checkbox untouched → no agent-variant mutation anywhere.
    const mutationCalls = [
      ...mock.callsTo("/api/config/simulate", "POST"),
      ...applyCalls,
    ];
    expect(mutationCalls.length).toBeGreaterThanOrEqual(2);
    for (const c of mutationCalls) {
      expect((c.body as ConfigMutation).kind).toBe("agent-model");
    }

    // onApplied triggered a runtime refresh (initial load + post-apply).
    await poll(() =>
      expect(mock.callsTo("/api/runtime").length).toBeGreaterThanOrEqual(2),
    );
  });

  test("intended accessible action labels: 'Preview changes' and 'Apply Assignment'", async () => {
    const row = makeRow({
      name: "explorer",
      kind: "builtin",
      effectiveModel: "anthropic/claude-sonnet-4-5",
    });
    mockFetch(
      baseRoutes({
        agents: makeAgentsDto([row]),
        providers: makeProvidersDto([
          makeProvider("anthropic", "Anthropic", true, [
            makeModel("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
          ]),
        ]),
        provenanceModel: { found: false },
        provenanceVariant: { found: false },
      }),
    );
    renderWithRouter(<AgentsPage />);
    await openEditor("explorer");

    // Final intended labels — accessible names, not just visible text.
    screen.getByRole("button", { name: "Preview changes" });
    screen.getByRole("button", { name: "Apply Assignment" });
  });

  test("Current Assignment: divergence expands layers + pills; aligned compresses", async () => {
    // explorer: preset assigns Sonnet, a root override wins (GPT-5), and the
    // live session drifted further (GPT-5 mini) → both divergence signals.
    // scribe: preset assignment, effective, and live all agree.
    const rows: AgentRow[] = [
      makeRow({
        name: "explorer",
        kind: "builtin",
        effectiveModel: "openai/gpt-5",
        liveModel: "openai/gpt-5-mini",
        modelSourceStage: "root-agent",
      }),
      makeRow({
        name: "scribe",
        kind: "builtin",
        effectiveModel: "anthropic/claude-sonnet-4-5",
        liveModel: "anthropic/claude-sonnet-4-5",
        modelSourceStage: "preset",
      }),
    ];
    const desired: AgentsDto["desired"] = {
      sources: [],
      agents: {
        explorer: {
          name: "explorer",
          kind: "builtin",
          model: "openai/gpt-5",
          sourceIds: [],
        },
      },
      presets: {
        openai: {
          explorer: {
            name: "explorer",
            kind: "builtin",
            model: "anthropic/claude-sonnet-4-5",
            sourceIds: [],
          },
          scribe: {
            name: "scribe",
            kind: "builtin",
            model: "anthropic/claude-sonnet-4-5",
            sourceIds: [],
          },
        },
      },
      globals: {},
      raw: {},
    };
    const dto: AgentsDto = { ...makeAgentsDto(rows), desired };
    const providers = makeProvidersDto([
      makeProvider("anthropic", "Anthropic", true, [
        makeModel("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
      ]),
      makeProvider("openai", "OpenAI", true, [
        makeModel("openai", "gpt-5", "GPT-5"),
        makeModel("openai", "gpt-5-mini", "GPT-5 mini"),
      ]),
    ]);

    mockFetch(
      baseRoutes({
        agents: dto,
        providers,
        provenanceModel: { found: false },
        provenanceVariant: { found: false },
      }),
    );

    renderWithRouter(<AgentsPage />);

    // ── Divergent agent: all three layers, both pills, plain-language copy ──
    await openEditor("explorer");
    let section = currentAssignmentSection();
    // Layers render human names first, canonical ids second.
    within(section).getByText("Configured");
    within(section).getByText("Effective");
    within(section).getByText("Live");
    within(section).getByText("Claude Sonnet 4.5");
    within(section).getByText("GPT-5");
    within(section).getByText("GPT-5 mini");
    // Distinct, separately-labeled divergence signals.
    within(section).getByText("Assignment overridden");
    within(section).getByText("Runtime drift");
    within(section).getByText(
      "Config override and runtime drift are both present.",
    );
    within(section).getByText(/different configuration source currently wins/);
    // The layers summary lists all three raw values.
    const meta = within(section).getByLabelText("Assignment layers");
    within(meta).getByText("anthropic/claude-sonnet-4-5");
    within(meta).getByText("openai/gpt-5");
    within(meta).getByText("openai/gpt-5-mini");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await poll(() =>
      expect(
        screen.queryByRole("heading", { name: /Change model/ }),
      ).toBeNull(),
    );

    // ── Aligned agent: compressed to a single Model line, no pills ──
    await openEditor("scribe");
    section = currentAssignmentSection();
    within(section).getByText("Model");
    within(section).getByText(/Assigned, effective, and live agree/);
    within(section).getByText("Claude Sonnet 4.5");
    // The compressed line names the controlling source path.
    within(section).getByText("presets.openai.scribe.model");
    expect(within(section).queryByText("Configured")).toBeNull();
    expect(within(section).queryByText("Assignment overridden")).toBeNull();
    expect(within(section).queryByText("Runtime drift")).toBeNull();
  });

  test("apply conflict (409) keeps the modal open and offers Re-preview", async () => {
    const row = makeRow({
      name: "explorer",
      kind: "builtin",
      effectiveModel: "anthropic/claude-sonnet-4-5",
    });
    const providers = makeProvidersDto([
      makeProvider("anthropic", "Anthropic", true, [
        makeModel("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
      ]),
    ]);

    let applyCount = 0;
    const mock = mockFetch(
      baseRoutes({
        agents: makeAgentsDto([row]),
        providers,
        provenanceModel: { found: false },
        provenanceVariant: { found: false },
        apply: () => {
          applyCount++;
          return applyCount === 1
            ? {
                ok: false,
                conflict: {
                  path: "~/.config/omo/omo.json",
                  expectedHash: "user-hash-1",
                  actualHash: "user-hash-9",
                  message: "Target file changed since preview.",
                },
                errors: [],
              }
            : { ok: true, revisionId: "rev-after-repreview", errors: [] };
        },
      }),
    );

    renderWithRouter(<AgentsPage />);
    await openEditor("explorer");
    await poll(() =>
      screen.getByRole("option", { name: /Anthropic \(anthropic\) — 1 models/ }),
    );

    // Preview once…
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    await poll(() => screen.getByText("Preview — model"));
    await poll(() => expect(applyButton().disabled).toBe(false));

    // …apply → the target file changed underneath → conflict, modal stays open.
    fireEvent.click(applyButton());
    await poll(() => screen.getByText("Target file changed since preview."));
    screen.getByRole("heading", { name: /Change model — explorer/ });
    const repreview = screen.getByRole("button", {
      name: "Re-preview",
    }) as HTMLButtonElement;
    expect(repreview.disabled).toBe(false);

    // Re-preview re-runs the simulation against the fresh file state…
    const simsBefore = mock.callsTo("/api/config/simulate", "POST").length;
    fireEvent.click(repreview);
    await poll(() =>
      expect(
        mock.callsTo("/api/config/simulate", "POST").length,
      ).toBeGreaterThan(simsBefore),
    );
    await poll(() => screen.getByText("Preview — model"));

    // …and the retried apply succeeds → modal closes.
    await poll(() => expect(applyButton().disabled).toBe(false));
    fireEvent.click(applyButton());
    await poll(() =>
      expect(
        screen.queryByRole("heading", { name: /Change model/ }),
      ).toBeNull(),
    );

    const applies = mock.callsTo("/api/config/apply", "POST");
    expect(applies).toHaveLength(2);
    expect(agentModelBody(applies[0]!).model).toEqual([
      "anthropic/claude-sonnet-4-5",
    ]);
    expect(agentModelBody(applies[1]!).model).toEqual([
      "anthropic/claude-sonnet-4-5",
    ]);
  });
});
