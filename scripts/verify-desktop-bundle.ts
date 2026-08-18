#!/usr/bin/env bun
/**
 * Desktop bundle verification.
 *
 * CLI: bun run scripts/verify-desktop-bundle.ts --platform <macos|windows|linux> [--root <src-tauri>]
 *
 * Verifies, after `tauri build`, that:
 *  - the expected installer/bundle outputs exist for the platform;
 *  - the bundled app contains the compiled sidecar and the staged runtime
 *    resources (web SPA, package identity, telemetry bridge source);
 *  - no legacy CLI release archives (owl-v<version>-<platform>.tar.gz/.tgz)
 *    exist anywhere in the output tree (the Tauri `Owl.app.tar.gz` app-bundle
 *    archive is allowed).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(msg: string): never {
  console.error(`[verify-desktop-bundle] error: ${msg}`);
  console.error(
    `usage: bun run scripts/verify-desktop-bundle.ts --platform <macos|windows|linux> [--root <src-tauri>]`,
  );
  process.exit(1);
}

function parseArgs(): { platform: string; root: string } {
  const args = process.argv.slice(2);
  let platform: string | undefined;
  let root: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--platform") {
      if (platform !== undefined) fail("duplicate --platform");
      platform = args[++i];
      i++;
    } else if (a.startsWith("--platform=")) {
      if (platform !== undefined) fail("duplicate --platform");
      platform = a.slice("--platform=".length);
    } else if (a === "--root") {
      if (root !== undefined) fail("duplicate --root");
      root = args[++i];
      i++;
    } else if (a.startsWith("--root=")) {
      if (root !== undefined) fail("duplicate --root");
      root = a.slice("--root=".length);
    } else {
      fail(`unknown argument: ${a}`);
    }
  }
  if (!platform || !["macos", "windows", "linux"].includes(platform)) {
    fail(`--platform must be one of macos|windows|linux (got "${platform ?? ""}")`);
  }
  const r = root ?? join(REPO, "src-tauri");
  if (!isAbsolute(r)) fail(`--root must be absolute`);
  return { platform, root: r };
}

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

function requireFile(p: string, label: string, failures: string[]): void {
  try {
    const st = statSync(p);
    if (!st.isFile() || st.size === 0) failures.push(`${label} invalid: ${p}`);
  } catch {
    failures.push(`${label} missing: ${p}`);
  }
}

function checkResourcesTree(dir: string, failures: string[]): void {
  requireFile(join(dir, "web", "index.html"), "runtime web", failures);
  requireFile(join(dir, "packages", "omo-telemetry-bridge", "package.json"), "bridge package manifest", failures);
  requireFile(join(dir, "packages", "omo-telemetry-bridge", "src", "index.ts"), "bridge source", failures);
  const pkgPath = join(dir, "package.json");
  requireFile(pkgPath, "runtime package identity", failures);
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: unknown };
      if (pkg.name !== "omo-control-plane") {
        failures.push(`runtime package.json name is "${String(pkg.name)}" (expected "omo-control-plane")`);
      }
    } catch (e) {
      failures.push(`runtime package.json unreadable: ${String(e)}`);
    }
  }
}

function main(): void {
  const { platform, root } = parseArgs();
  const bundle = join(root, "target", "release", "bundle");
  const failures: string[] = [];

  if (platform === "macos") {
    const app = join(bundle, "macos", "Owl.app");
    if (!existsSync(app)) {
      failures.push(`macOS app bundle missing: ${app}`);
    } else {
      // Resolve the real main executable from Info.plist (the bundle keeps
      // the Cargo binary name; the sidecar is the separate externalBin file).
      const plistPath = join(app, "Contents", "Info.plist");
      let mainExe: string | undefined;
      try {
        const plist = readFileSync(plistPath, "utf-8");
        const m = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
        mainExe = m?.[1];
      } catch (e) {
        failures.push(`Info.plist unreadable: ${String(e)}`);
      }
      if (!mainExe) {
        failures.push("Info.plist CFBundleExecutable not found");
      } else {
        requireFile(join(app, "Contents", "MacOS", mainExe), "main executable", failures);
      }
      requireFile(join(app, "Contents", "MacOS", "owl"), "bundled sidecar", failures);
      checkResourcesTree(join(app, "Contents", "Resources"), failures);
    }
    const dmgs = existsSync(join(bundle, "dmg"))
      ? walk(join(bundle, "dmg")).filter((f) => f.endsWith(".dmg"))
      : [];
    if (dmgs.length === 0) failures.push(`no .dmg under ${join(bundle, "dmg")}`);
  } else if (platform === "windows") {
    const nsisDir = join(bundle, "nsis");
    const installers = existsSync(nsisDir)
      ? walk(nsisDir).filter((f) => f.endsWith(".exe") && f.includes("setup"))
      : [];
    if (installers.length === 0) failures.push(`no NSIS setup .exe under ${nsisDir}`);
    // Pre-install layout check: sidecar is compiled next to the main binary.
    requireFile(join(root, "target", "release", "owl.exe"), "compiled sidecar", failures);
  } else {
    const debs = existsSync(join(bundle, "deb"))
      ? walk(join(bundle, "deb")).filter((f) => f.endsWith(".deb"))
      : [];
    if (debs.length === 0) failures.push(`no .deb under ${join(bundle, "deb")}`);
    const appImages = existsSync(join(bundle, "appimage"))
      ? walk(join(bundle, "appimage")).filter((f) => f.endsWith(".AppImage"))
      : [];
    if (appImages.length === 0) failures.push(`no .AppImage under ${join(bundle, "appimage")}`);
  }

  // No legacy CLI release archives anywhere in the build output. The old CLI
  // payloads were named `owl-v<version>-<platform>.tar.gz` (and `.tgz`); the
  // Tauri app-bundle archive `Owl.app.tar.gz` is a legitimate macOS output and
  // must be allowed.
  const releaseDir = join(root, "target", "release");
  if (existsSync(releaseDir)) {
    for (const f of walk(releaseDir)) {
      const base = basename(f);
      if (/^owl-v[^-]+-[a-z0-9-]+\.(tar\.gz|tgz)$/.test(base)) {
        failures.push(`legacy CLI archive present in build output: ${f}`);
      }
    }
  }

  if (failures.length > 0) {
    for (const f of failures) console.error(`[verify-desktop-bundle] FAIL ${f}`);
    process.exit(1);
  }
  console.log(`[verify-desktop-bundle] ok (${platform})`);
}

main();
