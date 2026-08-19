/**
 * Add provider (/providers/add) — two dense flows, no wizard chrome:
 *
 *  1. Custom (OpenAI-compatible): id / name / npm / baseURL / write-only key
 *     → POST models/list → tick the allowed models (unticked ids become the
 *     blacklist) → simulate → review diff (key never rendered) → apply with
 *     auth.apiKey + restart if the user confirms.
 *  2. Native: catalog table with per-row API-key / OAuth auth. Native add
 *     writes nothing to the config — the credential is everything.
 */
import { useId, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type {
  OpenCodeProviderCustomNpm,
  OpenCodeProviderListedModel,
} from "@omo/shared";
import { api } from "../api";
import { PageHeader } from "../components/PageHeader";
import { Button } from "../components/ui/Button";
import { useProviderData } from "../providers/useProviderData";
import {
  providerIdError,
  statusErrorMessage,
  writeTargetMeta,
} from "../providers/format";
import { MutationFlow } from "../providers/MutationFlow";
import { CatalogTable } from "../providers/CatalogTable";
import "../styles/providers.css";

export function AddProviderPage() {
  const [mode, setMode] = useState<"custom" | "native">("custom");
  const data = useProviderData({ loadCatalog: mode === "native" });

  return (
    <div className="prov-page" data-testid="add-provider-page">
      <PageHeader
        title="Add provider"
        meta={
          data.manage
            ? `${writeTargetMeta(data.manage.writeTarget)}`
            : undefined
        }
        onRefresh={() => void data.refresh()}
        loading={data.loading}
      />

      <div className="prov-actions prov-top-actions">
        <Link className="omo-btn omo-btn-secondary omo-btn-md" to="/providers/manage">
          Manage providers
        </Link>
      </div>

      <div
        className="prov-chip-row prov-mode"
        role="group"
        aria-label="Provider kind"
      >
        <button
          type="button"
          className="prov-chip"
          aria-pressed={mode === "custom"}
          onClick={() => setMode("custom")}
        >
          Custom (OpenAI-compatible)
        </button>
        <button
          type="button"
          className="prov-chip"
          aria-pressed={mode === "native"}
          onClick={() => setMode("native")}
        >
          Native (catalog)
        </button>
      </div>

      {data.error ? (
        <div className="error" role="alert">
          {data.error}
        </div>
      ) : null}

      {data.manage?.writeTarget.kind === "project-masked" && mode === "custom" ? (
        <div className="warn-block" role="status">
          Config writes are masked by the project config.{" "}
          {data.manage.writeTarget.reason}
        </div>
      ) : null}
      {data.manage?.writeTarget.kind === "blocked" && mode === "custom" ? (
        <div className="warn-block" role="status">
          Config writes are unavailable. {data.manage.writeTarget.reason}
        </div>
      ) : null}

      {mode === "custom" ? (
        <CustomFlow
          manage={data.manage}
          existingIds={new Set([
            ...(data.manage?.desired.map((d) => d.id) ?? []),
            ...(data.manage?.live.map((l) => l.id) ?? []),
          ])}
          onApplied={() => void data.refresh()}
        />
      ) : (
        <>
          {data.catalogIssue ? (
            <div className="error" role="alert">
              Catalog unavailable: {data.catalogIssue}
            </div>
          ) : null}
          {data.catalog?.issue ? (
            <div className="warn-block" role="status">
              {data.catalog.issue}
            </div>
          ) : null}
          {data.catalog ? (
            <CatalogTable
              catalog={data.catalog}
              onChanged={() => void data.refresh()}
            />
          ) : data.loading ? (
            <p className="muted">Loading catalog…</p>
          ) : null}
        </>
      )}
    </div>
  );
}

function CustomFlow(props: {
  manage: import("@omo/shared").OpenCodeProvidersManageDto | null;
  existingIds: Set<string>;
  onApplied: () => void;
}) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [npm, setNpm] = useState<OpenCodeProviderCustomNpm>(
    "@ai-sdk/openai-compatible",
  );
  const [baseURL, setBaseURL] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [fetchBusy, setFetchBusy] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [models, setModels] = useState<OpenCodeProviderListedModel[] | null>(
    null,
  );
  const [blocked, setBlocked] = useState<Set<string>>(new Set());

  const fid = useId();
  const fname = useId();
  const fnpm = useId();
  const furl = useId();
  const fkey = useId();
  const furlErr = useId();
  const fidErr = useId();

  const idError = id ? providerIdError(id) : null;
  const idTaken = id && !idError ? props.existingIds.has(id) : false;
  const urlError =
    baseURL && !/^https?:\/\/.+/.test(baseURL)
      ? "Base URL must start with http:// or https://."
      : null;

  const canFetch =
    !!id &&
    !idError &&
    !idTaken &&
    !!name.trim() &&
    !!baseURL &&
    !urlError &&
    !fetchBusy;

  const fetchModels = async () => {
    setFetchBusy(true);
    setFetchError(null);
    setModels(null);
    setBlocked(new Set());
    try {
      const r = await api.opencodeProviderModelsList({
        baseURL: baseURL.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      if (!r.data?.ok) {
        setFetchError(statusErrorMessage("List models", r.status, r.data));
        return;
      }
      setModels(r.data.models);
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      setFetchBusy(false);
    }
  };

  const mutation = useMemo(() => {
    if (!models) return null;
    return {
      kind: "add-custom" as const,
      provider: {
        id,
        name: name.trim(),
        baseURL: baseURL.trim(),
        npm,
        models,
        ...(blocked.size > 0
          ? { blacklist: Array.from(blocked).sort() }
          : {}),
      },
    };
  }, [models, id, name, baseURL, npm, blocked]);

  const toggle = (modelId: string, allow: boolean) => {
    const next = new Set(blocked);
    if (allow) next.delete(modelId);
    else next.add(modelId);
    setBlocked(next);
  };

  const setAll = (allow: boolean) => {
    setBlocked(allow ? new Set() : new Set((models ?? []).map((m) => m.id)));
  };

  return (
    <section className="prov-section" aria-label="Add custom provider">
      <div className="prov-form-grid">
        <div className="prov-field">
          <label className="prov-label" htmlFor={fid}>
            Provider id
          </label>
          <input
            id={fid}
            className="prov-input mono"
            type="text"
            autoComplete="off"
            placeholder="my-provider"
            aria-describedby={idError || idTaken ? fidErr : undefined}
            aria-invalid={idError || idTaken ? true : undefined}
            value={id}
            onChange={(e) => setId(e.target.value.trim())}
          />
          {idError ? (
            <div className="error prov-field-error" id={fidErr} role="alert">
              {idError}
            </div>
          ) : idTaken ? (
            <div className="error prov-field-error" id={fidErr} role="alert">
              A provider with this id already exists.
            </div>
          ) : null}
        </div>

        <div className="prov-field">
          <label className="prov-label" htmlFor={fname}>
            Display name
          </label>
          <input
            id={fname}
            className="prov-input"
            type="text"
            autoComplete="off"
            placeholder="My provider"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="prov-field">
          <label className="prov-label" htmlFor={fnpm}>
            Adapter (npm)
          </label>
          <select
            id={fnpm}
            className="prov-select"
            value={npm}
            onChange={(e) => setNpm(e.target.value as OpenCodeProviderCustomNpm)}
          >
            <option value="@ai-sdk/openai-compatible">
              @ai-sdk/openai-compatible (default)
            </option>
            <option value="@ai-sdk/openai">@ai-sdk/openai</option>
          </select>
        </div>

        <div className="prov-field">
          <label className="prov-label" htmlFor={furl}>
            Base URL
          </label>
          <input
            id={furl}
            className="prov-input mono prov-input-wide"
            type="url"
            autoComplete="off"
            placeholder="https://api.example.com/v1"
            aria-describedby={urlError ? furlErr : undefined}
            aria-invalid={urlError ? true : undefined}
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
          />
          {urlError ? (
            <div className="error prov-field-error" id={furlErr} role="alert">
              {urlError}
            </div>
          ) : null}
        </div>

        <div className="prov-field">
          <label className="prov-label" htmlFor={fkey}>
            API key (optional)
          </label>
          <input
            id={fkey}
            className="prov-input"
            type="password"
            autoComplete="new-password"
            placeholder="Write-only — stored with apply, never shown again"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <p className="prov-help">
            Used to list models now and stored with OpenCode when you apply.
            You can also add or rotate it later under Edit.
          </p>
        </div>

        <div className="prov-actions">
          <Button
            variant="primary"
            onClick={() => void fetchModels()}
            disabled={!canFetch}
            data-testid="custom-fetch-models"
          >
            {fetchBusy ? "Fetching…" : "Fetch models"}
          </Button>
        </div>
      </div>

      {fetchError ? (
        <div className="error" role="alert">
          {fetchError}
        </div>
      ) : null}

      {models ? (
        models.length === 0 ? (
          <div className="warn-block" role="status">
            The endpoint returned no models. Check the base URL and key.
          </div>
        ) : (
          <div className="prov-section" aria-label="Models">
            <p className="muted">
              {models.length} model{models.length === 1 ? "" : "s"} found.
              Ticked models are allowed; untick to add to the blacklist.
            </p>
            <div className="prov-actions">
              <Button size="sm" onClick={() => setAll(true)}>
                Allow all
              </Button>
              <Button size="sm" onClick={() => setAll(false)}>
                Block all
              </Button>
            </div>
            <div className="prov-model-list" role="group" aria-label="Allowed models">
              {models.map((m) => {
                const allowed = !blocked.has(m.id);
                const rowId = `add-${m.id}`;
                return (
                  <label className="prov-model-row" key={m.id} htmlFor={rowId}>
                    <input
                      id={rowId}
                      type="checkbox"
                      checked={allowed}
                      onChange={(e) => toggle(m.id, e.target.checked)}
                      aria-label={`Allow ${m.name ?? m.id}`}
                    />
                    <span className="prov-model-name">{m.name ?? m.id}</span>
                    {m.name && m.name !== m.id ? (
                      <span className="mono muted">{m.id}</span>
                    ) : null}
                    {!allowed ? <span className="pill warn">Blocked</span> : null}
                  </label>
                );
              })}
            </div>
          </div>
        )
      ) : null}

      {mutation && models && models.length > 0 ? (
        <MutationFlow
          mutation={mutation}
          writeTarget={props.manage?.writeTarget}
          {...(apiKey.trim() ? { authApiKey: apiKey.trim() } : {})}
          onApplied={props.onApplied}
        />
      ) : null}
    </section>
  );
}
