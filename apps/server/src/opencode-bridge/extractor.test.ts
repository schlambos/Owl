/**
 * Slice 17 hardened — Extractor tests.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractEffectivePluginView, fingerprintNonce, generateNonce } from "./extractor";

// Portable fixture: the canonical bridge package lives ONLY under a
// dedicated Owl install root; the target project root is a separate
// directory with no packages/ layout.
let fixtureRoot: string;
let OWL_INSTALL_DIR: string;
let BRIDGE_DIR: string;
let PROJECT_ROOT: string;
let ROOTS: string[];

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "omo-extractor-"));
  OWL_INSTALL_DIR = join(fixtureRoot, "owl-install");
  BRIDGE_DIR = join(OWL_INSTALL_DIR, "packages", "omo-telemetry-bridge");
  PROJECT_ROOT = join(fixtureRoot, "proj");
  mkdirSync(BRIDGE_DIR, { recursive: true });
  writeFileSync(join(BRIDGE_DIR, "package.json"), "{}");
  mkdirSync(PROJECT_ROOT, { recursive: true });
  ROOTS = [OWL_INSTALL_DIR, PROJECT_ROOT];
});

afterAll(() => {
  try { rmSync(fixtureRoot, { recursive: true, force: true }); } catch { /* */ }
});

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
    const v = extractEffectivePluginView({ agent: {} }, ROOTS, OWL_INSTALL_DIR);
    expect(v.entries).toEqual([]);
    expect(v.unavailable).toBe(false);
    expect(v.invalid).toBe(false);
  });

  test("plugin not array → unavailable + invalid", () => {
    const v = extractEffectivePluginView({ plugin: "foo" }, ROOTS, OWL_INSTALL_DIR);
    expect(v.unavailable).toBe(true);
    expect(v.invalid).toBe(true);
    expect(v.errors?.[0]?.code).toBe("plugin-shape-unsupported");
  });

  test("bare string entries: form=string, identityKind=npm", () => {
    const v = extractEffectivePluginView(
      { plugin: ["oh-my-opencode-slim"] },
      ROOTS,
      OWL_INSTALL_DIR,
    );
    expect(v.entries).toHaveLength(1);
    expect(v.entries[0]!.form).toBe("string");
    expect(v.entries[0]!.effectiveIdentity).toBe("oh-my-opencode-slim");
    expect(v.entries[0]!.identityKind).toBe("npm");
    expect(v.entries[0]!.bridge).toBeUndefined();
  });

  test("absolute path entry: identityKind=path", () => {
    const v = extractEffectivePluginView(
      { plugin: [`${BRIDGE_DIR}`] },
      ROOTS,
      OWL_INSTALL_DIR,
    );
    expect(v.entries[0]!.identityKind).toBe("path");
  });

  test("file:// URL entry: identityKind=file-url", () => {
    const v = extractEffectivePluginView(
      { plugin: [`file://${BRIDGE_DIR}`] },
      ROOTS,
      OWL_INSTALL_DIR,
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
      OWL_INSTALL_DIR,
    );
    expect(v.entries[0]!.form).toBe("tuple");
    expect(v.entries[0]!.effectiveIdentity).toBe("oh-my-opencode-slim");
  });

  test("{path, options} object entry → unsupported, invalidates whole view", () => {
    const v = extractEffectivePluginView(
      { plugin: [{ path: "foo", options: {} }] },
      ROOTS,
      OWL_INSTALL_DIR,
    );
    expect(v.invalid).toBe(true);
    expect(v.errors?.[0]?.code).toBe("plugin-shape-unsupported");
  });

  test("one unsupported entry invalidates whole view", () => {
    const v = extractEffectivePluginView(
      { plugin: ["oh-my-opencode-slim", 42] },
      ROOTS,
      OWL_INSTALL_DIR,
    );
    expect(v.invalid).toBe(true);
  });

  test("relative path → valid path identity kind (unrelated relative plugins supported)", () => {
    const v = extractEffectivePluginView(
      { plugin: ["./packages/my-custom-plugin.js"] },
      ROOTS,
      OWL_INSTALL_DIR,
    );
    expect(v.invalid).toBe(false);
    expect(v.entries).toHaveLength(1);
    expect(v.entries[0]!.identityKind).toBe("path");
  });

  test("bare string canonical bridge entry → proves presence, env transport, NO port, NO fingerprint", () => {
    const v = extractEffectivePluginView(
      { plugin: [`${BRIDGE_DIR}`] },
      ROOTS,
      OWL_INSTALL_DIR,
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
    const v = extractEffectivePluginView(rawConfig, ROOTS, OWL_INSTALL_DIR);
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
            `${BRIDGE_DIR}`,
            { port: 8788, activationNonce: rawNonce },
          ],
        ],
      },
      ROOTS,
      OWL_INSTALL_DIR,
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
            `${BRIDGE_DIR}`,
            { port: 8788, activationNonce: "too-short" },
          ],
        ],
      },
      ROOTS,
      OWL_INSTALL_DIR,
    );
    expect(v.entries[0]?.bridge?.nonceFingerprint).toBeUndefined();
  });

  test("bridge entry with out-of-range port does not populate port", () => {
    const v = extractEffectivePluginView(
      {
        plugin: [
          [
            `${BRIDGE_DIR}`,
            { port: 9999, activationNonce: "test-activation-nonce-1234567890abcdef" },
          ],
        ],
      },
      ROOTS,
      OWL_INSTALL_DIR,
    );
    expect(v.entries[0]?.bridge?.port).toBeUndefined();
  });

  test("bridge entry without valid activationNonce does NOT fabricate a fingerprint", () => {
    const v = extractEffectivePluginView(
      {
        plugin: [
          [
            `${BRIDGE_DIR}`,
            { port: 8788, nonce: "should-be-ignored" },
          ],
        ],
      },
      ROOTS,
      OWL_INSTALL_DIR,
    );
    // 'nonce' is not an allowlisted option; activationNonce is missing.
    // Must NOT fabricate sha256("")!
    expect(v.entries[0]?.bridge?.nonceFingerprint).toBeUndefined();
    expect(v.entries[0]?.bridge?.port).toBe(8788);
    expect(v.entries[0]?.bridge?.pluginForm).toBe("tuple");
  });
});
// ── Install root ≠ project root: canonical identity semantics ──────────

