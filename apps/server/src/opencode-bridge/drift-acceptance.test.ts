/**
 * Drift-acceptance proof engine + service two-phase tests (metadata-only
 * trust rebase). Temp fixtures/DBs only — no live routes, no live config,
 * no live DB, no processes, no production ports.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { BridgeRevisionStore } from "./revisions-bridge";
import { BridgeService } from "./service";
import { canonicalBridgeDir } from "./canonical";
import { computeAddPatch, applyPatch } from "./byte-patch";
import { hashContent } from "../cfgwrite/jsonc-edit";
import { fingerprintNonce } from "./extractor";
import { computeDriftAcceptanceProof } from "./drift-acceptance";
import {
  DRIFT_ACCEPT_ACKNOWLEDGEMENT,
  DRIFT_ACCEPT_CONFIRMATION_TOKEN,
} from "./types";

const RAW_NONCE = "drift-test-raw-nonce-0123456789ab";
const NONCE_FP = fingerprintNonce(RAW_NONCE);
const SECRET_PATH = "/Users/secret/arbitrary-provider-path-with-token-xyz";

interface Fixture {
  sandbox: string;
  projectDir: string;
  configDir: string;
  configPath: string;
  canonicalIdentity: string;
  store: BridgeRevisionStore;
  service: BridgeService;
  committedHash: string;
  revisionId: string;
  /** Text with the bridge committed (pre-drift). */
  committedText: string;
  effectiveViewCalls: { count: number };
}

let fixture: Fixture | undefined;

function buildFixture(opts: { drift?: (text: string, canonicalIdentity: string) => string } = {}): Fixture {
  const sandbox = mkdtempSync(join(tmpdir(), "omo-drift-"));
  const projectDir = join(sandbox, "proj");
  const configDir = join(sandbox, "ocfg");
  mkdirSync(join(projectDir, "packages", "omo-telemetry-bridge"), {
    recursive: true,
  });
  mkdirSync(configDir, { recursive: true });
  const canonicalIdentity = canonicalBridgeDir(projectDir);
  const configPath = join(projectDir, "opencode.json");

  // Committed content: root object with the canonical bridge entry.
  const text0 = `{\n  "plugin": []\n}\n`;
  const added = computeAddPatch(text0, canonicalIdentity);
  if ("errors" in added) throw new Error("fixture add patch failed");
  const text1 = added.proposedText;
  writeFileSync(configPath, text1, "utf-8");
  const committedHash = hashContent(text1);

  const store = new BridgeRevisionStore(join(sandbox, "data", "bridge.db"));
  const intentId = "intent_fixture_add";
  store.insertPreparedIntent({
    id: intentId,
    targetPath: configPath,
    sourceKind: "project-root",
    operation: "add",
    baselineHash: hashContent(text0),
    proposedHash: committedHash,
    canonicalIdentity,
    port: 8788,
    registrationTransport: "env",
    transportMode: "loopback-http",
    nonceFingerprint: NONCE_FP,
    bytePatch: JSON.stringify(added.patch),
    rawActivationNonce: RAW_NONCE,
  });
  const revisionId = "brev_fixture_add";
  expect(store.finalizeIntent(intentId, revisionId, new Date().toISOString(), committedHash)).toBe(true);

  const effectiveViewCalls = { count: 0 };
  const service = new BridgeService({
    opencodeConfigDir: configDir,
    projectDirectory: projectDir,
    // Fixture install root carries the bridge package under the project
    // dir (canonicalIdentity above stays consistent).
    owlInstallDirectory: projectDir,
    authorizedRoots: [sandbox],
    revisions: store,
    effectiveViewProvider: async () => {
      effectiveViewCalls.count++;
      throw new Error("effective view must never be called by drift paths");
    },
  });

  const fx: Fixture = {
    sandbox, projectDir, configDir, configPath, canonicalIdentity,
    store, service, committedHash, revisionId, committedText: text1,
    effectiveViewCalls,
  };

  if (opts.drift) {
    writeFileSync(configPath, opts.drift(text1, canonicalIdentity), "utf-8");
  }
  fixture = fx;
  return fx;
}

function observedHash(fx: Fixture): string {
  return hashContent(readFileSync(fx.configPath, "utf-8"));
}

function previewReq(fx: Fixture) {
  return {
    expectedRevisionId: fx.revisionId,
    expectedCommittedHash: fx.committedHash,
    expectedObservedHash: observedHash(fx),
  };
}

function proofReq(fx: Fixture) {
  return previewReq(fx);
}

function proofDeps(fx: Fixture, overrideActive = false) {
  return {
    store: fx.store,
    opencodeConfigDir: fx.configDir,
    projectDirectory: fx.projectDir,
    // Fixture bridge package is co-located under the project dir.
    owlInstallDirectory: fx.projectDir,
    authorizedRoots: [fx.sandbox],
    overrideActive,
  };
}

/** Default drift: add an unknown top-level key + provider-looking value. */
const DEFAULT_DRIFT = (text: string): string =>
  text.replace(
    `"plugin": [`,
    `"zz-custom-opaque": {"token": "provider-secret-sentinel-123"},\n  "plugin": [`,
  );

beforeEach(() => {
  fixture = undefined;
});

afterEach(() => {
  if (fixture !== undefined) {
    try { fixture.store.close(); } catch { /* */ }
    rmSync(fixture.sandbox, { recursive: true, force: true });
    fixture = undefined;
  }
});

/* ------------------------------------------------------------------ */
/* Happy path                                                           */
/* ------------------------------------------------------------------ */

