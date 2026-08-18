import { FocusTrapDialog } from "../components/FocusTrapDialog";
import { Button } from "../components/ui/Button";
import {
  LARGE_BATCH_THRESHOLD,
  MODEL_BATCH_TITLE_ID,
  type ModelRefId,
} from "./presentation";

export function BatchProbeDialog(props: {
  title: string;
  models: ModelRefId[];
  skipFresh: boolean;
  onSkipFreshChange: (next: boolean) => void;
  ackLarge: boolean;
  onAckLargeChange: (next: boolean) => void;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
  returnFocus?: () => HTMLElement | null;
}) {
  const large = props.models.length > LARGE_BATCH_THRESHOLD;
  const confirmDisabled =
    props.busy || props.models.length === 0 || (large && !props.ackLarge);

  return (
    <FocusTrapDialog
      variant="modal"
      labelledBy={MODEL_BATCH_TITLE_ID}
      onClose={() => {
        if (!props.busy) props.onClose();
      }}
      returnFocus={props.returnFocus}
      className="modal omo-models-batch"
    >
      <h2
        className="omo-models-batch-title"
        id={MODEL_BATCH_TITLE_ID}
        tabIndex={-1}
      >
        Confirm probe batch
      </h2>
      <p className="omo-models-batch-lead">{props.title}</p>
      <p>
        You are about to invoke {props.models.length} models through OpenCode.
        This may consume provider quota.
      </p>
      <label className="omo-models-check">
        <input
          type="checkbox"
          checked={props.skipFresh}
          onChange={(e) => props.onSkipFreshChange(e.target.checked)}
        />
        Skip recently tested models
      </label>
      {large ? (
        <label className="omo-models-check">
          <input
            type="checkbox"
            checked={props.ackLarge}
            onChange={(e) => props.onAckLargeChange(e.target.checked)}
          />
          I understand this is a large batch
        </label>
      ) : null}
      <div className="omo-models-batch-actions">
        <Button
          variant="primary"
          disabled={confirmDisabled}
          onClick={props.onConfirm}
        >
          {props.busy ? "Queuing…" : `Probe ${props.models.length} Models`}
        </Button>
        <Button disabled={props.busy} onClick={props.onClose}>
          Cancel
        </Button>
      </div>
    </FocusTrapDialog>
  );
}
