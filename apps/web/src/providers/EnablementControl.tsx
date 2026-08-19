/**
 * EnablementControl — enabled/disabled switch for a provider. Defaults: on
 * unless the user-level config lists the provider in disabled_providers;
 * a provider listed in both arrays shows the conflict warning (disabled
 * wins). Toggling opens the shared simulate → apply flow inline.
 */
import { useState } from "react";
import type { OpenCodeProviderWriteTarget } from "@omo/shared";
import { Switch } from "../pages/system/SystemPrimitives";
import "../styles/system.css";
import {
  effectiveEnabled,
  writeTargetBindsApply,
} from "./format";
import type { ManagedProviderRow } from "./types";
import { MutationFlow } from "./MutationFlow";

export function EnablementControl(props: {
  row: ManagedProviderRow;
  writeTarget: OpenCodeProviderWriteTarget | null | undefined;
  onApplied?: () => void;
  /** Compact cell mode for the manage table. */
  compact?: boolean;
}) {
  const { row, writeTarget } = props;
  const enabled = effectiveEnabled(row.desired);
  const [pending, setPending] = useState<boolean | null>(null);
  const blocked = !writeTargetBindsApply(writeTarget);

  if (pending !== null) {
    return (
      <div className="prov-enablement-flow" data-testid="enablement-flow">
        <p className="prov-label">
          {pending ? "Enable" : "Disable"} {row.name ?? row.id}
        </p>
        <MutationFlow
          mutation={{
            kind: "set-enablement",
            providerId: row.id,
            enabled: pending,
          }}
          writeTarget={writeTarget}
          onApplied={() => {
            props.onApplied?.();
            setPending(null);
          }}
          onCancel={() => setPending(null)}
        />
      </div>
    );
  }

  const proposed = !enabled;
  return (
    <div className="prov-enablement" data-testid="enablement-control">
      <Switch
        checked={enabled}
        label={`${enabled ? "Disable" : "Enable"} provider ${row.name ?? row.id}`}
        disabled={blocked}
        onChange={() => setPending(proposed)}
      />
      <span className={enabled ? "muted" : "prov-off"}>
        {enabled ? "Enabled" : "Disabled"}
      </span>
      {row.desired?.enableDisableConflict ? (
        <span className="pill warn" title="Listed in both enabled_providers and disabled_providers. Disabled wins.">
          Conflict
        </span>
      ) : null}
      {blocked ? (
        <span className="muted" title="Config writes are unavailable for the current write target.">
          Writes off
        </span>
      ) : null}
    </div>
  );
}
