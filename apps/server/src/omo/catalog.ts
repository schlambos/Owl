/**
 * Installed OMO-Slim option catalog (oh-my-opencode-slim@2.2.10).
 * Derived from schema JSON + dist implementation. Authoritative.
 */

export interface OmoCapabilities {
  readable: boolean;
  resolved: boolean;
  provenance: boolean;
  editable: boolean;
  runtimeObservable: boolean | "partial";
  runtimeControllable: boolean;
  doctor: boolean;
}

export interface OmoOption {
  path: string;
  schemaType: string;
  defaultValue?: unknown;
  implementationDefault?: unknown;
  enumValues?: unknown[];
  minimum?: number;
  maximum?: number;
  support:
    | "implemented-prior"
    | "implemented-slice-9"
    | "implemented-slice-16"
    | "read-only-slice-13"
    | "typed-capable-slice-18"
    | "deferred"
    | "unsupported-installed-version";
  effect:
    | "control-plane-only"
    | "plugin-load"
    | "new-sessions"
    | "live-if-reloaded"
    | "ui-refresh"
    | "unknown";
  capabilities: OmoCapabilities;
  evidence: string;
}

const CAP_EDIT: OmoCapabilities = {
  readable: true,
  resolved: true,
  provenance: true,
  editable: true,
  runtimeObservable: false,
  runtimeControllable: false,
  doctor: true,
};
const CAP_READ_ONLY_13: OmoCapabilities = {
  readable: true,
  resolved: true,
  provenance: true,
  editable: false,
  runtimeObservable: false,
  runtimeControllable: false,
  doctor: true,
};
  /** Interview typed writes are schema/version/hash gated (Slice 18 D2). */
const CAP_INTERVIEW_TYPED_18: OmoCapabilities = {
  readable: true,
  resolved: true,
  provenance: true,
  editable: true,
  runtimeObservable: false,
  runtimeControllable: false,
  doctor: true,
};
const CAP_UNSUPPORTED: OmoCapabilities = {
  readable: false,
  resolved: false,
  provenance: false,
  editable: false,
  runtimeObservable: false,
  runtimeControllable: false,
  doctor: false,
};
const CAP_DEFERRED: OmoCapabilities = {
  readable: true,
  resolved: true,
  provenance: true,
  editable: false,
  runtimeObservable: false,
  runtimeControllable: false,
  doctor: false,
};

