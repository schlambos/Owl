/**
 * HTTP routes for /api/opencode/providers/*.
 *
 * handleProviderManagementRequest returns undefined for paths outside the
 * provider-management namespace so index.ts can continue its route chain.
 * Every response is secret-free by construction: DTOs are allowlisted,
 * errors are sanitized, and request-body keys are consumed in-memory only.
 */

import type {
  OpenCodeProviderApplyRequest,
  OpenCodeProviderCustomSpec,
  OpenCodeProviderMutation,
  OpenCodeProviderOauthAuthorizeRequest,
  OpenCodeProviderOauthCallbackRequest,
  OpenCodeProviderSimulateResponse,
} from "@omo/shared";
import { buildCatalog, buildManage, slimCatalogIds } from "../opencode-providers/catalog";
import { listModels } from "../opencode-providers/model-listing";
import { removeProviderAuth, setProviderAuth } from "../opencode-providers/auth";
import { oauthAuthorize, oauthCallback } from "../opencode-providers/oauth";
import { applyProviderEffect } from "../opencode-providers/apply-effect";
import type { CompositionPaths } from "../opencode-providers/catalog";
import type { OpenCodeClient } from "../opencode/client";
import type { OpenCodeLifecycleManager } from "../opencode/lifecycle";
import type { OpenCodeConfigWriter } from "./writer";

