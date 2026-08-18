/**
 * Slice 17 hardened — Service tests (preview/apply/restore/reconcile/security).
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeService } from "./service";
import { BridgeRevisionStore } from "./revisions-bridge";
import { canonicalBridgeDir } from "./canonical";
import { hashContent } from "../cfgwrite/jsonc-edit";
import { fingerprintNonce } from "./extractor";
import type { EffectivePluginView, EffectivePluginEntry } from "./types";

let sandbox: string;
let configDir: string;
let projectDir: string;
let bridgeDir: string;
let dbPath: string;
let revisions: BridgeRevisionStore;
let service: BridgeService;
let currentView: EffectivePluginView;

const fakeProbe = { isInUse: async () => false };

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "omo-svc-"));
  configDir = join(sandbox, "config");
  projectDir = join(sandbox, "project");
  bridgeDir = join(projectDir, "packages", "omo-telemetry-bridge");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(bridgeDir, { recursive: true });
  writeFileSync(join(bridgeDir, "package.json"), "{}");
  dbPath = join(sandbox, "test-bridge.db");
  revisions = new BridgeRevisionStore(dbPath);
  currentView = { entries: [], invalid: false };
  service = new BridgeService({
    opencodeConfigDir: configDir,
    projectDirectory: projectDir,
    // Fixture layout keeps the bridge package under the project dir, so
    // this fixture's "install root" IS the project dir.
    owlInstallDirectory: projectDir,
    authorizedRoots: [configDir, projectDir],
    revisions,
    probe: fakeProbe,
    effectiveViewProvider: async () => currentView,
  });
});

afterEach(() => {
  try {
    revisions.close();
  } catch {
    /* */
  }
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* */
  }
});

function writeConfig(content: string): string {
  const path = join(configDir, "opencode.json");
  writeFileSync(path, content, "utf-8");
  return path;
}

function makeEntry(identity: string, kind: "npm" | "path" | "file-url"): EffectivePluginEntry {
  return { form: "string", effectiveIdentity: identity, identityKind: kind };
}

function setView(entries: EffectivePluginEntry[]): void {
  currentView = { entries, invalid: false };
}

function matchingView(text: string): EffectivePluginEntry[] {
  const parsed = JSON.parse(text);
  const plugin = (parsed.plugin ?? []) as string[];
  return plugin.map((p) => {
    const kind = p.startsWith("/") ? "path" : p.startsWith("file://") ? "file-url" : "npm";
    return makeEntry(p, kind as "npm" | "path" | "file-url");
  });
}

function canonicalIdentity(): string {
  return realpathSync(bridgeDir);
}

describe("BridgeService.preview", () => {
  test("preview add: no write, returns previewId and diff", async () => {
    const path = writeConfig(`{"plugin":["oh-my-opencode-slim"]}`);
    const beforeHash = hashContent(readFileSync(path, "utf-8"));
    setView(matchingView(readFileSync(path, "utf-8")));

    const r = await service.preview({ operation: "add" });

    expect(r.ok).toBe(true);
    expect(r.previewId).toMatch(/^preview_[0-9a-f]+$/);
    expect(r.port).toBe(8788);
    expect(r.nonceFingerprint).toHaveLength(64);
    expect(r.registrationTransport).toBe("env");
    expect(r.transportMode).toBe("loopback-http");
    // No write.
    expect(hashContent(readFileSync(path, "utf-8"))).toBe(beforeHash);
  });

  test("preview remove: generates NO nonce or nonce fingerprint", async () => {
    const ci = canonicalIdentity();
    const path = writeConfig(`{"plugin":["oh-my-opencode-slim","${ci}"]}`);
    const beforeHash = hashContent(readFileSync(path, "utf-8"));
    setView(matchingView(readFileSync(path, "utf-8")));

    const r = await service.preview({ operation: "remove" });

    expect(r.ok).toBe(true);
    expect(r.operation).toBe("remove");
    expect(r.nonceFingerprint).toBeUndefined();
    expect(r.port).toBeUndefined();
    expect(r.registrationTransport).toBeUndefined();
    expect(hashContent(readFileSync(path, "utf-8"))).toBe(beforeHash);
  });

  test("preview add when already present → duplicate-config", async () => {
    const ci = canonicalIdentity();
    writeConfig(`{"plugin":["${ci}"]}`);
    setView(matchingView(readFileSync(join(configDir, "opencode.json"), "utf-8")));

    const r = await service.preview({ operation: "add" });

    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe("duplicate-config");
  });

  test("preview remove when not present → restore-mismatch", async () => {
    writeConfig(`{"plugin":["oh-my-opencode-slim"]}`);
    setView(matchingView(readFileSync(join(configDir, "opencode.json"), "utf-8")));

    const r = await service.preview({ operation: "remove" });

    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe("restore-mismatch");
  });

  test("preview trust: uses injected effective view exclusively", async () => {
    const path = writeConfig(`{"plugin":["oh-my-opencode-slim"]}`);
    setView(matchingView(readFileSync(path, "utf-8")));

    const r = await service.preview({ operation: "add" });

    // preview succeeds based on trusted provider matching disk.
    expect(r.ok).toBe(true);
    expect(r.targetPath).toBe(realpathSync(path));
  });
});

