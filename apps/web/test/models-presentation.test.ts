import { describe, expect, test } from "bun:test";
import {
  catalogNameFor,
  dedupeModels,
  effectiveModels,
  isProblemProbe,
  modelDisplayName,
  modelKey,
  probeDisabledReason,
  referencedModels,
  usageLabel,
} from "../src/models/presentation";
import { makeModelAvailability, makeUsageRef } from "./helpers";

describe("models presentation helpers", () => {
  test("modelDisplayName never invents a pretty name", () => {
    expect(modelDisplayName("claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
    expect(modelDisplayName("claude-sonnet-4-5", "claude-sonnet-4-5")).toBe(
      "claude-sonnet-4-5",
    );
    expect(modelDisplayName("claude-sonnet-4-5", "Claude Sonnet 4.5")).toBe(
      "Claude Sonnet 4.5",
    );
  });

  test("catalogNameFor only returns a name that differs from the id", () => {
    const names = new Map([
      [modelKey("anthropic", "claude-sonnet-4-5"), "Claude Sonnet 4.5"],
      [modelKey("openai", "gpt-5"), "gpt-5"],
    ]);
    expect(catalogNameFor("anthropic", "claude-sonnet-4-5", names)).toBe(
      "Claude Sonnet 4.5",
    );
    expect(catalogNameFor("openai", "gpt-5", names)).toBeUndefined();
    expect(catalogNameFor("ollama", "llama", names)).toBeUndefined();
  });

  test("effectiveModels keeps only active usage; referenced keeps any usage", () => {
    const models = [
      makeModelAvailability({
        providerId: "anthropic",
        modelId: "claude-sonnet-4-5",
        usage: [makeUsageRef({ kind: "agent-primary", active: true })],
      }),
      makeModelAvailability({
        providerId: "openai",
        modelId: "gpt-5",
        usage: [
          makeUsageRef({
            kind: "council-member",
            ownerId: "duo",
            active: false,
          }),
        ],
      }),
      makeModelAvailability({
        providerId: "ollama",
        modelId: "llama",
        usage: [],
      }),
    ];
    expect(
      referencedModels(models).map((m) => ({
        providerId: m.providerId,
        modelId: m.modelId,
      })),
    ).toEqual([
      { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
      { providerId: "openai", modelId: "gpt-5" },
    ]);
    expect(
      effectiveModels(models).map((m) => ({
        providerId: m.providerId,
        modelId: m.modelId,
      })),
    ).toEqual([{ providerId: "anthropic", modelId: "claude-sonnet-4-5" }]);
  });

  test("dedupeModels collapses provider/model pairs", () => {
    expect(
      dedupeModels([
        { providerId: "a", modelId: "m" },
        { providerId: "a", modelId: "m" },
        { providerId: "b", modelId: "m" },
      ]),
    ).toEqual([
      { providerId: "a", modelId: "m" },
      { providerId: "b", modelId: "m" },
    ]);
  });

  test("probeDisabledReason and problem states stay explicit-only", () => {
    expect(probeDisabledReason(true, true)).toBe("OpenCode is disconnected");
    expect(probeDisabledReason(false, false)).toBe(
      "Provider is not connected in OpenCode",
    );
    expect(probeDisabledReason(false, true)).toBeUndefined();
    expect(isProblemProbe("healthy")).toBe(false);
    expect(isProblemProbe("never")).toBe(false);
    expect(isProblemProbe("running")).toBe(false);
    expect(isProblemProbe("unauthorized")).toBe(true);
    expect(isProblemProbe("timeout")).toBe(true);
  });

  test("usageLabel keeps compact owner roles", () => {
    expect(
      usageLabel(
        makeUsageRef({ kind: "agent-primary", label: "Explorer" }),
      ),
    ).toBe("Explorer");
    expect(
      usageLabel(
        makeUsageRef({ kind: "agent-fallback", label: "Oracle" }),
      ),
    ).toBe("Fallback · Oracle");
  });
});
