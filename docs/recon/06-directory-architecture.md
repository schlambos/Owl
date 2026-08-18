# 06 — Initial Directory / Package Architecture

**Date:** 2026-08-11

```text
~/Repos/omo-slim/
  PLAN.md                 # product gospel
  AGENTS.md
  package.json            # bun workspace root
  tsconfig.base.json
  docs/
    recon/                # this reconnaissance set
    architecture/         # evolving design notes
  apps/
    server/               # Bun TypeScript control-plane API
      src/
        index.ts
        opencode/         # OpenCode HTTP client
        omo/              # OMO config load + resolve
        routes/           # HTTP routes
        domain/           # Desired/Effective/Live types usage
    web/                  # Vite + React + TypeScript UI
      src/
        pages/            # Overview, Models, Agents, Sessions
        api/              # fetch control-plane
        components/
  packages/
    shared/               # shared DTOs / zod schemas
      src/
```

## Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Runtime | Bun | Local, FS-heavy, matches PLAN |
| Server | Bun.serve | Minimal deps |
| Frontend | React + Vite + TS | PLAN default |
| Validation | Zod | Aligns with OMO schema style |
| JSONC | `jsonc-parser` | Comment-preserving reads later |
| DB | SQLite (later) | Telemetry only; not slice 1 |

## Process topology

```text
Browser (localhost:5173)
    → HTTP → Control plane (localhost:8787)
                 → HTTP → OpenCode (localhost:4096)
                 → FS   → ~/.config/opencode (read)
                 → FS   → project .opencode (read)
```

Browser never touches config files.
