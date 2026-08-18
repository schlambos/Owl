import type { ConfigWriteScope, ResolvedProperty } from "@omo/shared";
import type { DestKind, DestinationChoice, EditStateResponse } from "./types";
import { destDescription, destPlainLabel } from "./model-utils";
import { humanSourceLabel } from "./CurrentAssignment";

const CELLS: Array<{
  scope: ConfigWriteScope;
  kind: DestKind;
  title: string;
  label: string;
  hint: string;
}> = [
  {
    scope: "user",
    kind: "preset",
    title: "User preset",
    label: "Preset",
    hint: "writes inside the active preset",
  },
  {
    scope: "user",
    kind: "root-agent",
    title: "User override",
    label: "Root override",
    hint: "overrides the active preset",
  },
  {
    scope: "project",
    kind: "preset",
    title: "Project preset",
    label: "Project preset",
    hint: "this project only",
  },
  {
    scope: "project",
    kind: "root-agent",
    title: "Project override",
    label: "Project override",
    hint: "overrides the project preset",
  },
];

export function AssignmentLocation(props: {
  agent: string;
  scope: ConfigWriteScope;
  destKind: DestKind;
  editState: EditStateResponse | null;
  winnerDest: DestinationChoice | null;
  destDiffersFromWinner: boolean;
  maskedWarning: { sourcePath: string; reason: string } | null;
  provModel: ResolvedProperty | null;
  onChange: (scope: ConfigWriteScope, kind: DestKind) => void;
  onUseControlling: () => void;
}) {
  const preset = props.editState?.preset;
  const selectedPath =
    props.scope === "user"
      ? props.editState?.user.path
      : props.editState?.project.path;
  const selectedExists =
    props.scope === "user"
      ? props.editState?.user.exists
      : props.editState?.project.exists;

  return (
    <section className="card ame-section ame-location" aria-labelledby="ame-location-heading">
      <h2 id="ame-location-heading">Assignment Location</h2>
      <p className="agents-quiet-note">
        Choose where this assignment is stored. User vs project is who it
        applies to; preset vs override is how strongly it wins.
      </p>

      <div className="ame-dest-grid" role="radiogroup" aria-label="Assignment location">
        {CELLS.map((cell) => {
          const selected =
            props.scope === cell.scope && props.destKind === cell.kind;
          const controlling =
            props.winnerDest != null &&
            props.winnerDest.scope === cell.scope &&
            props.winnerDest.kind === cell.kind;
          /* Clean accessible name for the radio — the wrapping label's
           * text (title + summary + hint) would otherwise concatenate
           * into a duplicated machine-like phrase. Values unchanged. */
          const radioName =
            cell.scope === "user" && cell.kind === "preset"
              ? preset
                ? `User preset “${preset}”`
                : "User preset"
              : cell.scope === "user"
                ? "User root override"
                : cell.kind === "preset"
                  ? preset
                    ? `Project preset “${preset}”`
                    : "Project preset"
                  : "Project override";
          return (
            <label
              key={`${cell.scope}-${cell.kind}`}
              className={
                selected ? "dest-option ame-dest-cell is-selected" : "dest-option ame-dest-cell"
              }
            >
              {cell.scope === "user" && cell.kind === "preset" ? (
                <span className="dest-scope">User configuration</span>
              ) : null}
              {cell.scope === "project" && cell.kind === "preset" ? (
                <span className="dest-scope">Project configuration</span>
              ) : null}
              <span className="ame-dest-title">{cell.title}</span>
              <span>
                <input
                  type="radio"
                  name="write-dest"
                  aria-label={radioName}
                  checked={selected}
                  onChange={() => props.onChange(cell.scope, cell.kind)}
                />{" "}
                {cell.scope === "user" && cell.kind === "preset" ? (
                  <>
                    Preset · {preset ?? "—"}
                  </>
                ) : cell.scope === "user" ? (
                  <>Root override</>
                ) : cell.kind === "preset" ? (
                  <>
                    Project preset · {preset ?? "—"}
                  </>
                ) : (
                  <>Project override</>
                )}
              </span>
              <span className="ame-dest-hint muted">{cell.hint}</span>
              {controlling ? (
                <span className="ame-dest-current">Currently controlling</span>
              ) : null}
            </label>
          );
        })}
      </div>
      {props.editState ? (
        <div className="mono muted dest-path">{props.editState.user.path}</div>
      ) : null}
      {props.editState ? (
        <div className="mono muted dest-path">
          {props.editState.project.path}{" "}
          {!props.editState.project.exists ? (
            <span className="pill warn">will create</span>
          ) : null}
        </div>
      ) : null}

      <p className="ame-dest-plain">
        This write will be stored in{" "}
        <strong>
          {destPlainLabel(props.scope, props.destKind, preset)}
        </strong>
        .
      </p>

      <div className="toolbar">
        <button
          type="button"
          className="btn btn-xs"
          disabled={!props.winnerDest}
          title={
            props.winnerDest
              ? "Point the write at the source that currently controls this agent"
              : "No configured controlling source (defaults-only)"
          }
          onClick={props.onUseControlling}
        >
          Edit controlling source
        </button>
        {props.provModel?.winner ? (
          <span className="muted">
            current controlling source:{" "}
            {humanSourceLabel(props.provModel.winner)} ·{" "}
            <span className="mono">{props.provModel.winner.sourcePath}</span>
          </span>
        ) : (
          <span className="muted">
            no configured controlling source (defaults-only)
          </span>
        )}
      </div>

      {props.destDiffersFromWinner ? (
        <div className="info-block">
          Preview to confirm whether this source changes the Effective
          model.
        </div>
      ) : null}

      {props.maskedWarning ? (
        <div className="warn-block">
          This write will not change <strong>{props.agent}</strong>’s
          Effective model. You are editing{" "}
          {destDescription(props.scope, props.destKind, preset)}, but{" "}
          <span className="mono">{props.maskedWarning.sourcePath}</span>{" "}
          currently wins. {props.maskedWarning.reason}
        </div>
      ) : null}

      <details className="ame-advanced">
        <summary>Technical Details</summary>
        <dl className="row-kv">
          <dt>File</dt>
          <dd className="mono">{selectedPath ?? "—"}</dd>
          <dt>Creates file</dt>
          <dd>{selectedExists === false ? "yes" : "no"}</dd>
          <dt>Destination</dt>
          <dd>{destDescription(props.scope, props.destKind, preset)}</dd>
          {props.provModel?.winner ? (
            <>
              <dt>Provenance</dt>
              <dd className="mono">{props.provModel.winner.sourcePath}</dd>
              <dt>Stage</dt>
              <dd>
                {props.provModel.winner.stage}
                {props.provModel.reason
                  ? ` — ${props.provModel.reason}`
                  : ""}
              </dd>
            </>
          ) : null}
        </dl>
      </details>
    </section>
  );
}
