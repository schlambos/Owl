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
 * dependency (tests/disabled lane). Owned start is CLI-PRIMARY: it spawns
 * `opencode serve` directly (startViaOpencodeCli) because compiled Bun
 * sidecars cannot resolve cross-spawn's `which` require from the external
 * SDK install. The verified overlay (port + raw nonce) is captured before
 * any spawn; stale OMO_BRIDGE_PORT / OMO_BRIDGE_ACTIVATION_NONCE values
 * are deleted before the child env snapshot and the exact parent env is
 * restored before awaiting. No other env reconstruction. Attach/external
 * never uses this path. If launch boundary fails, owned start fails closed
 * with redacted error before spawn. The installed-SDK path remains as a
 * fallback when the opencode binary cannot be resolved/spawned.
 */
import type { BridgeRevisionStore } from "../opencode-bridge/revisions-bridge";
import {
  withOwnedBridgeLaunchEnv,
  type LaunchEnvOverlay,
  type LaunchSecretRedactor,
} from "../opencode-bridge/launch-boundary";
import { sanitizeOpenCodeError } from "./security";
import { existsSync, statSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

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
 * Default owned starter. CLI-PRIMARY: spawns `opencode serve` directly via
 * node:child_process (startViaOpencodeCli), which replicates the installed
 * SDK's createOpencodeServer contract exactly but does NOT depend on
 * cross-spawn/`which` — required because compiled Bun sidecars run with
 * load_package_json=false and cannot resolve `which` from the external
 * SDK install. The installed-SDK path (startViaInstalledSdk) remains as a
 * fallback when the opencode binary cannot be resolved or spawned, and its
 * isModuleResolutionFailure detection remains as a safety net.
 *
 * Bridge launch env semantics are unchanged: `withOwnedBridgeLaunchEnv`
 * verifies committed activation state and supplies the overlay (port + raw
 * nonce) before any spawn; stale OMO_BRIDGE_PORT / OMO_BRIDGE_ACTIVATION_NONCE
 * values are deleted before spawn and the exact parent env is restored
 * before any await. If the launch boundary fails (dirty reconciliation,
 * conflict, transport unverified, hash drift, missing nonce), owned start
 * fails closed with a redacted error before spawn.
 */
export const startManagedSdkServer: ManagedSdkStarter = async (options) => {
  // The bridge store is read from the module-level variable set by
  // setBridgeRevisionStoreForLaunch(). When undefined (disabled lane /
  // tests), the launch boundary is skipped and the overlay is empty
  // (no bridge env injected).
  const store = currentBridgeStore;

  // Capture prior bridge env state BEFORE anything touches env.
  const priorBridgeEnv = captureBridgeEnv(process.env);

  // Verify committed bridge activation state and capture the verified
  // overlay. The boundary itself never mutates process.env; the raw nonce
  // is confined to the overlay value plus the safe redaction closure.
  let capturedOverlay: LaunchEnvOverlay = {};
  let redactLaunchNonce: LaunchSecretRedactor | undefined;

  if (store) {
    const boundaryResult = withOwnedBridgeLaunchEnv(
      { store },
      (overlay, redact) => {
        redactLaunchNonce = redact;
        capturedOverlay = overlay;
      },
    );
    if (!boundaryResult.ok) {
      capturedOverlay = {};
    }
  }

  // PRIMARY: direct `opencode serve` spawn. Stale bridge env values are
  // deleted before the child env snapshot (taken synchronously inside
  // startViaOpencodeCli) and restored BEFORE awaiting.
  deleteBridgeEnv(process.env);
  let cliPromise: Promise<ManagedSdkHandle>;
  try {
    cliPromise = startViaOpencodeCli(options, capturedOverlay);
  } catch {
    // Binary could not be resolved on PATH / GUI-safe dirs — fall back to
    // the installed SDK path.
    restoreBridgeEnv(process.env, priorBridgeEnv);
    return startViaInstalledSdk(options, capturedOverlay, priorBridgeEnv, redactLaunchNonce);
  }
  restoreBridgeEnv(process.env, priorBridgeEnv);

  try {
    return await cliPromise;
  } catch (error) {
    if (isCliSpawnAvailabilityError(error)) {
      // Binary vanished or could not be exec'd — fall back to the SDK path.
      return startViaInstalledSdk(options, capturedOverlay, priorBridgeEnv, redactLaunchNonce);
    }
    throw new Error(
      sanitizeSdkStartError(
        error,
        collectTransientSecrets(priorBridgeEnv, capturedOverlay),
        redactLaunchNonce,
      ),
    );
  }
};

/**
 * Spawn errors that mean the opencode binary itself is unavailable, so the
 * SDK fallback path is worth attempting. Timeouts / non-zero exits / parse
 * failures mean the binary ran — retrying the same serve via the SDK would
 * fail identically, so those do NOT fall back.
 */
function isCliSpawnAvailabilityError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "EACCES";
}

