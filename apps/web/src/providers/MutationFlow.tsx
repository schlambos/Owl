/**
 * MutationFlow — the shared simulate → review → apply sequence for every
 * provider config mutation (add-custom, set-blacklist, set-enablement).
 *
 * Honest outcomes only: simulate errors block apply; apply failures render
 * the server's error list; restart results distinguish requested /
 * performed / failed so a silent no-restart never looks like a success.
 * The diff is rendered verbatim (the server already redacts secrets); API
 * keys go out write-only on apply and are never displayed back.
 */
import { useCallback, useEffect, useId, useState } from "react";
import type {
  OpenCodeProviderApplyResponse,
  OpenCodeProviderMutation,
  OpenCodeProviderSimulateResponse,
  OpenCodeProviderWriteTarget,
} from "@omo/shared";
import { api } from "../api";
import { Button } from "../components/ui/Button";
import {
  expectedSourceHashFor,
  statusErrorMessage,
  writeTargetBindsApply,
  writeTargetBlockReason,
} from "./format";

export const RESTART_WARNING =
  "Restarting OpenCode will destroy active sessions and interrupt running work.";

export const RESTART_NOT_PERFORMED_FALLBACK =
  "OMO cannot restart this backend. Restart OpenCode manually.";

interface MutationFlowProps {
  mutation: OpenCodeProviderMutation;
  writeTarget: OpenCodeProviderWriteTarget | null | undefined;
  /** Write-only key applied after the config write (add-custom). */
  authApiKey?: string;
  /** Offer the restart checkbox (default true). */
  showRestart?: boolean;
  /** Fires after a successful apply for cache refresh. */
  onApplied?: (result: OpenCodeProviderApplyResponse) => void;
  /** Optional secondary action next to Apply. */
  onCancel?: () => void;
  cancelLabel?: string;
}

