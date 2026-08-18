/**
 * Dev supervisor: one-command `bun run dev` for server + frontend.
 *
 * Why this exists
 * ---------------
 * The previous root script used shell-background `&`:
 *   "dev": "bun run --filter @omo/server dev & bun run --filter @omo/web dev"
 * That pattern has two defects this supervisor fixes:
 *   1. Lifecycle leaks: the shell backgrounds both children and exits, leaving
 *      `bun --filter` wrappers, the server, and vite running detached. A bare
 *      Ctrl-C in the launching shell does not reach them reliably.
 *   2. No signal coordination: the server owns an SDK-started OpenCode backend
 *      in Managed mode and must run its `shutdown()` (which calls
 *      `lifecycle.stop()` → `handle.close()`) to close that backend. If the
 *      server is SIGKILLed or orphaned, the owned OpenCode backend leaks.
 *
 * What this supervisor does
 * -------------------------
 *   - Spawns server and web as direct child processes (no shell `&`, no
 *     detached `bun --filter` wrapper that exits before its child does).
 *   - Forwards SIGINT/SIGTERM to both children and waits for them to exit
 *     before exiting itself, so the server's graceful shutdown path runs.
 *   - If one child exits unexpectedly, stops the other and exits non-zero.
 *   - Does NOT spawn `opencode serve`. In Managed mode the server's
 *     OpenCodeLifecycleManager starts/owns/stops the SDK backend itself.
 *
 * What this supervisor does NOT do
 * -------------------------------
 *   - It does not invent PID files, log streaming, or restart-on-crash
 *     supervision. The server's `--watch` (from its own dev script) handles
 *     hot restart; this supervisor only coordinates process lifetime.
 *   - It does not parse or own OpenCode lifecycle state. The server is the
 *     single authority for backend ownership, readiness, and shutdown.
 *
 * Exit codes
 * ----------
 *   0  both children exited cleanly (or were stopped by a forwarded signal)
 *   1  one child exited unexpectedly and the supervisor tore down the other
 *   130 received SIGINT/SIGTERM and forwarded it (128 + signal)
 */

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_DIR = join(ROOT, "apps", "server");
const WEB_DIR = join(ROOT, "apps", "web");

const SERVER_CMD = "bun";
// Run the server entry directly from the repo root. The server requires
// cwd = the fixed project directory in Managed mode (it rejects any other
// cwd because the installed SDK has no cwd option and inherits process.cwd).
//
// NOTE: we intentionally do NOT use `bun --watch` here. `bun --watch` intercepts
// SIGINT/SIGTERM and does not exit (it treats them as restart triggers), which
// prevents the server's graceful shutdown() from running and leaks the owned
// SDK OpenCode backend. The server's own `dev:server` script keeps `--watch`
// for users who want hot restart as a separate command; this supervisor
// prioritizes clean signal forwarding and backend shutdown over auto-restart.
const SERVER_ARGS = [join("apps", "server", "src", "index.ts")];
const WEB_CMD = "bun";
// Vite resolves its config from apps/web; run it there so it picks up
// apps/web/vite.config.ts and the web tsconfig. Vite exits cleanly on SIGINT.
const WEB_ARGS = ["run", "dev"];

interface Child {
  name: string;
  proc: ReturnType<typeof spawn>;
  exited: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
}

function spawnChild(name: string, cmd: string, args: string[], cwd: string): Child {
  const proc = spawn(cmd, args, {
    cwd,
    stdio: "inherit",
    // Same process group so a terminal Ctrl-C also reaches children directly;
    // the supervisor additionally forwards explicit SIGINT/SIGTERM it catches.
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  const child: Child = { name, proc, exited: false, code: null, signal: null };
  proc.on("exit", (code, signal) => {
    child.exited = true;
    child.code = code;
    child.signal = signal;
  });
  proc.on("error", (err) => {
    console.error(`[dev] ${name} spawn error: ${err.message}`);
    child.exited = true;
    child.code = 1;
    child.signal = null;
  });
  return child;
}

async function waitFor(child: Child): Promise<void> {
  while (!child.exited) {
    await new Promise<void>((r) => setTimeout(r, 50));
  }
}

async function main(): Promise<number> {
  const server = spawnChild("server", SERVER_CMD, SERVER_ARGS, ROOT);
  const web = spawnChild("web", WEB_CMD, WEB_ARGS, WEB_DIR);

  let stopping = false;
  let exitCode = 0;

  const stopAll = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    exitCode = 128 + (signal === "SIGINT" ? 2 : 15);
    for (const c of [server, web]) {
      if (!c.exited) {
        try {
          c.proc.kill(signal);
        } catch {
          /* best-effort */
        }
      }
    }
  };

  // Forward terminal signals to both children. The server's SIGINT handler
  // runs its graceful shutdown (runtime.stop() + lifecycle.stop() + server.stop)
  // which closes the owned SDK OpenCode backend.
  process.on("SIGINT", () => stopAll("SIGINT"));
  process.on("SIGTERM", () => stopAll("SIGTERM"));

  // Wait for either child to exit, then decide.
  while (!server.exited && !web.exited) {
    await new Promise<void>((r) => setTimeout(r, 50));
  }

  if (stopping) {
    // A signal initiated teardown; wait for both to finish.
    await Promise.all([waitFor(server), waitFor(web)]);
    return exitCode;
  }

  // One child exited on its own. Tear down the survivor and surface the exit.
  const first = server.exited ? server : web;
  const survivor = server.exited ? web : server;
  console.error(
    `[dev] ${first.name} exited (code=${first.code} signal=${first.signal}); stopping ${survivor.name}`,
  );
  if (!survivor.exited) {
    try {
      survivor.proc.kill("SIGTERM");
    } catch {
      /* best-effort */
    }
    await waitFor(survivor);
  }
  // Unexpected exit → non-zero so CI/launchers can detect it.
  return first.code === 0 && first.signal === null ? 0 : 1;
}

process.exitCode = await main();