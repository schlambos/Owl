/**
 * OpenAI-compatible custom provider adapter.
 *
 * Custom adds are OpenAI-compatible ONLY (no Anthropic custom adapter).
 * The produced config value is the exact OpenCode custom-provider shape
 * for ai-sdk OpenAI-compatible (or plain OpenAI) packages. The adapter
 * refuses any secret-bearing or unsupported request fields — options
 * other than baseURL, whitelist, and api are never emitted.
 */

import type {
  OpenCodeProviderCustomNpm,
  OpenCodeProviderCustomSpec,
} from "@omo/shared";

const SUPPORTED_NPM: readonly OpenCodeProviderCustomNpm[] = [
  "@ai-sdk/openai-compatible",
  "@ai-sdk/openai",
];

const MODEL_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/;

/**
 * Build the exact custom provider value for provider.<id>. Throws with a
 * redacted shape message on invalid input. Never includes api, whitelist,
 * options.apiKey, or any options.* other than baseURL.
 */
export function buildCustomProviderValue(
  spec: OpenCodeProviderCustomSpec,
): Record<string, unknown> {
  if (typeof spec.id !== "string" || spec.id.length === 0) {
    throw new Error("Custom provider requires an id.");
  }
  if (typeof spec.name !== "string" || spec.name.trim().length === 0) {
    throw new Error("Custom provider requires a display name.");
  }
  if (typeof spec.baseURL !== "string" || !/^https?:\/\//i.test(spec.baseURL)) {
    throw new Error("Custom provider requires an http(s) baseURL.");
  }
  const npm: OpenCodeProviderCustomNpm =
    spec.npm !== undefined && SUPPORTED_NPM.includes(spec.npm)
      ? spec.npm
      : "@ai-sdk/openai-compatible";

  // Refuse unsupported/secret-bearing speculative fields on the request.
  const rogue = spec as unknown as Record<string, unknown>;
  for (const banned of ["apiKey", "whitelist", "api", "options", "headers", "env"]) {
    if (Object.prototype.hasOwnProperty.call(rogue, banned)) {
      throw new Error(`Custom provider must not carry "${banned}".`);
    }
  }

  const models: Record<string, unknown> = {};
  for (const m of spec.models ?? []) {
    if (!MODEL_ID_RE.test(m.id)) {
      throw new Error("Custom provider model id is invalid.");
    }
    if (m.name !== undefined && typeof m.name !== "string") {
      throw new Error("Custom provider model name is invalid.");
    }
    models[m.id] = m.name !== undefined ? { id: m.id, name: m.name } : {};
  }
  if (Object.keys(models).length === 0) {
    throw new Error("Custom provider requires at least one model.");
  }

  const blacklist = [...new Set((spec.blacklist ?? []).filter((x) => typeof x === "string" && x.length > 0))];

  const value: Record<string, unknown> = {
    npm,
    name: spec.name,
    options: { baseURL: spec.baseURL },
    models,
  };
  // blacklist = unticked ids; omit the key entirely when none.
  if (blacklist.length > 0) value.blacklist = blacklist;
  return value;
}
