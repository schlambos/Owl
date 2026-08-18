# Slice 4 — Configuration Provenance & Prompt Discovery

**Date:** 2026-08-11  
**Status:** Implemented  
**Layer:** Desired → Effective (Live join unchanged)

## Goal

Every important effective OMO property is explainable: source file, JSON path, competitors, winner reason. Prompt replacement/append layers are discovered and composed per verified OMO rules.

## Verified merge stages (load-time)

1. Load user `oh-my-opencode-slim.json(c)` (jsonc preferred if both exist)
2. Deep-merge project `.opencode/oh-my-opencode-slim.json(c)` over user  
   - Nested objects: recursive merge  
   - Arrays / primitives: **override replaces**
3. `OH_MY_OPENCODE_SLIM_PRESET` overrides `preset` name
4. `agents = deepMerge(presets[preset], agents)` → **root agents win**
5. Runtime `/preset` (not observable via OpenCode): opposite order — modeled as unknown

## Verified prompt rules (`resolvePrompt` in dist)

```text
base = inlinePrompt ?? fileReplacement ?? builtin
result = append ? base + "\n\n" + append : base
```

**Inline overrides file replacement** (OMO logs a warning). This differs from some skill-doc wording that emphasizes file replacement; **implementation wins**.

### Prompt file search order (first hit wins per kind)

1. `<project>/.opencode/oh-my-opencode-slim/{preset}/`
2. `<project>/.opencode/oh-my-opencode-slim/`
3. `<configDir>/oh-my-opencode-slim/{preset}/`
4. `<configDir>/oh-my-opencode-slim/`

Files: `{agent}.md` (replacement), `{agent}_append.md` (append).

## Provenance model

```ts
PropertyCandidate { value, sourceId, sourceLabel, sourcePath, stage, order, filePath? }
ResolvedProperty { path, value, winner, overridden[], reason, arrayReplaced? }
```

Stages: `user-config` | `project-config` | `env` | `preset` | `root-agent` | …

## Endpoints

| Path | Purpose |
|------|---------|
| `GET /api/omo/effective` | Effective agents + sources inventory summary |
| `GET /api/omo/provenance` | Full property map |
| `GET /api/omo/provenance?path=` | Single property |
| `GET /api/omo/sources` | Source inventory |
| `GET /api/omo/prompts` | All agent prompt summaries |
| `GET /api/agents/:name/prompts?text=1` | Prompt composition + optional full text |

## UI

- **Config** nav: sources table, warnings, property browser with candidate chain
- **Agents**: source stage badge; row click → field provenance + prompt inspector
- Desired / Effective / Live remain distinct; runtime drift note does not claim fallback

## Tests

`apps/server/src/omo/provenance.test.ts` — 17 tests  
Fixtures under `apps/server/test/fixtures/` (inside project root).

Coverage: user-only, project-over-user nested + arrays, env preset, missing project, out-of-scope project, inline-over-file + append, orchestrator append, unknown keys in raw.

## Real-config verification

- Active preset `openai`; explorer model provenance stage `preset`
- `orchestrator_append.md` applied as append source
- No config/prompt files modified
- Filesystem boundary held

## Docs vs implementation discrepancy

| Topic | Docs/skills often say | Implementation |
|-------|----------------------|----------------|
| Prompt file vs inline | File can replace prompt | **Inline wins** over `{agent}.md` |
| Runtime preset merge | Same as load | **Opposite** deepMerge order |

## Limitations

- Built-in prompt body not extracted from package (placeholder in composition when no file/inline)
- Runtime preset name unknown
- Capability semantics (`*` / `!mcp` skill lists) not fully interpreted — raw provenance only
- Council special-case prompt wiring not fully mirrored

## No writes

This slice is read-only. Writes remain blocked until provenance is trusted.

## Recommended next slice

Safe configuration writes (atomic JSONC mutation) for agent model/variant — gated on this resolver.
