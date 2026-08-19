/**
 * Secret status pill — presence signals only ("Key on file" via
 * live.connected + desired.inConfig). Never reveals or implies a value.
 */
import { StatusBadge } from "../components/ui/StatusBadge";
import type { ManagedProviderRow } from "./types";
import { credentialState } from "./format";

export function SecretStatus(props: { row: ManagedProviderRow }) {
  const s = credentialState(props.row);
  return (
    <StatusBadge
      tone={s.tone === "ok" ? "ok" : "neutral"}
      title={s.title}
      testId="secret-status"
    >
      {s.label}
    </StatusBadge>
  );
}
