/**
 * Narrow adapter over installed @opencode-ai/sdk@1.18.14.
 *
 * createOpencode() only adds a generated client to the same server handle;
 * this control plane already has a mature REST/SSE normalizer, so the minimal
 * createOpencodeServer() API is the useful lifecycle surface (url + close).
 * SDK source verifies inherited process.env, OPENCODE_CONFIG_CONTENT overlay,
 * loopback/port arguments, no PID in the return type, and no success log API.
 *
 * Slice 17: owned start integrates the non-barrel `withOwnedBridgeLaunchEnv`
 * from opencode-bridge/launch-boundary. BridgeRevisionStore is an optional
 * dependency (tests/disabled lane). After all dynamic imports, immediately
 * around the installed SDK `createOpencodeServer()` call: capture prior
 * present/absent values for OMO_BRIDGE_PORT and OMO_BRIDGE_ACTIVATION_NONCE;
 * delete stale values; apply verified overlay if enabled; invoke
 * createOpencodeServer synchronously and capture returned promise; restore
 * exact parent env in finally BEFORE awaiting. No other env reconstruction.
 * Attach/external never uses this path. If launch boundary fails, owned
 * start fails closed with redacted error before spawn.
 */
import type { BridgeRevisionStore } from "../opencode-bridge/revisions-bridge";
import {
  withOwnedBridgeLaunchEnv,
  type LaunchEnvOverlay,
  type LaunchSecretRedactor,
} from "../opencode-bridge/launch-boundary";
import { sanitizeOpenCodeError } from "./security";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

/**
 * The owned SDK start resolves the active-config SDK install directly from
 * the environment. Unlike config.ts, this adapter has no default config
 * directory: OPENCODE_CONFIG_DIR must be a non-empty, absolute, existing
 * directory, and a clear error is thrown when it is absent or invalid.
 */
