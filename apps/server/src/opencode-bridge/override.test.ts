/**
 * Slice 17 hardened — Override validation tests.
 */

import { describe, expect, test } from "bun:test";
import { validateBridgeOverride } from "./override";

describe("validateBridgeOverride: absence", () => {
  test("undefined → not present", () => {
    const r = validateBridgeOverride(undefined);
    expect(r.present).toBe(false);
    expect(r.invalid).toBe(false);
    expect(r.optsOutOfManagement).toBe(false);
  });

  test("empty string → not present", () => {
    const r = validateBridgeOverride("");
    expect(r.present).toBe(false);
  });

  test("whitespace → not present", () => {
    const r = validateBridgeOverride("   ");
    expect(r.present).toBe(false);
  });
});

describe("validateBridgeOverride: valid", () => {
  test("http://127.0.0.1:8788 → valid, opts out", () => {
    const r = validateBridgeOverride("http://127.0.0.1:8788");
    expect(r.present).toBe(true);
    expect(r.invalid).toBe(false);
    expect(r.url).toBe("http://127.0.0.1:8788");
    expect(r.port).toBe(8788);
    expect(r.optsOutOfManagement).toBe(true);
  });

  test("trailing slash accepted", () => {
    const r = validateBridgeOverride("http://127.0.0.1:8788/");
    expect(r.invalid).toBe(false);
    expect(r.url).toBe("http://127.0.0.1:8788");
  });
});

describe("validateBridgeOverride: invalid", () => {
  test("not a URL", () => {
    const r = validateBridgeOverride("not-a-url");
    expect(r.invalid).toBe(true);
    expect(r.invalidReason).toContain("not a valid URL");
  });

  test("https rejected", () => {
    const r = validateBridgeOverride("https://127.0.0.1:8788");
    expect(r.invalid).toBe(true);
    expect(r.invalidReason).toContain("protocol");
  });

  test("localhost rejected (only 127.0.0.1)", () => {
    const r = validateBridgeOverride("http://localhost:8788");
    expect(r.invalid).toBe(true);
    expect(r.invalidReason).toContain("127.0.0.1");
  });

  test("[::1] rejected (only 127.0.0.1)", () => {
    const r = validateBridgeOverride("http://[::1]:8788");
    expect(r.invalid).toBe(true);
    expect(r.invalidReason).toContain("127.0.0.1");
  });

  test("0.0.0.0 rejected", () => {
    const r = validateBridgeOverride("http://0.0.0.0:8788");
    expect(r.invalid).toBe(true);
  });

  test("missing port", () => {
    const r = validateBridgeOverride("http://127.0.0.1");
    expect(r.invalid).toBe(true);
    expect(r.invalidReason).toContain("port");
  });

  test("path rejected", () => {
    const r = validateBridgeOverride("http://127.0.0.1:8788/telemetry");
    expect(r.invalid).toBe(true);
    expect(r.invalidReason).toContain("path");
  });

  test("userinfo rejected", () => {
    const r = validateBridgeOverride("http://user:pass@127.0.0.1:8788");
    expect(r.invalid).toBe(true);
    expect(r.invalidReason).toContain("userinfo");
  });

  test("query rejected", () => {
    const r = validateBridgeOverride("http://127.0.0.1:8788?foo=bar");
    expect(r.invalid).toBe(true);
    expect(r.invalidReason).toContain("query");
  });

  test("fragment rejected", () => {
    const r = validateBridgeOverride("http://127.0.0.1:8788#frag");
    expect(r.invalid).toBe(true);
    expect(r.invalidReason).toContain("fragment");
  });
});