export const OPTION_CATALOG: OmoOption[] = [
  { path: "preset", schemaType: "string", support: "implemented-prior", effect: "plugin-load", capabilities: CAP_EDIT, evidence: "Slice 8" },
  { path: "presets", schemaType: "object", support: "implemented-prior", effect: "plugin-load", capabilities: CAP_EDIT, evidence: "Slice 8" },
  { path: "agents", schemaType: "object", support: "implemented-prior", effect: "plugin-load", capabilities: { ...CAP_EDIT, runtimeObservable: "partial" }, evidence: "Slices 5–7; live registration/model visible via GET /agent" },
  { path: "disabled_agents", schemaType: "string[]", support: "implemented-slice-9", effect: "plugin-load", capabilities: CAP_EDIT, evidence: "schema: orchestrator/councillor protected; default observer disabled" },
  { path: "disabled_skills", schemaType: "string[]", support: "implemented-slice-9", effect: "plugin-load", capabilities: CAP_EDIT, evidence: "schema" },
  { path: "disabled_mcps", schemaType: "string[]", support: "implemented-slice-9", effect: "plugin-load", capabilities: { ...CAP_EDIT, runtimeObservable: "partial" }, evidence: "schema; MCP runtime status visible via GET /mcp" },
  { path: "disabled_tools", schemaType: "string[]", support: "implemented-slice-9", effect: "plugin-load", capabilities: CAP_EDIT, evidence: "schema" },
  { path: "backgroundJobs.strategy", schemaType: "string", defaultValue: "latest", enumValues: ["latest", "checkpoint-compatible"], support: "implemented-slice-9", effect: "plugin-load", capabilities: CAP_EDIT, evidence: "schema" },
  { path: "backgroundJobs.maxSessionsPerAgent", schemaType: "integer", defaultValue: 2, minimum: 1, maximum: 10, support: "implemented-slice-9", effect: "new-sessions", capabilities: CAP_EDIT, evidence: "schema + DEFAULT_MAX_SESSIONS_PER_AGENT" },
  { path: "backgroundJobs.maxContextLines", schemaType: "integer", defaultValue: 50000, minimum: 0, maximum: 500000, support: "implemented-slice-9", effect: "plugin-load", capabilities: CAP_EDIT, evidence: "schema" },
  { path: "backgroundJobs.readContextMinLines", schemaType: "integer", defaultValue: 10, minimum: 0, maximum: 1000, support: "implemented-slice-9", effect: "plugin-load", capabilities: CAP_EDIT, evidence: "schema" },
  { path: "backgroundJobs.readContextMaxFiles", schemaType: "integer", defaultValue: 8, minimum: 0, maximum: 50, support: "implemented-slice-9", effect: "plugin-load", capabilities: CAP_EDIT, evidence: "schema" },
  { path: "backgroundJobs.maxRetainedSnapshots", schemaType: "integer", defaultValue: 20, minimum: 1, maximum: 100, support: "implemented-slice-9", effect: "plugin-load", capabilities: CAP_EDIT, evidence: "schema" },
  { path: "backgroundJobs.continueOnIdle", schemaType: "boolean", defaultValue: false, support: "implemented-slice-9", effect: "plugin-load", capabilities: CAP_EDIT, evidence: "schema (beta opt-in)" },
  { path: "backgroundJobs.wallClockTimeoutMs", schemaType: "0 | int", defaultValue: 0, minimum: 60000, maximum: 2147483647, support: "implemented-slice-9", effect: "new-sessions", capabilities: CAP_EDIT, evidence: "schema: 0 disables supervision" },
  { path: "backgroundJobs.abortGraceMs", schemaType: "integer", defaultValue: 10000, minimum: 1000, maximum: 60000, support: "implemented-slice-9", effect: "new-sessions", capabilities: CAP_EDIT, evidence: "schema" },
  { path: "fallback.enabled", schemaType: "boolean", defaultValue: true, support: "implemented-slice-9", effect: "plugin-load", capabilities: CAP_EDIT, evidence: "schema" },
  { path: "fallback.timeoutMs", schemaType: "number", defaultValue: 15000, minimum: 0, support: "implemented-slice-9", effect: "new-sessions", capabilities: CAP_EDIT, evidence: "schema" },
  { path: "fallback.retryDelayMs", schemaType: "number", defaultValue: 500, minimum: 0, support: "implemented-slice-9", effect: "new-sessions", capabilities: CAP_EDIT, evidence: "schema" },
  { path: "fallback.maxRetries", schemaType: "integer", defaultValue: 3, minimum: 0, support: "implemented-slice-9", effect: "new-sessions", capabilities: CAP_EDIT, evidence: "schema" },
  { path: "fallback.retry_on_empty", schemaType: "boolean", defaultValue: true, support: "implemented-slice-9", effect: "new-sessions", capabilities: CAP_EDIT, evidence: "schema exact name" },
  { path: "fallback.runtimeOverride", schemaType: "boolean", support: "unsupported-installed-version", effect: "unknown", capabilities: CAP_UNSUPPORTED, evidence: "DEPRECATED in schema" },
  { path: "image_routing", schemaType: "string", enumValues: ["auto", "direct"], support: "implemented-slice-9", effect: "new-sessions", capabilities: CAP_EDIT, evidence: "resolveImageRouting: omit → observerEnabled?auto:direct" },
  { path: "stripOrchestratorModel", schemaType: "boolean", defaultValue: false, support: "implemented-slice-9", effect: "plugin-load", capabilities: CAP_EDIT, evidence: "schema" },
  { path: "compactSidebar", schemaType: "boolean", defaultValue: true, support: "implemented-slice-9", effect: "ui-refresh", capabilities: CAP_EDIT, evidence: "schema" },
  { path: "setDefaultAgent", schemaType: "boolean", support: "implemented-slice-9", effect: "plugin-load", capabilities: CAP_EDIT, evidence: "schema" },
  { path: "autoUpdate", schemaType: "boolean", defaultValue: true, support: "implemented-slice-9", effect: "plugin-load", capabilities: CAP_EDIT, evidence: "schema" },
  { path: "showStartupToast", schemaType: "—", support: "unsupported-installed-version", effect: "unknown", capabilities: CAP_UNSUPPORTED, evidence: "absent from installed schema/dist" },
  { path: "webfetch.enabled", schemaType: "boolean", defaultValue: true, support: "implemented-slice-9", effect: "plugin-load", capabilities: CAP_EDIT, evidence: "schema" },
  { path: "webfetch.model", schemaType: "string|array", support: "implemented-slice-9", effect: "plugin-load", capabilities: CAP_EDIT, evidence: "schema" },
  { path: "council.default_preset", schemaType: "string", defaultValue: "default", support: "implemented-prior", effect: "new-sessions", capabilities: CAP_EDIT, evidence: "Slice 10" },
  { path: "council.presets", schemaType: "object", support: "implemented-prior", effect: "new-sessions", capabilities: CAP_EDIT, evidence: "Slice 10: council-preset lifecycle" },
  { path: "council.presets.<name>.<member>.model", schemaType: "string | chain", support: "implemented-prior", effect: "new-sessions", capabilities: CAP_EDIT, evidence: "Slice 10: single or ordered fallback chain" },
  { path: "council.presets.<name>.<member>.variant", schemaType: "string", support: "implemented-prior", effect: "new-sessions", capabilities: CAP_EDIT, evidence: "Slice 10" },
  { path: "council.presets.<name>.<member>.prompt", schemaType: "string", support: "implemented-prior", effect: "new-sessions", capabilities: CAP_EDIT, evidence: "Slice 10: perspective prompt" },
  { path: "council.master*", schemaType: "legacy", support: "unsupported-installed-version", effect: "unknown", capabilities: { ...CAP_UNSUPPORTED, readable: true, doctor: true }, evidence: "parsed as _deprecated; reserved key silently ignored" },
  { path: "acpAgents.<name>.command", schemaType: "string", support: "implemented-prior", effect: "plugin-load", capabilities: { ...CAP_EDIT, runtimeObservable: "partial" }, evidence: "Slice 11: required; wrapper registration visible via GET /agent, external process opaque" },
  { path: "acpAgents.<name>.args", schemaType: "string[]", defaultValue: [], support: "implemented-prior", effect: "plugin-load", capabilities: { ...CAP_EDIT, runtimeObservable: "partial" }, evidence: "Slice 11" },
  { path: "acpAgents.<name>.env", schemaType: "object", defaultValue: {}, support: "implemented-prior", effect: "plugin-load", capabilities: { ...CAP_EDIT, runtimeObservable: "partial" }, evidence: "Slice 11: merged into spawn env" },
  { path: "acpAgents.<name>.cwd", schemaType: "string", support: "implemented-prior", effect: "plugin-load", capabilities: { ...CAP_EDIT, runtimeObservable: "partial" }, evidence: "Slice 11" },
  { path: "acpAgents.<name>.description", schemaType: "string", support: "implemented-prior", effect: "plugin-load", capabilities: { ...CAP_EDIT, runtimeObservable: "partial" }, evidence: "Slice 11" },
  { path: "acpAgents.<name>.prompt", schemaType: "string", support: "implemented-prior", effect: "plugin-load", capabilities: { ...CAP_EDIT, runtimeObservable: "partial" }, evidence: "Slice 11: wrapper prompt override" },
  { path: "acpAgents.<name>.orchestratorPrompt", schemaType: "string", support: "implemented-prior", effect: "plugin-load", capabilities: { ...CAP_EDIT, runtimeObservable: "partial" }, evidence: "Slice 11: routing text" },
  { path: "acpAgents.<name>.wrapperModel", schemaType: "string", support: "implemented-prior", effect: "plugin-load", capabilities: { ...CAP_EDIT, runtimeObservable: "partial" }, evidence: "Slice 11: provider/model for wrapper" },
  { path: "acpAgents.<name>.timeoutMs", schemaType: "integer", defaultValue: 0, minimum: 0, maximum: 2147483647, support: "implemented-prior", effect: "new-sessions", capabilities: { ...CAP_EDIT, runtimeObservable: "partial" }, evidence: "Slice 11: 0 = disabled" },
  { path: "acpAgents.<name>.permissionMode", schemaType: "string", defaultValue: "ask", enumValues: ["ask", "allow", "reject"], support: "implemented-prior", effect: "new-sessions", capabilities: { ...CAP_EDIT, runtimeObservable: "partial" }, evidence: "Slice 11" },
  { path: "multiplexer.type", schemaType: "string", defaultValue: "none", enumValues: ["auto", "tmux", "zellij", "herdr", "kitty", "cmux", "none"], support: "implemented-slice-16", effect: "plugin-load", capabilities: { readable: true, resolved: true, provenance: true, editable: true, runtimeObservable: "partial", runtimeControllable: false, doctor: true }, evidence: "Slice 16: schema:941-955; zod dist/index.js:18753-18761; factory auto order dist/index.js:35553-35572; init dist/index.js:40831-40838" },
  { path: "multiplexer.layout", schemaType: "string", defaultValue: "main-vertical", enumValues: ["main-horizontal", "main-vertical", "tiled", "even-horizontal", "even-vertical"], support: "implemented-slice-16", effect: "plugin-load", capabilities: { readable: true, resolved: true, provenance: true, editable: true, runtimeObservable: "partial", runtimeControllable: false, doctor: true }, evidence: "Slice 16: schema:957-966; zod dist/index.js:18762-18768; tmux applyLayout dist/index.js:35085-35141; zellij paneDirection dist/index.js:35508-35518; herdr paneDirection dist/index.js:34807-34817" },
  { path: "multiplexer.main_pane_size", schemaType: "number", defaultValue: 60, minimum: 20, maximum: 80, support: "implemented-slice-16", effect: "plugin-load", capabilities: { readable: true, resolved: true, provenance: true, editable: true, runtimeObservable: "partial", runtimeControllable: false, doctor: true }, evidence: "Slice 16: schema:968-972; zod dist/index.js:18773; tmux main-pane-width/height dist/index.js:35119-35128" },
  { path: "multiplexer.zellij_pane_mode", schemaType: "string", defaultValue: "agent-tab", enumValues: ["agent-tab", "current-tab"], support: "implemented-slice-16", effect: "plugin-load", capabilities: { readable: true, resolved: true, provenance: true, editable: true, runtimeObservable: "partial", runtimeControllable: false, doctor: true }, evidence: "Slice 16: schema:974-980; zod dist/index.js:18769-18774; zellij spawnPane agent-tab/current-tab dist/index.js:35199-35226" },
  { path: "companion.enabled", schemaType: "boolean", defaultValue: false, support: "read-only-slice-13", effect: "plugin-load", capabilities: CAP_READ_ONLY_13, evidence: "2.2.10 CompanionConfigSchema; config read once at plugin init — restart required" },
  { path: "companion.binaryPath", schemaType: "string", support: "read-only-slice-13", effect: "plugin-load", capabilities: CAP_READ_ONLY_13, evidence: "2.2.10 CompanionConfigSchema; min length 1, no default; default discovery under XDG data home — restart required" },
  { path: "companion.position", schemaType: "enum", defaultValue: "bottom-right", enumValues: ["bottom-right", "bottom-left", "top-right", "top-left"], support: "read-only-slice-13", effect: "plugin-load", capabilities: CAP_READ_ONLY_13, evidence: "2.2.10 CompanionConfigSchema — restart required" },
  { path: "companion.size", schemaType: "enum", defaultValue: "medium", enumValues: ["small", "medium", "large"], support: "read-only-slice-13", effect: "plugin-load", capabilities: CAP_READ_ONLY_13, evidence: "2.2.10 CompanionConfigSchema — restart required" },
  { path: "companion.gifPack", schemaType: "enum", defaultValue: "default", enumValues: ["default"], support: "read-only-slice-13", effect: "plugin-load", capabilities: CAP_READ_ONLY_13, evidence: "2.2.10 CompanionConfigSchema — restart required" },
  { path: "companion.loopStyle", schemaType: "enum", defaultValue: "classic", enumValues: ["classic", "smooth"], support: "read-only-slice-13", effect: "plugin-load", capabilities: CAP_READ_ONLY_13, evidence: "2.2.10 CompanionConfigSchema — restart required" },
  { path: "companion.speed", schemaType: "number", defaultValue: 1, minimum: 0.25, maximum: 4, support: "read-only-slice-13", effect: "plugin-load", capabilities: CAP_READ_ONLY_13, evidence: "2.2.10 CompanionConfigSchema — restart required" },
  { path: "companion.debug", schemaType: "boolean", defaultValue: false, support: "read-only-slice-13", effect: "plugin-load", capabilities: CAP_READ_ONLY_13, evidence: "2.2.10 CompanionConfigSchema — restart required" },
  { path: "interview.maxQuestions", schemaType: "integer", defaultValue: 2, minimum: 1, maximum: 10, support: "typed-capable-slice-18", effect: "plugin-load", capabilities: CAP_INTERVIEW_TYPED_18, evidence: "2.2.10 InterviewConfigSchema dist/index.js:18778-18784 + schema SHA-256 947ac72a9035e0b7d7ce80c6e8f16ccdf930677b6b80b61d83b054cedbd30e8b; manager config captured at plugin init (40955) — restart required; typed writes fail-closed unless version/hash/fields match" },
  { path: "interview.outputFolder", schemaType: "string", defaultValue: "interview", support: "typed-capable-slice-18", effect: "plugin-load", capabilities: CAP_INTERVIEW_TYPED_18, evidence: "2.2.10 InterviewConfigSchema; normalizeOutputFolder trim+slash strip dist/index.js:28996-28999; join under project dir 29000-29002 — metadata only, never inspect destination" },
  { path: "interview.autoOpenBrowser", schemaType: "boolean", defaultValue: true, support: "typed-capable-slice-18", effect: "plugin-load", capabilities: CAP_INTERVIEW_TYPED_18, evidence: "2.2.10 InterviewConfigSchema; shouldAutoOpenBrowser dist/index.js:32812-32818; control plane never launches a browser" },
  { path: "interview.port", schemaType: "integer", defaultValue: 0, minimum: 0, maximum: 65535, support: "typed-capable-slice-18", effect: "plugin-load", capabilities: CAP_INTERVIEW_TYPED_18, evidence: "2.2.10 InterviewConfigSchema; 0 = OS-assigned per-session, >0 = dashboard (dist/index.js:33907-33916) — no port probe" },
  { path: "interview.dashboard", schemaType: "boolean", defaultValue: false, support: "typed-capable-slice-18", effect: "plugin-load", capabilities: CAP_INTERVIEW_TYPED_18, evidence: "2.2.10 InterviewConfigSchema; dashboardEnabled = dashboard || port>0; default dashboard port 43211 (dist/index.js:31268)" },
];