describe("drift proof: happy path", () => {
  test("valid drift produces a sanitized proof with exact limitation booleans", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    const r = computeDriftAcceptanceProof(proofDeps(fx), proofReq(fx));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.proof;
    expect(p.oldCommittedHash).toBe(fx.committedHash);
    expect(p.observedHash).toBe(observedHash(fx));
    expect(p.expectedRevisionId).toBe(fx.revisionId);
    expect(p.canonicalBridgeIndex).toBe(0);
    expect(p.anchorRevisionId).toBe("brev_fixture_add");
    expect(p.anchorPresent).toBe(true);
    expect(p.fragmentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(p.patchDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(p.preserved).toEqual({
      port: 8788,
      transportMode: "loopback-http",
      canonicalIdentity: fx.canonicalIdentity,
      nonceFingerprint: NONCE_FP,
    });
    expect(p.limitations).toEqual({
      historicalContentAvailable: false,
      fullDiffAvailable: false,
      contentEquivalenceProven: false,
      nonBridgeChangesOpaque: true,
      canonicalBridgeContinuityProven: true,
      configWritePlanned: false,
      runtimeActionPlanned: "none",
      rollbackAvailable: false,
    });
    expect(p.topLevel.knownKeysPresent).toContain("plugin");
    expect(p.topLevel.totalCount).toBe(2);
    expect(p.topLevel.unknownCount).toBe(1); // zz-custom-opaque
    // Sanitization: no raw config text, no raw nonce, no provider sentinel.
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain(RAW_NONCE);
    expect(serialized).not.toContain("provider-secret-sentinel-123");
    expect(serialized).not.toContain("zz-custom-opaque");
  });

  test("noncanonical entries appear only as SHA-256 fingerprints", () => {
    const fx = buildFixture({
      drift: (t) =>
        t.replace(
          `"plugin": [`,
          `"plugin": ["${SECRET_PATH}", "oh-my-opencode-slim", "./relative/local-plugin.ts", "file:///Users/secret/file-url-plugin",`,
        ),
    });
    // Reorder so the canonical entry is not first; also relocation check.
    const r = computeDriftAcceptanceProof(proofDeps(fx), proofReq(fx));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proof.pluginSequence.length).toBe(5);
    const canonical = r.proof.pluginSequence.find((e) => e.label === "managed-telemetry-bridge");
    expect(canonical).toBeDefined();
    expect(canonical?.index).toBe(4);
    const others = r.proof.pluginSequence.filter((e) => e.label === undefined);
    for (const o of others) {
      expect(o.identityFingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
    const serialized = JSON.stringify(r.proof);
    expect(serialized).not.toContain(SECRET_PATH);
    expect(serialized).not.toContain("file:///Users/secret/file-url-plugin");
    expect(serialized).not.toContain("./relative/local-plugin.ts");
    expect(serialized).not.toContain("oh-my-opencode-slim");
  });

  test("bridge entry relocation (array reorder) still passes — anchor fragment occurs once", () => {
    // Manual construction matching the pretty-printed add format so the
    // exact insert fragment still occurs exactly once after relocation.
    const fx = buildFixture();
    const relocated =
      `{\n  "plugin": [\n    "oh-my-opencode-slim",\n    "${fx.canonicalIdentity}"\n  ]\n}\n`;
    writeFileSync(fx.configPath, relocated, "utf-8");
    const r = computeDriftAcceptanceProof(proofDeps(fx), proofReq(fx));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proof.canonicalBridgeIndex).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Eligibility failures (drift-not-eligible)                            */
/* ------------------------------------------------------------------ */

describe("drift proof: eligibility", () => {
  test("override active → drift-not-eligible", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    const r = computeDriftAcceptanceProof(proofDeps(fx, true), proofReq(fx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-not-eligible");
  });

  test("unresolved intent → drift-not-eligible", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    fx.store.insertPreparedIntent({
      id: "intent_dangling",
      targetPath: fx.configPath,
      sourceKind: "project-root",
      operation: "add",
      baselineHash: "h1",
      proposedHash: "h2",
      canonicalIdentity: fx.canonicalIdentity,
      bytePatch: "{}",
    });
    const r = computeDriftAcceptanceProof(proofDeps(fx), proofReq(fx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-not-eligible");
  });

  test("disabled (inactive) committed state → drift-not-eligible", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    // Commit a remove to disable.
    fx.store.insertPreparedIntent({
      id: "intent_remove",
      targetPath: fx.configPath,
      sourceKind: "project-root",
      operation: "remove",
      baselineHash: fx.committedHash,
      proposedHash: "h_removed",
      canonicalIdentity: fx.canonicalIdentity,
      bytePatch: "{}",
    });
    fx.store.finalizeIntent("intent_remove", "brev_remove", new Date().toISOString(), "h_removed");
    const r = computeDriftAcceptanceProof(proofDeps(fx), proofReq(fx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-not-eligible");
  });

  test("wrong expected revision/hash → drift-not-eligible", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    const r1 = computeDriftAcceptanceProof(proofDeps(fx), {
      ...proofReq(fx),
      expectedRevisionId: "brev_wrong",
    });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.errors[0]!.code).toBe("drift-not-eligible");
    const r2 = computeDriftAcceptanceProof(proofDeps(fx), {
      ...proofReq(fx),
      expectedCommittedHash: "0".repeat(64),
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.errors[0]!.code).toBe("drift-not-eligible");
  });

  test("incomplete committed state (missing fingerprint) → drift-not-eligible", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    const db = new Database(join(fx.sandbox, "data", "bridge.db"));
    db.query("UPDATE bridge_activation_state SET nonce_fingerprint = NULL WHERE id = 1").run();
    db.close();
    const r = computeDriftAcceptanceProof(proofDeps(fx), proofReq(fx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-not-eligible");
  });

  test("no drift (observed == committed) → drift-not-eligible", () => {
    const fx = buildFixture(); // no drift
    const r = computeDriftAcceptanceProof(proofDeps(fx), proofReq(fx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-not-eligible");
  });
});

/* ------------------------------------------------------------------ */
/* Proof failures (drift-proof-failed)                                  */
/* ------------------------------------------------------------------ */

describe("drift proof: file/content failures", () => {
  test("observed hash mismatch with file content → drift-proof-failed", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    const r = computeDriftAcceptanceProof(proofDeps(fx), {
      ...proofReq(fx),
      expectedObservedHash: "f".repeat(64),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-proof-failed");
  });

  test("symlink target → drift-proof-failed", () => {
    const fx = buildFixture();
    const real = join(fx.sandbox, "real-target.json");
    rmSync(fx.configPath);
    writeFileSync(real, DEFAULT_DRIFT(fx.committedText), "utf-8");
    symlinkSync(real, fx.configPath);
    const r = computeDriftAcceptanceProof(proofDeps(fx), {
      expectedRevisionId: fx.revisionId,
      expectedCommittedHash: fx.committedHash,
      expectedObservedHash: hashContent(DEFAULT_DRIFT(fx.committedText)),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-proof-failed");
  });

  test("directory target → drift-proof-failed", () => {
    const fx = buildFixture();
    rmSync(fx.configPath);
    mkdirSync(fx.configPath);
    const r = computeDriftAcceptanceProof(proofDeps(fx), {
      expectedRevisionId: fx.revisionId,
      expectedCommittedHash: fx.committedHash,
      expectedObservedHash: "f".repeat(64),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-proof-failed");
  });

  test("root escape (target outside authorized roots) → drift-proof-failed", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    const r = computeDriftAcceptanceProof(
      {
        store: fx.store,
        opencodeConfigDir: fx.configDir,
        projectDirectory: fx.projectDir,
        owlInstallDirectory: fx.projectDir,
        authorizedRoots: [join(fx.sandbox, "nowhere")],
        overrideActive: false,
      },
      proofReq(fx),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-proof-failed");
  });

  test("invalid UTF-8 → drift-proof-failed", () => {
    const fx = buildFixture();
    const bytes = Buffer.concat([
      Buffer.from(fx.committedText, "utf8"),
      Buffer.from([0xff, 0xfe, 0xfd]),
    ]);
    writeFileSync(fx.configPath, bytes);
    const r = computeDriftAcceptanceProof(proofDeps(fx), proofReq(fx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-proof-failed");
  });

  test("oversize file → drift-proof-failed", () => {
    const fx = buildFixture();
    writeFileSync(
      fx.configPath,
      fx.committedText + " ".repeat(300 * 1024),
      "utf-8",
    );
    const r = computeDriftAcceptanceProof(proofDeps(fx), proofReq(fx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-proof-failed");
  });

  test("malformed JSONC → drift-proof-failed", () => {
    const fx = buildFixture({ drift: () => `{ not json at all ` });
    const r = computeDriftAcceptanceProof(proofDeps(fx), proofReq(fx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-proof-failed");
  });

  test("non-object root → drift-proof-failed", () => {
    const fx = buildFixture({ drift: () => `["array", "root"]` });
    const r = computeDriftAcceptanceProof(proofDeps(fx), proofReq(fx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-proof-failed");
  });

  test("duplicate top-level keys → drift-proof-failed", () => {
    const fx = buildFixture({
      drift: (t) =>
        t.replace(
          `"plugin": [`,
          `"theme": "dark",\n  "plugin": [`,
        ).replace(/\}\s*$/, `,\n  "theme": "light"\n}\n`),
    });
    const r = computeDriftAcceptanceProof(proofDeps(fx), proofReq(fx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-proof-failed");
  });

  test("unsupported plugin entry shape → drift-proof-failed", () => {
    const fx = buildFixture({
      drift: (t) => t.replace(`"plugin": [`, `"plugin": [42,`),
    });
    const r = computeDriftAcceptanceProof(proofDeps(fx), proofReq(fx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-proof-failed");
  });
});

describe("drift proof: bridge identity failures", () => {
  test("bridge missing → drift-proof-failed", () => {
    const fx = buildFixture({
      drift: () => `{\n  "plugin": []\n}\n`,
    });
    const r = computeDriftAcceptanceProof(proofDeps(fx), proofReq(fx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-proof-failed");
  });

  test("bridge duplicated → drift-proof-failed", () => {
    const fx = buildFixture();
    const dup = `{\n  "plugin": ["${fx.canonicalIdentity}", "${fx.canonicalIdentity}"]\n}\n`;
    writeFileSync(fx.configPath, dup, "utf-8");
    const r = computeDriftAcceptanceProof(proofDeps(fx), proofReq(fx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-proof-failed");
  });

  test("bridge as tuple → drift-proof-failed", () => {
    const fx = buildFixture();
    const tuple = `{\n  "plugin": [["${fx.canonicalIdentity}", {"port": 8789, "activationNonce": "tuple-nonce-sentinel-0123456789"}]]\n}\n`;
    writeFileSync(fx.configPath, tuple, "utf-8");
    const r = computeDriftAcceptanceProof(proofDeps(fx), proofReq(fx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-proof-failed");
    expect(JSON.stringify(r)).not.toContain("tuple-nonce-sentinel-0123456789");
  });

  test("additional noncanonical (realpath-matching) bridge entry → drift-proof-failed", () => {
    const fx = buildFixture();
    // /var vs /private/var style lexical difference that realpaths equal.
    const alt = fx.canonicalIdentity.replace("/private/", "/");
    const lexical = alt === fx.canonicalIdentity
      ? fx.canonicalIdentity + "/./"
      : alt;
    const text = `{\n  "plugin": ["${fx.canonicalIdentity}", "${lexical}"]\n}\n`;
    writeFileSync(fx.configPath, text, "utf-8");
    const r = computeDriftAcceptanceProof(proofDeps(fx), proofReq(fx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-proof-failed");
  });

  test("bridge-like entry in another authorized candidate → drift-proof-failed", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    writeFileSync(
      join(fx.configDir, "opencode.json"),
      `{\n  "plugin": ["./packages/omo-telemetry-bridge"]\n}\n`,
      "utf-8",
    );
    const r = computeDriftAcceptanceProof(proofDeps(fx), proofReq(fx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-proof-failed");
  });
});

describe("drift proof: anchor and nonce failures", () => {
  test("no anchor revision → drift-proof-failed", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    // Remove all revisions.
    const db = new Database(join(fx.sandbox, "data", "bridge.db"));
    db.exec("DELETE FROM bridge_revisions");
    db.close();
    const r = computeDriftAcceptanceProof(proofDeps(fx), proofReq(fx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-proof-failed");
  });

  test("malformed anchor patch → drift-proof-failed", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    const db = new Database(join(fx.sandbox, "data", "bridge.db"));
    db.query("UPDATE bridge_revisions SET byte_patch = 'not json' WHERE id = 'brev_fixture_add'").run();
    db.close();
    const r = computeDriftAcceptanceProof(proofDeps(fx), proofReq(fx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-proof-failed");
  });

  test("anchor with non-empty deleteText → drift-proof-failed", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    const db = new Database(join(fx.sandbox, "data", "bridge.db"));
    const bad = JSON.stringify({ version: 1, offsetUtf16: 0, deleteText: "x", insertText: "y" });
    db.query("UPDATE bridge_revisions SET byte_patch = ? WHERE id = 'brev_fixture_add'").run(bad);
    db.close();
    const r = computeDriftAcceptanceProof(proofDeps(fx), proofReq(fx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-proof-failed");
  });

  test("anchor fragment occurring twice → drift-proof-failed", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    const anchor = fx.store.getRevision("brev_fixture_add");
    expect(anchor).not.toBeNull();
    if (!anchor || anchor.operation !== "add") return;
    const insertText = (JSON.parse(anchor.bytePatch) as { insertText: string }).insertText;
    // Duplicate the exact insert fragment elsewhere as inert content (a
    // block comment preserves the fragment bytes exactly).
    const t = readFileSync(fx.configPath, "utf-8").replace(
      /\}\s*$/,
      `\n/* ${insertText} */\n}\n`,
    );
    writeFileSync(fx.configPath, t, "utf-8");
    const r = computeDriftAcceptanceProof(proofDeps(fx), proofReq(fx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-proof-failed");
  });

  test("missing raw nonce → drift-proof-failed", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    fx.store.clearRawCommittedNonce();
    const r = computeDriftAcceptanceProof(proofDeps(fx), proofReq(fx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-proof-failed");
  });

  test("nonce not matching fingerprint → drift-proof-failed", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    const db = new Database(join(fx.sandbox, "data", "bridge.db"));
    db.query("UPDATE bridge_activation_state SET raw_activation_nonce = 'different-nonce-0123456789ab' WHERE id = 1").run();
    db.close();
    const r = computeDriftAcceptanceProof(proofDeps(fx), proofReq(fx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-proof-failed");
  });
});

/* ------------------------------------------------------------------ */
/* Service two-phase                                                    */
/* ------------------------------------------------------------------ */

describe("drift acceptance service", () => {
  test("preview performs zero DB writes and zero effective-view calls", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    const db = new Database(join(fx.sandbox, "data", "bridge.db"));
    const intentCountBefore = (db.query("SELECT COUNT(*) c FROM bridge_activation_intents").get() as { c: number }).c;
    const revCountBefore = (db.query("SELECT COUNT(*) c FROM bridge_revisions").get() as { c: number }).c;
    db.close();

    const dto = fx.service.previewDriftAcceptance(previewReq(fx), { overrideActive: false });
    expect(dto.ok).toBe(true);
    expect(dto.previewId).toMatch(/^driftpreview_[0-9a-f]{32}$/);
    expect(dto.acknowledgement).toBe(DRIFT_ACCEPT_ACKNOWLEDGEMENT);
    expect(dto.confirmationToken).toBe(DRIFT_ACCEPT_CONFIRMATION_TOKEN);
    expect(fx.effectiveViewCalls.count).toBe(0);

    const db2 = new Database(join(fx.sandbox, "data", "bridge.db"));
    expect((db2.query("SELECT COUNT(*) c FROM bridge_activation_intents").get() as { c: number }).c).toBe(intentCountBefore);
    expect((db2.query("SELECT COUNT(*) c FROM bridge_revisions").get() as { c: number }).c).toBe(revCountBefore);
    db2.close();

    // Preview DTO sanitization.
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain(RAW_NONCE);
    expect(serialized).not.toContain("provider-secret-sentinel-123");
  });

  test("apply commits metadata only: hash/revision/updatedAt change; nonce and config bytes identical", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    const statBefore = lstatSync(fx.configPath);
    let nonceBefore: string | undefined;
    fx.store.withCommittedRawNonce((n) => { nonceBefore = n; });

    const preview = fx.service.previewDriftAcceptance(previewReq(fx), { overrideActive: false });
    expect(preview.ok).toBe(true);
    const applied = fx.service.applyDriftAcceptance(
      { ...previewReq(fx), previewId: preview.previewId!, confirmation: DRIFT_ACCEPT_CONFIRMATION_TOKEN },
      { overrideActive: false },
    );
    expect(applied.ok).toBe(true);
    expect(applied.configWritten).toBe(false);
    expect(applied.runtimeAction).toBe("none");
    expect(applied.restorable).toBe(false);
    expect(applied.restartRequired).toBe(true);
    expect(applied.metadataCommitted).toBe(true);
    expect(applied.stateDisposition).toBe("committed");
    expect(applied.oldConfigHash).toBe(fx.committedHash);
    expect(applied.newConfigHash).toBe(observedHash(fx));

    // Only activation hash/revision/timestamp changed.
    const state = fx.store.getActivationState();
    expect(state?.configHash).toBe(observedHash(fx));
    expect(state?.revisionId).toBe(applied.revisionId);
    expect(state?.revisionId).not.toBe(fx.revisionId);
    expect(state?.nonceFingerprint).toBe(NONCE_FP);
    expect(state?.port).toBe(8788);

    // Raw nonce byte-identical.
    let nonceAfter: string | undefined;
    fx.store.withCommittedRawNonce((n) => { nonceAfter = n; });
    expect(nonceAfter).toBe(nonceBefore);
    expect(nonceAfter).toBe(RAW_NONCE);

    // Config file untouched: bytes/hash/inode/mode/mtime.
    const statAfter = lstatSync(fx.configPath);
    expect(statAfter.ino).toBe(statBefore.ino);
    expect(statAfter.mode).toBe(statBefore.mode);
    expect(statAfter.size).toBe(statBefore.size);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    expect(hashContent(readFileSync(fx.configPath, "utf-8"))).toBe(observedHash(fx));

    // No temp files left behind.
    const leftovers = readdirSync(fx.projectDir).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);

    // Rebase revision: non-restorable shape, correct linkage.
    const rev = fx.store.getRevision(applied.revisionId!);
    expect(rev?.operation).toBe("rebase");
    if (rev?.operation === "rebase") {
      expect(rev.bytePatch).toBeNull();
      expect(rev.parentRevisionId).toBe(fx.revisionId);
      expect(rev.anchorRevisionId).toBe("brev_fixture_add");
      expect(rev.acceptanceIntentId).toContain("intent_");
    }

    // Apply DTO sanitization.
    const serialized = JSON.stringify(applied);
    expect(serialized).not.toContain(RAW_NONCE);
    expect(serialized).not.toContain("provider-secret-sentinel-123");
  });

  test("replay: second apply with the same preview ID → preview-stale", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    const preview = fx.service.previewDriftAcceptance(previewReq(fx), { overrideActive: false });
    const first = fx.service.applyDriftAcceptance(
      { ...previewReq(fx), previewId: preview.previewId!, confirmation: DRIFT_ACCEPT_CONFIRMATION_TOKEN },
      { overrideActive: false },
    );
    expect(first.ok).toBe(true);
    const second = fx.service.applyDriftAcceptance(
      { ...previewReq(fx), previewId: preview.previewId!, confirmation: DRIFT_ACCEPT_CONFIRMATION_TOKEN },
      { overrideActive: false },
    );
    expect(second.ok).toBe(false);
    expect(second.errors[0]!.code).toBe("preview-stale");
  });

  test("wrong confirmation consumes the preview and fails closed", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    const preview = fx.service.previewDriftAcceptance(previewReq(fx), { overrideActive: false });
    const bad = fx.service.applyDriftAcceptance(
      { ...previewReq(fx), previewId: preview.previewId!, confirmation: "wrong-token" },
      { overrideActive: false },
    );
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]!.code).toBe("confirmation-mismatch");
    // Consumed: retry with the correct token fails as stale.
    const retry = fx.service.applyDriftAcceptance(
      { ...previewReq(fx), previewId: preview.previewId!, confirmation: DRIFT_ACCEPT_CONFIRMATION_TOKEN },
      { overrideActive: false },
    );
    expect(retry.ok).toBe(false);
    expect(retry.errors[0]!.code).toBe("preview-stale");
  });

  test("expected-field mismatch after consumption → hash-conflict", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    const preview = fx.service.previewDriftAcceptance(previewReq(fx), { overrideActive: false });
    const r = fx.service.applyDriftAcceptance(
      { ...previewReq(fx), previewId: preview.previewId!, expectedObservedHash: "e".repeat(64), confirmation: DRIFT_ACCEPT_CONFIRMATION_TOKEN },
      { overrideActive: false },
    );
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.code).toBe("hash-conflict");
  });

  test("expired preview → preview-stale", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    const preview = fx.service.previewDriftAcceptance(previewReq(fx), { overrideActive: false });
    fx.service.__expireDriftPreviewsForTests();
    const r = fx.service.applyDriftAcceptance(
      { ...previewReq(fx), previewId: preview.previewId!, confirmation: DRIFT_ACCEPT_CONFIRMATION_TOKEN },
      { overrideActive: false },
    );
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.code).toBe("preview-stale");
  });

  test("state changed between preview and apply → fail closed, nothing committed", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    const preview = fx.service.previewDriftAcceptance(previewReq(fx), { overrideActive: false });
    // Concurrent commit changes the committed revision/hash.
    fx.store.insertPreparedIntent({
      id: "intent_concurrent",
      targetPath: fx.configPath,
      sourceKind: "project-root",
      operation: "remove",
      baselineHash: fx.committedHash,
      proposedHash: "h_x",
      canonicalIdentity: fx.canonicalIdentity,
      bytePatch: "{}",
    });
    fx.store.finalizeIntent("intent_concurrent", "brev_concurrent", new Date().toISOString(), "h_x");
    const r = fx.service.applyDriftAcceptance(
      { ...previewReq(fx), previewId: preview.previewId!, confirmation: DRIFT_ACCEPT_CONFIRMATION_TOKEN },
      { overrideActive: false },
    );
    expect(r.ok).toBe(false);
    expect(r.metadataCommitted).toBe(false);
    expect(["drift-not-eligible", "state-conflict"]).toContain(r.errors[0]!.code);
  });

  test("post-commit external edit → metadataCommitted true + post-acceptance-drift + recovery-pending", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    const preview = fx.service.previewDriftAcceptance(previewReq(fx), { overrideActive: false });
    const r = fx.service.applyDriftAcceptance(
      { ...previewReq(fx), previewId: preview.previewId!, confirmation: DRIFT_ACCEPT_CONFIRMATION_TOKEN },
      {
        overrideActive: false,
        afterCommitBeforeReread: () => {
          writeFileSync(fx.configPath, `{ "plugin": ["${fx.canonicalIdentity}"], "zz-later": 1 }\n`, "utf-8");
        },
      },
    );
    expect(r.ok).toBe(false);
    expect(r.metadataCommitted).toBe(true);
    expect(r.errors[0]!.code).toBe("post-acceptance-drift");
    expect(r.stateDisposition).toBe("recovery-pending");
    // Never pretend rollback: the rebase revision remains committed.
    expect(fx.store.getRevision(r.revisionId!)?.operation).toBe("rebase");
  });

  test("repeated rebases preserve the original ADD anchor chain", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    // First rebase.
    const p1 = fx.service.previewDriftAcceptance(previewReq(fx), { overrideActive: false });
    const a1 = fx.service.applyDriftAcceptance(
      { ...previewReq(fx), previewId: p1.previewId!, confirmation: DRIFT_ACCEPT_CONFIRMATION_TOKEN },
      { overrideActive: false },
    );
    expect(a1.ok).toBe(true);

    // Second external edit + second rebase.
    writeFileSync(
      fx.configPath,
      readFileSync(fx.configPath, "utf-8").replace(/\}\s*$/, `,\n  "theme": "dark"\n}\n`),
      "utf-8",
    );
    const req2 = {
      expectedRevisionId: a1.revisionId!,
      expectedCommittedHash: a1.newConfigHash!,
      expectedObservedHash: observedHash(fx),
    };
    const p2 = fx.service.previewDriftAcceptance(req2, { overrideActive: false });
    expect(p2.ok).toBe(true);
    if (!p2.ok) return;
    // Anchor is STILL the original add revision.
    expect(p2.proof?.anchorRevisionId).toBe("brev_fixture_add");
    const a2 = fx.service.applyDriftAcceptance(
      { ...req2, previewId: p2.previewId!, confirmation: DRIFT_ACCEPT_CONFIRMATION_TOKEN },
      { overrideActive: false },
    );
    expect(a2.ok).toBe(true);
    const rev2 = fx.store.getRevision(a2.revisionId!);
    if (rev2?.operation === "rebase") {
      expect(rev2.anchorRevisionId).toBe("brev_fixture_add");
      expect(rev2.parentRevisionId).toBe(a1.revisionId as string);
    } else {
      throw new Error("expected rebase revision");
    }
  });

  test("rebase revision is not restorable", async () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    const p = fx.service.previewDriftAcceptance(previewReq(fx), { overrideActive: false });
    const a = fx.service.applyDriftAcceptance(
      { ...previewReq(fx), previewId: p.previewId!, confirmation: DRIFT_ACCEPT_CONFIRMATION_TOKEN },
      { overrideActive: false },
    );
    const restored = await fx.service.restore({
      revisionId: a.revisionId!,
      expectedSourceHash: observedHash(fx),
    });
    expect(restored.ok).toBe(false);
    expect(restored.errors[0]!.code).toBe("revision-not-restorable");
  });
});

// ── Oracle attempt-2 remediation: candidate provenance + lineage ──────

describe("drift proof: candidate provenance fail-closed", () => {
  test("malformed alternate candidate (inventory error) blocks acceptance", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    writeFileSync(join(fx.configDir, "opencode.json"), `{ not valid`, "utf-8");
    const r = computeDriftAcceptanceProof(proofDeps(fx), proofReq(fx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-proof-failed");
  });

  test("target absent from inventory blocks acceptance", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    // Move the committed target OUTSIDE both enumeration directories (but
    // still inside an authorized root) so the inventory cannot contain it.
    const elsewhere = join(fx.sandbox, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    const movedPath = join(elsewhere, "opencode.json");
    writeFileSync(movedPath, readFileSync(fx.configPath, "utf-8"), "utf-8");
    rmSync(fx.configPath);
    const db = new Database(join(fx.sandbox, "data", "bridge.db"));
    db.query("UPDATE bridge_activation_state SET target_path = ? WHERE id = 1").run(movedPath);
    db.query("UPDATE bridge_revisions SET target_path = ?").run(movedPath);
    db.close();
    const r = computeDriftAcceptanceProof(proofDeps(fx), {
      expectedRevisionId: fx.revisionId,
      expectedCommittedHash: fx.committedHash,
      expectedObservedHash: hashContent(readFileSync(movedPath, "utf-8")),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-proof-failed");
    expect(r.errors[0]!.message).toContain("inventory");
  });

  test("source-kind mismatch blocks acceptance", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    // Committed as project-root but claim opencode-config-dir in state.
    const db = new Database(join(fx.sandbox, "data", "bridge.db"));
    db.query("UPDATE bridge_activation_state SET source_kind = 'opencode-config-dir' WHERE id = 1").run();
    db.close();
    const r = computeDriftAcceptanceProof(proofDeps(fx), proofReq(fx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-proof-failed");
  });
});

describe("drift proof: lineage-based anchor", () => {
  test("unrelated newer ADD revision for the same target is ignored (lineage anchor wins)", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    // Insert an unrelated newer add revision (not in the committed lineage).
    fx.store.insertRevision({
      id: "brev_unrelated_newer",
      timestamp: new Date(Date.now() + 60_000).toISOString(),
      targetPath: fx.configPath,
      sourceKind: "project-root",
      operation: "add",
      baselineHash: "h_x",
      postWriteHash: "h_y",
      canonicalIdentity: fx.canonicalIdentity,
      port: 8788,
      registrationTransport: "env",
      transportMode: "loopback-http",
      nonceFingerprint: NONCE_FP,
      bytePatch: JSON.stringify({ version: 1, offsetUtf16: 1, deleteText: "", insertText: "zzz" }),
    });
    const r = computeDriftAcceptanceProof(proofDeps(fx), proofReq(fx));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proof.anchorRevisionId).toBe("brev_fixture_add");
  });

  test("broken parent link in a rebase chain → proof fails", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    // One legit rebase.
    const p1 = fx.service.previewDriftAcceptance(previewReq(fx), { overrideActive: false });
    const a1 = fx.service.applyDriftAcceptance(
      { ...previewReq(fx), previewId: p1.previewId!, confirmation: DRIFT_ACCEPT_CONFIRMATION_TOKEN },
      { overrideActive: false },
    );
    expect(a1.ok).toBe(true);
    // Corrupt the parent linkage: point the rebase at a missing parent.
    const db = new Database(join(fx.sandbox, "data", "bridge.db"));
    db.query("UPDATE bridge_revisions SET parent_revision_id = 'brev_missing' WHERE id = ?").run(a1.revisionId!);
    db.close();
    // New drift.
    writeFileSync(
      fx.configPath,
      readFileSync(fx.configPath, "utf-8").replace(/\}\s*$/, `,\n  "theme": "dark"\n}\n`),
      "utf-8",
    );
    const r = computeDriftAcceptanceProof(proofDeps(fx), {
      expectedRevisionId: a1.revisionId!,
      expectedCommittedHash: a1.newConfigHash!,
      expectedObservedHash: observedHash(fx),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-proof-failed");
  });

  test("hash linkage mismatch in a rebase chain → proof fails", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    const p1 = fx.service.previewDriftAcceptance(previewReq(fx), { overrideActive: false });
    const a1 = fx.service.applyDriftAcceptance(
      { ...previewReq(fx), previewId: p1.previewId!, confirmation: DRIFT_ACCEPT_CONFIRMATION_TOKEN },
      { overrideActive: false },
    );
    expect(a1.ok).toBe(true);
    // Corrupt the baseline hash of the rebase revision.
    const db = new Database(join(fx.sandbox, "data", "bridge.db"));
    db.query("UPDATE bridge_revisions SET baseline_hash = 'h_corrupt' WHERE id = ?").run(a1.revisionId!);
    db.close();
    writeFileSync(
      fx.configPath,
      readFileSync(fx.configPath, "utf-8").replace(/\}\s*$/, `,\n  "theme": "dark"\n}\n`),
      "utf-8",
    );
    const r = computeDriftAcceptanceProof(proofDeps(fx), {
      expectedRevisionId: a1.revisionId!,
      expectedCommittedHash: a1.newConfigHash!,
      expectedObservedHash: observedHash(fx),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-proof-failed");
  });

  test("rebase row with a non-null patch is malformed → proof fails", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    const p1 = fx.service.previewDriftAcceptance(previewReq(fx), { overrideActive: false });
    const a1 = fx.service.applyDriftAcceptance(
      { ...previewReq(fx), previewId: p1.previewId!, confirmation: DRIFT_ACCEPT_CONFIRMATION_TOKEN },
      { overrideActive: false },
    );
    expect(a1.ok).toBe(true);
    const db = new Database(join(fx.sandbox, "data", "bridge.db"));
    db.query("UPDATE bridge_revisions SET byte_patch = '{}' WHERE id = ?").run(a1.revisionId!);
    db.close();
    writeFileSync(
      fx.configPath,
      readFileSync(fx.configPath, "utf-8").replace(/\}\s*$/, `,\n  "theme": "dark"\n}\n`),
      "utf-8",
    );
    const r = computeDriftAcceptanceProof(proofDeps(fx), {
      expectedRevisionId: a1.revisionId!,
      expectedCommittedHash: a1.newConfigHash!,
      expectedObservedHash: observedHash(fx),
    });
    expect(r.ok).toBe(false);
  });

  test("commitDriftAcceptance rejects a caller anchor that disagrees with lineage", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    const r = fx.store.commitDriftAcceptance({
      intentId: "intent_anchor_mismatch",
      revisionId: "brev_anchor_mismatch",
      timestamp: new Date().toISOString(),
      targetPath: fx.configPath,
      sourceKind: "project-root",
      canonicalIdentity: fx.canonicalIdentity,
      port: 8788,
      nonceFingerprint: NONCE_FP,
      oldConfigHash: fx.committedHash,
      newConfigHash: observedHash(fx),
      expectedRevisionId: fx.revisionId,
      anchorRevisionId: "brev_NOT_the_anchor",
      auditMetadata: "{}",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("state-conflict");
    expect(fx.store.getRevision("brev_anchor_mismatch")).toBeNull();
  });
});

describe("post-commit honesty (service)", () => {
  test("post-commit stable-read fault (symlink swap) → metadataCommitted true + post-acceptance-drift", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    const preview = fx.service.previewDriftAcceptance(previewReq(fx), { overrideActive: false });
    const r = fx.service.applyDriftAcceptance(
      { ...previewReq(fx), previewId: preview.previewId!, confirmation: DRIFT_ACCEPT_CONFIRMATION_TOKEN },
      {
        overrideActive: false,
        afterCommitBeforeReread: () => {
          const real = join(fx.sandbox, "swap-target.json");
          writeFileSync(real, readFileSync(fx.configPath, "utf-8"), "utf-8");
          rmSync(fx.configPath);
          symlinkSync(real, fx.configPath);
        },
      },
    );
    expect(r.ok).toBe(false);
    expect(r.metadataCommitted).toBe(true);
    expect(r.errors[0]!.code).toBe("post-acceptance-drift");
    expect(r.stateDisposition).toBe("recovery-pending");
    // The rebase revision remains committed — never pretend rollback.
    expect(fx.store.getRevision(r.revisionId!)?.operation).toBe("rebase");
  });

  test("post-commit DB read fault → structured metadataCommitted true, no uncaught exception", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    const preview = fx.service.previewDriftAcceptance(previewReq(fx), { overrideActive: false });
    const r = fx.service.applyDriftAcceptance(
      { ...previewReq(fx), previewId: preview.previewId!, confirmation: DRIFT_ACCEPT_CONFIRMATION_TOKEN },
      {
        overrideActive: false,
        afterCommitBeforeReread: () => {
          fx.store.close(); // DB reads after this throw
        },
      },
    );
    expect(r.ok).toBe(false);
    expect(r.metadataCommitted).toBe(true);
    expect(r.errors[0]!.code).toBe("post-acceptance-drift");
    expect(r.stateDisposition).toBe("recovery-pending");
  });
});

// ── Oracle attempt-3: strict inventory + bounded reads ────────────────

describe("drift proof: strict inventory (no legacy path reader)", () => {
  /** Counting ops seam over the real fs. */
  function countingOps() {
    const counts = { open: [] as string[], read: 0, lstat: [] as string[] };
    const ops = {
      lstatSync: (p: string) => {
        counts.lstat.push(p);
        return lstatSync(p);
      },
      realpathSync: (p: string) => realpathSync(p),
      existsSync: (p: string) => existsSync(p),
      openSync: (p: string, flags: number) => {
        counts.open.push(p);
        return openSync(p, flags);
      },
      fstatSync: (fd: number) => fstatSync(fd),
      readFdSync: (fd: number, maxBytes: number) => {
        counts.read++;
        const b = readFileSync(fd);
        if (b.length > maxBytes) throw new RangeError("overflow");
        return b;
      },
      closeSync: (fd: number) => closeSync(fd),
    } satisfies import("./stable-config-reader").StableReadFileOps;
    return { counts, ops };
  }

  test("committed target is opened/read exactly once (snapshot reused by inventory)", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    // Create an alternate existing candidate to force an inventory read.
    writeFileSync(join(fx.configDir, "opencode.json"), `{"plugin": []}\n`, "utf-8");
    const { counts, ops } = countingOps();
    const r = computeDriftAcceptanceProof({ ...proofDeps(fx), fileOps: ops }, proofReq(fx));
    expect(r.ok).toBe(true);
    const targetOpens = counts.open.filter(
      (p) => realpathSync(p) === realpathSync(fx.configPath),
    );
    expect(targetOpens.length).toBe(1); // proof read only; inventory reuses it
    expect(counts.read).toBe(2); // target + alternate candidate
  });

  test("target swapped to FIFO (seam) is rejected before any open", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    const { counts, ops } = countingOps();
    const fifoOps = {
      ...ops,
      lstatSync: (p: string) => {
        const st = lstatSync(p);
        if (realpathSync(p) === realpathSync(fx.configPath)) {
          // Pretend the target is now a FIFO.
          return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
            isFile: () => false,
            isFIFO: () => true,
          }) as typeof st;
        }
        return st;
      },
    };
    const r = computeDriftAcceptanceProof({ ...proofDeps(fx), fileOps: fifoOps }, proofReq(fx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-proof-failed");
    // The target was NEVER opened (lstat rejects before open — no blocking).
    expect(counts.open.filter((p) => realpathSync(p) === realpathSync(fx.configPath)).length).toBe(0);
  });

  test("alternate candidate that is a FIFO is rejected before blocking open", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    const fifoPath = join(fx.configDir, "opencode.json");
    writeFileSync(fifoPath, `{"plugin": []}\n`, "utf-8");
    const { counts, ops } = countingOps();
    const fifoOps = {
      ...ops,
      lstatSync: (p: string) => {
        const st = lstatSync(p);
        if (realpathSync(p) === realpathSync(fifoPath)) {
          return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
            isFile: () => false,
            isFIFO: () => true,
          }) as typeof st;
        }
        return st;
      },
    };
    const r = computeDriftAcceptanceProof({ ...proofDeps(fx), fileOps: fifoOps }, proofReq(fx));
    expect(r.ok).toBe(false);
    expect(counts.open.filter((p) => realpathSync(p) === realpathSync(fifoPath)).length).toBe(0);
  });

  test("alternate candidate that is a symlink (even in-root) blocks", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    const real = join(fx.sandbox, "real-alt.json");
    writeFileSync(real, `{"plugin": []}\n`, "utf-8");
    symlinkSync(real, join(fx.configDir, "opencode.json"));
    const r = computeDriftAcceptanceProof(proofDeps(fx), proofReq(fx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-proof-failed");
    expect(r.errors[0]!.message).toContain("symlink");
  });

  test("alternate oversized candidate blocks", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    writeFileSync(
      join(fx.configDir, "opencode.json"),
      " ".repeat(300 * 1024),
      "utf-8",
    );
    const r = computeDriftAcceptanceProof(proofDeps(fx), proofReq(fx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.message).toContain("too-large");
  });

  test("fstat-small but growing candidate (descriptor supplies > limit) blocks", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    writeFileSync(join(fx.configDir, "opencode.json"), `{"plugin": []}\n`, "utf-8");
    const { ops } = countingOps();
    const growingOps = {
      ...ops,
      readFdSync: (fd: number, _maxBytes: number) => {
        // Descriptor supplies far more than fstat reported.
        return Buffer.alloc(300 * 1024, 0x20);
      },
    };
    const r = computeDriftAcceptanceProof({ ...proofDeps(fx), fileOps: growingOps }, proofReq(fx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.message).toContain("too-large");
  });
});

describe("drift proof: lineage start hash + strict operations", () => {
  test("current revision postWriteHash mismatch vs committed state → proof fails, nothing committed", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    const db = new Database(join(fx.sandbox, "data", "bridge.db"));
    db.query("UPDATE bridge_revisions SET post_write_hash = 'h_corrupt' WHERE id = 'brev_fixture_add'").run();
    db.close();
    const intentsBefore = fx.store.getIntent("intent_fixture_add") !== null;
    expect(intentsBefore).toBe(true);
    const r = computeDriftAcceptanceProof(proofDeps(fx), proofReq(fx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe("drift-proof-failed");
  });

  test("unknown operation value on the current revision → every path rejects with zero changes", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    const db = new Database(join(fx.sandbox, "data", "bridge.db"));
    db.query("UPDATE bridge_revisions SET operation = 'frobnicate' WHERE id = 'brev_fixture_add'").run();
    db.close();

    // Proof rejects.
    const r = computeDriftAcceptanceProof(proofDeps(fx), proofReq(fx));
    expect(r.ok).toBe(false);

    // Preview rejects; nothing stored.
    const preview = fx.service.previewDriftAcceptance(previewReq(fx), { overrideActive: false });
    expect(preview.ok).toBe(false);

    // Direct commit rejects and leaves zero new intent/revision/state change.
    const commit = fx.store.commitDriftAcceptance({
      intentId: "intent_unknown_op",
      revisionId: "brev_unknown_op",
      timestamp: new Date().toISOString(),
      targetPath: fx.configPath,
      sourceKind: "project-root",
      canonicalIdentity: fx.canonicalIdentity,
      port: 8788,
      nonceFingerprint: NONCE_FP,
      oldConfigHash: fx.committedHash,
      newConfigHash: observedHash(fx),
      expectedRevisionId: fx.revisionId,
      anchorRevisionId: "brev_fixture_add",
      auditMetadata: "{}",
    });
    expect(commit.ok).toBe(false);
    expect(fx.store.getIntent("intent_unknown_op")).toBeNull();
    expect(fx.store.getRevision("brev_unknown_op")).toBeNull();
    expect(fx.store.getActivationState()?.revisionId).toBe(fx.revisionId);
  });
});

// ── Oracle exceptional parser correction: strict snapshot parsing ──────

describe("drift preview: strict snapshot parsing, zero writes", () => {
  const SENTINEL_IDENTITY = "/Users/secret/sentinel-plugin-path-aa55";

  function dbCounts(fx: Fixture): { intents: number; revisions: number } {
    const db = new Database(join(fx.sandbox, "data", "bridge.db"));
    const intents = (db.query("SELECT COUNT(*) c FROM bridge_activation_intents").get() as { c: number }).c;
    const revisions = (db.query("SELECT COUNT(*) c FROM bridge_revisions").get() as { c: number }).c;
    const state = (db.query("SELECT config_hash h, revision_id r, updated_at u FROM bridge_activation_state WHERE id=1").get() as { h: string; r: string; u: string });
    db.close();
    void state;
    return { intents, revisions };
  }

  function stateSnapshot(fx: Fixture): string {
    return JSON.stringify(fx.store.getActivationState());
  }

  function expectZeroWriteRejection(
    fx: Fixture,
    alternateContent: string,
    sentinel: string,
  ): void {
    writeFileSync(join(fx.configDir, "opencode.json"), alternateContent, "utf-8");
    const before = dbCounts(fx);
    const stateBefore = stateSnapshot(fx);
    const configBytesBefore = readFileSync(fx.configPath, "utf-8");

    const preview = fx.service.previewDriftAcceptance(previewReq(fx), { overrideActive: false });
    expect(preview.ok).toBe(false);
    expect(preview.errors[0]!.code).toBe("drift-proof-failed");

    // Zero DB intent/revision/activation updates.
    expect(dbCounts(fx)).toEqual(before);
    expect(stateSnapshot(fx)).toBe(stateBefore);
    // Zero config writes and zero effective-view calls.
    expect(readFileSync(fx.configPath, "utf-8")).toBe(configBytesBefore);
    expect(fx.effectiveViewCalls.count).toBe(0);
    // No raw sentinel in any output.
    expect(JSON.stringify(preview)).not.toContain(sentinel);
  }

  test("alternate with duplicate plugin key (canonical entry FIRST) rejects", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    expectZeroWriteRejection(
      fx,
      `{\n  "plugin": ["${fx.canonicalIdentity}"],\n  "plugin": ["${SENTINEL_IDENTITY}"]\n}\n`,
      SENTINEL_IDENTITY,
    );
  });

  test("alternate with duplicate plugin key (canonical entry SECOND) rejects", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    expectZeroWriteRejection(
      fx,
      `{\n  "plugin": ["${SENTINEL_IDENTITY}"],\n  "plugin": ["${fx.canonicalIdentity}"]\n}\n`,
      SENTINEL_IDENTITY,
    );
  });

  test("alternate with duplicate non-plugin top-level key rejects", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    expectZeroWriteRejection(
      fx,
      `{\n  "theme": "${SENTINEL_IDENTITY}",\n  "plugin": [],\n  "theme": "dark"\n}\n`,
      SENTINEL_IDENTITY,
    );
  });

  test("alternate with array root rejects", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    expectZeroWriteRejection(fx, `["${SENTINEL_IDENTITY}"]\n`, SENTINEL_IDENTITY);
  });

  test("alternate with scalar root rejects", () => {
    const fx = buildFixture({ drift: DEFAULT_DRIFT });
    expectZeroWriteRejection(fx, `"${SENTINEL_IDENTITY}"\n`, SENTINEL_IDENTITY);
  });
});
