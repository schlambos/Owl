/**
 * Secret hygiene helpers for provider management. Secrets are never placed
 * in DTOs, logs, SSE payloads, revisions, or errors. These helpers are the
 * detection side; construction-side allowlists do the prevention.
 */

/** Scan a serialized payload for any planted secret value. */
export function containsPlantedSecret(serialized: string, secrets: string[]): boolean {
  return secrets.some((s) => s.length > 0 && serialized.includes(s));
}

/**
 * Redact every occurrence of the given secret values from a message.
 * Applied around outbound errors so a backend echo can never surface a key.
 */
export function redactSecrets(message: string, secrets: Array<string | undefined>): string {
  let out = message;
  for (const s of secrets) {
    if (!s) continue;
    out = out.split(s).join("[redacted]");
  }
  return out;
}
