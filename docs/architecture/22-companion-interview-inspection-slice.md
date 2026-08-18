# Slice 13 — Companion + Interview Read-Only Inspection

**Date:** 2026-08-11  
**Status:** Implemented. Strictly read-only; no subsystem launched, no outside-scope filesystem access.

## Source-of-Truth Invariant (permanent)

Installed OMO source + schema + observed runtime behavior are authoritative. PLAN.md/recon docs are secondary. Unverifiable facts are represented as `Unknown`; no placeholder semantics. All semantics below carry installed-source citations. Verified against **oh-my-opencode-slim@2.2.10**.

---

## Companion — installed schema (CompanionConfigSchema, dist/index.js:18804-18813)

Zod non-strict object; **no `.default()` anywhere**; schema is never `.parse()`d at runtime — effective defaults applied by loader normalization (dist/index.js:19067-19078). Unknown keys stripped by zod.

| Field | Type | Enum / Range | Effective default |
|---|---|---|---|
| `enabled` | boolean | — | `false` |
| `binaryPath` | string (minLen 1) | — | none (passes through) |
| `position` | string | `bottom-right`, `bottom-left`, `top-right`, `top-left` | `"bottom-right"` |
| `size` | string | `small`, `medium`, `large` | `"medium"` |
| `gifPack` | string | `default` | `"default"` |
| `loopStyle` | string | `classic`, `smooth` | `"classic"` |
| `speed` | number | 0.25–4 | `1` |
| `debug` | boolean | — | `false` |

Prior project tracking knew only 4 fields (enabled/binaryPath/position/size). `gifPack`, `loopStyle`, `speed`, `debug` are **INCLUDED** in catalog + UI from installed source; nothing fabricated the other way either — `fixer-low/high` discipline applied (regression freeze in companion.test.ts).

**Merge:** user→project `deepMerge` (provenance.ts:186-189), scalars/arrays replace, nested merge.

## Companion — runtime architecture (verified)

Source: `CompanionManager`, dist/index.js ~20500-21200.

- **External native binary** `oh-my-opencode-slim-companion` (`.exe` win32); NOT bundled; downloaded from GitHub releases at install/update.
- **Discovery** (`resolveCompanionBinaryPath`, dist/index.js:20586-20590): configured `binaryPath?.trim()` else `($XDG_DATA_HOME|~/.local/share)/opencode/storage/oh-my-opencode-slim/bin/<binaryName>`; `existsSync` else `null`. No PATH search.
- **Launch:** once per plugin init (`proc_<pid>` manager id, dist/index.js:40956), via `spawn(detached, stdio:"ignore")` + `child.unref()` (20869-20883); single-instance PID-file lock (20837-20861).
- **No IPC socket; file-based state** (`companion-state.json`, atomic tmp+rename write, 20504-20508, 20603-20620). Consumes session status/permission/question events into agent grid (9-agent cap, 20784-20793).
- **Binary missing → graceful no-op** (log only, 20863-20868); **no auto-restart** on crash; stale PID cleaned on next spawn; spawner kills child on exit when no sessions remain (20759-20783).
- **`enabled !== true` → no launch anywhere**: every manager method early-returns (20658+, 20695, 20713, 20722, 20728).
- **Restart required**: config read once at plugin init; no hot-enable.
- **Not observable via OpenCode server APIs** — runtime.state is honestly `observable:false` with citation reason.

## Companion — filesystem boundary

Default auto-discovery path resolves to `~/.local/share/opencode/...` — **outside authorized roots** → `withinAuthorizedScope:false`, `inspected:false`, `exists:null`. The exists-probe is injection-guarded and provably not invoked out of scope (test: probe spy call count 0). Outside-scope paths are displayed as metadata only. In-scope configured `binaryPath` gets a single `existsSync` probe.

## Interview — installed schema (InterviewConfigSchema, dist/index.js:18778-18784)

Zod non-strict with real `.default()`s:

