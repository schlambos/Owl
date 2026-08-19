/**
 * CatalogTable — native providers from GET /catalog. Search + connection /
 * source filters; disconnected rows are never hidden, only marked. Each row
 * can expand an inline auth panel (API key or OAuth, plus the terminal
 * fallback). Adding a native provider stores a credential with OpenCode —
 * it does NOT write provider.<id> to the user-level config.
 */
import { useMemo, useState } from "react";
import type {
  OpenCodeProviderCatalogDto,
  OpenCodeProviderCatalogEntry,
} from "@omo/shared";
import { StatusDot } from "../components/ui/StatusDot";
import { providerDisplayName, sourceLabel } from "./format";
import { ApiKeyForm } from "./ApiKeyForm";
import { OAuthFlow, TuiFallback } from "./OAuthFlow";
import { Button } from "../components/ui/Button";
import "../styles/agents.css";
import "../styles/team-roster.css";

type ConnFilter = "all" | "connected" | "disconnected";

export function CatalogTable(props: {
  catalog: OpenCodeProviderCatalogDto;
  onChanged?: () => void;
}) {
  const [q, setQ] = useState("");
  const [conn, setConn] = useState<ConnFilter>("all");
  const [src, setSrc] = useState("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<"api" | "oauth">("api");

  const sources = useMemo(() => {
    const set = new Set<string>();
    for (const p of props.catalog.providers) set.add(p.source);
    return Array.from(set).sort();
  }, [props.catalog.providers]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return props.catalog.providers.filter((p) => {
      if (conn === "connected" && !p.connected) return false;
      if (conn === "disconnected" && p.connected) return false;
      if (src !== "all" && p.source !== src) return false;
      if (!needle) return true;
      return (
        p.id.toLowerCase().includes(needle) ||
        (p.name ?? "").toLowerCase().includes(needle)
      );
    });
  }, [props.catalog.providers, q, conn, src]);

  return (
    <div className="prov-catalog" data-testid="provider-catalog">
      <div className="agents-toolbar team-roster-toolbar">
        <input
          className="agents-search"
          type="search"
          placeholder="Search provider name or id…"
          aria-label="Search catalog providers"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="prov-chip-row" role="group" aria-label="Connection filter">
          {(
            [
              ["all", "All"],
              ["connected", "Connected"],
              ["disconnected", "Not connected"],
            ] as Array<[ConnFilter, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className="prov-chip"
              aria-pressed={conn === id}
              onClick={() => setConn(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <label>
          <span className="omo-sr-only">Source filter</span>
          <select
            className="prov-select"
            aria-label="Source filter"
            value={src}
            onChange={(e) => setSrc(e.target.value)}
          >
            <option value="all">all sources</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {sourceLabel(s as OpenCodeProviderCatalogEntry["source"])}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="muted prov-catalog-note">
        Adding a native provider stores a credential with OpenCode. It does
        not write provider.&lt;id&gt; to the user-level config.
      </p>

      <table className="data prov-table" role="table">
        <thead>
          <tr>
            <th>Provider</th>
            <th>Source</th>
            <th>Models</th>
            <th>Connection</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <CatalogRow
              key={p.id}
              entry={p}
              open={openId === p.id}
              authMode={authMode}
              onAuthMode={setAuthMode}
              onToggle={() => {
                setOpenId(openId === p.id ? null : p.id);
                setAuthMode("api");
              }}
              onChanged={props.onChanged}
            />
          ))}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5} className="muted">
                {props.catalog.providers.length === 0
                  ? "No providers reported by the backend."
                  : "No providers match the current filter."}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function CatalogRow(props: {
  entry: OpenCodeProviderCatalogEntry;
  open: boolean;
  authMode: "api" | "oauth";
  onAuthMode: (m: "api" | "oauth") => void;
  onToggle: () => void;
  onChanged?: () => void;
}) {
  const p = props.entry;
  const panelId = `catalog-auth-${p.id}`;
  return (
    <>
      <tr data-provider={p.id}>
        <td>
          <span className="prov-name">{providerDisplayName(p)}</span>
          {p.name && p.name !== p.id ? (
            <div className="mono muted">{p.id}</div>
          ) : null}
        </td>
        <td>{sourceLabel(p.source)}</td>
        <td>
          {p.modelCount !== undefined ? (
            p.modelCount
          ) : (
            <span className="muted">—</span>
          )}
        </td>
        <td>
          <span className="team-conn">
            <StatusDot tone={p.connected ? "ok" : "bad"} />
            {p.connected ? "Connected" : "Not connected"}
          </span>
        </td>
        <td className="prov-actions-cell">
          <Button
            size="sm"
            onClick={props.onToggle}
            aria-expanded={props.open}
            aria-controls={panelId}
          >
            {props.open ? "Close" : "Add"}
          </Button>
        </td>
      </tr>
      {props.open ? (
        <tr className="prov-catalog-detail-row">
          <td colSpan={5} id={panelId}>
            <div className="prov-auth-panel" data-testid={`catalog-auth-${p.id}`}>
              <div className="prov-chip-row" role="group" aria-label="Auth method">
                <button
                  type="button"
                  className="prov-chip"
                  aria-pressed={props.authMode === "api"}
                  onClick={() => props.onAuthMode("api")}
                >
                  API key
                </button>
                <button
                  type="button"
                  className="prov-chip"
                  aria-pressed={props.authMode === "oauth"}
                  onClick={() => props.onAuthMode("oauth")}
                >
                  OAuth
                </button>
              </div>
              {props.authMode === "api" ? (
                <ApiKeyForm providerId={p.id} compact onChanged={props.onChanged} />
              ) : (
                <OAuthFlow providerId={p.id} compact onDone={(ok) => { if (ok) props.onChanged?.(); }} />
              )}
              <TuiFallback providerId={p.id} />
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
