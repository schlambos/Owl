# 09 — Architectural Blockers / Contradictions

**Date:** 2026-08-11

## Non-blocking issues (proceed)

| Issue | Impact | Mitigation |
|-------|--------|------------|
| OMO loader not publicly exported | Cannot import `loadPluginConfig` from package | Reimplement from verified `loader.d.ts` + `dist/index.js` semantics; add tests later against fixtures |
| Load-time vs runtime-preset merge order differs | Effective config can disagree with file-only resolution when `/preset` used | Track runtime preset as separate Live/Effective input when discoverable; document asymmetry |
| `/provider` payload ~4.6MB | UI lag if naively shipped | Prefer `/config/providers` for connected set; lazy-load full catalog |
| `/session/status` often empty | Weak live status | Use session list + later SSE |
| Skills manifest 2.2.12 vs package 2.2.10 | Version display ambiguity | Show both package.json version and manifest version |
| Project config may live under foreign worktrees | Cannot read project OMO outside authorized FS | Only resolve project config when project directory is inside authorized roots; otherwise mark "project config unavailable (out of scope)" |
| OpenCode unsecured local server | Security note | Bind control plane to localhost; document OpenCode password option |

## Potential future blockers

| Issue | When it matters |
|-------|-----------------|
| No OMO job-board API | Phase 6–7 runtime depth |
| Comment-preserving JSONC writes | Phase 4 edits |
| SSE event schema volume | Live topology performance |

## Contradictions found

1. **PLAN vs package export surface:** Plan assumes deep OMO introspection; package only exports plugin default. Resolution: treat installed `dist` + schema as readable specification, reimplement control-plane-side resolver.  
2. **Effective model sources:** File effective ≠ Live `/agent` when sessions use fallbacks or stale workers. UI must show both, not pick one.  

## No hard stop

Slice 1 can proceed without expanding filesystem scope.
