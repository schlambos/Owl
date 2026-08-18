/**
 * OMO telemetry bridge — OpenCode plugin entry point (Slice 17, hardened;
 * Phase 2 ownership fix).
 *
 * Runs inside the same OpenCode plugin process (same VM) as OMO-Slim and
 * serves READ-ONLY snapshots of OMO's `globalThis` `Symbol.for` stores over
 * a loopback-only HTTP endpoint:
 *
 * - `GET /telemetry` → {@link TelemetrySnapshot} (schema v3)
 * - `GET /health`    → `{ ok, schemaVersion, bound, capabilities, ... }`
 * - non-GET on `/health` or `/telemetry` → `405 Method Not Allowed`
 * - anything else → `404 Not Found`
 *
 * Guarantees:
 * - Loopback only: the host is hardcoded to `127.0.0.1` and is never read
 *   from env/config. No CORS headers, no auth (loopback needs none).
 * - Read-only: no OpenCode mutations, no network writes, no file writes.
 *   The only hook registered is `dispose` (server shutdown).
 * - REGISTRATION IS NOT ACTIVATION. A bare registration with no managed
 *   activation identity resolves to a typed INACTIVE outcome: supported
 *   no-op hooks, a stable secret-free structured log, and ZERO
 *   acquire/factory/bind calls. There is no legacy default port and no
 *   zero-config/manual bind path.
 * - Partial, mixed-channel, or malformed activation resolves to a typed
 *   INVALID outcome (stable redacted reason/detail codes, no custom hooks,
 *   zero bind). A missing/unparseable canonical origin is invalid and never
 *   binds.
 * - A complete managed activation that cannot bind (e.g. EADDRINUSE from a
 *   foreign or unmanaged listener) rejects plugin init with a typed,
 *   redacted {@link BridgeActivationError} (stable code only). The failure
 *   is surfaced — never swallowed as a successful unbound load. No port
 *   fallback, retry, sleep, probe, or adoption.
 * - Ownership state machine + lease lifecycle (lifecycle.ts): Starting is
 *   published before serve; compatible acquisitions join one epoch; every
 *   lease is fenced to its exact owner epoch; incompatible identity is a
 *   typed rejection (no first-registration-wins reuse of mismatched
 *   identity); a failed stop fences the registry against rebind.
 *
 * Activation channels (exactly one complete channel required):
 *  1. Tuple: `["<plugin>", { port, activationNonce }]` in the plugin array.
 *  2. Env (canonical managed path): `OMO_BRIDGE_PORT` +
 *     `OMO_BRIDGE_ACTIVATION_NONCE` (launch-scoped overlay).
 * Channels are never mixed. Managed port range: `8788..8803` inclusive.
 * The raw nonce is fingerprinted during resolution and never retained,
 * returned, or logged.
 *
 * This module exports ONLY the default plugin function. Named exports live
 * in dedicated modules (`./routing`, `./stores`, `./options`, `./lifecycle`)
 * so upstream cannot treat them as plugin candidates.
 */

import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { captureBridgeIdentity, type BridgeIdentity } from "./stores";
import {
  resolveBridgeActivation,
  type BridgeActivationInvalid,
} from "./options";
import {
  acquireBridge,
  __testServerFactoryOverride,
  type BridgeServerFactory,
  type BridgeServerHandle,
  type BridgeLease,
} from "./lifecycle";
import { buildBridgeFetchHandler } from "./routing";

/** Bridge package version resolved from package.json at init (best-effort). */
let bridgePackageVersion: string | undefined;

/**
 * Bun server factory (production). Isolated so tests can inject a fake
 * factory without touching `Bun.serve`. The Bun `Server` structurally
 * satisfies `BridgeServerHandle` (including the async `stop` contract) — no
 * capability-hiding cast is used.
 */
const bunServerFactory: BridgeServerFactory = {
  serve(opts): BridgeServerHandle {
    const server = Bun.serve({
      hostname: opts.hostname,
      port: opts.port,
      fetch: opts.fetch,
    });
    return {
      hostname: server.hostname ?? opts.hostname,
      port: server.port ?? opts.port,
      stop: (closeActiveConnections?: boolean) =>
        Promise.resolve(server.stop(closeActiveConnections)),
    };
  },
};

/**
 * Resolve the bridge package version from `package.json` once at module load.
 * Best-effort: undefined when unresolvable. Uses `import.meta.url` to locate
 * the sibling `package.json`.
 */
