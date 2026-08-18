/**
 * Slice 17 — Canonical bridge identity tests.
 *
 * Covers: canonical equivalence; ambiguous relative/npm; symlink/root
 * escape detection; duplicate/equivalent entry detection; file:// URL
 * normalization; trailing slash normalization.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalBridgeDir,
  detectIdentityKind,
  detectDuplicateBridgeEntries,
  normalizePathIdentity,
  resolveCanonicalBridge,
  arePluginEntriesEquivalent,
} from "./canonical";

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "omo-bridge-canonical-"));
});

afterEach(() => {
  try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* */ }
});

function setupBridgeDir(root: string): string {
  const bridgeDir = join(root, "packages", "omo-telemetry-bridge");
  mkdirSync(bridgeDir, { recursive: true });
  writeFileSync(join(bridgeDir, "package.json"), "{}");
  return bridgeDir;
}

describe("detectIdentityKind", () => {
  test("absolute path → path", () => {
    expect(detectIdentityKind("/Users/matt/foo")).toBe("path");
  });

  test("file:// URL → file-url", () => {
    expect(detectIdentityKind("file:///Users/matt/foo")).toBe("file-url");
  });

  test("bare npm name → npm", () => {
    expect(detectIdentityKind("oh-my-opencode-slim")).toBe("npm");
  });

  test("scoped npm → npm", () => {
    expect(detectIdentityKind("@scope/name")).toBe("npm");
  });

  test("npm with version → npm", () => {
    expect(detectIdentityKind("@scope/name@1.2.3")).toBe("npm");
  });

  test("relative ./ → path (lexical form for matching)", () => {
    expect(detectIdentityKind("./packages/omo-telemetry-bridge")).toBe("path");
  });

  test("relative ../ → path", () => {
    expect(detectIdentityKind("../omo-telemetry-bridge")).toBe("path");
  });
});

describe("normalizePathIdentity", () => {
  test("absolute path within roots → path", () => {
    const r = normalizePathIdentity("/Users/matt/Repos/omo-slim/foo", [
      "/Users/matt/Repos/omo-slim",
    ]);
    expect(r.path).toBe("/Users/matt/Repos/omo-slim/foo");
  });

  test("absolute path outside roots → outside-roots", () => {
    const r = normalizePathIdentity("/etc/passwd", ["/Users/matt/Repos/omo-slim"]);
    expect(r.path).toBeNull();
    if (r.path === null) expect(r.reason).toBe("outside-roots");
  });

  test("file:// URL within roots → path", () => {
    const r = normalizePathIdentity("file:///Users/matt/Repos/omo-slim/foo", [
      "/Users/matt/Repos/omo-slim",
    ]);
    expect(r.path).toBe("/Users/matt/Repos/omo-slim/foo");
  });

  test("relative → not-path-like", () => {
    const r = normalizePathIdentity("./foo", ["/Users/matt/Repos/omo-slim"]);
    expect(r.path).toBeNull();
    if (r.path === null) expect(r.reason).toBe("not-path-like");
  });

  test("npm name → not-path-like", () => {
    const r = normalizePathIdentity("oh-my-opencode-slim", ["/Users/matt/Repos/omo-slim"]);
    expect(r.path).toBeNull();
    if (r.path === null) expect(r.reason).toBe("not-path-like");
  });

  test("trailing slash stripped", () => {
    const r = normalizePathIdentity("/Users/matt/Repos/omo-slim/foo/", [
      "/Users/matt/Repos/omo-slim",
    ]);
    expect(r.path).toBe("/Users/matt/Repos/omo-slim/foo");
  });
});

