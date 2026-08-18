/**
 * Slice 17 hardened — Internal launch-boundary accessor.
 *
 * Oracle decision 4: non-barrel-exported internal module owned in
 * opencode-bridge. Future sdk-adapter imports it directly.
 *
 * Reads committed state afresh, verifies SHA-256 fingerprint parity,
 * verifies on-disk config hash parity, ensures no unresolved or conflict intents exist,
 * and invokes a supplied owned-start synchronous callback with ONLY
 * OMO_BRIDGE_PORT and OMO_BRIDGE_ACTIVATION_NONCE.
 * Disabled state invokes callback with empty overlay and removes stale vars.
 * Fails closed for dirty reconciliation, conflicts, or non-env registration transport.
 */

import { dirname } from "node:path";
import type { BridgeRevisionStore } from "./revisions-bridge";
import type { BridgeError } from "./types";
import { BRIDGE_PORT_RANGE_START, BRIDGE_PORT_RANGE_END } from "./types";
import { fingerprintNonce } from "./extractor";
import { stableReadConfigFile } from "./stable-config-reader";

export interface LaunchEnvOverlay {
  OMO_BRIDGE_PORT?: string;
  OMO_BRIDGE_ACTIVATION_NONCE?: string;
}

/**
 * Safe redaction closure created inside the raw-nonce scope. It replaces
 * every occurrence of the raw nonce in a string with a fixed marker so
 * later SDK errors can be sanitized WITHOUT exposing the raw nonce. The
 * closure retains the nonce in memory only for replacement purposes; it
 * never returns it.
 */
export type LaunchSecretRedactor = (text: string) => string;

/**
 * Launch boundary result. Deliberately carries NO callback value: the
 * callback's return is discarded so the raw nonce can never escape through
 * a generic result channel.
 */
export interface LaunchBoundaryResult {
  ok: boolean;
  errors: BridgeError[];
}

export interface LaunchBoundaryOptions {
  store: BridgeRevisionStore;
}

/**
 * Execute an owned launch start action with verified bridge environment.
 *
 * The raw nonce is read from the DB ONLY within the scoped callback execution,
 * verified against the stored SHA-256 fingerprint, and passed ONLY to the callback in
 * the overlay. It is never logged, returned in any DTO or result, or exposed via public getters.
 */
