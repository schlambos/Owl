export const PREFERRED_OPENCODE_BASE_URL = "http://127.0.0.1:4096";

// Oracle decision 10: consolidated override validator.
// The single source of truth is opencode-bridge/override.ts.
import { validateBridgeOverride } from "./opencode-bridge/override";
import type { BridgeOverrideStatus } from "./opencode-bridge/override";
export type { BridgeOverrideStatus };
export { validateBridgeOverride };

import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Package name of the control-plane monorepo root package. */
const OWL_INSTALL_PACKAGE_NAME = "omo-control-plane";
/** Maximum ancestor directories walked above the start directory. */
const MAX_INSTALL_ROOT_ANCESTOR_HOPS = 10;

export interface DesktopModeConfig {
  /**
   * Unpredictable per-launch token (env OMO_CP_SHUTDOWN_TOKEN). Required for
   * the loopback-only `POST /internal/shutdown` route. Never logged or
   * exposed through any API response.
   */
  shutdownToken: string;
}

export interface ServerConfig {
  host: string;
  port: number;
  /**
   * Desktop (Tauri sidecar) mode, selected by `OMO_CP_DESKTOP=1`. Forces the
   * loopback host and an ephemeral port (0), requires a shutdown token, and
   * emits an exact `OWL_READY http://127.0.0.1:<port>` line on stdout once
   * the listener is bound.
   */
  desktop?: DesktopModeConfig;
  /** Presence of OPENCODE_BASE_URL selects attach; absence selects managed. */
  opencodeMode?: "managed" | "attach";
  /** Raw attach request. It is validated by the lifecycle manager and has no default. */
  opencodeAttachBaseUrl?: string;
  /** Authorized OpenCode config directory (realpath) */
  opencodeConfigDir: string;
  /** Authorized project root for project-local OMO config (realpath) */
  projectDirectory: string;
  /** Discovered omo-control-plane install root (realpath) */
  owlInstallDirectory: string;
  /** Only these roots may be read from disk */
  authorizedRoots: string[];
  /**
   * Base URL of the OMO telemetry bridge plugin loopback server.
   * Env OMO_BRIDGE_BASE_URL. Default undefined → bridge lane disabled.
   *
   * Oracle decision 10: set to undefined when the override is invalid,
   * so the existing OmoBridgeClient cannot request an arbitrary URL.
   * Only the canonical validated URL is exposed here.
   */
  omoBridgeBaseUrl?: string;
  /**
   * Structured OMO_BRIDGE_BASE_URL override status. Present even when
   * invalid (so the UI can surface the error). A valid override opts
   * out of bridge management by default.
   */
  omoBridgeOverride?: BridgeOverrideStatus;
}

/**
 * Production default search start for install-root discovery.
 *
 * Forward/backward compatible standalone detection (minimal):
 * - Explicit `isStandaloneExecutable` override is respected first (test seam).
 * - Bun >=1.4: `Bun.isStandaloneExecutable === true` is preferred when present
 *   and indicates a compiled standalone binary.
 * - Bun 1.3 (pinned 1.3.14): `Bun.isStandaloneExecutable` is undefined, so the
 *   documented pre-1.4 virtual-path marker is used: normalized `Bun.main`
 *   beginning with `/$bunfs/` (POSIX) or containing `/~BUN/` after
 *   normalizing backslashes (Windows `B:\~BUN\`) indicates standalone.
 *
 * Standalone start remains `dirname(realpathSync(process.execPath))` with
 * lexical `dirname(execPath)` fallback for synthetic paths. Source mode
 * remains `dirname(fileURLToPath(import.meta.url))` and never `process.cwd()`.
 * The result is fed to the bounded package-name walk in
 * `resolveOwlInstallDirectory`.
 *
 * `overrides` exists only for deterministic unit testing without mutating
 * global `Bun` state or requiring a compiled binary. `bunMain` is the
 * injectable equivalent of `Bun.main` so tests do not mutate globals.
 */
