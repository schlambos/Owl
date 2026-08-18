import { describe, expect, test } from "bun:test";
import type { ProvenanceBundle } from "@omo/shared";
import { DoctorEngine } from "./engine";
import type { DoctorInput } from "./input";
import { computeOverall } from "./severity";
import type { Diagnostic, DoctorSnapshot } from "./types";
import { buildCompanionState } from "../omo/companion";
import { buildInterviewState } from "../omo/interview";

function baseInput(overrides: Partial<DoctorInput> = {}): DoctorInput {
  const base: DoctorInput = {
    generatedAt: "2026-08-11T00:00:00Z",
    cp: {
      revisionDbOk: true,
      runtimeStoreStarted: true,
      configGeneration: 1,
      host: "127.0.0.1",
    },
    lifecycle: {
      mode: "attach",
      ownership: "external",
      status: "connected",
      baseUrl: "http://x",
      version: "1.18.14",
      generation: 1,
      projectDirectory: "/Users/matt/Repos/omo-slim",
      configDirectory: "/Users/matt/.config/opencode",
      authConfigured: false,
      ready: {
        health: true,
        configProviders: true,
        providers: true,
        agents: true,
        omo: true,
        omoExpected: true,
        rest: true,
        sse: true,
      },
      updatedAt: "2026-08-11T00:00:00Z",
    },
    connection: {
      rest: "connected",
      sse: "connected",
      stale: false,
      opencodeBaseUrl: "http://x",
    },
    health: { healthy: true, version: "1.18.14" },
    agents: [
      { name: "orchestrator", model: { providerID: "xai", modelID: "grok-4.5" } },
      { name: "explorer", model: { providerID: "ollama-cloud", modelID: "ds" } },
      { name: "librarian", model: { providerID: "ollama-cloud", modelID: "ds" } },
      { name: "oracle", model: { providerID: "openai", modelID: "gpt" } },
      { name: "designer", model: { providerID: "synthetic", modelID: "k" } },
      { name: "fixer", model: { providerID: "alibaba-token-plan", modelID: "q" } },
    ],
    providers: [
      { id: "xai", name: "xAI", connected: true, modelCount: 1, models: [] },
      { id: "ollama-cloud", name: "OC", connected: true, modelCount: 1, models: [] },
      { id: "openai", name: "OpenAI", connected: true, modelCount: 1, models: [] },
      { id: "synthetic", name: "S", connected: true, modelCount: 1, models: [] },
      { id: "alibaba-token-plan", name: "A", connected: true, modelCount: 1, models: [] },
    ],
    sessions: [],
    permissions: [],
    mcp: { context7: { status: "connected" } },
    config: { loadOk: true },
    provenance: {
      sources: [],
      properties: {
        "presets.openai.explorer.model": {
          path: "presets.openai.explorer.model",
          value: "ollama-cloud/ds",
          winner: { value: "ollama-cloud/ds", sourceId: "x", sourceLabel: "x", sourcePath: "p", stage: "preset", order: 1 },
          overridden: [],
          reason: "r",
        },
      },
      agents: {
        orchestrator: {
          name: "orchestrator", kind: "builtin", enabled: true,
          modelPrimary: "xai/grok-4.5", modelFallbacks: [], skills: [], mcps: [], provenance: [],
          hasInlinePrompt: false, hasOrchestratorPrompt: false,
          fieldProvenance: {},
        },
        explorer: {
          name: "explorer", kind: "builtin", enabled: true,
          modelPrimary: "ollama-cloud/ds", modelFallbacks: [], skills: [], mcps: [], provenance: [],
          hasInlinePrompt: false, hasOrchestratorPrompt: false,
          fieldProvenance: {},
        },
      },
      preset: "openai",
      filePreset: "openai",
      warnings: [],
      runtimePreset: { known: false, name: null, note: "x" },
      prompts: {},
      globals: {},
      rawMerged: {},
    },
    environment: {
      OPENCODE_CONFIG_DIR_SET: false,
      OPENCODE_BASE_URL_SET: true,
      OMO_CP_HOST: "127.0.0.1",
    },
    revisions: { reachable: true, count: 3 },
  };
  return { ...base, ...overrides };
}

function run(input: DoctorInput) {
  const eng = new DoctorEngine(() => input);
  return eng.evaluate(input);
}

describe("healthy baseline", () => {
  test("no errors on healthy input", () => {
    const snap = run(baseInput());
    const errors = snap.diagnostics.filter((d) => d.severity === "error");
    expect(errors.length).toBe(0);
    expect(snap.overall).not.toBe("error");
    expect(snap.system.openCodeVersion).toBe("1.18.14");
    expect(snap.system.runtimeStale).toBe(false);
  });
});

describe("OpenCode unreachable", () => {
  test("error overall + blocked prerequisites", () => {
    const snap = run(baseInput({
      lifecycle: {
        ...baseInput().lifecycle,
        status: "failed",
        ready: { ...baseInput().lifecycle.ready, health: false, rest: false, sse: false },
        error: {
          code: "attach-unavailable",
          message: "ECONNREFUSED",
          action: "Restore external OpenCode, then Retry.",
          retryable: true,
          at: "2026-08-11T00:00:00Z",
        },
      },
      health: { healthy: false, error: "ECONNREFUSED" },
      connection: { rest: "disconnected", sse: "disconnected", stale: true, opencodeBaseUrl: "http://x" },
    }));
    expect(snap.overall).toBe("error");
    const ids = snap.diagnostics.map((d) => d.id);
    expect(ids).toContain("opencode.lifecycle");
    expect(ids).not.toContain("providers.catalog");
    expect(ids).not.toContain("omo.registration");
  });
});

describe("SSE down, REST up", () => {
  test("warning runtime", () => {
    const snap = run(baseInput({
      connection: { rest: "connected", sse: "disconnected", stale: true, opencodeBaseUrl: "http://x", sseError: "ended" },
    }));
    expect(snap.overall).toBe("degraded");
    const rt = snap.diagnostics.find((d) => d.id === "runtime.sse-down");
    expect(rt?.severity).toBe("warning");
    expect(rt?.summary).toContain("reconcile");
  });
});

