# 01 — Repository Inventory (`~/Repos/omo-slim`)

**Date:** 2026-08-11  
**Scope:** Authorized project root only.

## State

Pre-implementation foundation repo. Not empty of planning artifacts; no application source yet before this phase.

| Path | Role |
|------|------|
| `AGENTS.md` | Project agent rule: follow `PLAN.md` as gospel; design skills for UI; research uncertainties |
| `PLAN.md` | Full product/architecture plan (~3235 lines) — authoritative product gospel |
| `.gitignore` | Anticipates monorepo: `apps/web`, `apps/server`, `*.db`, recon artifacts |
| `.opencode-openapi.json` | Captured OpenCode OpenAPI 3.1 dump (gitignored) |
| `.opencode-serve.log` | Notes server on `http://127.0.0.1:4096` |
| `.recon-samples/` | Prior live API response samples (gitignored) |

## Not present (before scaffold)

- No `package.json` workspace
- No `apps/`, `packages/`, `src/`
- No git repository initialized in this directory
- No tests, CI, or runtime code

## Implications

Greenfield implementation under an existing product plan. Scaffold must stay under this root. Recon samples and OpenAPI dump are useful fixtures but not authoritative at runtime — live OpenCode is authoritative for runtime state.
