/**
 * Multiplexer pure resolver (Slice 16).
 *
 * Source authority: installed oh-my-opencode-slim@2.2.10
 *   schema  oh-my-opencode-slim.schema.json:941-982
 *   zod     dist/index.js:18753-18775 (MultiplexerConfigSchema — Zod strip)
 *   loader  dist/index.js:18881-18944 (safeParse; legacy tmux 18901-18911)
 *   factory dist/index.js:35525-35586 (getMultiplexer; auto order)
 *   init    dist/index.js:40831-40846 (defaults + startAvailabilityCheck)
 *
 * This module is PURE: it reuses the existing provenance bundle/deep merge
 * (no broad resolver duplication) and computes configured/effective/
 * provenance/detection/availability. Runtime correlation lives in the store
 * layer; this module only normalizes the static halves.
 */

import type {
  MultiplexerActivation,
  MultiplexerAvailability,
  MultiplexerCapabilities,
  MultiplexerCommandAvailability,
  MultiplexerConfigured,
  MultiplexerDetection,
  MultiplexerEffective,
  MultiplexerProvenance,
  MultiplexerRuntime,
  MultiplexerSystemDto,
  MultiplexerType,
  ProvenanceBundle,
  ResolvedProperty,
} from "@omo/shared";
import { builtinLeaf } from "./companion";

// ── Frozen field catalog (source: schema + zod) ────────────────────────────

export interface MultiplexerFieldSpec {
  path: string;
  schemaType: string;
  defaultValue: unknown;
  enumValues?: readonly string[];
  minimum?: number;
  maximum?: number;
}

export const MULTIPLEXER_FIELDS: Record<string, MultiplexerFieldSpec> = Object.freeze({
  type: {
    path: "multiplexer.type",
    schemaType: "string",
    defaultValue: "none",
    enumValues: [
      "auto",
      "tmux",
      "zellij",
      "herdr",
      "kitty",
      "cmux",
      "none",
    ],
  },
  layout: {
    path: "multiplexer.layout",
    schemaType: "string",
    defaultValue: "main-vertical",
    enumValues: [
      "main-horizontal",
      "main-vertical",
      "tiled",
      "even-horizontal",
      "even-vertical",
    ],
  },
  main_pane_size: {
    path: "multiplexer.main_pane_size",
    schemaType: "number",
    defaultValue: 60,
    minimum: 20,
    maximum: 80,
  },
  zellij_pane_mode: {
    path: "multiplexer.zellij_pane_mode",
    schemaType: "string",
    defaultValue: "agent-tab",
    enumValues: ["agent-tab", "current-tab"],
  },
});

export const MULTIPLEXER_BUILTIN_DEFAULTS: MultiplexerEffective = Object.freeze({
  type: "none",
  layout: "main-vertical",
  main_pane_size: 60,
  zellij_pane_mode: "agent-tab",
});

/** Commands the control plane may probe with `command -v` (static list). */
export const MULTIPLEXER_COMMANDS = Object.freeze([
  "tmux",
  "zellij",
  "herdr",
  "kitten",
  "kitty",
  "cmux",
  "opencode",
] as const);

/** Auto-detection env signals in exact factory order (dist/index.js:35553-35572). */
export const AUTO_SIGNAL_ORDER: ReadonlyArray<{
  match: (env: Record<string, string | undefined>) => boolean;
  type: MultiplexerType;
  label: string;
}> = Object.freeze([
  {
    match: (e) =>
      !!e.CMUX_SOCKET_PATH && !!e.CMUX_WORKSPACE_ID && !!e.CMUX_SURFACE_ID,
    type: "cmux",
    label: "CMUX_SOCKET_PATH && CMUX_WORKSPACE_ID && CMUX_SURFACE_ID",
  },
  { match: (e) => !!e.TMUX, type: "tmux", label: "TMUX" },
  { match: (e) => !!e.ZELLIJ, type: "zellij", label: "ZELLIJ" },
  {
    match: (e) => !!e.HERDR_ENV || !!e.HERDR_PANE_ID,
    type: "herdr",
    label: "HERDR_ENV || HERDR_PANE_ID",
  },
  {
    match: (e) => !!e.KITTY_PID || !!e.KITTY_WINDOW_ID,
    type: "kitty",
    label: "KITTY_PID || KITTY_WINDOW_ID",
  },
]);

