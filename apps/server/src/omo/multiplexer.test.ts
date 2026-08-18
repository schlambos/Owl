/**
 * Multiplexer resolver tests (Slice 16).
 *
 * Tests cover:
 * - Schema exact fields/enums/defaults/range/legacy/raw unknown
 * - Auto fixture signals/order/none/explicit
 * - Resolution/provenance/removal/inactive preservation/conflict
 * - Command resolution (static command -v only)
 * - Detection (env signals, inside session)
 *
 * Source authority: installed oh-my-opencode-slim@2.2.10
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProvenance } from "./provenance";
import {
  AUTO_SIGNAL_ORDER,
  buildMultiplexerSystem,
  detectLegacyTmux,
  isInsideSession,
  MULTIPLEXER_BUILTIN_DEFAULTS,
  MULTIPLEXER_CAPABILITIES,
  MULTIPLEXER_COMMANDS,
  MULTIPLEXER_FIELDS,
  resolveAvailability,
  resolveConfigured,
  resolveDetection,
  resolveEffective,
  type CommandRunner,
} from "./multiplexer";
import { buildMultiplexerRuntime } from "../omo-runtime/multiplexer-runtime";
import type { OmoRuntimeSnapshot, OmoBridgeStatus } from "../omo-runtime/types";
import type { MultiplexerRuntime } from "@omo/shared";

const ROOT = join(import.meta.dir, "../../test/multiplexer-sandbox");

function setup(
  user?: Record<string, unknown>,
  project?: Record<string, unknown>,
) {
  rmSync(ROOT, { recursive: true, force: true });
  const userDir = join(ROOT, "cfg");
  const projDir = join(ROOT, "proj");
  mkdirSync(userDir, { recursive: true });
  mkdirSync(projDir, { recursive: true });
  mkdirSync(join(projDir, ".opencode"), { recursive: true });
  if (user) {
    writeFileSync(
      join(userDir, "oh-my-opencode-slim.json"),
      JSON.stringify(user, null, 2),
    );
  }
  if (project) {
    writeFileSync(
      join(projDir, ".opencode", "oh-my-opencode-slim.json"),
      JSON.stringify(project, null, 2),
    );
  }
  const bundle = resolveProvenance({
    opencodeConfigDir: userDir,
    projectDirectory: projDir,
    authorizedRoots: [userDir, projDir],
  });
  return { bundle, userDir, projDir };
}

function emptyOmoSnapshot(): OmoRuntimeSnapshot {
  return {
    telemetrySchemaVersion: 2,
    generatedAt: 0,
    stale: false,
    availability: { opencodeJobs: false, bridge: false, runtimePreset: false },
    jobs: [],
    workers: [],
    notes: [],
  };
}

function emptyRuntime(): MultiplexerRuntime {
  return {
    stores: { sessions: [], cmux: [], counts: {} },
    mapping: {
      bySessionId: {},
      mappedJobs: [],
      unmappedJobs: [],
      unavailable: true,
      stale: false,
    },
    bridgeConnected: false,
  };
}

class FakeRunner implements CommandRunner {
  constructor(private paths: Record<string, string | null>) {}
  async resolve(name: string): Promise<string | null> {
    return this.paths[name] ?? null;
  }
}

// ── (1) Schema field catalog freeze ───────────────────────────────────────

describe("multiplexer field catalog (source freeze)", () => {
  test("exactly four fields with correct names", () => {
    expect(Object.keys(MULTIPLEXER_FIELDS)).toEqual([
      "type",
      "layout",
      "main_pane_size",
      "zellij_pane_mode",
    ]);
  });

  test("type: enum + default none", () => {
    const f = MULTIPLEXER_FIELDS.type!;
    expect(f.defaultValue).toBe("none");
    expect(f.enumValues).toEqual([
      "auto",
      "tmux",
      "zellij",
      "herdr",
      "kitty",
      "cmux",
      "none",
    ]);
  });

  test("layout: enum + default main-vertical", () => {
    const f = MULTIPLEXER_FIELDS.layout!;
    expect(f.defaultValue).toBe("main-vertical");
    expect(f.enumValues).toEqual([
      "main-horizontal",
      "main-vertical",
      "tiled",
      "even-horizontal",
      "even-vertical",
    ]);
  });

  test("main_pane_size: range 20..80 + default 60", () => {
    const f = MULTIPLEXER_FIELDS.main_pane_size!;
    expect(f.defaultValue).toBe(60);
    expect(f.minimum).toBe(20);
    expect(f.maximum).toBe(80);
  });

  test("zellij_pane_mode: enum + default agent-tab", () => {
    const f = MULTIPLEXER_FIELDS.zellij_pane_mode!;
    expect(f.defaultValue).toBe("agent-tab");
    expect(f.enumValues).toEqual(["agent-tab", "current-tab"]);
  });

  test("builtin defaults frozen", () => {
    expect(MULTIPLEXER_BUILTIN_DEFAULTS).toEqual({
      type: "none",
      layout: "main-vertical",
      main_pane_size: 60,
      zellij_pane_mode: "agent-tab",
    });
  });

  test("capabilities frozen", () => {
    expect(MULTIPLEXER_CAPABILITIES).toEqual({
      readable: true,
      resolved: true,
      provenance: true,
      editable: true,
      runtimeObservable: "partial",
      runtimeControllable: false,
      doctor: true,
    });
  });

  test("command allowlist exact", () => {
    expect([...MULTIPLEXER_COMMANDS]).toEqual([
      "tmux",
      "zellij",
      "herdr",
      "kitten",
      "kitty",
      "cmux",
      "opencode",
    ]);
  });
});

// ── (2) Auto detection signals/order/none/explicit ────────────────────────

describe("auto detection (factory order)", () => {
  test("no signals → resolvedType null, order ends with none", () => {
    const d = resolveDetection({});
    expect(d.resolvedType).toBeNull();
    expect(d.insideSession).toBe(false);
    expect(d.order[d.order.length - 1]).toEqual({ match: "none", type: null });
  });

  test("CMUX signals win over TMUX (order)", () => {
    const d = resolveDetection({
      CMUX_SOCKET_PATH: "/tmp/cmux.sock",
      CMUX_WORKSPACE_ID: "ws1",
      CMUX_SURFACE_ID: "surf1",
      TMUX: "/tmp/tmux",
      ZELLIJ: "0",
    });
    expect(d.resolvedType).toBe("cmux");
    expect(d.insideSession).toBe(true);
    expect(d.order[0]).toEqual({
      match: "CMUX_SOCKET_PATH && CMUX_WORKSPACE_ID && CMUX_SURFACE_ID",
      type: "cmux",
    });
  });

  test("TMUX alone → tmux", () => {
    const d = resolveDetection({ TMUX: "/tmp/tmux" });
    expect(d.resolvedType).toBe("tmux");
    expect(d.insideSession).toBe(true);
  });

  test("ZELLIJ alone → zellij", () => {
    const d = resolveDetection({ ZELLIJ: "0" });
    expect(d.resolvedType).toBe("zellij");
  });

  test("HERDR_ENV alone → herdr", () => {
    const d = resolveDetection({ HERDR_ENV: "1" });
    expect(d.resolvedType).toBe("herdr");
  });

  test("HERDR_PANE_ID alone → herdr", () => {
    const d = resolveDetection({ HERDR_PANE_ID: "pane1" });
    expect(d.resolvedType).toBe("herdr");
  });

  test("KITTY_PID alone → kitty", () => {
    const d = resolveDetection({ KITTY_PID: "123" });
    expect(d.resolvedType).toBe("kitty");
  });

  test("KITTY_WINDOW_ID alone → kitty", () => {
    const d = resolveDetection({ KITTY_WINDOW_ID: "win1" });
    expect(d.resolvedType).toBe("kitty");
  });

  test("partial CMUX (missing SURFACE_ID) → not cmux, falls through", () => {
    const d = resolveDetection({
      CMUX_SOCKET_PATH: "/tmp/cmux.sock",
      CMUX_WORKSPACE_ID: "ws1",
      TMUX: "/tmp/tmux",
    });
    expect(d.resolvedType).toBe("tmux");
  });

  test("AUTO_SIGNAL_ORDER has exactly 5 entries in factory order", () => {
    expect(AUTO_SIGNAL_ORDER).toHaveLength(5);
    expect(AUTO_SIGNAL_ORDER.map((e) => e.type)).toEqual([
      "cmux",
      "tmux",
      "zellij",
      "herdr",
      "kitty",
    ]);
  });
});

// ── (3) isInsideSession per backend ──────────────────────────────────────

describe("isInsideSession per backend", () => {
  test("cmux requires all three env vars", () => {
    expect(
      isInsideSession("cmux", {
        CMUX_SOCKET_PATH: "x",
        CMUX_WORKSPACE_ID: "y",
        CMUX_SURFACE_ID: "z",
      }),
    ).toBe(true);
    expect(
      isInsideSession("cmux", {
        CMUX_SOCKET_PATH: "x",
        CMUX_WORKSPACE_ID: "y",
      }),
    ).toBe(false);
  });

  test("tmux requires TMUX", () => {
    expect(isInsideSession("tmux", { TMUX: "x" })).toBe(true);
    expect(isInsideSession("tmux", {})).toBe(false);
  });

  test("zellij requires ZELLIJ", () => {
    expect(isInsideSession("zellij", { ZELLIJ: "0" })).toBe(true);
    expect(isInsideSession("zellij", {})).toBe(false);
  });

  test("herdr requires HERDR_ENV or HERDR_PANE_ID", () => {
    expect(isInsideSession("herdr", { HERDR_ENV: "1" })).toBe(true);
    expect(isInsideSession("herdr", { HERDR_PANE_ID: "p" })).toBe(true);
    expect(isInsideSession("herdr", {})).toBe(false);
  });

  test("kitty requires KITTY_PID or KITTY_WINDOW_ID", () => {
    expect(isInsideSession("kitty", { KITTY_PID: "1" })).toBe(true);
    expect(isInsideSession("kitty", { KITTY_WINDOW_ID: "w" })).toBe(true);
    expect(isInsideSession("kitty", {})).toBe(false);
  });

  test("none and auto always false", () => {
    expect(isInsideSession("none", { TMUX: "x" })).toBe(false);
    expect(isInsideSession("auto", { TMUX: "x" })).toBe(false);
  });
});

// ── (4) Resolution / provenance / defaults ────────────────────────────────

describe("resolution and provenance", () => {
  test("no config → all builtin defaults", () => {
    const { bundle } = setup();
    const { effective, provenance } = resolveEffective(bundle);
    expect(effective).toEqual(MULTIPLEXER_BUILTIN_DEFAULTS);
    expect(provenance.builtinDefaults).toEqual([
      "multiplexer.type",
      "multiplexer.layout",
      "multiplexer.main_pane_size",
      "multiplexer.zellij_pane_mode",
    ]);
  });

  test("configured type tmux → effective type tmux", () => {
    const { bundle } = setup({ multiplexer: { type: "tmux" } });
    const { effective } = resolveEffective(bundle);
    expect(effective.type).toBe("tmux");
    // Other fields still defaults
    expect(effective.layout).toBe("main-vertical");
    expect(effective.main_pane_size).toBe(60);
  });

  test("configured all fields → effective all fields", () => {
    const { bundle } = setup({
      multiplexer: {
        type: "zellij",
        layout: "tiled",
        main_pane_size: 50,
        zellij_pane_mode: "current-tab",
      },
    });
    const { effective } = resolveEffective(bundle);
    expect(effective).toEqual({
      type: "zellij",
      layout: "tiled",
      main_pane_size: 50,
      zellij_pane_mode: "current-tab",
    });
  });

  test("project overrides user (deep merge)", () => {
    const { bundle } = setup(
      { multiplexer: { type: "tmux", layout: "tiled" } },
      { multiplexer: { type: "zellij" } },
    );
    const { effective } = resolveEffective(bundle);
    expect(effective.type).toBe("zellij"); // project wins
    expect(effective.layout).toBe("tiled"); // user preserved (deep merge)
  });

  test("configured preserves unknown nested keys", () => {
    const { bundle } = setup({
      multiplexer: { type: "tmux", futureField: "x" },
    });
    const configured = resolveConfigured(bundle);
    expect(configured.type).toBe("tmux");
    expect(configured.futureField).toBe("x");
  });

  test("provenance winner is user-config for user-set fields", () => {
    const { bundle } = setup({ multiplexer: { type: "tmux" } });
    const { provenance } = resolveEffective(bundle);
    const typeProp = provenance.properties["multiplexer.type"];
    expect(typeProp).toBeDefined();
    expect(typeProp!.winner.stage).toBe("user-config");
    expect(typeProp!.winner.value).toBe("tmux");
  });

  test("provenance builtin default for omitted fields", () => {
    const { bundle } = setup({ multiplexer: { type: "tmux" } });
    const { provenance } = resolveEffective(bundle);
    const layoutProp = provenance.properties["multiplexer.layout"];
    expect(layoutProp).toBeDefined();
    expect(layoutProp!.winner.stage).toBe("builtin");
    expect(layoutProp!.winner.value).toBe("main-vertical");
  });
});

// ── (5) Legacy top-level tmux ─────────────────────────────────────────────

describe("legacy top-level tmux", () => {
  test("legacy tmux present → detected, ignored", () => {
    const { bundle } = setup({ tmux: { enabled: true } });
    expect(detectLegacyTmux(bundle)).toBe(true);
  });

  test("no legacy tmux → false", () => {
    const { bundle } = setup({ multiplexer: { type: "tmux" } });
    expect(detectLegacyTmux(bundle)).toBe(false);
  });
});

// ── (6) Command availability (static command -v only) ─────────────────────

describe("command availability", () => {
  test("all resolved → all status resolved", async () => {
    const runner = new FakeRunner({
      tmux: "/usr/bin/tmux",
      zellij: "/usr/bin/zellij",
      herdr: "/usr/bin/herdr",
      kitten: "/usr/bin/kitten",
      kitty: "/usr/bin/kitty",
      cmux: "/usr/bin/cmux",
      opencode: "/usr/bin/opencode",
    });
    const avail = await resolveAvailability(runner);
    expect(avail.tmux.status).toBe("resolved");
    expect(avail.tmux.path).toBe("/usr/bin/tmux");
    expect(avail.zellij.status).toBe("resolved");
    expect(avail.opencode.status).toBe("resolved");
  });

  test("none resolved → all not-resolved", async () => {
    const runner = new FakeRunner({
      tmux: null,
      zellij: null,
      herdr: null,
      kitten: null,
      kitty: null,
      cmux: null,
      opencode: null,
    });
    const avail = await resolveAvailability(runner);
    expect(avail.tmux.status).toBe("not-resolved");
    expect(avail.zellij.status).toBe("not-resolved");
  });

  test("runner throws → unknown", async () => {
    const runner: CommandRunner = {
      async resolve() {
        throw new Error("boom");
      },
    };
    const avail = await resolveAvailability(runner);
    expect(avail.tmux.status).toBe("unknown");
  });
});

// ── (7) Full DTO assembly ─────────────────────────────────────────────────

describe("buildMultiplexerSystem", () => {
  test("no config, no signals → none effective, auto detects none", async () => {
    const { bundle } = setup();
    const dto = await buildMultiplexerSystem({
      bundle,
      env: {},
      runner: new FakeRunner({}),
      runtime: emptyRuntime(),
    });
    expect(dto.effective.type).toBe("none");
    expect(dto.detection.resolvedType).toBeNull();
    expect(dto.legacy.tmuxPresent).toBe(false);
    expect(dto.capabilities).toEqual(MULTIPLEXER_CAPABILITIES);
    expect(dto.activation.configReadAt).toBe("plugin-load");
    expect(dto.activation.hotReload).toBe(false);
  });

  test("explicit tmux + command missing → warning", async () => {
    const { bundle } = setup({ multiplexer: { type: "tmux" } });
    const dto = await buildMultiplexerSystem({
      bundle,
      env: {},
      runner: new FakeRunner({ tmux: null }),
      runtime: emptyRuntime(),
    });
    expect(dto.effective.type).toBe("tmux");
    const warn = dto.warnings.find((w) => w.kind === "explicit-backend-command-missing");
    expect(warn).toBeDefined();
    expect(warn!.severity).toBe("warning");
  });

  test("auto + TMUX signal → info about detected backend", async () => {
    const { bundle } = setup({ multiplexer: { type: "auto" } });
    const dto = await buildMultiplexerSystem({
      bundle,
      env: { TMUX: "/tmp/tmux" },
      runner: new FakeRunner({}),
      runtime: emptyRuntime(),
    });
    expect(dto.detection.resolvedType).toBe("tmux");
    const info = dto.warnings.find((w) => w.kind === "auto-detected-backend");
    expect(info).toBeDefined();
    expect(info!.severity).toBe("info");
  });

  test("legacy tmux present → info warning", async () => {
    const { bundle } = setup({ tmux: { foo: "bar" } });
    const dto = await buildMultiplexerSystem({
      bundle,
      env: {},
      runner: new FakeRunner({}),
      runtime: emptyRuntime(),
    });
    expect(dto.legacy.tmuxPresent).toBe(true);
    expect(dto.legacy.ignored).toBe(true);
    const warn = dto.warnings.find((w) => w.kind === "legacy-tmux-ignored");
    expect(warn).toBeDefined();
    expect(warn!.severity).toBe("info");
  });
});

// ── (8) Runtime correlation ───────────────────────────────────────────────
//
// Slice 17 v3: v2 is display-only, only verified v3 maps. Updated legacy
// tests that expected v2 mapping/grace to use verified v3 fixtures instead.

/** A verified v3 bridge status with minimal identity/capabilities. */
function verifiedV3Bridge(overrides: Partial<OmoBridgeStatus> = {}): OmoBridgeStatus {
  return {
    connected: true,
    schemaVersion: 3,
    verified: true,
    identity: {
      pluginInstanceId: "11111111-2222-3333-4444-555555555555",
      startupTimestamp: 1000,
      transportMode: "loopback-http",
      schemaVersion: 3,
      capturedAt: 2000,
    },
    capabilities: {
      fallbackInProgress: "absent",
      continuationGate: "absent",
      multiplexerManager: "present",
      cmuxStore: "absent",
      runtimePreset: false,
      workerReuse: false,
      terminalCapture: false,
    },
    ...overrides,
  };
}

