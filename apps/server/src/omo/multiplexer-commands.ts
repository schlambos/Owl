/**
 * Static command runner for multiplexer availability (Slice 16).
 *
 * The control plane may ONLY use static `command -v` for the exact commands
 * tmux, zellij, herdr, kitten, kitty, cmux, opencode. No user-supplied
 * command, no version/binary execution, no path crawl. Ensures no unscoped
 * mux command is ever callable.
 */

import type { CommandRunner } from "../omo/multiplexer";

/**
 * Production command runner: runs `command -v <name>` via a child process.
 * Returns the trimmed first stdout line (path) when exit code 0, else null.
 * Never throws.
 */
export class StaticCommandRunner implements CommandRunner {
  constructor(
    private readonly spawn: (cmd: string, args: string[]) => Promise<{
      exited: Promise<number>;
      stdout: () => Promise<string>;
    }>,
  ) {}

  async resolve(name: string): Promise<string | null> {
    // Strict allowlist — no unscoped command is ever callable.
    const allowed = new Set([
      "tmux",
      "zellij",
      "herdr",
      "kitten",
      "kitty",
      "cmux",
      "opencode",
    ]);
    if (!allowed.has(name)) return null;
    try {
      const proc = await this.spawn("command", ["-v", name]);
      const exitCode = await proc.exited;
      if (exitCode !== 0) return null;
      const stdout = await proc.stdout();
      const path = stdout.trim().split("\n")[0];
      return path || null;
    } catch {
      return null;
    }
  }
}

/**
 * Test command runner: returns paths from a static map. Never executes
 * anything. Paths are opaque strings (never inspected).
 */
export class FakeCommandRunner implements CommandRunner {
  constructor(private readonly paths: Record<string, string | null>) {}

  async resolve(name: string): Promise<string | null> {
    const allowed = new Set([
      "tmux",
      "zellij",
      "herdr",
      "kitten",
      "kitty",
      "cmux",
      "opencode",
    ]);
    if (!allowed.has(name)) return null;
    return this.paths[name] ?? null;
  }
}