export function getDefaultOwlInstallSearchStartDir(overrides?: {
  isStandaloneExecutable?: boolean;
  bunMain?: string;
  execPath?: string;
  moduleDir?: string;
}): string {
  let isStandalone: boolean;
  if (overrides?.isStandaloneExecutable !== undefined) {
    isStandalone = overrides.isStandaloneExecutable;
  } else {
    const bun = (globalThis as unknown as { Bun?: { isStandaloneExecutable?: boolean; main?: string } }).Bun;
    if (bun?.isStandaloneExecutable === true) {
      isStandalone = true;
    } else {
      const rawMain = overrides?.bunMain ?? bun?.main;
      if (typeof rawMain === "string") {
        const normalized = rawMain.replace(/\\/g, "/");
        isStandalone = normalized.startsWith("/$bunfs/") || normalized.includes("/~BUN/");
      } else {
        isStandalone = false;
      }
    }
  }

  if (isStandalone) {
    const rawExec = overrides?.execPath ?? process.execPath;
    try {
      return dirname(realpathSync(rawExec));
    } catch {
      // Exec path may be a synthetic test path that does not exist on disk.
      // Fall back to lexical dirname without realpath.
      return dirname(rawExec);
    }
  }

  if (overrides?.moduleDir !== undefined) return overrides.moduleDir;
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Locate the omo-control-plane install root portably: start at `startDir`
 * (defaults to production logic via `getDefaultOwlInstallSearchStartDir()`),
 * walk upward at most MAX_INSTALL_ROOT_ANCESTOR_HOPS directories, and return
 * the realpath of the first directory whose `package.json` has name exactly
 * "omo-control-plane". Missing, unreadable, invalid, and non-matching
 * manifests (and non-directory candidates) are skipped. A clear startup
 * error is thrown when no ancestor within the hop limit matches.
 *
 * There is deliberately no `../../..` literal and no process.cwd()
 * authority here: the install root derives from where this module lives
 * (dev) or from the standalone executable's directory (compiled).
 * `startDir` remains optional so existing tests can pass an explicit
 * directory without needing a compiled binary; production callers omit it.
 *
 * Bun compiled note: in a `bun build --compile` binary `Bun.main` and
 * `import.meta.url` may be `/$bunfs/root/...` (POSIX) or `B:\~BUN\...`
 * (Windows) virtual paths pinned on 1.3.14, and `Bun.isStandaloneExecutable`
 * is only defined from 1.4. The executable-adjacent walk via
 * `dirname(realpathSync(process.execPath))` is therefore required in
 * standalone mode.
 */
export function resolveOwlInstallDirectory(
  startDir: string = getDefaultOwlInstallSearchStartDir(),
): string {
  let candidate = startDir;
  for (let hop = 0; hop <= MAX_INSTALL_ROOT_ANCESTOR_HOPS; hop++) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(candidate, "package.json"), "utf8"),
      ) as { name?: unknown };
      if (
        typeof manifest === "object" &&
        manifest !== null &&
        manifest.name === OWL_INSTALL_PACKAGE_NAME &&
        statSync(candidate).isDirectory()
      ) {
        return realpathSync(candidate);
      }
    } catch {
      // Missing/unreadable/invalid manifest or vanished/non-directory
      // candidate: skip it and keep walking.
    }
    const parent = dirname(candidate);
    if (parent === candidate) break; // reached filesystem root
    candidate = parent;
  }
  throw new Error(
    `omo-control-plane install root not found: no package.json named ` +
      `"${OWL_INSTALL_PACKAGE_NAME}" within ${MAX_INSTALL_ROOT_ANCESTOR_HOPS} ` +
      `ancestor directories of ${startDir}`,
  );
}

/**
 * Validate a configured directory (already trimmed of surrounding
 * whitespace): must be non-empty, absolute, exist, and be a directory.
 * Returns the canonical realpath. `label` names the setting in errors.
 */
