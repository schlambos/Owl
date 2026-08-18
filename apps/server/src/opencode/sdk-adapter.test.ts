import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import {
  __testOwnedLaunchEnvOverlay,
  sanitizeSdkStartError,
  type BridgeLaunchBoundaryError,
} from "./sdk-adapter";
import { BridgeRevisionStore } from "../opencode-bridge/revisions-bridge";
import { fingerprintNonce } from "../opencode-bridge/extractor";
import { hashContent } from "../cfgwrite/jsonc-edit";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), ".config", "opencode");
const SDK_ROOT = join(CONFIG_DIR, "node_modules", "@opencode-ai", "sdk");

describe("installed SDK lifecycle contract", () => {
  test("active-config SDK is 1.18.14 and preserves port:0 actual-url contract", () => {
    const pkg = JSON.parse(readFileSync(`${SDK_ROOT}/package.json`, "utf8")) as {
      version: string;
    };
    const source = readFileSync(`${SDK_ROOT}/dist/server.js`, "utf8");
    const types = readFileSync(`${SDK_ROOT}/dist/server.d.ts`, "utf8");
    expect(pkg.version).toBe("1.18.14");
    expect(source).toContain("`--port=${options.port}`");
    expect(source).toContain("resolve(match[1])");
    expect(source).toContain("...process.env");
    expect(types).toContain("port?: number");
    expect(types).toContain("url: string");
    expect(types).toContain("close(): void");
    expect(types).not.toContain("pid:");
  });

  test("the OS returns a concrete alternate port for a loopback port:0 bind", async () => {
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      expect(typeof address).toBe("object");
      expect(address && typeof address === "object" ? address.port : 0).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ── Slice 17: owned launch env overlay ──────────────────────────────────

describe("owned launch env overlay (sdk-adapter)", () => {
  let sandbox: string;
  let dbPath: string;
  let store: BridgeRevisionStore;
  let configPath: string;

  function setup(): void {
    sandbox = mkdtempSync(join(tmpdir(), "omo-sdk-launch-"));
    dbPath = join(sandbox, "data", "bridge.db");
    store = new BridgeRevisionStore(dbPath);
    configPath = join(sandbox, "opencode.json");
  }

  function teardown(): void {
    try { store.close(); } catch { /* */ }
    try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* */ }
  }

  test("disabled/inactive bridge invokes spawn with empty overlay and restores parent env", () => {
    setup();
    try {
      // Set stale env values to prove they are deleted and restored.
      process.env.OMO_BRIDGE_PORT = "stale-port";
      process.env.OMO_BRIDGE_ACTIVATION_NONCE = "stale-nonce";

      let capturedOverlay: Record<string, string | undefined> | undefined;
      const result = __testOwnedLaunchEnvOverlay(undefined, (overlay) => {
        capturedOverlay = { ...overlay };
      });

      expect(result.ok).toBe(true);
      // Callback return is discarded: the result carries no value channel.
      expect("value" in result).toBe(false);
      // Overlay is empty (disabled lane / no store).
      expect(capturedOverlay).toEqual({});
      // Parent env restored exactly.
      expect(result.envAfterRestore.OMO_BRIDGE_PORT).toBe("stale-port");
      expect(result.envAfterRestore.OMO_BRIDGE_ACTIVATION_NONCE).toBe("stale-nonce");
      // Process env is restored.
      expect(process.env.OMO_BRIDGE_PORT).toBe("stale-port");
      expect(process.env.OMO_BRIDGE_ACTIVATION_NONCE).toBe("stale-nonce");
    } finally {
      delete process.env.OMO_BRIDGE_PORT;
      delete process.env.OMO_BRIDGE_ACTIVATION_NONCE;
      teardown();
    }
  });

  test("active committed bridge passes port+nonce to spawn synchronously and restores parent env", () => {
    setup();
    try {
      const rawNonce = "super-secret-nonce-1234567890abcdef";
      const nonceFp = fingerprintNonce(rawNonce);
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
        canonicalIdentity: "/canonical/bridge",
        port: 8788,
        registrationTransport: "env",
        transportMode: "loopback-http",
        nonceFingerprint: nonceFp,
        bytePatch: "{}",
        rawActivationNonce: rawNonce,
      });
      store.finalizeIntent("intent_active", "rev_1", new Date().toISOString(), cfgHash);

      // Parent env has no bridge vars.
      delete process.env.OMO_BRIDGE_PORT;
      delete process.env.OMO_BRIDGE_ACTIVATION_NONCE;

      let capturedOverlay: Record<string, string | undefined> | undefined;
      const result = __testOwnedLaunchEnvOverlay(store, (overlay) => {
        capturedOverlay = { ...overlay };
      });

      expect(result.ok).toBe(true);
      expect("value" in result).toBe(false);
      // Overlay seen by synchronous spawn.
      expect(capturedOverlay).toEqual({
        OMO_BRIDGE_PORT: "8788",
        OMO_BRIDGE_ACTIVATION_NONCE: rawNonce,
      });
      // Parent env restored (both absent).
      expect(result.envAfterRestore.OMO_BRIDGE_PORT).toBeUndefined();
      expect(result.envAfterRestore.OMO_BRIDGE_ACTIVATION_NONCE).toBeUndefined();
      // Process env restored.
      expect(process.env.OMO_BRIDGE_PORT).toBeUndefined();
      expect(process.env.OMO_BRIDGE_ACTIVATION_NONCE).toBeUndefined();

      // Raw nonce absent from result snapshot.
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(rawNonce);
      expect(serialized).not.toContain("super-secret-nonce");
    } finally {
      delete process.env.OMO_BRIDGE_PORT;
      delete process.env.OMO_BRIDGE_ACTIVATION_NONCE;
      teardown();
    }
  });

  test("spawn throw restores parent env and fails closed", () => {
    setup();
    try {
      process.env.OMO_BRIDGE_PORT = "parent-port";
      process.env.OMO_BRIDGE_ACTIVATION_NONCE = "parent-nonce";

      const result = __testOwnedLaunchEnvOverlay(undefined, () => {
        throw new Error("spawn crashed");
      });

      expect(result.ok).toBe(false);
      // Parent env restored even on throw.
      expect(result.envAfterRestore.OMO_BRIDGE_PORT).toBe("parent-port");
      expect(result.envAfterRestore.OMO_BRIDGE_ACTIVATION_NONCE).toBe("parent-nonce");
      expect(process.env.OMO_BRIDGE_PORT).toBe("parent-port");
      expect(process.env.OMO_BRIDGE_ACTIVATION_NONCE).toBe("parent-nonce");
    } finally {
      delete process.env.OMO_BRIDGE_PORT;
      delete process.env.OMO_BRIDGE_ACTIVATION_NONCE;
      teardown();
    }
  });

  test("dirty reconciliation blocks launch before spawn with redacted error", () => {
    setup();
    try {
      store.insertPreparedIntent({
        id: "intent_dirty",
        targetPath: configPath,
        sourceKind: "opencode-config-dir",
        operation: "add",
        baselineHash: "h1",
        proposedHash: "h2",
        canonicalIdentity: "/bridge",
        bytePatch: "{}",
      });

      let spawnCalled = false;
      const result = __testOwnedLaunchEnvOverlay(store, () => {
        spawnCalled = true;

      });

      expect(result.ok).toBe(false);
      expect(spawnCalled).toBe(false);
      expect(result.errors[0]?.code).toBe("state-recovery-pending");
      // Raw nonce absent from errors.
      const serialized = JSON.stringify(result.errors);
      expect(serialized).not.toContain("nonce");
    } finally {
      teardown();
    }
  });

  test("stale env values are deleted before applying overlay", () => {
    setup();
    try {
      const rawNonce = "fresh-nonce-1234567890abcdef";
      const nonceFp = fingerprintNonce(rawNonce);
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
        canonicalIdentity: "/canonical/bridge",
        port: 8789,
        registrationTransport: "env",
        transportMode: "loopback-http",
        nonceFingerprint: nonceFp,
        bytePatch: "{}",
        rawActivationNonce: rawNonce,
      });
      store.finalizeIntent("intent_active", "rev_1", new Date().toISOString(), cfgHash);

      // Stale values present.
      process.env.OMO_BRIDGE_PORT = "stale-port";
      process.env.OMO_BRIDGE_ACTIVATION_NONCE = "stale-nonce";

      let capturedOverlay: Record<string, string | undefined> | undefined;
      const result = __testOwnedLaunchEnvOverlay(store, (overlay) => {
        capturedOverlay = { ...overlay };
        // Verify the process env has the FRESH overlay, not stale.
        expect(process.env.OMO_BRIDGE_PORT).toBe("8789");
        expect(process.env.OMO_BRIDGE_ACTIVATION_NONCE).toBe(rawNonce);

      });

      expect(result.ok).toBe(true);
      expect(capturedOverlay).toEqual({
        OMO_BRIDGE_PORT: "8789",
        OMO_BRIDGE_ACTIVATION_NONCE: rawNonce,
      });
      // Parent env restored to stale values.
      expect(result.envAfterRestore.OMO_BRIDGE_PORT).toBe("stale-port");
      expect(result.envAfterRestore.OMO_BRIDGE_ACTIVATION_NONCE).toBe("stale-nonce");
    } finally {
      delete process.env.OMO_BRIDGE_PORT;
      delete process.env.OMO_BRIDGE_ACTIVATION_NONCE;
      teardown();
    }
  });

  test("SDK error sanitization redacts raw nonce and provider credentials", async () => {
    // This test verifies that startManagedSdkServer sanitizes SDK errors
    // with sanitizeOpenCodeError, ensuring the raw nonce and provider
    // credentials cannot leak through child stderr in the thrown error.
    //
    // We test the sanitization path directly by importing the helper.
    const { sanitizeOpenCodeError } = await import("./security");
    const rawNonce = "super-secret-nonce-1234567890abcdef";
    const providerKey = "sk-provider-secret-key-12345";
    const rawError = `child stderr: nonce=${rawNonce} key=${providerKey} ECONNREFUSED`;

    const sanitized = sanitizeOpenCodeError(rawError, [rawNonce, providerKey]);
    expect(sanitized).not.toContain(rawNonce);
    expect(sanitized).not.toContain("super-secret-nonce");
    expect(sanitized).not.toContain(providerKey);
    expect(sanitized).toContain("[redacted]");
  });
});
// ── Phase 2 Gate 2: launch-nonce confinement in async SDK rejections ────

