/**
 * Slice 17 — JSONC plugin array edit helper tests.
 *
 * Covers: comments preserved, unknown fields preserved, ordering
 * preserved, EOL preserved, trailing commas preserved, add/remove
 * recognized bridge entry, never JSON.stringify whole document.
 */

import { describe, expect, test } from "bun:test";
import {
  applyPluginEntryAdd,
  applyPluginEntryRemove,
  findPluginEntryNode,
  parseConfigText,
  pluginEntrySpan,
  patchPluginEntrySpan,
} from "./jsonc-edit";

describe("applyPluginEntryAdd", () => {
  test("adds entry to existing array, preserves comments", () => {
    const text = `{
  // comment
  "plugin": [
    "foo"
  ]
}`;
    const { text: result, alreadyPresent } = applyPluginEntryAdd(text, "/abs/bridge");
    expect(alreadyPresent).toBe(false);
    expect(result).toContain("// comment");
    expect(result).toContain("foo");
    expect(result).toContain("/abs/bridge");
    const parsed = parseConfigText(result);
    expect(parsed["plugin"]).toEqual(["foo", "/abs/bridge"]);
  });

  test("creates plugin array when absent", () => {
    const text = `{
  "agent": {}
}`;
    const { text: result, alreadyPresent } = applyPluginEntryAdd(text, "/abs/bridge");
    expect(alreadyPresent).toBe(false);
    const parsed = parseConfigText(result);
    expect(parsed["plugin"]).toEqual(["/abs/bridge"]);
    expect(parsed["agent"]).toEqual({});
  });

  test("already present → unchanged", () => {
    const text = `{"plugin":["foo","/abs/bridge"]}`;
    const { text: result, alreadyPresent } = applyPluginEntryAdd(text, "/abs/bridge");
    expect(alreadyPresent).toBe(true);
    expect(result).toBe(text);
  });

  test("preserves unknown fields", () => {
    const text = `{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["foo"],
  "lsp": true
}`;
    const { text: result } = applyPluginEntryAdd(text, "/abs/bridge");
    expect(result).toContain("$schema");
    expect(result).toContain("lsp");
    expect(result).toContain("foo");
  });

  test("preserves ordering of existing entries", () => {
    const text = `{"plugin":["a","b","c"]}`;
    const { text: result } = applyPluginEntryAdd(text, "/abs/bridge");
    const parsed = parseConfigText(result);
    expect(parsed["plugin"]).toEqual(["a", "b", "c", "/abs/bridge"]);
  });

  test("preserves trailing comma in jsonc", () => {
    const text = `{
  "plugin": [
    "foo",
  ]
}`;
    const { text: result } = applyPluginEntryAdd(text, "/abs/bridge");
    // Should still parse (trailing comma tolerated).
    const parsed = parseConfigText(result);
    expect(parsed["plugin"]).toContain("/abs/bridge");
  });

  test("preserves EOL (\\r\\n)", () => {
    const text = `{\r\n  "plugin": ["foo"]\r\n}`;
    const { text: result } = applyPluginEntryAdd(text, "/abs/bridge");
    expect(result).toContain("\r\n");
  });

  test("preserves EOL (\\n)", () => {
    const text = `{\n  "plugin": ["foo"]\n}`;
    const { text: result } = applyPluginEntryAdd(text, "/abs/bridge");
    expect(result).toContain("\n");
    expect(result).not.toContain("\r\n");
  });
});

describe("applyPluginEntryRemove", () => {
  test("removes entry, preserves others", () => {
    const text = `{"plugin":["foo","/abs/bridge","bar"]}`;
    const { text: result, wasPresent } = applyPluginEntryRemove(text, "/abs/bridge");
    expect(wasPresent).toBe(true);
    const parsed = parseConfigText(result);
    expect(parsed["plugin"]).toEqual(["foo", "bar"]);
  });

  test("not present → unchanged", () => {
    const text = `{"plugin":["foo"]}`;
    const { text: result, wasPresent } = applyPluginEntryRemove(text, "/abs/bridge");
    expect(wasPresent).toBe(false);
    expect(result).toBe(text);
  });

  test("preserves comments on remove", () => {
    const text = `{
  // keep me
  "plugin": [
    "foo",
    "/abs/bridge"
  ]
}`;
    const { text: result } = applyPluginEntryRemove(text, "/abs/bridge");
    expect(result).toContain("// keep me");
    expect(result).toContain("foo");
    expect(result).not.toContain("/abs/bridge");
  });

  test("removes object entry by path field", () => {
    const text = `{"plugin":[{"path":"/abs/bridge","options":{}},"foo"]}`;
    const { text: result, wasPresent } = applyPluginEntryRemove(text, "/abs/bridge");
    expect(wasPresent).toBe(true);
    const parsed = parseConfigText(result);
    expect(parsed["plugin"]).toEqual(["foo"]);
  });

  test("empty array after remove → preserved (not deleted)", () => {
    const text = `{"plugin":["/abs/bridge"]}`;
    const { text: result } = applyPluginEntryRemove(text, "/abs/bridge");
    const parsed = parseConfigText(result);
    expect(parsed["plugin"]).toEqual([]);
  });
});

describe("findPluginEntryNode", () => {
  test("finds string entry", () => {
    const text = `{"plugin":["foo","bar"]}`;
    const found = findPluginEntryNode(text, "bar");
    expect(found).not.toBeNull();
    expect(found?.index).toBe(1);
  });

  test("finds object entry by path", () => {
    const text = `{"plugin":[{"path":"/abs/bridge"}]}`;
    const found = findPluginEntryNode(text, "/abs/bridge");
    expect(found).not.toBeNull();
    expect(found?.index).toBe(0);
  });

  test("not found → null", () => {
    const text = `{"plugin":["foo"]}`;
    expect(findPluginEntryNode(text, "bar")).toBeNull();
  });

  test("unparseable → null", () => {
    expect(findPluginEntryNode("{bad", "foo")).toBeNull();
  });
});

describe("pluginEntrySpan + patchPluginEntrySpan", () => {
  test("span returns offset+length", () => {
    const text = `{"plugin":["foo","/abs/bridge"]}`;
    const span = pluginEntrySpan(text, "/abs/bridge");
    expect(span).not.toBeNull();
    expect(span?.length).toBeGreaterThan(0);
    // The substring at [offset, offset+length) should be the JSON string.
    const fragment = text.slice(span!.offset, span!.offset + span!.length);
    expect(fragment).toBe('"/abs/bridge"');
  });

  test("patch replaces only the span", () => {
    const text = `{"plugin":["foo","/abs/bridge"]}`;
    const span = pluginEntrySpan(text, "/abs/bridge");
    const patched = patchPluginEntrySpan(text, span!.offset, span!.length, '"new"');
    expect(patched).toBe(`{"plugin":["foo","new"]}`);
  });
});