export interface ProviderManagementRouteDeps {
  paths: CompositionPaths;
  /** Canonical client accessor; throws when no backend is active. */
  getClient: () => OpenCodeClient;
  writer: OpenCodeConfigWriter;
  lifecycle: OpenCodeLifecycleManager;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

const PROVIDER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const ROUTE_PREFIX = "/api/opencode/providers";

function errorDto(status: number, code: string, message: string): Response {
  return json({ ok: false, errors: [{ code, message }] }, status);
}

async function readBody(req: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await req.text();
    if (!text.trim()) return undefined;
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function parseMutation(v: unknown): OpenCodeProviderMutation | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const m = v as Record<string, unknown>;
  switch (m.kind) {
    case "add-custom": {
      const p = m.provider;
      if (!p || typeof p !== "object" || Array.isArray(p)) return undefined;
      const c = p as Record<string, unknown>;
      if (typeof c.id !== "string" || typeof c.name !== "string" || typeof c.baseURL !== "string") {
        return undefined;
      }
      if (!Array.isArray(c.models)) return undefined;
      return { kind: "add-custom", provider: p as unknown as OpenCodeProviderCustomSpec };
    }
    case "set-blacklist": {
      if (typeof m.providerId !== "string" || !PROVIDER_ID_RE.test(m.providerId)) return undefined;
      if (!Array.isArray(m.blacklist)) return undefined;
      const blacklist = (m.blacklist as unknown[]).filter((x): x is string => typeof x === "string");
      return { kind: "set-blacklist", providerId: m.providerId, blacklist };
    }
    case "set-enablement": {
      if (typeof m.providerId !== "string" || !PROVIDER_ID_RE.test(m.providerId)) return undefined;
      if (typeof m.enabled !== "boolean") return undefined;
      return { kind: "set-enablement", providerId: m.providerId, enabled: m.enabled };
    }
    default:
      return undefined;
  }
}

export async function handleProviderManagementRequest(
  req: Request,
  url: URL,
  deps: ProviderManagementRouteDeps,
): Promise<Response | undefined> {
  if (url.pathname !== ROUTE_PREFIX && !url.pathname.startsWith(`${ROUTE_PREFIX}/`)) {
    return undefined;
  }
  const sub = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\//, "");

  // GET /catalog
  if (sub === "catalog" && req.method === "GET") {
    return json(await buildCatalog(deps.getClient));
  }

  // GET /manage
  if (sub === "manage" && req.method === "GET") {
    return json(await buildManage(deps.paths, deps.getClient));
  }

  // POST /models/list (server-only SSRF-guarded fetch)
  if (sub === "models/list" && req.method === "POST") {
    const body = await readBody(req);
    const baseURL = body?.baseURL;
    if (typeof baseURL !== "string" || baseURL.length === 0) {
      return errorDto(400, "request-invalid", "baseURL is required.");
    }
    const apiKey = typeof body?.apiKey === "string" ? body.apiKey : undefined;
    const result = await listModels(baseURL, apiKey);
    return json(result, result.ok ? 200 : result.error?.code === "ssrf-blocked" ? 403 : 502);
  }

  // POST /simulate (sanitized preview only)
  if (sub === "simulate" && req.method === "POST") {
    const body = await readBody(req);
    const mutation = parseMutation(body?.mutation);
    if (!mutation) return errorDto(400, "request-invalid", "mutation is required and must be a supported provider mutation.");
    const catalogIds = await slimCatalogIds(deps.getClient).catch(() => new Set<string>());
    const result = await deps.writer.simulate({ mutation, slimCatalogIds: catalogIds });
    const dto: OpenCodeProviderSimulateResponse = result;
    return json(dto, result.ok ? 200 : 400);
  }

  // POST /apply
  if (sub === "apply" && req.method === "POST") {
    const body = await readBody(req);
    const mutation = parseMutation(body?.mutation);
    if (!mutation) return errorDto(400, "request-invalid", "mutation is required and must be a supported provider mutation.");
    const expectedSourceHash =
      typeof body?.expectedSourceHash === "string" && body.expectedSourceHash.length > 0
        ? body.expectedSourceHash
        : undefined;
    const auth =
      body?.auth && typeof body.auth === "object" && !Array.isArray(body.auth) &&
      typeof (body.auth as Record<string, unknown>).apiKey === "string"
        ? { apiKey: String((body.auth as Record<string, unknown>).apiKey) }
        : undefined;
    const applyReq: OpenCodeProviderApplyRequest = {
      mutation,
      ...(expectedSourceHash !== undefined ? { expectedSourceHash } : {}),
      ...(auth !== undefined ? { auth } : {}),
      ...(body?.restart === true ? { restart: true } : {}),
    };
    const { response, status } = await applyProviderEffect(
      {
        writer: deps.writer,
        getClient: deps.getClient,
        lifecycle: deps.lifecycle,
        slimCatalogIds: () => slimCatalogIds(deps.getClient),
      },
      applyReq,
    );
    return json(response, status);
  }

  // /:id/auth and /:id/oauth/*
  const authMatch = /^([^/]+)\/auth$/.exec(sub);
  if (authMatch) {
    const providerId = decodeURIComponent(authMatch[1]!);
    if (!PROVIDER_ID_RE.test(providerId)) {
      return errorDto(400, "provider-id-invalid", "Provider id is invalid.");
    }
    if (req.method === "PUT") {
      const body = await readBody(req);
      const key = body?.key;
      if (typeof key !== "string" || key.length === 0) {
        return errorDto(400, "request-invalid", "key is required.");
      }
      const result = await setProviderAuth(deps.getClient, providerId, key);
      return json(result, result.ok ? 200 : 502);
    }
    if (req.method === "DELETE") {
      const result = await removeProviderAuth(deps.getClient, providerId);
      return json(result, result.ok ? 200 : 502);
    }
    return errorDto(405, "method-not-allowed", "Method not allowed.");
  }

  const oauthAuthorizeMatch = /^([^/]+)\/oauth\/authorize$/.exec(sub);
  if (oauthAuthorizeMatch && req.method === "POST") {
    const providerId = decodeURIComponent(oauthAuthorizeMatch[1]!);
    if (!PROVIDER_ID_RE.test(providerId)) {
      return errorDto(400, "provider-id-invalid", "Provider id is invalid.");
    }
    const body = (await readBody(req)) as unknown as OpenCodeProviderOauthAuthorizeRequest | undefined;
    if (!body || typeof body.method !== "number") {
      return errorDto(400, "request-invalid", "method is required.");
    }
    const inputs =
      body.inputs && typeof body.inputs === "object" && !Array.isArray(body.inputs)
        ? Object.fromEntries(
            Object.entries(body.inputs).filter(([, v]) => typeof v === "string"),
          ) as Record<string, string>
        : undefined;
    const result = await oauthAuthorize(deps.getClient, providerId, {
      method: body.method,
      ...(inputs !== undefined ? { inputs } : {}),
    });
    return json(result, result.ok ? 200 : 502);
  }

  const oauthCallbackMatch = /^([^/]+)\/oauth\/callback$/.exec(sub);
  if (oauthCallbackMatch && req.method === "POST") {
    const providerId = decodeURIComponent(oauthCallbackMatch[1]!);
    if (!PROVIDER_ID_RE.test(providerId)) {
      return errorDto(400, "provider-id-invalid", "Provider id is invalid.");
    }
    const body = (await readBody(req)) as unknown as OpenCodeProviderOauthCallbackRequest | undefined;
    if (!body || typeof body.method !== "number") {
      return errorDto(400, "request-invalid", "method is required.");
    }
    const result = await oauthCallback(deps.getClient, providerId, {
      method: body.method,
      ...(typeof body.code === "string" ? { code: body.code } : {}),
    });
    return json(result, result.ok ? 200 : 502);
  }

  // Under the prefix but unmatched: treat as not-found within the namespace.
  if (url.pathname.startsWith(`${ROUTE_PREFIX}/`)) {
    return errorDto(404, "not-found", "Unknown provider management route.");
  }
  return undefined;
}
