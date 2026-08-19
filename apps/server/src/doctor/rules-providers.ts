/**
 * Doctor rules for OpenCode provider management.
 *
 * Secret-free, pure mapping from input.providerManagement (composed in
 * index.ts). Enablement flags are CONTROL-PLANE interpretations of the
 * root enabled_providers / disabled_providers arrays (disabled wins) —
 * never a claimed OpenCode merge semantics. Registered from engine.ts.
 */

import type { Diagnostic } from "./types";
import type { DoctorInput } from "./input";
import type { RuleContext } from "./rules-core";

type Entry = NonNullable<DoctorInput["providerManagement"]>["entries"][number];

export function providerManagementRules(input: DoctorInput, _ctx: RuleContext): Diagnostic[] {
  const pm = input.providerManagement;
  if (!pm) return [];
  const out: Diagnostic[] = [];

  for (const e of pm.entries) {
    if (e.blacklistedActiveModel) {
      out.push(diag(e, "blacklisted-active-model", "error",
        `Active model is blacklisted`,
        `The default model for "${e.id}" is in the provider blacklist; sessions using the default will fail. Remove it from the blacklist or change the default model.`));
    }
    if (e.disabled && e.connected) {
      out.push(diag(e, "disabled-active-provider", "warning",
        `Provider disabled but still active`,
        `"${e.id}" is disabled in the control-plane config (disabled wins) but still reports connected on the live backend.`));
    }
    if (e.enableDisableConflict) {
      out.push(diag(e, "enable-disable-conflict", "warning",
        `Provider in enabled and disabled lists`,
        `"${e.id}" appears in both enabled_providers and disabled_providers; control-plane interpretation treats disabled as winning. Resolve the conflict.`));
    }
    if (e.authMissing) {
      out.push(diag(e, "auth-missing", "info",
        `Provider not authenticated`,
        `"${e.id}" is configured but not connected on the live backend; authentication is likely missing. Set auth via REST (PUT /auth or OAuth).`));
    }
    if (e.desiredNotLive) {
      out.push(diag(e, "desired-not-live", "info",
        `Desired provider not live`,
        `"${e.id}" is declared in the user-level config but absent from the live provider catalog. A restart of the owned backend may be required.`));
    }
    if (e.externalConfigDrift) {
      out.push(diag(e, "external-config-drift", "warning",
        `User-level config drifted externally`,
        `The OpenCode user-level config changed outside provider management since the last managed write. Review before applying further edits.`));
    }
    if (e.projectMasked) {
      out.push(diag(e, "project-masked", "info",
        `Provider masked by project config`,
        `"${e.id}" is also declared in the project-root OpenCode config, which masks user-level edits. Manage it in the project config directly.`));
    }
  }
  return out;
}

function diag(
  e: Entry,
  rule: string,
  severity: Diagnostic["severity"],
  title: string,
  summary: string,
): Diagnostic {
  return {
    id: `provider.${e.id}.${rule}`,
    category: "providers",
    severity,
    title,
    summary,
    entityType: "provider",
    entityId: e.id,
  };
}