export const PROTECTED_AGENTS = new Set(["orchestrator", "councillor"]);
export const DEFAULT_DISABLED_AGENTS = ["observer"];

export const BACKGROUND_JOBS_FIELDS: Array<{
  key: string;
  type: "int" | "bool" | "enum" | "wallclock";
  min?: number;
  max?: number;
  default: unknown;
  enum?: string[];
}> = [
  { key: "strategy", type: "enum", default: "latest", enum: ["latest", "checkpoint-compatible"] },
  { key: "maxSessionsPerAgent", type: "int", min: 1, max: 10, default: 2 },
  { key: "maxContextLines", type: "int", min: 0, max: 500000, default: 50000 },
  { key: "readContextMinLines", type: "int", min: 0, max: 1000, default: 10 },
  { key: "readContextMaxFiles", type: "int", min: 0, max: 50, default: 8 },
  { key: "maxRetainedSnapshots", type: "int", min: 1, max: 100, default: 20 },
  { key: "continueOnIdle", type: "bool", default: false },
  { key: "wallClockTimeoutMs", type: "wallclock", min: 60000, max: 2147483647, default: 0 },
  { key: "abortGraceMs", type: "int", min: 1000, max: 60000, default: 10000 },
];

export const FALLBACK_FIELDS: Array<{
  key: string;
  type: "int" | "bool" | "num";
  min?: number;
  max?: number;
  default: unknown;
}> = [
  { key: "enabled", type: "bool", default: true },
  { key: "timeoutMs", type: "num", min: 0, default: 15000 },
  { key: "retryDelayMs", type: "num", min: 0, default: 500 },
  { key: "maxRetries", type: "int", min: 0, default: 3 },
  { key: "retry_on_empty", type: "bool", default: true },
];
