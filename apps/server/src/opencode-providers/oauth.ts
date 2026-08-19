/**
 * Native provider OAuth helpers: REST-only forwarding with allowlisted
 * responses. Never logs or echoes inputs verbatim beyond the declared
 * response allowlist (url, method, instructions).
 */

import type {
  OpenCodeProviderOauthAuthorizeResponse,
  OpenCodeProviderOauthCallbackResponse,
} from "@omo/shared";
import type { ClientProvider } from "./types";

export async function oauthAuthorize(
  getClient: ClientProvider,
  providerId: string,
  req: { method: number; inputs?: Record<string, string> },
): Promise<OpenCodeProviderOauthAuthorizeResponse> {
  if (!Number.isInteger(req.method) || req.method < 0) {
    return { ok: false, error: { code: "oauth-invalid", message: "OAuth method index is invalid." } };
  }
  try {
    const r = await getClient().providerOauthAuthorize(providerId, {
      method: req.method,
      ...(req.inputs !== undefined ? { inputs: req.inputs } : {}),
    });
    return {
      ok: true,
      url: r.url,
      method: r.method,
      instructions: r.instructions,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "OAuth authorize failed.";
    return { ok: false, error: { code: "oauth-failed", message: msg } };
  }
}

export async function oauthCallback(
  getClient: ClientProvider,
  providerId: string,
  req: { method: number; code?: string },
): Promise<OpenCodeProviderOauthCallbackResponse> {
  if (!Number.isInteger(req.method) || req.method < 0) {
    return { ok: false, error: { code: "oauth-invalid", message: "OAuth method index is invalid." } };
  }
  try {
    await getClient().providerOauthCallback(providerId, {
      method: req.method,
      ...(req.code !== undefined ? { code: req.code } : {}),
    });
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "OAuth callback failed.";
    return { ok: false, error: { code: "oauth-failed", message: msg } };
  }
}
