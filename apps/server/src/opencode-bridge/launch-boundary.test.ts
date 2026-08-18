/**
 * Slice 17 hardened — Launch boundary tests.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeRevisionStore } from "./revisions-bridge";
import { withOwnedBridgeLaunchEnv, type LaunchEnvOverlay } from "./launch-boundary";
import { fingerprintNonce } from "./extractor";
import { hashContent } from "../cfgwrite/jsonc-edit";

let sandbox: string;
let dbPath: string;
let store: BridgeRevisionStore;
let configPath: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "omo-launch-"));
  dbPath = join(sandbox, "data", "bridge.db");
  store = new BridgeRevisionStore(dbPath);
  configPath = join(sandbox, "opencode.json");
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* */
  }
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* */
  }
});

describe("withOwnedBridgeLaunchEnv", () => {
  test("disabled/inactive state invokes callback with empty overlay", () => {
    let capturedOverlay: LaunchEnvOverlay | undefined;
    const result = withOwnedBridgeLaunchEnv({ store }, (overlay) => {
      capturedOverlay = overlay;
      // Return value deliberately discarded by the boundary.
      return "started-without-bridge";
    });

    expect(result.ok).toBe(true);
    // No generic value channel: the callback return cannot escape.
    expect("value" in result).toBe(false);
    expect(capturedOverlay).toEqual({});
    // Assert result does not return or contain overlay (no raw nonce leakage)
    expect((result as unknown as Record<string, unknown>).overlay).toBeUndefined();
  });

  test("active committed state passes port and raw nonce exclusively to callback argument", () => {
    const rawNonce = "super-secret-nonce-1234567890abcdef";
    const nonceFp = fingerprintNonce(rawNonce);
    const configText = `{"plugin":["/canonical/bridge"]}`;
    writeFileSync(configPath, configText, "utf-8");
    const cfgHash = hashContent(configText);

    // Prepare & finalize intent into committed state.
    store.insertPreparedIntent({
      id: "intent_active",
      targetPath: configPath,
      sourceKind: "opencode-config-dir",
      operation: "add",
      baselineHash: "h_base",
      proposedHash: cfgHash,
      canonicalIdentity: "/canonical/bridge",
      port: 8788,
      registrationTransport: "env",
      transportMode: "loopback-http",
      nonceFingerprint: nonceFp,
      bytePatch: "{\"version\":1,\"offsetUtf16\":14,\"deleteText\":\"\",\"insertText\":\"x\"}",
      rawActivationNonce: rawNonce,
    });
    store.finalizeIntent("intent_active", "rev_1", new Date().toISOString(), cfgHash);

    let capturedOverlay: LaunchEnvOverlay | undefined;
    const result = withOwnedBridgeLaunchEnv({ store }, (overlay) => {
      capturedOverlay = overlay;
      return "server-started-ok";
    });

    expect(result.ok).toBe(true);
    expect("value" in result).toBe(false);
    expect(capturedOverlay).toEqual({
      OMO_BRIDGE_PORT: "8788",
      OMO_BRIDGE_ACTIVATION_NONCE: rawNonce,
    });

    // Assert the returned result and serialized result contain NO overlay / raw nonce
    expect((result as unknown as Record<string, unknown>).overlay).toBeUndefined();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(rawNonce);
    expect(serialized).not.toContain("super-secret-nonce");
  });

  test("unresolved intent blocks launch with state-recovery-pending", () => {
    store.insertPreparedIntent({
      id: "intent_dirty",
      targetPath: configPath,
      sourceKind: "opencode-config-dir",
      operation: "add",
      baselineHash: "h1",
      proposedHash: "h2",
      canonicalIdentity: "/bridge",
      bytePatch: "{\"version\":1,\"offsetUtf16\":14,\"deleteText\":\"\",\"insertText\":\"x\"}",
    });

    const result = withOwnedBridgeLaunchEnv({ store }, () => {
      throw new Error("should not be called");
    });

    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("state-recovery-pending");
  });

  test("committed config hash drift on disk blocks launch with state-conflict", () => {
    const rawNonce = "nonce_123";
    const nonceFp = fingerprintNonce(rawNonce);
    const originalText = `{"plugin":["/canonical/bridge"]}`;
    writeFileSync(configPath, originalText, "utf-8");
    const originalHash = hashContent(originalText);

    store.insertPreparedIntent({
      id: "intent_1",
      targetPath: configPath,
      sourceKind: "opencode-config-dir",
      operation: "add",
      baselineHash: "h_base",
      proposedHash: originalHash,
      canonicalIdentity: "/canonical/bridge",
      port: 8788,
      registrationTransport: "env",
      transportMode: "loopback-http",
      nonceFingerprint: nonceFp,
      bytePatch: "{\"version\":1,\"offsetUtf16\":14,\"deleteText\":\"\",\"insertText\":\"x\"}",
      rawActivationNonce: rawNonce,
    });
    store.finalizeIntent("intent_1", "rev_1", new Date().toISOString(), originalHash);

    // Tamper with config file externally.
    writeFileSync(configPath, `{"plugin":["/canonical/bridge","tampered"]}`, "utf-8");

    const result = withOwnedBridgeLaunchEnv({ store }, () => {
      throw new Error("should not be called");
    });

    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("state-conflict");
  });

  test("missing committed target file blocks launch with state-conflict", () => {
    const rawNonce = "nonce_123";
    const nonceFp = fingerprintNonce(rawNonce);
    const missingPath = join(sandbox, "nonexistent.json");

    store.insertPreparedIntent({
      id: "intent_1",
      targetPath: missingPath,
      sourceKind: "opencode-config-dir",
      operation: "add",
      baselineHash: "h_base",
      proposedHash: "h_prop",
      canonicalIdentity: "/canonical/bridge",
      port: 8788,
      registrationTransport: "env",
      transportMode: "loopback-http",
      nonceFingerprint: nonceFp,
      bytePatch: "{\"version\":1,\"offsetUtf16\":14,\"deleteText\":\"\",\"insertText\":\"x\"}",
      rawActivationNonce: rawNonce,
    });
    store.finalizeIntent("intent_1", "rev_1", new Date().toISOString(), "h_prop");

    const result = withOwnedBridgeLaunchEnv({ store }, () => {
      throw new Error("should not be called");
    });

    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("state-conflict");
  });

  // ── Phase 2: an active committed record must be COMPLETE ────────────
  // Optional/missing fields can never skip validation.

  function commitActiveRecord(overrides: {
    port?: number;
    nonceFingerprint?: string;
    rawActivationNonce?: string;
    transportMode?: "loopback-http";
    canonicalIdentity?: string;
  }): void {
    const rawNonce = overrides.rawActivationNonce ?? "nonce_1234567890abcdef";
    const configText = `{"plugin":["/canonical/bridge"]}`;
    writeFileSync(configPath, configText, "utf-8");
    const cfgHash = hashContent(configText);
    store.insertPreparedIntent({
      id: "intent_active",
      targetPath: configPath,
      sourceKind: "opencode-config-dir",
      operation: "add",
      baselineHash: "h_base",
      proposedHash: cfgHash,
      canonicalIdentity: overrides.canonicalIdentity ?? "/canonical/bridge",
      ...(overrides.port !== undefined ? { port: overrides.port } : {}),
      registrationTransport: "env",
      ...(overrides.transportMode !== undefined
        ? { transportMode: overrides.transportMode }
        : {}),
      ...(overrides.nonceFingerprint !== undefined
        ? { nonceFingerprint: overrides.nonceFingerprint }
        : {}),
      bytePatch: "{\"version\":1,\"offsetUtf16\":14,\"deleteText\":\"\",\"insertText\":\"x\"}",
      rawActivationNonce: rawNonce,
    });
    store.finalizeIntent("intent_active", "rev_1", new Date().toISOString(), cfgHash);
  }

  test("active record with missing port is rejected (state-conflict)", () => {
    commitActiveRecord({ nonceFingerprint: "a".repeat(64) });
    const result = withOwnedBridgeLaunchEnv({ store }, () => {});
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("state-conflict");
    expect("value" in result).toBe(false);
  });

  test("active record with out-of-range port is rejected", () => {
    commitActiveRecord({ port: 9999, nonceFingerprint: "a".repeat(64) });
    const result = withOwnedBridgeLaunchEnv({ store }, () => {});
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("state-conflict");
  });

  test("active record with malformed fingerprint is rejected", () => {
    commitActiveRecord({ port: 8788, nonceFingerprint: "not-hex" });
    const result = withOwnedBridgeLaunchEnv({ store }, () => {});
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("state-conflict");
  });

  test("active record with missing transport mode is rejected", () => {
    commitActiveRecord({ port: 8788, nonceFingerprint: "a".repeat(64) });
    const result = withOwnedBridgeLaunchEnv({ store }, () => {});
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("state-conflict");
  });

  test("active record with empty canonical identity is rejected", () => {
    commitActiveRecord({
      port: 8788,
      nonceFingerprint: "a".repeat(64),
      transportMode: "loopback-http",
      canonicalIdentity: "",
    });
    const result = withOwnedBridgeLaunchEnv({ store }, () => {});
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("state-conflict");
  });

  test("raw nonce mismatching the committed fingerprint is rejected", () => {
    commitActiveRecord({
      port: 8788,
      nonceFingerprint: "a".repeat(64), // does not match rawNonce below
      transportMode: "loopback-http",
      rawActivationNonce: "nonce_1234567890abcdef",
    });
    const result = withOwnedBridgeLaunchEnv({ store }, () => {});
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("state-conflict");
  });

  test("complete active record passes all field validation", () => {
    const rawNonce = "nonce_1234567890abcdef";
    commitActiveRecord({
      port: 8788,
      nonceFingerprint: fingerprintNonce(rawNonce),
      transportMode: "loopback-http",
      rawActivationNonce: rawNonce,
    });
    let captured: LaunchEnvOverlay | undefined;
    const result = withOwnedBridgeLaunchEnv({ store }, (overlay) => {
      captured = overlay;
    });
    expect(result.ok).toBe(true);
    expect(captured).toEqual({
      OMO_BRIDGE_PORT: "8788",
      OMO_BRIDGE_ACTIVATION_NONCE: rawNonce,
    });
  });
});

