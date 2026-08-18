/**
 * Drift-acceptance route tests: local-request security, bounded bodies,
 * two-phase API flow. All fixtures are temp dirs/DBs; no live server is
 * started (the handler is invoked directly with synthetic Request objects).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DRIFT_APPLY_PATH,
  DRIFT_PREVIEW_PATH,
  handleBridgeDriftRoute,
  type DriftRouteContext,
} from "./drift-route";
import { BridgeRevisionStore } from "./revisions-bridge";
import { BridgeService } from "./service";
import { canonicalBridgeDir } from "./canonical";
import { computeAddPatch } from "./byte-patch";
import { hashContent } from "../cfgwrite/jsonc-edit";
import { fingerprintNonce } from "./extractor";
import { DRIFT_ACCEPT_CONFIRMATION_TOKEN } from "./types";

const RAW_NONCE = "route-test-raw-nonce-0123456789ab";
const NONCE_FP = fingerprintNonce(RAW_NONCE);

let sandbox: string;
let projectDir: string;
let configDir: string;
let configPath: string;
let canonicalIdentity: string;
let store: BridgeRevisionStore;
let service: BridgeService;
let committedHash: string;
let revisionId: string;
let appliedCalls: number;

function ctx(overrides: Partial<DriftRouteContext> = {}): DriftRouteContext {
  return {
    loopbackBind: true,
    requestAddress: () => "127.0.0.1",
    getService: () => service,
    overrideActive: () => false,
    onMetadataCommitted: () => {
      appliedCalls++;
      return "committed";
    },
    ...overrides,
  };
}

function req(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Request {
  return new Request(`http://127.0.0.1:8787${path}`, {
    method: init.method ?? "POST",
    ...(init.body !== undefined
      ? { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }
      : {}),
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function observedHash(): string {
  return hashContent(readFileSync(configPath, "utf-8"));
}

function expectedBody() {
  return {
    expectedRevisionId: revisionId,
    expectedCommittedHash: committedHash,
    expectedObservedHash: observedHash(),
  };
}

beforeEach(() => {
  appliedCalls = 0;
  sandbox = mkdtempSync(join(tmpdir(), "omo-drift-route-"));
  projectDir = join(sandbox, "proj");
  configDir = join(sandbox, "ocfg");
  mkdirSync(join(projectDir, "packages", "omo-telemetry-bridge"), { recursive: true });
  mkdirSync(configDir, { recursive: true });
  canonicalIdentity = canonicalBridgeDir(projectDir);
  configPath = join(projectDir, "opencode.json");

  const text0 = `{\n  "plugin": []\n}\n`;
  const added = computeAddPatch(text0, canonicalIdentity);
  if ("errors" in added) throw new Error("fixture patch failed");
  writeFileSync(configPath, added.proposedText, "utf-8");
  committedHash = hashContent(added.proposedText);
  revisionId = "brev_route_add";

  store = new BridgeRevisionStore(join(sandbox, "data", "bridge.db"));
  store.insertPreparedIntent({
    id: "intent_route_add",
    targetPath: configPath,
    sourceKind: "project-root",
    operation: "add",
    baselineHash: hashContent(text0),
    proposedHash: committedHash,
    canonicalIdentity,
    port: 8788,
    registrationTransport: "env",
    transportMode: "loopback-http",
    nonceFingerprint: NONCE_FP,
    bytePatch: JSON.stringify(added.patch),
    rawActivationNonce: RAW_NONCE,
  });
  store.finalizeIntent("intent_route_add", revisionId, new Date().toISOString(), committedHash);

  service = new BridgeService({
    opencodeConfigDir: configDir,
    projectDirectory: projectDir,
    authorizedRoots: [sandbox],
    revisions: store,
    effectiveViewProvider: async () => {
      throw new Error("effective view must never be called");
    },
  });

  // External drift.
  writeFileSync(
    configPath,
    added.proposedText.replace(/\}\s*$/, `,\n  "theme": "dark"\n}\n`),
    "utf-8",
  );
});

afterEach(() => {
  try { store.close(); } catch { /* */ }
  rmSync(sandbox, { recursive: true, force: true });
});