| Field | Type | Range | Default |
|---|---|---|---|
| `maxQuestions` | int | 1–10 | `2` |
| `outputFolder` | string | minLen 1 | `"interview"` |
| `autoOpenBrowser` | boolean | — | `true` |
| `port` | int | 0–65535 | `0` |
| `dashboard` | boolean | — | `false` |

## Interview — runtime architecture (verified)

- **Invocation: `/interview` COMMAND, not a tool** (`COMMAND_NAME4`, dist/index.js:32803; registered via `registerCommand` 33103-33114 into OpenCode command table; dispatched via `command.execute.before` hook 41332-41333). Plugin `tools` object contains no interview tool (40971-40978). **No `interview` agent**; the flow drives `orchestrator` via `session.promptAsync` (33168-33173 et al.).
- **One HTTP server per plugin instance, lazy**: `createInterviewServer.ensureStarted()` memoized; `node:http` `createServer` only on first `/interview` create/resume/reopen (32482-32522). Binds **127.0.0.1 only** (32510). Never closed by plugin `dispose` (41322-41327 only dispatches disposed to other managers) — `close()` functions defined (32525-32533, 32116-32142) but unwired.
- **Per-session vs dashboard**: `createInterviewManager` (33907-33917): `effectivePort = port ?? 0`; `dashboardEnabled = dashboard===true || effectivePort>0`. Per-session mode → `port:0` hardcoded (33896); dashboard → configured port else **DEFAULT_DASHBOARD_PORT = 43211** (31268). **`port = 0` ⇒ OS-assigned ephemeral** via `listen(0, "127.0.0.1")` (32510-32518) — verified, per-session servers hardcode 0. Dashboard uses cross-process election (`tryBecomeDashboard` probing `/api/health`, 32264-32287); election loser becomes session client pushing over HTTP; loss → per-session fallback (33604-33620).
- **`autoOpenBrowser`** (`openBrowser` 32819-32845): darwin `open` / win32 `cmd /c start` / else `xdg-open`; `{detached, stdio:"ignore"}` + unref. Gated by `shouldAutoOpenBrowser` (32815-32818): `requested && !isAutomatedRuntime(env)`; automated runtime = `NODE_ENV==="test"` or truthy `CI`/`BUN_TEST`/`VITEST`/`JEST_WORKER_ID` (32812-32814). Fired once per interview create/resume/reopen (dedup `browserOpened` Set, 32883-32892). **The control plane reports the gating rule as metadata; it never flips the effective value, and nothing here opens a browser.**
- **`outputFolder`**: `normalizeOutputFolder` strips leading/trailing slashes, empty→`"interview"` (28996-28999) → absolute paths are neutralized; resolved `path.join(ctx.directory, normalized)` (29000-29002). Writes `interview/<slug>.md` with frontmatter (`sessionID, baseMessageCount, updatedAt, version, date_created, owner, tags` — 29069-29103); folder `mkdir recursive` **lazily on first interview** (29106); file rewritten on answers/title rename; resume paths containment-checked under project root, out-of-root rejected (29010-29039).
- **Simultaneous interviews:** one shared server; ≤1 active interview per sessionID (`activeInterviewIds`, 32854); multiple interviews multiplexed over one server (`interviewsById`, 32855).
- **Observability:** in-process only (service/dashboard `handleEvent`, SSE `/api/interviews/{id}/events`, `/api/health`); **no OpenCode server exposure** → `runtime.observable:false` with reason. Tool discovery cross-checked: control-plane `/experimental/tool/ids`-equivalent data shows no interview tool (command ≠ tool — correct representation).

## Interview — filesystem boundary

Output resolves under `ctx.directory` = `<owl-install-root>` → `withinAuthorizedScope:true`, but folder contents are **never listed/stat-ed** (`inspected:false, exists:null` always). A constructed test with roots excluding ctx.directory proves `withinAuthorizedScope:false` + zero inspection.

## Control-plane modules (server-side, local types — council/acp precedent)

