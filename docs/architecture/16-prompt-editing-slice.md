# Slice 7 — Safe Prompt Configuration & Prompt-File Editing

**Date:** 2026-08-11  
**Status:** Implemented

## Verified precedence (authoritative from OMO dist)

```text
base   = inlinePrompt ?? replacementFile ?? builtin
result = appendFile ? base + "\n\n" + appendFile : base
```

Search order (first hit per kind):

1. `<project>/.opencode/oh-my-opencode-slim/{preset}/`
2. `<project>/.opencode/oh-my-opencode-slim/`
3. `<configDir>/oh-my-opencode-slim/{preset}/`
4. `<configDir>/oh-my-opencode-slim/`

Inline overrides replacement file.

## Mutations

- `agent-inline-prompt` (JSONC)
- `agent-orchestrator-prompt` (JSONC)
- `prompt-file` (`set` / `delete`, scope user|project, optional preset subdir, replacement|append)

Backend derives all paths. No client absolute paths.

## Prompt file pipeline

Read → hash check → same-dir `.tmp` → verify → rename → revision.  
Delete: tombstone rename → revision → unlink.

## APIs

- `GET /api/prompts` — agent list
- `GET /api/prompts/:agent` — `AgentPromptDetail` (sources, base/append, effective text, chars/lines)
- `POST /api/config/prompt/simulate`
- `POST /api/config/prompt/apply`

Revisions reuse unified SQLite history (`prompt-file-create/update/delete`).

## UI

**Prompts** workspace: agent list → base/append → sources table (active/shadowed/missing) → edit/create → preview diff → apply. Delete inline in table.

## Built-in prompt extraction

Not extracted from package — shown as `built-in` placeholder. (Package bundles prompts inside compiled dist; extraction deferred.)

## Live verification

- Created `researcher_append.md` (user generic): applied; effective append path correct; composition = inline + append
- Deleted: back to none
- Revisions: create + delete recorded
- Orchestrator append untouched

## Runtime reload

Desired/Effective update immediately. Live `/agent` not asserted. No auto-restart.

## Deferred

Global disables, Council, ACP, options, preset CRUD, raw whole-file editor, AI rewriting.

## Recommended next slice

Global configuration editing (`disabled_*`, `backgroundJobs`, `fallback`, `image_routing`) or Presets workspace — same mutation framework.
