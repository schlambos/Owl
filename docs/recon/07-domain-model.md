# 07 — Domain Model: Desired / Effective / Live

**Date:** 2026-08-11

## Core triad

```text
Desired  →  Effective  →  Live
 (files)     (resolved)    (OpenCode runtime)
```

These layers must remain independently inspectable. Never collapse into a single flattened blob without provenance.

## Desired

What is written in configuration sources.

```ts
type ConfigScope = "user" | "project" | "env" | "builtin" | "runtime-preset";

interface ConfigSource {
  id: string;
  scope: ConfigScope;
  path: string | null;       // null for env/builtin
  format: "json" | "jsonc" | "md" | "env";
  hash?: string;
  mtimeMs?: number;
}

interface DesiredOmoConfig {
  sources: ConfigSource[];
  rawBySource: Record<string, unknown>;  // parsed objects
  activePresetName?: string;             // as written (pre-env)
  agents: Record<string, DesiredAgent>;
  presets: Record<string, Record<string, DesiredAgent>>;
  globals: DesiredGlobals;               // disables, fallback, backgroundJobs, ...
}

interface DesiredAgent {
  name: string;
  kind: "builtin" | "custom";
  model?: string | ModelRef | Array<string | ModelRef>;
  variant?: string;
  temperature?: number;
  skills?: string[];
  mcps?: string[];
  prompt?: string;
  orchestratorPrompt?: string;
  options?: Record<string, unknown>;
  displayName?: string;
  description?: string;
  permission?: unknown;
  sourceIds: string[];                   // which files contributed
}
```

## Effective

What OMO resolution produces after merge + preset application (control-plane reimplementation of loader semantics).

```ts
interface Provenance {
  path: string;                // JSON path e.g. agents.explorer.model
  effectiveValue: unknown;
  winner: ConfigSource;
  reason: string;              // e.g. "root agents override preset"
  overridden: Array<{ source: ConfigSource; value: unknown }>;
}

interface EffectiveAgent {
  name: string;
  kind: "builtin" | "custom";
  enabled: boolean;
  modelPrimary?: string;       // provider/model normalized
  modelFallbacks: string[];
  variant?: string;
  temperature?: number;
  skills: string[];
  mcps: string[];
  provenance: Provenance[];    // key fields
}

interface EffectiveConfig {
  preset?: string;
  agents: Record<string, EffectiveAgent>;
  disabledAgents: string[];
  backgroundJobs: Record<string, unknown>;
  fallback: Record<string, unknown>;
  warnings: Array<{ kind: string; message: string; path?: string }>;
}
```

### Resolution rules (verified)

1. User file ← project file (project wins; deep merge nested)  
2. `OH_MY_OPENCODE_SLIM_PRESET` overrides preset name  
3. `agents = deepMerge(presets[preset], agents)` — **root agents win**  
4. Runtime preset switch (later): opposite merge order  
5. `disabled_agents` minus protected set  
6. Prompt files layered separately (replace/append; preset subdir first)

## Live

What OpenCode reports now.

```ts
interface LiveSnapshot {
  health: { healthy: boolean; version?: string };
  path: { config: string; directory: string; worktree: string; state: string };
  providers: LiveProvider[];
  agents: LiveAgent[];
  sessions: LiveSession[];
  mcp: Record<string, { status: string }>;
  fetchedAt: string;
}

interface LiveProvider {
  id: string;
  name: string;
  connected: boolean;
  source?: string;
  models: LiveModel[];
}

interface LiveModel {
  id: string;
  name?: string;
  providerID: string;
  // probe state is separate / optional
}

interface LiveAgent {
  name: string;
  mode?: string;
  native?: boolean;
  hidden?: boolean;
  model?: { providerID: string; modelID: string };
  variant?: string;
}

interface LiveSession {
  id: string;
  parentID?: string;
  title?: string;
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
  directory?: string;   // metadata only
  time?: { created?: number; updated?: number };
  status?: string;
}
```

## Correlation views (UI)

For each agent row:

| Column | Layer |
|--------|-------|
| Configured model | Desired (preset + overrides as written) |
| Effective model | Effective resolution |
| Live model | `/agent` entry |
| Sessions | Live sessions filtered by `agent` |

Drift badges when Desired ≠ Effective ≠ Live.

## Model availability states (later UI)

`configured` → `provider_connected` → `advertised` → `probed` → `healthy`  
No automatic inference probes in slice 1.
