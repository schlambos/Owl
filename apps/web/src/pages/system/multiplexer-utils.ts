/**
 * Multiplexer (Slice 16) — pure presentation logic.
 *
 * Every label here is grounded in the verified OMO 2.2.10 semantics that the
 * backend DTO documents (see packages/shared Multiplexer* types):
 *   - config is read once at plugin load; no hot reload;
 *   - layout applies to tmux (window layout), zellij/herdr (pane direction),
 *     kitty (layout mapping); cmux ignores it; none disables the multiplexer;
 *   - main_pane_size is used only by tmux main-horizontal/main-vertical;
 *     zellij/herdr constructors receive it but do not use it; kitty/cmux
 *     ignore it;
 *   - zellij_pane_mode applies only when the backend is zellij;
 *   - "auto" defers to environment-signal detection at plugin init.
 *
 * No runtime state is invented: relevance is derived from the DTO's
 * configured/effective/detection stages only.
 */
import type {
  MultiplexerLayout,
  MultiplexerSessionRecord,
  MultiplexerSystemDto,
  MultiplexerType,
} from "@omo/shared";

export const MUX_FIELDS = [
  "type",
  "layout",
  "main_pane_size",
  "zellij_pane_mode",
] as const;
export type MuxField = (typeof MUX_FIELDS)[number];

export const MUX_TYPE_OPTIONS: readonly MultiplexerType[] = [
  "auto",
  "tmux",
  "zellij",
  "herdr",
  "kitty",
  "cmux",
  "none",
];

export const MUX_LAYOUT_OPTIONS: readonly MultiplexerLayout[] = [
  "main-horizontal",
  "main-vertical",
  "tiled",
  "even-horizontal",
  "even-vertical",
];

export const MUX_ZELLIJ_MODE_OPTIONS = ["agent-tab", "current-tab"] as const;

export const MUX_MAIN_PANE_MIN = 20;
export const MUX_MAIN_PANE_MAX = 80;

/** Concrete backend in effect: explicit type, or detection for "auto". */
export function resolvedBackend(
  dto: MultiplexerSystemDto,
): MultiplexerType | null {
  if (dto.effective.type === "auto") return dto.detection.resolvedType;
  return dto.effective.type;
}

/** Short type label used wherever a mapping is shown (jobs panel, overview). */
export function muxTypeLabel(dto: MultiplexerSystemDto): string {
  return resolvedBackend(dto) ?? dto.effective.type;
}

export interface FieldRelevance {
  /** active — the backend consumes the value; inactive — stored but unused. */
  state: "active" | "inactive" | "unknown";
  label: string;
}

/**
 * Relevance of `multiplexer.layout` for the effective/detected backend.
 * tmux window layout; zellij/herdr direction; kitty layout mapping; cmux
 * ignores; none inactive; auto-without-signal unknown.
 */
export function layoutRelevance(
  dto: MultiplexerSystemDto,
): FieldRelevance {
  const backend = resolvedBackend(dto);
  const autoSuffix =
    dto.effective.type === "auto"
      ? backend
        ? ` (auto → ${backend})`
        : " (auto)"
      : "";
  switch (backend) {
    case "tmux":
      return { state: "active", label: `applies — tmux window layout${autoSuffix}` };
    case "zellij":
      return { state: "active", label: `applies — zellij pane direction${autoSuffix}` };
    case "herdr":
      return { state: "active", label: `applies — herdr pane direction${autoSuffix}` };
    case "kitty":
      return { state: "active", label: `applies — mapped to a kitty layout${autoSuffix}` };
    case "cmux":
      return { state: "inactive", label: `ignored — cmux does not use layout${autoSuffix}` };
    case "none":
      return { state: "inactive", label: "inactive — multiplexer disabled (none)" };
    default:
      return {
        state: "unknown",
        label:
          "unknown — auto detected no backend; relevance depends on the backend resolved at plugin init",
      };
  }
}

/**
 * Relevance of `multiplexer.main_pane_size`. Only tmux main-horizontal /
 * main-vertical consume it. zellij/herdr receive the value in their
 * constructor but do not use it; kitty/cmux ignore it.
 */
