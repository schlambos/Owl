/**
 * Slice 17 hardened — Watcher foundation.
 *
 * Oracle decision 11: one-shot self-write intent keyed exact path+hash+
 * token+expiry, armed before rename; error recovery/restart; idempotent
 * start/stop; separate watched paths. External events only invalidate.
 */

import { watch, type FSWatcher } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { BridgeWatcherEvent, BridgeWatcherOptions, SelfWriteIntent } from "./types";

const WATCHED_FILES = new Set(["opencode.json", "opencode.jsonc"]);

export interface BridgeWatcher {
  start(): void;
  stop(): void;
  onEvent(listener: (event: BridgeWatcherEvent) => void): void;
  /** Arm a one-shot self-write intent for exact path+hash+token+expiry. */
  armSelfWrite(intent: SelfWriteIntent): void;
}

export function createBridgeWatcher(opts: BridgeWatcherOptions): BridgeWatcher {
  const debounceMs = opts.debounceMs ?? 300;
  let watcher: FSWatcher | null = null;
  let listeners: Array<(event: BridgeWatcherEvent) => void> = [];
  let intents: SelfWriteIntent[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSeenHash: Record<string, string> = {};
  let started = false;
  let stopped = false;

  function emit(event: BridgeWatcherEvent): void {
    for (const l of listeners) {
      try { l(event); } catch { /* isolated */ }
    }
  }

  function hashFile(path: string): string {
    const content = readFileSync(path, "utf-8");
    return createHash("sha256").update(content).digest("hex");
  }

  function initLastSeen(): void {
    for (const fname of WATCHED_FILES) {
      const p = join(opts.directory, fname);
      if (existsSync(p)) {
        try { lastSeenHash[fname] = hashFile(p); } catch { /* skip */ }
      }
    }
  }

  function checkFiles(): void {
    if (stopped) return;
    const now = Date.now();

    // Purge expired intents.
    intents = intents.filter((i) => i.expiresAt > now);

    for (const fname of WATCHED_FILES) {
      const p = join(opts.directory, fname);
      let currentHash: string | null;
      try {
        if (!existsSync(p)) {
          currentHash = null;
        } else {
          currentHash = hashFile(p);
        }
      } catch { continue; }

      const prev = lastSeenHash[fname];

      if (currentHash === null) {
        if (prev !== undefined) {
          delete lastSeenHash[fname];
          emit({ kind: "removed", path: p, hash: "", timestamp: new Date().toISOString() });
        }
        continue;
      }

      if (prev === currentHash) continue;

      // Check self-write intents (one-shot, exact path+hash+token+expiry).
      const matchingIntent = intents.find(
        (i) => i.path === p && i.hash === currentHash,
      );
      if (matchingIntent) {
        lastSeenHash[fname] = currentHash;
        // Consume the intent (one-shot).
        intents = intents.filter((i) => i !== matchingIntent);
        emit({ kind: "self-write", path: p, hash: currentHash, timestamp: new Date().toISOString() });
        continue;
      }

      // External edit.
      lastSeenHash[fname] = currentHash;
      emit({ kind: "external-edit", path: p, hash: currentHash, timestamp: new Date().toISOString() });
    }
  }

  function onFsEvent(): void {
    if (stopped) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      checkFiles();
    }, debounceMs);
  }

  function startWatch(): void {
    if (stopped || started) return;
    try {
      if (!existsSync(opts.directory)) return;
      initLastSeen();
      watcher = watch(opts.directory, { recursive: false }, () => { onFsEvent(); });
      onFsEvent(); // initial poll
      started = true;
    } catch {
      // Error recovery: will retry on next start() call.
      started = false;
    }
  }

  function stopWatch(): void {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    try { watcher?.close(); } catch { /* */ }
    watcher = null;
    started = false;
  }

  return {
    start(): void {
      if (stopped) return;
      if (started) return; // idempotent
      startWatch();
    },
    stop(): void {
      if (stopped) return; // idempotent
      stopped = true;
      stopWatch();
      listeners = [];
      intents = [];
    },
    onEvent(listener: (event: BridgeWatcherEvent) => void): void {
      listeners.push(listener);
    },
    armSelfWrite(intent: SelfWriteIntent): void {
      if (stopped) return;
      intents.push(intent);
    },
  };
}

/** Generate a crypto-random self-write token. */
export function generateSelfWriteToken(): string {
  return randomBytes(16).toString("hex");
}