// ── Phase 2 Gate 2: raw nonce confinement proofs ────────────────────────

describe("raw nonce confinement (Gate 2)", () => {
  test("callback return value cannot carry the nonce (compile + runtime)", () => {
    // Compile-oriented proof: the result type exposes no value channel.
    // @ts-expect-error — LaunchBoundaryResult has no `value` property.
    const _noValue: unknown = withOwnedBridgeLaunchEnv({ store }, () => {}).value;
    void _noValue;

    // Runtime proof: a callback returning the nonce-shaped value is discarded.
    let observed: string | undefined;
    const result = withOwnedBridgeLaunchEnv({ store }, () => {
      observed = "callback-ran";
      return "would-be-nonce-leak";
    });
    expect(result.ok).toBe(true);
    expect(observed).toBe("callback-ran");
    expect(JSON.stringify(result)).not.toContain("would-be-nonce-leak");
  });

  test("committed raw nonce violating the length bound is rejected", () => {
    const shortNonce = "tiny";
    const configText = `{"plugin":["/canonical/bridge"]}`;
    writeFileSync(configPath, configText, "utf-8");
    const cfgHash = hashContent(configText);
    store.insertPreparedIntent({
      id: "intent_short_nonce",
      targetPath: configPath,
      sourceKind: "opencode-config-dir",
      operation: "add",
      baselineHash: "h_base",
      proposedHash: cfgHash,
      canonicalIdentity: "/canonical/bridge",
      port: 8788,
      registrationTransport: "env",
      transportMode: "loopback-http",
      nonceFingerprint: fingerprintNonce(shortNonce),
      bytePatch: "{\"version\":1,\"offsetUtf16\":14,\"deleteText\":\"\",\"insertText\":\"x\"}",
      rawActivationNonce: shortNonce,
    });
    store.finalizeIntent("intent_short_nonce", "rev_1", new Date().toISOString(), cfgHash);

    let called = false;
    const result = withOwnedBridgeLaunchEnv({ store }, () => {
      called = true;
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("state-conflict");
    expect(called).toBe(false);
  });

  test("redactor closure redacts the raw nonce from later error text", () => {
    const rawNonce = "redactor-nonce-0123456789abcdef";
    const configText = `{"plugin":["/canonical/bridge"]}`;
    writeFileSync(configPath, configText, "utf-8");
    const cfgHash = hashContent(configText);
    store.insertPreparedIntent({
      id: "intent_redactor",
      targetPath: configPath,
      sourceKind: "opencode-config-dir",
      operation: "add",
      baselineHash: "h_base",
      proposedHash: cfgHash,
      canonicalIdentity: "/canonical/bridge",
      port: 8788,
      registrationTransport: "env",
      transportMode: "loopback-http",
      nonceFingerprint: fingerprintNonce(rawNonce),
      bytePatch: "{\"version\":1,\"offsetUtf16\":14,\"deleteText\":\"\",\"insertText\":\"x\"}",
      rawActivationNonce: rawNonce,
    });
    store.finalizeIntent("intent_redactor", "rev_1", new Date().toISOString(), cfgHash);

    let redactor: ((text: string) => string) | undefined;
    const result = withOwnedBridgeLaunchEnv({ store }, (_overlay, redact) => {
      redactor = redact;
    });
    expect(result.ok).toBe(true);
    expect(redactor).toBeDefined();
    const sanitized = redactor!(`SDK failed: nonce=${rawNonce} on port 8788`);
    expect(sanitized).not.toContain(rawNonce);
    expect(sanitized).toContain("[redacted]");
  });
});

// ── DB v3: launch boundary after metadata-only rebase ──────────────────

describe("launch boundary after drift acceptance", () => {
  test("accepts the rebased hash with the same nonce; rejects later tamper", () => {
    const rawNonce = "rebase-launch-nonce-0123456789";
    const nonceFp = fingerprintNonce(rawNonce);
    const originalText = `{"plugin":["/canonical/bridge"]}`;
    writeFileSync(configPath, originalText, "utf-8");
    const originalHash = hashContent(originalText);

    store.insertPreparedIntent({
      id: "intent_lb_add",
      targetPath: configPath,
      sourceKind: "opencode-config-dir",
      operation: "add",
      baselineHash: "h_base",
      proposedHash: originalHash,
      canonicalIdentity: "/canonical/bridge",
      port: 8788,
      registrationTransport: "env",
      transportMode: "loopback-http",
      nonceFingerprint: nonceFp,
      bytePatch: "{\"version\":1,\"offsetUtf16\":14,\"deleteText\":\"\",\"insertText\":\"x\"}",
      rawActivationNonce: rawNonce,
    });
    store.finalizeIntent("intent_lb_add", "rev_lb_add", new Date().toISOString(), originalHash);

    // External edit, then metadata-only rebase to the new hash.
    const driftedText = `{"plugin":["/canonical/bridge"],"theme":"dark"}`;
    writeFileSync(configPath, driftedText, "utf-8");
    const driftedHash = hashContent(driftedText);
    const commit = store.commitDriftAcceptance({
      intentId: "intent_lb_rebase",
      revisionId: "rev_lb_rebase",
      timestamp: new Date().toISOString(),
      targetPath: configPath,
      sourceKind: "opencode-config-dir",
      canonicalIdentity: "/canonical/bridge",
      port: 8788,
      nonceFingerprint: nonceFp,
      oldConfigHash: originalHash,
      newConfigHash: driftedHash,
      expectedRevisionId: "rev_lb_add",
      anchorRevisionId: "rev_lb_add",
      auditMetadata: "{}",
    });
    expect(commit.ok).toBe(true);

    // Launch boundary accepts the NEW committed hash with the SAME nonce.
    let captured: LaunchEnvOverlay | undefined;
    const okResult = withOwnedBridgeLaunchEnv({ store }, (overlay) => {
      captured = overlay;
    });
    expect(okResult.ok).toBe(true);
    expect(captured).toEqual({
      OMO_BRIDGE_PORT: "8788",
      OMO_BRIDGE_ACTIVATION_NONCE: rawNonce,
    });

    // A later external edit (watcher-class drift) is rejected again.
    writeFileSync(configPath, driftedText + " ", "utf-8");
    const tampered = withOwnedBridgeLaunchEnv({ store }, () => {});
    expect(tampered.ok).toBe(false);
    expect(tampered.errors[0]?.code).toBe("state-conflict");
  });
});