// ── Helpers ────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isMultiplexerType(v: unknown): v is MultiplexerType {
  return (
    typeof v === "string" &&
    [
      "auto",
      "tmux",
      "zellij",
      "herdr",
      "kitty",
      "cmux",
      "none",
    ].includes(v)
  );
}

function asConfigured(raw: unknown): MultiplexerConfigured {
  if (!isPlainObject(raw)) return {};
  const out: MultiplexerConfigured = {};
  if (isMultiplexerType(raw.type)) out.type = raw.type;
  if (
    typeof raw.layout === "string" &&
    [
      "main-horizontal",
      "main-vertical",
      "tiled",
      "even-horizontal",
      "even-vertical",
    ].includes(raw.layout)
  ) {
    out.layout = raw.layout as MultiplexerConfigured["layout"];
  }
  if (typeof raw.main_pane_size === "number" && Number.isFinite(raw.main_pane_size)) {
    out.main_pane_size = raw.main_pane_size;
  }
  if (
    typeof raw.zellij_pane_mode === "string" &&
    ["agent-tab", "current-tab"].includes(raw.zellij_pane_mode)
  ) {
    out.zellij_pane_mode =
      raw.zellij_pane_mode as MultiplexerConfigured["zellij_pane_mode"];
  }
  // Preserve unknown nested keys (Zod strips at runtime; raw JSONC must survive)
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in out) && k !== "type" && k !== "layout" && k !== "main_pane_size" && k !== "zellij_pane_mode") {
      out[k] = v;
    }
  }
  return out;
}

/** Per-backend isInsideSession() (dist factory + each class). */
export function isInsideSession(
  type: MultiplexerType,
  env: Record<string, string | undefined>,
): boolean {
  switch (type) {
    case "cmux":
      return !!(
        env.CMUX_SOCKET_PATH &&
        env.CMUX_WORKSPACE_ID &&
        env.CMUX_SURFACE_ID
      );
    case "tmux":
      return !!env.TMUX;
    case "zellij":
      return !!env.ZELLIJ;
    case "herdr":
      return !!(env.HERDR_ENV || env.HERDR_PANE_ID);
    case "kitty":
      return !!(env.KITTY_PID || env.KITTY_WINDOW_ID);
    case "none":
    case "auto":
      return false;
  }
}

// ── Configured / Effective / Provenance ───────────────────────────────────

export function resolveConfigured(bundle: ProvenanceBundle): MultiplexerConfigured {
  return asConfigured(bundle.rawMerged.multiplexer);
}

export function resolveEffective(
  bundle: ProvenanceBundle,
): { effective: MultiplexerEffective; provenance: MultiplexerProvenance } {
  const configured = resolveConfigured(bundle);
  const properties: Record<string, ResolvedProperty> = {};
  const builtinDefaults: string[] = [];

  const apply = (
    field: keyof typeof MULTIPLEXER_FIELDS,
    defaultValue: unknown,
  ): unknown => {
    const spec = MULTIPLEXER_FIELDS[field];
    if (!spec) return defaultValue;
    const path = spec.path;
    const leaf = bundle.properties[path];
    if (leaf) {
      properties[path] = leaf;
      return leaf.value;
    }
    properties[path] = builtinLeaf(path, defaultValue);
    builtinDefaults.push(path);
    return defaultValue;
  };

  const type = apply("type", MULTIPLEXER_BUILTIN_DEFAULTS.type) as MultiplexerType;
  const layout = apply(
    "layout",
    MULTIPLEXER_BUILTIN_DEFAULTS.layout,
  ) as MultiplexerEffective["layout"];
  const main_pane_size = apply(
    "main_pane_size",
    MULTIPLEXER_BUILTIN_DEFAULTS.main_pane_size,
  ) as number;
  const zellij_pane_mode = apply(
    "zellij_pane_mode",
    MULTIPLEXER_BUILTIN_DEFAULTS.zellij_pane_mode,
  ) as MultiplexerEffective["zellij_pane_mode"];

  return {
    effective: { type, layout, main_pane_size, zellij_pane_mode },
    provenance: { properties, builtinDefaults },
  };
}

