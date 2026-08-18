import { useState } from "react";
import type { ModelAvailability, ProviderDiagnostics } from "@omo/shared";
import { ChevronDown } from "lucide-react";
import { Button } from "../components/ui/Button";
import { StatusDot } from "../components/ui/StatusDot";
import { Surface } from "../components/ui/Surface";
import { ago, isProblemProbe } from "./presentation";

/**
 * Condensed provider summary surface. Replaces the per-provider card grid:
 * every provider is one compact row (connection, inventory counts, problem
 * markers). Full diagnostics — advertised/referenced/probed metrics, auth
 * methods, last successful probe, rate-limit note, catalog membership — and
 * the provider-scoped Probe Referenced action live behind the row's
 * progressive disclosure. No data is dropped.
 */
export function ProviderStrip(props: {
  providers: ProviderDiagnostics[];
  modelsByProvider: Map<string, ModelAvailability[]>;
  disabledReason: (providerConnected: boolean) => string | undefined;
  onProbeReferenced: (provider: ProviderDiagnostics, trigger: HTMLElement) => void;
}) {
  const { providers, modelsByProvider } = props;
  const connected = providers.filter((p) => p.connected).length;

  return (
    <Surface className="omo-models-strip" padding="sm">
      <div className="omo-models-strip-head">
        <h2 className="omo-models-strip-title">Providers</h2>
        <span className="omo-models-strip-headmeta muted">
          {connected} of {providers.length} connected
        </span>
      </div>
      <ul className="omo-models-strip-list">
        {providers.map((p) => (
          <ProviderRow
            key={p.providerId}
            p={p}
            models={modelsByProvider.get(p.providerId) ?? []}
            disabledReason={props.disabledReason(p.connected)}
            onProbeReferenced={(trigger) => props.onProbeReferenced(p, trigger)}
          />
        ))}
      </ul>
    </Surface>
  );
}

function ProviderRow(props: {
  p: ProviderDiagnostics;
  models: ModelAvailability[];
  disabledReason?: string;
  onProbeReferenced: (trigger: HTMLElement) => void;
}) {
  const { p, models } = props;
  const [open, setOpen] = useState(false);

  const probed = models.filter((m) => m.probe.state !== "never").length;
  const healthy = models.filter((m) => m.probe.state === "healthy").length;
  const notTested = models.length - probed;
  const referencedCount = models.filter((m) => m.usage.length > 0).length;
  const problems = models.filter((m) => isProblemProbe(m.probe.state)).length;
  const detailsId = `omo-provider-details-${p.providerId}`;

  return (
    <li className="omo-models-strip-row">
      <button
        type="button"
        className="omo-models-strip-toggle"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen((v) => !v)}
      >
        <StatusDot tone={p.connected ? "ok" : "bad"} />
        <span className="omo-models-strip-name">{p.name || p.providerId}</span>
        <span className="omo-models-strip-summary muted">
          <span className="omo-sr-only">
            {p.connected ? "Connected" : "Disconnected"} ·{" "}
          </span>
          <span className="omo-mono omo-models-strip-id">{p.providerId}</span>
          <span>
            {models.length} {models.length === 1 ? "model" : "models"} ·{" "}
            {referencedCount} referenced
          </span>
          {healthy > 0 ? <span>{healthy} healthy</span> : null}
          {problems > 0 ? (
            <span className="omo-models-strip-flag">
              {problems} {problems === 1 ? "problem" : "problems"}
            </span>
          ) : null}
          {p.recentRateLimitCount > 0 ? (
            <span className="omo-models-strip-flag">
              rate-limited {p.recentRateLimitCount}×
            </span>
          ) : null}
          {!p.known ? <span>not in catalog</span> : null}
          {!p.connected ? (
            <span className="omo-models-strip-flag">disconnected</span>
          ) : null}
        </span>
        <ChevronDown
          size={14}
          className="omo-models-strip-chev"
          data-open={open}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div id={detailsId} className="omo-models-strip-details">
          <div className="omo-models-strip-metrics">
            {p.connected ? "Connected" : "Disconnected"}
          </div>
          <div className="omo-models-strip-metrics">
            {p.advertisedCount} advertised · {p.referencedCount} referenced
          </div>
          <div className="omo-models-strip-metrics">
            {probed} probed · {healthy} healthy · {notTested} not tested
          </div>
          {p.authMethods.length > 0 ? (
            <div className="omo-models-strip-meta">
              Auth: {p.authMethods.map((a) => a.label).join(", ")}
            </div>
          ) : null}
          <div className="omo-models-strip-meta">
            {p.lastSuccessfulProbeAt
              ? `Last successful probe ${ago(p.lastSuccessfulProbeAt)}`
              : "No successful probe recorded"}
          </div>
          {p.recentRateLimitCount > 0 ? (
            <div className="omo-models-rate">
              Rate-limited {p.recentRateLimitCount}× recently
            </div>
          ) : null}
          {!p.known ? (
            <div className="omo-models-strip-meta">
              <span className="omo-badge">not in OpenCode catalog</span>
            </div>
          ) : null}
          <div className="omo-models-strip-actions">
            <Button
              size="sm"
              disabled={Boolean(props.disabledReason) || referencedCount === 0}
              title={
                props.disabledReason ?? "Probe this provider's referenced models"
              }
              onClick={(e) => props.onProbeReferenced(e.currentTarget)}
            >
              Probe Referenced ({referencedCount})
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
