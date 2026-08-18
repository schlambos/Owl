import { describe, expect, test } from "bun:test";
import {
  bestEffortCompanion,
  companionPolicy,
  companionPolicyForRepair,
  jsonChanges,
  provenanceChanges,
  truncateUtf8,
} from "./candidate-diff";
import type { ResolvedProperty } from "@omo/shared";
import { MAX_DIFF_VALUE_PREVIEW_BYTES } from "@omo/shared";

function leaf(
  path: string,
  value: unknown,
  sourceId: string,
  stage: string,
): ResolvedProperty {
  return {
    path,
    value,
    winner: {
      value,
      sourceId,
      sourceLabel: sourceId,
      sourcePath: path,
      stage: stage as never,
      order: 1,
    },
    overridden: [],
    reason: "test",
  };
}

describe("candidate-diff fixtures", () => {
  test("direct leaf change", () => {
    const changes = jsonChanges({ a: 1 }, { a: 2 });
    expect(changes).toEqual([
      { path: "a", op: "replace", before: 1, after: 2 },
    ]);
  });

  test("override removal", () => {
    const changes = jsonChanges({ interview: { port: 8 } }, {});
    expect(changes.some((c) => c.op === "remove" && c.path === "interview.port")).toBe(
      true,
    );
  });

  test("project override appears as replace at leaf", () => {
    const changes = jsonChanges(
      { interview: { maxQuestions: 2 } },
      { interview: { maxQuestions: 7 } },
    );
    expect(changes).toEqual([
      { path: "interview.maxQuestions", op: "replace", before: 2, after: 7 },
    ]);
  });

  test("array replacement is a single leaf replace", () => {
    const changes = jsonChanges(
      { agents: { explorer: { skills: ["a"] } } },
      { agents: { explorer: { skills: ["b"] } } },
    );
    expect(changes).toEqual([
      {
        path: "agents.explorer.skills",
        op: "replace",
        before: ["a"],
        after: ["b"],
      },
    ]);
  });

  test("preset / council / custom-agent / interview leaves", () => {
    const before = {
      presets: { p1: { explorer: { model: "a/b" } } },
      council: { presets: { def: { alpha: { model: "a/b" } } } },
      agents: { researcher: { model: "old/x" } },
      interview: { maxQuestions: 2 },
    };
    const after = {
      presets: { p1: { explorer: { model: "c/d" } } },
      council: { presets: { def: { alpha: { model: "c/d" } } } },
      agents: { researcher: { model: "new/x" } },
      interview: { maxQuestions: 5 },
    };
    const paths = jsonChanges(before, after).map((c) => c.path).sort();
    expect(paths).toEqual([
      "agents.researcher.model",
      "council.presets.def.alpha.model",
      "interview.maxQuestions",
      "presets.p1.explorer.model",
    ]);
  });

  test("provenance change records winner stage/source", () => {
    const changes = provenanceChanges(
      { "interview.maxQuestions": leaf("interview.maxQuestions", 2, "builtin", "builtin") },
      { "interview.maxQuestions": leaf("interview.maxQuestions", 7, "user:x", "user-config") },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.after?.stage).toBe("user-config");
    expect(changes[0]?.after?.value).toBe(7);
  });

  test("Companion structural equality vs nested/delete/mixed", () => {
    expect(
      companionPolicy(
        { companion: { enabled: false } },
        { companion: { enabled: false } },
      ).ok,
    ).toBe(true);
    expect(
      companionPolicy({ companion: { enabled: false } }, { companion: {} }).ok,
    ).toBe(false);
    expect(companionPolicy({ companion: { enabled: false } }, {}).ok).toBe(false);
    expect(
      companionPolicy(
        { companion: { enabled: false } },
        { compactSidebar: true, companion: { enabled: true } },
      ).ok,
    ).toBe(false);
    expect(
      companionPolicy(
        { companion: { enabled: false }, compactSidebar: true },
        { companion: { enabled: false }, compactSidebar: false },
      ).ok,
    ).toBe(true);
    expect(
      companionPolicy(
        { companion: { enabled: false, position: "bottom-right" } },
        { companion: { position: "bottom-right", enabled: false } },
      ).ok,
    ).toBe(true);
  });

  test("best-effort Companion from unparseable current", () => {
    expect(
      bestEffortCompanion(`{ "companion": { "enabled": false }, broken`),
    ).toEqual({ present: true, value: { enabled: false } });
    expect(bestEffortCompanion(`{ broken`)).toBe("unproven");
    expect(
      companionPolicyForRepair(`{ broken`, { compactSidebar: true }).ok,
    ).toBe(false);
    expect(
      companionPolicyForRepair(
        `{ "companion": { "enabled": false }, broken`,
        { compactSidebar: true, companion: { enabled: false } },
      ).ok,
    ).toBe(true);
  });

  test("UTF-8 truncation never splits a multibyte code point", () => {
    const text = "é".repeat(20);
    const cut = truncateUtf8(text, 5);
    expect(cut.truncated).toBe(true);
    expect(Buffer.byteLength(cut.text, "utf-8")).toBeLessThanOrEqual(5);
    expect(cut.text).not.toContain("\uFFFD");
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(cut.text))).not.toThrow();
    const preview = jsonChanges(
      { note: "🙂".repeat(MAX_DIFF_VALUE_PREVIEW_BYTES) },
      { note: "🙂".repeat(MAX_DIFF_VALUE_PREVIEW_BYTES + 8) },
    );
    expect(preview[0]?.after === undefined || typeof preview[0]?.after === "string").toBe(true);
  });
});