export function mainPaneSizeRelevance(
  dto: MultiplexerSystemDto,
): FieldRelevance {
  const backend = resolvedBackend(dto);
  const layout = dto.effective.layout;
  const autoSuffix =
    dto.effective.type === "auto"
      ? backend
        ? ` (auto → ${backend})`
        : " (auto)"
      : "";
  switch (backend) {
    case "tmux":
      return layout === "main-horizontal" || layout === "main-vertical"
        ? { state: "active", label: `applies — tmux ${layout} main pane %${autoSuffix}` }
        : {
            state: "inactive",
            label: `not used — tmux ${layout} has no main pane${autoSuffix}`,
          };
    case "zellij":
      return {
        state: "inactive",
        label: `received by the zellij constructor but not used${autoSuffix}`,
      };
    case "herdr":
      return {
        state: "inactive",
        label: `received by the herdr constructor but not used${autoSuffix}`,
      };
    case "kitty":
      return { state: "inactive", label: `ignored by the kitty constructor${autoSuffix}` };
    case "cmux":
      return { state: "inactive", label: `ignored by cmux${autoSuffix}` };
    case "none":
      return { state: "inactive", label: "inactive — multiplexer disabled (none)" };
    default:
      return {
        state: "unknown",
        label:
          "unknown — auto detected no backend; only tmux main-horizontal/main-vertical use this value",
      };
  }
}

/** Relevance of `multiplexer.zellij_pane_mode` — zellij backends only. */
export function zellijPaneModeRelevance(
  dto: MultiplexerSystemDto,
): FieldRelevance {
  const backend = resolvedBackend(dto);
  const autoSuffix =
    dto.effective.type === "auto"
      ? backend
        ? ` (auto → ${backend})`
        : " (auto)"
      : "";
  if (backend === "zellij") {
    return { state: "active", label: `applies — zellij pane placement${autoSuffix}` };
  }
  if (backend === null) {
    return {
      state: "unknown",
      label:
        "unknown — auto detected no backend; only applies when zellij is resolved",
    };
  }
  return {
    state: "inactive",
    label: `configured but inactive — only applies to zellij (backend is ${backend})${autoSuffix}`,
  };
}

export function fieldRelevance(
  dto: MultiplexerSystemDto,
  field: MuxField,
): FieldRelevance {
  if (field === "type") {
    return { state: "active", label: "selects the backend at plugin init" };
  }
  if (field === "layout") return layoutRelevance(dto);
  if (field === "main_pane_size") return mainPaneSizeRelevance(dto);
  return zellijPaneModeRelevance(dto);
}

/**
 * Verified state labels for an OMO-owned session record. Only the exact
 * collection-membership flags from the bridge store are shown; a record with
 * no flags is "recorded" (present in the session-manager store).
 */
export function recordStateLabel(rec: MultiplexerSessionRecord): string {
  const flags: string[] = [];
  if (rec.spawning) flags.push("spawning");
  if (rec.closing) flags.push("closing");
  if (rec.permanentlyClosed) flags.push("permanently closed");
  if (rec.known) flags.push("known");
  return flags.length ? flags.join(" · ") : "recorded";
}

/** Terminal label for an OMO job row: `type paneId` (pane optional). */
export function terminalLabel(
  dto: MultiplexerSystemDto,
  rec: MultiplexerSessionRecord,
): string {
  const type = muxTypeLabel(dto);
  return rec.paneId ? `${type} ${rec.paneId}` : type;
}

/**
 * True when the runtime mapping is authoritative enough to display as fact:
 * bridge connected and the mapping not flagged unavailable. Stale data is
 * still real snapshot data — callers should badge it, not hide it.
 */
export function mappingAuthoritative(dto: MultiplexerSystemDto): boolean {
  return dto.runtime.bridgeConnected && !dto.runtime.mapping.unavailable;
}

/** True when counts may be shown (authoritative and not stale). */
export function mappingLive(dto: MultiplexerSystemDto): boolean {
  return mappingAuthoritative(dto) && !dto.runtime.mapping.stale;
}

/** Names of the detection env signals that are set — never their values. */
export function detectionSignalNames(dto: MultiplexerSystemDto): string[] {
  return Object.keys(dto.detection.signals).sort();
}