describe("runtime correlation", () => {
  test("bridge unavailable → mapping.unavailable true, no grace", () => {
    const rt = buildMultiplexerRuntime(undefined, emptyOmoSnapshot(), 0);
    expect(rt.mapping.unavailable).toBe(true);
    expect(rt.mapping.graceAppliedMs).toBeUndefined();
    expect(rt.mapping.mappedJobs).toEqual([]);
    expect(rt.mapping.unmappedJobs).toEqual([]);
  });

  test("verified v3 bridge connected + not stale → grace applied", () => {
    const rt = buildMultiplexerRuntime(
      verifiedV3Bridge(),
      emptyOmoSnapshot(),
      0,
    );
    expect(rt.mapping.unavailable).toBe(false);
    expect(rt.mapping.graceAppliedMs).toBe(60_000);
    expect(rt.bridgeConnected).toBe(true);
    expect(rt.bridgeSchemaVersion).toBe(3);
  });

  test("verified v3 bridge connected + stale → no grace", () => {
    const snap = { ...emptyOmoSnapshot(), stale: true };
    const rt = buildMultiplexerRuntime(
      verifiedV3Bridge(),
      snap,
      0,
    );
    expect(rt.mapping.graceAppliedMs).toBeUndefined();
    expect(rt.mapping.stale).toBe(true);
  });

  test("legacy v2 bridge → display only, no grace, no mapping", () => {
    const rt = buildMultiplexerRuntime(
      { connected: true, schemaVersion: 2 },
      emptyOmoSnapshot(),
      0,
    );
    expect(rt.mapping.unavailable).toBe(false);
    expect(rt.mapping.graceAppliedMs).toBeUndefined();
    expect(rt.bridgeSchemaVersion).toBe(2);
    expect(rt.mapping.mappedJobs).toEqual([]);
    expect(rt.mapping.unmappedJobs).toEqual([]);
  });

  test("OMO jobs mapped to session records by child session ID (verified v3 only)", () => {
    const snap: OmoRuntimeSnapshot = {
      ...emptyOmoSnapshot(),
      jobs: [
        {
          taskId: "ses_child1",
          agent: "explorer",
          parentSessionId: "ses_parent",
          childSessionId: "ses_child1",
          state: "running",
          source: "opencode-task-call",
        },
        {
          taskId: "ses_child2",
          agent: "librarian",
          parentSessionId: "ses_parent",
          childSessionId: "ses_child2",
          state: "running",
          source: "opencode-task-call",
        },
      ],
    };
    const rt = buildMultiplexerRuntime(
      verifiedV3Bridge({
        stores: {
          multiplexerRecords: [
            {
              sessionId: "ses_child1",
              known: true,
              spawning: false,
              closing: false,
              permanentlyClosed: false,
            },
          ],
        },
      }),
      snap,
      0,
    );
    expect(rt.mapping.mappedJobs).toEqual(["ses_child1"]);
    expect(rt.mapping.unmappedJobs).toEqual(["ses_child2"]);
  });
});