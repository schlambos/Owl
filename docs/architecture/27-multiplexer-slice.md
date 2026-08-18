# Slice 16 — Multiplexer Configuration & Read-Only Runtime Visibility

**Status:** Implemented  
**Source authority:** installed `oh-my-opencode-slim@2.2.10` (`~/.config/opencode/node_modules/oh-my-opencode-slim`)  
**Scope:** backend resolver, bridge v2 store readers, runtime correlation, typed JSONC writes, System UI, Session Inspector, OMO Jobs, Agents/Overview badges, Doctor rules.  

This slice makes the OMO-Slim `multiplexer` configuration fully visible, editable, and safely writable while honestly documenting what runtime state is **not** observable or controllable from the control plane.

---

## 1. Schema (exact)

**Installed schema path:** `oh-my-opencode-slim.schema.json:941-982`  
**Zod runtime schema:** `dist/index.js:18753-18775` (`MultiplexerConfigSchema`, Zod strip)  
**Loader:** `dist/index.js:18881-18944` (`safeParse`)  

The multiplexer object lives at the root `multiplexer` key and contains exactly four fields:

| Field | Schema path | Type | Enum / Range | Default | Omission semantics |
|---|---|---|---|---|---|
| `type` | `multiplexer.type` | string | `auto`, `tmux`, `zellij`, `herdr`, `kitty`, `cmux`, `none` | `none` | omitted → `none` |
| `layout` | `multiplexer.layout` | string | `main-horizontal`, `main-vertical`, `tiled`, `even-horizontal`, `even-vertical` | `main-vertical` | omitted → `main-vertical` |
| `main_pane_size` | `multiplexer.main_pane_size` | number | 20–80 | 60 | omitted → 60 |
| `zellij_pane_mode` | `multiplexer.zellij_pane_mode` | string | `agent-tab`, `current-tab` | `agent-tab` | omitted → `agent-tab` |

The JSON Schema does **not** set `additionalProperties: false` on the multiplexer object, but the Zod runtime schema is a strip schema: unknown nested keys are removed at OMO parse time. The control-plane JSONC writer must still preserve unknown keys so they are not lost on disk.

The control-plane field catalog is frozen in `apps/server/src/omo/multiplexer.ts` as `MULTIPLEXER_FIELDS` and is the single source for enum/range/default validation in the writer and UI.

---

## 2. Deep merge, provenance, and scope

`mergePluginConfigs` (`dist/index.js:19008`) deep-merges the `multiplexer` object, so user and project sources are merged leaf-by-leaf. The existing provenance resolver (`apps/server/src/omo/provenance.ts`) already traces each leaf under `multiplexer.*` back to its winning source, with synthetic builtin-default leaves for omitted fields. Edits can target `user` or `project` scope exactly like other global settings.

---

## 3. Plugin-init timing and activation

`dist/index.js:40831-40846` reads the multiplexer config **once at plugin init** and starts the availability check only when `isInsideSession()` returns true. There is **no hot reload** in 2.2.10; configuration changes require an OpenCode/OMO restart to take effect. The UI states this explicitly in the editor preview.

---

## 4. Auto detection (factory order, env signals only)

`getMultiplexer` in `dist/index.js:35525-35586` resolves `auto` with the following exact order:

1. `CMUX_SOCKET_PATH && CMUX_WORKSPACE_ID && CMUX_SURFACE_ID` → `cmux`
2. `TMUX` → `tmux`
3. `ZELLIJ` → `zellij`
4. `HERDR_ENV || HERDR_PANE_ID` → `herdr`
5. `KITTY_PID || KITTY_WINDOW_ID` → `kitty`
6. else → `null` (disabled)

Auto uses **only** these environment booleans. It does **not** check process ancestry, executable availability, or any other signal. The control-plane resolver mirrors this exactly in `AUTO_SIGNAL_ORDER`.

---

## 5. Backend command resolution (static `command -v` only)

The control plane may probe only these exact commands with `command -v`:

```text
tmux, zellij, herdr, kitten, kitty, cmux, opencode
```

Implementation: `apps/server/src/omo/multiplexer-commands.ts` (`StaticCommandRunner`).  
- Returns the first stdout line when exit code is 0; otherwise `not-resolved`.  
- Never executes the binary, reads versions, crawls PATH, or accepts user-supplied commands.  
- `opencode` is included because the cmux backend resolves the host OpenCode binary.

