/**
 * OAuthFlow — native provider OAuth via authorize/callback. `method` is the
 * numeric auth-method index OpenCode exposes for the provider. Responses:
 * `method: "auto"` → OpenCode owns the browser callback (open/show URL);
 * `method: "code"` → paste the code back through /oauth/callback.
 */
import { useId, useState } from "react";
import type { OpenCodeProviderOauthAuthorizeResponse } from "@omo/shared";
import { api } from "../api";
import { Button } from "../components/ui/Button";
import { IconButton } from "../components/ui/IconButton";
import { copyText, statusErrorMessage } from "./format";

export function OAuthFlow(props: {
  providerId: string;
  compact?: boolean;
  onDone?: (ok: boolean) => void;
}) {
  const [method, setMethod] = useState(0);
  const [busy, setBusy] = useState<"authorize" | "callback" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [auth, setAuth] = useState<OpenCodeProviderOauthAuthorizeResponse | null>(
    null,
  );
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const methodId = useId();
  const codeId = useId();

  const authorize = async () => {
    setBusy("authorize");
    setError(null);
    setNotice(null);
    try {
      const r = await api.opencodeProviderOauthAuthorize(props.providerId, {
        method,
      });
      if (!r.data?.ok) {
        setError(statusErrorMessage("Start authorization", r.status, r.data));
        setAuth(null);
        return;
      }
      setAuth(r.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setAuth(null);
    } finally {
      setBusy(null);
    }
  };

  const callback = async () => {
    setBusy("callback");
    setError(null);
    setNotice(null);
    try {
      const r = await api.opencodeProviderOauthCallback(props.providerId, {
        method,
        ...(code.trim() ? { code: code.trim() } : {}),
      });
      if (!r.data?.ok) {
        setError(statusErrorMessage("Submit code", r.status, r.data));
        return;
      }
      setNotice("Authorization completed. OpenCode accepted the credential.");
      setAuth(null);
      setCode("");
      props.onDone?.(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="prov-oauth" data-testid="oauth-flow">
      <div className={props.compact ? "prov-auth-row" : "prov-field"}>
        {!props.compact ? (
          <label className="prov-label" htmlFor={methodId}>
            Method index
          </label>
        ) : null}
        <input
          id={methodId}
          className="prov-input prov-input-narrow"
          type="number"
          min={0}
          inputMode="numeric"
          aria-label={
            props.compact
              ? `OAuth method index for ${props.providerId}`
              : undefined
          }
          value={method}
          onChange={(e) => setMethod(Math.max(0, Number(e.target.value) || 0))}
        />
        <Button
          variant="primary"
          onClick={() => void authorize()}
          disabled={busy !== null}
        >
          {busy === "authorize" ? "Starting…" : "Start authorization"}
        </Button>
      </div>
      {!props.compact ? (
        <p className="prov-help">
          Method index matches the auth methods OpenCode lists for this
          provider — 0 is the first.
        </p>
      ) : null}

      {error ? (
        <div className="error prov-field-error" role="alert">
          {error}
        </div>
      ) : null}

      {auth ? (
        <div className="prov-oauth-pending" data-testid="oauth-pending">
          {auth.url ? (
            <div className="prov-oauth-url">
              <a className="mono" href={auth.url} target="_blank" rel="noreferrer">
                {auth.url}
              </a>
              <IconButton
                label="Copy authorization URL"
                onClick={() => {
                  void copyText(auth.url ?? "").then((ok) => {
                    setCopied(ok);
                    if (ok) setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                {copied ? "✓" : "⧉"}
              </IconButton>
            </div>
          ) : null}
          {auth.instructions ? (
            <p className="prov-help">{auth.instructions}</p>
          ) : null}
          {auth.method === "auto" ? (
            <p className="muted">
              Follow the authorization page in your browser; OpenCode handles
              the callback itself.
            </p>
          ) : (
            <div className="prov-field">
              <label className="prov-label" htmlFor={codeId}>
                Authorization code
              </label>
              <div className="prov-auth-row">
                <input
                  id={codeId}
                  className="prov-input"
                  type="text"
                  autoComplete="off"
                  placeholder="Paste the code shown after authorization"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
                <Button
                  variant="primary"
                  onClick={() => void callback()}
                  disabled={busy !== null || code.trim() === ""}
                >
                  {busy === "callback" ? "Submitting…" : "Submit code"}
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {notice ? (
        <p className="muted" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

/** Copyable terminal fallback for CLI-authenticable providers. */
export function TuiFallback(props: { providerId: string }) {
  const [copied, setCopied] = useState(false);
  const cmd = `opencode auth login --provider ${props.providerId}`;
  return (
    <div className="prov-tui" data-testid="tui-fallback">
      <span className="prov-label">Terminal fallback</span>
      <div className="prov-tui-row">
        <code className="mono">{cmd}</code>
        <IconButton
          label="Copy terminal command"
          onClick={() => {
            void copyText(cmd).then((ok) => {
              setCopied(ok);
              if (ok) setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "✓" : "⧉"}
        </IconButton>
        {copied ? (
          <span className="muted" role="status">
            Copied.
          </span>
        ) : null}
      </div>
    </div>
  );
}
