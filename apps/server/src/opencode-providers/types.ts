/**
 * Server-internal types for OpenCode provider management. Shared DTOs
 * live in @omo/shared; this module carries composition seams only.
 */

import type { LiveProvider } from "@omo/shared";
import type { OpenCodeClient } from "../opencode/client";

/** Live join inputs (already normalized through the existing allowlist). */
export interface LiveProviderJoin {
  providers: LiveProvider[];
  connected: string[];
  /** Model defaults from the cached GET /provider authority. */
  defaults: Record<string, string>;
}

/**
 * Accessor for the CURRENT canonical OpenCode client. Throws when no
 * backend is active; callers convert failures to secret-free issues.
 */
export type ClientProvider = () => OpenCodeClient;
