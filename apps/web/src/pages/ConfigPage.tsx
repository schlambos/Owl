import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type {
  OmoSchemaDocumentDto,
  OmoSchemaStatus,
  OmoRevisionDetail,
  OmoRevisionListItem,
  RawCompareResponse,
  RawOmoSourceId,
  RawPreviewResponse,
  RawSourceLoadResponse,
  ResolvedProperty,
} from "@omo/shared";
import { MISSING_PROJECT_EDITOR_TEXT } from "@omo/shared";
import { api, parseRawApplyResponse, parseRawSimulateResponse } from "../api";
import { PageHeader } from "../components/PageHeader";
import { Button } from "../components/ui/Button";
import { StatusBadge } from "../components/ui/StatusBadge";
import { Surface } from "../components/ui/Surface";
import { notifyOmoSchemaStatusRefresh, useOmoSchemaStatus } from "../hooks/useOmoSchemaStatus";
import { useUnsavedChangesWarning } from "../hooks/useUnsavedChangesWarning";
import type { OmoMonacoSchemaOptions } from "../monaco/omo-config-editor";
import { useRuntime } from "../runtime/RuntimeContext";
import { ProvenanceBrowser, type ProvenancePayload } from "./config/ProvenanceBrowser";
import { RawEditorWorkspace } from "./config/RawEditorWorkspace";
import { RevisionsWorkspace } from "./config/RevisionsWorkspace";
import "../styles/config.css";
import {
  CONFIG_TABS,
  exceedsCandidateCap,
  fingerprintsEqual,
  flattenSourceDiagnostics,
  parseRevisionDetail,
  parseRevisionList,
  parseSchemaDocument,
  parseSourceIdParam,
  schemaModelUri,
  shortHash,
  sourceIsValid,
  sourceModelUri,
  type ConfigWorkspaceTab,
} from "./config/raw-contract";

const TAB_IDS = new Set(CONFIG_TABS.map((t) => t.id));

function parseTab(raw: string | null): ConfigWorkspaceTab {
  if (raw && TAB_IDS.has(raw as ConfigWorkspaceTab)) return raw as ConfigWorkspaceTab;
  return "sources";
}