describe("lifecycle diagnostics", () => {
  test("restart is informational and does not create downstream cascades", () => {
    const baseline = baseInput();
    const snap = run(baseInput({
      lifecycle: {
        ...baseline.lifecycle,
        status: "restarting",
        ready: { ...baseline.lifecycle.ready, rest: false, sse: false },
        restart: {
          attempt: 2,
          maxAttempts: 5,
          nextRetryAt: "2026-08-11T00:00:02Z",
          lastReason: "connection lost",
        },
      },
      health: { healthy: false },
      providers: [],
      agents: [],
      sessions: [],
      mcp: {},
    }));
    expect(snap.diagnostics.find((d) => d.id === "opencode.lifecycle")?.severity).toBe("info");
    expect(snap.diagnostics.find((d) => d.id === "opencode.restart")?.severity).toBe("info");
    expect(snap.diagnostics.some((d) => d.id.startsWith("provider."))).toBe(false);
    expect(snap.diagnostics.some((d) => d.id.startsWith("sessions."))).toBe(false);
    expect(snap.diagnostics.some((d) => d.id.startsWith("caps.") && d.category === "mcp")).toBe(false);
  });

  test("managed failure produces one actionable lifecycle root cause", () => {
    const baseline = baseInput();
    const snap = run(baseInput({
      lifecycle: {
        ...baseline.lifecycle,
        mode: "managed",
        ownership: "control-plane",
        status: "failed",
        ready: { ...baseline.lifecycle.ready, rest: false, sse: false },
        error: {
          code: "managed-restart-exhausted",
          message: "startup failed",
          action: "Inspect startup error, then Retry.",
          retryable: true,
          at: baseline.lifecycle.updatedAt,
        },
      },
      health: { healthy: false },
    }));
    const roots = snap.diagnostics.filter((d) =>
      ["opencode.lifecycle", "opencode.reachable", "runtime.staleness"].includes(d.id) &&
      d.severity === "error");
    expect(roots.map((d) => d.id)).toEqual(["opencode.lifecycle"]);
    expect(roots[0]?.summary).toContain("Retry");
  });

  test("OMO registration failure is explicit after lifecycle readiness", () => {
    const snap = run(baseInput({ agents: [{ name: "build" }] }));
    expect(snap.diagnostics.find((d) => d.id === "omo.registration")?.severity).toBe("error");
  });

  test("terminal lifecycle OMO failure is the single registration root cause", () => {
    const baseline = baseInput();
    const snap = run(baseInput({
      lifecycle: {
        ...baseline.lifecycle,
        status: "failed",
        ready: { ...baseline.lifecycle.ready, omo: false, rest: false, sse: false },
        error: {
          code: "omo-registration-failed",
          message: "OMO-Slim agents are not registered in OpenCode /agent",
          action: "Restore OMO registration, then Retry.",
          retryable: true,
          at: baseline.lifecycle.updatedAt,
        },
      },
      health: { healthy: false },
    }));
    expect(snap.diagnostics.find((d) => d.id === "omo.registration")?.severity).toBe("error");
    expect(snap.diagnostics.find((d) => d.id === "opencode.lifecycle")).toBeUndefined();
  });

  test("intentional OMO disable is informational rather than registration error", () => {
    const input = baseInput({ agents: [{ name: "build" }] });
    input.environment.OH_MY_OPENCODE_SLIM_DISABLE = "1";
    input.lifecycle.ready.omoExpected = false;
    input.lifecycle.ready.omo = true;
    const snap = run(input);
    expect(snap.diagnostics.find((d) => d.id === "omo.registration")?.severity).toBe("info");
  });
});

describe("config failure", () => {
  test("config parse error", () => {
    const snap = run(baseInput({ config: { loadOk: false, loadError: "parse bad" }, provenance: undefined }));
    expect(snap.overall).toBe("error");
    expect(snap.diagnostics.find((d) => d.id === "config.parse")?.severity).toBe("error");
  });
});

describe("config.schema diagnostics", () => {
  test("valid installed schema status is healthy and includes the version", () => {
    const snap = run(
      baseInput({
        schema: {
          status: {
            available: true,
            packageVersion: "2.2.10",
            schemaHash: "abc123",
            userConfig: { present: true, valid: true, issues: [] },
            projectConfig: { present: false, valid: null, issues: [] },
          },
          revisionsScanned: 0,
          revisionsIncompatible: 0,
        },
      }),
    );
    const diag = snap.diagnostics.find((d) => d.id === "config.schema");
    expect(diag?.severity).toBe("healthy");
    expect(diag?.summary).toContain("2.2.10");
  });

  test("invalid user config is an error with normalized issue paths", () => {
    const snap = run(
      baseInput({
        schema: {
          status: {
            available: true,
            packageVersion: "2.2.10",
            userConfig: {
              present: true,
              valid: false,
              issues: [
                {
                  path: "agents.critic.model",
                  keyword: "type",
                  message: "must be string or array",
                },
              ],
            },
            projectConfig: { present: false, valid: null, issues: [] },
          },
          revisionsScanned: 1,
          revisionsIncompatible: 1,
        },
      }),
    );
    const diag = snap.diagnostics.find((d) => d.id === "config.schema");
    expect(diag?.severity).toBe("error");
    expect(diag?.summary).toContain("agents.critic.model");
    expect(diag?.summary).toContain("schema-valid mutation");
    expect(diag?.remediation?.target).toBe(
      "/config?tab=raw&sourceId=user-omo&path=agents.critic.model",
    );
    expect(diag?.sourceId).toBe("user-omo");
    expect(diag?.issuePath).toBe("agents.critic.model");
    expect(
      snap.diagnostics.find((d) => d.id === "revisions.schema-incompat")
        ?.severity,
    ).toBe("info");
  });

  test("schema unavailable warns that writes are blocked fail-closed", () => {
    const snap = run(
      baseInput({
        schema: {
          status: {
            available: false,
            error: "schema file missing",
            userConfig: { present: true, valid: false, issues: [] },
            projectConfig: { present: false, valid: null, issues: [] },
          },
          revisionsScanned: 0,
          revisionsIncompatible: 0,
        },
      }),
    );
    const diag = snap.diagnostics.find((d) => d.id === "config.schema");
    expect(diag?.severity).toBe("warning");
    expect(diag?.summary).toContain("blocked");
    expect(diag?.summary).toContain("fail-closed");
    expect(diag?.remediation?.target).toBe("/system?section=schema");
  });

  test("revision conflict links to revisions tab", () => {
    const snap = run(
      baseInput({
        revisions: { reachable: true, count: 1, conflictScopes: ["user"] },
      }),
    );
    const d = snap.diagnostics.find((x) => x.id === "revisions.conflict.user");
    expect(d?.remediation?.target).toBe("/config?tab=revisions&sourceId=user-omo");
  });
});

describe("prerequisite gating", () => {
  test("live diagnostics are suppressed while lifecycle is not ready", () => {
    const snap = run(baseInput({
      lifecycle: {
        ...baseInput().lifecycle,
        status: "starting",
        ready: { ...baseInput().lifecycle.ready, health: false, rest: false, sse: false },
      },
      health: { healthy: false, error: "down" },
    }));
    const prov = snap.diagnostics.find((d) => d.id === "providers.catalog");
    expect(prov).toBeUndefined();
    expect(snap.diagnostics.find((d) => d.id === "opencode.lifecycle")?.severity).toBe("info");
  });
});

