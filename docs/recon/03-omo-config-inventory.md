# 03 — OMO-Slim Configuration Inventory

**Date:** 2026-08-11  
**Package:** `oh-my-opencode-slim@2.2.10` (installed under `~/.config/opencode`)  
**Skills manifest claims packageVersion `2.2.12`** — minor install/manifest skew to note  
**Source of truth for behavior:** installed package `dist/` + schema + README skill docs (authorized config tree)

## Config files in active OpenCode config dir

| Path | Role |
|------|------|
| `~/.config/opencode/opencode.json` | OpenCode core: plugins, providers, disabled native agents, default model |
| `~/.config/opencode/opencode.jsonc` | Minimal schema stub (not primary) |
| `~/.config/opencode/oh-my-opencode-slim.json` | **User OMO config** (active; valid JSON) |
| `~/.config/opencode/oh-my-opencode-slim/orchestrator_append.md` | Append prompt for orchestrator |
| `~/.config/opencode/.oh-my-opencode-slim/skills-manifest.json` | Managed skills inventory |
| `~/.config/opencode/skills/*` | Installed skills |
| `~/.config/opencode/package.json` | deps: `oh-my-opencode-slim`, `@opencode-ai/plugin` |

**No project-local** `~/Repos/omo-slim/.opencode/oh-my-opencode-slim.{json,jsonc}` observed.

## Filename / format precedence (from `loader.d.ts` + `dist/index.js`)

1. Search user config dirs → `oh-my-opencode-slim.jsonc` **preferred over** `.json` if both exist  
2. Project: `<directory>/.opencode/oh-my-opencode-slim.jsonc` preferred over `.json`  
3. Load user, then **merge project over user** via `mergePluginConfigs`  
4. Env `OH_MY_OPENCODE_SLIM_PRESET` overrides `preset`  
5. Active preset agents merged: `config.agents = deepMerge(preset, config.agents)`  
   → **root `agents` wins over preset** for same keys  
6. Nested objects deep-merged; top-level arrays replaced by override

### Runtime preset switch (important asymmetry)

When a runtime preset is active (`/preset`), code does:
`config.agents = deepMerge(config.agents, presetAgents)`  
→ **runtime preset wins over root agents** (opposite of load-time order). Document as verified source behavior.

## Schema top-level keys (`oh-my-opencode-slim.schema.json`)

`preset`, `setDefaultAgent`, `compactSidebar`, `stripOrchestratorModel`, `autoUpdate`, `presets`, `agents`, `disabled_agents`, `image_routing`, `disabled_mcps`, `disabled_tools`, `disabled_skills`, `multiplexer`, `interview`, `backgroundJobs`, `fallback`, `council`, `companion`, `webfetch`, `acpAgents`

## Agent override fields

`model` (string | array of string | `{id, variant?}[]`), `temperature`, `variant`, `skills`, `mcps`, `prompt`, `orchestratorPrompt`, `options`, `displayName`, `description`, `permission`

## Built-in agent names

`orchestrator`, `explorer`, `librarian`, `oracle`, `designer`, `fixer`, `observer`, `council`, `councillor`  
Protected (cannot disable): `orchestrator`, `councillor`  
Default disabled: `observer`

## Prompt file locations

Under prompts dir `oh-my-opencode-slim/`:

- `{agent}.md` — full replacement  
- `{agent}_append.md` — append  
- `{preset}/{agent}.md` / `{preset}/{agent}_append.md` — preset-specific first  

Also project-local variants when `projectDirectory` provided (loader supports).

## Current user config summary (Desired)

- Active preset: `openai`
- Presets defined: `openai`, `opencode-go`, empty `preset-3`
- Custom agents: `researcher`, `planner`, `spotter`, `critic`
- Companion: disabled
- Council: default preset stub
- Orchestrator model (preset): `xai/grok-4.5` variant `high`

## OpenCode plugin registration

```json
"plugin": [
  "@ex-machina/opencode-anthropic-auth@1.8.1",
  "oh-my-opencode-slim"
]
```

Native agents `explore` and `general` disabled in `opencode.json`.

## Discrepancies / notes

1. Skills manifest version `2.2.12` vs installed package `2.2.10`  
2. Load-time vs runtime-preset merge order differs (see above)  
3. Published package exports only default plugin + types — **config loader is not a public export**; control plane must reimplement loader semantics from verified source  
4. User OMO JSON is strict JSON today; still parse as JSONC for forward compatibility  