---

## 6. Layout / backend semantics

The layout enum applies differently per backend; the UI shows exact relevance labels rather than pretending every field is always active.

### tmux (`dist/index.js:35085-35141`)
- `applyLayoutNow` runs `tmux select-layout <layout>`.
- For `main-horizontal` / `main-vertical` only, it sets `main-pane-height` / `main-pane-width` to `{mainPaneSize}%`, then re-applies the layout.
- `tiled`, `even-horizontal`, `even-vertical`: `select-layout` only; no size option.

### zellij (`dist/index.js:35184-35518`)
- `getPaneDirection2`:  
  - `main-vertical` → `"right"`  
  - `main-horizontal` → `"down"`  
  - `even-horizontal`, `even-vertical`, `tiled` → `null`
- `applyLayout` is a **no-op**.
- `zellij_pane_mode`:  
  - `agent-tab` (default): creates/uses a dedicated "opencode-agents" tab; first pane reused, subsequent panes created in that tab.  
  - `current-tab`: creates panes in the parent tab via `createPaneInCurrentTab`.

### herdr (`dist/index.js:34631-34817`)
- `getPaneDirection`:  
  - `main-horizontal`, `even-vertical` → `"down"`  
  - `main-vertical`, `even-horizontal`, `tiled` → `"right"`
- Layout affects pane split direction in the agent area.

### kitty (`dist/index.js:34821-34984`)
- Uses `@new-window` / `@close-window` remote control.
- `layout` and `main_pane_size` are **not used** by the kitty backend.

### cmux (`dist/index.js:34108-34127`)
- Manages its own surfaces.
- `layout` and `main_pane_size` are **ignored**.

Where a backend does not use a field, the UI labels it as configured-but-inactive or ignored, never fabricating an effect.

---

## 7. Legacy top-level `tmux`

`dist/index.js:18901-18911`: if the raw config contains a top-level `"tmux"` key, OMO emits the exact warning `"Deprecated tmux config key found and ignored. Use multiplexer config instead."` and **ignores** the value. It is **not** aliased to `multiplexer.type`, not migrated, and not merged. The modern `multiplexer` object solely controls behavior.

---

## 8. Runtime stores (bridge v1 / v2)

The OMO multiplexer keeps two `globalThis` stores. The optional telemetry bridge reads them with whitelisted, capped, sorted, deduped readers.

### Multiplexer session-manager store
**Symbol:** `Symbol.for("oh-my-opencode-slim.multiplexer-session-manager.state")`  
**Shape:** `Map sessionId → { sessionId, paneId, parentId, title, directory, ownerInstanceId }` plus collection Sets/Maps for `known`, `spawning`, `closing`, `permanentlyClosed`.

- **v1 bridge:** aggregate counts only (`sessionsCount`, `knownSessionsCount`, `spawningCount`, `closingCount`, `permanentlyClosedCount`).
- **v2 bridge (Slice 16):** whitelisted record fields only:  
  `sessionId`, `paneId`, `parentSessionId`, `title`, `known`, `spawning`, `closing`, `permanentlyClosed`.  
  **Never exposed:** `directory`, `owner`, promises, timers, raw Map objects, env values, content.
- Collection-only IDs (known/spawning/closing/permanentlyClosed without a sessions record) are exposed separately and normalized into one record set by the server when practical.

### cmux session store
**Symbol:** `Symbol.for("oh-my-opencode-slim.cmux-session-store")`  
**Shape:** `Map sessionId → CmuxSessionRecord` (`dist/multiplexer/cmux/session-state.d.ts:12-31`).

- **v1 bridge:** `{ recordCount }`.
- **v2 bridge:** whitelisted fields only:  
  `sessionId`, `parentSessionId`, `paneId`, `title`, `spawnState`, `lifecycle`, `panePresent`.  
  **Never exposed:** `directory`, `owner`, `attachedAt`, `lastActivityAt`, `activityVersion`, `idleConsecutive`, `statusMissingSince`, deferred spawn/close intent/timers/promises.

Both record arrays are capped at **100**, sorted by `sessionId`, and deduped. The server accepts **v1 and v2** telemetry schema versions (`OMO_TELEMETRY_ACCEPTED_SCHEMA_VERSIONS = {1, 2}`).