describe("model drift live agent", () => {
  test("warning when stale=false", () => {
    const inp = baseInput();
    inp.agents = inp.agents.map((a) =>
      a.name === "explorer"
        ? { ...a, model: { providerID: "other", modelID: "m2" } }
        : a,
    );
    const snap = run(inp);
    const d = snap.diagnostics.find((x) => x.id === "agent.explorer.model-drift");
    expect(d?.severity).toBe("warning");
    expect(d?.summary).toContain("not inferred as fallback");
  });

  test("unknown when stale=true", () => {
    const inp = baseInput({
      connection: { rest: "connected", sse: "connected", stale: true, opencodeBaseUrl: "http://x" },
    });
    inp.agents = inp.agents.map((a) =>
      a.name === "explorer"
        ? { ...a, model: { providerID: "other", modelID: "m2" } }
        : a,
    );
    const snap = run(inp);
    const d = snap.diagnostics.find((x) => x.id === "agent.explorer.model-drift");
    expect(d?.severity).toBe("unknown");
  });
});

describe("missing enabled live agent", () => {
  test("warning", () => {
    const inp = baseInput();
    inp.agents = inp.agents.filter((a) => a.name !== "explorer");
    const snap = run(inp);
    expect(snap.diagnostics.find((d) => d.id === "agent.explorer.missing-live")?.severity).toBe("warning");
  });
});

describe("sessions", () => {
  test("active errors warn, idle fine", () => {
    const snap = run(baseInput({
      sessions: [
        { id: "s1", agent: "explorer", status: "idle" },
        { id: "s2", agent: "fixer", status: "error" },
      ],
    }));
    expect(snap.diagnostics.find((d) => d.id === "sessions.active-errors")?.severity).toBe("warning");
  });

  test("pending permission", () => {
    const snap = run(baseInput({
      permissions: [
        { id: "per1", sessionID: "s1", permission: "bash", patterns: ["rm *"], askedAt: "x", source: "permission.asked" },
      ],
    }));
    const d = snap.diagnostics.find((x) => x.id.startsWith("sessions.permission"));
    expect(d?.severity).toBe("warning");
  });
});

describe("severity policy", () => {
  test("computeOverall rules", () => {
    expect(computeOverall([])).toBe("healthy");
    expect(computeOverall([di("info")])).toBe("healthy");
    expect(computeOverall([di("unknown")])).toBe("healthy");
    expect(computeOverall([di("warning")])).toBe("degraded");
    expect(computeOverall([di("error")])).toBe("error");
    expect(computeOverall([di("warning"), di("error")])).toBe("error");
  });
});

function di(sev: Diagnostic["severity"]): Diagnostic {
  return {
    id: "t", category: "sessions", severity: sev,
    title: "t", summary: "s",
  };
}

// ── Slice 13: companion + interview (read-only subsystems) ──────────

function miniBundle(rawMerged: Record<string, unknown>): ProvenanceBundle {
  return {
    sources: [],
    properties: {},
    agents: {},
    warnings: [],
    runtimePreset: { known: false, name: null, note: "x" },
    prompts: {},
    globals: {},
    rawMerged,
  };
}

function companionState(
  raw?: Record<string, unknown>,
  opts: { roots?: string[]; probe?: (p: string) => boolean } = {},
) {
  const roots = opts.roots ?? ["/proj"];
  return buildCompanionState(
    miniBundle(raw ? { companion: raw } : {}),
    "/proj",
    roots,
    {},
    opts.probe ? { existsProbe: opts.probe } : {},
  );
}

function interviewState(
  raw?: Record<string, unknown>,
  opts: { roots?: string[]; env?: Record<string, string | undefined> } = {},
) {
  const roots = opts.roots ?? ["/proj"];
  return buildInterviewState(
    miniBundle(raw ? { interview: raw } : {}),
    "/proj",
    roots,
    opts.env ?? {},
  );
}

describe("doctor: companion", () => {
  test("disabled → single healthy companion diagnostic, no warnings", () => {
    const snap = run(baseInput({ companion: companionState() }));
    const companion = snap.diagnostics.filter((d) => d.category === "companion");
    expect(companion.map((d) => d.id)).toEqual(["companion.disabled"]);
    expect(companion[0]?.severity).toBe("healthy");
    expect(snap.overall).toBe("healthy");
  });

  test("enabled + binary outside scope → info, no warning", () => {
    const snap = run(
      baseInput({
        companion: companionState({ enabled: true, binaryPath: "/opt/x/bin" }),
      }),
    );
    const d = snap.diagnostics.find((x) => x.id === "companion.enabled");
    expect(d?.severity).toBe("info");
    expect(d?.summary).toContain("outside authorized control-plane scope");
    expect(
      snap.diagnostics.filter((x) => x.category === "companion" && x.severity === "warning"),
    ).toEqual([]);
    expect(snap.overall).toBe("healthy");
  });

  test("enabled + in-scope missing binary → warning, overall degraded", () => {
    const snap = run(
      baseInput({
        companion: companionState(
          { enabled: true, binaryPath: "/proj/bin/x" },
          { probe: () => false },
        ),
      }),
    );
    const d = snap.diagnostics.find((x) => x.id === "companion.enabled");
    expect(d?.severity).toBe("warning");
    expect(d?.summary).toContain("binary missing");
    expect(snap.overall).toBe("degraded");
  });

  test("enabled + in-scope binary present → healthy", () => {
    const snap = run(
      baseInput({
        companion: companionState(
          { enabled: true, binaryPath: "/proj/bin/x" },
          { probe: () => true },
        ),
      }),
    );
    const d = snap.diagnostics.find((x) => x.id === "companion.enabled");
    expect(d?.severity).toBe("healthy");
    expect(snap.overall).toBe("healthy");
  });

  test("unknown field → info", () => {
    const snap = run(baseInput({ companion: companionState({ fooBar: 1 }) }));
    const u = snap.diagnostics.find((x) => x.id.startsWith("companion.unknown-field"));
    expect(u?.severity).toBe("info");
    expect(u?.summary).toContain("stripped by OMO zod");
    expect(snap.overall).toBe("healthy");
  });

  test("invalid enum → warning", () => {
    const snap = run(
      baseInput({ companion: companionState({ position: "sideways" }) }),
    );
    const d = snap.diagnostics.find((x) => x.id === "companion.invalid-enum.position");
    expect(d?.severity).toBe("warning");
    expect(d?.summary).toContain("value ignored");
    expect(snap.overall).toBe("degraded");
  });
});

