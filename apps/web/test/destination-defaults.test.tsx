/**
 * Slice 14.5 §31 — write-destination defaults derived from the provenance
 * winner of agents.<name>.model, plus the masked-write warning path.
 */
import { describe, expect, test } from "bun:test";
import { fireEvent, screen } from "@testing-library/react";
import type { ConfigMutation, ConfigScope, ResolveStage } from "@omo/shared";
import { AgentEditModal } from "../src/pages/AgentEditModal";
import {
  baseRoutes,
  makeAgentsDto,
  makeModel,
  makeProvider,
  makeProvidersDto,
  makeRow,
  makeSimulation,
  mockFetch,
  poll,
  renderWithRuntime,
  resolvedModel,
} from "./helpers";

const CASES: Array<{
  label: string;
  stage: ResolveStage;
  scope: ConfigScope;
  radioIndex: number;
  sourcePath: string;
}> = [
  {
    label: "preset winner (user scope) preselects USER preset radio",
    stage: "preset",
    scope: "user",
    radioIndex: 0,
    sourcePath: "presets.openai.explorer.model",
  },
  {
    label: "root-agent winner (user scope) preselects USER root-agent radio",
    stage: "root-agent",
    scope: "user",
    radioIndex: 1,
    sourcePath: "agents.explorer.model",
  },
  {
    label: "root-agent winner (project scope) preselects PROJECT root-agent radio",
    stage: "root-agent",
    scope: "project",
    radioIndex: 3,
    sourcePath: "agents.explorer.model",
  },
  {
    label: "preset winner (project scope) preselects PROJECT preset radio",
    stage: "preset",
    scope: "project",
    radioIndex: 2,
    sourcePath: "presets.openai.explorer.model",
  },
];

function renderModalWithWinner(opts: {
  stage: ResolveStage;
  scope: ConfigScope;
  sourcePath: string;
  simulate?: (call: { body: unknown }) => ReturnType<typeof makeSimulation>;
}) {
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
  const mock = mockFetch(
    baseRoutes({
      agents: makeAgentsDto([row]),
      providers,
      provenanceModel: {
        found: true,
        property: resolvedModel({
          agent: "explorer",
          value: "anthropic/claude-sonnet-4-5",
          stage: opts.stage,
          scope: opts.scope,
          sourcePath: opts.sourcePath,
        }),
      },
      provenanceVariant: { found: false },
      simulate: opts.simulate,
    }),
  );
  const utils = renderWithRuntime(
    <AgentEditModal
      agent="explorer"
      row={row}
      initialModel={row.effectiveModel}
      onClose={() => {}}
      onApplied={() => {}}
    />,
  );
  return { mock, ...utils };
}

describe("destination defaults from provenance (slice §31)", () => {
  for (const c of CASES) {
    test(c.label, async () => {
      renderModalWithWinner({
        stage: c.stage,
        scope: c.scope,
        sourcePath: c.sourcePath,
      });

      // Wait until provenance is loaded and the destination-default effect
      // landed (the winner line appears, then the effect applies one commit
      // later — poll until the expected radio is checked).
      // Radio order: [user preset, user root-agent, project preset, project root-agent].
      await poll(() => {
        screen.getByText(/current controlling source:/);
        const radios = screen.getAllByRole("radio") as HTMLInputElement[];
        expect(radios).toHaveLength(4);
        expect(radios[c.radioIndex]!.checked).toBe(true);
      });
      const radios = screen.getAllByRole("radio") as HTMLInputElement[];
      expect(radios).toHaveLength(4);
      radios.forEach((r, i) => {
        expect(r.checked).toBe(i === c.radioIndex);
      });

      // The preselected radio is described with user-visible text.
      const selectedLabel = radios[c.radioIndex]!.closest("label");
      // Radio 0 = user preset, 1 = user root override, 2 = project preset,
      // 3 = project override.
      const expectedLabelRe =
        c.radioIndex === 0
          ? /Preset/
          : c.radioIndex === 1
            ? /Root override/
            : c.radioIndex === 2
              ? /Project preset/
              : /Project override/;
      expect(selectedLabel?.textContent ?? "").toMatch(expectedLabelRe);
    });
  }

  test("masked write warns before apply and after masked preview", async () => {
    renderModalWithWinner({
      stage: "root-agent",
      scope: "user",
      sourcePath: "agents.explorer.model",
      simulate: (call) =>
        makeSimulation({
          mutation: call.body as ConfigMutation,
          masked: true,
          effectiveAfter: "anthropic/claude-sonnet-4-5", // unchanged — masked
        }),
    });

    // Default destination = the winner's (user root-agent); settle on it.
    let radios: HTMLInputElement[] = [];
    await poll(() => {
      screen.getByText(/current controlling source:/);
      radios = screen.getAllByRole("radio") as HTMLInputElement[];
      expect(radios[1]!.checked).toBe(true);
    });

    // Pick the USER preset destination → masked warning appears BEFORE apply.
    fireEvent.click(radios[0]!);
    await poll(() => screen.getByText(/will not change/));

    // Preview with a masked simulation → SimCard masked block as well.
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    await poll(() => {
      screen.getByText("Preview — model");
      screen.getByText(/higher-precedence source/);
    });

    // The pre-apply destination warning is still present.
    screen.getByText(/will not change/);
  });

  test("destination differing from the winner shows the exact pre-preview copy", async () => {
    renderModalWithWinner({
      stage: "preset",
      scope: "user",
      sourcePath: "presets.openai.explorer.model",
    });

    // Default = winner destination → no advisory.
    let radios: HTMLInputElement[] = [];
    await poll(() => {
      screen.getByText(/current controlling source:/);
      radios = screen.getAllByRole("radio") as HTMLInputElement[];
      expect(radios[0]!.checked).toBe(true);
    });
    expect(
      screen.queryByText(
        /Preview to confirm whether this source changes the Effective model\./,
      ),
    ).toBeNull();

    // Switch to the user root override → advisory appears with exact copy.
    fireEvent.click(radios[1]!);
    await poll(() =>
      screen.getByText(
        "Preview to confirm whether this source changes the Effective model.",
      ),
    );

    // Back to the winner destination → advisory disappears.
    fireEvent.click(radios[0]!);
    await poll(() =>
      expect(
        screen.queryByText(
          /Preview to confirm whether this source changes the Effective model\./,
        ),
      ).toBeNull(),
    );
  });
});
