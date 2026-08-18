/**
 * Slice 18 D1 — adapters must not physically write OMO JSON.
 * Allowlist: transaction.ts. Exclusions: prompts.ts, opencode-bridge/**, tests.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ADAPTERS = [
  "mutate.ts",
  "globals.ts",
  "council.ts",
  "acp.ts",
  "presets.ts",
  "interview.ts",
  "raw.ts",
];

const FORBIDDEN = [
  "writeFileSync",
  "renameSync",
  "unlinkSync",
  "mkdirSync",
  "Bun.write",
  "fs.promises.writeFile",
  "fs.promises.rename",
];

const ROOT = join(import.meta.dir);

describe("transaction boundary (adapter source analysis)", () => {
  test("OMO JSON adapters do not invoke physical writes", () => {
    for (const file of ADAPTERS) {
      const src = readFileSync(join(ROOT, file), "utf-8");
      for (const token of FORBIDDEN) {
        expect(src.includes(token), `${file} must not contain ${token}`).toBe(
          false,
        );
      }
      expect(src).toMatch(
        /commitOmoCandidate|previewOmoCandidate|commitOmoRevisionRestore|previewThenCommit/,
      );
    }
  });

  test("transaction.ts is the sole adapter-side OMO JSON writer", () => {
    const src = readFileSync(join(ROOT, "transaction.ts"), "utf-8");
    expect(src).toContain("writeFileSync");
    expect(src).toContain("renameSync");
  });

  test("prompt-file and OpenCode-bridge remain labeled exclusions", () => {
    const prompts = readFileSync(join(ROOT, "prompts.ts"), "utf-8");
    expect(prompts).toContain("writeFileSync");
    const bridge = readFileSync(
      join(import.meta.dir, "../opencode-bridge/service.ts"),
      "utf-8",
    );
    expect(bridge.length).toBeGreaterThan(0);
  });
});