describe("doctor: interview", () => {
  test("valid config → healthy diagnostic", () => {
    const snap = run(baseInput({ interview: interviewState() }));
    const d = snap.diagnostics.find((x) => x.id === "interview.valid");
    expect(d?.severity).toBe("healthy");
    expect(snap.overall).toBe("healthy");
  });

  test("invalid maxQuestions → warning, no valid diagnostic", () => {
    const snap = run(baseInput({ interview: interviewState({ maxQuestions: 0 }) }));
    const w = snap.diagnostics.filter((x) => x.id.startsWith("interview.invalid-field"));
    expect(w[0]?.remediation?.target).toContain("/config?tab=raw&sourceId=");
    expect(w[0]?.remediation?.target).toContain("path=interview.maxQuestions");
    expect(w.length).toBeGreaterThan(0);
    expect(w[0]?.severity).toBe("warning");
    expect(snap.diagnostics.find((x) => x.id === "interview.valid")).toBeUndefined();
    expect(snap.overall).toBe("degraded");
  });

  test("port -1 → warning", () => {
    const snap = run(baseInput({ interview: interviewState({ port: -1 }) }));
    expect(
      snap.diagnostics.some(
        (x) => x.id.startsWith("interview.invalid-field") && x.severity === "warning",
      ),
    ).toBe(true);
    expect(snap.overall).toBe("degraded");
  });

  test("unknown field → info", () => {
    const snap = run(
      baseInput({ interview: interviewState({ magicDashboardMode: true }) }),
    );
    const u = snap.diagnostics.find((x) => x.id.startsWith("interview.unknown-field"));
    expect(u?.severity).toBe("info");
    expect(snap.overall).toBe("healthy");
  });

  test("output outside authorized scope → info only", () => {
    const snap = run(
      baseInput({ interview: interviewState({}, { roots: ["/other"] }) }),
    );
    const d = snap.diagnostics.find((x) => x.id === "interview.output-scope");
    expect(d?.severity).toBe("info");
    expect(snap.overall).toBe("healthy");
  });

  test("unknown runtime state emits no warning or error", () => {
    const st = interviewState();
    expect(st.runtime.observable).toBe(false);
    const snap = run(baseInput({ interview: st }));
    expect(
      snap.diagnostics.filter(
        (x) =>
          x.category === "interview" &&
          (x.severity === "warning" || x.severity === "error"),
      ),
    ).toEqual([]);
  });

  test("info-only companion/interview diagnostics never degrade overall", () => {
    const snap = run(
      baseInput({
        companion: companionState({
          fooBar: 1,
          enabled: true,
          binaryPath: "/opt/x/bin",
        }),
        interview: interviewState({ magicDashboardMode: true }, { roots: ["/other"] }),
      }),
    );
    const severities = snap.diagnostics
      .filter((x) => x.category === "companion" || x.category === "interview")
      .map((x) => x.severity);
    expect(severities.length).toBeGreaterThan(0);
    expect(severities).not.toContain("warning");
    expect(severities).not.toContain("error");
    expect(snap.overall).toBe("healthy");
  });
});

// ── OMO runtime telemetry (category "telemetry") ───────────────────────────

describe("doctor: omo runtime telemetry", () => {
  type Tele = NonNullable<DoctorInput["omoTelemetry"]>;
  const tele = (overrides: Partial<Tele> = {}): Tele => ({
    bridgeConfigured: false,
    bridgeConnected: false,
    jobCount: 2,
    orphanJobs: [],
    timedOutJobs: [],
    recentErrors: [],
    stale: false,
    ...overrides,
  });
  const teleDiags = (snap: DoctorSnapshot) =>
    snap.diagnostics.filter((x) => x.category === "telemetry");

  test("absent telemetry input → zero telemetry diagnostics (conservative silence)", () => {
    const snap = run(baseInput()); // no omoTelemetry key
    expect(teleDiags(snap)).toEqual([]);
  });

  test("bridge unconfigured → zero bridge diagnostics and zero warnings/errors", () => {
    const snap = run(baseInput({ omoTelemetry: tele() }));
    const diags = teleDiags(snap);
    expect(diags.find((d) => d.id === "telemetry.bridge-down")).toBeUndefined();
    expect(diags.find((d) => d.id === "telemetry.bridge-schema")).toBeUndefined();
    expect(diags.filter((d) => d.severity === "warning" || d.severity === "error")).toEqual([]);
    // Only the activity diagnostic, healthy because jobs exist.
    expect(diags.map((d) => d.id)).toEqual(["telemetry.activity"]);
    expect(diags[0]!.severity).toBe("healthy");
    expect(snap.overall).toBe("healthy");
  });

  test("bridge configured but down → info only; never degrades", () => {
    const snap = run(
      baseInput({ omoTelemetry: tele({ bridgeConfigured: true, bridgeConnected: false }) }),
    );
    const down = teleDiags(snap).find((d) => d.id === "telemetry.bridge-down");
    expect(down?.severity).toBe("info");
    expect(snap.overall).toBe("healthy");
    // Connected bridge → no bridge-down diagnostic at all.
    const ok = run(
      baseInput({ omoTelemetry: tele({ bridgeConfigured: true, bridgeConnected: true, bridgeSchema: 1 }) }),
    );
    expect(teleDiags(ok).find((d) => d.id === "telemetry.bridge-down")).toBeUndefined();
  });

  test("bridge schema 1, 2, and 3 accepted; schema 4 → warning (degraded)", () => {
    // Schema 1 → accepted (no warning)
    const ok1 = run(
      baseInput({ omoTelemetry: tele({ bridgeConfigured: true, bridgeConnected: true, bridgeSchema: 1 }) }),
    );
    expect(teleDiags(ok1).find((d) => d.id === "telemetry.bridge-schema")).toBeUndefined();

    // Schema 2 → accepted (no warning) — v2 adds whitelisted records
    const ok2 = run(
      baseInput({ omoTelemetry: tele({ bridgeConfigured: true, bridgeConnected: true, bridgeSchema: 2 }) }),
    );
    expect(teleDiags(ok2).find((d) => d.id === "telemetry.bridge-schema")).toBeUndefined();

    // Schema 3 → accepted (no warning) — v3 is the current authoritative schema
    const ok3 = run(
      baseInput({ omoTelemetry: tele({ bridgeConfigured: true, bridgeConnected: true, bridgeSchema: 3 }) }),
    );
    expect(teleDiags(ok3).find((d) => d.id === "telemetry.bridge-schema")).toBeUndefined();

    // Schema 4 → warning (unsupported)
    const snap = run(
      baseInput({ omoTelemetry: tele({ bridgeConfigured: true, bridgeConnected: true, bridgeSchema: 4 }) }),
    );
    const schema = teleDiags(snap).find((d) => d.id === "telemetry.bridge-schema");
    expect(schema?.severity).toBe("warning");
    expect(snap.overall).toBe("degraded");
  });

  test("orphan jobs: suppressed inside 60s grace, warning after", () => {
    const now = Date.now();
    // Within grace (30s ago) → suppressed.
    const fresh = run(
      baseInput({
        omoTelemetry: tele({
          orphanJobs: ["ses_orphan1"],
          orphanMissingSince: { ses_orphan1: now - 30_000 },
        }),
      }),
    );
    expect(teleDiags(fresh).find((d) => d.id === "telemetry.job-orphan.ses_orphan1")).toBeUndefined();
    expect(fresh.overall).toBe("healthy");

    // Beyond grace (90s ago) → warning, overall degraded.
    const old = run(
      baseInput({
        omoTelemetry: tele({
          orphanJobs: ["ses_orphan1"],
          orphanMissingSince: { ses_orphan1: now - 90_000 },
        }),
      }),
    );
    const orphan = teleDiags(old).find((d) => d.id === "telemetry.job-orphan.ses_orphan1");
    expect(orphan?.severity).toBe("warning");
    expect(old.overall).toBe("degraded");
  });

  test("orphan without missingSince timestamp never warns (conservative)", () => {
    const snap = run(
      baseInput({ omoTelemetry: tele({ orphanJobs: ["ses_orphanX"] }) }),
    );
    expect(teleDiags(snap).find((d) => d.id.startsWith("telemetry.job-orphan"))).toBeUndefined();
  });

  test("job-timeout warns only for OMO-declared timedOut jobs", () => {
    const snap = run(baseInput({ omoTelemetry: tele({ timedOutJobs: ["ses_t1"] }) }));
    const timeout = teleDiags(snap).find((d) => d.id === "telemetry.job-timeout.ses_t1");
    expect(timeout?.severity).toBe("warning");
    const none = run(baseInput({ omoTelemetry: tele() }));
    expect(teleDiags(none).find((d) => d.id.startsWith("telemetry.job-timeout"))).toBeUndefined();
  });

  test("recent job errors + stale snapshot → info only, never degrades", () => {
    const snap = run(
      baseInput({
        omoTelemetry: tele({ recentErrors: ["ses_e1", "ses_e2"], stale: true }),
      }),
    );
    const diags = teleDiags(snap);
    expect(diags.find((d) => d.id === "telemetry.job-errors")?.severity).toBe("info");
    expect(diags.find((d) => d.id === "telemetry.stale")?.severity).toBe("info");
    expect(diags.map((d) => d.severity)).not.toContain("warning");
    expect(diags.map((d) => d.severity)).not.toContain("error");
    expect(snap.overall).toBe("healthy");
  });

  test("no job activity → info activity diagnostic", () => {
    const snap = run(baseInput({ omoTelemetry: tele({ jobCount: 0 }) }));
    const activity = teleDiags(snap).find((d) => d.id === "telemetry.activity");
    expect(activity?.severity).toBe("info");
    expect(snap.overall).toBe("healthy");
  });
});

