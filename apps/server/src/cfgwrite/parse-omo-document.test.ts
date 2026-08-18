/**
 * Slice 18 D0 — strict `.json` vs `.jsonc` parser contract.
 */

import { describe, expect, test } from "bun:test";
import { parseOmoDocument } from "./jsonc-edit";

describe("parseOmoDocument json vs jsonc", () => {
  test("strict JSON accepts a plain object", () => {
    const r = parseOmoDocument('{"a":1}', "json");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.document).toEqual({ a: 1 });
  });

  test("strict JSON rejects comments with syntax-invalid", () => {
    const r = parseOmoDocument('{ // comment\n "a": 1 }', "json");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issue.code).toBe("syntax-invalid");
    expect(r.issue.format).toBe("json");
    expect(r.issue.path).toBe("");
  });

  test("strict JSON rejects trailing commas with syntax-invalid", () => {
    const r = parseOmoDocument('{"a":1,}', "json");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issue.code).toBe("syntax-invalid");
    expect(r.issue.format).toBe("json");
  });

  test("JSONC accepts comments and trailing commas", () => {
    const r = parseOmoDocument(
      '{ // retained\n "a": 1,\n}',
      "jsonc",
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.document).toEqual({ a: 1 });
  });

  test("both formats reject a non-object root", () => {
    for (const format of ["json", "jsonc"] as const) {
      const r = parseOmoDocument("[1,2]", format);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.issue.code).toBe("root-not-object");
      expect(r.issue.format).toBe(format);
      expect(r.issue.path).toBe("");
    }
  });

  test("JSONC reports offset/length on syntax errors", () => {
    const r = parseOmoDocument("{,}", "jsonc");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issue.code).toBe("syntax-invalid");
    expect(typeof r.issue.offset).toBe("number");
  });
});
