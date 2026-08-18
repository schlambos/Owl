# Slice 16 — Multiplexer Source Audit

**Date:** 2026-08-13  
**Status:** Factual — citations from installed `oh-my-opencode-slim@2.2.10`  
**Package:** `oh-my-opencode-slim@2.2.10` (`<opencode-config-dir>/node_modules/oh-my-opencode-slim`)

## 1. Schema (JSON Schema)

**File:** `oh-my-opencode-slim.schema.json:941-982`

```
"multiplexer": {
  "type": "object",
  "properties": {
    "type":          { "default": "none",          "type": "string", "enum": ["auto","tmux","zellij","herdr","kitty","cmux","none"] },
    "layout":        { "default": "main-vertical", "type": "string", "enum": ["main-horizontal","main-vertical","tiled","even-horizontal","even-vertical"] },
    "main_pane_size":{ "default": 60,              "type": "number", "minimum": 20, "maximum": 80 },
    "zellij_pane_mode":{ "default": "agent-tab",   "type": "string", "enum": ["agent-tab","current-tab"] }
  }
}
```

No `additionalProperties: false` on the multiplexer object — unknown nested keys are not schema-rejected at the JSON Schema level, but Zod strips them at runtime (see §2).

## 2. Zod Runtime Schema

**File:** `dist/index.js:18753-18775`

```js
var MultiplexerTypeSchema     = z2.enum(["auto","tmux","zellij","herdr","kitty","cmux","none"]);
var MultiplexerLayoutSchema   = z2.enum(["main-horizontal","main-vertical","tiled","even-horizontal","even-vertical"]);
var ZellijPaneModeSchema       = z2.enum(["agent-tab","current-tab"]);
var MultiplexerConfigSchema    = z2.object({
  type:             MultiplexerTypeSchema.default("none"),
  layout:           MultiplexerLayoutSchema.default("main-vertical"),
  main_pane_size:   z2.number().min(20).max(80).default(60),
  zellij_pane_mode: ZellijPaneModeSchema.default("agent-tab")
});
```

**Type:** `dist/config/schema.d.ts:357-380` — `MultiplexerConfigSchema` is `ZodObject<..., z.core.$strip>`. Unknown nested fields are **stripped** by runtime Zod parse, but raw JSONC must be preserved by the control plane writer.

**PluginConfigSchema:** `dist/index.js:18857` — `multiplexer: MultiplexerConfigSchema.optional()`.

## 3. Loader (safeParse + legacy tmux)

**File:** `dist/index.js:18881-18944`

- `loadConfigFromPath` reads file → `stripJsonComments` → `{env:VAR}` interpolation → `JSON.parse` → `PluginConfigSchema.safeParse`.
- **Legacy top-level `tmux`:** `dist/index.js:18901-18911` — if raw config has `"tmux"` key, emits exact warning `"Deprecated tmux config key found and ignored. Use multiplexer config instead."` and **ignores** it. Not aliased, not migrated. The modern `multiplexer` solely controls behavior.
- `safeParse` failure → returns `null` + warning (config does not match schema).

## 4. Deep Merge (user/project)

**File:** `dist/index.js` around line 19008 — `mergePluginConfigs` deep-merges `multiplexer` (nested object merge). Existing project provenance `mergePluginConfigs` in `apps/server/src/omo/provenance.ts:158-161` already handles multiplexer deep merge.

## 5. Plugin Init Defaults + Capture

**File:** `dist/index.js:40831-40846`

```js
multiplexerConfig = {
  type:             config.multiplexer?.type ?? "none",
  layout:           config.multiplexer?.layout ?? "main-vertical",
  main_pane_size:   config.multiplexer?.main_pane_size ?? 60,
  zellij_pane_mode: config.multiplexer?.zellij_pane_mode ?? "agent-tab"
};
const multiplexer = getMultiplexer(multiplexerConfig);
multiplexerEnabled = multiplexerConfig.type !== "none" && multiplexer !== null && multiplexer.isInsideSession();
if (multiplexerEnabled) {
  startAvailabilityCheck(multiplexerConfig);
}
```

- Config read **once at plugin init** → restart required for changes.
- `startAvailabilityCheck` starts once at plugin init **only if inside session** (`dist/index.js:40844-40845`).
- **No hot reload** proven in 2.2.10.

## 6. Factory / Auto Resolution

**File:** `dist/index.js:35525-35586` (`getMultiplexer`)