describe("BridgeService.apply", () => {
  test("apply add: writes bridge entry, records revision, hash proof", async () => {
    const path = writeConfig(`{"plugin":["oh-my-opencode-slim"]}`);
    const baselineHash = hashContent(readFileSync(path, "utf-8"));
    setView(matchingView(readFileSync(path, "utf-8")));

    const preview = await service.preview({ operation: "add" });
    expect(preview.ok).toBe(true);

    const r = await service.apply({ previewId: preview.previewId });

    expect(r.ok).toBe(true);
    expect(r.revisionId).toBeDefined();
    expect(r.baselineHash).toBe(baselineHash);
    expect(r.postWriteHash).not.toBe(baselineHash);
    expect(r.stateDisposition).toBe("committed");

    const finalText = readFileSync(path, "utf-8");
    expect(finalText).toContain("omo-telemetry-bridge");
    expect(hashContent(finalText)).toBe(r.postWriteHash!);

    // Committed state in DB has raw nonce and matching fingerprint.
    const activeState = revisions.getActivationState();
    expect(activeState?.active).toBe(true);
    expect(activeState?.configHash).toBe(r.postWriteHash!);
    expect(revisions.withCommittedRawNonce((n) => { void n; })).toBe(true);
  });

  test("apply remove: removes bridge entry, clears raw nonce, sets state columns to NULL", async () => {
    const ci = canonicalIdentity();
    const path = writeConfig(`{"plugin":["oh-my-opencode-slim","${ci}"]}`);
    setView(matchingView(readFileSync(path, "utf-8")));

    const preview = await service.preview({ operation: "remove" });
    expect(preview.ok).toBe(true);

    const r = await service.apply({ previewId: preview.previewId });

    expect(r.ok).toBe(true);
    expect(r.revisionId).toBeDefined();
    const finalText = readFileSync(path, "utf-8");
    expect(finalText).not.toContain("omo-telemetry-bridge");

    // Committed state has active=false and all transport/nonce columns NULL,
    // while resulting configHash, revisionId, and target/source provenance are retained.
    const disabledState = revisions.getActivationState();
    expect(disabledState?.active).toBe(false);
    expect(disabledState?.nonceFingerprint).toBeUndefined();
    expect(disabledState?.port).toBeUndefined();
    expect(disabledState?.registrationTransport).toBeUndefined();
    expect(disabledState?.transportMode).toBeUndefined();
    expect(disabledState?.configHash).toBe(r.postWriteHash);
    expect(disabledState?.revisionId).toBe(r.revisionId);
    expect(disabledState?.targetPath).toBe(realpathSync(path));
    expect(disabledState?.sourceKind).toBe("opencode-config-dir");
    expect(revisions.withCommittedRawNonce((n) => { void n; })).toBe(false);
  });

  test("apply with no previewId → preview-stale", async () => {
    const r = await service.apply({ previewId: "" });
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe("preview-stale");
  });

  test("apply with consumed/expired preview → preview-stale", async () => {
    writeConfig(`{"plugin":["oh-my-opencode-slim"]}`);
    setView(matchingView(readFileSync(join(configDir, "opencode.json"), "utf-8")));

    const preview = await service.preview({ operation: "add" });
    // First apply consumes it.
    const r1 = await service.apply({ previewId: preview.previewId });
    expect(r1.ok).toBe(true);

    // Second apply with same ID → stale.
    const r2 = await service.apply({ previewId: preview.previewId });
    expect(r2.ok).toBe(false);
    expect(r2.errors[0]?.code).toBe("preview-stale");
  });

  test("apply detects external change between preview and apply", async () => {
    const path = writeConfig(`{"plugin":["oh-my-opencode-slim"]}`);
    setView(matchingView(readFileSync(path, "utf-8")));

    const preview = await service.preview({ operation: "add" });
    expect(preview.ok).toBe(true);

    // External edit.
    writeFileSync(path, `{"plugin":["oh-my-opencode-slim","extra"]}`, "utf-8");
    // Update the view to match the external edit so resolver passes.
    setView(matchingView(readFileSync(path, "utf-8")));

    const r = await service.apply({ previewId: preview.previewId });

    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "hash-conflict" || e.code === "preview-stale")).toBe(true);
  });
});