describe("resolveCanonicalBridge", () => {
  test("exact realpath match → isCanonical", () => {
    const bridgeDir = setupBridgeDir(sandbox);
    const realBridge = realpathSync(bridgeDir);
    const r = resolveCanonicalBridge(bridgeDir, sandbox, [sandbox]);
    expect(r.isCanonical).toBe(true);
    expect(r.realpath).toBe(realBridge);
  });

  test("non-existent path → not canonical, no error", () => {
    const r = resolveCanonicalBridge(
      join(sandbox, "nope"),
      sandbox,
      [sandbox],
    );
    expect(r.isCanonical).toBe(false);
    expect(r.realpath).toBeNull();
  });

  test("relative bridge-looking path → not canonical, bridge-like but not canonical", () => {
    const r = resolveCanonicalBridge("./packages/omo-telemetry-bridge", sandbox, [sandbox]);
    expect(r.isCanonical).toBe(false);
    expect(r.isBridgeLikeButNotCanonical).toBe(true);
  });

  test("npm bridge-looking name → not canonical, bridge-like but not canonical", () => {
    const r = resolveCanonicalBridge("omo-telemetry-bridge", sandbox, [sandbox]);
    expect(r.isCanonical).toBe(false);
    expect(r.isBridgeLikeButNotCanonical).toBe(true);
  });

  test("symlink escaping roots → env-scope-unproven error + advisory", () => {
    const bridgeDir = setupBridgeDir(sandbox);
    // Create a target outside sandbox.
    const outsideDir = mkdtempSync(join(tmpdir(), "omo-outside-"));
    try {
      const outsideTarget = join(outsideDir, "real-target");
      mkdirSync(outsideTarget, { recursive: true });
      // Create a symlink WITHIN sandbox pointing to the outside target.
      const symlinkPath = join(sandbox, "escape-link");
      symlinkSync(outsideTarget, symlinkPath);
      const r = resolveCanonicalBridge(symlinkPath, sandbox, [sandbox]);
      expect(r.isCanonical).toBe(false);
      expect(r.advisories.some((a) => a.kind === "symlink-escape")).toBe(true);
      expect(r.errors.some((e) => e.code === "env-scope-unproven")).toBe(true);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("path-like but different dir → bridge-like but not canonical", () => {
    const otherDir = join(sandbox, "packages", "some-other-pkg");
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, "package.json"), "{}");
    const r = resolveCanonicalBridge(otherDir, sandbox, [sandbox]);
    expect(r.isCanonical).toBe(false);
    // otherDir is path-like and resolves, but is not the canonical bridge.
    expect(r.isBridgeLikeButNotCanonical).toBe(true);
  });
});

describe("detectDuplicateBridgeEntries", () => {
  test("no bridge entries → 0", () => {
    setupBridgeDir(sandbox);
    const r = detectDuplicateBridgeEntries(
      ["oh-my-opencode-slim", "@scope/foo"],
      sandbox,
      [sandbox],
    );
    expect(r.canonicalCount).toBe(0);
    expect(r.equivalentIndices).toEqual([]);
  });

  test("one canonical bridge entry → 1", () => {
    const bridgeDir = setupBridgeDir(sandbox);
    const r = detectDuplicateBridgeEntries(
      ["oh-my-opencode-slim", bridgeDir],
      sandbox,
      [sandbox],
    );
    expect(r.canonicalCount).toBe(1);
    expect(r.equivalentIndices).toEqual([1]);
  });

  test("duplicate canonical entries → 2", () => {
    const bridgeDir = setupBridgeDir(sandbox);
    const r = detectDuplicateBridgeEntries(
      [bridgeDir, bridgeDir],
      sandbox,
      [sandbox],
    );
    expect(r.canonicalCount).toBe(2);
  });

  test("file:// URL equivalent to path → detected", () => {
    const bridgeDir = setupBridgeDir(sandbox);
    const fileUrl = `file://${bridgeDir}`;
    const r = detectDuplicateBridgeEntries(
      [bridgeDir, fileUrl],
      sandbox,
      [sandbox],
    );
    expect(r.canonicalCount).toBe(2);
  });
});

describe("arePluginEntriesEquivalent", () => {
  test("source canonical path ↔ effective canonical file-url matches", () => {
    const bridgeDir = setupBridgeDir(sandbox);
    const fileUrl = `file://${bridgeDir}`;
    const eq = arePluginEntriesEquivalent(
      { identity: bridgeDir, identityKind: "path", form: "string" },
      { identity: fileUrl, identityKind: "file-url", form: "string" },
      sandbox,
      [sandbox],
    );
    expect(eq).toBe(true);
  });

  test("reverse lexical forms (source file-url ↔ effective path) matches when both canonical", () => {
    const bridgeDir = setupBridgeDir(sandbox);
    const fileUrl = `file://${bridgeDir}`;
    const eq = arePluginEntriesEquivalent(
      { identity: fileUrl, identityKind: "file-url", form: "string" },
      { identity: bridgeDir, identityKind: "path", form: "string" },
      sandbox,
      [sandbox],
    );
    expect(eq).toBe(true);
  });

  test("arbitrary noncanonical path and file-url do NOT become equivalent", () => {
    const otherDir = join(sandbox, "other-pkg");
    mkdirSync(otherDir, { recursive: true });
    const fileUrl = `file://${otherDir}`;
    const eq = arePluginEntriesEquivalent(
      { identity: otherDir, identityKind: "path", form: "string" },
      { identity: fileUrl, identityKind: "file-url", form: "string" },
      sandbox,
      [sandbox],
    );
    expect(eq).toBe(false);
  });

  test("root/symlink escape or malformed file-url reject", () => {
    const bridgeDir = setupBridgeDir(sandbox);
    const outsideDir = mkdtempSync(join(tmpdir(), "outside-canonical-"));
    try {
      const outsideTarget = join(outsideDir, "target");
      mkdirSync(outsideTarget, { recursive: true });
      const symlinkPath = join(sandbox, "escape-link");
      symlinkSync(outsideTarget, symlinkPath);

      // Symlink escape
      expect(
        arePluginEntriesEquivalent(
          { identity: symlinkPath, identityKind: "path", form: "string" },
          { identity: `file://${bridgeDir}`, identityKind: "file-url", form: "string" },
          sandbox,
          [sandbox],
        ),
      ).toBe(false);

      // Malformed file URL
      expect(
        arePluginEntriesEquivalent(
          { identity: bridgeDir, identityKind: "path", form: "string" },
          { identity: "file:///%ZZmalformed", identityKind: "file-url", form: "string" },
          sandbox,
          [sandbox],
        ),
      ).toBe(false);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("npm/order/form mismatches still block", () => {
    const bridgeDir = setupBridgeDir(sandbox);
    const fileUrl = `file://${bridgeDir}`;

    // Form mismatch (string vs tuple)
    expect(
      arePluginEntriesEquivalent(
        { identity: bridgeDir, identityKind: "path", form: "string" },
        { identity: fileUrl, identityKind: "file-url", form: "tuple" },
        sandbox,
        [sandbox],
      ),
    ).toBe(false);

    // npm string mismatch
    expect(
      arePluginEntriesEquivalent(
        { identity: "foo-plugin", identityKind: "npm", form: "string" },
        { identity: "bar-plugin", identityKind: "npm", form: "string" },
        sandbox,
        [sandbox],
      ),
    ).toBe(false);
  });
});

describe("canonicalBridgeDir", () => {
  test("returns joined path under project root", () => {
    const dir = canonicalBridgeDir("/Users/matt/Repos/omo-slim");
    expect(dir).toBe("/Users/matt/Repos/omo-slim/packages/omo-telemetry-bridge");
  });

  test("returns realpath when exists", () => {
    const bridgeDir = setupBridgeDir(sandbox);
    const dir = canonicalBridgeDir(sandbox);
    expect(existsSync(dir)).toBe(true);
    expect(realpathSync(dir)).toBe(realpathSync(bridgeDir));
  });
});