/**
 * ApiKeyForm — write-only API key store/rotate via PUT /auth, and remove
 * via DELETE /auth. The body is `{ key }` (the server wraps the type). The
 * key is never echoed or persisted client-side; after a successful write it
 * is discarded from state immediately.
 */
import { useId, useState } from "react";
import { api } from "../api";
import { Button } from "../components/ui/Button";
import { statusErrorMessage } from "./format";

export function ApiKeyForm(props: {
  providerId: string;
  /** Compact mode for the native catalog rows. */
  compact?: boolean;
  /** Fires after a store/remove succeeded (refresh data). */
  onChanged?: () => void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"put" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const inputId = useId();
  const errId = useId();

  const run = async (action: "put" | "delete") => {
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      if (action === "put") {
        const trimmed = key.trim();
        if (!trimmed) {
          setError("Enter an API key first.");
          return;
        }
        const r = await api.opencodeProviderSetAuth(props.providerId, {
          key: trimmed,
        });
        if (!r.data?.ok) {
          setError(statusErrorMessage("Store key", r.status, r.data));
          return;
        }
        setKey("");
        setNotice("Key stored. OpenCode accepted the credential.");
      } else {
        const r = await api.opencodeProviderRemoveAuth(props.providerId);
        if (!r.data?.ok) {
          setError(statusErrorMessage("Remove key", r.status, r.data));
          return;
        }
        setNotice("Key removed from the backend.");
        setConfirmRemove(false);
      }
      props.onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="prov-auth" data-testid="api-key-form">
      <div className={props.compact ? "prov-auth-row" : "prov-field"}>
        {!props.compact ? (
          <label className="prov-label" htmlFor={inputId}>
            New API key
          </label>
        ) : null}
        <input
          id={inputId}
          className="prov-input"
          type="password"
          autoComplete="new-password"
          placeholder={
            props.compact ? "New API key (write-only)" : "Paste key — write-only"
          }
          aria-label={props.compact ? `New API key for ${props.providerId}` : undefined}
          aria-describedby={error ? errId : undefined}
          aria-invalid={error ? true : undefined}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <Button
          variant="primary"
          onClick={() => void run("put")}
          disabled={busy !== null || key.trim() === ""}
        >
          {busy === "put" ? "Storing…" : "Store key"}
        </Button>
      </div>
      {!props.compact ? (
        <p className="prov-help">
          Write-only: the key is sent once and never shown again. Storing
          replaces any existing key. The old key is never displayed.
        </p>
      ) : null}
      {error ? (
        <div className="error prov-field-error" id={errId} role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <p className="muted" role="status">
          {notice}
        </p>
      ) : null}
      <div className="prov-actions">
        {confirmRemove ? (
          <>
            <span className="prov-restart-warning">
              Remove the stored key from the backend?
            </span>
            <Button
              variant="primary"
              onClick={() => void run("delete")}
              disabled={busy !== null}
              data-testid="api-key-remove-confirm"
            >
              {busy === "delete" ? "Removing…" : "Confirm remove"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => setConfirmRemove(false)}
              disabled={busy !== null}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={() => setConfirmRemove(true)}>
            Remove key
          </Button>
        )}
      </div>
    </div>
  );
}