- `apps/server/src/omo/companion.ts` — `CompanionState`, `buildCompanionState()`: frozen 8-field catalog, effective+desired, builtin-leaf provenance synthesis (`builtinLeaf`), scope-guarded binary resolution, activation facts, warnings (invalid enum fallback per loader semantics).
- `apps/server/src/omo/interview.ts` — `InterviewState`, `buildInterviewState()`: frozen 5-field catalog, zod-mirroring range warnings, server-mode derivation, outputFolder normalization/resolution without inspection, invocation facts.
- `apps/server/src/config.ts` — pure `isWithinAuthorizedRoots()`; `assertAuthorizedPath` delegates (indentical semantics).
- `packages/shared` — **untouched**.

## APIs

- `GET /api/system/companion` → `CompanionState`
- `GET /api/system/interview` → `InterviewState`
- Doctor input provider composes both inventories in independent try/catch (index.ts), so a subsystem failure cannot break doctor.

No runtime-specific endpoints (no observable runtime state to return — would have been perpetual `{}`).

## Doctor integration (category `companion`, `interview` added to DiagnosticCategory + UI CATS)

**Conservative noise discipline; unknown runtime never degrades health.**

| ID | Severity | Condition |
|---|---|---|
| `companion.disabled` | healthy | enabled !== true |
| `companion.enabled` | healthy/info/warning | enabled: healthy if in-scope binary exists; **info** if binary path outside authorized scope (validation not performed); **warning** only if in-scope configured binary provably missing |
| `companion.unknown-field` | info | raw key not in 8-field catalog (stripped by OMO zod) |
| `companion.invalid-enum` | warning | user value out of enum (ignored → effective default) |
| `interview.valid` | healthy | no schema warnings |
| `interview.invalid-<field>` | warning | zod-mirror range failure (maxQuestions not 1–10 int, port not 0–65535 int, outputFolder empty) |
| `interview.unknown-field` | info | raw key not in 5-field catalog |
| `interview.output-scope` | info | resolved output outside authorized roots (display-only) |

Info diagnostics never degrade overall (verified test: info-only additions cannot move the aggregate). No warnings for intentionally-disabled subsystems, non-running interview servers, or unexposed runtime.

## Option-catalog capability matrix

`OmoOption.capabilities` (required, rolled out across ALL entries): `readable, resolved, provenance, editable, runtimeObservable (bool|"partial"), runtimeControllable, doctor`. Companion/interview generic `deferred` entries removed; **13 field-level entries** added (`companion.{8}` + `interview.{5}`) with `support:"read-only-slice-13"`, `effect:"plugin-load"` (both subsystems read config once at plugin init — restart required), editable/runtimeObservable/runtimeControllable `false`, doctor `true`.

## System UI (engineering-console style, read-only)

SystemPage sections: `Startup / UI` → **`Companion`** → **`Interview`** → `Environment`. 
- Companion: 8 effective fields + provenance badges, binary block (auto-discovery/default path; parent-scope notice instead of existence when out of scope), runtime "not exposed" + reason, activation list, warnings, collapsed raw user/project fragments.
- Interview: max questions with 1–10 hint, output chain (configured→normalized→resolved, scope note, no existence row), autoOpen + verbatim CI-gating note, port ("0 — automatic (OS-assigned)" / dashboard port), dashboard derivation note (43211 default when on), `/interview` command invocation note, server notes, raw fragments.
- Option Coverage gained a Capabilities column (✓ / — / partial) with muted legend.
- Provenance badge mapping: user-config=ok, project-config=warn accent, builtin=muted "OMO default".

No Edit/Start/Stop/Restart/Test/Open buttons anywhere.

## Tests (185 pass, 0 fail — +62 this slice)

