/**
 * Provider mutation producers for opencode.json / opencode.jsonc.
 *
 * Every edit is a narrow jsonc-parser path edit (modify + applyEdits via
 * applyJsoncPathEdit): unknown keys, comments, EOL, and the plugin array
 * are preserved byte-for-byte. The custom add shape is exact:
 *
 *   provider.<id> = {
 *     npm: "@ai-sdk/openai-compatible" | "@ai-sdk/openai",
 *     name,
 *     options: { baseURL },
 *     models: { [id]: {} | { id, name? } },
 *     blacklist?: string[]
 *   }
 *
 * Never written: api, whitelist, options.apiKey, or any other options.*.
 * blacklist = unticked ids; the key is omitted when empty.
 */

import type {
  OpenCodeProviderCustomSpec,
  OpenCodeProviderMutation,
} from "@omo/shared";
import { applyJsoncPathEdit, getAtPath, parseConfigText } from "../cfgwrite/jsonc-edit";
import { buildCustomProviderValue } from "../opencode-providers/openai-compatible";

export interface MutationFailure {
  code: string;
  message: string;
}

export type MutationResult =
  | { ok: true; text: string; summary: Record<string, unknown> }
  | { ok: false; error: MutationFailure };

const PROVIDER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function fail(code: string, message: string): MutationResult {
  return { ok: false, error: { code, message } };
}

function parseOrFail(text: string): { ok: true; doc: Record<string, unknown> } | { ok: false; error: MutationFailure } {
  try {
    return { ok: true, doc: parseConfigText(text) };
  } catch {
    return { ok: false, error: { code: "source-unproven", message: "Config text does not parse." } };
  }
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

// ── Custom add ─────────────────────────────────────────────────────────

function applyAddCustom(
  text: string,
  spec: OpenCodeProviderCustomSpec,
  slimCatalogIds: ReadonlySet<string>,
): MutationResult {
  if (!PROVIDER_ID_RE.test(spec.id)) {
    return fail("provider-id-invalid", "Provider id must be alphanumeric with optional . _ - characters.");
  }
  if (slimCatalogIds.has(spec.id)) {
    return fail("provider-id-collision", "Provider id collides with a known slim catalog provider id.");
  }
  const parsed = parseOrFail(text);
  if (!parsed.ok) return parsed;
  const existing = getAtPath(parsed.doc, ["provider"]);
  if (existing !== undefined) {
    if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
      return fail("plugin-shape-unsupported", "Root provider property exists but is not an object.");
    }
    if (Object.prototype.hasOwnProperty.call(existing, spec.id)) {
      return fail("provider-id-collision", "Provider id already exists in the config provider map.");
    }
  }

  let built: Record<string, unknown>;
  try {
    built = buildCustomProviderValue(spec);
  } catch (e) {
    return fail("shape-invalid", e instanceof Error ? e.message : "Custom provider shape invalid.");
  }

  // Extra defense-in-depth at the write boundary: the built value must
  // never carry banned keys even if inputs were crafted adversarially.
  const serialized = JSON.stringify(built);
  for (const banned of ['"apiKey"', '"whitelist"', '"api"']) {
    if (serialized.includes(banned)) {
      return fail("shape-invalid", "Refusing to write a secret-bearing or unsupported provider key.");
    }
  }

  const next = applyJsoncPathEdit(text, ["provider", spec.id], built);
  const summary: Record<string, unknown> = {
    operation: "provider-added",
    providerId: spec.id,
    npm: built.npm,
    modelCount: Object.keys(built.models as Record<string, unknown>).length,
    blacklistCount: Array.isArray(built.blacklist) ? (built.blacklist as unknown[]).length : 0,
  };
  return { ok: true, text: next, summary };
}

// ── Blacklist ──────────────────────────────────────────────────────────

