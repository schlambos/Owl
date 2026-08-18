export const MANAGED_PROJECT_DIRECTORY = "/Users/matt/Repos/omo-slim";
export const DEFAULT_OPENCODE_CONFIG_DIRECTORY = "/Users/matt/.config/opencode";
export const PREFERRED_OPENCODE_BASE_URL = "http://127.0.0.1:4096";

// Oracle decision 10: consolidated override validator.
// The single source of truth is opencode-bridge/override.ts.
import { validateBridgeOverride } from "./opencode-bridge/override";
import type { BridgeOverrideStatus } from "./opencode-bridge/override";
export type { BridgeOverrideStatus };
export { validateBridgeOverride };

export interface ServerConfig {
  host: string;
  port: number;
  /** Presence of OPENCODE_BASE_URL selects attach; absence selects managed. */
  opencodeMode?: "managed" | "attach";
  /** Raw attach request. It is validated by the lifecycle manager and has no default. */
  opencodeAttachBaseUrl?: string;
  /** Authorized OpenCode config directory */
  opencodeConfigDir: string;
  /** Authorized project root for project-local OMO config */
  projectDirectory: string;
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

export function loadServerConfig(
  env: Record<string, string | undefined> = process.env,
): ServerConfig {
  // The managed backend and every project-scoped request intentionally use
  // one fixed project. OMO_CP_PROJECT_DIR was a historical escape hatch that
  // made backend identity ambiguous and is no longer a runtime authority.
  const projectDirectory = MANAGED_PROJECT_DIRECTORY;
  const opencodeConfigDir =
    env.OPENCODE_CONFIG_DIR ?? DEFAULT_OPENCODE_CONFIG_DIRECTORY;
  if (!opencodeConfigDir) {
    throw new Error("OPENCODE_CONFIG_DIR is present but empty");
  }
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

  return {
    host: env.OMO_CP_HOST ?? "127.0.0.1",
    port: Number(env.OMO_CP_PORT ?? 8787),
    opencodeMode: attachRequested ? "attach" : "managed",
    ...(attachRequested
      ? { opencodeAttachBaseUrl: env.OPENCODE_BASE_URL }
      : {}),
    opencodeConfigDir,
    projectDirectory,
    authorizedRoots: [projectDirectory, opencodeConfigDir],
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