async function bodyJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("drift route: two-phase flow", () => {
  test("preview then apply succeeds without any lifecycle/runtime dependency (failed generation-0 compatible)", async () => {
    // The route context carries NO lifecycle/runtime handles at all: it
    // works while the lifecycle is failed at generation 0 and never starts
    // or reconciles the runtime.
    const previewRes = await handleBridgeDriftRoute(
      req(DRIFT_PREVIEW_PATH, { body: expectedBody() }),
      ctx(),
    );
    expect(previewRes.status).toBe(200);
    const previewBody = await bodyJson(previewRes);
    expect(previewBody["ok"]).toBe(true);
    const preview = previewBody["preview"] as Record<string, unknown>;
    const previewId = String(preview["previewId"]);
    expect(previewId).toMatch(/^driftpreview_[0-9a-f]{32}$/);

    const applyRes = await handleBridgeDriftRoute(
      req(DRIFT_APPLY_PATH, {
        body: { ...expectedBody(), previewId, confirmation: DRIFT_ACCEPT_CONFIRMATION_TOKEN },
      }),
      ctx(),
    );
    expect(applyRes.status).toBe(200);
    const applyBody = await bodyJson(applyRes);
    const apply = applyBody["apply"] as Record<string, unknown>;
    expect(apply["ok"]).toBe(true);
    expect(apply["configWritten"]).toBe(false);
    expect(apply["runtimeAction"]).toBe("none");
    expect(apply["restorable"]).toBe(false);
    expect(apply["restartRequired"]).toBe(true);
    expect(appliedCalls).toBe(1);

    // No raw nonce in any response.
    expect(JSON.stringify(previewBody)).not.toContain(RAW_NONCE);
    expect(JSON.stringify(applyBody)).not.toContain(RAW_NONCE);
  });

  test("failed apply does not invoke the post-apply hook", async () => {
    const res = await handleBridgeDriftRoute(
      req(DRIFT_APPLY_PATH, {
        body: { ...expectedBody(), previewId: "driftpreview_nonexistent", confirmation: DRIFT_ACCEPT_CONFIRMATION_TOKEN },
      }),
      ctx(),
    );
    expect(res.status).toBe(409);
    expect(appliedCalls).toBe(0);
  });
});

describe("drift route: local request security", () => {
  test("rejects non-loopback peer", async () => {
    const res = await handleBridgeDriftRoute(
      req(DRIFT_PREVIEW_PATH, { body: expectedBody() }),
      ctx({ requestAddress: () => "192.168.1.50" }),
    );
    expect(res.status).toBe(403);
    expect(((await bodyJson(res))["error"] as { code: string }).code).toBe("local-request-required");
  });

  test("rejects when the bind host is not loopback", async () => {
    const res = await handleBridgeDriftRoute(
      req(DRIFT_PREVIEW_PATH, { body: expectedBody() }),
      ctx({ loopbackBind: false }),
    );
    expect(res.status).toBe(403);
  });

  test("rejects undefined peer address (fail closed)", async () => {
    const res = await handleBridgeDriftRoute(
      req(DRIFT_PREVIEW_PATH, { body: expectedBody() }),
      ctx({ requestAddress: () => undefined }),
    );
    expect(res.status).toBe(403);
  });

  test("rejects any Origin header", async () => {
    const res = await handleBridgeDriftRoute(
      req(DRIFT_PREVIEW_PATH, { body: expectedBody(), headers: { origin: "http://127.0.0.1:8787" } }),
      ctx(),
    );
    expect(res.status).toBe(403);
  });

  test("rejects cross-site/browser fetch metadata", async () => {
    const res = await handleBridgeDriftRoute(
      req(DRIFT_PREVIEW_PATH, {
        body: expectedBody(),
        headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" },
      }),
      ctx(),
    );
    expect(res.status).toBe(403);
  });

  test("rejects OPTIONS (no CORS participation)", async () => {
    const res = await handleBridgeDriftRoute(req(DRIFT_PREVIEW_PATH, { method: "OPTIONS" }), ctx());
    expect(res.status).toBe(405);
  });

  test("rejects non-POST methods", async () => {
    const res = await handleBridgeDriftRoute(req(DRIFT_PREVIEW_PATH, { method: "GET" }), ctx());
    expect(res.status).toBe(405);
  });

  test("no CORS headers on any response", async () => {
    const responses = [
      await handleBridgeDriftRoute(req(DRIFT_PREVIEW_PATH, { body: expectedBody() }), ctx()),
      await handleBridgeDriftRoute(req(DRIFT_PREVIEW_PATH, { method: "OPTIONS" }), ctx()),
      await handleBridgeDriftRoute(
        req(DRIFT_PREVIEW_PATH, { body: expectedBody(), headers: { origin: "http://evil.example" } }),
        ctx(),
      ),
    ];
    for (const res of responses) {
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("access-control-allow-methods")).toBeNull();
      expect(res.headers.get("access-control-allow-headers")).toBeNull();
    }
  });

  test("bounded body: 4097 bytes rejected, normal-size accepted", async () => {
    const big = { ...expectedBody(), pad: "x".repeat(4096) };
    const res = await handleBridgeDriftRoute(req(DRIFT_PREVIEW_PATH, { body: big }), ctx());
    expect(res.status).toBe(413);

    const okRes = await handleBridgeDriftRoute(req(DRIFT_PREVIEW_PATH, { body: expectedBody() }), ctx());
    expect(okRes.status).toBe(200);
  });

  test("malformed JSON body → 400", async () => {
    const res = await handleBridgeDriftRoute(req(DRIFT_PREVIEW_PATH, { body: "{ not json" }), ctx());
    expect(res.status).toBe(400);
  });

  test("missing required fields → 400", async () => {
    const res = await handleBridgeDriftRoute(req(DRIFT_PREVIEW_PATH, { body: {} }), ctx());
    expect(res.status).toBe(400);
  });

  test("service unavailable → 503 state-recovery-pending", async () => {
    const res = await handleBridgeDriftRoute(
      req(DRIFT_PREVIEW_PATH, { body: expectedBody() }),
      ctx({ getService: () => undefined }),
    );
    expect(res.status).toBe(503);
    expect(((await bodyJson(res))["error"] as { code: string }).code).toBe("state-recovery-pending");
  });

  test("response bodies never contain raw config text or nonce sentinels", async () => {
    const previewRes = await handleBridgeDriftRoute(
      req(DRIFT_PREVIEW_PATH, { body: expectedBody() }),
      ctx(),
    );
    const text = await previewRes.text();
    expect(text).not.toContain(RAW_NONCE);
    // Config VALUES/content are never echoed (allowlisted key names only).
    expect(text).not.toContain("dark");
    expect(text).not.toContain(readFileSync(configPath, "utf-8"));
  });
});

