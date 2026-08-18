/**
 * Bridge activation resolution (Slice 17, hardened — Phase 2 ownership fix).
 *
 * REGISTRATION IS NOT ACTIVATION. A bare plugin registration (no tuple
 * options, no activation env) resolves to a typed INACTIVE result and never
 * binds. There is no legacy default port and no zero-config/manual bind path.
 *
 * Activation requires ONE complete, deliberate channel:
 *
 *  1. Tuple channel — `["<plugin>", { port, activationNonce }]` in the
 *     OpenCode config plugin array.
 *  2. Env channel — `OMO_BRIDGE_PORT` + `OMO_BRIDGE_ACTIVATION_NONCE`
 *     (the canonical managed path: bare string registration + launch-scoped
 *     env overlay supplied by the control-plane launch boundary).
 *
 * Channels are never mixed: tuple port + env nonce (or vice versa) is
 * invalid. A partial channel (port-only or nonce-only) is invalid. Invalid
 * values fail closed. All of these produce a typed INVALID result with
 * stable, secret-free reason/detail codes — no raw values are propagated.
 *
 * When BOTH channels are complete, the explicit tuple channel wins
 * (long-standing options-over-env precedence, preserved).
 *
 * Active output carries: host `127.0.0.1` (hardcoded), explicit managed
 * port, transport `loopback-http`, and the SHA-256 nonce fingerprint. The
 * raw nonce is consumed only by the fingerprint digest and is NEVER retained
 * in the result. The canonical-origin requirement is enforced by the plugin
 * entry (index.ts) from `PluginInput.serverUrl` before acquisition.
 *
 * Security: no raw nonce, env value, or invalid raw value is ever returned
 * or logged from this module — only stable reason/detail codes.
 */

/** Hardcoded loopback bind address. Deliberately NOT configurable. */
export const LOOPBACK_HOST = "127.0.0.1";

/** Inclusive managed port range. */
export const MANAGED_PORT_MIN = 8788;
export const MANAGED_PORT_MAX = 8803;

/** Environment variable keys (the canonical managed activation channel). */
export const PORT_ENV_KEY = "OMO_BRIDGE_PORT";
export const NONCE_ENV_KEY = "OMO_BRIDGE_ACTIVATION_NONCE";

/** Option keys read from `PluginOptions` (the tuple activation channel). */
export const PORT_OPTION_KEY = "port";
export const NONCE_OPTION_KEY = "activationNonce";

/** Minimum activation nonce length (inclusive). */
export const NONCE_MIN_LENGTH = 16;
/** Maximum activation nonce length (inclusive). */
export const NONCE_MAX_LENGTH = 256;

/** Which activation channel supplied a complete identity. */
export type BridgeActivationChannel = "options" | "env";

/**
 * Stable, secret-free detail codes for invalid activation. These are the
 * ONLY diagnostic emitted — no raw invalid values are ever propagated.
 */
export type BridgeActivationInvalidDetail =
  | "port-without-nonce"
  | "nonce-without-port"
  | "mixed-activation-channels"
  | "port-out-of-range"
  | "port-not-integer"
  | "port-not-numeric"
  | "port-wrong-type"
  | "nonce-too-short"
  | "nonce-too-long"
  | "nonce-wrong-type"
  | "nonce-empty"
  | "canonical-origin-missing"
  | "canonical-origin-invalid"
  | "fingerprint-failed"
  | "fingerprint-malformed";

/**
 * Invalid-activation descriptor (fail closed). Contains NO raw values —
 * only stable reason/detail codes and a redacted message safe to log.
 */
export interface BridgeActivationInvalid {
  /**
   * Top-level classification:
   * - `activation-incomplete` — partial channel, mixed channels, invalid
   *   port/nonce, or missing/invalid canonical origin.
   * - `fingerprint-unavailable` — a valid-shaped nonce could not be hashed.
   */
  reason: "activation-incomplete" | "fingerprint-unavailable";
  /** Stable machine-readable detail code. */
  detail: BridgeActivationInvalidDetail;
  /** Redacted human-readable message (no raw value). */
  message: string;
  /** Which logical field was invalid, when applicable. */
  field?: "port" | "activationNonce" | "canonicalOrigin";
}

/**
 * A complete, validated managed activation identity. Contains NO raw nonce —
 * only its SHA-256 fingerprint.
 */
export interface BridgeActivation {
  /** Bind host (always 127.0.0.1). */
  host: "127.0.0.1";
  /** Explicit managed port (8788..8803 inclusive). */
  port: number;
  /** Which channel supplied the complete activation. */
  channel: BridgeActivationChannel;
  /** SHA-256 hex fingerprint of the activation nonce (64 lowercase hex). */
  nonceFingerprint: string;
}

/**
 * Typed activation outcome:
 * - `inactive` — no tuple activation fields and no activation env fields are
 *   present (`activation-absent`). The plugin must not bind.
 * - `invalid` — partial/mixed/malformed activation. The plugin must not bind.
 * - `active` — one complete deliberate channel, fully validated.
 */