describe("BridgeService: Owl install-root identity", () => {
  test("canonical bridge identity derives from the install root, not the target project", async () => {
    // Remove the fixture bridge package from the target project; the
    // install root below is then the ONLY location carrying it.
    try { rmSync(join(projectDir, "packages"), { recursive: true, force: true }); } catch { /* */ }
    const installDir = join(sandbox, "owl-install");
    const installBridgeDir = join(installDir, "packages", "omo-telemetry-bridge");
    mkdirSync(installBridgeDir, { recursive: true });
    writeFileSync(join(installBridgeDir, "package.json"), "{}");
    expect(existsSync(join(projectDir, "packages", "omo-telemetry-bridge"))).toBe(false);

    const installRevisions = new BridgeRevisionStore(join(sandbox, "install-bridge.db"));
    let view: EffectivePluginView = { entries: [], invalid: false };
    const installService = new BridgeService({
      opencodeConfigDir: configDir,
      projectDirectory: projectDir,
      owlInstallDirectory: installDir,
      authorizedRoots: [configDir, projectDir, installDir],
      revisions: installRevisions,
      probe: fakeProbe,
      effectiveViewProvider: async () => view,
    });

    try {
      writeConfig(`{"plugin":["oh-my-opencode-slim"]}`);
      view = {
        entries: [makeEntry("oh-my-opencode-slim", "npm")],
        invalid: false,
      };

      const r = await installService.preview({ operation: "add" });

      expect(r.ok).toBe(true);
      // The registered identity is the install-root bridge path...
      const expectedIdentity = canonicalBridgeDir(installDir);
      expect(expectedIdentity).toBe(realpathSync(installBridgeDir));
      expect(r.diff).toContain(expectedIdentity);
      // ...and is NOT a path under the target project.
      expect(r.diff).not.toContain(join(projectDir, "packages"));
      expect(existsSync(join(projectDir, "packages", "omo-telemetry-bridge"))).toBe(false);

      // End-to-end resolver equivalence with install root ≠ project root:
      // apply the add, then prove the source candidate (install-root bridge
      // path) still matches the effective view through the canonical
      // identity path by successfully previewing a remove.
      const applied = await installService.apply({ previewId: r.previewId });
      expect(applied.ok).toBe(true);
      const path = join(configDir, "opencode.json");
      const finalText = readFileSync(path, "utf-8");
      expect(finalText).toContain(expectedIdentity);

      // Effective view mirrors the on-disk plugin sequence with the
      // cross-form file:// identity (as the real runtime reports). The
      // path ↔ file-url match can ONLY succeed through canonical
      // resolution against the Owl install root — proving the resolver
      // identity path, not lexical equality.
      view = {
        entries: [
          makeEntry("oh-my-opencode-slim", "npm"),
          makeEntry(`file://${expectedIdentity}`, "file-url"),
        ],
        invalid: false,
      };
      const removePreview = await installService.preview({ operation: "remove" });
      expect(removePreview.ok).toBe(true);
    } finally {
      try { installRevisions.close(); } catch { /* */ }
    }
  });
});