---

## 9. Runtime correlation: OMO jobs ↔ child sessions ↔ panes

`buildMultiplexerRuntime` (`apps/server/src/omo-runtime/multiplexer-runtime.ts`) composes the runtime view from **cached** bridge stores and **cached** OMO jobs only.

- **Join key:** exact OpenCode child session ID. The OMO job `taskId` equals the child session ID produced by the `task` tool result (`Slice 14` mapping).
- **Authoritative only when:** bridge connected **and** runtime snapshot not stale (reuses Slice 14 staleness: both REST and SSE disconnected).
- **Grace:** a `60_000` ms reconciliation grace is reported only when authoritative. Unmapped jobs are still exposed without grace when not authoritative; they are simply not turned into warnings.
- **Pane IDs are safe:** they come from OMO-owned session-manager records, not from querying external pane APIs.

### What remains unavailable
The following are intentionally **not** represented because they live inside OMO closures/module variables not exported by 2.2.10:

- Background job board internals, reuse counts, eligibility, discard reasons.
- Fallback chain position, active runtime preset name.
- Multiplexer PID, socket, process state, internal pane content/scrollback.
- Any pane create/delete/focus/move/rename/attach/detach/kill/capture/send-keys operations.

---

## 10. Normalized DTOs and API routes

### Shared DTOs
`packages/shared/src/index.ts` defines:
- `MultiplexerType`, `MultiplexerLayout`, `ZellijPaneMode`
- `MultiplexerConfigured`, `MultiplexerEffective`, `MultiplexerProvenance`
- `MultiplexerAvailability`, `MultiplexerDetection`, `MultiplexerActivation`
- `MultiplexerSessionRecord`, `CmuxSessionRecord`
- `MultiplexerRuntime`, `MultiplexerRuntimeMapping`, `MultiplexerSystemDto`

### Routes
- `GET /api/system/multiplexer` — full `MultiplexerSystemDto` (desired/effective/provenance, legacy, availability, detection, runtime, activation, capabilities, warnings). Read-only. No OpenCode/session API calls, no mux queries.
- `POST /api/config/global/simulate` — accepts `GlobalMutation` with `multiplexer?: Record<string, FieldOp>`; returns candidate diff, effective change preview, and installed-schema validation.
- `POST /api/config/global/apply` — same mutation shape; performs atomic temp-write + verify + rename, records a revision, and triggers a runtime reconcile.

### GlobalMutation multiplexer shape
```ts
multiplexer?: {
  type?: FieldOp;
  layout?: FieldOp;
  main_pane_size?: FieldOp;
  zellij_pane_mode?: FieldOp;
}

FieldOp = { operation: "unchanged" }
        | { operation: "set"; value: unknown }
        | { operation: "remove" }
```

The writer validates enum/range/type and rejects unknown field keys before any disk write. The installed OMO-Slim JSON Schema gate runs twice: post-mutation pre-temp-write and post-reread pre-rename. Revisions are recorded under the existing `global-settings` label. Restore goes through the guarded revision route and re-validates historical content against the current installed schema.

---

## 11. Capability matrix

| Capability | Value | Notes |
|---|---|---|
| readable | true | schema + provenance resolver |
| resolved | true | builtin defaults applied |
| provenance | true | per-leaf source tracing |
| editable | true | `GlobalMutation` + schema-gated writes |
| runtimeObservable | partial | bridge store snapshots + OpenCode session/job mapping only |
| runtimeControllable | false | control plane cannot drive the multiplexer |
| doctor | true | conservative rules |

The option catalog (`apps/server/src/omo/catalog.ts`) exposes four `implemented-slice-16` rows: `multiplexer.type`, `multiplexer.layout`, `multiplexer.main_pane_size`, `multiplexer.zellij_pane_mode`.

---

## 12. Doctor rules (conservative)

Category: `agents` (navigates to System → Multiplexer).

| Rule | Severity | Trigger |
|---|---|---|
| `multiplexer.none` | healthy | `type = none` |
| `multiplexer.auto-detected` | healthy | `type = auto` and a backend is detected |
| `multiplexer.auto-none` | info | `type = auto` and no signal detected |
| `multiplexer.legacy-tmux-ignored` | info | legacy top-level `tmux` present (ignored behavior) |
| `multiplexer.explicit-backend-command-missing` | warning | explicit `type` (`tmux`/`zellij`/`herdr`/`kitty`/`cmux`) and the backend command is not resolvable via `command -v` |
| `multiplexer.missing-mapping-after-grace` | warning | authoritative runtime + unmapped OMO jobs after the 60s grace |

