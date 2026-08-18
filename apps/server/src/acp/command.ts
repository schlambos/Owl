/**
 * Safe command resolution probe: `command -v` semantics without PATH crawling.
 * Returns resolved/not-resolved/unknown only; never inspects the binary.
 */

import { spawnSync } from "node:child_process";

export type CommandResolution =
  | { status: "resolved"; path: string }
  | { status: "not-resolved" }
  | { status: "unknown"; reason: string };

const SAFE_PROBE_RE = /^[A-Za-z0-9._+\-/:@-]+$/;

export function resolveCommand(command: string): CommandResolution {
  try {
    if (!command || !SAFE_PROBE_RE.test(command) || command.includes("..")) {
      return { status: "unknown", reason: "command fails probe validation" };
    }
    // Absolute path beneath / would violate FS boundary if inspected; treat as opaque.
    if (command.startsWith("/")) {
      return { status: "unknown", reason: "absolute command paths not probed (filesystem boundary)" };
    }
    // No interpolation: $1 expanded by sh
    const r = spawnSync("sh", ["-c", 'command -v "$1"', "_", command], {
      encoding: "utf8",
      timeout: 3000,
    });
    const out = String(r.stdout ?? "").trim();
    if (r.status === 0 && out) {
      return { status: "resolved", path: out };
    }
    // fallback: which without interpolation
    const w = spawnSync("which", [command], { encoding: "utf8", timeout: 3000 });
    const wout = String(w.stdout ?? "").trim();
    if (w.status === 0 && wout) return { status: "resolved", path: wout };
    return { status: "not-resolved" };
  } catch (e) {
    return { status: "unknown", reason: e instanceof Error ? e.message : String(e) };
  }
}