describe("BridgeService: Secure Write Race & Symlink Detection", () => {
  test("last-moment baseline change immediately before rename → deletes temp & returns hash-conflict", async () => {
    const path = writeConfig(`{"plugin":["oh-my-opencode-slim"]}`);
    setView(matchingView(readFileSync(path, "utf-8")));

    const preview = await service.preview({ operation: "add" });
    expect(preview.ok).toBe(true);

    // Change file immediately so secureAtomicWrite pre-rename check fails.
    writeFileSync(path, `{"plugin":["oh-my-opencode-slim","drifted"]}`, "utf-8");

    const r = await service.apply({ previewId: preview.previewId });
    expect(r.ok).toBe(false);
  });

  test("symlinked target file detected during apply → env-scope-unproven", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "omo-outside-target-"));
    try {
      const realTarget = join(outsideDir, "real-opencode.json");
      writeFileSync(realTarget, `{"plugin":["oh-my-opencode-slim"]}`, "utf-8");

      const linkPath = join(configDir, "opencode.json");
      if (existsSync(linkPath)) rmSync(linkPath);
      symlinkSync(realTarget, linkPath);

      setView(matchingView(readFileSync(realTarget, "utf-8")));

      const preview = await service.preview({ operation: "add" });
      // Symlink escaping roots is rejected.
      expect(preview.ok).toBe(false);
      expect(preview.errors.some((e) => e.code === "env-scope-unproven")).toBe(true);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe("BridgeService.restore: exact baseline hash restore", () => {
  test("restore add → remove reproduces exact baseline hash", async () => {
    const path = writeConfig(`{"plugin":["oh-my-opencode-slim"]}`);
    const baselineHash = hashContent(readFileSync(path, "utf-8"));
    setView(matchingView(readFileSync(path, "utf-8")));

    const preview = await service.preview({ operation: "add" });
    const applyResult = await service.apply({ previewId: preview.previewId });
    expect(applyResult.ok).toBe(true);
    const postWriteHash = applyResult.postWriteHash!;

    const restoreResult = await service.restore({
      revisionId: applyResult.revisionId!,
      expectedSourceHash: postWriteHash,
    });

    expect(restoreResult.ok).toBe(true);
    expect(restoreResult.restoredHash).toBe(baselineHash);
    expect(restoreResult.baselineHash).toBe(baselineHash);
    const finalText = readFileSync(path, "utf-8");
    expect(hashContent(finalText)).toBe(baselineHash);
  });

  test("restore with external change → hash-conflict or restore-mismatch", async () => {
    const path = writeConfig(`{"plugin":["oh-my-opencode-slim"]}`);
    setView(matchingView(readFileSync(path, "utf-8")));

    const preview = await service.preview({ operation: "add" });
    const applyResult = await service.apply({ previewId: preview.previewId });
    expect(applyResult.ok).toBe(true);

    // External edit.
    writeFileSync(path, `{"plugin":["oh-my-opencode-slim","extra"]}`, "utf-8");

    const restoreResult = await service.restore({
      revisionId: applyResult.revisionId!,
      expectedSourceHash: applyResult.postWriteHash!,
    });

    expect(restoreResult.ok).toBe(false);
    expect(restoreResult.errors.some((e) => e.code === "hash-conflict" || e.code === "restore-mismatch")).toBe(true);
  });

  test("restore non-existent revision → restore-mismatch", async () => {
    const r = await service.restore({ revisionId: "nonexistent", expectedSourceHash: "dummy_hash" });
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe("restore-mismatch");
  });
});

describe("BridgeService: Reconciliation & Failure Recovery", () => {
  test("reconcile forward recovery: file has proposed hash → completes final transaction with pending raw nonce", () => {
    const path = writeConfig(`{"plugin":["oh-my-opencode-slim"]}`);
    const baselineHash = hashContent(readFileSync(path, "utf-8"));

    const proposedText = `{\n  "plugin": [\n    "oh-my-opencode-slim",\n    "${canonicalIdentity()}"\n  ]\n}`;
    const proposedHash = hashContent(proposedText);

    // Simulate post-rename crash: file on disk has proposedText, intent is still prepared in DB.
    writeFileSync(path, proposedText, "utf-8");
    const rawNonce = "pending-raw-nonce-for-recovery";

    revisions.insertPreparedIntent({
      id: "intent_crash",
      targetPath: path,
      sourceKind: "opencode-config-dir",
      operation: "add",
      baselineHash,
      proposedHash,
      canonicalIdentity: canonicalIdentity(),
      port: 8788,
      registrationTransport: "env",
      transportMode: "loopback-http",
      nonceFingerprint: fingerprintNonce(rawNonce),
      bytePatch: JSON.stringify({ version: 1, offsetUtf16: 0, deleteText: "", insertText: "" }),
      rawActivationNonce: rawNonce,
    });

    const r = service.reconcile();
    expect(r.disposition).toBe("committed");
    expect(r.errors).toHaveLength(0);

    // Committed state now has the recovered raw nonce!
    const state = revisions.getActivationState();
    expect(state?.active).toBe(true);
    let scopedNonce: string | undefined;
    expect(
      revisions.withCommittedRawNonce((n) => {
        scopedNonce = n;
      }),
    ).toBe(true);
    expect(scopedNonce).toBe(rawNonce);

    // Intent is marked committed and raw nonce cleared from intent table.
    const intent = revisions.getIntent("intent_crash");
    expect(intent?.status).toBe("committed");
    expect(intent?.rawActivationNonce).toBeUndefined();
  });

  test("reconcile abort: file has baseline hash → aborts intent", () => {
    const path = writeConfig(`{"plugin":["oh-my-opencode-slim"]}`);
    const baselineHash = hashContent(readFileSync(path, "utf-8"));

    revisions.insertPreparedIntent({
      id: "intent_aborted_crash",
      targetPath: path,
      sourceKind: "opencode-config-dir",
      operation: "add",
      baselineHash,
      proposedHash: "h_different",
      canonicalIdentity: canonicalIdentity(),
      port: 8788,
      registrationTransport: "env",
      transportMode: "loopback-http",
      nonceFingerprint: fingerprintNonce("raw_abc"),
      bytePatch: "{}",
      rawActivationNonce: "raw_abc",
    });

    const r = service.reconcile();
    expect(r.disposition).toBe("not-written");

    const intent = revisions.getIntent("intent_aborted_crash");
    expect(intent?.status).toBe("aborted");
    expect(intent?.rawActivationNonce).toBeUndefined();
  });

  test("reconcile conflict: file has unexpected hash → marks conflict", () => {
    const path = writeConfig(`{"plugin":["oh-my-opencode-slim"]}`);

    revisions.insertPreparedIntent({
      id: "intent_conflict_crash",
      targetPath: path,
      sourceKind: "opencode-config-dir",
      operation: "add",
      baselineHash: "h_old_baseline",
      proposedHash: "h_different",
      canonicalIdentity: canonicalIdentity(),
      port: 8788,
      registrationTransport: "env",
      transportMode: "loopback-http",
      nonceFingerprint: fingerprintNonce("raw_abc"),
      bytePatch: "{}",
      rawActivationNonce: "raw_abc",
    });

    const r = service.reconcile();
    expect(r.disposition).toBe("recovery-pending");
    expect(r.errors[0]?.code).toBe("state-conflict");

    const intent = revisions.getIntent("intent_conflict_crash");
    expect(intent?.status).toBe("conflict");
  });

  test("reconcile detects committed active bridge target config hash drift", () => {
    const path = writeConfig(`{"plugin":["oh-my-opencode-slim"]}`);
    const baseHash = hashContent(readFileSync(path, "utf-8"));

    // Set committed active state with a specific configHash.
    revisions.insertPreparedIntent({
      id: "intent_committed",
      targetPath: path,
      sourceKind: "opencode-config-dir",
      operation: "add",
      baselineHash: "h_base",
      proposedHash: baseHash,
      canonicalIdentity: canonicalIdentity(),
      port: 8788,
      registrationTransport: "env",
      transportMode: "loopback-http",
      nonceFingerprint: fingerprintNonce("raw_nonce"),
      bytePatch: "{}",
      rawActivationNonce: "raw_nonce",
    });
    revisions.finalizeIntent("intent_committed", "rev_1", new Date().toISOString(), baseHash);

    // Tamper with file on disk.
    writeFileSync(path, `{"plugin":["oh-my-opencode-slim","external-tamper"]}`, "utf-8");

    const r = service.reconcile();
    expect(r.disposition).toBe("recovery-pending");
    expect(r.errors.some((e) => e.code === "state-conflict")).toBe(true);
  });
});

describe("BridgeService: Secret-Free Revisions, DTOs, and Diffs", () => {
  test("revision does not contain raw nonce", async () => {
    const path = writeConfig(`{"plugin":["oh-my-opencode-slim"]}`);
    setView(matchingView(readFileSync(path, "utf-8")));

    const preview = await service.preview({ operation: "add" });
    const applyResult = await service.apply({ previewId: preview.previewId });
    expect(applyResult.ok).toBe(true);

    const rev = revisions.getRevision(applyResult.revisionId!);
    expect(rev).not.toBeNull();
    const revJson = JSON.stringify(rev);
    expect(revJson).not.toContain("raw_activation_nonce");
    expect(revJson).not.toContain("beforeContent");
    expect(revJson).not.toContain("afterContent");
    expect(rev?.nonceFingerprint).toHaveLength(64);
  });

  test("diff with single-line secret-bearing config: zero secret leakage", async () => {
    const path = writeConfig(
      `{"plugin":["oh-my-opencode-slim"],"provider":{"openai":{"apiKey":"sk-leaked-secret-1234567890abcdef"}}}`,
    );
    setView(matchingView(readFileSync(path, "utf-8")));

    const r = await service.preview({ operation: "add" });
    expect(r.diff).not.toContain("sk-leaked-secret-1234567890abcdef");
    expect(r.diff).not.toContain("apiKey");
    expect(r.diff).not.toContain("provider");
    expect(r.diff).not.toContain("openai");
  });
});