describe("sanitizeSdkStartError (launch nonce confinement)", () => {
  test("synthetic SDK rejection containing the launch nonce is redacted", () => {
    const launchNonce = "launch-nonce-sentinel-0123456789abcdef";
    const parentNonce = "parent-env-nonce-sentinel-abcdef0123456789";
    const parentPort = "8711";
    const redact = (text: string) => text.split(launchNonce).join("[redacted]");
    const synthetic = new Error(
      `OpenCode server failed: stderr contained nonce=${launchNonce} parent=${parentNonce} port=${parentPort}`,
    );

    const sanitized = sanitizeSdkStartError(
      synthetic,
      [parentNonce, parentPort],
      redact,
    );
    expect(sanitized).not.toContain(launchNonce);
    expect(sanitized).not.toContain("launch-nonce-sentinel");
    expect(sanitized).not.toContain(parentNonce);
    expect(sanitized).not.toContain(parentPort);
    expect(sanitized).toContain("[redacted]");
  });

  test("without a redactor, parent env secrets are still redacted", () => {
    const parentNonce = "parent-env-nonce-sentinel-abcdef0123456789";
    const sanitized = sanitizeSdkStartError(
      new Error(`failure with ${parentNonce}`),
      [parentNonce],
    );
    expect(sanitized).not.toContain(parentNonce);
  });

  test("redactor closure redacts without exposing the nonce", () => {
    const secret = "closure-secret-nonce-0123456789ab";
    const redact = (text: string) => text.split(secret).join("[redacted]");
    const out = redact(`prefix ${secret} suffix ${secret}`);
    expect(out).toBe("prefix [redacted] suffix [redacted]");
    expect(out).not.toContain(secret);
  });
});

