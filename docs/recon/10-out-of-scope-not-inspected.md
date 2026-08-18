# 10 — Intentionally Not Inspected (Filesystem Boundary)

**Date:** 2026-08-11

Per project authorization, the following were **not** inspected even if potentially relevant:

## Paths / areas

- `~/Repos/*` other than `~/Repos/omo-slim`
- Sibling repositories (including any full checkout of `oh-my-opencode-slim` outside config `node_modules`)
- `~/Documents`, `~/Downloads`, `~/Desktop`
- `~/.local/state/opencode` (OpenCode state DB/files)
- `/tmp`, `/opt`, `/usr/local` (except noting `opencode` binary path via `which` without reading foreign trees)
- Home-directory-wide searches for OpenCode/OMO projects
- Session `directory` values pointing at other projects (e.g. `/Users/matt/Repos`, `/Users/matt/Repos/mystatus`) — **metadata only**
- Project worktrees reported by `GET /project` outside authorized roots
- npm/bun global caches outside `~/.config/opencode/node_modules`
- Upstream GitHub repository working trees on disk

## Allowed external non-FS actions used

- HTTP to `http://127.0.0.1:4096` (live OpenCode)
- Reading installed package under `~/.config/opencode/node_modules/oh-my-opencode-slim`
- `which opencode` / `opencode --version` (binary path noted, not used to crawl)

## If more context is required

Only the user may expand filesystem scope. Until then, gaps are recorded and work continues from authorized material + live API + public docs if needed.