export type BridgeActivationResult =
  | { kind: "inactive"; reason: "activation-absent" }
  | { kind: "invalid"; error: BridgeActivationInvalid }
  | { kind: "active"; activation: BridgeActivation };

/** @internal Validation outcome for a single port value. */
type PortCheck =
  | { port: number }
  | { detail: BridgeActivationInvalidDetail; message: string };

/** @internal Validation outcome for a single nonce value. */
type NonceCheck =
  | { nonce: string }
  | { detail: BridgeActivationInvalidDetail; message: string };

/**
 * Validate a port value. Accepts integers in the managed range
 * `8788..8803` inclusive. No legacy/default port exists anymore — an
 * explicit managed port is mandatory for activation.
 */
function validatePort(value: unknown): PortCheck {
  let parsed: number;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return {
        detail: "port-not-numeric",
        message: `port must be a finite integer in ${MANAGED_PORT_MIN}..${MANAGED_PORT_MAX}`,
      };
    }
    parsed = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    // An explicit but empty/whitespace port is INVALID, not absent.
    if (trimmed === "") {
      return {
        detail: "port-not-numeric",
        message: "port is present but empty",
      };
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      return {
        detail: "port-not-numeric",
        message: `port must be a finite integer in ${MANAGED_PORT_MIN}..${MANAGED_PORT_MAX}`,
      };
    }
    parsed = n;
  } else {
    return {
      detail: "port-wrong-type",
      message: `port must be a number or numeric string, got ${typeof value}`,
    };
  }
  if (!Number.isInteger(parsed)) {
    return { detail: "port-not-integer", message: "port must be an integer" };
  }
  if (parsed < MANAGED_PORT_MIN || parsed > MANAGED_PORT_MAX) {
    return {
      detail: "port-out-of-range",
      message: `port is outside managed range ${MANAGED_PORT_MIN}..${MANAGED_PORT_MAX}`,
    };
  }
  return { port: parsed };
}

/**
 * Validate an activation nonce. Must be a string of length
 * `NONCE_MIN_LENGTH..NONCE_MAX_LENGTH` (inclusive).
 */
function validateNonce(value: unknown): NonceCheck {
  if (typeof value !== "string") {
    return {
      detail: "nonce-wrong-type",
      message: `activationNonce must be a string, got ${typeof value}`,
    };
  }
  if (value.trim().length === 0) {
    // Explicit empty OR whitespace-only nonce is invalid (never absent).
    return {
      detail: "nonce-empty",
      message: "activationNonce must be a non-empty, non-whitespace string",
    };
  }
  if (value.length < NONCE_MIN_LENGTH) {
    return {
      detail: "nonce-too-short",
      message: `activationNonce must be at least ${NONCE_MIN_LENGTH} characters`,
    };
  }
  if (value.length > NONCE_MAX_LENGTH) {
    return {
      detail: "nonce-too-long",
      message: `activationNonce must be at most ${NONCE_MAX_LENGTH} characters`,
    };
  }
  return { nonce: value };
}

function invalid(
  detail: BridgeActivationInvalidDetail,
  message: string,
  field?: BridgeActivationInvalid["field"],
): BridgeActivationResult {
  return {
    kind: "invalid",
    error: { reason: "activation-incomplete", detail, message, ...(field ? { field } : {}) },
  };
}

/**
 * Resolve the bridge activation from plugin options and environment.
 *
 * Exactly one complete channel is required. Channels are never combined.
 * When both channels are complete, the explicit tuple channel wins
 * (options-over-env precedence, preserved). The raw nonce is fingerprinted
 * (SHA-256) inside this function and NEVER retained in the result.
 *
 * @param pluginOptions The `PluginOptions` record (second plugin arg).
 * @param envEnv Optional environment override for tests; defaults to
 *               `process.env`.
 * @param fingerprintFn Optional fingerprint function override for tests.
 */