describe("sanitizeSdkStartError redaction order (Gate 2 attempt 2)", () => {
  test("long-prefix + boundary-spanning 64-char nonce is fully redacted pre-normalization", () => {
    const launchNonce = "b7f4".repeat(16); // 64 lowercase hex chars
    const parentSecret = "parent-env-secret-value-0123456789";
    const redact = (text: string) => text.split(launchNonce).join("[redacted]");
    // The nonce straddles the sanitizer's 240-char truncation boundary: if
    // redaction ran AFTER normalization/truncation, the nonce's surviving
    // prefix would leak. Pre-redaction must remove it entirely.
    const longPrefix = "p".repeat(200); // nonce starts before the 240 cap…
    const synthetic = new Error(
      `${longPrefix} nonce=${launchNonce} trailing parent=${parentSecret}`,
    );

    const sanitized = sanitizeSdkStartError(synthetic, [parentSecret], redact);
    // No full nonce…
    expect(sanitized).not.toContain(launchNonce);
    // …and no meaningful partial substring (first/last 16 chars).
    expect(sanitized).not.toContain(launchNonce.slice(0, 16));
    expect(sanitized).not.toContain(launchNonce.slice(-16));
    expect(sanitized).not.toContain(parentSecret);
    expect(sanitized).toContain("[redacted]");
  });

  test("redactor applies to the original error before whitespace normalization", () => {
    // A nonce adjacent to whitespace that normalization would collapse: the
    // redactor still sees the exact original bytes.
    const launchNonce = "c9e1".repeat(16);
    const redact = (text: string) => text.split(launchNonce).join("[redacted]");
    const synthetic = new Error(`a\n\n${launchNonce}\n\nb`);
    const sanitized = sanitizeSdkStartError(synthetic, [], redact);
    expect(sanitized).not.toContain(launchNonce);
    expect(sanitized).toContain("[redacted]");
  });
});
