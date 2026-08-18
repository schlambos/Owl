import { describe, expect, test } from "bun:test";
import {
  interpretListExpression,
  parseList,
  skillPermissionMap,
  summarizeToolPermission,
} from "./capabilities";

describe("parseList (OMO)", () => {
  const all = ["a", "b", "c", "d"];
  test("empty", () => expect(parseList([], all)).toEqual([]));
  test("undefined", () => expect(parseList(undefined, all)).toEqual([]));
  test("deny all", () => expect(parseList(["!*"], all)).toEqual([]));
  test("wildcard minus", () =>
    expect(parseList(["*", "!b"], all)).toEqual(["a", "c", "d"]));
  test("explicit", () =>
    expect(parseList(["a", "c", "!c"], all)).toEqual(["a"]));
  test("unknown filtered", () =>
    expect(parseList(["a", "zzz"], all)).toEqual(["a"]));
});

describe("interpretListExpression", () => {
  test("global disable removes", () => {
    const s = interpretListExpression(["*", "!x"], ["a", "b", "x"], ["b"]);
    expect(s.allowed).toEqual(["a"]);
    expect(s.globallyDisabled).toContain("b");
  });
  test("unset", () => {
    expect(interpretListExpression(undefined, ["a"], []).mode).toBe("unset");
  });
  test("unknown configured", () => {
    const s = interpretListExpression(["foo", "a"], ["a"], []);
    expect(s.configuredUnknown).toContain("foo");
    expect(s.allowed).toContain("a");
  });
});

describe("skillPermissionMap", () => {
  test("wildcard", () => {
    const m = skillPermissionMap(["*"], [], "explorer");
    expect(m["*"]).toBe("allow");
  });
  test("negative", () => {
    const m = skillPermissionMap(["*", "!deepwork"], [], "orch");
    expect(m["*"]).toBe("allow");
    expect(m.deepwork).toBe("deny");
  });
  test("disabled forced", () => {
    const m = skillPermissionMap(["codemap"], ["codemap"], "x");
    expect(m.codemap).toBe("deny");
  });
});

describe("permission summarize", () => {
  test("simple", () => expect(summarizeToolPermission("allow")).toBe("allow"));
  test("patterned", () =>
    expect(
      summarizeToolPermission({ "git *": "allow", "*": "ask" }),
    ).toBe("patterned"));
});
