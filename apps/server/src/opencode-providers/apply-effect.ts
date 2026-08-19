/**
 * Apply effect orchestration for OpenCode provider management.
 *
 * Order: config write (writer.apply) → PUT /auth against the CURRENT Live
 * backend (or OAuth, handled by separate routes) → owned restart if
 * requested AND owned.
 *
 * Auth failure = partial apply: NO rollback of the committed config write;
 * the error is secret-free (client sanitizes with the key as a redaction
 * needle). Restart is delegated to restartForOwnedConfigApply, which
 * rejects attach / managed+external without process action (Desired write
 * stands; the warning is surfaced).
 */

import type {
  OpenCodeProviderApplyRequest,
  OpenCodeProviderApplyResponse,
} from "@omo/shared";
import type { OpenCodeConfigWriter } from "../opencode-config/writer";
import { mutationProviderId } from "../opencode-config/mutations";
import { sanitizeOpenCodeError } from "../opencode/security";
import type { OpenCodeLifecycleManager } from "../opencode/lifecycle";
import type { ClientProvider } from "./types";

export interface ApplyEffectDeps {
  writer: OpenCodeConfigWriter;
  getClient: ClientProvider;
  lifecycle: OpenCodeLifecycleManager;
  slimCatalogIds: () => Promise<Set<string>>;
}

export async function applyProviderEffect(
  deps: ApplyEffectDeps,
  req: OpenCodeProviderApplyRequest,
): Promise<{ response: OpenCodeProviderApplyResponse; status: number }> {
  const catalogIds = await deps.slimCatalogIds().catch(() => new Set<string>());

  const written = await deps.writer.apply({
    mutation: req.mutation,
    expectedSourceHash: req.expectedSourceHash,
    slimCatalogIds: catalogIds,
  });
  if (!written.ok) {
    return {
      status: written.status,
      response: { ok: false, errors: written.errors },
    };
  }

  const providerId = mutationProviderId(req.mutation);

  // PUT /auth against the current Live backend (only when a key was
  // supplied in the request — in-memory, never persisted or revisioned).
  let authApplied: boolean | undefined;
  let authError: string | undefined;
  if (req.auth && typeof req.auth.apiKey === "string" && req.auth.apiKey.length > 0) {
    try {
      await deps.getClient().authSet(providerId, req.auth.apiKey);
      authApplied = true;
    } catch (e) {
      // Partial apply, no rollback. Secret-free: sanitize with the key.
      authApplied = false;
      authError = sanitizeOpenCodeError(e, [req.auth.apiKey]);
    }
  }

  // Owned restart — only when requested; attach/external get a warning via
  // the lifecycle's rejection (no process action; Desired stands).
  let restart: OpenCodeProviderApplyResponse["restart"];
  if (req.restart === true) {
    const r = await deps.lifecycle.restartForOwnedConfigApply();
    restart = {
      requested: true,
      performed: r.ok,
      ok: r.ok,
      code: r.code,
      message: r.message,
    };
  }

  return {
    status: 200,
    response: {
      ok: true,
      revisionId: written.revisionId,
      targetPath: written.targetPath,
      baselineHash: written.baselineHash,
      postWriteHash: written.postWriteHash,
      ...(authApplied !== undefined ? { authApplied } : {}),
      ...(authError !== undefined ? { authError } : {}),
      ...(restart !== undefined ? { restart } : {}),
      errors: [],
    },
  };
}