- Explicit `none` → `null` (no multiplexer).
- `auto` order (dist/index.js:35553-35572):
  1. `CMUX_SOCKET_PATH && CMUX_WORKSPACE_ID && CMUX_SURFACE_ID` → cmux
  2. `TMUX` → tmux
  3. `ZELLIJ` → zellij
  4. `HERDR_ENV || HERDR_PANE_ID` → herdr
  5. `KITTY_PID || KITTY_WINDOW_ID` → kitty
  6. else → `null` (log: "auto: not inside any session, disabling")
- **No ancestry/executable availability in auto selection.** Auto uses env signals only.
- Availability check starts once at plugin init only if inside session.

## 7. Command Behavior (per backend)

| Backend  | Binary resolution | Verification | Source |
|----------|-------------------|--------------|--------|
| tmux     | `findBinary("tmux", { verify: true })` | `tmux -V` exit 0 | dist/index.js:35023 |
| zellij   | `findBinary("zellij")` | none | dist/index.js:35192 |
| herdr    | `findBinary("herdr")` | none | dist/index.js:34648 |
| kitty    | `findBinary("kitten") ?? findBinary("kitty")` | none | dist/index.js:34834 |
| cmux     | `client.version()` + `resolveHostOpencodeBinary()` | version ≥ MINIMUM_VERSION | dist/index.js:34127-34136, 34117-34125 |
| opencode | `resolveHostOpencodeBinary()` | path exists, basename matches | dist/index.js:34010-34016 |

`findBinary` (`dist/index.js:34018-34068`): runs `which <name>` (or `where` on Windows), trims first stdout line, optional `-V` verify.

**Control plane constraint:** may ONLY use static `command -v` for `tmux, zellij, herdr, kitten, kitty, cmux, opencode`. No user-supplied command, no version/binary execution, no path crawl.

## 8. Layout / Backend Semantics

### tmux (`dist/index.js:35085-35141`)
- `applyLayoutNow(layout, mainPaneSize)`: `tmux select-layout <layout>`.
- For `main-horizontal` / `main-vertical`: sets `main-pane-height` / `main-pane-width` to `{mainPaneSize}%`, then re-applies layout.
- `tiled`, `even-horizontal`, `even-vertical`: select-layout only (no size option).

### zellij (`dist/index.js:35184-35518`)
- `getPaneDirection2(layout)` (dist/index.js:35508-35518):
  - `main-vertical` → `"right"`
  - `main-horizontal` → `"down"`
  - `even-horizontal`, `even-vertical`, `tiled` → `null` (no direction)
- `applyLayout` is a **no-op** (`dist/index.js:35468`: `async applyLayout(_layout, _mainPaneSize) {}`).
- `zellij_pane_mode`:
  - `agent-tab` (default): creates/uses a dedicated "opencode-agents" tab; first pane reused, subsequent panes created in that tab.
  - `current-tab`: creates panes in the parent tab via `createPaneInCurrentTab`.

### herdr (`dist/index.js:34631-34817`)
- `getPaneDirection(layout)` (dist/index.js:34807-34817):
  - `main-horizontal`, `even-vertical` → `"down"`
  - `main-vertical`, `even-horizontal`, `tiled` → `"right"`
- Layout affects pane split direction in the agent area.

### kitty (`dist/index.js:34821-34984`)
- Layout not directly applied via `applyLayout`; kitty uses `@new-window` / `@close-window` remote control.
- `main_pane_size` not used by kitty backend.

### cmux (`dist/index.js:34108-34127`)
- No layout/main_pane_size — cmux manages its own surfaces.

## 9. Stores

### Multiplexer Session Manager
**Symbol:** `Symbol.for("oh-my-opencode-slim.multiplexer-session-manager.state")`  
**File:** `dist/index.js:36299-36315`

```js
state = {
  sessions: new Map(),               // sessionId → { sessionId, paneId, parentId, title, directory, ownerInstanceId }
  knownSessions: new Map(),          // sessionId → { parentId, title, directory }
  spawningSessions: new Set(),       // sessionId
  closingSessions: new Map(),       // sessionId → Promise
  permanentlyClosedSessions: new Set() // sessionId
};
```

- **Keys** are exact OpenCode child session IDs: `onSessionCreated` uses `info.id` (`dist/index.js:36407-36413`).
- **known/spawning writes:** `dist/index.js:36436-36441`.
- **sessions values** (`dist/index.js:36486-36493`): `{ sessionId, paneId, parentId, title, directory, ownerInstanceId }`.
- **Bridge v2 expose ONLY:** `sessionId, paneId, parentId, title` + exact boolean collection membership (known/spawning/closing/permanentlyClosed). **NEVER** directory/owner/promise/raw object.
- Pane ID is safe because mapping is OMO-owned. Title from OMO-owned mapping only.

