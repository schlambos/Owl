#!/usr/bin/env bun
/**
 * Desktop sidecar smoke harness.
 *
 * CLI: bun run scripts/smoke-sidecar.ts [--bin <absolute-sidecar-path>]
 * Defaults to the host-triple sidecar under src-tauri/binaries.
 *
 * Prerequisite: `bun run desktop:prepare` has produced src-tauri/resources.
 *
 * Flow (mirrors the desktop shell exactly):
 *  - stage resources under a temp install root (simulates the Rust staging
 *    into app-data `runtime/current` so the install-root proof and bridge
 *    identity resolve against the staged tree);
 *  - spawn the sidecar in desktop mode with an unpredictable token;
 *  - parse the exact `OWL_READY http://127.0.0.1:<port>` line (bounded);
 *  - verify SPA HTML, security headers (CSP/XFO/nosniff), exact-origin CORS;
 *  - verify /internal/shutdown rejects missing/wrong tokens and that the
 *    correct token yields 200 followed by process exit.
 */

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { BridgeRevisionStore } from "../apps/server/src/opencode-bridge/revisions-bridge";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESOURCES = join(ROOT, "src-tauri", "resources");
const BINARIES = join(ROOT, "src-tauri", "binaries");

function fail(msg: string): never {
  console.error(`[smoke-sidecar] error: ${msg}`);
  console.error(`usage: bun run scripts/smoke-sidecar.ts [--bin <absolute-sidecar-path>]`);
  process.exit(1);
}

function defaultBinPath(): string {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return join(BINARIES, "owl-aarch64-apple-darwin");
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return join(BINARIES, "owl-x86_64-pc-windows-msvc.exe");
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return join(BINARIES, "owl-x86_64-unknown-linux-gnu");
  }
  fail(`unsupported host ${process.platform}/${process.arch}`);
}

function parseArgs(): string {
  const args = process.argv.slice(2);
  let bin: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--bin") {
      if (bin !== undefined) fail("duplicate --bin");
      if (i + 1 >= args.length) fail("--bin requires a value");
      bin = args[++i];
      if (!bin) fail("--bin requires a non-empty value");
    } else if (a.startsWith("--bin=")) {
      if (bin !== undefined) fail("duplicate --bin");
      bin = a.slice("--bin=".length);
      if (!bin) fail("--bin requires a non-empty value");
    } else {
      fail(`unknown argument: ${a}`);
    }
  }
  const path = bin ?? defaultBinPath();
  if (!isAbsolute(path)) fail(`sidecar path must be absolute: ${path}`);
  try {
    if (!statSync(path).isFile()) fail(`sidecar missing: ${path}`);
  } catch {
    fail(`sidecar missing: ${path} (run: bun run desktop:prepare)`);
  }
  return path;
}

function requireResources(): void {
  const webIndex = join(RESOURCES, "web", "index.html");
  const pkg = join(RESOURCES, "package.json");
  if (!existsSync(webIndex) || !existsSync(pkg)) {
    fail("src-tauri/resources is incomplete (run: bun run desktop:prepare)");
  }
}

function buildSafeEnv(token: string, projectDir: string, configDir: string): Record<string, string> {
  // Explicit whitelist (same approach as the former CLI smoke): PATH plus
  // Windows host vars; never inherit provider/auth/OpenCode secrets.
  const allowLower = new Set<string>([
    "path",
    "pathext",
    "systemroot",
    "windir",
    "tmp",
    "temp",
    "tmpdir",
    "comspec",
    "systemdrive",
    "os",
    "number_of_processors",
    "processor_architecture",
    "processor_architew6432",
    "localappdata",
    "userprofile",
    "programdata",
    "programfiles",
    "programfiles(x86)",
    "commonprogramfiles",
    "commonprogramfiles(x86)",
    "home",
    "user",
    "shell",
  ]);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (allowLower.has(k.toLowerCase())) env[k] = v;
  }
  env["OMO_CP_DESKTOP"] = "1";
  env["OMO_CP_SHUTDOWN_TOKEN"] = token;
  env["OMO_CP_HOST"] = "127.0.0.1";
  env["OMO_CP_PORT"] = "0";
  env["OMO_CP_PROJECT_DIR"] = projectDir;
  env["OPENCODE_CONFIG_DIR"] = configDir;
  // Dead attach backend; the smoke never starts a managed OpenCode.
  env["OPENCODE_BASE_URL"] = "http://127.0.0.1:1";
  return env;
}