export async function resolveBridgeActivation(
  pluginOptions: unknown,
  envEnv: Record<string, string | undefined> | NodeJS.ProcessEnv = process.env,
  fingerprintFn: (nonce: string) => Promise<string | undefined> = defaultFingerprint,
): Promise<BridgeActivationResult> {
  const opts = (pluginOptions ?? {}) as Record<string, unknown>;

  /**
   * Env presence is determined by OWN-PROPERTY / defined-key BEFORE any
   * trimming. An explicit but empty/whitespace value is PRESENT — and will
   * fail validation (invalid, never silently inactive). The nonce value is
   * NEVER trimmed before hashing: the exact bytes are fingerprinted so the
   * launch boundary's stored fingerprint matches exactly.
   */
  const readEnvRaw = (
    key: string,
  ): { present: boolean; value?: string } => {
    try {
      if (!Object.prototype.hasOwnProperty.call(envEnv, key)) {
        return { present: false };
      }
      const raw = envEnv[key];
      if (raw === undefined) return { present: false };
      return {
        present: true,
        value: typeof raw === "string" ? raw : String(raw),
      };
    } catch {
      return { present: false };
    }
  };

  // Channel presence: tuple fields count when defined and non-null; env
  // fields count when the key is own/defined (even empty).
  const tuplePortRaw = opts[PORT_OPTION_KEY];
  const tupleNonceRaw = opts[NONCE_OPTION_KEY];
  const tuplePortPresent = tuplePortRaw !== undefined && tuplePortRaw !== null;
  const tupleNoncePresent =
    tupleNonceRaw !== undefined && tupleNonceRaw !== null;
  const envPort = readEnvRaw(PORT_ENV_KEY);
  const envNonce = readEnvRaw(NONCE_ENV_KEY);
  const envPortPresent = envPort.present;
  const envNoncePresent = envNonce.present;

  const tupleComplete = tuplePortPresent && tupleNoncePresent;
  const envComplete = envPortPresent && envNoncePresent;

  // ── Inactive: no activation fields on either channel ────────────────
  if (
    !tuplePortPresent &&
    !tupleNoncePresent &&
    !envPortPresent &&
    !envNoncePresent
  ) {
    return { kind: "inactive", reason: "activation-absent" };
  }

  // ── Channel selection (never mixed) ──────────────────────────────────
  let channel: BridgeActivationChannel;
  let portRaw: unknown;
  let nonceRaw: unknown;
  if (tupleComplete) {
    channel = "options";
    portRaw = tuplePortRaw;
    nonceRaw = tupleNonceRaw;
  } else if (!tuplePortPresent && !tupleNoncePresent && envComplete) {
    channel = "env";
    portRaw = envPort.value;
    nonceRaw = envNonce.value;
  } else {
    // Partial and/or mixed activation — fail closed with a stable detail.
    const portSource = tuplePortPresent ? "tuple" : envPortPresent ? "env" : "none";
    const nonceSource = tupleNoncePresent ? "tuple" : envNoncePresent ? "env" : "none";
    if (portSource !== "none" && nonceSource !== "none" && portSource !== nonceSource) {
      return invalid(
        "mixed-activation-channels",
        "activation port and nonce were supplied on different channels; " +
          "provide both via tuple options or both via environment",
      );
    }
    if (portSource !== "none") {
      return invalid(
        "port-without-nonce",
        "activation port was supplied without an activation nonce on the same channel",
        "activationNonce",
      );
    }
    return invalid(
      "nonce-without-port",
      "activation nonce was supplied without an explicit managed port on the same channel",
      "port",
    );
  }

  // ── Validate the selected channel's values (fail closed) ────────────
  const portCheck = validatePort(portRaw);
  if ("detail" in portCheck) {
    return invalid(portCheck.detail, portCheck.message, "port");
  }
  const nonceCheck = validateNonce(nonceRaw);
  if ("detail" in nonceCheck) {
    return invalid(nonceCheck.detail, nonceCheck.message, "activationNonce");
  }

  // ── Fingerprint the nonce; the raw nonce is not retained ────────────
  // The fingerprint function is an isolated seam: a throw, undefined,
  // malformed (not 64 lowercase hex), or equal-to-raw output is a typed
  // invalid result. Raw output never propagates.
  let nonceFingerprint: string | undefined;
  try {
    nonceFingerprint = await fingerprintFn(nonceCheck.nonce);
  } catch {
    nonceFingerprint = undefined;
  }
  if (nonceFingerprint === undefined) {
    return {
      kind: "invalid",
      error: {
        reason: "fingerprint-unavailable",
        detail: "fingerprint-failed",
        message: "activation nonce fingerprint could not be computed",
        field: "activationNonce",
      },
    };
  }
  if (
    !/^[0-9a-f]{64}$/.test(nonceFingerprint) ||
    nonceFingerprint === nonceCheck.nonce
  ) {
    return {
      kind: "invalid",
      error: {
        reason: "fingerprint-unavailable",
        detail: "fingerprint-malformed",
        message: "activation nonce fingerprint was malformed",
        field: "activationNonce",
      },
    };
  }

  return {
    kind: "active",
    activation: {
      host: LOOPBACK_HOST,
      port: portCheck.port,
      channel,
      nonceFingerprint,
    },
  };
}

/**
 * Default SHA-256 fingerprint function. Produces a 64-character lowercase hex
 * string. Returns undefined on any error.
 */
async function defaultFingerprint(nonce: string): Promise<string | undefined> {
  try {
    const data = new TextEncoder().encode(nonce);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const bytes = new Uint8Array(hashBuffer);
    let hex = "";
    for (const b of bytes) hex += b.toString(16).padStart(2, "0");
    return hex;
  } catch {
    return undefined;
  }
}