export function MutationFlow(props: MutationFlowProps) {
  const {
    mutation,
    writeTarget,
    authApiKey,
    showRestart = true,
    onApplied,
    onCancel,
    cancelLabel = "Cancel",
  } = props;

  const mutationKey = JSON.stringify(mutation);
  const [sim, setSim] = useState<OpenCodeProviderSimulateResponse | null>(null);
  const [simError, setSimError] = useState<string | null>(null);
  const [simLoading, setSimLoading] = useState(true);
  const [wantRestart, setWantRestart] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applied, setApplied] = useState<OpenCodeProviderApplyResponse | null>(
    null,
  );
  const restartId = useId();

  useEffect(() => {
    let cancelled = false;
    setSimLoading(true);
    setSimError(null);
    setSim(null);
    setApplied(null);
    setApplyError(null);
    api
      .opencodeProviderSimulate({ mutation })
      .then((r) => {
        if (cancelled) return;
        if (!r.data || typeof r.data !== "object" || !Array.isArray((r.data as { errors?: unknown }).errors)) {
          setSimError(statusErrorMessage("Simulate", r.status, r.data));
          return;
        }
        if (r.status >= 400 && !r.data.ok) {
          // Still a well-formed simulate DTO: render its errors, block apply.
          setSim(r.data);
          return;
        }
        setSim(r.data);
      })
      .catch((e) => {
        if (!cancelled)
          setSimError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setSimLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mutationKey]);

  const blockReason = writeTargetBlockReason(writeTarget);
  const canApply =
    writeTargetBindsApply(writeTarget) &&
    sim !== null &&
    sim.ok &&
    !applyBusy &&
    applied === null;

  const onApply = useCallback(async () => {
    setApplyBusy(true);
    setApplyError(null);
    try {
      const hash = expectedSourceHashFor(writeTarget);
      const body: import("@omo/shared").OpenCodeProviderApplyRequest = {
        mutation,
        ...(hash ? { expectedSourceHash: hash } : {}),
        ...(authApiKey ? { auth: { apiKey: authApiKey } } : {}),
        ...(wantRestart ? { restart: true } : {}),
      };
      const r = await api.opencodeProviderApply(body);
      if (
        !r.data ||
        typeof r.data !== "object" ||
        !Array.isArray((r.data as { errors?: unknown }).errors)
      ) {
        setApplyError(statusErrorMessage("Apply", r.status, r.data));
        return;
      }
      setApplied(r.data);
      if (r.data.ok) onApplied?.(r.data);
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplyBusy(false);
    }
  }, [mutation, writeTarget, authApiKey, wantRestart, onApplied]);

  return (
    <div className="prov-flow" data-testid="mutation-flow">
      {simLoading ? (
        <p className="muted">Preparing preview…</p>
      ) : null}

      {simError ? (
        <div className="error" role="alert">
          {simError}
        </div>
      ) : null}

      {blockReason ? (
        <div className="warn-block" data-testid="mutation-flow-blocked">
          Apply unavailable. {blockReason}
        </div>
      ) : null}

      {sim && !sim.ok ? (
        <div className="error" role="alert" data-testid="mutation-flow-sim-errors">
          Simulate rejected the change:
          <ul className="prov-error-list">
            {sim.errors.map((e, i) => (
              <li key={i}>
                <span className="mono">{e.code}</span> {e.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {sim?.ok && !applied ? (
        <div className="prov-review" data-testid="mutation-flow-review">
          <div className="prov-review-head">
            <span className="prov-review-title">Config diff</span>
            {sim.targetPath ? (
              <span className="muted mono">{sim.targetPath}</span>
            ) : null}
          </div>
          {sim.diff ? (
            <pre className="msg-pre prov-diff">{sim.diff}</pre>
          ) : (
            <p className="muted">No config diff reported by the server.</p>
          )}

          {showRestart ? (
            <div className="prov-restart">
              <label className="prov-restart-label" htmlFor={restartId}>
                <input
                  id={restartId}
                  type="checkbox"
                  checked={wantRestart}
                  onChange={(e) => setWantRestart(e.target.checked)}
                />
                Restart OpenCode after applying
              </label>
              <p className="prov-restart-warning">{RESTART_WARNING}</p>
            </div>
          ) : null}

          <div className="prov-actions">
            <Button
              variant="primary"
              onClick={() => void onApply()}
              disabled={!canApply}
              data-testid="mutation-flow-apply"
            >
              {applyBusy ? "Applying…" : "Apply"}
            </Button>
            {onCancel ? (
              <Button variant="ghost" onClick={onCancel}>
                {cancelLabel}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {applyError ? (
        <div className="error" role="alert">
          {applyError}
        </div>
      ) : null}

      {applied ? <ApplyOutcome result={applied} /> : null}
    </div>
  );
}

/** Honest post-apply outcome, including partial applies. */
export function ApplyOutcome(props: { result: OpenCodeProviderApplyResponse }) {
  const r = props.result;
  if (!r.ok) {
    return (
      <div className="error" role="alert" data-testid="apply-outcome-failed">
        Apply failed:
        <ul className="prov-error-list">
          {r.errors.map((e, i) => (
            <li key={i}>
              <span className="mono">{e.code}</span> {e.message}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className="prov-outcome" data-testid="apply-outcome-ok">
      <div className="info-block" role="status">
        Change written
        {r.revisionId ? (
          <>
            {" "}
            · revision <span className="mono">{r.revisionId}</span>
          </>
        ) : null}
        {r.targetPath ? (
          <>
            {" "}
            · <span className="mono">{r.targetPath}</span>
          </>
        ) : null}
      </div>
      {r.authApplied === false ? (
        <div className="warn-block" data-testid="apply-outcome-auth-error">
          Config written but the API key was not stored.
          {r.authError ? ` ${r.authError}` : ""} Retry the key under Edit → API
          key.
        </div>
      ) : null}
      {r.restart?.requested ? (
        r.restart.performed ? (
          r.restart.ok === false ? (
            <div className="warn-block" data-testid="apply-outcome-restart-failed">
              Restart was attempted but did not complete.
              {r.restart.message ? ` ${r.restart.message}` : ""}
            </div>
          ) : (
            <div className="info-block" role="status">
              OpenCode restarted.
            </div>
          )
        ) : (
          <div className="warn-block" data-testid="apply-outcome-restart-not-performed">
            {r.restart.message?.trim()
              ? r.restart.message
              : RESTART_NOT_PERFORMED_FALLBACK}
          </div>
        )
      ) : (
        <p className="muted">
          Written without restart. Restart OpenCode to make the change live.
        </p>
      )}
    </div>
  );
}