async function awaitReadyLine(
  child: ChildProcess,
  stdout: () => string,
  stderr: () => string,
): Promise<string> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `sidecar exited early (code=${child.exitCode} signal=${child.signalCode})` +
          diag(stdout, stderr),
      );
    }
    const m = /^OWL_READY (http:\/\/127\.0\.0\.1:\d+)\s*$/m.exec(stdout());
    if (m?.[1]) return m[1];
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out waiting for OWL_READY line" + diag(stdout, stderr));
}

function diag(stdout: () => string, stderr: () => string): string {
  let s = "";
  const out = stdout().slice(-4000);
  const err = stderr().slice(-4000);
  if (out.trim()) s += `\n--- stdout (tail) ---\n${out}`;
  if (err.trim()) s += `\n--- stderr (tail) ---\n${err}`;
  return s;
}

async function expectStatus(
  init: string,
  expected: number,
  requestInit?: RequestInit,
): Promise<Response> {
  const res = await fetch(init, { signal: AbortSignal.timeout(5000), ...requestInit });
  if (res.status !== expected) {
    const body = await res.text().catch(() => "");
    throw new Error(`${init} expected ${expected} got ${res.status} body=${body.slice(0, 300)}`);
  }
  return res;
}

async function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// ── Managed-mode coverage (regression: dirty bridge must not block reuse) ──

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Minimal deterministic fake OpenCode backend on the preferred loopback port
 * (127.0.0.1:4096). Satisfies the lifecycle's full-compatibility probe
 * (/global/health, /config/providers, /provider, /agent with orchestrator +
 * 3 specialists) so the sidecar classifies it as a reusable preexisting
 * backend. No real credentials/config are required.
 */
function startFakeOpenCode(port: number): { stop(): void } {
  const agents = [
    { name: "orchestrator" },
    { name: "explorer" },
    { name: "librarian" },
    { name: "oracle" },
  ];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/global/health") return json({ healthy: true, version: "1.18.14" });
      if (path === "/config/providers") return json({ providers: [] });
      if (path === "/provider") return json({ all: [], connected: [] });
      if (path === "/agent") return json(agents);
      if (path === "/config") return json({ plugin: [] });
      return json({});
    },
  });
  return { stop: () => server.stop(true) };
}

/**
 * Seed the exact shipped v0.1.2 failure shape: a committed ACTIVE bridge
 * activation whose target config file has since drifted (external edit), so
 * startup reconciliation classifies it recovery-pending. The DB lives at
 * `<projectDir>/data/control-plane-bridge.db` (the sidecar's default path).
 */
function seedDirtyBridgeState(projectDir: string, configDir: string): void {
  const dbPath = join(projectDir, "data", "control-plane-bridge.db");
  const configPath = join(configDir, "opencode.json");
  const store = new BridgeRevisionStore(dbPath, [projectDir, configDir]);
  const content = `{"plugin":["/canonical/bridge"]}`;
  writeFileSync(configPath, content, "utf-8");
  const cfgHash = createHash("sha256").update(content).digest("hex");
  store.insertPreparedIntent({
    id: "intent_smoke_managed",
    targetPath: configPath,
    sourceKind: "opencode-config-dir",
    operation: "add",
    baselineHash: "h_base",
    proposedHash: cfgHash,
    canonicalIdentity: "/canonical/bridge",
    port: 8788,
    registrationTransport: "env",
    transportMode: "loopback-http",
    nonceFingerprint: "a".repeat(64),
    bytePatch: "{}",
    rawActivationNonce: "nonce-1234567890abcdef",
  });
  store.finalizeIntent("intent_smoke_managed", "rev_smoke_managed", new Date().toISOString(), cfgHash);
  // External drift: modify the committed target after commit.
  writeFileSync(configPath, `${content}\n// external drift\n`, "utf-8");
  store.close();
}

interface LifecycleSnapshot {
  status?: string;
  ownership?: string;
  generation?: number;
  error?: { code?: string };
}

/** Poll /api/opencode/lifecycle until the predicate holds or the deadline passes. */
async function awaitLifecycle(
  origin: string,
  predicate: (s: LifecycleSnapshot) => boolean,
  timeoutMs: number,
): Promise<LifecycleSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let last: LifecycleSnapshot = {};
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/api/opencode/lifecycle`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        last = (await res.json()) as LifecycleSnapshot;
        if (predicate(last)) return last;
      }
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return last;
}

/**
 * Wait for the managed-mode listening line
 * `[omo-cp] listening on http://127.0.0.1:<port>` (managed mode does not emit
 * the desktop-only OWL_READY line). Returns the loopback origin.
 */
