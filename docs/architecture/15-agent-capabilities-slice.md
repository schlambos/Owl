# Slice 6 — Agent Capabilities (temperature, skills, MCPs, permissions)

**Date:** 2026-08-11  
**Status:** Implemented

## Verified skill / MCP list semantics (`parseList`)

From `oh-my-opencode-slim` dist:

```js
if (!items || items.length === 0) return [];
allow = items without leading !
deny  = items with ! stripped
if deny includes "*" → []
if allow includes "*" → allAvailable − deny
else → allow ∩ allAvailable − deny
```

Unknown names not in inventory are **dropped** from the allowed set (but preserved in raw config).

Global `disabled_skills` / `disabled_mcps` force deny after list resolution (display layer).

## Skill permission map (when `skills` configured)

```text
start: * = deny
*     → * = allow
!name → name = deny
name  → name = allow (unless globally disabled)
then force deny all disabled_skills
```

## Temperature

Schema: `number` min 0 max 2.  
`null` mutation removes the JSON property (inheritance), not write JSON null.

## Permission

Union of `"allow"|"ask"|"deny"` or object of tool → decision | pattern-map.  
Unknown tools preserved. Patterned tools shown as `△` in matrix.

## Mutations added

- `agent-temperature`
- `agent-skills`
- `agent-mcps`
- `agent-permission`
- `agent-capabilities` (compound set/remove ops)

Reuse Slice 5: scope, destination, simulate, hash, JSONC edit, atomic write, revisions.

## APIs

- `GET /api/capabilities` — inventory + per-agent semantic summary  
- `GET /api/skills`, `GET /api/mcps`  
- existing simulate/apply accept new kinds  

## UI

- **Capabilities** workspace: tool matrix, skills×agents, MCP runtime, cell explain  
- Agents → **Caps** modal: temperature / skills expr / mcps expr / permission JSON  

## Tests

63 pass total (capabilities unit + mutate extensions).

## Live verification

- Set `researcher.temperature = 0.42` → apply OK  
- Restore revision → property removed (as before)  
- Capabilities: 13 agents, 53 skills, context7/gh_grep connected  

## Deferred

Prompt editing, global disable writes, options, Council, etc.

## Recommended next

Prompt-file editing (append/replace) with same mutation safety model.