function applySetBlacklist(text: string, providerId: string, blacklist: string[]): MutationResult {
  if (!PROVIDER_ID_RE.test(providerId)) {
    return fail("provider-id-invalid", "Provider id must be alphanumeric with optional . _ - characters.");
  }
  const parsed = parseOrFail(text);
  if (!parsed.ok) return parsed;
  const provider = getAtPath(parsed.doc, ["provider", providerId]);
  const deduped = [...new Set(blacklist)].filter((x) => typeof x === "string" && x.length > 0);
  if (provider === undefined) {
    // Native provider (auth via REST only): a later blacklist edit is the
    // ONLY case a provider.<id> key is written for it. Creating { blacklist }
    // for a native id is unsupported when the blacklist itself is empty.
    if (deduped.length === 0) {
      return fail("provider-not-found", "Provider is not declared in the user-level config and no blacklist ids were given.");
    }
    const next = applyJsoncPathEdit(text, ["provider", providerId], { blacklist: deduped });
    return {
      ok: true,
      text: next,
      summary: { operation: "provider-blacklist", providerId, blacklistCount: deduped.length },
    };
  }
  if (typeof provider !== "object" || provider === null || Array.isArray(provider)) {
    return fail("plugin-shape-unsupported", "Provider entry is not an object; blacklist edit unsupported.");
  }
  // Narrow path edit of provider.<id>.blacklist only — every other key
  // (including externally managed fields) is preserved byte-for-byte.
  const next = applyJsoncPathEdit(
    text,
    ["provider", providerId, "blacklist"],
    deduped.length ? deduped : undefined,
  );
  return {
    ok: true,
    text: next,
    summary: { operation: "provider-blacklist", providerId, blacklistCount: deduped.length },
  };
}

// ── Enablement (root enabled_providers / disabled_providers only) ──────

function applySetEnablement(text: string, providerId: string, enabled: boolean): MutationResult {
  if (!PROVIDER_ID_RE.test(providerId)) {
    return fail("provider-id-invalid", "Provider id must be alphanumeric with optional . _ - characters.");
  }
  const parsed = parseOrFail(text);
  if (!parsed.ok) return parsed;
  const currentEnabled = strArray(parsed.doc.enabled_providers);
  const currentDisabled = strArray(parsed.doc.disabled_providers);

  const enabledSet = new Set(currentEnabled);
  const disabledSet = new Set(currentDisabled);
  if (enabled) {
    enabledSet.add(providerId);
    disabledSet.delete(providerId);
  } else {
    disabledSet.add(providerId);
    enabledSet.delete(providerId);
  }

  let next = applyJsoncPathEdit(
    text,
    ["enabled_providers"],
    enabledSet.size ? [...enabledSet] : undefined,
  );
  next = applyJsoncPathEdit(
    next,
    ["disabled_providers"],
    disabledSet.size ? [...disabledSet] : undefined,
  );
  return {
    ok: true,
    text: next,
    summary: { operation: "provider-enablement", providerId, enabled },
  };
}

// ── Dispatch ───────────────────────────────────────────────────────────

/**
 * Apply a provider mutation to config text. `slimCatalogIds` is the slim
 * provider catalog id set used for add-custom collision rejection.
 */
export function applyProviderMutationText(
  text: string,
  mutation: OpenCodeProviderMutation,
  slimCatalogIds: ReadonlySet<string> = new Set(),
): MutationResult {
  switch (mutation.kind) {
    case "add-custom":
      return applyAddCustom(text, mutation.provider, slimCatalogIds);
    case "set-blacklist":
      return applySetBlacklist(text, mutation.providerId, mutation.blacklist);
    case "set-enablement":
      return applySetEnablement(text, mutation.providerId, mutation.enabled);
  }
}

/** Provider id targeted by a mutation (for downstream auth/revision steps). */
export function mutationProviderId(mutation: OpenCodeProviderMutation): string {
  return mutation.kind === "add-custom" ? mutation.provider.id : mutation.providerId;
}