async function awaitListeningLine(
  child: ChildProcess,
  stdout: () => string,
  stderr: () => string,
): Promise<string> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `managed sidecar exited early (code=${child.exitCode} signal=${child.signalCode})` +
          diag(stdout, stderr),
      );
    }
    const m = /\[omo-cp\] listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout());
    if (m?.[1]) return m[1];
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out waiting for managed listening line" + diag(stdout, stderr));
}

/**
 * Managed-mode phase: prove a dirty bridge reconciliation does NOT block
 * reuse of a compatible preexisting OpenCode backend (the shipped v0.1.2
 * regression). Spawns the staged sidecar in managed mode (no
 * OPENCODE_BASE_URL, no OMO_CP_DESKTOP) against a fake OpenCode on 4096 and
 * a seeded dirty bridge DB, then asserts the lifecycle reaches
 * connected/external (reuse) rather than failed/bridge-reconciliation-dirty.
 */
async function runManagedPhase(stage: string, stagedBin: string): Promise<void> {
  const projectDir = mkdtempSync(join(tmpdir(), "omo-sidecar-mgmt-project-"));
  const configDir = mkdtempSync(join(tmpdir(), "omo-sidecar-mgmt-config-"));
  const fake = startFakeOpenCode(4096);
  let child: ChildProcess | undefined;
  let stdoutBuf = "";
  let stderrBuf = "";
  const maxBuf = 64 * 1024;
  try {
    seedDirtyBridgeState(projectDir, configDir);

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (["path", "home", "user", "shell", "tmp", "temp", "tmpdir"].includes(k.toLowerCase())) {
        env[k] = v;
      }
    }
    env["OMO_CP_HOST"] = "127.0.0.1";
    env["OMO_CP_PORT"] = "0";
    env["OMO_CP_INSTALL_DIR"] = stage;
    env["OMO_CP_PROJECT_DIR"] = projectDir;
    env["OPENCODE_CONFIG_DIR"] = configDir;
    // Managed mode: OPENCODE_BASE_URL deliberately absent.

    child = spawn(stagedBin, [], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: stage,
      windowsHide: true,
    });
    child.stdout?.on("data", (c: Buffer) => {
      stdoutBuf += c.toString("utf-8");
      if (stdoutBuf.length > maxBuf) stdoutBuf = stdoutBuf.slice(-maxBuf);
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderrBuf += c.toString("utf-8");
      if (stderrBuf.length > maxBuf) stderrBuf = stderrBuf.slice(-maxBuf);
    });

    const origin = await awaitListeningLine(child, () => stdoutBuf, () => stderrBuf);
    console.log(`[smoke-sidecar] managed ready: ${origin}`);

    const snap = await awaitLifecycle(
      origin,
      (s) => s.status === "connected" || s.status === "failed",
      30_000,
    );
    if (snap.status !== "connected" || snap.ownership !== "external") {
      throw new Error(
        `managed phase: expected connected/external reuse, got status=${snap.status} ownership=${snap.ownership} error=${snap.error?.code ?? "none"}`,
      );
    }
    console.log(`[smoke-sidecar] managed phase ok: reused preexisting backend (external) despite dirty bridge`);

    // Graceful shutdown via SIGTERM (managed mode has no shutdown token route).
    child.kill("SIGTERM");
    if (!(await waitExit(child, 10_000))) {
      throw new Error("managed sidecar did not exit within 10s after SIGTERM");
    }
  } finally {
    if (child && !(await waitExit(child, 500))) {
      try { child.kill("SIGKILL"); } catch { /* */ }
      await waitExit(child, 3000);
    }
    fake.stop();
    for (const d of [projectDir, configDir]) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
    }
  }
}

