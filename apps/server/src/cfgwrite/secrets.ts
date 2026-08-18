/**
 * Env secret handling: detection + masking. Used by ACP views, preview diffs,
 * revision metadata, and process output sanitization.
 */

const SECRET_KEY_RE =
  /(token|secret|password|passwd|credential|api[_-]?key|auth|private[_-]?key|access[_-]?key)/i;

const SECRET_VALUE_RE =
  /\b(sk-[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{6,}|ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{10,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,})\b/g;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

export function maskValue(v: string): string {
  if (v.length <= 4) return "••••";
  return `••••(${v.length} chars)`;
}

export function maskEnv(
  env: Record<string, string> | undefined,
): Record<string, string> {
  if (!env) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = isSecretKey(k) ? maskValue(String(v)) : String(v);
  }
  return out;
}

export function secretKeyCount(env: Record<string, string> | undefined): number {
  if (!env) return 0;
  return Object.keys(env).filter(isSecretKey).length;
}

/** Redact secret-looking tokens in arbitrary process output text. */
export function sanitizeOutput(
  text: string,
  env: Record<string, string> | undefined,
  maxChars = 4000,
): string {
  let out = text;
  if (env) {
    for (const [k, v] of Object.entries(env)) {
      if (isSecretKey(k) && v && v.length > 3) {
        out = out.split(v).join(`[REDACTED:${k}]`);
      }
    }
  }
  out = out.replace(SECRET_VALUE_RE, "[REDACTED:token]");
  if (out.length > maxChars) {
    out = out.slice(0, maxChars) + `\n…[truncated ${text.length - maxChars} chars]`;
  }
  return out;
}
