/**
 * Slice 17 hardened — Watcher foundation tests.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridgeWatcher, generateSelfWriteToken } from "./watcher";
import { createHash } from "node:crypto";

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "omo-watch-"));
});

afterEach(() => {
  try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* */ }
});

function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("createBridgeWatcher", () => {
  test("detects external edit to opencode.json", async () => {
    const path = join(sandbox, "opencode.json");
    writeFileSync(path, `{"plugin":["foo"]}`, "utf-8");

    const events: string[] = [];
    const watcher = createBridgeWatcher({ directory: sandbox, debounceMs: 50 });
    watcher.onEvent((e) => events.push(e.kind));
    watcher.start();

    await sleep(80);
    writeFileSync(path, `{"plugin":["bar"]}`, "utf-8");
    await sleep(150);

    watcher.stop();
    expect(events).toContain("external-edit");
  });

  test("self-write intent: matching path+hash → self-write event", async () => {
    const path = join(sandbox, "opencode.json");
    writeFileSync(path, `{"plugin":["foo"]}`, "utf-8");
    const selfHash = hashContent(`{"plugin":["foo","bridge"]}`);
    const token = generateSelfWriteToken();

    const events: string[] = [];
    const watcher = createBridgeWatcher({ directory: sandbox, debounceMs: 50 });
    watcher.onEvent((e) => events.push(e.kind));
    watcher.start();

    await sleep(80);
    watcher.armSelfWrite({ path, hash: selfHash, token, expiresAt: Date.now() + 10_000 });
    writeFileSync(path, `{"plugin":["foo","bridge"]}`, "utf-8");
    await sleep(150);

    watcher.stop();
    expect(events).toContain("self-write");
    expect(events).not.toContain("external-edit");
  });

  test("expired self-write intent → external-edit", async () => {
    const path = join(sandbox, "opencode.json");
    writeFileSync(path, `{"plugin":["foo"]}`, "utf-8");
    const selfHash = hashContent(`{"plugin":["foo","bridge"]}`);
    const token = generateSelfWriteToken();

    const events: string[] = [];
    const watcher = createBridgeWatcher({ directory: sandbox, debounceMs: 50 });
    watcher.onEvent((e) => events.push(e.kind));
    watcher.start();

    await sleep(80);
    // Arm with already-expired intent.
    watcher.armSelfWrite({ path, hash: selfHash, token, expiresAt: Date.now() - 1 });
    writeFileSync(path, `{"plugin":["foo","bridge"]}`, "utf-8");
    await sleep(150);

    watcher.stop();
    expect(events).toContain("external-edit");
  });

  test("removed file → removed event", async () => {
    const path = join(sandbox, "opencode.json");
    writeFileSync(path, `{"plugin":["foo"]}`, "utf-8");

    const events: string[] = [];
    const watcher = createBridgeWatcher({ directory: sandbox, debounceMs: 50 });
    watcher.onEvent((e) => events.push(e.kind));
    watcher.start();

    await sleep(80);
    rmSync(path);
    await sleep(150);

    watcher.stop();
    expect(events).toContain("removed");
  });

  test("no change → no external-edit/removed events", async () => {
    const path = join(sandbox, "opencode.json");
    writeFileSync(path, `{"plugin":["foo"]}`, "utf-8");

    const events: string[] = [];
    const watcher = createBridgeWatcher({ directory: sandbox, debounceMs: 50 });
    watcher.onEvent((e) => events.push(e.kind));
    watcher.start();
    await sleep(150);
    watcher.stop();

    expect(events.filter((e) => e === "external-edit" || e === "removed")).toHaveLength(0);
  });

  test("idempotent start/stop", () => {
    const watcher = createBridgeWatcher({ directory: sandbox, debounceMs: 50 });
    watcher.start();
    watcher.start(); // idempotent
    watcher.stop();
    watcher.stop(); // idempotent
    expect(true).toBe(true); // no throw
  });

  test("missing directory → start is no-op", () => {
    const watcher = createBridgeWatcher({
      directory: join(sandbox, "nonexistent"),
      debounceMs: 50,
    });
    watcher.start();
    watcher.stop();
    expect(true).toBe(true);
  });
});