// ── Legacy top-level tmux ─────────────────────────────────────────────────

export function detectLegacyTmux(bundle: ProvenanceBundle): boolean {
  return Object.prototype.hasOwnProperty.call(bundle.rawMerged, "tmux");
}

// ── Detection (auto factory order) ────────────────────────────────────────

export function resolveDetection(
  env: Record<string, string | undefined> = process.env,
): MultiplexerDetection {
  const signals: MultiplexerDetection["signals"] = {};
  for (const key of [
    "CMUX_SOCKET_PATH",
    "CMUX_WORKSPACE_ID",
    "CMUX_SURFACE_ID",
    "TMUX",
    "ZELLIJ",
    "HERDR_ENV",
    "HERDR_PANE_ID",
    "KITTY_PID",
    "KITTY_WINDOW_ID",
  ] as const) {
    const v = env[key];
    if (v !== undefined) signals[key] = v;
  }

  const order: MultiplexerDetection["order"] = [];
  let resolvedType: MultiplexerType | null = null;
  for (const entry of AUTO_SIGNAL_ORDER) {
    if (entry.match(env)) {
      order.push({ match: entry.label, type: entry.type });
      if (resolvedType === null) resolvedType = entry.type;
    }
  }
  if (resolvedType === null) {
    order.push({ match: "none", type: null });
  }

  const insideSession =
    resolvedType !== null && isInsideSession(resolvedType, env);

  return { signals, resolvedType, insideSession, order };
}

// ── Availability (static command -v only) ──────────────────────────────────

/**
 * Injected command runner. MUST only ever run `command -v <name>` one by one.
 * Returns the trimmed first stdout line (path) when exit code 0, else null.
 * The control plane never inspects the binary, executes it, or crawls PATH.
 */
export interface CommandRunner {
  /** Run `command -v <name>`; return path string or null. Never throws. */
  resolve(name: string): Promise<string | null>;
}

export async function resolveAvailability(
  runner: CommandRunner,
): Promise<MultiplexerAvailability> {
  const probe = async (name: string): Promise<MultiplexerCommandAvailability> => {
    try {
      const path = await runner.resolve(name);
      if (path === null) {
        return { command: name, status: "not-resolved" };
      }
      return { command: name, status: "resolved", path };
    } catch {
      return { command: name, status: "unknown" };
    }
  };

  const [tmux, zellij, herdr, kitten, kitty, cmux, opencode] = await Promise.all([
    probe("tmux"),
    probe("zellij"),
    probe("herdr"),
    probe("kitten"),
    probe("kitty"),
    probe("cmux"),
    probe("opencode"),
  ]);

  return { tmux, zellij, herdr, kitten, kitty, cmux, opencode };
}

// ── Activation / Capabilities ─────────────────────────────────────────────

export function resolveActivation(legacyTmuxPresent: boolean): MultiplexerActivation {
  return {
    configReadAt: "plugin-load",
    availabilityCheckAt: "plugin-init-if-in-session",
    hotReload: false,
    legacyTmuxIgnored: legacyTmuxPresent,
    note:
      "Multiplexer config read once at plugin init (dist/index.js:40831-40846); " +
      "availability check starts once at init only if inside session " +
      "(dist/index.js:40844-40845). No hot reload proven in 2.2.10. " +
      "Legacy top-level tmux emits a warning and is ignored " +
      "(dist/index.js:18901-18911); not aliased, not migrated.",
  };
}

export const MULTIPLEXER_CAPABILITIES: MultiplexerCapabilities = Object.freeze({
  readable: true,
  resolved: true,
  provenance: true,
  editable: true,
  runtimeObservable: "partial",
  runtimeControllable: false,
  doctor: true,
});

