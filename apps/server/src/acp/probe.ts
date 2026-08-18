/**
 * Explicit, user-triggered ACP handshake probe.
 * Direct spawn (no shell), only configured env, bounded timeout, terminate after.
 * Sends ACP initialize JSON-RPC over stdin (NDJSON) as AcpClient does.
 */

import { spawn } from "node:child_process";
import { sanitizeOutput } from "../cfgwrite/secrets";

export interface AcpProbeResult {
  ok: boolean;
  started: boolean;
  handshake: boolean;
  agentInfo?: {
    name?: string;
    version?: string;
    protocolVersion?: number;
  };
  elapsedMs: number;
  error?: string;
  stderrTail?: string;
  stdoutTail?: string;
  terminated: boolean;
}

const PROBE_TIMEOUT_MS = 12000;

export function probeAcp(opts: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}): Promise<AcpProbeResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const result: AcpProbeResult = {
      ok: false,
      started: false,
      handshake: false,
      elapsedMs: 0,
      terminated: false,
    };

    let child;
    try {
      // Minimal safe base env (PATH resolution only) + explicitly configured env.
      const baseEnv: Record<string, string> = {};
      for (const k of ["PATH", "HOME", "TMPDIR", "SHELL", "LANG", "LC_ALL"]) {
        const v = process.env[k];
        if (v) baseEnv[k] = v;
      }
      child = spawn(opts.command, opts.args ?? [], {
        cwd: opts.cwd,
        env: { ...baseEnv, ...(opts.env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
    } catch (e) {
      result.error = `spawn failed: ${e instanceof Error ? e.message : String(e)}`;
      result.elapsedMs = Date.now() - startedAt;
      return resolve(result);
    }

    result.started = true;
    let stdout = "";
    let stderr = "";
    let done = false;
    let buffer = "";

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      result.elapsedMs = Date.now() - startedAt;
      result.stderrTail = sanitizeOutput(stderr, opts.env, 2000);
      result.stdoutTail = sanitizeOutput(stdout, opts.env, 2000);
      try {
        child.kill("SIGTERM");
        result.terminated = true;
      } catch {
        /* */
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      if (!done) {
        result.error = result.handshake
          ? "handshake completed; probe window elapsed"
          : "probe timeout — no handshake response";
        finish();
      }
    }, PROBE_TIMEOUT_MS);

    child.stderr?.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    child.stdout?.on("data", (d) => {
      const s = String(d);
      stdout += s;
      if (stdout.length > 20000) stdout = stdout.slice(-20000);
      buffer += s;
      // NDJSON parse
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg.id === 1 && msg.result) {
            const r = msg.result as Record<string, unknown>;
            const info = (r.agentInfo ?? {}) as Record<string, unknown>;
            result.handshake = true;
            result.agentInfo = {
              name: typeof info.name === "string" ? info.name : undefined,
              version: typeof info.version === "string" ? info.version : undefined,
              protocolVersion:
                typeof r.protocolVersion === "number" ? r.protocolVersion : undefined,
            };
            result.ok = true;
            finish();
            return;
          }
          if (msg.id === 1 && msg.error) {
            result.error = `initialize error: ${JSON.stringify(msg.error)}`;
            finish();
            return;
          }
        } catch {
          /* non-JSON line; ignore */
        }
      }
    });
    child.on("error", (e) => {
      result.error = `process error: ${e.message}`;
      finish();
    });
    child.on("exit", (code) => {
      if (!done) {
        result.error = `process exited during probe (code ${code})`;
        finish();
      }
    });

    // send initialize request (matches OMO AcpClient params)
    try {
      const initReq = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "omo-control-plane", version: "0.1.0" },
        },
      });
      child.stdin?.write(initReq + "\n");
    } catch (e) {
      result.error = `stdin write failed: ${e instanceof Error ? e.message : String(e)}`;
      finish();
    }
  });
}
