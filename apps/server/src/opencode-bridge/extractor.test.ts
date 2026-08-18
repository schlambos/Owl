/**
 * Slice 17 hardened — Extractor tests.
 */

import { describe, expect, test } from "bun:test";
import { extractEffectivePluginView, fingerprintNonce, generateNonce } from "./extractor";

const ROOTS = ["/Users/matt/Repos/omo-slim", "/Users/matt/.config/opencode"];
const PROJECT_ROOT = "/Users/matt/Repos/omo-slim";

describe("fingerprintNonce", () => {
  test("sha256('abc') = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", () => {
    expect(fingerprintNonce("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("64 lowercase hex chars", () => {
    expect(fingerprintNonce("test")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("deterministic", () => {
    expect(fingerprintNonce("x")).toBe(fingerprintNonce("x"));
  });

  test("non-reversible: raw nonce not in fingerprint", () => {
    const raw = "very-long-secret-nonce-value-1234567890abcdef";
    const fp = fingerprintNonce(raw);
    expect(fp).not.toContain(raw);
    expect(fp).not.toContain("secret");
  });
});

describe("generateNonce", () => {
  test("64 hex chars (randomBytes(32))", () => {
    const n = generateNonce();
    expect(n).toMatch(/^[0-9a-f]{64}$/);
  });

  test("different each call (crypto random)", () => {
    expect(generateNonce()).not.toBe(generateNonce());
  });
});

describe("extractEffectivePluginView", () => {
  test("absent plugin → empty, not unavailable/invalid", () => {
    const v = extractEffectivePluginView({ agent: {} }, ROOTS, PROJECT_ROOT);
    expect(v.entries).toEqual([]);
    expect(v.unavailable).toBe(false);
    expect(v.invalid).toBe(false);
  });

  test("plugin not array → unavailable + invalid", () => {
    const v = extractEffectivePluginView({ plugin: "foo" }, ROOTS, PROJECT_ROOT);
    expect(v.unavailable).toBe(true);
    expect(v.invalid).toBe(true);
    expect(v.errors?.[0]?.code).toBe("plugin-shape-unsupported");
  });

  test("bare string entries: form=string, identityKind=npm", () => {
    const v = extractEffectivePluginView(
      { plugin: ["oh-my-opencode-slim"] },
      ROOTS,
      PROJECT_ROOT,
    );
    expect(v.entries).toHaveLength(1);
    expect(v.entries[0]!.form).toBe("string");
    expect(v.entries[0]!.effectiveIdentity).toBe("oh-my-opencode-slim");
    expect(v.entries[0]!.identityKind).toBe("npm");
    expect(v.entries[0]!.bridge).toBeUndefined();
  });

  test("absolute path entry: identityKind=path", () => {
    const v = extractEffectivePluginView(
      { plugin: ["/Users/matt/Repos/omo-slim/packages/omo-telemetry-bridge"] },
      ROOTS,
      PROJECT_ROOT,
    );
    expect(v.entries[0]!.identityKind).toBe("path");
  });

  test("file:// URL entry: identityKind=file-url", () => {
    const v = extractEffectivePluginView(
      { plugin: ["file:///Users/matt/Repos/omo-slim/packages/omo-telemetry-bridge"] },
      ROOTS,
      PROJECT_ROOT,
    );
    expect(v.entries[0]!.identityKind).toBe("file-url");
  });

  test("tuple [string, options] entry: form=tuple", () => {
    const v = extractEffectivePluginView(
      {
        plugin: [
          ["oh-my-opencode-slim", { port: 8788 }],
        ],
      },
      ROOTS,
      PROJECT_ROOT,
    );
    expect(v.entries[0]!.form).toBe("tuple");
    expect(v.entries[0]!.effectiveIdentity).toBe("oh-my-opencode-slim");
  });

  test("{path, options} object entry → unsupported, invalidates whole view", () => {
    const v = extractEffectivePluginView(
      { plugin: [{ path: "foo", options: {} }] },
      ROOTS,
      PROJECT_ROOT,
    );
    expect(v.invalid).toBe(true);
    expect(v.errors?.[0]?.code).toBe("plugin-shape-unsupported");
  });

  test("one unsupported entry invalidates whole view", () => {
    const v = extractEffectivePluginView(
      { plugin: ["oh-my-opencode-slim", 42] },
      ROOTS,
      PROJECT_ROOT,
    );
    expect(v.invalid).toBe(true);
  });

  test("relative path → valid path identity kind (unrelated relative plugins supported)", () => {
    const v = extractEffectivePluginView(
      { plugin: ["./packages/my-custom-plugin.js"] },
      ROOTS,
      PROJECT_ROOT,
    );
    expect(v.invalid).toBe(false);
    expect(v.entries).toHaveLength(1);
    expect(v.entries[0]!.identityKind).toBe("path");
  });

  test("bare string canonical bridge entry → proves presence, env transport, NO port, NO fingerprint", () => {
    const v = extractEffectivePluginView(
      { plugin: ["/Users/matt/Repos/omo-slim/packages/omo-telemetry-bridge"] },
      ROOTS,
      PROJECT_ROOT,
    );
    expect(v.invalid).toBe(false);
    expect(v.entries).toHaveLength(1);
    const entry = v.entries[0]!;
    expect(entry.bridge).toBeDefined();
    expect(entry.bridge?.pluginForm).toBe("string");
    expect(entry.bridge?.registrationTransport).toBe("env");
    expect(entry.bridge?.transportMode).toBe("loopback-http");
    expect(entry.bridge?.port).toBeUndefined();
    expect(entry.bridge?.nonceFingerprint).toBeUndefined();
  });

  test("only plugin is copied — other fields ignored", () => {
    const rawConfig = {
      $schema: "https://opencode.ai/config.json",
      plugin: ["oh-my-opencode-slim"],
      provider: { openai: { apiKey: "sk-leaked" } },
    };
    const v = extractEffectivePluginView(rawConfig, ROOTS, PROJECT_ROOT);
    const serialized = JSON.stringify(v);
    expect(serialized).not.toContain("sk-leaked");
    expect(serialized).not.toContain("provider");
  });

  test("bridge entry with valid activationNonce (16..256 chars) and port → fingerprint kept, raw discarded", () => {
    const rawNonce = "test-activation-nonce-1234567890abcdef";
    const v = extractEffectivePluginView(
      {
        plugin: [
          [
            "/Users/matt/Repos/omo-slim/packages/omo-telemetry-bridge",
            { port: 8788, activationNonce: rawNonce },
          ],
        ],
      },
      ROOTS,
      PROJECT_ROOT,
    );
    expect(v.entries).toHaveLength(1);
    const entry = v.entries[0]!;
    expect(entry.bridge).toBeDefined();
    expect(entry.bridge?.pluginForm).toBe("tuple");
    expect(entry.bridge?.port).toBe(8788);
    expect(entry.bridge?.registrationTransport).toBe("tuple");
    expect(entry.bridge?.transportMode).toBe("loopback-http");
    expect(entry.bridge?.nonceFingerprint).toHaveLength(64);
    // Raw nonce must NOT appear in the view.
    expect(JSON.stringify(v)).not.toContain(rawNonce);
  });

  test("bridge entry with short activationNonce (<16 chars) does NOT generate fingerprint", () => {
    const v = extractEffectivePluginView(
      {
        plugin: [
          [
            "/Users/matt/Repos/omo-slim/packages/omo-telemetry-bridge",
            { port: 8788, activationNonce: "too-short" },
          ],
        ],
      },
      ROOTS,
      PROJECT_ROOT,
    );
    expect(v.entries[0]?.bridge?.nonceFingerprint).toBeUndefined();
  });

  test("bridge entry with out-of-range port does not populate port", () => {
    const v = extractEffectivePluginView(
      {
        plugin: [
          [
            "/Users/matt/Repos/omo-slim/packages/omo-telemetry-bridge",
            { port: 9999, activationNonce: "test-activation-nonce-1234567890abcdef" },
          ],
        ],
      },
      ROOTS,
      PROJECT_ROOT,
    );
    expect(v.entries[0]?.bridge?.port).toBeUndefined();
  });

  test("bridge entry without valid activationNonce does NOT fabricate a fingerprint", () => {
    const v = extractEffectivePluginView(
      {
        plugin: [
          [
            "/Users/matt/Repos/omo-slim/packages/omo-telemetry-bridge",
            { port: 8788, nonce: "should-be-ignored" },
          ],
        ],
      },
      ROOTS,
      PROJECT_ROOT,
    );
    // 'nonce' is not an allowlisted option; activationNonce is missing.
    // Must NOT fabricate sha256("")!
    expect(v.entries[0]?.bridge?.nonceFingerprint).toBeUndefined();
    expect(v.entries[0]?.bridge?.port).toBe(8788);
    expect(v.entries[0]?.bridge?.pluginForm).toBe("tuple");
  });
});