async function resolvePackageVersion(): Promise<string | undefined> {
  try {
    const moduleUrl = import.meta.url;
    if (!moduleUrl || !moduleUrl.startsWith("file:")) return undefined;
    const pkgUrl = new URL("../package.json", moduleUrl);
    const mod = (await import(pkgUrl.href)) as { default?: unknown };
    const pkg = mod.default;
    if (
      pkg &&
      typeof pkg === "object" &&
      pkg !== null &&
      "version" in pkg &&
      typeof (pkg as Record<string, unknown>).version === "string"
    ) {
      return (pkg as Record<string, string>).version;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stable, secret-free structured log for the inactive outcome (bare
 * registration without managed activation identity).
 */
function logInactive(): void {
  console.info(
    "[omo-telemetry-bridge] telemetry bridge inactive " +
      "(reason=activation-absent): no managed activation identity supplied; " +
      "no listener will be bound",
  );
}

/**
 * Log an invalid-activation outcome. Uses ONLY the stable reason/detail
 * codes — no raw invalid value is ever logged.
 */
function logInvalidActivation(error: BridgeActivationInvalid): void {
  console.error(
    "[omo-telemetry-bridge] invalid bridge activation — not binding " +
      `(reason=${error.reason}, detail=${error.detail}` +
      `${error.field !== undefined ? `, field=${error.field}` : ""}): ` +
      `${error.message}`,
  );
}

/** Supported no-op hooks for inactive/invalid outcomes. */
function inactiveHooks(): Hooks {
  return {
    async dispose() {
      // No server was started; no lease to release.
    },
  };
}

/**
 * OpenCode plugin entry point.
 *
 * @param input Plugin input (serverUrl used for canonical origin identity).
 * @param options Optional plugin options (`{ port?, activationNonce? }`).
 */
export default async function omoTelemetryBridge(
  input: PluginInput,
  options?: PluginOptions,
): Promise<Hooks> {
  // Resolve package version once (best-effort).
  if (bridgePackageVersion === undefined) {
    bridgePackageVersion = await resolvePackageVersion();
  }

  // Resolve the typed activation. The raw nonce is fingerprinted inside
  // resolveBridgeActivation and is NOT retained in the result.
  const activationResult = await resolveBridgeActivation(options);
  if (activationResult.kind === "inactive") {
    // Bare registration: typed inactive. Zero acquire/factory/bind calls.
    logInactive();
    return inactiveHooks();
  }
  if (activationResult.kind === "invalid") {
    // Partial/mixed/malformed activation: typed invalid. Zero bind.
    logInvalidActivation(activationResult.error);
    return inactiveHooks();
  }
  const activation = activationResult.activation;

  // Capture per-plugin-instance identity. The nonce fingerprint from the
  // activation is used directly — no raw nonce reaches identity.
  const identity: BridgeIdentity = await captureBridgeIdentity({
    serverUrl: input?.serverUrl,
    nonceFingerprint: activation.nonceFingerprint,
    bridgePackageVersion,
  });

  // A complete managed activation requires a parseable canonical origin.
  // Missing/invalid origin is an invalid activation — zero acquire/bind.
  if (identity.canonicalOrigin === undefined) {
    const originError: BridgeActivationInvalid = {
      reason: "activation-incomplete",
      detail:
        input?.serverUrl === undefined || input?.serverUrl === null
          ? "canonical-origin-missing"
          : "canonical-origin-invalid",
      message:
        "managed activation requires a parseable canonical OpenCode origin",
      field: "canonicalOrigin",
    };
    logInvalidActivation(originError);
    return inactiveHooks();
  }

  // Build the fetch handler. The handler only runs when a server is bound,
  // so `bound` is always true for arriving requests.
  const fetchHandler = buildBridgeFetchHandler(identity, true);

  // Acquire the bridge lease through the ownership state machine. A failed
  // acquisition throws a typed, redacted BridgeActivationError — surfaced,
  // never swallowed as a successful unbound load. (The factory override is a
  // test-only seam, always undefined in production.)
  const lease: BridgeLease = await acquireBridge(
    activation,
    identity,
    __testServerFactoryOverride() ?? bunServerFactory,
    fetchHandler,
  );

  return {
    async dispose() {
      await lease.dispose();
    },
  };
}