/**
 * Transient secret values eligible for redaction from start errors. Redaction
 * only ever removes text; including overlay values here never exposes them.
 */
function collectTransientSecrets(
  priorBridgeEnv: Record<BridgeEnvKey, string | undefined>,
  overlay: LaunchEnvOverlay,
): Array<string | undefined> {
  return [
    process.env.OPENCODE_SERVER_PASSWORD,
    priorBridgeEnv.OMO_BRIDGE_ACTIVATION_NONCE,
    priorBridgeEnv.OMO_BRIDGE_PORT,
    overlay.OMO_BRIDGE_ACTIVATION_NONCE,
    overlay.OMO_BRIDGE_PORT,
  ];
}

/**
 * FALLBACK owned start via the installed @opencode-ai/sdk@1.18.14
 * createOpencodeServer(). The version gate applies ONLY to this path (the
 * CLI primary path does not import the SDK at all).
 *
 * Env handling around createOpencodeServer():
 *  1. Delete stale bridge env values.
 *  2. Apply the verified overlay synchronously before spawn.
 *  3. Invoke createOpencodeServer synchronously and capture the returned
 *     promise (the SDK spreads ...process.env into the child).
 *  4. Restore exact parent env BEFORE awaiting.
 */
async function startViaInstalledSdk(
  options: ManagedSdkStartOptions,
  overlay: LaunchEnvOverlay,
  priorBridgeEnv: Record<BridgeEnvKey, string | undefined>,
  redactLaunchNonce: LaunchSecretRedactor | undefined,
): Promise<ManagedSdkHandle> {
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

  deleteBridgeEnv(process.env);
  let spawnPromise: Promise<ManagedSdkHandle>;
  try {
    applyBridgeOverlay(process.env, overlay);
    // Invoke synchronously and capture the promise; invokeCreateOpencodeServer
    // converts sync throws into rejections, so env restore in finally is safe.
    spawnPromise = invokeCreateOpencodeServer(sdk.createOpencodeServer, options);
  } finally {
    // Restore exact parent env BEFORE awaiting the spawn promise.
    restoreBridgeEnv(process.env, priorBridgeEnv);
  }

  // Await the captured promise. The SDK's error message may contain child
  // stderr/stdout with provider credentials or raw nonce values; sanitize
  // with sanitizeOpenCodeError before rethrowing so state/diagnostics/logs
  // never observe raw secrets.
  try {
    return await spawnPromise;
  } catch (error) {
    if (isModuleResolutionFailure(error)) {
      // Safety net: compiled Bun sidecars cannot resolve cross-spawn's
      // `which` require from ~/.config/opencode/node_modules. Retry the
      // direct CLI spawn with the identical args/env contract.
      try {
        return await startViaOpencodeCli(options, overlay);
      } catch (fallbackError) {
        throw new Error(
          sanitizeSdkStartError(
            fallbackError,
            collectTransientSecrets(priorBridgeEnv, overlay),
            redactLaunchNonce,
          ),
        );
      }
    }
    throw new Error(
      sanitizeSdkStartError(
        error,
        collectTransientSecrets(priorBridgeEnv, overlay),
        redactLaunchNonce,
      ),
    );
  }
}

function invokeCreateOpencodeServer(
  create: ManagedSdkStarter,
  options: ManagedSdkStartOptions,
): Promise<ManagedSdkHandle> {
  try {
    return Promise.resolve(create(options));
  } catch (error) {
    return Promise.reject(error);
  }
}

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

