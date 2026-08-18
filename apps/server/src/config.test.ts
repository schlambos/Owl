/**
 * Slice 17 hardened — Config tests.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_OPENCODE_CONFIG_DIRECTORY,
  MANAGED_PROJECT_DIRECTORY,
  loadServerConfig,
  validateBridgeOverride,
} from "./config";

describe("OpenCode mode configuration", () => {
  test("absence selects managed without inventing an attach URL", () => {
    const cfg = loadServerConfig({});
    expect(cfg.opencodeMode).toBe("managed");
    expect(cfg.opencodeAttachBaseUrl).toBeUndefined();
    expect(cfg.projectDirectory).toBe(MANAGED_PROJECT_DIRECTORY);
    expect(cfg.opencodeConfigDir).toBe(DEFAULT_OPENCODE_CONFIG_DIRECTORY);
  });

  test("presence selects attach, including explicit empty", () => {
    const cfg = loadServerConfig({ OPENCODE_BASE_URL: "" });
    expect(cfg.opencodeMode).toBe("attach");
    expect(cfg.opencodeAttachBaseUrl).toBe("");
  });

  test("active config dir override is preserved but project remains fixed", () => {
    const cfg = loadServerConfig({
      OPENCODE_CONFIG_DIR: "/Users/matt/.config/opencode/active",
      OMO_CP_PROJECT_DIR: "/not/authority",
    });
    expect(cfg.opencodeConfigDir).toBe("/Users/matt/.config/opencode/active");
    expect(cfg.projectDirectory).toBe(MANAGED_PROJECT_DIRECTORY);
  });

  test("explicit empty config dir fails instead of silently changing authority", () => {
    expect(() => loadServerConfig({ OPENCODE_CONFIG_DIR: "" })).toThrow("empty");
  });
});

// ── Slice 17 hardened: OMO_BRIDGE_BASE_URL override validation ────────

describe("OMO_BRIDGE_BASE_URL override in loadServerConfig", () => {
  test("absence → override not present, no management opt-out", () => {
    const cfg = loadServerConfig({});
    expect(cfg.omoBridgeOverride?.present).toBe(false);
    expect(cfg.omoBridgeOverride?.optsOutOfManagement).toBe(false);
    expect(cfg.omoBridgeBaseUrl).toBeUndefined();
  });

  test("valid loopback → valid override, opts out of management", () => {
    const cfg = loadServerConfig({ OMO_BRIDGE_BASE_URL: "http://127.0.0.1:8788" });
    expect(cfg.omoBridgeOverride?.present).toBe(true);
    expect(cfg.omoBridgeOverride?.invalid).toBe(false);
    expect(cfg.omoBridgeOverride?.url).toBe("http://127.0.0.1:8788");
    expect(cfg.omoBridgeOverride?.port).toBe(8788);
    expect(cfg.omoBridgeOverride?.optsOutOfManagement).toBe(true);
    expect(cfg.omoBridgeBaseUrl).toBe("http://127.0.0.1:8788");
  });

  test("invalid non-loopback → omoBridgeBaseUrl undefined (cannot request)", () => {
    const cfg = loadServerConfig({ OMO_BRIDGE_BASE_URL: "http://192.168.0.1:8788" });
    expect(cfg.omoBridgeOverride?.present).toBe(true);
    expect(cfg.omoBridgeOverride?.invalid).toBe(true);
    expect(cfg.omoBridgeOverride?.optsOutOfManagement).toBe(false);
    // Oracle decision 10: omoBridgeBaseUrl undefined when invalid.
    expect(cfg.omoBridgeBaseUrl).toBeUndefined();
  });

  test("localhost rejected (only 127.0.0.1)", () => {
    const cfg = loadServerConfig({ OMO_BRIDGE_BASE_URL: "http://localhost:8788" });
    expect(cfg.omoBridgeOverride?.invalid).toBe(true);
    expect(cfg.omoBridgeBaseUrl).toBeUndefined();
  });

  test("empty string → not present (absence preserved)", () => {
    const cfg = loadServerConfig({ OMO_BRIDGE_BASE_URL: "" });
    expect(cfg.omoBridgeOverride?.present).toBe(false);
    expect(cfg.omoBridgeBaseUrl).toBeUndefined();
  });

  test("https rejected", () => {
    const cfg = loadServerConfig({ OMO_BRIDGE_BASE_URL: "https://127.0.0.1:8788" });
    expect(cfg.omoBridgeOverride?.invalid).toBe(true);
    expect(cfg.omoBridgeBaseUrl).toBeUndefined();
  });

  test("userinfo rejected", () => {
    const cfg = loadServerConfig({ OMO_BRIDGE_BASE_URL: "http://user:pass@127.0.0.1:8788" });
    expect(cfg.omoBridgeOverride?.invalid).toBe(true);
    expect(cfg.omoBridgeOverride?.invalidReason).toContain("userinfo");
  });

  test("query rejected", () => {
    const cfg = loadServerConfig({ OMO_BRIDGE_BASE_URL: "http://127.0.0.1:8788?foo=bar" });
    expect(cfg.omoBridgeOverride?.invalid).toBe(true);
    expect(cfg.omoBridgeOverride?.invalidReason).toContain("query");
  });

  test("fragment rejected", () => {
    const cfg = loadServerConfig({ OMO_BRIDGE_BASE_URL: "http://127.0.0.1:8788#frag" });
    expect(cfg.omoBridgeOverride?.invalid).toBe(true);
    expect(cfg.omoBridgeOverride?.invalidReason).toContain("fragment");
  });
});

describe("validateBridgeOverride (consolidated)", () => {
  test("undefined → not present", () => {
    const r = validateBridgeOverride(undefined);
    expect(r.present).toBe(false);
    expect(r.invalid).toBe(false);
  });

  test("valid 127.0.0.1 → canonical URL", () => {
    const r = validateBridgeOverride("http://127.0.0.1:8788");
    expect(r.invalid).toBe(false);
    expect(r.url).toBe("http://127.0.0.1:8788");
    expect(r.optsOutOfManagement).toBe(true);
  });

  test("non-127.0.0.1 rejected", () => {
    const r = validateBridgeOverride("http://10.0.0.1:8788");
    expect(r.invalid).toBe(true);
    expect(r.invalidReason).toContain("127.0.0.1");
  });
});