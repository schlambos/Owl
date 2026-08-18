/** Secret-safe normalization shared by lifecycle, REST, SSE and probes. */

const MESSAGE_CAP = 240;

export function sanitizeOpenCodeError(
  raw: unknown,
  explicitSecrets: Array<string | undefined> = [],
): string {
  let value: string;
  if (raw instanceof Error) value = raw.message;
  else if (typeof raw === "string") value = raw;
  else {
    try {
      value = JSON.stringify(raw) ?? String(raw);
    } catch {
      value = String(raw);
    }
  }

  for (const secret of explicitSecrets) {
    if (!secret) continue;
    value = value.split(secret).join("[redacted]");
  }
  value = value
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/\b(?:basic|bearer)\s+[A-Za-z0-9+/=._~-]+/gi, (m) =>
      `${m.split(/\s/, 1)[0]} [redacted]`)
    .replace(/(https?:\/\/[^\s?"'()[\]]*)[?#][^\s"'()[\]]*/gi, "$1")
    .replace(/\b(?:sk|pk|api|key|token|secret|password)-[A-Za-z0-9_-]{8,}\b/gi, "[redacted]")
    .replace(
      /(authorization|api[-_]?key|access[-_]?token|x-api-key|client[-_]?secret|password)\s*[:=]\s*[^\s,;"']+/gi,
      "$1: [redacted]",
    )
    .replace(/\s+/g, " ")
    .trim();
  if (!value) return "Unknown OpenCode error";
  return value.length > MESSAGE_CAP
    ? `${value.slice(0, MESSAGE_CAP - 3)}...`
    : value;
}

export interface OpenCodeBasicAuth {
  username: string;
  password: string;
}

/** OpenCode enables server Basic auth only when SERVER_PASSWORD is present. */
export function openCodeAuthFromEnv(
  env: Record<string, string | undefined> = process.env,
): OpenCodeBasicAuth | undefined {
  const password = env.OPENCODE_SERVER_PASSWORD;
  if (!password) return undefined;
  return {
    username: env.OPENCODE_SERVER_USERNAME || "opencode",
    password,
  };
}

export function basicAuthHeader(
  auth: OpenCodeBasicAuth | undefined,
): string | undefined {
  if (!auth) return undefined;
  return `Basic ${Buffer.from(`${auth.username}:${auth.password}`, "utf8").toString("base64")}`;
}