// ── Warnings ────────────────────────────────────────────────────────────────

export interface MultiplexerWarningInput {
  configured: MultiplexerConfigured;
  effective: MultiplexerEffective;
  detection: MultiplexerDetection;
  availability: MultiplexerAvailability;
  legacyTmuxPresent: boolean;
}

export function resolveWarnings(
  input: MultiplexerWarningInput,
): Array<{ kind: string; message: string; severity: "info" | "warning" }> {
  const warnings: Array<{ kind: string; message: string; severity: "info" | "warning" }> = [];

  // Explicit backend command missing → warning (conservative)
  const explicitType = input.effective.type;
  if (explicitType !== "auto" && explicitType !== "none") {
    const cmdMap: Record<Exclude<MultiplexerType, "auto" | "none">, keyof MultiplexerAvailability> = {
      tmux: "tmux",
      zellij: "zellij",
      herdr: "herdr",
      kitty: "kitty",
      cmux: "cmux",
    };
    const key = cmdMap[explicitType];
    const avail = input.availability[key];
    if (avail && avail.status === "not-resolved") {
      warnings.push({
        kind: "explicit-backend-command-missing",
        severity: "warning",
        message: `Configured multiplexer type "${explicitType}" but "${avail.command}" not resolvable via command -v in the control-plane environment. May still run on the OMO host.`,
      });
    }
  }

  // Configured/detected drift → info only if runtime detected authoritative
  if (
    input.configured.type === "auto" &&
    input.detection.resolvedType !== null &&
    input.detection.resolvedType !== input.effective.type
  ) {
    // effective.type for auto is "auto" (configured value); the concrete backend
    // is detection.resolvedType. This is informational, not a drift error.
    warnings.push({
      kind: "auto-detected-backend",
      severity: "info",
      message: `multiplexer.type=auto detected "${input.detection.resolvedType}" from environment signals. Effective config retains type=auto; OMO resolves the concrete backend at plugin init.`,
    });
  }

  // Legacy tmux present → info (ignored, not a warning per spec)
  if (input.legacyTmuxPresent) {
    warnings.push({
      kind: "legacy-tmux-ignored",
      severity: "info",
      message:
        "Legacy top-level tmux config key present and ignored by OMO. Use multiplexer config instead (dist/index.js:18901-18911).",
    });
  }

  return warnings;
}

// ── Full DTO assembly (static halves; runtime injected by caller) ──────────

export interface BuildMultiplexerSystemOptions {
  bundle: ProvenanceBundle;
  env?: Record<string, string | undefined>;
  runner: CommandRunner;
  runtime: MultiplexerRuntime;
  now?: () => Date;
}

export async function buildMultiplexerSystem(
  opts: BuildMultiplexerSystemOptions,
): Promise<MultiplexerSystemDto> {
  const env = opts.env ?? process.env;
  const configured = resolveConfigured(opts.bundle);
  const { effective, provenance } = resolveEffective(opts.bundle);
  const legacyTmuxPresent = detectLegacyTmux(opts.bundle);
  const detection = resolveDetection(env);
  const availability = await resolveAvailability(opts.runner);
  const activation = resolveActivation(legacyTmuxPresent);
  const warnings = resolveWarnings({
    configured,
    effective,
    detection,
    availability,
    legacyTmuxPresent,
  });
  const now = (opts.now ?? (() => new Date()))();

  return {
    builtinDefaults: MULTIPLEXER_BUILTIN_DEFAULTS,
    configured,
    effective,
    provenance,
    legacy: {
      tmuxPresent: legacyTmuxPresent,
      ignored: true,
      note:
        "Legacy top-level tmux key is inspected at load and emits a warning, " +
        "then ignored. Not aliased to multiplexer.type and not migrated " +
        "(dist/index.js:18901-18911).",
    },
    availability,
    detection,
    runtime: opts.runtime,
    activation,
    capabilities: MULTIPLEXER_CAPABILITIES,
    warnings,
    generatedAt: now.toISOString(),
  };
}