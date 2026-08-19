/**
 * Path helpers for OpenCode provider-management writes.
 *
 * The write target is always a user-level OpenCode config (config-dir)
 * opencode.json / opencode.jsonc. Project-root configs are never written
 * and a competing config-dir file is never created to mask a project one.
 * First-create (no config-dir AND no project-root candidates anywhere) is
 * the only path to `{OPENCODE_CONFIG_DIR}/opencode.jsonc`.
 */

import { join } from "node:path";

/** Conventional candidate filenames, in resolver order. */
export const OPENCODE_CONFIG_BASENAMES = ["opencode.json", "opencode.jsonc"] as const;

/** First-create path for a brand-new user-level config. */
export function firstCreateConfigPath(opencodeConfigDir: string): string {
  return join(opencodeConfigDir, "opencode.jsonc");
}
