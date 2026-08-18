import type { LiveProvider } from "@omo/shared";
import type { ModelAvailabilityContextValue } from "../../../models/ModelAvailabilityContext";
import { ProbeBadge } from "../../../models/ProbeBadge";
import type { ChainEntryState, ProbeCandidate } from "./types";
import {
  entryCandidate,
  probeOf,
  probeTestTitle,
} from "./model-utils";

/**
 * Per-chain-row probe cell: badge for the currently selected candidate
 * (unadvertised/manual entries keep their warn pill and still get a badge
 * when probe history exists) plus a Test action. Test only POSTs
 * /api/models/probe — it never touches /api/config/*.
 */
export function ChainProbeCell(props: {
  entry: ChainEntryState;
  avail: ModelAvailabilityContextValue | null;
  liveProviders: LiveProvider[];
  ocDisconnected: boolean;
  busy: boolean;
  onTest: (entry: ChainEntryState, cand: ProbeCandidate) => void;
}) {
  const { entry, avail } = props;
  const cand = entryCandidate(entry);
  const av = probeOf(avail, cand);
  const providerConnected = cand
    ? (props.liveProviders.find((p) => p.id === cand.providerId)?.connected ??
      false)
    : false;
  return (
    <span className="chain-probe">
      {av ? (
        <ProbeBadge probe={av.probe} showLatency={false} />
      ) : cand && avail && !avail.loading ? (
        <span className="muted">Not tested</span>
      ) : null}
      <button
        type="button"
        className="btn btn-xs"
        disabled={
          !cand || props.ocDisconnected || !providerConnected || props.busy
        }
        title={probeTestTitle(cand, props.ocDisconnected, providerConnected)}
        onClick={() => {
          if (cand) props.onTest(entry, cand);
        }}
      >
        {props.busy ? "Testing…" : "Test"}
      </button>
    </span>
  );
}
