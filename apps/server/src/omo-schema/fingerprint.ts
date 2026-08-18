/**
 * Authorized OMO user/project source fingerprints (Slice 18 D0 groundwork).
 *
 * Reads only logical user/project OMO JSON/JSONC targets under authorized
 * roots. Never accepts client-supplied filesystem paths. Does not inspect
 * Interview output destinations.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import type { OmoScope, SourceFingerprint } from "@omo/shared";
import type { ServerConfig } from "../config";
import { assertAuthorizedPath } from "../config";
import { hashContent } from "../cfgwrite/jsonc-edit";
import { resolveWriteTarget } from "../cfgwrite/paths";

export function fingerprintAuthorizedSource(
  cfg: ServerConfig,
  scope: OmoScope,
  generation = 0,
): SourceFingerprint {
  const target = resolveWriteTarget(cfg, scope);
  if (!target.exists || !existsSync(target.path)) {
    return {
      exists: false,
      sha256: null,
      format: target.format,
      mtimeMs: null,
      generation,
    };
  }
  assertAuthorizedPath(target.path, cfg.authorizedRoots);
  const text = readFileSync(target.path, "utf-8");
  const st = statSync(target.path);
  return {
    exists: true,
    sha256: hashContent(text),
    format: target.format,
    mtimeMs: st.mtimeMs,
    generation,
  };
}