// ── Oracle attempt-2: post-commit hook honesty ─────────────────────────

describe("drift route: post-commit hook honesty", () => {
  function stubServiceWith(result: Record<string, unknown>): DriftRouteContext {
    const stub = {
      applyDriftAcceptance: () => result,
      previewDriftAcceptance: () => ({ ok: false, errors: [] }),
    } as unknown as BridgeService;
    return ctx({ getService: () => stub });
  }

  function applyReq(): Request {
    return req(DRIFT_APPLY_PATH, {
      body: {
        previewId: "driftpreview_0".repeat(2),
        expectedRevisionId: "brev_x",
        expectedCommittedHash: "a".repeat(64),
        expectedObservedHash: "b".repeat(64),
        confirmation: DRIFT_ACCEPT_CONFIRMATION_TOKEN,
      },
    });
  }

  test("hook reconciliation not clean → post-acceptance-drift even when service was clean", async () => {
    let hookCalls = 0;
    const context = ctx({
      getService: () =>
        ({
          applyDriftAcceptance: () => ({
            ok: true,
            metadataCommitted: true,
            configWritten: false,
            runtimeAction: "none",
            restorable: false,
            restartRequired: true,
            revisionId: "brev_new",
            stateDisposition: "committed",
            errors: [],
          }),
        }) as unknown as BridgeService,
      onMetadataCommitted: () => {
        hookCalls++;
        return "recovery-pending"; // reconciliation later edit / not clean
      },
    });
    const res = await handleBridgeDriftRoute(applyReq(), context);
    expect(hookCalls).toBe(1);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; apply: { stateDisposition?: string }; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("post-acceptance-drift");
    expect(body.apply.stateDisposition).toBe("recovery-pending");
  });

  test("hook failure is structured (metadataCommitted true + recovery-pending), never thrown", async () => {
    const context = ctx({
      getService: () =>
        ({
          applyDriftAcceptance: () => ({
            ok: true,
            metadataCommitted: true,
            configWritten: false,
            runtimeAction: "none",
            restorable: false,
            restartRequired: true,
            revisionId: "brev_new",
            stateDisposition: "committed",
            errors: [],
          }),
        }) as unknown as BridgeService,
      onMetadataCommitted: () => {
        throw new Error("hook boom");
      },
    });
    const res = await handleBridgeDriftRoute(applyReq(), context);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("post-acceptance-drift");
  });

  test("hook runs for post-commit drift outcomes too", async () => {
    let hookCalls = 0;
    const context = ctx({
      getService: () =>
        ({
          applyDriftAcceptance: () => ({
            ok: false,
            metadataCommitted: true,
            configWritten: false,
            runtimeAction: "none",
            restorable: false,
            revisionId: "brev_new",
            stateDisposition: "recovery-pending",
            errors: [{ code: "post-acceptance-drift", message: "drift after commit" }],
          }),
        }) as unknown as BridgeService,
      onMetadataCommitted: () => {
        hookCalls++;
        return "recovery-pending";
      },
    });
    const res = await handleBridgeDriftRoute(applyReq(), context);
    expect(hookCalls).toBe(1);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("post-acceptance-drift");
  });

  test("internal handler faults are caught (no uncaught exception)", async () => {
    const context = ctx({
      getService: () => {
        throw new Error("service accessor boom");
      },
    });
    const res = await handleBridgeDriftRoute(applyReq(), context);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("state-recovery-pending");
  });
});
