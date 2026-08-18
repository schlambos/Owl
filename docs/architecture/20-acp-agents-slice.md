# Slice 11 — ACP Agents Workspace

**Date:** 2026-08-11  
**Status:** Implemented

## Installed schema (2.2.10, verified)

`acpAgents.<name>` (strict — no unknown fields):

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `command` | string (min 1) | **required** | process executable (OS-resolved) |
| `args` | string[] | `[]` | ordered tokens |
| `env` | record<string,string> | `{}` | merged over base env at spawn |
| `cwd` | string | — | runtime working dir (control plane does not inspect if out of scope) |
| `description` | string | — | agent description fallback generated otherwise |
| `prompt` | string | — | wrapper worker prompt override |
| `orchestratorPrompt` | string | — | routing text |
| `wrapperModel` | provider/model | fallback→oracle default | wrapper LLM, single model only |
| `timeoutMs` | int 0..2^31-1 | `0` | per-run timeout; **0 disables** |
| `permissionMode` | `ask\|allow\|reject` | `ask` | ACP approval mediation |

Name: `/^[a-z][a-z0-9_-]*$/i`; must not collide with builtin/alias/custom agents (server-side validation mirrors OMO errors).

## Wrapper architecture (verified)

- OMO registers each entry as a normal agent named = config key
- Wrapper config: `model = wrapperModel ?? fallbackModel ?? oracle-default`, temperature 0, prompt = generic ACP wrapper (or configured `prompt`)
- Permission: **everything deny except `acp_run: allow`**
- `acp_run` tool registered only when `acpAgents` non-empty
- External agent's internal model is **not observable**
- Client spawns process directly (no shell): `spawn(command, args, {cwd, env: {...process.env, ...config.env}})`

## Mutations

`acp` typed mutation: `create` (clone optional) / `update` / `rename` / `delete` with field ops. Full simulation → hash → JSONC targeted edits → same-dir temp → atomic rename → revision → Desired/Effective reload.

## Environment & secrets

- Secret-like keys (`token|secret|password|api_key|auth|credential|private_key`) masked in UI and metadata
- **Revision storage redacts secret-like values** (`[REDACTED]`) in old/new value, mutation JSON, and before/after content. Restore of ACP revisions containing redacted values restores redaction markers — operator must re-enter secrets (documented limitation; local SQLite holds no plaintext ACP secrets from Slice 11 onward)
- Probe output sanitized against configured secrets + common token patterns

## Command probing

- `command -v`/`which` via `sh -c 'command -v "$1"' _ <cmd>` — no shell interpolation, no PATH crawling, no binary inspection. States: resolved | not-resolved | unknown (absolute paths not probed — FS boundary)

## Handshake probe (explicit, user-triggered only)

`POST /api/acp/probe`: direct spawn with minimal base env (PATH/HOME/TMPDIR/SHELL/LANG) + configured env; writes ACP `initialize` JSON-RPC (NDJSON over stdin, matching `createAcpInitializeParams`); parses agentInfo; kills process; bounded 12 s; output capped/sanitized. No coding task, no workspace files touched. Never auto-runs.

## APIs

`GET /api/acp` · `GET /api/acp/runtime` · `POST /api/acp/probe` · `POST /api/config/acp/simulate` · `POST /api/config/acp/apply`

## UI

**ACP** workspace: agent list (command · live/config badge), detail (command resolution, permission mode, timeout, args, cwd scope warning, masked env, raw desired masked), handshake probe panel, ACP session list.

## Tests

112 pass incl. inventory masking, command resolution, cwd scope, create/update/rename/delete lifecycle, name collisions, name regex, env arg validation, permissionMode enum, secret redaction, and a **live handshake fixture** (`fake-acp.js` under repo; real `initialize` request/response, kill, sanitize).

## Controlled live verification (real config)

| Step | Result |
|------|--------|
| Create `cp-test-acp` (bun + fixture, secret env, wrapperModel, reject mode, timeout) | OK, command resolved |
| Inventory | masked env (1 secret), cwd authorized |
| Explicit probe | handshake OK, `fake-live-acp@1.0.0` protocol 1, terminated, zero secret leakage |
| Update timeout 5s→7s, rename → `cp-test-acp-2`, delete | OK |
| Final file | `acpAgents: {}` (restored semantics) |
| Revisions | 4 entries; secret absent, `[REDACTED]` ×11 |

## Deferred

Multiplexer, Companion, Interview, generic process manager, terminal, auto-install, pricing, whole-config raw editor, OpenCode restart automation, member-runtime ACP process introspection beyond OpenCode session metadata.

## Recommended next slice

Companion / Interview inspection slices, or Overview consolidation polish (doctor view) before external subsystems.
