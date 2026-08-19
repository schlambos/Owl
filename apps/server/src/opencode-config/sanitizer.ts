/**
 * Secret-free extraction of desired provider state from OpenCode config
 * text, plus generic DTO secret-leak detection.
 *
 * The extracted state is a strict allowlist: id, name, options.baseURL,
 * model ids (+ optional model names), blacklist, and root
 * enabled_providers / disabled_providers flags. options.apiKey, whitelist,
 * api, env, headers, and every other options.* field are never copied out.
 */

import { parseConfigText, getAtPath } from "../cfgwrite/jsonc-edit";
import type {
  OpenCodeProviderDesiredEntry,
  OpenCodeProviderDesiredModel,
} from "@omo/shared";

export interface DesiredProviderState {
  providers: OpenCodeProviderDesiredEntry[];
  enabledProviders: string[];
  disabledProviders: string[];
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

/** Provider ids declared under the root `provider` map of a config text. */
export function providerIdsOfConfig(text: string): string[] {
  let doc: Record<string, unknown>;
  try {
    doc = parseConfigText(text);
  } catch {
    return [];
  }
  const providerMap = doc.provider;
  if (!providerMap || typeof providerMap !== "object" || Array.isArray(providerMap)) {
    return [];
  }
  return Object.keys(providerMap as Record<string, unknown>);
}

function sanitizeModels(v: unknown): OpenCodeProviderDesiredModel[] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return [];
  const out: OpenCodeProviderDesiredModel[] = [];
  for (const [mid, mv] of Object.entries(v as Record<string, unknown>)) {
    const m = (mv && typeof mv === "object" && !Array.isArray(mv)
      ? (mv as Record<string, unknown>)
      : {}) as Record<string, unknown>;
    out.push({
      id: mid,
      name: typeof m.name === "string" ? m.name : undefined,
    });
  }
  return out;
}

/**
 * Extract the secret-free desired state from user-level config text.
 * `projectMaskedIds` flags ids also declared in a project-root config.
 */
export function extractDesiredProviderState(
  text: string,
  projectMaskedIds: ReadonlySet<string> = new Set(),
): DesiredProviderState {
  let doc: Record<string, unknown>;
  try {
    doc = parseConfigText(text);
  } catch {
    return { providers: [], enabledProviders: [], disabledProviders: [] };
  }
  const enabled = strArray(doc.enabled_providers);
  const disabled = strArray(doc.disabled_providers);
  const enabledSet = new Set(enabled);
  const disabledSet = new Set(disabled);

  const providers: OpenCodeProviderDesiredEntry[] = [];
  const providerMap = doc.provider;
  if (providerMap && typeof providerMap === "object" && !Array.isArray(providerMap)) {
    for (const [id, raw] of Object.entries(providerMap as Record<string, unknown>)) {
      const p = (raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {}) as Record<string, unknown>;
      // Strict allowlist extraction — baseURL only, never any other options.*.
      const baseURL = getAtPath(p, ["options", "baseURL"]);
      providers.push({
        id,
        inConfig: true,
        custom: true,
        name: typeof p.name === "string" ? p.name : undefined,
        baseURL: typeof baseURL === "string" ? baseURL : undefined,
        models: sanitizeModels(p.models),
        blacklist: strArray(p.blacklist),
        enabled: enabledSet.has(id),
        disabled: disabledSet.has(id),
        enableDisableConflict: enabledSet.has(id) && disabledSet.has(id),
        projectMasked: projectMaskedIds.has(id),
      });
    }
  }
  // Root enablement flags may reference providers not declared in this file.
  for (const id of [...enabledSet, ...disabledSet]) {
    if (providers.some((p) => p.id === id)) continue;
    providers.push({
      id,
      inConfig: false,
      custom: false,
      models: [],
      blacklist: [],
      enabled: enabledSet.has(id),
      disabled: disabledSet.has(id),
      enableDisableConflict: enabledSet.has(id) && disabledSet.has(id),
      projectMasked: projectMaskedIds.has(id),
    });
  }
  return { providers, enabledProviders: enabled, disabledProviders: disabled };
}

// ── DTO secret-leak detection (freeze tests / compositional asserts) ───

/** Lowercased JSON key names that must never appear as DTO object keys. */
const BANNED_KEYS = ["apikey", "key", "env", "options", "headers", "whitelist", "api"];

/**
 * Scan a serialized DTO for banned object keys (matched as `"name":`, so
 * legitimate values like source: "env" / source: "api" are not flagged) or
 * planted secret values anywhere. Returns the offending substrings; empty
 * means clean.
 */
export function findSecretLeaks(serialized: string, secrets: string[]): string[] {
  const leaks: string[] = [];
  for (const key of BANNED_KEYS) {
    const re = new RegExp(`"${key}"\\s*:`, "i");
    if (re.test(serialized)) leaks.push(`"${key}"`);
  }
  for (const secret of secrets) {
    if (secret.length > 0 && serialized.includes(secret)) leaks.push(secret);
  }
  return leaks;
}
