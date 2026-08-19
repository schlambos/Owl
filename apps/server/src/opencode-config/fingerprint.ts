/**
 * Content fingerprints + authorized reads for user-level OpenCode configs.
 */

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { hashContent } from "../cfgwrite/jsonc-edit";
import { isWithinRoots, realpathRoots } from "../opencode-bridge/canonical";

export { hashContent };

export interface AuthorizedRead {
  path: string;
  text: string;
  hash: string;
}

/**
 * Read a config file under authorized roots with symlink-escape rejection.
 * Returns undefined when the file is absent; throws with a stable
 * redacted message on unauthorized/escape paths.
 */
export function readAuthorizedConfig(
  path: string,
  authorizedRoots: string[],
): AuthorizedRead | undefined {
  const roots = realpathRoots(authorizedRoots);
  if (!isWithinRoots(path, roots)) {
    throw new Error("Config path outside authorized roots — rejected.");
  }
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    const real = realpathSync(path);
    if (!isWithinRoots(real, roots)) {
      throw new Error("Config file is a symlink escaping authorized roots — rejected.");
    }
    path = real;
  }
  const text = readFileSync(path, "utf-8");
  return { path, text, hash: hashContent(text) };
}