describe("extractEffectivePluginView: Owl install-root identity", () => {
  test("bridge fingerprint extracted via install root while project root differs", () => {
    // BRIDGE_DIR lives ONLY under OWL_INSTALL_DIR; PROJECT_ROOT has no
    // packages/ layout. Identity resolves canonically via the install root.
    const v = extractEffectivePluginView(
      { plugin: [`${BRIDGE_DIR}`] },
      ROOTS,
      OWL_INSTALL_DIR,
    );
    expect(v.invalid).toBe(false);
    expect(v.entries).toHaveLength(1);
    expect(v.entries[0]!.bridge).toBeDefined();
    expect(v.entries[0]!.bridge?.pluginForm).toBe("string");
    expect(v.entries[0]!.bridge?.registrationTransport).toBe("env");
    expect(v.entries[0]!.bridge?.transportMode).toBe("loopback-http");
  });

  test("passing the project root as identity root yields NO fingerprint (root must be the install root)", () => {
    // Negative proof: the identity root parameter is load-bearing. With
    // PROJECT_ROOT as the identity root the bridge under the separate
    // install root is NOT canonical, so no bridge fingerprint is attached.
    const v = extractEffectivePluginView(
      { plugin: [`${BRIDGE_DIR}`] },
      ROOTS,
      PROJECT_ROOT,
    );
    expect(v.invalid).toBe(false);
    expect(v.entries).toHaveLength(1);
    expect(v.entries[0]!.identityKind).toBe("path");
    expect(v.entries[0]!.bridge).toBeUndefined();
  });
});