### cmux Session Store
**Symbol:** `Symbol.for("oh-my-opencode-slim.cmux-session-store")`  
**File:** `dist/index.js:35667-35672`  
**Type:** `dist/multiplexer/cmux/session-state.d.ts:12-31`

```ts
interface CmuxSessionRecord {
  session: string;          // → sessionId
  owner: string;             // NOT exposed
  parent: string;            // → parentSessionId
  title: string;             // → title
  directory: string;         // NOT exposed
  paneId?: string;           // → paneId
  spawnState: 'known'|'spawning'|'attached'|'failed';
  lifecycle: 'active'|'deleted'|'orphaned';
  attachedAt?: number;       // NOT exposed
  lastActivityAt: number;    // NOT exposed
  activityVersion: number;   // NOT exposed
  idleConsecutive: number;   // NOT exposed
  statusMissingSince?: number; // NOT exposed
  deferredSpawn?: ...;       // NOT exposed
  closeIntent?: ...;         // NOT exposed
  closeTimer?: ...;          // NOT exposed
  spawnPromise?: ...;        // NOT exposed
}
```

- **Bridge v2 expose ONLY:** `sessionId=record.session, parentSessionId=record.parent, paneId, title, spawnState, lifecycle, panePresent`. No directory/owner/timestamps/activity/intent/timers/promises.

## 10. Field Matrix

| Field | Schema Path | Type | Enum/Range | Default | Omission | Aliases | Behavior | Activation |
|-------|-------------|------|-----------|---------|----------|---------|----------|------------|
| type | multiplexer.type | string | auto/tmux/zellij/herdr/kitty/cmux/none | none | → none (builtin default) | none (legacy top-level `tmux` is NOT an alias) | Selects multiplexer backend; `none`→null, `auto`→env detection | plugin-load |
| layout | multiplexer.layout | string | main-horizontal/main-vertical/tiled/even-horizontal/even-vertical | main-vertical | → main-vertical | none | Pane direction + tmux select-layout | plugin-load |
| main_pane_size | multiplexer.main_pane_size | number | 20..80 | 60 | → 60 | none | tmux main-pane-width/height %; zellij/herdr pane direction; kitty/cmux unused | plugin-load |
| zellij_pane_mode | multiplexer.zellij_pane_mode | string | agent-tab/current-tab | agent-tab | → agent-tab | none | zellij only: agent-tab (dedicated tab) vs current-tab | plugin-load |

## 11. Capability Matrix

| Capability | Value | Evidence |
|-----------|-------|---------|
| readable | true | schema + provenance resolver |
| resolved | true | builtin defaults applied |
| provenance | true | per-leaf source tracing |
| editable | true | GlobalMutation multiplexer FieldOps + schema-gated write |
| runtimeObservable | partial | bridge v2 store snapshots + OpenCode session/job mapping only |
| runtimeControllable | false | control plane cannot drive the multiplexer |
| doctor | true | conservative rules (Slice 16) |

## 12. Proven / Unknown

**Proven:**
- Schema fields, enums, defaults, ranges (schema + zod).
- Legacy top-level tmux ignored (dist/index.js:18901-18911).
- Auto factory order (dist/index.js:35553-35572).
- Plugin init defaults + availability check timing (dist/index.js:40831-40846).
- Store symbols + collection shapes (dist/index.js:36299-36315, 35667-35672).
- Session-manager record fields (dist/index.js:36486-36493).
- cmux record fields (session-state.d.ts:12-31).
- Layout semantics: tmux select-layout + main-pane-width/height; zellij paneDirection + no-op applyLayout; herdr paneDirection.
- zellij_pane_mode: agent-tab vs current-tab spawn behavior.

**Unknown / Not Replicated:**
- No hot reload proven in 2.2.10.
- Auto selection does not check ancestry or executable availability — only env signals.
- OMO board internals (reuse counts, eligibility, fallback chains, runtime preset) are closure-scoped — unavailable.
- `reconciled` board state is OMO-closure-only (dist/index.js:25225) — never emitted.
- Kitty `main_pane_size` not used by kitty backend.
- cmux has no layout/main_pane_size concept.
- Multiplexer process internal state (PID, socket, etc.) not observable via OpenCode APIs.