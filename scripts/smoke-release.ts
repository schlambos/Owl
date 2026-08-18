#!/usr/bin/env bun
/**
 * Release smoke harness.
 *
 * CLI: bun run scripts/smoke-release.ts --dir <absolute-prepared-dir>
 * Strict args: only --dir <abs> or --dir=<abs> is accepted.
 * Requires: dir exists, contains executable (owl / owl.exe) and web/index.html.
 *
 * Flow:
 *  - mkdtemp project/config dirs
 *  - reserve ephemeral 127.0.0.1 port
 *  - spawn artifact with safe env whitelist only
 *  - poll /api/health bounded (dead Attach backend expected)
 *  - validate web/index.html assets + SPA + API 404s
 *  - always stop child (graceful → SIGKILL escalation) and remove temps
 *  - capture stdout/stderr for diagnostics without exposing secrets
 */

import { existsSync, statSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  console.error(`usage: bun run scripts/smoke-release.ts --dir <absolute-prepared-dir>`);
  process.exit(1);
}

function parseDirArg(): string {
  const argv = process.argv.slice(2);
  let dir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === "--dir") {
      if (dir !== undefined) fail("duplicate --dir");
      const next = argv[i + 1];
      if (next === undefined || next === "" || next.startsWith("-")) {
        fail("--dir requires a non-empty value");
      }
      dir = next;
      i += 2;
      continue;
    }
    if (arg.startsWith("--dir=")) {
      if (dir !== undefined) fail("duplicate --dir");
      const val = arg.slice("--dir=".length);
      if (!val) fail("--dir requires a non-empty value");
      dir = val;
      i += 1;
      continue;
    }
    // strict: any other flag or positional is invalid
    fail(`unknown argument: ${arg}`);
  }
  if (dir === undefined) fail("missing required --dir <absolute-prepared-dir>");
  return dir!;
}

function requirePreparedDir(dir: string): { artifactPath: string; indexPath: string } {
  if (!isAbsolute(dir)) fail(`--dir must be absolute: ${dir}`);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(dir);
  } catch {
    fail(`--dir does not exist: ${dir}`);
    throw new Error("unreachable");
  }
  if (!st.isDirectory()) fail(`--dir is not a directory: ${dir}`);

  const exeName = process.platform === "win32" ? "owl.exe" : "owl";
  const artifactPath = join(dir, exeName);
  try {
    const s = statSync(artifactPath);
    if (!s.isFile()) fail(`missing executable: ${artifactPath}`);
  } catch {
    fail(`missing executable: ${artifactPath}`);
  }

  const indexPath = join(dir, "web", "index.html");
  try {
    const s = statSync(indexPath);
    if (!s.isFile()) fail(`missing web/index.html: ${indexPath}`);
  } catch {
    fail(`missing web/index.html: ${indexPath}`);
  }

  return { artifactPath, indexPath };
}

function reserveEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? (addr as { port: number }).port : undefined;
      if (!port) {
        srv.close(() => reject(new Error("failed to reserve ephemeral port")));
        return;
      }
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function buildSafeEnv(port: number, projectDir: string, configDir: string): Record<string, string> {
  // Explicit whitelist: PATH plus temp/Windows system vars needed to start.
  // Never inherit provider/auth/OpenCode/OMO/bridge secrets.
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
  ]);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (allowLower.has(k.toLowerCase())) {
      env[k] = v;
    }
  }
  // Ensure PATH is present if available under different casing (already handled)
  // Set required values
  env["OPENCODE_BASE_URL"] = "http://127.0.0.1:1";
  env["OPENCODE_CONFIG_DIR"] = configDir;
  env["OMO_CP_PROJECT_DIR"] = projectDir;
  env["OMO_CP_HOST"] = "127.0.0.1";
  env["OMO_CP_PORT"] = String(port);
  return env;
}

