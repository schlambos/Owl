/**
 * Native provider auth (REST auth only): thin secret-safe wrappers over
 * the canonical OpenCode client. The API key exists only in the request
 * scope; wrappers return secret-free outcomes and never echo backend
 * bodies verbatim.
 */

import type { OpenCodeProviderAuthResponse } from "@omo/shared";
import type { ClientProvider } from "./types";

function fail(message: string): OpenCodeProviderAuthResponse {
  return { ok: false, error: { code: "auth-failed", message } };
}

/** auth.set → PUT /auth/{providerID}. */
export async function setProviderAuth(
  getClient: ClientProvider,
  providerId: string,
  key: string,
): Promise<OpenCodeProviderAuthResponse> {
  try {
    await getClient().authSet(providerId, key);
    return { ok: true };
  } catch (e) {
    // The client already sanitized with the key as a redaction needle.
    const msg = e instanceof Error ? e.message : "Provider auth set failed.";
    return fail(msg);
  }
}

/** auth.remove → DELETE /auth/{providerID}. */
export async function removeProviderAuth(
  getClient: ClientProvider,
  providerId: string,
): Promise<OpenCodeProviderAuthResponse> {
  try {
    await getClient().authRemove(providerId);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Provider auth removal failed.";
    return fail(msg);
  }
}
