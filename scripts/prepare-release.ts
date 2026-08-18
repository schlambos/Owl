#!/usr/bin/env bun
/**
 * Prepare release artifact.
 *
 * CLI: bun run scripts/prepare-release.ts --target <target> --out <absolute-dir>
 * Strict args. No dependencies. Spawn via Bun.spawnSync argv arrays.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type TargetInfo = {
  platform: string;
  artifact: string;
  exe: string;
  isWindows: boolean;
};

const TARGETS: Record<string, TargetInfo> = {
  "bun-windows-x64": {
    platform: "windows-x64",
    artifact: "owl-windows-x64",
    exe: "owl.exe",
    isWindows: true,
  },
  "bun-darwin-arm64": {
    platform: "darwin-arm64",
    artifact: "owl-darwin-arm64",
    exe: "owl",
    isWindows: false,
  },
  "bun-linux-x64-baseline": {
    platform: "linux-x64",
    artifact: "owl-linux-x64",
    exe: "owl",
    isWindows: false,
  },
};

function fail(message: string): never {
  console.error(`[prepare-release] error: ${message}`);
  process.exit(1);
}

function parseArgs(): { target: string; out: string } {
  const args = process.argv.slice(2);
  let target: string | undefined;
  let out: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--target") {
      if (target !== undefined) fail("duplicate --target");
      if (i + 1 >= args.length) fail("--target requires a value");
      target = args[++i];
      if (!target) fail("--target requires a non-empty value");
    } else if (a === "--out") {
      if (out !== undefined) fail("duplicate --out");
      if (i + 1 >= args.length) fail("--out requires a value");
      out = args[++i];
      if (!out) fail("--out requires a non-empty value");
    } else {
      fail(`unknown argument: ${a}`);
    }
  }

  if (target === undefined) fail("missing required --target <target>");
  if (out === undefined) fail("missing required --out <absolute-dir>");

  if (!TARGETS[target!]) {
    const allowed = Object.keys(TARGETS).join(", ");
    fail(`invalid --target "${target}". Allowed: ${allowed}`);
  }

  // Strict: exactly two flags (4 argv entries) already enforced by duplicate/missing logic,
  // but also ensure no extra positional after parsing (covered).
  // Ensure we had exactly 4 raw entries (two flags + two values) to catch stray extras
  // that would have been flagged as unknown above; if count !=4 but parsing succeeded,
  // it would mean duplicate detection missed, so enforce length.
  if (args.length !== 4) {
    fail(`strict args: expected exactly --target <target> --out <absolute-dir> (got ${args.length} args)`);
  }

  return { target: target!, out: out! };
}

function validateOut(out: string): string {
  if (!isAbsolute(out)) {
    fail(`--out must be an absolute path (got "${out}")`);
  }
  const resolvedOut = resolve(out);
  const resolvedRoot = resolve(ROOT);

  // Must be outside repo: not equal and not descendant of repo root
  if (resolvedOut === resolvedRoot || resolvedOut.startsWith(resolvedRoot + sep)) {
    fail(`--out must be outside the repository (repo root is "${resolvedRoot}", got "${resolvedOut}")`);
  }

  if (existsSync(resolvedOut)) {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(resolvedOut);
    } catch (e) {
      fail(`--out path exists but cannot be stated: ${String(e)}`);
    }
    if (!st.isDirectory()) {
      fail(`--out exists but is not a directory: "${resolvedOut}"`);
    }
    let entries: string[];
    try {
      entries = readdirSync(resolvedOut);
    } catch (e) {
      fail(`--out cannot be read: ${String(e)}`);
    }
    if (entries.length !== 0) {
      fail(`--out must be absent or empty (found ${entries.length} entries in "${resolvedOut}")`);
    }
  }

  return resolvedOut;
}

function getVersion(): string {
  const pkgPath = join(ROOT, "package.json");
  let raw: string;
  try {
    raw = readFileSync(pkgPath, "utf-8");
  } catch (e) {
    fail(`cannot read package.json at "${pkgPath}": ${String(e)}`);
  }
  let pkg: any;
  try {
    pkg = JSON.parse(raw!);
  } catch (e) {
    fail(`invalid JSON in package.json: ${String(e)}`);
  }
  const v = pkg?.version;
  if (typeof v !== "string" || !v) {
    fail(`package.json missing version field`);
  }
  // Basic semver-ish check
  if (!/^\d+\.\d+\.\d+/.test(v)) {
    fail(`invalid version "${v}" in package.json`);
  }
  return v;
}

function runSync(cmd: string[], cwd: string, label: string): void {
  console.log(`[prepare-release] run: ${cmd.join(" ")}`);
  const result = Bun.spawnSync({
    cmd,
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
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
  let entries: any[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      // skip node_modules, .git etc.
      if (e.name === "node_modules" || e.name === ".git") continue;
      walkFilesRecursive(full, out);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function main(): void {
  const { target, out: rawOut } = parseArgs();
  const out = validateOut(rawOut);
  const info = TARGETS[target]!;
  const version = getVersion();

  const exeName = info.exe;
  const platform = info.platform;
  const artifact = info.artifact;

  const archiveBase =
    info.isWindows
      ? `owl-v${version}-${platform}.zip`
      : `owl-v${version}-${platform}.tar.gz`;
  const archivePath = join(dirname(out), archiveBase);
  const compileOut = join(out, "owl");
  const executablePath = join(out, exeName);

  console.log(`[prepare-release] target=${target} platform=${platform} artifact=${artifact}`);
  console.log(`[prepare-release] version=${version}`);
  console.log(`[prepare-release] out=${out}`);
  console.log(`[prepare-release] archive=${archivePath}`);

  // Ensure out exists (absent case)
  ensureDir(out);

  // 1. vite build
  // bun --cwd=apps/web run vite build --outDir <out>/web --emptyOutDir
  const webOut = join(out, "web");
  runSync(
    ["bun", "--cwd=apps/web", "run", "vite", "build", "--outDir", webOut, "--emptyOutDir"],
    ROOT,
    "vite build",
  );

  // 2. bun compile
  // bun build --compile --minify --no-compile-autoload-dotenv --no-compile-autoload-bunfig --target <target> apps/server/src/index.ts --outfile <out>/owl
  runSync(
    [
      "bun",
      "build",
      "--compile",
      "--minify",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--target",
      target,
      join("apps", "server", "src", "index.ts"),
      "--outfile",
      compileOut,
    ],
    ROOT,
    "bun compile",
  );

  // chmod / assert
  if (!info.isWindows) {
    try {
      chmodSync(executablePath, 0o755);
      console.log(`[prepare-release] chmod 0755 ${executablePath}`);
    } catch (e) {
      fail(`chmod 0755 failed for "${executablePath}": ${String(e)}`);
    }
  } else {
    // Windows: assert Bun produced owl.exe
    if (!existsSync(executablePath)) {
      fail(`expected Windows executable missing: "${executablePath}"`);
    }
    try {
      const st = statSync(executablePath);
      if (!st.isFile()) fail(`Windows executable is not a file: "${executablePath}"`);
    } catch (e) {
      fail(`cannot stat Windows executable "${executablePath}": ${String(e)}`);
    }
    console.log(`[prepare-release] Windows executable verified: ${executablePath}`);
  }

  // Copy metadata: package.json README.md LICENSE
  for (const name of ["package.json", "README.md", "LICENSE"]) {
    const src = join(ROOT, name);
    const dest = join(out, name);
    if (!existsSync(src)) {
      fail(`missing root metadata file: "${src}"`);
    }
    try {
      copyFile(src, dest);
      console.log(`[prepare-release] copied ${name}`);
    } catch (e) {
      fail(`copy ${name} failed: ${String(e)}`);
    }
  }

  // Copy bridge package.json and every non-test .ts/.d.ts under bridge src
  const bridgeSrcRoot = join(ROOT, "packages", "omo-telemetry-bridge");
  const bridgeDestRoot = join(out, "packages", "omo-telemetry-bridge");

  const bridgePkgSrc = join(bridgeSrcRoot, "package.json");
  const bridgePkgDest = join(bridgeDestRoot, "package.json");
  if (!existsSync(bridgePkgSrc)) {
    fail(`missing bridge package.json: "${bridgePkgSrc}"`);
  }
  try {
    copyFile(bridgePkgSrc, bridgePkgDest);
    console.log(`[prepare-release] copied bridge package.json`);
  } catch (e) {
    fail(`copy bridge package.json failed: ${String(e)}`);
  }

  const bridgeSrcDir = join(bridgeSrcRoot, "src");
  if (!existsSync(bridgeSrcDir)) {
    fail(`missing bridge src dir: "${bridgeSrcDir}"`);
  }
  const allBridgeFiles = walkFilesRecursive(bridgeSrcDir);
  let copiedCount = 0;
  for (const full of allBridgeFiles) {
    const rel = full.startsWith(bridgeSrcRoot + sep) ? full.slice(bridgeSrcRoot.length + 1) : basename(full);
    // Only .ts / .d.ts, skip tests, skip deps already filtered
    const isTs = full.endsWith(".ts") || full.endsWith(".d.ts");
    if (!isTs) continue;
    if (basename(full).includes(".test.")) continue;
    // Also skip if path segment includes ".test."
    if (full.includes(".test.")) continue;

    const dest = join(bridgeDestRoot, rel);
    try {
      copyFile(full, dest);
      copiedCount++;
    } catch (e) {
      fail(`copy bridge file "${full}" failed: ${String(e)}`);
    }
  }
  console.log(`[prepare-release] copied ${copiedCount} bridge src files`);
  if (copiedCount === 0) {
    fail(`no bridge src files copied from "${bridgeSrcDir}"`);
  }

  // Verify: executable, web/index.html, metadata, bridge runtime
  // executable
  try {
    const st = statSync(executablePath);
    if (!st.isFile()) fail(`executable is not a file: "${executablePath}"`);
    if (!info.isWindows) {
      // ensure executable bit
      if ((st.mode & 0o111) === 0) {
        fail(`executable is not executable: "${executablePath}"`);
      }
    }
  } catch (e) {
    if ((e as any)?.message?.includes("executable is not")) throw e;
    fail(`executable missing: "${executablePath}": ${String(e)}`);
  }
  console.log(`[prepare-release] verified executable`);

  // web/index.html
  const webIndex = join(out, "web", "index.html");
  try {
    const st = statSync(webIndex);
    if (!st.isFile()) fail(`web/index.html is not a file: "${webIndex}"`);
    if (st.size === 0) fail(`web/index.html is empty: "${webIndex}"`);
  } catch (e) {
    if ((e as any)?.message?.includes("web/index")) throw e;
    fail(`web/index.html missing: "${webIndex}": ${String(e)}`);
  }
  console.log(`[prepare-release] verified web/index.html`);

  // metadata
  for (const name of ["package.json", "README.md", "LICENSE"]) {
    const p = join(out, name);
    try {
      const st = statSync(p);
      if (!st.isFile()) fail(`metadata ${name} not a file: "${p}"`);
      if (st.size === 0) fail(`metadata ${name} is empty: "${p}"`);
    } catch (e) {
      if ((e as any)?.message?.includes("metadata")) throw e;
      fail(`metadata ${name} missing: "${p}": ${String(e)}`);
    }
  }
  console.log(`[prepare-release] verified metadata`);

  // bridge runtime
  const bridgeIndex = join(bridgeDestRoot, "src", "index.ts");
  try {
    const st = statSync(bridgeIndex);
    if (!st.isFile()) fail(`bridge runtime missing index.ts: "${bridgeIndex}"`);
  } catch (e) {
    if ((e as any)?.message?.includes("bridge runtime")) throw e;
    fail(`bridge runtime index.ts missing: "${bridgeIndex}": ${String(e)}`);
  }
  // Check no test files were copied
  const destBridgeFiles = walkFilesRecursive(join(bridgeDestRoot, "src"));
  for (const f of destBridgeFiles) {
    if (basename(f).includes(".test.")) {
      fail(`bridge runtime contains test file: "${f}"`);
    }
    if (f.includes("node_modules")) {
      fail(`bridge runtime contains deps: "${f}"`);
    }
  }
  // Also ensure at least one file exists
  if (destBridgeFiles.length === 0) {
    fail(`bridge runtime src empty: "${join(bridgeDestRoot, "src")}"`);
  }
  console.log(`[prepare-release] verified bridge runtime`);

  // Archive as sibling — fail if already exists, do not overwrite
  const shaPath = `${archivePath}.sha256`;
  if (existsSync(archivePath)) {
    fail(`archive already exists: "${archivePath}" (refusing to overwrite)`);
  }
  if (existsSync(shaPath)) {
    fail(`checksum already exists: "${shaPath}" (refusing to overwrite)`);
  }

  if (info.isWindows) {
    // tar.exe -C <out> -a -cf <archive> owl.exe web package.json README.md LICENSE packages
    runSync(
      ["tar.exe", "-C", out, "-a", "-cf", archivePath, exeName, "web", "package.json", "README.md", "LICENSE", "packages"],
      ROOT,
      "tar archive (windows)",
    );
  } else {
    // tar -C <out> -czf <archive> owl web package.json README.md LICENSE packages
    runSync(
      ["tar", "-C", out, "-czf", archivePath, exeName, "web", "package.json", "README.md", "LICENSE", "packages"],
      ROOT,
      "tar archive",
    );
  }
  console.log(`[prepare-release] archived ${archivePath}`);

  // Hash archive via node:crypto SHA256 and write <archive>.sha256 exactly "<hex>  <basename>\n"
  let hex: string;
  try {
    const data = readFileSync(archivePath);
    hex = createHash("sha256").update(data).digest("hex");
  } catch (e) {
    fail(`hash archive failed: ${String(e)}`);
  }
  const base = basename(archivePath);
  const shaContent = `${hex!}  ${base}\n`;
  try {
    writeFileSync(shaPath, shaContent, "utf-8");
    console.log(`[prepare-release] wrote checksum ${shaPath}`);
  } catch (e) {
    fail(`write checksum failed: ${String(e)}`);
  }

  // Verify checksum file format
  try {
    const check = readFileSync(shaPath, "utf-8");
    if (check !== shaContent) {
      fail(`checksum file content mismatch`);
    }
  } catch (e) {
    fail(`verify checksum failed: ${String(e)}`);
  }

  const result = {
    target,
    platform,
    artifact,
    releaseDir: out,
    executable: executablePath,
    archive: archivePath,
    checksum: hex!,
  };

  // Final stdout line must be JSON
  console.log(JSON.stringify(result));
}

try {
  main();
} catch (e) {
  if (e instanceof Error) {
    console.error(`[prepare-release] unhandled error: ${e.message}`);
  } else {
    console.error(`[prepare-release] unhandled error: ${String(e)}`);
  }
  process.exit(1);
}