async function pollHealth(port: number, child: ChildProcess, stdout: () => string, stderr: () => string): Promise<void> {
  const url = `http://127.0.0.1:${port}/api/health`;
  const deadline = Date.now() + 20_000;
  const intervalMs = 200;
  let lastErr = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `artifact exited early (code=${child.exitCode} signal=${child.signalCode}) while polling ${url}` +
          diagnosticsSuffix(stdout, stderr),
      );
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status === 200) {
        const ct = res.headers.get("content-type") ?? "";
        if (!ct.toLowerCase().includes("application/json")) {
          throw new Error(`/api/health content-type not JSON: ${ct}`);
        }
        const text = await res.text();
        try {
          JSON.parse(text);
        } catch {
          throw new Error(`/api/health not JSON 200: ${text.slice(0, 500)}`);
        }
        return;
      }
      lastErr = `status ${res.status}`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Network errors while port not yet listening are expected
      lastErr = msg;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out polling ${url} (last: ${lastErr})` + diagnosticsSuffix(stdout, stderr));
}

function diagnosticsSuffix(stdout: () => string, stderr: () => string): string {
  // Capture stdout/stderr for timeout diagnostics without exposing secrets.
  // We do NOT log env values; only child output truncated.
  const out = stdout().slice(-4000);
  const err = stderr().slice(-4000);
  let s = "";
  if (out.trim()) s += `\n--- stdout (tail) ---\n${out}`;
  if (err.trim()) s += `\n--- stderr (tail) ---\n${err}`;
  // Intentionally do not include env or secret values.
  return s;
}

function collectAssets(html: string): string[] {
  const assets: string[] = [];
  const seen = new Set<string>();
  // script src="/assets/..."
  const scriptRe = /<script[^>]*\ssrc=["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = scriptRe.exec(html)) !== null) {
    const v = m[1]!;
    if (v.startsWith("/assets/") && !seen.has(v)) {
      seen.add(v);
      assets.push(v);
    }
  }
  // link href="/assets/..."
  const linkRe = /<link[^>]*\shref=["']([^"']+)["'][^>]*>/gi;
  while ((m = linkRe.exec(html)) !== null) {
    const v = m[1]!;
    if (v.startsWith("/assets/") && !seen.has(v)) {
      seen.add(v);
      assets.push(v);
    }
  }
  return assets;
}

async function fetchExpect(
  url: string,
  opts: { status: number; contentType?: "json" | "html" | "js" | "css" | "asset" | "any" },
): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (res.status !== opts.status) {
    const body = await res.text().catch(() => "");
    throw new Error(`${url} expected ${opts.status} got ${res.status} body=${body.slice(0, 500)}`);
  }
  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  if (opts.contentType === "json") {
    if (!ct.includes("application/json")) throw new Error(`${url} expected JSON content-type got ${ct}`);
    const t = await res.text();
    try {
      JSON.parse(t);
    } catch {
      throw new Error(`${url} expected JSON body got ${t.slice(0, 500)}`);
    }
  } else if (opts.contentType === "html") {
    if (!ct.includes("text/html")) throw new Error(`${url} expected HTML content-type got ${ct}`);
    // drain body
    await res.text();
  } else if (opts.contentType === "js") {
    if (!ct.includes("javascript")) throw new Error(`${url} expected JS MIME got ${ct}`);
    await res.text();
  } else if (opts.contentType === "css") {
    if (!ct.includes("text/css")) throw new Error(`${url} expected CSS MIME got ${ct}`);
    await res.text();
  } else if (opts.contentType === "asset") {
    // js or css based on extension
    const path = new URL(url).pathname;
    if (path.endsWith(".js") || path.endsWith(".mjs")) {
      if (!ct.includes("javascript")) throw new Error(`${url} expected JS MIME got ${ct}`);
    } else if (path.endsWith(".css")) {
      if (!ct.includes("text/css")) throw new Error(`${url} expected CSS MIME got ${ct}`);
    } else {
      // generic asset: require 200 only, but check we got some content-type
      if (!ct) throw new Error(`${url} missing content-type`);
    }
    await res.text();
  } else {
    // any: just drain
    await res.text().catch(() => {});
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // Request graceful termination where available
  try {
    if (process.platform === "win32") {
      // On Windows, SIGTERM is supported by Node as TerminateProcess; try SIGTERM first
      const ok = child.kill("SIGTERM");
      if (!ok) child.kill();
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    /* ignore */
  }
  const gracefulMs = 5000;
  const start = Date.now();
  while (Date.now() - start < gracefulMs) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  // Bounded kill escalation
  try {
    child.kill("SIGKILL");
  } catch {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
  const killMs = 3000;
  const start2 = Date.now();
  while (Date.now() - start2 < killMs) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function main(): Promise<void> {
  const dir = parseDirArg();
  const { artifactPath, indexPath } = requirePreparedDir(dir);

  const projectDir = mkdtempSync(join(tmpdir(), "omo-smoke-project-"));
  const configDir = mkdtempSync(join(tmpdir(), "omo-smoke-config-"));
  const port = await reserveEphemeralPort();

  const safeEnv = buildSafeEnv(port, projectDir, configDir);

  let child: ChildProcess | undefined;
  let stdoutBuf = "";
  let stderrBuf = "";
  const maxBuf = 64 * 1024;

  // Ensure cleanup in finally
  let exitCode = 0;
  try {
    child = spawn(artifactPath, [], {
      env: safeEnv,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: dir,
      windowsHide: true,
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf-8");
      stdoutBuf += s;
      if (stdoutBuf.length > maxBuf) stdoutBuf = stdoutBuf.slice(-maxBuf);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf-8");
      stderrBuf += s;
      if (stderrBuf.length > maxBuf) stderrBuf = stderrBuf.slice(-maxBuf);
    });
    child.on("error", (err) => {
      stderrBuf += `\nspawn error: ${String(err)}\n`;
    });

    // Poll health bounded until JSON 200; dead Attach backend is expected.
    await pollHealth(port, child, () => stdoutBuf, () => stderrBuf);

    const base = `http://127.0.0.1:${port}`;

    // Read prepared web/index.html, collect every script src/link href beginning /assets/
    const html = readFileSync(indexPath, "utf-8");
    const assets = collectAssets(html);
    if (assets.length === 0) {
      // Not strictly required to fail if no assets, but we still validate fetches
      // Keep as info - will still pass if no assets.
    }
    for (const assetPath of assets) {
      const url = `${base}${assetPath}`;
      const ext = assetPath.split(".").pop()?.toLowerCase() ?? "";
      let ctExpect: "js" | "css" | "asset" = "asset";
      if (ext === "js" || ext === "mjs") ctExpect = "js";
      else if (ext === "css") ctExpect = "css";
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.status !== 200) {
        const body = await res.text().catch(() => "");
        throw new Error(`asset ${assetPath} expected 200 got ${res.status} body=${body.slice(0, 500)}`);
      }
      const ct = (res.headers.get("content-type") ?? "").toLowerCase();
      if (ctExpect === "js" && !ct.includes("javascript")) {
        throw new Error(`asset ${assetPath} expected JS MIME got ${ct}`);
      }
      if (ctExpect === "css" && !ct.includes("text/css")) {
        throw new Error(`asset ${assetPath} expected CSS MIME got ${ct}`);
      }
      if (ctExpect === "asset" && !ct) {
        throw new Error(`asset ${assetPath} missing content-type`);
      }
      // drain
      await res.text().catch(() => {});
    }

    // Require /agents HTML 200; health JSON; /api/release-smoke-missing JSON 404; /assets/release-smoke-missing.js 404
    await fetchExpect(`${base}/agents`, { status: 200, contentType: "html" });
    await fetchExpect(`${base}/api/health`, { status: 200, contentType: "json" });
    await fetchExpect(`${base}/api/release-smoke-missing`, { status: 404, contentType: "json" });
    // assets 404 is plain 404 (not JSON); accept any content-type
    await fetchExpect(`${base}/assets/release-smoke-missing.js`, { status: 404, contentType: "any" });

    console.log(`smoke-release: ok`);
    console.log(`  dir: ${dir}`);
    console.log(`  port: ${port}`);
    console.log(`  artifact: ${artifactPath}`);
    console.log(`  assets: ${assets.length} fetched (${assets.join(", ") || "none"})`);
    console.log(`  checks: /agents 200 html, /api/health 200 json (attach dead expected), /api/release-smoke-missing 404 json, /assets/release-smoke-missing.js 404`);
    console.log(`  temp project: ${projectDir} (removed)`);
    console.log(`  temp config: ${configDir} (removed)`);
  } catch (e) {
    exitCode = 1;
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`smoke-release failed: ${msg}`);
    // diagnostics already include stdout/stderr tail where relevant (pollHealth)
    // For other failures, attach tail without secrets
    if (!msg.includes("--- stdout")) {
      const out = stdoutBuf.slice(-4000);
      const err = stderrBuf.slice(-4000);
      if (out.trim()) console.error(`--- stdout (tail) ---\n${out}`);
      if (err.trim()) console.error(`--- stderr (tail) ---\n${err}`);
    }
    process.exitCode = 1;
  } finally {
    if (child) {
      try {
        await stopChild(child);
      } catch {
        /* ignore */
      }
      // Await child exit fully
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 3000);
          child!.once("exit", () => {
            clearTimeout(t);
            resolve();
          });
          child!.once("close", () => {
            clearTimeout(t);
            resolve();
          });
        });
      }
    }
    // Remove temp dirs cross-platform
    for (const d of [projectDir, configDir]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    if (exitCode !== 0) process.exit(exitCode);
  }
}

await main();