Bridge/runtime unavailability produces **no** warning (conservative: do not warn for unobservable state).

---

## 13. UI surfaces

### System → Multiplexer
- URL-addressable section (`/system?section=multiplexer`).
- Renders Desired (configured), Effective, Detection, Availability, Runtime, Capabilities, and Legacy cards separately.
- Per-field relevance labels follow exact backend semantics.
- Typed editor: select `unchanged` / `set` / `remove`, choose value, Preview, Apply, guarded Restore.
- Preview shows target file, JSON path, diff, schema validation, and explicit "No runtime action will be taken." / "requires plugin restart" note.

### Session Inspector
- Shows a Multiplexer card **only when** a mapping exists for that session.
- Displays `type`, `paneId`, session/parent IDs, and state flags from the bridge record.

### OMO Jobs panel
- Mapped job: shows backend label + pane ID (e.g., `tmux %5`).
- Unmapped but runtime available: shows "Terminal Unavailable".
- Unobservable (bridge unavailable): no terminal line at all.

### Agents / Overview
- Compact multiplexer summary only when authoritative mappings exist.
- Stale/unavailable runtime produces no summary (avoids false counts).

### Doctor
- Multiplexer diagnostics deep-link to `/system?section=multiplexer`.

No pane/session creation, deletion, focus, move, rename, attach, detach, kill, capture, scrollback, raw command, Companion, or Interview controls are present.

---

## 14. Security / authorized-root boundaries

- The backend only runs `command -v <allowed-name>` from a frozen allowlist; it never executes the discovered binary, inspects its contents, or traverses arbitrary PATH entries.
- Runtime DTOs never contain directory paths, owner IDs, environment values, timers, promises, or raw store objects.
- Pane IDs are OMO-owned internal identifiers; the control plane does not query tmux/zellij/etc. pane APIs.
- The telemetry bridge is **optional** and not auto-registered by this slice; there is no restart or process management of the bridge.
- Runtime session metadata may reference paths outside the authorized filesystem roots; those paths are never opened by the multiplexer code.

---

## 15. Deferred (explicitly out of scope)

All of the following remain deferred and are **not** exposed or editable:

- Pane create / delete / focus / move / rename / attach / detach / kill.
- Scrollback capture / raw multiplexer commands.
- Multiplexer process manager, PID/socket inspection, analytics.
- Companion or Interview writes.
- Any control-plane action that drives the multiplexer at runtime.

---

## 16. Verification notes

### Automated tests (lane results)

| Suite | Result |
|---|---|
| Backend (`apps/server/src`) | 484 pass, 0 fail |
| Telemetry bridge (`packages/omo-telemetry-bridge/src`) | 32 pass, 0 fail |
| **Backend + bridge total** | **516 pass, 0 fail** |
| Web UI (`apps/web/test`) | 138 pass, 0 fail |
| `bun run typecheck` | clean (shared, server, web) |
| `bun run build` | clean (shared, server, web) |

> Final independent verification passed after the restore hash/schema hardening.

### Controlled live verification

1. Read-only inspection confirmed built-in effective values, command availability, and neutral bridge-unavailable state.
2. A schema-gated user-scope `main_pane_size` change `60 → 61` was previewed and applied without changing multiplexer type or restarting OpenCode.
3. Guarded revision restore returned the file byte-for-byte to baseline; `opencode.json` remained unchanged.
4. Live bridge correlation was unavailable because the optional bridge remains unregistered; fixture tests verify the authoritative mapping path.

**Live verification status:** `passed` — see `evidence/multiplexer-slice/live-read-only-report.md`, `live-mutation.md`, and `independent-verification.md`.

---

## 17. Recommended next slice

The project architecture index establishes slice numbering, but the next slice for this branch has **not** been decided. Choose the next slice only after the orchestrator verifies the live results above and confirms the multiplexer surface is stable. Do not invent a next slice number here.

---

## 18. Contradictions found

None. The implemented code, source audit, manifest, and tests are consistent on every point documented above.
