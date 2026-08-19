/**
 * Server-only OpenAI-compatible /v1/models listing with SSRF guards.
 *
 *  - http/https only, no credentials in the URL.
 *  - Rejected networks: 10/8, 172.16/12, 192.168/16, 127/8 (except explicit
 *    user loopback), 169.254/16, ::1, fc00::/7.
 *  - 5s timeout, 1 MiB body cap.
 *  - The Authorization header (when a key is supplied) exists in memory
 *    only for the request. URL queries, headers, and bodies are NEVER
 *    logged or surfaced in errors.
 *  - This is a raw model listing, NOT an entitlement probe — the probe
 *    engine is never invoked.
 */

import { lookup } from "node:dns/promises";
import type {
  OpenCodeProviderListedModel,
  OpenCodeProviderModelListResponse,
} from "@omo/shared";

const TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

export interface ModelListDeps {
  fetchImpl?: typeof fetch;
  lookupImpl?: typeof lookup;
}

function fail(code: string, message: string): OpenCodeProviderModelListResponse {
  return { ok: false, models: [], error: { code, message } };
}

function isPrivateV4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const a = parts[0]!;
  const b = parts[1]!;
  if (a === 10) return true; // 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 169 && b === 254) return true; // 169.254/16
  if (a === 0) return true; // 0/8
  return false;
}

function isLoopbackV4(ip: string): boolean {
  return ip.split(".").map(Number)[0] === 127;
}

function isBlockedV6(ip: string): boolean {
  const norm = ip.toLowerCase();
  if (norm === "::1" || norm === "0:0:0:0:0:0:0:1") return true; // ::1
  // fc00::/7 → first hextet 0xfc00..0xfdff
  const first = norm.split(":")[0] ?? "";
  const firstNum = parseInt(first || "0", 16);
  if (Number.isFinite(firstNum) && firstNum >= 0xfc00 && firstNum <= 0xfdff) return true;
  if (norm === "::" ) return true; // unspecified
  return false;
}

function isV4Literal(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * Validate the base URL and resolve its host. Explicit user loopback
 * (127/8, e.g. a local LiteLLM/Ollama proxy intentionally pointed at
 * loopback) is permitted; every other listed private/link-local range is
 * rejected.
 */
async function validateBaseUrl(
  raw: string,
  lookupImpl: typeof lookup,
): Promise<{ ok: true; url: URL } | { ok: false; reason: string }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "baseURL is not a valid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "baseURL must use http or https." };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "baseURL must not embed credentials." };
  }
  let host = url.hostname;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);

  const checkIp = (ip: string): string | null => {
    if (isV4Literal(ip)) {
      if (isLoopbackV4(ip)) return null; // explicit user loopback allowed
      if (isPrivateV4(ip)) return "baseURL target network is not permitted.";
      return null;
    }
    if (isBlockedV6(ip)) return "baseURL target network is not permitted.";
    return null;
  };

  if (isV4Literal(host) || host.includes(":")) {
    const blocked = checkIp(host);
    if (blocked) return { ok: false, reason: blocked };
    return { ok: true, url };
  }

  // Hostname: DNS-resolve and validate EVERY address (no TOCTOU fetch of
  // a re-resolving name — the connect below uses the same lookup).
  let addresses;
  try {
    addresses = await lookupImpl(host, { all: true, verbatim: true });
  } catch {
    return { ok: false, reason: "baseURL host does not resolve." };
  }
  for (const addr of addresses) {
    const blocked = checkIp(addr.address);
    if (blocked) return { ok: false, reason: blocked };
  }
  return { ok: true, url };
}

/**
 * GET {baseURL}/v1/models. Returns the normalized allowlisted model list.
 */
export async function listModels(
  baseURL: string,
  apiKey: string | undefined,
  deps: ModelListDeps = {},
): Promise<OpenCodeProviderModelListResponse> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const lookupImpl = deps.lookupImpl ?? lookup;

  const validated = await validateBaseUrl(baseURL, lookupImpl);
  if (!validated.ok) return fail("ssrf-blocked", validated.reason);

  const modelsUrl = new URL(validated.url.toString());
  const basePath = modelsUrl.pathname.replace(/\/+$/, "");
  modelsUrl.pathname = `${basePath}/v1/models`;
  // Query strings of user baseURL are never forwarded/logged.
  modelsUrl.search = "";
  const target = modelsUrl.toString();

  const headers = new Headers({ Accept: "application/json" });
  // Authorization header in memory only; never logged or echoed.
  if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);

  let res: Response;
  try {
    res = await fetchImpl(target, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
  } catch {
    return fail("request-failed", "Model list request failed or timed out.");
  }

  if (!res.ok) {
    // Discard the body; status only.
    try {
      await res.arrayBuffer();
    } catch {
      /* */
    }
    return fail("request-failed", `Model list request returned HTTP ${res.status}.`);
  }

  // Body cap: 1 MiB.
  let text: string;
  try {
    if (res.body) {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BODY_BYTES) {
          await reader.cancel();
          return fail("response-too-large", "Model list response exceeded the 1 MiB cap.");
        }
        chunks.push(value);
      }
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.byteLength;
      }
      text = new TextDecoder().decode(merged);
    } else {
      text = await res.text();
      if (text.length > MAX_BODY_BYTES) {
        return fail("response-too-large", "Model list response exceeded the 1 MiB cap.");
      }
    }
  } catch {
    return fail("request-failed", "Model list response read failed.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("parse-failed", "Model list response was not JSON.");
  }

  // OpenAI /v1/models shape: { data: [{ id, ... }] }. Some proxies return
  // { models: [...] } — tolerate both, emit the allowlist only.
  const root = (parsed ?? {}) as Record<string, unknown>;
  const list = Array.isArray(root.data)
    ? root.data
    : Array.isArray(root.models)
      ? root.models
      : undefined;
  if (!list) {
    return fail("parse-failed", "Model list response had no model array.");
  }
  const models: OpenCodeProviderListedModel[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const m = item as Record<string, unknown>;
    const id = typeof m.id === "string" ? m.id : typeof m.name === "string" ? m.name : undefined;
    if (!id) continue;
    models.push({
      id,
      name: typeof m.name === "string" && m.name !== id ? m.name : undefined,
    });
  }
  return { ok: true, models };
}