/** Compiled-sidecar / Bun ResolveMessage: cross-spawn cannot require `which`. */
export function isModuleResolutionFailure(error: unknown): boolean {
  const text =
    error instanceof Error
      ? `${error.name} ${error.message}`
      : typeof error === "string"
        ? error
        : (() => {
            try {
              return JSON.stringify(error) ?? "";
            } catch {
              return String(error);
            }
          })();
  return (
    /Cannot find package ['"]which['"]/i.test(text) ||
    /ResolveMessage/i.test(text) ||
    /Cannot find package ['"]cross-spawn['"]/i.test(text)
  );
}

const OPENCODE_BIN = process.platform === "win32" ? "opencode.exe" : "opencode";

/**
 * Resolve the `opencode` CLI the same way a terminal would, plus GUI-safe
 * extra dirs. Finder-launched macOS apps do not inherit Homebrew PATH.
 */
export function resolveOpencodeExecutable(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const extra = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".opencode", "bin"),
    join(homedir(), ".local", "bin"),
  ];
  const dirs = [...(env.PATH ?? "").split(delimiter).filter(Boolean), ...extra];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const candidate = join(dir, OPENCODE_BIN);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      /* skip unreadable entries */
    }
  }
  throw new Error(
    "opencode executable not found on PATH (or /opt/homebrew/bin, /usr/local/bin). Install OpenCode and retry.",
  );
}

/**
 * Same contract as installed SDK createOpencodeServer: spawn
 * `opencode serve --hostname --port`, parse the listening URL, return
 * { url, close }. Does not use cross-spawn / which.
 */
export function startViaOpencodeCli(
  options: ManagedSdkStartOptions,
  overlay: LaunchEnvOverlay = {},
): Promise<ManagedSdkHandle> {
  const bin = resolveOpencodeExecutable(process.env);
  const args = [
    "serve",
    `--hostname=${options.hostname}`,
    `--port=${options.port}`,
  ];
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  if (overlay.OMO_BRIDGE_PORT !== undefined) {
    childEnv.OMO_BRIDGE_PORT = overlay.OMO_BRIDGE_PORT;
  }
  if (overlay.OMO_BRIDGE_ACTIVATION_NONCE !== undefined) {
    childEnv.OMO_BRIDGE_ACTIVATION_NONCE = overlay.OMO_BRIDGE_ACTIVATION_NONCE;
  }
  if (childEnv.OPENCODE_CONFIG_CONTENT === undefined) {
    childEnv.OPENCODE_CONFIG_CONTENT = "{}";
  }

  const proc: ChildProcess = spawn(bin, args, {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  return new Promise<ManagedSdkHandle>((resolve, reject) => {
    const timeoutMs = options.timeout;
    let output = "";
    let settled = false;

    const finish = (err?: Error, handle?: ManagedSdkHandle) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (err) {
        stopChild(proc);
        reject(err);
      } else if (handle) {
        resolve(handle);
      }
    };

    const onAbort = () => {
      finish(options.signal?.reason instanceof Error
        ? options.signal.reason
        : new Error("OpenCode CLI start aborted"));
    };

    const timer = setTimeout(() => {
      finish(new Error(`Timeout waiting for server to start after ${timeoutMs}ms`));
    }, timeoutMs);

    const onChunk = (chunk: Buffer | string) => {
      if (settled) return;
      output += chunk.toString();
      for (const line of output.split("\n")) {
        if (!line.startsWith("opencode server listening")) continue;
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
        if (!match) {
          finish(new Error(`Failed to parse server url from output: ${line}`));
          return;
        }
        finish(undefined, {
          url: match[1]!,
          close() {
            stopChild(proc);
          },
        });
        return;
      }
    };

    proc.stdout?.on("data", onChunk);
    proc.stderr?.on("data", onChunk);
    proc.on("error", (error) => finish(error));
    proc.on("exit", (code) => {
      if (settled) return;
      let msg = `Server exited with code ${code}`;
      if (output.trim()) msg += `\nServer output: ${output}`;
      finish(new Error(msg));
    });
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function stopChild(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === "win32" && proc.pid) {
    spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  proc.kill();
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