function requireValidOpenCodeConfigDir(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    throw new Error(
      "OPENCODE_CONFIG_DIR must be set to a non-empty absolute existing directory for the owned OpenCode SDK start",
    );
  }
  if (!isAbsolute(trimmed)) {
    throw new Error(
      `OPENCODE_CONFIG_DIR must be an absolute directory path: ${trimmed}`,
    );
  }
  let stats;
  try {
    stats = statSync(trimmed);
  } catch {
    throw new Error(`OPENCODE_CONFIG_DIR does not exist: ${trimmed}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`OPENCODE_CONFIG_DIR is not a directory: ${trimmed}`);
  }
  return trimmed;
}

export interface ManagedSdkHandle {
  url: string;
  close(): void;
}

export interface ManagedSdkStartOptions {
  hostname: string;
  port: number;
  timeout: number;
  signal?: AbortSignal;
}

export type ManagedSdkStarter = (
  options: ManagedSdkStartOptions,
) => Promise<ManagedSdkHandle>;

/**
 * Owned bridge launch environment keys. These are the ONLY env vars the
 * launch boundary is permitted to overlay. Stale values are deleted before
 * applying the verified overlay, and the exact parent env is restored in
 * finally BEFORE awaiting the SDK promise.
 */
const BRIDGE_ENV_KEYS = ["OMO_BRIDGE_PORT", "OMO_BRIDGE_ACTIVATION_NONCE"] as const;

type BridgeEnvKey = (typeof BRIDGE_ENV_KEYS)[number];

/**
 * Capture the prior present/absent state of a bridge env key. `undefined`
 * means the key was absent; a string means it was present with that value.
 */
function captureBridgeEnv(env: NodeJS.ProcessEnv): Record<BridgeEnvKey, string | undefined> {
  return {
    OMO_BRIDGE_PORT: env.OMO_BRIDGE_PORT,
    OMO_BRIDGE_ACTIVATION_NONCE: env.OMO_BRIDGE_ACTIVATION_NONCE,
  };
}

/**
 * Restore the exact prior env state for bridge keys. Keys that were absent
 * are deleted; keys that were present are restored to their exact value.
 */
function restoreBridgeEnv(env: NodeJS.ProcessEnv, prior: Record<BridgeEnvKey, string | undefined>): void {
  for (const key of BRIDGE_ENV_KEYS) {
    const val = prior[key];
    if (val === undefined) {
      delete env[key];
    } else {
      env[key] = val;
    }
  }
}

/**
 * Delete stale bridge env values before applying the verified overlay.
 */
function deleteBridgeEnv(env: NodeJS.ProcessEnv): void {
  for (const key of BRIDGE_ENV_KEYS) {
    delete env[key];
  }
}

/**
 * Apply the verified launch overlay to the process env. Only non-undefined
 * overlay values are set; undefined values are deleted.
 */
function applyBridgeOverlay(env: NodeJS.ProcessEnv, overlay: LaunchEnvOverlay): void {
  for (const key of BRIDGE_ENV_KEYS) {
    const val = overlay[key];
    if (val === undefined) {
      delete env[key];
    } else {
      env[key] = val;
    }
  }
}

/**
 * Redacted error thrown when the launch boundary fails closed. The message
 * never contains the raw nonce, port, or config content — only a stable
 * code and a redacted description.
 */
export class BridgeLaunchBoundaryError extends Error {
  override readonly name = "BridgeLaunchBoundaryError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`Bridge launch boundary failed (${code}): ${message}`);
  }
}

/**
 * Default owned SDK starter. Integrates `withOwnedBridgeLaunchEnv` around
 * the installed SDK `createOpencodeServer()` call.
 *
 * If `bridgeStore` is provided, the launch boundary verifies committed
 * bridge activation state, checks for dirty reconciliation/conflicts, and
 * supplies the overlay (port + raw nonce) exclusively to the synchronous
 * spawn scope. If `bridgeStore` is omitted (disabled lane / tests), the
 * callback is invoked with an empty overlay (no bridge env injected).
 *
 * Env handling around createOpencodeServer():
 *  1. Capture prior present/absent values for OMO_BRIDGE_PORT and
 *     OMO_BRIDGE_ACTIVATION_NONCE.
 *  2. Delete stale values.
 *  3. Apply verified overlay if enabled (inside the launch boundary
 *     callback, synchronously before spawn).
 *  4. Invoke createOpencodeServer synchronously and capture the returned
 *     promise.
 *  5. Restore exact parent env in finally BEFORE awaiting.
 *
 * If the launch boundary fails (dirty reconciliation, conflict, transport
 * unverified, hash drift, missing nonce), owned start fails closed with a
 * redacted error before spawn.
 */
export const startManagedSdkServer: ManagedSdkStarter = async (options) => {
  // Variable dynamic import intentionally resolves the active-config install,
  // rather than allowing a workspace dependency to drift from OpenCode.
  // The config dir comes from OPENCODE_CONFIG_DIR only — no default path.
  const configDir = requireValidOpenCodeConfigDir(process.env.OPENCODE_CONFIG_DIR);
  const modulePath = `${configDir.replace(/\/$/, "")}/node_modules/@opencode-ai/sdk/dist/server.js`;
  const packagePath = `${configDir.replace(/\/$/, "")}/node_modules/@opencode-ai/sdk/package.json`;
  const pkg = (await import(packagePath, { with: { type: "json" } })).default as {
    version?: string;
  };
  if (pkg.version !== "1.18.14") {
    throw new Error(
      `Unsupported active OpenCode SDK version ${pkg.version ?? "unknown"}; expected 1.18.14`,
    );
  }
  const sdk = (await import(modulePath)) as {
    createOpencodeServer: ManagedSdkStarter;
  };

  // The bridge store is read from the module-level variable set by
  // setBridgeRevisionStoreForLaunch(). When undefined (disabled lane /
  // tests), the launch boundary is skipped and the callback receives an
  // empty overlay (no bridge env injected).
  const store = currentBridgeStore;

  // Capture prior bridge env state BEFORE the launch boundary touches env.
  const priorBridgeEnv = captureBridgeEnv(process.env);

  // The launch boundary callback runs synchronously. Inside it, we:
  //  - delete stale bridge env values
  //  - apply the verified overlay
  //  - invoke createOpencodeServer synchronously
  //  - capture the returned promise
  // The raw nonce exists ONLY inside this callback scope.
  let spawnPromise: Promise<ManagedSdkHandle> | undefined;
  let boundaryError: BridgeLaunchBoundaryError | undefined;
  // Safe redaction closure captured inside the launch boundary scope. It can
  // redact the raw launch nonce from later SDK errors WITHOUT exposing it.
  let redactLaunchNonce: LaunchSecretRedactor | undefined;

  if (store) {
    const boundaryResult = withOwnedBridgeLaunchEnv(
      { store },
      (overlay, redact) => {
        redactLaunchNonce = redact;
        // Delete stale bridge env values.
        deleteBridgeEnv(process.env);
        // Apply the verified overlay (port + raw nonce, or empty when disabled).
        applyBridgeOverlay(process.env, overlay);
        // Invoke createOpencodeServer synchronously and capture the promise.
        // The SDK spreads ...process.env into the child, so the overlay is
        // visible to the synchronous spawn.
        spawnPromise = sdk.createOpencodeServer(options);
      },
    );

    if (!boundaryResult.ok) {
      // Launch boundary failed closed: restore env, then fail with a redacted
      // error before spawn. The raw nonce is never in the error.
      restoreBridgeEnv(process.env, priorBridgeEnv);
      const firstError = boundaryResult.errors[0];
      boundaryError = new BridgeLaunchBoundaryError(
        firstError?.code ?? "state-conflict",
        firstError?.message ?? "Launch boundary verification failed.",
      );
    }
  } else {
    // Disabled lane: no launch boundary, empty overlay.
    deleteBridgeEnv(process.env);
    try {
      spawnPromise = sdk.createOpencodeServer(options);
    } catch (error) {
      // Restore env before rethrowing.
      restoreBridgeEnv(process.env, priorBridgeEnv);
      throw error;
    }
  }

  if (boundaryError) {
    throw boundaryError;
  }

  // Restore exact parent env BEFORE awaiting the spawn promise.
  restoreBridgeEnv(process.env, priorBridgeEnv);

  // Await the captured promise. The SDK's error message may contain child
  // stderr/stdout with provider credentials or raw nonce values; sanitize
  // with sanitizeOpenCodeError before rethrowing so state/diagnostics/logs
  // never observe raw secrets. Known auth/bridge env values are included
  // transiently only inside the launch boundary callback scope (already
  // restored above); the sanitized error never contains the raw nonce.
  try {
    return await spawnPromise!;
  } catch (error) {
    // A synthetic SDK rejection may embed child stderr/stdout containing
    // provider credentials, prior parent bridge env values, or the launch
    // nonce. Redact ALL of them before the error can reach lifecycle state,
    // diagnostics, or logs.
    const transientSecrets: Array<string | undefined> = [
      process.env.OPENCODE_SERVER_PASSWORD,
      priorBridgeEnv.OMO_BRIDGE_ACTIVATION_NONCE,
      priorBridgeEnv.OMO_BRIDGE_PORT,
    ];
    throw new Error(
      sanitizeSdkStartError(error, transientSecrets, redactLaunchNonce),
    );
  }
};

/**
 * Sanitize an asynchronous `createOpencodeServer` rejection.
 *
 * ORDER MATTERS: the launch-secret redactor is applied to the ORIGINAL
 * error text BEFORE `sanitizeOpenCodeError` normalization (whitespace
 * collapse/trim) — normalization must never get a chance to observe or
 * reshape the raw nonce. Parent env secrets are then redacted by
 * `sanitizeOpenCodeError` as before. Pure and exported for focused tests.
 */
export function sanitizeSdkStartError(
  error: unknown,
  transientSecrets: Array<string | undefined>,
  redactLaunchNonce?: LaunchSecretRedactor,
): string {
  let original: string;
  if (error instanceof Error) original = error.message;
  else if (typeof error === "string") original = error;
  else {
    try {
      original = JSON.stringify(error) ?? String(error);
    } catch {
      original = String(error);
    }
  }
  const preRedacted =
    redactLaunchNonce !== undefined ? redactLaunchNonce(original) : original;
  return sanitizeOpenCodeError(preRedacted, transientSecrets);
}

// ── BridgeRevisionStore injection (composition root sets this) ──────────

let currentBridgeStore: BridgeRevisionStore | undefined;

/**
 * Set the long-lived BridgeRevisionStore for owned launch env verification.
 * The composition root owns and closes the store; this adapter never closes
 * it. When undefined (disabled lane / tests), the launch boundary callback
 * receives an empty overlay and no bridge env is injected.
 */
export function setBridgeRevisionStoreForLaunch(store: BridgeRevisionStore | undefined): void {
  currentBridgeStore = store;
}

/**
 * Get the currently injected bridge store (for tests / diagnostics).
 * Never exposes the raw nonce — only the store reference.
 */
export function getBridgeRevisionStoreForLaunch(): BridgeRevisionStore | undefined {
  return currentBridgeStore;
}

/**
 * Test helper: directly run the owned-start env overlay logic with an
 * explicit store and a synchronous spawn callback, returning what the
 * callback observed. This proves the overlay is seen by the synchronous
 * spawn and that parent env is restored on success/throw/disabled.
 *
 * The raw nonce exists ONLY inside the callback scope.
 *
 * When store is undefined (disabled lane / tests), the callback is invoked
 * with an empty overlay (no bridge env injected) — the launch boundary
 * is skipped because there is no committed state to verify.
 */
export function __testOwnedLaunchEnvOverlay(
  store: BridgeRevisionStore | undefined,
  spawn: (overlay: LaunchEnvOverlay, redact: LaunchSecretRedactor) => void,
): {
  ok: boolean;
  errors: Array<{ code: string; message: string }>;
  envAfterRestore: Record<BridgeEnvKey, string | undefined>;
} {
  const prior = captureBridgeEnv(process.env);
  let ok: boolean;
  let errors: Array<{ code: string; message: string }>;
  if (!store) {
    // Disabled lane: invoke spawn with empty overlay, no launch boundary.
    try {
      deleteBridgeEnv(process.env);
      spawn({}, (text) => text);
      ok = true;
      errors = [];
    } catch {
      ok = false;
      errors = [{ code: "spawn-failed", message: "Spawn callback threw." }];
    }
  } else {
    const boundaryResult = withOwnedBridgeLaunchEnv(
      { store },
      (overlay, redact) => {
        deleteBridgeEnv(process.env);
        applyBridgeOverlay(process.env, overlay);
        spawn(overlay, redact);
      },
    );
    ok = boundaryResult.ok;
    errors = boundaryResult.errors.map((e) => ({ code: e.code, message: e.message }));
  }
  // Restore exact parent env.
  restoreBridgeEnv(process.env, prior);
  return {
    ok,
    errors,
    envAfterRestore: captureBridgeEnv(process.env),
  };
}

/**
 * Installed SDK passes --port=0 through and resolves the URL emitted by
 * OpenCode, so the OS-selected actual port is available as handle.url.
 */
export const INSTALLED_SDK_SUPPORTS_EPHEMERAL_PORT = true;