// ── Slice 15: probe-aware model diagnostics (rules-models.ts) ────────────
// ADDITIVE Lane 5a cases; fixtures compose ModelAvailability input directly.

import type { ModelAvailability } from "@omo/shared";

function mAvail(
  over: Partial<ModelAvailability> &
    Pick<ModelAvailability, "providerId" | "modelId">,
): ModelAvailability {
  return {
    configured: true,
    provider: { known: true, connected: true },
    advertised: true,
    probe: { state: "never", freshness: "never" },
    capabilities: { state: "unknown", source: "none" },
    lastUpdatedAt: "2026-08-11T00:00:00Z",
    usage: [],
    ...over,
  };
}

function mUsage(over: Partial<ModelAvailability["usage"][number]>): ModelAvailability["usage"][number] {
  return {
    kind: "agent-primary",
    ownerId: "fixer",
    label: "fixer",
    active: true,
    fallback: false,
    ...over,
  };
}

function freshProbe(
  state: ModelAvailability["probe"]["state"],
  over: Partial<ModelAvailability["probe"]> = {},
): ModelAvailability["probe"] {
  return {
    state,
    freshness: "fresh",
    lastCompletedAt: "2026-08-11T23:00:00Z",
    ...over,
  };
}

function providerDiag(
  providerId: string,
  over: Partial<NonNullable<DoctorInput["modelInventory"]>["providers"][number]> = {},
): NonNullable<DoctorInput["modelInventory"]>["providers"][number] {
  return {
    providerId,
    known: true,
    connected: true,
    advertisedCount: 1,
    referencedCount: 1,
    authMethods: [],
    recentFailureCounts: {},
    recentRateLimitCount: 0,
    ...over,
  };
}

function modelInput(
  models: ModelAvailability[],
  providers: NonNullable<DoctorInput["modelInventory"]>["providers"] = [],
  overrides: Partial<DoctorInput> = {},
): DoctorInput {
  return baseInput({
    modelInventory: { probeStoreAvailable: true, models, providers },
    ...overrides,
  });
}