async function main(): Promise<void> {
  const bin = parseArgs();
  requireResources();

  const stage = mkdtempSync(join(tmpdir(), "omo-sidecar-stage-"));
  const projectDir = mkdtempSync(join(tmpdir(), "omo-sidecar-project-"));
  const configDir = mkdtempSync(join(tmpdir(), "omo-sidecar-config-"));

  let child: ChildProcess | undefined;
  let stdoutBuf = "";
  let stderrBuf = "";
  const maxBuf = 64 * 1024;
  let exitCode = 0;

  try {
    // Stage: simulated app-data runtime/current tree.
    const stagedBin = join(stage, process.platform === "win32" ? "owl.exe" : "owl");
    copyFileSync(bin, stagedBin);
    cpSync(join(RESOURCES, "web"), join(stage, "web"), { recursive: true });
    cpSync(join(RESOURCES, "packages"), join(stage, "packages"), { recursive: true });
    copyFileSync(join(RESOURCES, "package.json"), join(stage, "package.json"));
    if (process.platform !== "win32") {
      chmodSync(stagedBin, 0o755);
    }

    const token = randomBytes(32).toString("hex");
    const env = buildSafeEnv(token, projectDir, configDir);

    child = spawn(stagedBin, [], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: stage,
      windowsHide: true,
    });
    child.stdout?.on("data", (c: Buffer) => {
      stdoutBuf += c.toString("utf-8");
      if (stdoutBuf.length > maxBuf) stdoutBuf = stdoutBuf.slice(-maxBuf);
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderrBuf += c.toString("utf-8");
      if (stderrBuf.length > maxBuf) stderrBuf = stderrBuf.slice(-maxBuf);
    });
    child.on("error", (e) => {
      stderrBuf += `\nspawn error: ${String(e)}\n`;
    });

    const origin = await awaitReadyLine(child, () => stdoutBuf, () => stderrBuf);
    console.log(`[smoke-sidecar] ready: ${origin}`);

    // SPA HTML + security headers.
    const index = await expectStatus(`${origin}/`, 200);
    const ct = (index.headers.get("content-type") ?? "").toLowerCase();
    if (!ct.includes("text/html")) throw new Error(`/ content-type not HTML: ${ct}`);
    const csp = index.headers.get("content-security-policy") ?? "";
    if (!csp.includes("default-src 'self'")) throw new Error(`missing/weak CSP: ${csp}`);
    if (index.headers.get("x-frame-options") !== "DENY") throw new Error("missing XFO DENY");
    if (index.headers.get("x-content-type-options") !== "nosniff") throw new Error("missing nosniff");
    await index.text();

    // SPA fallback route.
    await expectStatus(`${origin}/agents`, 200);

    // API health + exact desktop CORS origin.
    const health = await expectStatus(`${origin}/api/health`, 200);
    const acao = health.headers.get("access-control-allow-origin") ?? "";
    if (acao !== origin) throw new Error(`CORS allow-origin not exact origin: "${acao}" != "${origin}"`);
    const healthBody = (await health.json()) as { ok?: boolean };
    if (healthBody.ok !== true) throw new Error(`/api/health ok !== true`);

    // JSON 404 for unknown API route.
    await expectStatus(`${origin}/api/release-smoke-missing`, 404);

    // Shutdown auth: missing token → 403; wrong token → 403; GET → 404.
    await expectStatus(`${origin}/internal/shutdown`, 403, { method: "POST" });
    await expectStatus(`${origin}/internal/shutdown`, 403, {
      method: "POST",
      headers: { authorization: `Bearer ${"0".repeat(64)}` },
    });
    await expectStatus(`${origin}/internal/shutdown`, 404, { method: "GET" });

    // Correct token → 200, then the process must exit on its own.
    const ok = await expectStatus(`${origin}/internal/shutdown`, 200, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const okBody = (await ok.json()) as { ok?: boolean };
    if (okBody.ok !== true) throw new Error(`/internal/shutdown ok !== true`);

    const exited = await waitExit(child, 10_000);
    if (!exited) {
      throw new Error("sidecar did not exit within 10s after authenticated shutdown");
    }
    if (child.exitCode !== 0) {
      throw new Error(`sidecar exit code ${child.exitCode} (signal ${child.signalCode})`);
    }

    console.log(`[smoke-sidecar] ok`);
    console.log(`  origin: ${origin}`);
    console.log(`  stage: ${stage} (removed)`);
    console.log(`  checks: SPA html+CSP/XFO/nosniff, exact CORS, /api/health, JSON 404, shutdown auth (403/403/404/200+exit 0)`);

    // ── Managed-mode phase: dirty bridge must not block preexisting reuse ──
    // Regression for the shipped v0.1.2 failure: a committed active bridge
    // whose target config drifted (recovery-pending reconciliation) must NOT
    // block reuse of a compatible OpenCode already listening on 4096. The
    // sidecar runs in managed mode (no OPENCODE_BASE_URL, no OMO_CP_DESKTOP).
    await runManagedPhase(stage, stagedBin);
  } catch (e) {
    exitCode = 1;
    console.error(`[smoke-sidecar] failed: ${e instanceof Error ? e.message : String(e)}`);
    console.error(diag(() => stdoutBuf, () => stderrBuf));
    process.exitCode = 1;
  } finally {
    if (child && !(await waitExit(child, 500))) {
      try {
        child.kill("SIGKILL");
      } catch {
        try {
          child.kill();
        } catch {}
      }
      await waitExit(child, 3000);
    }
    for (const d of [stage, projectDir, configDir]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
    if (exitCode !== 0) process.exit(exitCode);
  }
}

await main();
