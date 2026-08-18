#!/usr/bin/env bun
/**
 * Prepare desktop (Tauri) reference assets.
 *
 * CLI: bun run scripts/prepare-desktop-assets.ts [--target <bun-target> --triple <rust-triple>]
 * Defaults derive from the host platform. Spawn via Bun.spawnSync argv arrays.
 *
 * Produces:
 *   src-tauri/resources/web/                      built SPA (vite build)
 *   src-tauri/resources/package.json              root package identity (name
 *                                                 "omo-control-plane") expected by
 *                                                 the server install-root proof
 *   src-tauri/resources/LICENSE                   license file
 *   src-tauri/resources/packages/omo-telemetry-bridge
 *                                                 managed telemetry bridge source
 *                                                 (identity for registration/realpath
 *                                                 equivalence; kept on a stable
 *                                                 app-data path at runtime, NOT a
 *                                                 bundle/mount path)
 *   src-tauri/binaries/owl-<triple>[.exe]         target-suffixed compiled sidecar
 *
 * src-tauri/resources is recreated from scratch on every run; the sidecar
 * binary for the given triple is replaced in place. src-tauri/icons is never
 * touched.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_TAURI = join(ROOT, "src-tauri");
const RESOURCES = join(SRC_TAURI, "resources");
const BINARIES = join(SRC_TAURI, "binaries");

interface TargetInfo {
  bunTarget: string;
  triple: string;
}

const TARGETS: Record<string, TargetInfo> = {
  "darwin-arm64": {
    bunTarget: "bun-darwin-arm64",
    triple: "aarch64-apple-darwin",
  },
  "windows-x64": {
    bunTarget: "bun-windows-x64",
    triple: "x86_64-pc-windows-msvc",
  },
  "linux-x64": {
    bunTarget: "bun-linux-x64-baseline",
    triple: "x86_64-unknown-linux-gnu",
  },
};

function hostPlatform(): string {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "win32" && process.arch === "x64") return "windows-x64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64";
  throw new Error(`unsupported host ${process.platform}/${process.arch}`);
}

function fail(message: string): never {
  console.error(`[prepare-desktop-assets] error: ${message}`);
  process.exit(1);
}

function parseArgs(): TargetInfo {
  const args = process.argv.slice(2);
  let target: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--target") {
      if (target !== undefined) fail("duplicate --target");
      if (i + 1 >= args.length) fail("--target requires a value");
      target = args[++i];
      if (!target) fail("--target requires a non-empty value");
    } else if (a.startsWith("--target=")) {
      if (target !== undefined) fail("duplicate --target");
      target = a.slice("--target=".length);
      if (!target) fail("--target requires a non-empty value");
    } else {
      fail(`unknown argument: ${a}`);
    }
  }
  const key = target ?? hostPlatform();
  const info = TARGETS[key];
  if (!info) {
    fail(`invalid --target "${key}". Allowed: ${Object.keys(TARGETS).join(", ")}`);
  }
  return info;
}

function runSync(cmd: string[], cwd: string, label: string): void {
  console.log(`[prepare-desktop-assets] run: ${cmd.join(" ")}`);
  const result = Bun.spawnSync({ cmd, cwd, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) {
    fail(`${label} failed (exit ${result.exitCode})`);
  }
}

function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true });
}

function copyFile(src: string, dest: string): void {
  ensureDir(dirname(dest));
  copyFileSync(src, dest);
}

function walkFilesRecursive(dir: string, out: string[] = []): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      walkFilesRecursive(full, out);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function main(): void {
  const info = parseArgs();
  const sidecarBase =
    info.triple === "x86_64-pc-windows-msvc"
      ? `owl-${info.triple}.exe`
      : `owl-${info.triple}`;
  const sidecarPath = join(BINARIES, sidecarBase);

  console.log(`[prepare-desktop-assets] bunTarget=${info.bunTarget} triple=${info.triple}`);
  console.log(`[prepare-desktop-assets] sidecar=${sidecarBase}`);

  // 1. Clean+recreate resource staging (deterministic layout; icons untouched).
  rmSync(RESOURCES, { recursive: true, force: true });
  ensureDir(RESOURCES);
  ensureDir(BINARIES);

  // 2. Build the SPA into resources/web.
  runSync(
    ["bun", "--cwd=apps/web", "run", "vite", "build", "--outDir", join(RESOURCES, "web"), "--emptyOutDir"],
    ROOT,
    "vite build",
  );

  // 3. Root package identity: the staged runtime root must contain a
  //    package.json named "omo-control-plane" for the server install-root
  //    proof (resolveOwlInstallDirectory), plus LICENSE.
  const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
    name?: unknown;
  };
  if (rootPkg.name !== "omo-control-plane") {
    fail(`root package.json name must be "omo-control-plane" (got "${String(rootPkg.name)}")`);
  }
  copyFile(join(ROOT, "package.json"), join(RESOURCES, "package.json"));
  copyFile(join(ROOT, "LICENSE"), join(RESOURCES, "LICENSE"));
  console.log(`[prepare-desktop-assets] copied package identity + LICENSE`);

  // 4. Managed telemetry bridge package source: package.json + every
  //    non-test .ts/.d.ts under src (same filter as the former CLI release).
  const bridgeSrcRoot = join(ROOT, "packages", "omo-telemetry-bridge");
  const bridgeDestRoot = join(RESOURCES, "packages", "omo-telemetry-bridge");
  copyFile(join(bridgeSrcRoot, "package.json"), join(bridgeDestRoot, "package.json"));
  const bridgeFiles = walkFilesRecursive(join(bridgeSrcRoot, "src"));
  let copied = 0;
  for (const full of bridgeFiles) {
    const isTs = full.endsWith(".ts") || full.endsWith(".d.ts");
    if (!isTs) continue;
    if (full.includes(".test.")) continue;
    const rel = full.startsWith(bridgeSrcRoot + sep) ? full.slice(bridgeSrcRoot.length + 1) : basename(full);
    copyFile(full, join(bridgeDestRoot, rel));
    copied++;
  }
  if (copied === 0) fail("no bridge src files copied");
  console.log(`[prepare-desktop-assets] copied ${copied} bridge src files`);

  // 5. Compile the target-suffixed sidecar.
  runSync(
    [
      "bun",
      "build",
      "--compile",
      "--minify",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--target",
      info.bunTarget,
      join("apps", "server", "src", "index.ts"),
      "--outfile",
      sidecarPath,
    ],
    ROOT,
    "bun compile",
  );
  if (!info.bunTarget.includes("windows")) {
    chmodSync(sidecarPath, 0o755);
  }

  // 6. Verify deterministic layout.
  const required = [
    join(RESOURCES, "web", "index.html"),
    join(RESOURCES, "package.json"),
    join(RESOURCES, "LICENSE"),
    join(bridgeDestRoot, "package.json"),
    join(bridgeDestRoot, "src", "index.ts"),
    sidecarPath,
  ];
  for (const p of required) {
    let st;
    try {
      st = statSync(p);
    } catch (e) {
      fail(`required output missing: ${p}: ${String(e)}`);
    }
    if (!st.isFile() || st.size === 0) fail(`required output invalid: ${p}`);
  }
  const stagedPkg = JSON.parse(readFileSync(join(RESOURCES, "package.json"), "utf-8")) as {
    name?: unknown;
  };
  if (stagedPkg.name !== "omo-control-plane") {
    fail(`staged package.json identity lost: ${String(stagedPkg.name)}`);
  }
  console.log(`[prepare-desktop-assets] verified layout`);

  console.log(JSON.stringify({
    bunTarget: info.bunTarget,
    triple: info.triple,
    resources: RESOURCES,
    sidecar: sidecarPath,
  }));
}

try {
  main();
} catch (e) {
  console.error(`[prepare-desktop-assets] unhandled error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