export function ConfigPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseTab(searchParams.get("tab"));
  const sourceId = parseSourceIdParam(searchParams.get("sourceId"), searchParams.get("scope"));
  const pathQuery = searchParams.get("path");
  const { status: schemaStatus } = useOmoSchemaStatus();
  const { configSourcesEvent, configSourcesGeneration } = useRuntimeSafe();

  const setWorkspace = (next: {
    tab?: ConfigWorkspaceTab;
    sourceId?: RawOmoSourceId;
    path?: string | null;
  }) => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      params.delete("scope");
      const nextTab = next.tab ?? tab;
      if (nextTab === "sources") params.delete("tab");
      else params.set("tab", nextTab);
      const nextSource = next.sourceId ?? sourceId;
      if (nextSource === "user-omo") params.delete("sourceId");
      else params.set("sourceId", nextSource);
      if (next.path === null) params.delete("path");
      else if (next.path !== undefined) params.set("path", next.path);
      return params;
    });
  };

  useEffect(() => {
    if (searchParams.get("scope") && !searchParams.get("sourceId")) {
      setWorkspace({ sourceId });
    }
    // Compatibility redirect from legacy ?scope= once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [provenance, setProvenance] = useState<ProvenancePayload | null>(null);
  const [provError, setProvError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedProp, setSelectedProp] = useState<string | null>(null);
  const [userSource, setUserSource] = useState<RawSourceLoadResponse | null>(null);
  const [projectSource, setProjectSource] = useState<RawSourceLoadResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<RawOmoSourceId, string>>({
    "user-omo": "",
    "project-omo": MISSING_PROJECT_EDITOR_TEXT,
  });
  const [schemaDoc, setSchemaDoc] = useState<OmoSchemaDocumentDto | null>(null);
  const [preview, setPreview] = useState<RawPreviewResponse | null>(null);
  const [previewTab, setPreviewTab] = useState<
    "semantic" | "source" | "effective" | "provenance" | "validation"
  >("semantic");
  const [stale, setStale] = useState(false);
  const [latestFingerprint, setLatestFingerprint] = useState<
    RawSourceLoadResponse["fingerprint"] | null
  >(null);
  const [compare, setCompare] = useState<RawCompareResponse | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<string | null>(null);
  const [wordWrap, setWordWrap] = useState(true);
  const [revisions, setRevisions] = useState<OmoRevisionListItem[]>([]);
  const [revision, setRevision] = useState<OmoRevisionDetail | null>(null);
  const [restorePreview, setRestorePreview] = useState<RawPreviewResponse | null>(null);
  const [revealPath, setRevealPath] = useState<string | null>(pathQuery);
  const ownApplyRef = useRef<{ sourceId: RawOmoSourceId; sha256: string | null } | null>(null);
  const handledSourcesGenerationRef = useRef<Record<RawOmoSourceId, number>>({
    "user-omo": 0,
    "project-omo": 0,
  });

  const activeSource = sourceId === "user-omo" ? userSource : projectSource;
  const draft = drafts[sourceId];
  const dirty = !!activeSource && draft !== activeSource.text;
  useUnsavedChangesWarning(
    dirty,
    "This source has unsaved draft changes. Leave anyway?",
  );

  const loadProvenance = useCallback(async () => {
    try {
      const r = await fetch("/api/omo/provenance");
      if (!r.ok) throw new Error(`provenance → ${r.status}`);
      setProvenance((await r.json()) as ProvenancePayload);
      setProvError(null);
    } catch (e) {
      setProvError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadSource = useCallback(
    async (which: RawOmoSourceId, opts?: { preserveDraft?: boolean }) => {
      const { data } = await api.rawSource(which);
      const parsed = data as RawSourceLoadResponse;
      if (which === "user-omo") setUserSource(parsed);
      else setProjectSource(parsed);
      if (parsed.text !== undefined && !opts?.preserveDraft) {
        setDrafts((d) => ({ ...d, [which]: parsed.text }));
      }
      return parsed;
    },
    [],
  );

  const loadSchemaDoc = useCallback(async () => {
    const { data } = await api.schemaDocument();
    setSchemaDoc(parseSchemaDocument(data));
  }, []);

  const loadRevisions = useCallback(async (which: RawOmoSourceId) => {
    const data = await api.omoRevisions(which);
    setRevisions(parseRevisionList(data));
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([
      loadProvenance(),
      loadSource("user-omo").catch(() => null),
      loadSource("project-omo").catch(() => null),
      loadSchemaDoc().catch(() =>
        setSchemaDoc({ available: false, error: "installed schema unavailable" }),
      ),
      loadRevisions(sourceId).catch(() => setRevisions([])),
    ]);
    setLoading(false);
  }, [loadProvenance, loadSource, loadSchemaDoc, loadRevisions, sourceId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    void loadRevisions(sourceId).catch(() => setRevisions([]));
  }, [sourceId, loadRevisions]);

  useEffect(() => {
    setRevealPath(pathQuery);
  }, [pathQuery]);

  useEffect(() => {
    if (!configSourcesEvent || configSourcesGeneration === 0) return;
    if (handledSourcesGenerationRef.current[sourceId] === configSourcesGeneration) return;
    const incoming = configSourcesEvent.sources[sourceId];
    const loaded = activeSource?.fingerprint;
    const schemaKeyChanged =
      !!activeSource?.schema.cacheKey &&
      !!configSourcesEvent.schema.cacheKey &&
      activeSource.schema.cacheKey !== configSourcesEvent.schema.cacheKey;
    const own = ownApplyRef.current;
    const ownForViewed =
      configSourcesEvent.ownApplyBySource?.[sourceId] === true ||
      (own?.sourceId === sourceId &&
        own.sha256 !== null &&
        incoming?.sha256 === own.sha256);
    if (ownForViewed) {
      handledSourcesGenerationRef.current[sourceId] = configSourcesGeneration;
      ownApplyRef.current = null;
      if (schemaKeyChanged) void loadSchemaDoc();
      if (dirty) {
        if (incoming) setLatestFingerprint(incoming);
        setPreview(null);
        setStale(true);
        return;
      }
      void loadSource(sourceId, { preserveDraft: false });
      setStale(false);
      return;
    }
    if (!loaded || !incoming) return;
    handledSourcesGenerationRef.current[sourceId] = configSourcesGeneration;
    const activeChanged =
      !fingerprintsEqual(loaded, incoming) || schemaKeyChanged;
    if (activeChanged) {
      setLatestFingerprint(incoming);
      setPreview(null);
      setStale(true);
    }
  }, [
    configSourcesEvent,
    configSourcesGeneration,
    sourceId,
    activeSource,
    dirty,
    loadSource,
    loadSchemaDoc,
  ]);

  const schemaUnavailable =
    schemaStatus?.available === false ||
    schemaDoc?.available === false ||
    activeSource?.schema.available === false ||
    activeSource?.writeCapability === "closed";
  const readOnly = schemaUnavailable === true;
  const schemaOptions: OmoMonacoSchemaOptions | undefined = useMemo(() => {
    if (!schemaDoc || schemaDoc.available !== true || !activeSource) return undefined;
    return {
      schemaUri: schemaModelUri(schemaDoc.packageVersion, schemaDoc.schemaHash),
      cacheKey: schemaDoc.cacheKey,
      format: activeSource.format,
      sourceUri: sourceModelUri(activeSource.sourceId, activeSource.format),
      schema: schemaDoc.schema,
    };
  }, [schemaDoc, activeSource]);

  const touchDraft = (text: string) => {
    setDrafts((d) => ({ ...d, [sourceId]: text }));
    setPreview(null);
    setFormError(null);
    setApplied(null);
  };

  const runPreview = async () => {
    if (!activeSource) return;
    if (exceedsCandidateCap(draft)) {
      setFormError("Draft exceeds the 2 MiB candidate limit.");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const { status, data } = await api.simulateRaw({
        sourceId,
        expectedSource: activeSource.fingerprint,
        candidateText: draft,
        expectedSchemaCacheKey: activeSource.schema.cacheKey,
      });
      if (status === 409) {
        setPreview(null);
        setStale(true);
        return;
      }
      const next = parseRawSimulateResponse(data);
      if (next.code === "stale-source") {
        setPreview(null);
        setStale(true);
        return;
      }
      setStale(false);
      setPreview(next);
      setPreviewTab("source");
      setWorkspace({ tab: "diff" });
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runApply = async () => {
    if (!activeSource || !preview?.candidateSha256) return;
    setBusy(true);
    try {
      const { status, data } = await api.applyRaw({
        sourceId,
        expectedSource: activeSource.fingerprint,
        candidateText: draft,
        expectedSchemaCacheKey: activeSource.schema.cacheKey,
        expectedCandidateSha256: preview.candidateSha256,
      });
      if (status === 409) {
        setPreview(null);
        setStale(true);
        return;
      }
      const commit = parseRawApplyResponse(data);
      if (commit.code === "stale-source") {
        setPreview(null);
        setStale(true);
        return;
      }
      if (!commit.ok) {
        setPreview(commit.preview);
        setFormError(commit.errors.join("; ") || "Apply failed");
        return;
      }
      ownApplyRef.current = {
        sourceId,
        sha256: commit.source?.sha256 ?? commit.preview.candidateSha256 ?? null,
      };
      setApplied(commit.revisionId ?? "saved");
      setPreview(null);
      notifyOmoSchemaStatusRefresh();
      await Promise.all([loadSource(sourceId), loadProvenance(), loadRevisions(sourceId)]);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runCompare = async () => {
    const { data } = await api.compareRaw({ sourceId, draftText: draft });
    setCompare(data as RawCompareResponse);
  };

  const runReload = async () => {
    if (dirty && !window.confirm("Reload discards the local draft. Continue?")) return;
    setStale(false);
    setCompare(null);
    setPreview(null);
    await loadSource(sourceId);
  };

  const createProject = () => {
    setDrafts((d) => ({ ...d, "project-omo": MISSING_PROJECT_EDITOR_TEXT }));
    setWorkspace({ tab: "raw", sourceId: "project-omo" });
  };

  const openRevision = async (id: string) => {
    const detail = parseRevisionDetail(await api.omoRevision(id));
    setRevision(detail);
    setRestorePreview(null);
  };

  const previewRestore = async () => {
    if (!revision || !activeSource) return;
    const { data } = await api.simulateOmoRestore(revision.id, {
      sourceId,
      expectedSource: activeSource.fingerprint,
    });
    setRestorePreview(parseRawSimulateResponse(data));
  };

  const applyRestore = async () => {
    if (!revision || !activeSource || !restorePreview?.candidateSha256) return;
    const { data } = await api.restoreOmoRevision(revision.id, {
      sourceId,
      expectedSource: activeSource.fingerprint,
      expectedCandidateSha256: restorePreview.candidateSha256,
    });
    const commit = parseRawApplyResponse(data);
    if (!commit.ok) {
      setFormError(commit.errors.join("; ") || "Restore failed");
      return;
    }
    setApplied(commit.revisionId ?? revision.id);
    notifyOmoSchemaStatusRefresh();
    await loadAll();
  };

  return (
    <div className="omo-config config-workspace" data-testid="config-workspace">
      <PageHeader
        title="Configuration"
        meta={
          provenance
            ? `preset ${provenance.preset ?? "—"} · ${Object.keys(provenance.properties).length} properties`
            : undefined
        }
        onRefresh={() => void loadAll()}
        loading={loading}
      />

      <VersionBanner
        schemaStatus={schemaStatus}
        schemaDoc={schemaDoc}
        source={activeSource}
      />

      <div className="omo-config-toolbar">
        <label className="omo-config-source" htmlFor="config-scope">
          Source
          <select
            id="config-scope"
            className="omo-config-select"
            name="config-source"
            autoComplete="off"
            data-testid="config-scope"
            value={sourceId}
            onChange={(e) => {
              setPreview(null);
              setStale(false);
              setWorkspace({ sourceId: e.target.value as RawOmoSourceId });
            }}
          >
            <option value="user-omo">User OMO</option>
            <option value="project-omo">Project OMO</option>
          </select>
        </label>
        {sourceId === "project-omo" && projectSource && !projectSource.exists ? (
          <StatusBadge tone="warn" testId="config-project-missing">
            Not present
          </StatusBadge>
        ) : null}
      </div>

      <nav
        className="omo-seg omo-seg-secondary omo-config-tabs"
        data-testid="config-tabs"
        aria-label="Configuration views"
      >
        {CONFIG_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className="omo-seg-item"
            data-testid={`config-tab-${item.id}`}
            aria-current={tab === item.id ? "page" : undefined}
            onClick={() => setWorkspace({ tab: item.id })}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {provError && (tab === "sources" || tab === "effective" || tab === "provenance") ? (
        <div className="error" role="alert">{provError}</div>
      ) : null}

      {tab === "sources" ? (
        <SourcesPane
          data={provenance}
          user={userSource}
          project={projectSource}
          onOpen={(next) => setWorkspace({ tab: "raw", sourceId: next })}
          onCreateProject={createProject}
        />
      ) : null}

      {tab === "effective" ? <EffectivePane data={provenance} /> : null}

      {tab === "provenance" ? (
        <ProvenanceBrowser
          data={provenance}
          selected={selectedProp}
          onSelect={setSelectedProp}
        />
      ) : null}

      {tab === "raw" || tab === "diff" ? (
        <RawEditorWorkspace
          source={activeSource}
          draft={draft}
          dirty={dirty}
          wordWrap={wordWrap}
          readOnly={readOnly}
          schema={schemaOptions}
          revealPath={revealPath}
          preview={preview}
          previewTab={previewTab}
          stale={stale}
          latestFingerprint={latestFingerprint}
          compare={compare}
          formError={formError}
          busy={busy}
          applied={applied}
          onDraft={touchDraft}
          onPreview={() => void runPreview()}
          onApply={() => void runApply()}
          onDiscardPreview={() => setPreview(null)}
          onPreviewTab={setPreviewTab}
          onWordWrap={() => setWordWrap((w) => !w)}
          onCompare={() => void runCompare()}
          onReload={() => void runReload()}
          onCreateProject={createProject}
        />
      ) : null}

      {tab === "revisions" ? (
        <RevisionsWorkspace
          items={revisions}
          selected={revision}
          busy={busy}
          restorePreviewOk={!!restorePreview?.ok && !!restorePreview.canApply}
          onSelect={(id) => void openRevision(id)}
          onPreviewRestore={() => void previewRestore()}
          onRestore={() => void applyRestore()}
        />
      ) : null}

      {tab === "schema" ? (
        <SchemaPane status={schemaStatus} document={schemaDoc} />
      ) : null}
    </div>
  );
}

function useRuntimeSafe() {
  try {
    return useRuntime();
  } catch {
    return { configSourcesEvent: null, configSourcesGeneration: 0 };
  }
}

function VersionBanner(props: {
  schemaStatus: OmoSchemaStatus | null;
  schemaDoc: OmoSchemaDocumentDto | null;
  source: RawSourceLoadResponse | null;
}) {
  const available =
    props.schemaStatus?.available !== false &&
    props.schemaDoc?.available !== false &&
    props.source?.schema.available !== false;
  const version =
    props.source?.schema.packageVersion ??
    props.schemaStatus?.packageVersion ??
    (props.schemaDoc?.available ? props.schemaDoc.packageVersion : undefined);
  const hash =
    props.source?.schema.schemaHash ??
    props.schemaStatus?.schemaHash ??
    (props.schemaDoc?.available ? props.schemaDoc.schemaHash : undefined);
  const sourceValid =
    props.source == null ? null : !props.source.exists ? null : sourceIsValid(props.source);
  return (
    <Surface className="omo-config-banner omo-config-surface" data-testid="config-version-banner">
      <dl className="omo-config-kv">
        <dt>OMO-Slim</dt>
        <dd className="omo-mono">{version ?? "—"}</dd>
        <dt>Schema</dt>
        <dd>
          {available ? (
            <StatusBadge tone="ok">loaded</StatusBadge>
          ) : (
            <StatusBadge tone="warn">unavailable</StatusBadge>
          )}{" "}
          <span className="omo-mono" title={hash} translate="no">
            {shortHash(hash)}
          </span>
        </dd>
        <dt>Source</dt>
        <dd>
          {sourceValid == null ? (
            <span className="omo-config-quiet">not present</span>
          ) : sourceValid ? (
            <StatusBadge tone="ok">valid</StatusBadge>
          ) : (
            <StatusBadge tone="bad">invalid</StatusBadge>
          )}
        </dd>
      </dl>
      <p className="omo-config-banner-note">
        Changes can affect any OMO subsystem. Writes are schema-validated and
        revisioned. Companion stays read-only — a raw Companion change is
        rejected by policy.
        {!available
          ? " Installed schema unavailable — configuration writes are blocked."
          : ""}
      </p>
    </Surface>
  );
}

function SourcesPane(props: {
  data: ProvenancePayload | null;
  user: RawSourceLoadResponse | null;
  project: RawSourceLoadResponse | null;
  onOpen: (sourceId: RawOmoSourceId) => void;
  onCreateProject: () => void;
}) {
  return (
    <div className="omo-config-sources" data-testid="config-sources">
      <div className="omo-config-table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Source</th>
              <th>Present</th>
              <th>Path / detail</th>
            </tr>
          </thead>
          <tbody>
            {(props.data?.sources ?? []).map((s) => (
              <tr key={s.id}>
                <td>{s.label}</td>
                <td>
                  <StatusBadge tone={s.present ? "ok" : "neutral"}>
                    {s.present ? "yes" : "no"}
                  </StatusBadge>
                </td>
                <td className="omo-mono omo-config-break" title={s.path ?? undefined}>
                  {s.path ?? "—"}
                  {s.detail ? <div className="omo-config-quiet">{s.detail}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="omo-config-source-cards">
        <Surface className="omo-config-source-card omo-config-surface">
          <h2>User OMO</h2>
          <p className="omo-config-quiet omo-config-break" title={props.user?.path || undefined}>
            {props.user?.path || "authorized user source"}
          </p>
          <div className="omo-config-actions">
            <Button onClick={() => props.onOpen("user-omo")}>Open raw editor</Button>
          </div>
        </Surface>
        <Surface className="omo-config-source-card omo-config-surface">
          <h2>Project OMO</h2>
          <p
            className="omo-config-quiet omo-config-break"
            title={props.project?.exists ? props.project.path : undefined}
          >
            {props.project?.exists ? props.project.path : "Not present"}
          </p>
          <div className="omo-config-actions">
            {props.project && !props.project.exists ? (
              <Button
                variant="primary"
                data-testid="config-create-project-sources"
                onClick={props.onCreateProject}
              >
                Create Project Config
              </Button>
            ) : (
              <Button onClick={() => props.onOpen("project-omo")}>
                Open raw editor
              </Button>
            )}
          </div>
        </Surface>
      </div>
    </div>
  );
}

function EffectivePane(props: { data: ProvenancePayload | null }) {
  const propsMap = props.data?.properties ?? {};
  const keys = Object.keys(propsMap).sort();
  return (
    <div className="omo-config-stack" data-testid="config-effective">
      {props.data?.runtimePreset ? (
        <Surface className="omo-config-surface">
          <h2>Runtime preset</h2>
          <p className="omo-config-quiet">{props.data.runtimePreset.note}</p>
        </Surface>
      ) : null}
      <div className="omo-config-table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Path</th>
              <th>Effective</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((path) => {
              const p: ResolvedProperty | undefined = propsMap[path];
              return (
                <tr key={path}>
                  <td className="omo-mono omo-config-break">{path}</td>
                  <td className="omo-mono omo-config-break">{JSON.stringify(p?.value)}</td>
                  <td>{p?.winner.stage}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SchemaPane(props: {
  status: OmoSchemaStatus | null;
  document: OmoSchemaDocumentDto | null;
}) {
  return (
    <Surface className="omo-config-surface omo-config-stack" data-testid="config-schema">
      <h2>Installed schema</h2>
      {props.document?.available === false || props.status?.available === false ? (
        <p data-testid="config-schema-unavailable">
          {props.document && "error" in props.document
            ? props.document.error
            : props.status?.error ??
              "The installed OMO-Slim package does not ship a readable schema — configuration writes are blocked."}
        </p>
      ) : (
        <>
          <dl className="omo-config-kv">
            <dt>Version</dt>
            <dd className="omo-mono">{props.status?.packageVersion ?? "—"}</dd>
            <dt>Hash</dt>
            <dd className="omo-mono" title={props.status?.schemaHash ?? undefined} translate="no">
              {shortHash(props.status?.schemaHash)}
            </dd>
            <dt>Cache key</dt>
            <dd
              className="omo-mono omo-config-break"
              title={
                props.document?.available ? props.document.cacheKey : props.status?.cacheKey ?? undefined
              }
              translate="no"
            >
              {props.document?.available ? props.document.cacheKey : props.status?.cacheKey ?? "—"}
            </dd>
          </dl>
          <p className="omo-config-quiet">
            Monaco uses this document for diagnostics only. Preview and Apply
            still use the server schema gate.
          </p>
        </>
      )}
    </Surface>
  );
}
