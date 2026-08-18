/**
 * Slice 18 D0 — authorized logical source fingerprints.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fingerprintAuthorizedSource } from "./fingerprint";

const ROOT = join(import.meta.dir, "../../test/schema-sandbox/fingerprint");

function cfg(userDir: string, projDir: string) {
  return {
    host: "127.0.0.1",
    port: 0,
    opencodeConfigDir: userDir,
    projectDirectory: projDir,
    owlInstallDirectory: projDir,
    authorizedRoots: [userDir, projDir, ROOT],
  };
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("fingerprintAuthorizedSource", () => {
  test("missing project source: exists false, jsonc format, null hash/mtime", () => {
    const userDir = join(ROOT, "cfg-missing");
    const projDir = join(ROOT, "proj-missing");
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projDir, { recursive: true });
    const fp = fingerprintAuthorizedSource(cfg(userDir, projDir), "project", 7);
    expect(fp).toEqual({
      exists: false,
      sha256: null,
      format: "jsonc",
      mtimeMs: null,
      generation: 7,
    });
  });

  test("existing json source: full content hash, format, mtime, generation", () => {
    const userDir = join(ROOT, "cfg-json");
    const projDir = join(ROOT, "proj-json");
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projDir, { recursive: true });
    const text = `{\n  "preset": "x"\n}\n`;
    writeFileSync(join(userDir, "oh-my-opencode-slim.json"), text);
    const fp = fingerprintAuthorizedSource(cfg(userDir, projDir), "user", 3);
    expect(fp.exists).toBe(true);
    expect(fp.format).toBe("json");
    expect(fp.sha256).toBe(createHash("sha256").update(text).digest("hex"));
    expect(fp.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof fp.mtimeMs).toBe("number");
    expect(fp.mtimeMs).toBeGreaterThan(0);
    expect(fp.generation).toBe(3);
  });

  test("JSONC takes precedence when both formats exist", () => {
    const userDir = join(ROOT, "cfg-both");
    const projDir = join(ROOT, "proj-both");
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projDir, { recursive: true });
    const jsonc = `{\n  // preferred\n  "preset": "jsonc"\n}\n`;
    const json = `{"preset":"json"}\n`;
    writeFileSync(join(userDir, "oh-my-opencode-slim.jsonc"), jsonc);
    writeFileSync(join(userDir, "oh-my-opencode-slim.json"), json);
    const fp = fingerprintAuthorizedSource(cfg(userDir, projDir), "user", 1);
    expect(fp.exists).toBe(true);
    expect(fp.format).toBe("jsonc");
    expect(fp.sha256).toBe(createHash("sha256").update(jsonc).digest("hex"));
    expect(fp.sha256).not.toBe(createHash("sha256").update(json).digest("hex"));
  });

  test("only logical authorized user/project sources — no client path", () => {
    const userDir = join(ROOT, "cfg-logical");
    const projDir = join(ROOT, "proj-logical");
    mkdirSync(userDir, { recursive: true });
    mkdirSync(join(projDir, ".opencode"), { recursive: true });
    writeFileSync(
      join(userDir, "oh-my-opencode-slim.json"),
      `{"preset":"user"}\n`,
    );
    writeFileSync(
      join(projDir, ".opencode", "oh-my-opencode-slim.jsonc"),
      `{"preset":"project"}\n`,
    );
    const user = fingerprintAuthorizedSource(cfg(userDir, projDir), "user", 0);
    const project = fingerprintAuthorizedSource(
      cfg(userDir, projDir),
      "project",
      0,
    );
    expect(user.format).toBe("json");
    expect(project.format).toBe("jsonc");
    expect(user.sha256).not.toBe(project.sha256);
    expect(user.exists && project.exists).toBe(true);
  });
});