- `companion.test.ts` (16): frozen 8-field catalog (sorted regression freeze → phantom-field injection fails the suite), defaults, enums, omission, user-only, project override + winner provenance, unknown-field raw preservation, invalid-value fallback, **probe-spy call-count boundary proof** (0 outside scope, 1 inside), XDG/homedir default path.
- `interview.test.ts` (20): frozen 5-field regression freeze, defaults, ranges incl. `maxQuestions: "two"`/1.5/0/11, `port:-1/65536/1.5`, dashboard via explicit/port/none, automated-runtime env matrix (NODE_ENV/CI/BUN_TEST/VITEST/JEST_WORKER_ID), slash/absolute-path normalization, merge provenance, output scope.
- `doctor.test.ts` (+13): disabled healthy; enabled+out-of-scope → info; enabled+in-scope-missing → warning→degraded; unknown-field info; invalid-enum warning; interview valid/invalid/output-scope; unknown-runtime never warns; info-only aggregation invariant.
- Catalog assertions in `globals.test.ts` (+4): generic entries gone; exactly 13 verified paths (sorted freeze); per-entry capability assertions.

## Live findings (real config)

| | Companion | Interview |
|---|---|---|
| Desired | `{"enabled":false}` (user config wins) | `null` (no user/project interview block) |
| Effective | enabled false; position bottom-right; size medium; gifPack default; loopStyle classic; speed 1; debug false | maxQuestions 2; outputFolder "interview"; autoOpenBrowser true; port 0; dashboard false |
| Provenance | enabled: user-config; rest builtin defaults | all builtin defaults |
| Binary | default path `~/.local/share/opencode/storage/oh-my-opencode-slim/bin/oh-my-opencode-slim-companion`; **outside scope — not inspected** | — |
| Output | — | resolved `<owl-install-root>/interview`; in scope; **not inspected** |
| Runtime | not observable (cited) | not observable (cited) |
| Doctor | `companion.disabled` healthy | `interview.valid` healthy |

Doctor aggregate after slice: `degraded` (11 healthy / 2 info / 1 warning / 0 error) — the only warning remains the pre-existing empty-council-preset one; new subsystem diagnostics contribute 2 healthy, 0 noise.

## Prior-assumption corrections (source-authority audit)

1. Companion field set was historically tracked as 4 fields; installed source defines **8**. Added gifPack/loopStyle/speed/debug.
2. Interview runtime defaults historically assumed (e.g. port semantics, dashboard default port) — now source-verified: port 0 ⇒ OS-assigned; dashboard default port 43211; port>0 implicitly enables dashboard.
3. `/interview` is a **command**, not a tool — do not look for tool registration.
4. Interview server is lazily created on first `/interview`, bound 127.0.0.1, and is **never closed on plugin dispose** (close() defined but unwired).
5. `companion.enabled=false` fully prevents launch (not merely "usually"); restart-required (no hot-enable).
6. Repo audit found **no fabricated companion/interview semantics in code** — prior hits were raw pass-through, catalog placeholders (removed), and plant-text only.
7. Slice-12 finding codified: frozen sorted field catalogs + regression tests now guard both subsystems against phantom-field injection.

## Future-control readiness (NOT implemented)

| Item | Classification |
|---|---|
| `companion.enabled`, `position`, `size`, `gifPack`, `loopStyle`, `speed`, `debug` | Safe typed config-write candidates (same simulate→hash→JSONC→atomic protocol as prior writes; restart-required note) |
| `companion.binaryPath` | Writeable but dangerous — external-path policy check must gate scope + existence warning |
| Companion Start/Stop/Restart | Requires process lifecycle design (OMO launches detached on plugin init; no kill control without process mgmt) |
| `interview.maxQuestions`, `autoOpenBrowser`, `dashboard`, `port` | Safe typed write candidates (restart-required) |
| `interview.outputFolder` | Writeable with path/scope policy gate |
| Interview server start / browser open | Operational side-effect actions — explicit-only, never passive |

## Deferred

Companion/Interview writes, start/stop/restart, browser launch, port probing, process scanning, output-folder browsing, multiplexer, OMO job telemetry, Doctor suppression, auto-remediation, raw whole-file editing.

## Recommended next slice

Either (a) read-only prompt-source provenance browser (agents→prompt files/injection chains) or (b) safe typed config writes for companion/interview under the existing revision protocol, gated by restart-required UX.
