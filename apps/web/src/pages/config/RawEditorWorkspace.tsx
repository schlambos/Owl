import type {
  RawCompareResponse,
  RawPreviewResponse,
  RawSourceLoadResponse,
  SourceFingerprint,
} from "@omo/shared";
import { RAW_LIVE_UNCHANGED_NOTE } from "@omo/shared";
import { Button } from "../../components/ui/Button";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { Surface } from "../../components/ui/Surface";
import { OmoMonacoDiff, OmoMonacoEditor } from "../../monaco/OmoMonacoEditor";
import type { OmoMonacoSchemaOptions } from "../../monaco/omo-config-editor";
import { fmtVal } from "./ProvenanceBrowser";
import {
  exceedsCandidateCap,
  flattenSourceDiagnostics,
  semanticRows,
  shortHash,
  sourceModelUri,
} from "./raw-contract";

type PreviewTab = "semantic" | "source" | "effective" | "provenance" | "validation";

export function RawEditorWorkspace(props: {
  source: RawSourceLoadResponse | null;
  draft: string;
  dirty: boolean;
  wordWrap: boolean;
  readOnly: boolean;
  schema?: OmoMonacoSchemaOptions;
  revealPath?: string | null;
  preview: RawPreviewResponse | null;
  previewTab: PreviewTab;
  stale: boolean;
  latestFingerprint: SourceFingerprint | null;
  compare: RawCompareResponse | null;
  formError: string | null;
  busy: boolean;
  applied?: string | null;
  onDraft: (text: string) => void;
  onPreview: () => void;
  onApply: () => void;
  onDiscardPreview: () => void;
  onPreviewTab: (tab: PreviewTab) => void;
  onWordWrap: () => void;
  onCompare: () => void;
  onReload: () => void;
  onCreateProject: () => void;
}) {
  const source = props.source;
  const oversize = exceedsCandidateCap(props.draft);
  const applyReady =
    !!props.preview &&
    props.preview.ok &&
    props.preview.canApply &&
    !!props.preview.candidateSha256 &&
    !props.stale &&
    !props.readOnly &&
    !oversize &&
    (props.preview.schemaValidation ? props.preview.schemaValidation.ok : true);

  const uri = source ? sourceModelUri(source.sourceId, source.format) : "";
  const diagnostics = source ? flattenSourceDiagnostics(source) : [];
  const invalidCurrent = diagnostics.length > 0;
  const missingProject = source?.sourceId === "project-omo" && source.exists === false;
  const missingUser = source?.sourceId === "user-omo" && source.exists === false;

  return (
    <div className="omo-config-raw config-raw" data-testid="config-raw">
      {!source ? (
        <p className="omo-config-quiet">Loading source…</p>
      ) : (
        <>
          <div className="omo-config-raw-meta">
            <div>
              <div className="omo-config-raw-flags">
                <StatusBadge>
                  {source.sourceId === "user-omo" ? "user" : "project"} OMO
                </StatusBadge>
                <StatusBadge tone={source.exists ? "ok" : "warn"}>
                  {source.exists ? source.format : "not present"}
                </StatusBadge>
                {props.dirty ? (
                  <StatusBadge tone="warn" testId="config-dirty">
                    dirty
                  </StatusBadge>
                ) : null}
                {props.readOnly ? <StatusBadge tone="warn">read-only</StatusBadge> : null}
              </div>
              <div
                className="omo-config-raw-path omo-mono omo-config-path"
                title={source.path || undefined}
                translate="no"
              >
                {source.path || "(logical source)"}
              </div>
              <div className="omo-config-raw-fp omo-config-break">
                <span title={source.fingerprint.sha256 ?? undefined} translate="no">
                  {source.exists ? shortHash(source.fingerprint.sha256) : "missing"}
                </span>
                {" · gen "}
                {source.fingerprint.generation}
                {source.schema.cacheKey ? (
                  <>
                    {" · "}
                    <span title={source.schema.cacheKey} translate="no">
                      {source.schema.cacheKey}
                    </span>
                  </>
                ) : null}
              </div>
            </div>
            <div className="omo-config-actions">
              <Button onClick={props.onWordWrap}>
                {props.wordWrap ? "Unwrap" : "Word wrap"}
              </Button>
              {missingProject ? (
                <Button
                  variant="primary"
                  data-testid="config-create-project"
                  onClick={props.onCreateProject}
                >
                  Create Project Config
                </Button>
              ) : null}
            </div>
          </div>

          {missingProject ? (
            <p className="omo-config-note" data-testid="config-missing-project">
              Not present. Selecting this source does not create a file. Create
              Project Config starts a local `{"{}"}` draft; Apply writes the
              project `.jsonc` once.
            </p>
          ) : null}
          {missingUser ? (
            <p className="omo-config-note" data-testid="config-missing-user">
              User source is not present. This workspace does not create a user
              file from here.
            </p>
          ) : null}

          {invalidCurrent ? (
            <div className="warn-block" role="alert" data-testid="config-invalid-current">
              Current source is invalid. The exact text stays editable. A valid
              candidate can repair it.
              <ul className="omo-config-diag-list">
                {diagnostics.slice(0, 5).map((iss, i) => (
                  <li key={i}>
                    {iss.path || "(root)"} — {iss.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {oversize ? (
            <div className="error" role="alert" data-testid="config-oversize">
              Draft exceeds the 2 MiB candidate limit. Preview and Apply stay off.
            </div>
          ) : null}

          <OmoMonacoEditor
            uri={uri}
            value={props.draft}
            format={source.format}
            readOnly={props.readOnly}
            wordWrap={props.wordWrap}
            schema={props.schema}
            revealPath={props.revealPath}
            ariaLabel={`${source.sourceId === "user-omo" ? "User" : "Project"} OMO configuration editor`}
            onChange={props.onDraft}
          />

          {props.formError ? (
            <div className="error" role="alert" data-testid="config-form-error">
              {props.formError}
            </div>
          ) : null}

          {props.stale ? (
            <div className="warn-block" role="alert" data-testid="config-stale">
              The source changed outside this editor. Preview is invalid and Apply
              is off. Compare keeps your draft; Reload discards it.
              <div className="omo-config-quiet omo-config-stale-fp">
                Loaded{" "}
                <span title={source.fingerprint.sha256 ?? undefined} translate="no">
                  {shortHash(source.fingerprint.sha256)}
                </span>
                {" · latest "}
                <span
                  title={
                    props.compare?.fingerprint.sha256 ??
                    props.latestFingerprint?.sha256 ??
                    undefined
                  }
                  translate="no"
                >
                  {shortHash(
                    props.compare?.fingerprint.sha256 ??
                      props.latestFingerprint?.sha256 ??
                      null,
                  )}
                </span>
              </div>
              <div className="omo-config-actions">
                <Button data-testid="config-compare" onClick={props.onCompare}>
                  Compare
                </Button>
                <Button data-testid="config-reload" onClick={props.onReload}>
                  Reload
                </Button>
              </div>
            </div>
          ) : null}

          {props.compare ? (
            <div className="omo-config-compare" data-testid="config-compare-panel">
              <div className="omo-config-kicker">Draft vs latest source</div>
              <OmoMonacoDiff
                originalUri={`${uri}#latest`}
                original={props.compare.currentText}
                modifiedUri={`${uri}#draft`}
                modified={props.draft}
                ariaLabel="Draft compared with latest source"
                testId="config-compare-diff"
              />
            </div>
          ) : null}

          <div className="omo-config-actions">
            <Button
              data-testid="config-preview"
              disabled={props.busy || props.readOnly || oversize || props.stale}
              onClick={props.onPreview}
            >
              {props.busy ? "Working…" : "Preview"}
            </Button>
          </div>

          {props.preview ? (
            <PreviewPanel
              preview={props.preview}
              tab={props.previewTab}
              onTab={props.onPreviewTab}
              applyReady={applyReady}
              busy={props.busy}
              onApply={props.onApply}
              onDiscard={props.onDiscardPreview}
              sourceUri={uri}
              loadedText={source.text}
              draft={props.draft}
            />
          ) : null}

          <div aria-live="polite" role="status">
            {props.applied ? (
              <div className="info-block" data-testid="config-applied">
                Applied — revision{" "}
                <span className="omo-mono" translate="no">
                  {props.applied}
                </span>
                . {RAW_LIVE_UNCHANGED_NOTE}
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

function PreviewPanel(props: {
  preview: RawPreviewResponse;
  tab: PreviewTab;
  onTab: (tab: PreviewTab) => void;
  applyReady: boolean;
  busy: boolean;
  onApply: () => void;
  onDiscard: () => void;
  sourceUri: string;
  loadedText: string;
  draft: string;
}) {
  const tabs: PreviewTab[] = [
    "semantic",
    "source",
    "effective",
    "provenance",
    "validation",
  ];
  const labels: Record<PreviewTab, string> = {
    semantic: "Semantic Impact",
    source: "Source Diff",
    effective: "Effective Diff",
    provenance: "Provenance",
    validation: "Validation",
  };

  return (
    <Surface className="omo-config-preview omo-config-surface" data-testid="config-preview-panel">
      <div className="omo-config-kicker">Preview</div>
      <dl className="omo-config-kv">
        <dt>Target</dt>
        <dd className="omo-mono omo-config-break" title={props.preview.target.path || undefined}>
          {props.preview.target.path || "—"}
        </dd>
        <dt>Can apply</dt>
        <dd>{props.applyReady ? "yes" : "no"}</dd>
        <dt>Runtime</dt>
        <dd data-testid="config-runtime-action">{props.preview.liveUnchangedNote}</dd>
      </dl>
      <div className="omo-config-preview-tabs" role="tablist" aria-label="Preview views">
        {tabs.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={props.tab === id}
            className="omo-config-preview-tab"
            data-testid={`config-preview-tab-${id}`}
            onClick={() => props.onTab(id)}
          >
            {labels[id]}
          </button>
        ))}
      </div>

      {props.tab === "semantic" ? (
        <div data-testid="config-semantic">
          <p className="omo-config-quiet">{props.preview.liveUnchangedNote}</p>
          <dl className="omo-config-kv">
            {semanticRows(props.preview.semanticSummaries).map(([label, row]) => (
              <SemanticRow
                key={label}
                label={label}
                changed={row.changed}
                notes={row.notes}
              />
            ))}
          </dl>
        </div>
      ) : null}

      {props.tab === "source" ? (
        <div data-testid="config-source-diff">
          <OmoMonacoDiff
            originalUri={`${props.sourceUri}#before`}
            original={props.loadedText}
            modifiedUri={`${props.sourceUri}#after`}
            modified={props.draft}
            ariaLabel="Source before and after this preview"
            testId="config-source-monaco-diff"
          />
          {props.preview.textDiff?.truncated ? (
            <p className="omo-config-quiet">Bounded preview truncated — full text is in the editors.</p>
          ) : null}
        </div>
      ) : null}

      {props.tab === "effective" ? (
        <ChangeTable testId="config-effective-diff" rows={props.preview.effectiveChanges} />
      ) : null}
      {props.tab === "provenance" ? (
        <div className="omo-config-table-wrap omo-config-table-wrap-inset">
          <table className="data" data-testid="config-provenance-diff">
            <thead>
              <tr>
                <th>Path</th>
                <th>Before</th>
                <th>After</th>
              </tr>
            </thead>
            <tbody>
              {(props.preview.provenanceChanges ?? []).map((c) => (
                <tr key={c.path}>
                  <td className="omo-mono omo-config-break">{c.path}</td>
                  <td className="omo-mono omo-config-break">
                    {c.before?.stage ?? "—"} {fmtVal(c.before?.value)}
                  </td>
                  <td className="omo-mono omo-config-break">
                    {c.after?.stage ?? "—"} {fmtVal(c.after?.value)}
                  </td>
                </tr>
              ))}
              {(props.preview.provenanceChanges ?? []).length === 0 ? (
                <tr>
                  <td colSpan={3} className="omo-config-empty">
                    none
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}
      {props.tab === "validation" ? (
        <div className="omo-config-validation" data-testid="config-validation">
          <p>
            Schema{" "}
            {props.preview.schemaValidation?.unavailable
              ? "unavailable"
              : props.preview.schemaValidation?.ok
                ? "valid"
                : "invalid"}
          </p>
          <p>
            Semantic{" "}
            {props.preview.semanticValidation.ok ? "valid" : "has issues"}
          </p>
          {(props.preview.schemaValidation?.issues ?? []).map((iss, i) => (
            <div key={i} className="omo-mono">
              {iss.path || "(root)"} — {iss.message}
            </div>
          ))}
          {(props.preview.errors ?? []).map((e) => (
            <div key={e} className="error">
              {e}
            </div>
          ))}
        </div>
      ) : null}

      <div className="omo-config-actions omo-config-actions-end">
        <Button
          variant="primary"
          data-testid="config-apply"
          disabled={props.busy || !props.applyReady}
          onClick={props.onApply}
        >
          Apply
        </Button>
        <Button onClick={props.onDiscard}>Discard preview</Button>
      </div>
    </Surface>
  );
}

function SemanticRow(props: { label: string; changed: boolean; notes: string[] }) {
  return (
    <>
      <dt>{props.label}</dt>
      <dd>
        {props.changed ? "changed" : "unchanged"}
        {props.notes.length ? ` — ${props.notes.join("; ")}` : ""}
      </dd>
    </>
  );
}

function ChangeTable(props: {
  testId: string;
  rows: RawPreviewResponse["effectiveChanges"];
}) {
  return (
    <div className="omo-config-table-wrap omo-config-table-wrap-inset">
      <table className="data" data-testid={props.testId}>
        <thead>
          <tr>
            <th>Path</th>
            <th>Before</th>
            <th>After</th>
          </tr>
        </thead>
        <tbody>
          {(props.rows ?? []).map((c) => (
            <tr key={`${c.op}:${c.path}`}>
              <td className="omo-mono omo-config-break">{c.path}</td>
              <td className="omo-mono omo-config-break">{fmtVal(c.before)}</td>
              <td className="omo-mono omo-config-break">{c.op === "remove" ? "(removed)" : fmtVal(c.after)}</td>
            </tr>
          ))}
          {(props.rows ?? []).length === 0 ? (
            <tr>
              <td colSpan={3} className="omo-config-empty">
                none
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