function resolveAuthorizedRealDirectory(raw: string, label: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`${label} is present but empty`);
  }
  if (!isAbsolute(trimmed)) {
    throw new Error(`${label} must be an absolute directory path: ${trimmed}`);
  }
  let stats;
  try {
    stats = statSync(trimmed);
  } catch {
    throw new Error(`${label} does not exist: ${trimmed}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`${label} is not a directory: ${trimmed}`);
  }
  return realpathSync(trimmed);
}

export function loadServerConfig(
  env: Record<string, string | undefined> = process.env,
): ServerConfig {
  // Install root derives from production default start (standalone-aware)
  // only. Never cwd. OMO_CP_INSTALL_DIR (used by the desktop sidecar) must
  // point at a real install root: it is validated as a directory first and
  // must still pass the package-name proof walk.
  const owlInstallDirectory =
    env.OMO_CP_INSTALL_DIR !== undefined
      ? resolveOwlInstallDirectory(
          resolveAuthorizedRealDirectory(env.OMO_CP_INSTALL_DIR, "OMO_CP_INSTALL_DIR"),
        )
      : resolveOwlInstallDirectory();

  // OMO_CP_PROJECT_DIR is the project-root authority. When unset, the
  // project root is the realpath of process.cwd() at load time (which must
  // be an existing directory). loadServerConfig never chdir()s.
  const projectDirectory =
    env.OMO_CP_PROJECT_DIR !== undefined
      ? resolveAuthorizedRealDirectory(env.OMO_CP_PROJECT_DIR, "OMO_CP_PROJECT_DIR")
      : resolveAuthorizedRealDirectory(
          process.cwd(),
          "Project directory (process.cwd())",
        );

  // OPENCODE_CONFIG_DIR selects the active OpenCode config directory.
  // When unset, the conventional home location is used and must exist.
  let opencodeConfigDir: string;
  if (env.OPENCODE_CONFIG_DIR !== undefined) {
    opencodeConfigDir = resolveAuthorizedRealDirectory(
      env.OPENCODE_CONFIG_DIR,
      "OPENCODE_CONFIG_DIR",
    );
  } else {
    const defaultConfigDir = join(homedir(), ".config", "opencode");
    opencodeConfigDir = resolveAuthorizedRealDirectory(
      defaultConfigDir,
      `Default OpenCode config directory (${defaultConfigDir})`,
    );
  }

  // Sole constructor of the authorized-root set: exact deduped realpaths
  // of install root, project root, and OpenCode config root.
  const authorizedRoots = [
    ...new Set([owlInstallDirectory, projectDirectory, opencodeConfigDir]),
  ];

  const attachRequested = Object.prototype.hasOwnProperty.call(
    env,
    "OPENCODE_BASE_URL",
  );

  const omoBridgeRaw = env.OMO_BRIDGE_BASE_URL?.trim();

  // Oracle decision 10: use the single consolidated validator.
  // Set omoBridgeBaseUrl undefined when invalid, so OmoBridgeClient
  // cannot request an arbitrary URL. Only expose canonical validated URL.
  const omoBridgeOverride = validateBridgeOverride(omoBridgeRaw);
  const omoBridgeBaseUrl = omoBridgeOverride.invalid ? undefined : omoBridgeOverride.url;

  // Desktop sidecar mode: loopback host and ephemeral port are fixed by the
  // desktop shell; the launch token must be unpredictable and is never
  // defaulted—fail closed when it is absent or trivially short.
  let desktop: DesktopModeConfig | undefined;
  if (env.OMO_CP_DESKTOP === "1") {
    const token = env.OMO_CP_SHUTDOWN_TOKEN?.trim() ?? "";
    if (token.length < 16) {
      throw new Error(
        "OMO_CP_DESKTOP=1 requires OMO_CP_SHUTDOWN_TOKEN with at least 16 characters",
      );
    }
    desktop = { shutdownToken: token };
  }

  return {
    host: desktop ? "127.0.0.1" : (env.OMO_CP_HOST ?? "127.0.0.1"),
    port: desktop ? 0 : Number(env.OMO_CP_PORT ?? 8787),
    ...(desktop ? { desktop } : {}),
    opencodeMode: attachRequested ? "attach" : "managed",
    ...(attachRequested
      ? { opencodeAttachBaseUrl: env.OPENCODE_BASE_URL }
      : {}),
    opencodeConfigDir,
    projectDirectory,
    owlInstallDirectory,
    authorizedRoots,
    omoBridgeBaseUrl,
    omoBridgeOverride,
  };
}

/** Ensure a path is under an authorized root before any FS read. */
export function assertAuthorizedPath(path: string, roots: string[]): void {
  if (!isWithinAuthorizedRoots(path, roots)) {
    throw new Error(`Filesystem path outside authorized scope: ${path}`);
  }
}

function darwinPrivateAlias(p: string): string {
  // macOS often exposes /var and /tmp through /private. Treat those as
  // equivalent for lexical containment so authorized sandbox roots still match
  // realpath() results without opening a path-escape hatch.
  if (p.startsWith("/private/tmp/") || p === "/private/tmp") {
    return `/tmp${p.slice("/private/tmp".length)}`;
  }
  if (p.startsWith("/private/var/") || p === "/private/var") {
    return `/var${p.slice("/private/var".length)}`;
  }
  if (p.startsWith("/tmp/") || p === "/tmp") return `/private${p}`;
  if (p.startsWith("/var/") || p === "/var") return `/private${p}`;
  return p;
}

/** Non-throwing containment check against authorized roots (no FS access). */
export function isWithinAuthorizedRoots(path: string, roots: string[]): boolean {
  const candidates = [path.replace(/\\/g, "/"), darwinPrivateAlias(path.replace(/\\/g, "/"))];
  return roots.some((root) => {
    const aliases = [root.replace(/\\/g, "/").replace(/\/$/, ""), darwinPrivateAlias(root.replace(/\\/g, "/")).replace(/\/$/, "")];
    return candidates.some((normalized) =>
      aliases.some((r) => normalized === r || normalized.startsWith(r + "/")),
    );
  });
}
