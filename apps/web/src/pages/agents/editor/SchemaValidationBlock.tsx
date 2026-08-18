import { useState } from "react";
import type { SchemaValidationSummary } from "@omo/shared";

/**
 * OMO-Slim schema-validation block shown in the preview (simulation) and —
 * after a 422 apply — next to it. Three states:
 *   unavailable → warn   |   invalid → error   |   valid → success line
 */
export function SchemaValidationBlock(props: {
  sv: SchemaValidationSummary;
  /** Optional override; defaults to "OMO-Slim schema validation". */
  title?: string;
}) {
  const { sv } = props;
  const title = props.title ?? "OMO-Slim schema validation";
  const [rawOpen, setRawOpen] = useState(false);

  const issues = (sv.issues ?? []).filter(
    (iss) => iss && (iss.path || iss.message),
  );

  return (
    <div
      className={
        sv.unavailable ? "warn-block" : sv.ok ? "info-block" : "error"
      }
      data-testid="schema-validation"
    >
      <div>
        <strong>{title}</strong>{" "}
        {sv.unavailable ? (
          <span className="pill warn">schema unavailable</span>
        ) : sv.ok ? (
          <span className="pill ok">✓ valid</span>
        ) : (
          <span className="pill bad">✕ invalid</span>
        )}
      </div>
      <div>
        {sv.unavailable ? (
          "Installed schema unavailable — writes are blocked."
        ) : sv.ok ? (
          <>
            ✓ Valid against installed schema
            {sv.packageVersion ? ` ${sv.packageVersion}` : ""}
          </>
        ) : (
          "✕ Invalid"
        )}
      </div>
      {!sv.unavailable && !sv.ok && issues.length > 0 ? (
        <ul className="mono schema-issues">
          {issues.map((iss, i) => (
            <li key={i}>
              {iss.path || "(root)"} — {iss.message}
            </li>
          ))}
        </ul>
      ) : null}
      <button
        type="button"
        className="expand-toggle"
        onClick={() => setRawOpen((o) => !o)}
      >
        {rawOpen ? "▾ Hide raw schema details" : "▸ Raw schema details"}
      </button>
      {rawOpen ? (
        <pre className="msg-pre raw-json">{JSON.stringify(sv, null, 2)}</pre>
      ) : null}
    </div>
  );
}