export function withOwnedBridgeLaunchEnv(
  opts: LaunchBoundaryOptions,
  callback: (overlay: LaunchEnvOverlay, redact: LaunchSecretRedactor) => void,
): LaunchBoundaryResult {
  const store = opts.store;

  // 1. Check for dirty reconciliation or conflict intents.
  if (store.hasUnresolvedOrConflictIntents()) {
    return {
      ok: false,
      errors: [
        {
          code: "state-recovery-pending",
          message: "Unresolved or conflict intents exist — startup reconciliation required before launch.",
        },
      ],
    };
  }

  // 2. Read committed activation state.
  const state = store.getActivationState();
  if (!state || !state.active) {
    // Bridge lane disabled: invoke callback with empty overlay (clears stale
    // vars). The redactor is an identity function (no secret in scope).
    try {
      callback({}, (text) => text);
      return { ok: true, errors: [] };
    } catch {
      return {
        ok: false,
        errors: [{ code: "state-conflict", message: "Launch callback execution failed." }],
      };
    }
  }

  // 3. Verify env registration transport.
  if (state.registrationTransport !== "env") {
    return {
      ok: false,
      errors: [{ code: "transport-unverified", message: "Non-env registration transport not supported for launch." }],
    };
  }

  // 3a. An active committed record MUST be complete: exact configHash,
  // explicit managed port, valid 64-lowercase-hex fingerprint, canonical
  // identity, and loopback transport. Optional/missing fields can NEVER skip
  // validation (Phase 2 ownership hardening).
  if (typeof state.configHash !== "string" || state.configHash.length === 0) {
    return {
      ok: false,
      errors: [{ code: "state-conflict", message: "Committed active bridge has no config hash; cannot verify target parity." }],
    };
  }
  if (typeof state.targetPath !== "string" || state.targetPath.length === 0) {
    return {
      ok: false,
      errors: [{ code: "state-conflict", message: "Committed active bridge has no target path." }],
    };
  }
  if (
    typeof state.port !== "number" ||
    !Number.isInteger(state.port) ||
    state.port < BRIDGE_PORT_RANGE_START ||
    state.port > BRIDGE_PORT_RANGE_END
  ) {
    return {
      ok: false,
      errors: [{ code: "state-conflict", message: "Committed active bridge port is missing or outside the managed range." }],
    };
  }
  if (
    typeof state.nonceFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(state.nonceFingerprint)
  ) {
    return {
      ok: false,
      errors: [{ code: "state-conflict", message: "Committed active bridge nonce fingerprint is missing or malformed." }],
    };
  }
  if (typeof state.canonicalIdentity !== "string" || state.canonicalIdentity.length === 0) {
    return {
      ok: false,
      errors: [{ code: "state-conflict", message: "Committed active bridge has no canonical identity." }],
    };
  }
  if (state.transportMode !== "loopback-http") {
    return {
      ok: false,
      errors: [{ code: "state-conflict", message: "Committed active bridge transport mode is not loopback-http." }],
    };
  }

  // 4. Verify committed config hash parity on disk (mandatory for active)
  //    via the descriptor-stable reader: no plain pathname hash authorizes
  //    launch state.
  const stable = stableReadConfigFile(state.targetPath, {
    maxBytes: 256 * 1024,
    authorizedRoots:
      store.getAuthorizedRoots().length > 0
        ? store.getAuthorizedRoots()
        : [dirname(state.targetPath)],
  });
  if (!stable.ok) {
    return {
      ok: false,
      errors: [{ code: "state-conflict", message: `Target config failed the stable read (${stable.reason}).` }],
    };
  }
  if (stable.hash !== state.configHash) {
    return {
      ok: false,
      errors: [{ code: "state-conflict", message: "Target config hash drift detected against committed state." }],
    };
  }

  // 5. Scoped raw nonce access via withCommittedRawNonce. The callback is
  // synchronous void; its return value is discarded so the raw nonce can
  // never escape through a generic result channel.
  let innerErrors: BridgeError[] | undefined;
  let callbackFailed = false;
  const ran = store.withCommittedRawNonce((rawNonce) => {
    // Validate the raw nonce length bound (16..256) before any use.
    if (rawNonce.length < 16 || rawNonce.length > 256) {
      innerErrors = [
        { code: "state-conflict", message: "Committed raw nonce violates the activation nonce length bound." },
      ];
      return;
    }
    // Verify SHA-256 fingerprint match (mandatory — fingerprint validated above).
    const calculatedFp = fingerprintNonce(rawNonce);
    if (calculatedFp !== state.nonceFingerprint) {
      innerErrors = [
        { code: "state-conflict", message: "Raw nonce does not match committed fingerprint." },
      ];
      return;
    }

    // Safe redaction closure: redacts the raw nonce from later SDK errors
    // without ever exposing it.
    const redact: LaunchSecretRedactor = (text) =>
      text.split(rawNonce).join("[redacted]");

    const overlay: LaunchEnvOverlay = {
      // Port was validated as present/managed above.
      OMO_BRIDGE_PORT: String(state.port),
      OMO_BRIDGE_ACTIVATION_NONCE: rawNonce,
    };

    try {
      callback(overlay, redact);
    } catch {
      callbackFailed = true;
    }
  });

  if (!ran) {
    return {
      ok: false,
      errors: [{ code: "state-conflict", message: "Committed activation state has no raw nonce." }],
    };
  }
  if (innerErrors !== undefined) {
    return { ok: false, errors: innerErrors };
  }
  if (callbackFailed) {
    return {
      ok: false,
      errors: [{ code: "state-conflict", message: "Launch callback execution failed." }],
    };
  }
  return { ok: true, errors: [] };
}
