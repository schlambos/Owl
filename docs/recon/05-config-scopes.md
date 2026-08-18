# 05 — Exact Configuration Scopes Consumed

**Date:** 2026-08-11

## Authorized filesystem scopes (control plane process)

1. `~/Repos/omo-slim` — application code, docs, local DB, tests  
2. Active OpenCode config dir — normally `~/.config/opencode`  
   - Discoverable via `GET /path` → `config`  
   - Override via env `OPENCODE_CONFIG_DIR` (OpenCode convention)

## Files the control plane may **read** (slice 1+)

### OpenCode config scope

| File / pattern | Purpose |
|----------------|---------|
| `opencode.json` / `opencode.jsonc` | Plugin registration, providers, core settings |
| `oh-my-opencode-slim.json` / `.jsonc` | User OMO desired config |
| `oh-my-opencode-slim/**/*.md` | Prompt replace/append |
| `oh-my-opencode-slim.schema.json` (from package) | Validation reference |
| `package.json` (config dir) | Installed OMO/plugin versions |
| `skills/**/SKILL.md` | Skill inventory (optional) |
| `.oh-my-opencode-slim/skills-manifest.json` | Managed skill metadata |

### Project scope (when present, still under authorized project root only)

| File / pattern | Purpose |
|----------------|---------|
| `<project>/.opencode/oh-my-opencode-slim.json(c)` | Project OMO overrides |
| `<project>/.opencode/oh-my-opencode-slim/**` | Project prompts |

**Slice 1 project directory for OMO load:** `~/Repos/omo-slim` (no project OMO file yet).

## Files the control plane must **not** open

- Any path outside the two authorized roots  
- Session `directory` / project `worktree` values that point elsewhere (metadata display only)  
- `~/.local/state/opencode` unless later explicitly authorized  
- Sibling repos under `~/Repos/*`

## Runtime / network scopes (not filesystem)

- OpenCode HTTP API on localhost (default `http://127.0.0.1:4096`)  
- Configurable base URL via env `OPENCODE_BASE_URL` or control-plane config  

## Write policy

- **Slice 1: read-only** — no config mutation  
- Future writes: only through backend, atomic, validated, never from browser directly  
- Authoritative stores remain the real config files, not SQLite  