describe("slice15: probe-aware model rules", () => {
  test("absent modelInventory → zero model diagnostics + modelHealth undefined", () => {
    const snap = run(baseInput());
    expect(snap.diagnostics.filter((d) => d.category === "models")).toEqual([]);
    expect(snap.modelHealth).toBeUndefined();
  });

  test("never-probed / stale-only → NO diagnostic", () => {
    const snap = run(modelInput([
      mAvail({ providerId: "p", modelId: "a", probe: { state: "never", freshness: "never" }, usage: [mUsage({})] }),
      mAvail({ providerId: "p", modelId: "b", probe: { state: "unauthorized", freshness: "stale", lastCompletedAt: "2026-08-01T00:00:00Z" }, usage: [mUsage({})] }),
    ], [providerDiag("p")]));
    expect(snap.diagnostics.filter((d) => d.category === "models")).toEqual([]);
    expect(snap.overall).toBe("healthy");
  });

  test("latest probe aborted → silent", () => {
    const snap = run(modelInput([
      mAvail({ providerId: "p", modelId: "a", probe: freshProbe("error", { errorCode: "aborted" }), usage: [mUsage({ ownerId: "orchestrator" })] }),
    ], [providerDiag("p")]));
    expect(snap.diagnostics.filter((d) => d.category === "models")).toEqual([]);
  });

  test("active primary fresh unauthorized → warning", () => {
    const snap = run(modelInput([
      mAvail({ providerId: "p", modelId: "a", probe: freshProbe("unauthorized", { statusCode: 401, errorMessage: "bad key" }), usage: [mUsage({ ownerId: "fixer" })] }),
    ], [providerDiag("p")]));
    const diag = snap.diagnostics.find((d) => d.id === "model.p.a.probe-unauthorized");
    expect(diag?.severity).toBe("warning");
    expect(snap.overall).toBe("degraded");
  });

  test("orchestrator primary, no fresh-healthy fallback → error", () => {
    const snap = run(modelInput([
      mAvail({ providerId: "p", modelId: "main", probe: freshProbe("unauthorized"), usage: [mUsage({ ownerId: "orchestrator" })] }),
      mAvail({ providerId: "p", modelId: "fb", probe: freshProbe("error"), usage: [mUsage({ kind: "agent-fallback", ownerId: "orchestrator", fallback: true })] }),
    ], [providerDiag("p")]));
    expect(snap.diagnostics.find((d) => d.id === "model.p.main.probe-unauthorized")?.severity).toBe("error");
    expect(snap.overall).toBe("error");
  });

  test("orchestrator primary + fresh-healthy fallback → downgrade to warning with fallback evidence", () => {
    const snap = run(modelInput([
      mAvail({ providerId: "p", modelId: "main", probe: freshProbe("model-not-found"), usage: [mUsage({ ownerId: "orchestrator" })] }),
      mAvail({ providerId: "p", modelId: "fb", probe: freshProbe("healthy"), usage: [mUsage({ kind: "agent-fallback", ownerId: "orchestrator", fallback: true })] }),
    ], [providerDiag("p")]));
    const diag = snap.diagnostics.find((d) => d.id === "model.p.main.probe-model-not-found");
    expect(diag?.severity).toBe("warning");
    expect(diag?.evidence?.some((e) => e.label.startsWith("fallback"))).toBe(true);
    expect(snap.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  test("oracle primary → warning, never error", () => {
    const snap = run(modelInput([
      mAvail({ providerId: "p", modelId: "g", probe: freshProbe("unauthorized"), usage: [mUsage({ ownerId: "oracle" })] }),
    ], [providerDiag("p")]));
    expect(snap.diagnostics.find((d) => d.id === "model.p.g.probe-unauthorized")?.severity).toBe("warning");
    expect(snap.diagnostics.filter((d) => d.category === "models" && d.severity === "error")).toEqual([]);
  });

  test("inactive (inactive-preset-only council member) fresh failure → info", () => {
    const snap = run(modelInput([
      mAvail({ providerId: "p", modelId: "c", probe: freshProbe("unauthorized"), usage: [mUsage({ kind: "council-member", ownerId: "council.cheap.x", active: false })] }),
    ], [providerDiag("p")]));
    expect(snap.diagnostics.find((d) => d.id === "model.p.c.probe-unauthorized")?.severity).toBe("info");
    expect(snap.overall).toBe("healthy");
  });

  test("rate-limited: generic referenced → info; orchestrator primary → warning; provider rollup → one info", () => {
    const snap = run(modelInput([
      mAvail({ providerId: "p", modelId: "r1", probe: freshProbe("rate-limited"), usage: [mUsage({ ownerId: "fixer" })] }),
      mAvail({ providerId: "p", modelId: "r2", probe: freshProbe("rate-limited"), usage: [mUsage({ ownerId: "orchestrator" })] }),
    ], [providerDiag("p", { recentRateLimitCount: 2 })]));
    expect(snap.diagnostics.find((d) => d.id === "model.p.r1.probe-rate-limited")?.severity).toBe("info");
    expect(snap.diagnostics.find((d) => d.id === "model.p.r2.probe-rate-limited")?.severity).toBe("warning");
    const rollups = snap.diagnostics.filter((d) => d.id === "provider.p.recent-rate-limited");
    expect(rollups).toHaveLength(1);
    expect(rollups[0]?.severity).toBe("info");
  });

  test("timeout on active primary → warning with uncertainty wording; inactive → info", () => {
    const snap = run(modelInput([
      mAvail({ providerId: "p", modelId: "t1", probe: freshProbe("timeout"), usage: [mUsage({ ownerId: "fixer" })] }),
      mAvail({ providerId: "p", modelId: "t2", probe: freshProbe("timeout"), usage: [mUsage({ ownerId: "dead", active: false })] }),
    ], [providerDiag("p")]));
    const w = snap.diagnostics.find((d) => d.id === "model.p.t1.probe-timeout");
    expect(w?.severity).toBe("warning");
    expect(w?.summary).toContain("transient");
    expect(w?.summary).toContain("uncertain");
    expect(snap.diagnostics.find((d) => d.id === "model.p.t2.probe-timeout")?.severity).toBe("info");
  });

  test("provider-down dedup: ONE root info + relatedDiagnosticIds, no per-model flood", () => {
    const inp = modelInput([
      mAvail({ providerId: "down", modelId: "m1", provider: { known: true, connected: false }, probe: freshProbe("provider-disconnected"), usage: [mUsage({ ownerId: "fixer" })] }),
      mAvail({ providerId: "down", modelId: "m2", provider: { known: true, connected: false }, probe: freshProbe("opencode-disconnected"), usage: [mUsage({ ownerId: "librarian" })] }),
    ], [providerDiag("down", { connected: false })], {
      provenance: {
        ...baseInput().provenance!,
        agents: {
          fixer: {
            name: "fixer", kind: "builtin", enabled: true,
            modelPrimary: "down/m1", modelFallbacks: [], skills: [], mcps: [], provenance: [],
            hasInlinePrompt: false, hasOrchestratorPrompt: false, fieldProvenance: {},
          },
        } as never,
      },
      providers: [{ id: "down", name: "D", connected: false, modelCount: 2, models: [] }],
    });
    const snap = run(inp);
    const agg = snap.diagnostics.find((d) => d.id === "provider.down.probes-blocked-disconnected");
    expect(agg?.severity).toBe("info");
    expect(agg?.relatedDiagnosticIds).toEqual(["provider.down.disconnected-active"]);
    // Existing root warning from providerModelRules remains the single warn.
    const root = snap.diagnostics.find((d) => d.id === "provider.down.disconnected-active");
    expect(root?.severity).toBe("warning");
    // No per-model probe diagnostics for the down provider.
    expect(
      snap.diagnostics.filter(
        (d) => d.id.startsWith("model.down.") && d.id.includes("probe-"),
      ),
    ).toEqual([]);
    const modelCatWarnings = snap.diagnostics.filter(
      (d) => d.category === "models" && (d.severity === "warning" || d.severity === "error"),
    );
    expect(modelCatWarnings).toEqual([]);
  });

  test("unadvertised: active → warning advisory wording; inactive → info", () => {
    const snap = run(modelInput([
      mAvail({ providerId: "p", modelId: "u1", advertised: false, usage: [mUsage({})] }),
      mAvail({ providerId: "p", modelId: "u2", advertised: false, usage: [mUsage({ ownerId: "dead", active: false })] }),
    ], [providerDiag("p", { advertisedCount: 0 })]));
    const w = snap.diagnostics.find((d) => d.id === "model.p.u1.unadvertised");
    expect(w?.severity).toBe("warning");
    expect(w?.summary).toContain("not advertised by the OpenCode catalog");
    expect(w?.summary).toContain("may still work — probe to verify");
    expect(snap.diagnostics.find((d) => d.id === "model.p.u2.unadvertised")?.severity).toBe("info");
  });

  test("tool-capability mismatch: tools allowed + toolcall=false → warning; unknown capabilities → silent", () => {
    const inp = modelInput([
      mAvail({ providerId: "p", modelId: "nt", capabilities: { state: "known", tools: false, source: "opencode:/config/providers" }, usage: [mUsage({ ownerId: "fixer" })] }),
      mAvail({ providerId: "p", modelId: "unk", capabilities: { state: "partial", source: "opencode:/config/providers" }, usage: [mUsage({ ownerId: "fixer" })] }),
    ], [providerDiag("p")], {
      capabilities: {
        skills: [], mcps: [], tools: [],
        agents: [{
          agent: "fixer",
          skills: { mode: "unset", allowed: [], denied: [], configuredUnknown: [], globallyDisabled: [] },
          mcps: { mode: "unset", allowed: [], denied: [], configuredUnknown: [], globallyDisabled: [] },
          permissionSummary: "x",
          tools: { read: "allow", edit: "unset" },
        }],
        globals: { disabled_skills: [], disabled_mcps: [], disabled_tools: [], disabled_agents: [] },
      },
    });
    const snap = run(inp);
    expect(snap.diagnostics.find((d) => d.id === "model.p.nt.capability-tools")?.severity).toBe("warning");
    expect(snap.diagnostics.some((d) => d.id.includes("unk") && d.id.includes("capability"))).toBe(false);
  });

  test("fully-denied envelope → NO tool-capability warning (never role inference)", () => {
    const inp = modelInput([
      mAvail({ providerId: "p", modelId: "nt", capabilities: { state: "known", tools: false, source: "opencode:/config/providers" }, usage: [mUsage({ ownerId: "fixer" })] }),
    ], [providerDiag("p")], {
      capabilities: {
        skills: [], mcps: [], tools: [],
        agents: [{
          agent: "fixer",
          skills: { mode: "unset", allowed: [], denied: [], configuredUnknown: [], globallyDisabled: [] },
          mcps: { mode: "unset", allowed: [], denied: [], configuredUnknown: [], globallyDisabled: [] },
          permissionSummary: "x",
          tools: { read: "deny", edit: "deny", bash: "deny" },
        }],
        globals: { disabled_skills: [], disabled_mcps: [], disabled_tools: [], disabled_agents: [] },
      },
    });
    const snap = run(inp);
    expect(snap.diagnostics.find((d) => d.id === "model.p.nt.capability-tools")).toBeUndefined();
  });

  test("observer vision: enabled + vision=false → warning; unknown vision → silent", () => {
    const inp = modelInput([
      mAvail({ providerId: "p", modelId: "nv", capabilities: { state: "known", vision: false, source: "opencode:/config/providers" }, usage: [mUsage({ ownerId: "observer" })] }),
      mAvail({ providerId: "p", modelId: "uk", capabilities: { state: "known", source: "opencode:/config/providers" }, usage: [mUsage({ ownerId: "observer" })] }),
      mAvail({ providerId: "p", modelId: "pc", capabilities: { state: "partial", source: "opencode:/config/providers" }, usage: [mUsage({ ownerId: "observer" })] }),
    ], [providerDiag("p")]);
    const snap = run(inp);
    expect(snap.diagnostics.find((d) => d.id === "model.p.nv.observer-vision")?.severity).toBe("warning");
    expect(snap.diagnostics.find((d) => d.id === "model.p.uk.observer-vision")).toBeUndefined();
    expect(snap.diagnostics.find((d) => d.id === "model.p.pc.observer-vision")).toBeUndefined();
  });

  test("modelHealth counts: referenced/probed/healthy/freshFailing/neverTested", () => {
    const snap = run(modelInput([
      mAvail({ providerId: "p", modelId: "a", probe: freshProbe("healthy") }),
      mAvail({ providerId: "p", modelId: "b", probe: freshProbe("unauthorized") }),
      mAvail({ providerId: "p", modelId: "c", probe: { state: "never", freshness: "never" } }),
      mAvail({ providerId: "p", modelId: "d", configured: false, usage: [], probe: { state: "never", freshness: "never" } }),
      mAvail({ providerId: "p", modelId: "e", probe: freshProbe("error", { errorCode: "aborted" }) }),
    ], [providerDiag("p")]));
    expect(snap.modelHealth).toEqual({
      referenced: 4,
      probed: 3,
      healthy: 1,
      freshFailing: 1,
      neverTested: 1,
    });
  });

  test("generic fresh failure on ACTIVE model → silent (plan conservative scope)", () => {
    const snap = run(modelInput([
      mAvail({ providerId: "p", modelId: "g1", probe: freshProbe("error"), usage: [mUsage({ ownerId: "fixer" })] }),
      mAvail({ providerId: "p", modelId: "g2", probe: freshProbe("malformed"), usage: [mUsage({ ownerId: "fixer" })] }),
    ], [providerDiag("p")]));
    expect(snap.diagnostics.filter((d) => d.category === "models")).toEqual([]);
    expect(snap.overall).toBe("healthy");
  });
});

// ── Multiplexer rules (Slice 16) ──────────────────────────────────────────

describe("multiplexer rules (Slice 16)", () => {
  function muxInput(overrides: Partial<NonNullable<DoctorInput["multiplexer"]>> = {}): DoctorInput {
    return baseInput({
      multiplexer: {
        configuredType: "none",
        effectiveType: "none",
        detectedType: null,
        legacyTmuxPresent: false,
        explicitBackendCommandMissing: false,
        runtimeUnavailable: true,
        runtimeStale: false,
        unmappedJobsAfterGrace: [],
        graceApplied: false,
        ...overrides,
      },
    });
  }

  test("none → healthy", () => {
    const snap = run(muxInput({ effectiveType: "none" }));
    const d = snap.diagnostics.find((x) => x.id === "multiplexer.none");
    expect(d).toBeDefined();
    expect(d!.severity).toBe("healthy");
  });

  test("auto detected none → info", () => {
    const snap = run(
      muxInput({ configuredType: "auto", detectedType: null }),
    );
    const d = snap.diagnostics.find((x) => x.id === "multiplexer.auto-none");
    expect(d).toBeDefined();
    expect(d!.severity).toBe("info");
  });

  test("auto detected tmux → healthy", () => {
    const snap = run(
      muxInput({ configuredType: "auto", detectedType: "tmux" }),
    );
    const d = snap.diagnostics.find((x) => x.id === "multiplexer.auto-detected");
    expect(d).toBeDefined();
    expect(d!.severity).toBe("healthy");
    expect(d!.live).toEqual({ detectedType: "tmux" });
  });

  test("explicit backend command missing → warning", () => {
    const snap = run(
      muxInput({
        effectiveType: "tmux",
        explicitBackendCommandMissing: true,
      }),
    );
    const d = snap.diagnostics.find(
      (x) => x.id === "multiplexer.explicit-backend-command-missing",
    );
    expect(d).toBeDefined();
    expect(d!.severity).toBe("warning");
  });

  test("legacy tmux present → info", () => {
    const snap = run(muxInput({ legacyTmuxPresent: true }));
    const d = snap.diagnostics.find(
      (x) => x.id === "multiplexer.legacy-tmux-ignored",
    );
    expect(d).toBeDefined();
    expect(d!.severity).toBe("info");
  });

  test("missing mapping after grace → warning only when authoritative", () => {
    // Grace applied (authoritative) + unmapped jobs → warning
    const snap = run(
      muxInput({
        graceApplied: true,
        unmappedJobsAfterGrace: ["job_1", "job_2"],
      }),
    );
    const d = snap.diagnostics.find(
      (x) => x.id === "multiplexer.missing-mapping-after-grace",
    );
    expect(d).toBeDefined();
    expect(d!.severity).toBe("warning");
  });

  test("missing mapping without grace → no warning (conservative)", () => {
    const snap = run(
      muxInput({
        graceApplied: false,
        unmappedJobsAfterGrace: [],
      }),
    );
    const d = snap.diagnostics.find(
      (x) => x.id === "multiplexer.missing-mapping-after-grace",
    );
    expect(d).toBeUndefined();
  });

  test("runtime unavailable → no warning (conservative)", () => {
    const snap = run(
      muxInput({
        runtimeUnavailable: true,
        effectiveType: "tmux",
        explicitBackendCommandMissing: false,
      }),
    );
    // No runtime-unavailable diagnostic should exist
    const d = snap.diagnostics.find((x) =>
      x.id.includes("runtime-unavailable"),
    );
    expect(d).toBeUndefined();
  });

  test("multiplexer absent → no multiplexer diagnostics (conservative)", () => {
    const snap = run(baseInput({}));
    const muxDiags = snap.diagnostics.filter((x) =>
      x.id.startsWith("multiplexer."),
    );
    expect(muxDiags).toEqual([]);
  });
});

// ── Slice 17: telemetry bridge lifecycle rules ──────────────────────────

describe("doctor: bridge lifecycle rules (Slice 17)", () => {
  type BridgeStatus = NonNullable<DoctorInput["bridgeStatus"]>;
  const bridgeDiags = (snap: DoctorSnapshot) =>
    snap.diagnostics.filter((x) => x.category === "telemetry" && x.id.startsWith("bridge."));

  function bridgeInput(overrides: Partial<BridgeStatus> = {}): BridgeStatus {
    return {
      source: null,
      effective: null,
      desired: null,
      duplicates: { inSource: false, inEffective: false },
      override: { present: false, invalid: false, optsOutOfManagement: false },
      registration: "unknown",
      runtime: "unavailable",
      compatibility: "unknown",
      localPackageAvailable: "unknown",
      endpointSource: "unavailable",
      overrideActive: false,
      overrideInvalid: false,
      verificationEpoch: 0,
      generation: 1,
      omoReady: false,
      backendConnected: false,
      lifecycleStatus: "stale",
      mode: "managed",
      ownership: "control-plane",
      restartControllable: true,
      restartRequired: false,
      actions: {
        canRegister: false,
        canRemove: false,
        canRestore: false,
        canRestart: false,
        canProbe: false,
        reasons: [],
      },
      updatedAt: 0,
      ...overrides,
    };
  }

  test("absent bridgeStatus → zero bridge diagnostics (conservative)", () => {
    const snap = run(baseInput());
    expect(bridgeDiags(snap)).toEqual([]);
  });

  test("unconfigured neutral → no bridge diagnostics", () => {
    const snap = run(baseInput({ bridgeStatus: bridgeInput() }));
    expect(bridgeDiags(snap)).toEqual([]);
  });

  test("invalid override → warning", () => {
    const snap = run(baseInput({
      bridgeStatus: bridgeInput({
        override: { present: true, invalid: true, invalidReason: "Override host must be exactly 127.0.0.1.", optsOutOfManagement: false },
        overrideInvalid: true,
      }),
    }));
    const d = bridgeDiags(snap).find((x) => x.id === "bridge.override-invalid");
    expect(d?.severity).toBe("warning");
    expect(d?.summary).toContain("invalid");
    expect(snap.overall).toBe("degraded");
  });

  test("valid override unmanaged → info, never degrades", () => {
    const snap = run(baseInput({
      bridgeStatus: bridgeInput({
        override: { present: true, invalid: false, url: "http://127.0.0.1:8790", port: 8790, optsOutOfManagement: true },
        overrideActive: true,
      }),
    }));
    const d = bridgeDiags(snap).find((x) => x.id === "bridge.override-unmanaged");
    expect(d?.severity).toBe("info");
    expect(snap.overall).toBe("healthy");
  });

  test("registered awaiting restart → info, never degrades", () => {
    const snap = run(baseInput({
      bridgeStatus: bridgeInput({
        desired: { managed: true, enabled: true, stateDisposition: "committed", port: 8788, nonceFingerprint: "abc", sourceHash: "def", revisionId: "rev1", registrationTransport: "env" },
        restartRequired: true,
        runtime: "inactive",
        registration: "registered",
      }),
    }));
    const d = bridgeDiags(snap).find((x) => x.id === "bridge.registered-awaiting-restart");
    expect(d?.severity).toBe("info");
    expect(snap.overall).toBe("healthy");
  });

  test("configured unreachable → info, never degrades", () => {
    const snap = run(baseInput({
      bridgeStatus: bridgeInput({
        desired: { managed: true, enabled: true, stateDisposition: "committed", port: 8788 },
        runtime: "failed",
        registration: "registered",
      }),
    }));
    const d = bridgeDiags(snap).find((x) => x.id === "bridge.configured-unreachable");
    expect(d?.severity).toBe("info");
    expect(snap.overall).toBe("healthy");
  });

  test("schema/identity mismatch → warning", () => {
    const snap = run(baseInput({
      bridgeStatus: bridgeInput({
        compatibility: "incompatible",
        runtime: "mismatch",
        desired: { managed: true, enabled: true, stateDisposition: "committed" },
      }),
    }));
    const d = bridgeDiags(snap).find((x) => x.id === "bridge.schema-identity-mismatch");
    expect(d?.severity).toBe("warning");
    expect(snap.overall).toBe("degraded");
  });

  test("duplicate registration → warning", () => {
    const snap = run(baseInput({
      bridgeStatus: bridgeInput({
        registration: "duplicate",
        duplicates: { inSource: true, inEffective: false },
      }),
    }));
    const d = bridgeDiags(snap).find((x) => x.id === "bridge.duplicate-registration");
    expect(d?.severity).toBe("warning");
    expect(snap.overall).toBe("degraded");
  });

  test("deep bridge disconnected → info, distinct from derived OMO telemetry", () => {
    const snap = run(baseInput({
      omoTelemetry: { bridgeConfigured: true, bridgeConnected: false, jobCount: 3, orphanJobs: [], timedOutJobs: [], recentErrors: [], stale: false },
      bridgeStatus: bridgeInput({
        desired: { managed: true, enabled: true, stateDisposition: "committed" },
        backendConnected: false,
        runtime: "unavailable",
      }),
    }));
    const d = bridgeDiags(snap).find((x) => x.id === "bridge.deep-disconnected");
    expect(d?.severity).toBe("info");
    expect(d?.summary).toContain("unaffected");
    expect(snap.overall).toBe("healthy");
  });
});
