# OMO Control Plane

## Comprehensive Project Plan

## 1. Executive Summary

The objective of this project is to build a local, full-featured control plane for OpenCode and Oh My OpenCode Slim that replaces manual JSON/JSONC configuration management and fragmented terminal-based observation with a unified graphical interface.

The application will not merely act as a configuration editor.

It will function as an operational console capable of:

* discovering the actual OpenCode environment;
* inspecting connected and authenticated model providers;
* enumerating available models dynamically;
* configuring all OMO-Slim agents and presets;
* managing model assignments and fallback chains;
* editing prompts and delegation behavior;
* managing skills, MCPs, tools, and permissions;
* visualizing configuration inheritance and precedence;
* validating configuration before applying changes;
* inspecting the effective runtime configuration;
* observing active OpenCode sessions;
* tracking child sessions and specialist agents;
* monitoring background jobs and reusable agent sessions;
* inspecting Council activity;
* managing ACP-based external agents;
* observing provider failures and fallback behavior;
* displaying outstanding permission requests;
* correlating configured state with actual runtime behavior;
* and eventually exposing useful historical telemetry about the orchestration system.

The core architectural concept is:

> **Desired Configuration → Effective Configuration → Live Runtime**

Every significant UI surface should reinforce this distinction.

The product should answer three questions at any point:

1. **What did I configure?**
2. **What configuration does OMO-Slim actually resolve after all overrides and precedence rules?**
3. **What is OpenCode actually running right now?**

The project is specifically intended as a personal engineering tool rather than a generalized SaaS or broadly distributed commercial application. This removes many unnecessary requirements such as multi-tenancy, remote user management, billing, generalized onboarding, extensive permission separation between human users, and cloud-hosted infrastructure.

The project should instead optimize aggressively for:

* technical depth;
* completeness;
* observability;
* responsiveness;
* local-first operation;
* direct filesystem access;
* powerful controls;
* accurate representation of OpenCode and OMO-Slim internals;
* and minimal friction when changing a complex multi-agent configuration.

---

# 2. Problem Statement

OMO-Slim is highly configurable, but its configuration model is distributed across several layers:

* OpenCode configuration;
* OMO-Slim user configuration;
* OMO-Slim project configuration;
* presets;
* root-level agent overrides;
* prompt replacement files;
* prompt append files;
* project-local prompt files;
* globally disabled agents;
* globally disabled MCPs;
* globally disabled skills;
* globally disabled tools;
* provider-specific model options;
* runtime preset selection;
* live OpenCode model selection;
* agent permissions;
* external ACP agents;
* Council configuration;
* background-job settings;
* and runtime session state.

The raw configuration is manageable for a small setup, but complexity grows rapidly when different models are assigned according to role and when local and remote providers are mixed.

A mature setup may involve:

```text
Orchestrator
    premium reasoning model

Oracle
    premium/high reasoning model

Explorer
    local long-context model

Librarian
    inexpensive long-context model

Fixer
    fast coding model

Designer
    UI-specialized model

Council
    synthesis model
    +
    several heterogeneous councillor models

Custom specialists
    task-specific models

ACP agents
    external coding runtimes
```

At that point, several practical problems emerge.

### Configuration opacity

It becomes difficult to determine which configuration source currently controls a specific setting.

An Explorer model may appear to be configured inside a preset but actually be overridden by a root `agents.explorer.model` value or project-local configuration.

### Runtime opacity

A configuration file cannot answer:

* Which model is Explorer actually using now?
* Which specialists are active?
* How many Explorer sessions exist?
* Was the current worker newly created or reused?
* Has a fallback occurred?
* Is the provider authenticated?
* Is the selected model actually available?
* Is an MCP connected?
* Is the Orchestrator waiting for a background job?
* Why was an existing specialist session discarded?

### Provider uncertainty

Static model identifiers do not reliably represent the capabilities available to the current authenticated OpenCode installation.

The system should discover providers and available models dynamically.

### Permission complexity

Skills, MCP access, native tools, global disables, and per-agent permissions overlap.

A textual configuration makes it difficult to understand the actual capability envelope of each agent.

### Prompt complexity

OMO-Slim supports:

* built-in prompts;
* inline prompt replacement;
* prompt files;
* append prompts;
* project-local variants;
* and separate Orchestrator routing prompts for custom agents.

These require explicit visibility.

### Lack of feedback for configuration tuning

Parameters such as:

```text
maxSessionsPerAgent
maxContextLines
readContextMaxFiles
wallClockTimeoutMs
fallback retries
```

are significantly easier to tune when the user can inspect actual session utilization and historical behavior.

The proposed application addresses all of these problems.

---

# 3. Project Goals

## 3.1 Primary Goal

Build a fully functional local control plane capable of configuring, observing, and operating an OpenCode + OMO-Slim environment.

The system should become the preferred interface for managing OMO-Slim rather than manually editing configuration files for ordinary changes.

---

# 3.2 Secondary Goals

The application should provide:

### Complete configuration coverage

Every meaningful OMO-Slim configuration option should be representable in the interface.

No significant configuration capability should require abandoning the GUI and manually rewriting JSON unless the underlying option is intentionally arbitrary or newly introduced.

### Runtime introspection

The application should connect directly to the running OpenCode server and use live API state wherever possible.

### Configuration explainability

Every effective property should be traceable back to its source.

### Configuration safety

Changes should be validated before being committed to disk.

### Operational telemetry

The application should track enough runtime metadata to explain agent behavior and allow informed tuning.

### Local-first operation

The application should operate entirely on the workstation hosting OpenCode.

No external cloud backend is required.

---

# 4. Non-Goals

The following should explicitly remain outside initial project scope:

* SaaS hosting;
* multi-user collaboration;
* account creation;
* cloud synchronization;
* enterprise RBAC;
* team workspaces;
* billing;
* usage monetization;
* mobile applications;
* generalized visual workflow construction;
* arbitrary drag-and-drop AI pipeline design;
* replacing OpenCode;
* replacing OMO-Slim's scheduling logic;
* building another independent agent runtime;
* building a new model-provider abstraction.

The application is a **control surface over existing systems**, not a replacement for them.

---

# 5. Core Product Philosophy

The product should be built around five principles.

## 5.1 Desired, Effective, Live

Every setting should conceptually belong to one of three states.

### Desired

What exists in configuration sources.

Examples:

```text
User preset says:
Explorer = Ollama/Qwen

Project config says:
Explorer temperature = 0.1
```

### Effective

What the OMO-Slim configuration resolver ultimately produces.

Example:

```text
Explorer.model = OpenAI/GPT-X
```

because a higher-priority root override masked the preset.

### Live

What the current runtime is actually doing.

Example:

```text
Explorer #E183
Model: OpenAI/GPT-X
Status: running
Context: 31,442 tracked lines
```

The frontend should make discrepancies between these three states immediately visible.

---

## 5.2 The Runtime Is Authoritative

Where live information exists, the UI should query it rather than infer it.

Examples include:

* providers;
* authentication state;
* models;
* agents;
* sessions;
* child sessions;
* session statuses;
* MCP connectivity;
* LSP state;
* tool availability;
* outstanding permissions.

Static configuration should not be mistaken for runtime truth.

---

## 5.3 The GUI Must Not Reduce Expressiveness

OMO-Slim contains flexible fields such as arbitrary provider model options and custom agents.

Therefore, the application must retain an advanced raw JSONC editor.

The GUI should simplify ordinary operations without making unsupported configuration impossible.

---

## 5.4 Configuration Should Be Explainable

The frontend should never merely display:

```text
Explorer model: GPT-X
```

when it can instead display:

```text
Explorer model: GPT-X

Source:
project/.opencode/oh-my-opencode-slim.jsonc

Overrides:
user preset local → ollama/qwen...

Reason:
project root agents.explorer.model has higher effective precedence
```

---

## 5.5 Operational Data Should Inform Configuration

Configuration controls should eventually display relevant runtime telemetry.

For example:

```text
Reusable sessions per Explorer: 3

Currently:
3/3 occupied
Average reuse rate: 64%
```

This allows settings to be tuned empirically.

---

# 6. Proposed High-Level Architecture

The system should use a local client/server architecture.

```text
┌───────────────────────────────────────────────┐
│               Frontend Application            │
│                                               │
│ React / TypeScript                            │
│                                               │
│ Configuration UI                              │
│ Runtime Dashboard                             │
│ Session Inspector                             │
│ Topology Visualization                        │
└──────────────────────┬────────────────────────┘
                       │
                 HTTP / SSE
                       │
┌──────────────────────▼────────────────────────┐
│            OMO Control Service                │
│                                               │
│ TypeScript / Bun or Node                      │
│                                               │
│ Config Resolver                               │
│ Config Writer                                 │
│ Schema Validation                             │
│ OpenCode Client                               │
│ Runtime State Store                           │
│ Telemetry Collector                           │
│ Filesystem Watcher                            │
└─────────────┬───────────────────┬─────────────┘
              │                   │
              │                   │
              ▼                   ▼
       OpenCode Server       Local Filesystem
              │                   │
              │                   ├─ opencode.json
              │                   ├─ OMO config
              │                   ├─ project config
              │                   └─ prompt files
              │
              ▼
        OMO-Slim Plugin
              │
              ▼
        Provider Runtimes
```

The frontend should never manipulate configuration files directly.

The backend should own:

* reading;
* parsing;
* merging;
* validation;
* atomic writes;
* backups;
* schema handling;
* runtime communication.

---

# 7. Technology Recommendation

Because the application must integrate heavily with OpenCode's JavaScript/TypeScript ecosystem, TypeScript is the strongest default.

## Backend

Recommended:

```text
TypeScript
Bun
```

Alternative:

```text
Node.js
```

Bun is attractive because the application is local, latency-sensitive, filesystem-heavy, and not constrained by conventional enterprise deployment requirements.

## Frontend

Recommended:

```text
React
TypeScript
Vite
```

Potential supporting libraries:

```text
TanStack Query
Zustand
Monaco Editor
React Flow
Zod
```

React Flow is appropriate for the runtime topology visualization, but should not become the primary configuration interface.

## Local persistence

Use SQLite.

The database should hold telemetry and application state, not authoritative OMO configuration.

Potential uses:

```text
session metadata
runtime history
fallback events
configuration revision history
model probe history
agent utilization
UI state
```

The actual OMO/OpenCode files remain authoritative configuration sources.

---

# 8. Major Application Workspaces

The primary navigation should contain:

```text
Overview
Agents
Models
Presets
Orchestration
Capabilities
Sessions
System
```

Additional subpages should appear contextually rather than creating excessive top-level navigation.

---

# 9. Workspace: Overview

The Overview page should answer:

> Is my environment healthy, correctly configured, and operating as expected?

Suggested layout:

```text
OPENCode
────────────────────────────────────
Server             ● Online
Version            x.x.x
Project            /src/project
Preset             local-hybrid
Config             ✓ Valid
OMO-Slim           x.x.x


PROVIDERS
────────────────────────────────────
OpenAI             ● Connected
Anthropic          ● Connected
Google             ● Connected
Ollama             ● Connected


TEAM
────────────────────────────────────
Orchestrator       GPT-X
Explorer           Qwen
Librarian          Qwen
Oracle             GPT-X/high
Fixer              Qwen Coder
Designer           Gemini
Council            GPT-X


RUNTIME
────────────────────────────────────
Main sessions                2
Active specialists           5
Queued jobs                  1
Reusable sessions            4
Outstanding permissions      0
Provider failures            0
```

The page should also surface warnings.

Examples:

```text
Explorer preset configuration is masked by a root override.

Librarian fallback model belongs to a disconnected provider.

One reusable Explorer session exceeds the configured retention threshold.
```

---

# 10. Workspace: Agents

Agents should be the primary unit of configuration.

Each agent appears as a card containing:

```text
Name
Description
Enabled state
Primary model
Fallback count
Variant
Skills
MCPs
Permission profile
Prompt source
Active session count
Reusable session count
```

Example:

```text
EXPLORER                               ● Enabled

Fast internal repository reconnaissance

Model
ollama/qwen3.6-35b

Fallbacks
1 configured

Variant
default

Skills
None

MCP
codegraph

Permissions
Read-only

Prompt
Built-in + explorer_append.md

Running       2
Reusable      1

[Configure] [Prompt] [Permissions] [Sessions]
```

---

# 11. Agent Configuration Model

Each agent editor should contain the following sections.

## Identity

Fields:

```text
Name
Display Name
Description
Enabled
Built-in / Custom
```

Relevant underlying configuration:

```text
displayName
description
disabled_agents
custom agent identifier
```

---

## Model

Fields:

```text
Primary Model
Fallback Models
Variant
Temperature
Provider Options
```

The model selector must use live OpenCode discovery.

No ordinary model field should require free-text entry.

Free-text should remain available only through an advanced option.

---

## Behavior

Fields:

```text
temperature
variant
provider-specific options
```

Provider-specific options should use a hybrid editor.

Known properties can receive first-class controls.

Unknown properties remain editable as JSON.

---

## Capabilities

Fields:

```text
Skills
MCPs
Permissions
```

These should be linked into the central Capability matrix.

---

## Delegation

Primarily for custom agents.

Fields:

```text
orchestratorPrompt
```

The UI should explicitly explain that this controls when the Orchestrator should consider invoking the agent.

---

## Prompt

Fields:

```text
Inline prompt
Replacement file
Append file
Effective prompt source
```

---

## Runtime

Display:

```text
Current sessions
Reusable sessions
Recent tasks
Current model
Recent fallback behavior
```

---

# 12. Live Provider and Model Discovery

This is a core feature.

The application should query the running OpenCode server for:

```text
server health
providers
connected providers
provider authentication methods
models
agents
provider/model tool capabilities where available
```

Model selection should present only actual runtime-discovered models by default.

Example:

```text
CONNECTED

OpenAI
    GPT-X
    GPT-Y

Anthropic
    Claude-X

Ollama
    Qwen 35B
    Qwen Coder


NOT CONNECTED

Google
    Authentication required
```

Model metadata should be cached locally but refreshed on:

```text
application startup
OpenCode reconnect
provider authentication change
manual refresh
```

---

# 13. Model Availability States

Each model should distinguish:

```text
Discovered
Provider Connected
Entitlement Probed
Currently Healthy
```

Example:

```text
GPT-X

Provider connected        ✓
Advertised by OpenCode    ✓
Entitlement tested        ✓
Last probe                2 minutes ago
```

A model should not be automatically probed unless explicitly requested or part of an optional controlled validation operation.

Automatic probing of every model risks:

```text
quota consumption
provider throttling
unnecessary API activity
```

---

# 14. Model Probe Function

Provide:

```text
[Test Model]
```

The backend performs a minimal test inference.

The result should record:

```text
success
failure
latency
error response
provider
model
timestamp
```

Model probes should be stored in SQLite for historical visibility.

---

# 15. Fallback Chain Editor

Fallbacks should be represented visually.

Example:

```text
1. Ollama / Qwen
       ↓ failure
2. OpenAI / GPT-Y / medium
       ↓ failure
3. OpenAI / GPT-X / high
```

Users should be able to:

```text
add
remove
reorder
change variant
test each model
```

Semantic validation should detect:

```text
duplicate fallback models
unavailable providers
invalid variants where detectable
disabled provider
circular duplication
```

---

# 16. Workspace: Models

This page should function as an inference-resource inventory.

Columns:

```text
Provider
Model
Connection
Context
Capabilities
Probe state
Assigned agents
Active sessions
```

Example:

```text
Provider   Model          Status   Used By
OpenAI     GPT-X          ●        Orch, Oracle
Ollama     Qwen 35B       ●        Explorer, Librarian
Ollama     Qwen Coder     ●        Fixer
Google     Gemini-X       ●        Designer
```

Selecting a model should show:

```text
model identifier
provider
connectivity
capabilities
probe status
assigned roles
active sessions
fallback membership
provider options
```

---

# 17. Model-to-Agent Usage Map

Provide an optional visualization.

Example:

```text
GPT-X
 ├─ Orchestrator
 └─ Oracle

Qwen 35B
 ├─ Explorer
 └─ Librarian

Qwen Coder
 └─ Fixer
```

The purpose is to expose inference concentration and resource contention.

---

# 18. Workspace: Presets

Presets should be treated as complete team configurations.

Each preset card should summarize:

```text
Orchestrator
Explorer
Librarian
Oracle
Fixer
Designer
Council
custom agents
```

Selecting a preset should display a diff from the current active preset.

Example:

```text
local-hybrid → quality

Explorer
Qwen → GPT-Y

Librarian
Qwen → Gemini

Oracle
GPT-X/high → Claude/high
```

Runtime preset switching should be exposed directly when supported.

---

# 19. Configuration Precedence Visualizer

This should be one of the project's defining capabilities.

For any setting:

```text
Built-in default
        ↓
User preset
        ↓
Root user agents
        ↓
Project preset
        ↓
Project root agents
        ↓
Prompt/file override
        ↓
Runtime preset state
        ↓
Effective value
```

The exact chain should reflect OMO-Slim's actual implementation rather than a generalized theoretical model.

Selecting a property should reveal:

```text
Effective value
Source file
Source JSON path
Overridden values
Override reason
```

Example:

```text
Explorer.model

Effective:
openai/gpt-x

Source:
.opencode/oh-my-opencode-slim.jsonc

Path:
agents.explorer.model

Masked:
preset.local.explorer.model
ollama/qwen35b
```

---

# 20. Workspace: Orchestration

This page controls runtime scheduling behavior.

Organize it into:

```text
Session Reuse
Context Retention
Board Strategy
Execution Supervision
Orchestrator Wake
Image Routing
Fallback Behavior
```

---

# 21. Session Reuse

Expose:

```text
maxSessionsPerAgent
maxContextLines
readContextMinLines
readContextMaxFiles
```

The UI should display current utilization.

Example:

```text
Reusable sessions per agent
3

CURRENT

Explorer     3 / 3
Librarian    1 / 3
Oracle       0 / 3
Fixer        2 / 3
```

---

# 22. Context Retention

Example:

```text
Maximum reusable context
50,000 tracked lines

Current Sessions

Explorer #E12      42,100
Explorer #E18      17,240
Librarian #L31     51,400

Librarian #L31 will not remain reusable after completion.
```

This turns abstract limits into visible runtime behavior.

---

# 23. Board Strategy

Expose:

```text
strategy
maxRetainedSnapshots
```

Present as:

```text
Board strategy

Latest
Checkpoint-compatible
```

The UI should include a detailed explanation of each strategy because this setting has implications for context retention and prompt caching.

---

# 24. Execution Supervision

Expose:

```text
wallClockTimeoutMs
abortGraceMs
```

Presentation:

```text
Worker hard timeout
Disabled / custom duration

Cancellation grace
10 seconds
```

These should be clearly distinguished from provider-request fallback timeout.

---

# 25. Orchestrator Wake

Expose:

```text
orchestratorWake.enabled
orchestratorWake.intervalMs
```

Presentation:

```text
Wake idle Orchestrator when incomplete work exists
Enabled

Idle interval
5 minutes
```

Runtime display:

```text
Last wake
Next eligible wake
Current Orchestrator state
```

if telemetry becomes available.

---

# 26. Image Routing

Expose conceptually:

```text
Send images directly to Orchestrator
Automatically route images through Observer
```

Do not force the user to think primarily in terms of the raw `image_routing` property.

Validation should detect:

```text
auto routing with Observer disabled
Observer using non-vision model
```

---

# 27. Global Fallback Configuration

Expose:

```text
fallback.enabled
timeoutMs
retryDelayMs
maxRetries
retry_on_empty
```

Runtime telemetry should eventually report:

```text
requests
retries
fallback transitions
empty-response retries
failure rate
```

---

# 28. Workspace: Capabilities

This page should unify:

```text
Skills
MCPs
Tools
Permissions
Global Disables
```

The central interface should be a matrix.

Example:

```text
                     Orch Exp Lib Oracle Fixer
read                  ✓    ✓   ✓    ✓      ✓
edit                  ✓    ✕   ✕    ✕      ✓
bash                  ✓    △   ✕    △      ✓
task                  ✓    ✕   ✕    ✕      ✕
lsp                   ✓    ✓   ✓    ✓      ✓
websearch             ✓    ✕   ✓    ✓      ✕
context7              ✓    ✕   ✓    ✓      ✕
codemap               ✓    ✕   ✕    ✕      ✕
simplify              ✓    ✕   ✕    ✓      ✕

✓ Allow
△ Ask / Pattern Rule
✕ Deny
```

This is substantially easier to reason about than independent configuration blocks.

---

# 29. Skills Management

Display:

```text
Available
Disabled globally
Allowed by each agent
Denied by each agent
```

Skill patterns such as:

```text
*
!skill
!*
```

should be visualized rather than requiring literal pattern interpretation.

The raw representation must remain accessible.

---

# 30. MCP Management

Show both configured permission and live runtime state.

Example:

```text
Context7

Configured          Yes
Runtime             ● Connected

Allowed
Orchestrator
Librarian
Oracle

Denied
Explorer
Fixer
```

If globally disabled:

```text
Context7
Disabled globally
```

and all per-agent entries should remain visible but inactive.

---

# 31. Permission Editor

Permissions should support:

```text
Allow
Ask
Deny
Pattern rules
```

Example:

```text
Bash — Explorer

Default: Ask

Rules

git status*       Allow
git diff*         Allow
git log*          Allow
*                 Ask
```

Common patterns should be editable through a table.

Advanced JSON remains available.

---

# 32. Global Capability Availability

Expose:

```text
disabled_agents
disabled_mcps
disabled_tools
disabled_skills
```

Disabled entities should never simply disappear.

They should appear as disabled with an explanation.

Example:

```text
Observer

Disabled globally.

Enable under:
Capabilities → Global Availability
```

---

# 33. Prompt Management

Prompt handling requires its own dedicated editor.

Each agent should show:

```text
Built-in prompt
Inline prompt
User prompt file
User append file
Preset-specific file
Project prompt file
Project append file
Effective prompt
```

The UI should compute and display the effective prompt source chain.

---

# 34. Prompt Source Inspection

Example:

```text
Explorer Effective Prompt

Base
Built-in Explorer prompt

Applied:
~/.config/opencode/oh-my-opencode-slim/explorer_append.md

Applied:
project/.opencode/oh-my-opencode-slim/explorer_append.md
```

If one source masks another, explicitly warn.

Example:

```text
Inline prompt is currently ineffective because a replacement prompt file has precedence.
```

---

# 35. Custom Agent Routing

Custom agents should expose two independent editors.

### Worker Prompt

Defines how the agent behaves.

### Orchestrator Routing Prompt

Defines when the Orchestrator should delegate to it.

The UI should make these conceptually distinct.

Example:

```text
WORKER

Perform PowerShell compatibility analysis...


WHEN TO USE THIS AGENT

Delegate when work involves PowerShell, Windows administration,
CIM/WMI, remoting, DSC, Windows PowerShell 5.1 compatibility...
```

---

# 36. Council Management

Council needs explicit representation of its two-layer model.

```text
Council Coordinator
    model
    variant

Councillor Preset
    member A
    member B
    member C
```

Each councillor should support:

```text
model
variant
prompt
```

The Council page should also display current Council execution when active.

Example:

```text
Council #C31

Coordinator        GPT-X
Councillors

Claude       Complete
GPT-Y        Running
Gemini       Complete

Synthesis    Waiting
```

---

# 37. ACP Agent Management

ACP agents should be visibly distinct from native OMO specialists.

Expose:

```text
command
args
env
cwd
description
prompt
orchestratorPrompt
wrapperModel
permissionMode
timeoutMs
```

Provide:

```text
[Test ACP]
```

The test should validate:

```text
binary exists
process launches
working directory exists
ACP handshake works
```

without initiating a real coding task.

---

# 38. Workspace: Sessions

This workspace is the main runtime observability interface.

OpenCode's session hierarchy should be rendered as a tree.

Example:

```text
Main Session
"Investigate authentication regression"

├─ Explorer #E12           Complete
├─ Explorer #E13           Running
├─ Explorer #E14           Complete
├─ Librarian #L15          Running
└─ Oracle #O16             Waiting
```

---

# 39. Session Detail

Selecting a session should reveal:

```text
Session ID
Parent ID
Agent
Model
Provider
Status
Start time
Duration
Task
Messages
Files read
Files changed
Tool calls
Diffs
Outstanding permissions
Token/context data where available
Reuse state
Fallback history
```

Example:

```text
EXPLORER #E13

Parent
#MAIN42

Model
ollama/qwen35b

Status
Running

Elapsed
00:00:14

Task
Trace every mutation of AuthContext.

Recent Activity

read src/auth/context.ts
grep updateAuthContext
read src/middleware/auth.ts
```

---

# 40. Live Event Architecture

Runtime updates should use OpenCode's server-sent event stream rather than aggressive polling.

Conceptually:

```text
OpenCode SSE
      │
      ▼
Backend Event Normalizer
      │
      ▼
Runtime State Store
      │
      ├─ sessions
      ├─ messages
      ├─ providers
      ├─ permissions
      ├─ tools
      └─ statuses
      │
      ▼
Frontend
```

Polling should be retained only for reconciliation and API states not represented reliably by events.

---

# 41. Runtime Topology Visualization

Provide a secondary graphical view.

Example:

```text
                    Orchestrator
                       GPT-X
                         │
          ┌──────────────┼─────────────┐
          ▼              ▼             ▼
      Explorer       Explorer      Librarian
       Qwen           Qwen          Qwen
        ✓              ●             ✓
                                      │
                                      ▼
                                   Oracle
                                   GPT-X
                                     ●
```

This graph must reflect actual session relationships.

It should not be manually authored.

Selecting a node opens the session inspector.

---

# 42. Reusable Agent Pool Inspection

OMO-Slim's worker reuse should become directly visible.

Example:

```text
Explorer Pool

E12     Idle         17K lines     Reused 4x
E18     Running      31K lines     Reused 2x
E24     Running       8K lines     New

Configured maximum
3

Discard threshold
50K
```

Status categories:

```text
New
Running
Idle / Reusable
Reused
Discarded
Timed Out
Aborted
Failed
```

If possible, record discard reason.

---

# 43. Permission Request Center

Live permission requests should appear in a dedicated notification area.

Example:

```text
Permission Request

Explorer #E18

bash
git status --short

Configured policy:
bash "*" → Ask

[Allow Once]
[Deny]
```

Any OpenCode-supported persistent decision mechanism can be exposed where safe.

---

# 44. Historical Telemetry

SQLite should maintain lightweight metadata.

Recommended fields:

```text
session_id
parent_session_id
agent
model
provider
start
end
duration
status
new_or_reused
fallback_count
tool_count
files_read
files_modified
error
```

Do not store enormous conversation bodies by default unless required.

OpenCode remains the primary source for detailed session content.

---

# 45. Agent Analytics

Eventually expose:

```text
Explorer

Sessions             183
Reuse rate            62%
Average duration      14.2 s
Failures               3
Fallbacks              7
Average concurrent     2.8
```

These metrics are intended for tuning the orchestration environment, not generic AI productivity scoring.

---

# 46. Configuration Management

The backend must support:

```text
OpenCode configuration
OMO user configuration
OMO project configuration
prompt directories
preset prompt directories
environment overrides
```

The UI should display all currently participating sources.

Example:

```text
OpenCode
~/.config/opencode/opencode.json

OMO User
~/.config/opencode/oh-my-opencode-slim.jsonc

OMO Project
/project/.opencode/oh-my-opencode-slim.jsonc

User Prompt Directory
~/.config/opencode/oh-my-opencode-slim/

Project Prompt Directory
/project/.opencode/oh-my-opencode-slim/
```

---

# 47. Raw Configuration Editor

Provide Monaco-based editors for:

```text
opencode.json
oh-my-opencode-slim.jsonc
project OMO config
prompt files
```

Features:

```text
syntax highlighting
schema completion
diagnostics
JSON path navigation
diff
formatting
comments retained
jump from GUI field
```

The system should never force a user to abandon a valid advanced configuration because the GUI has not yet modeled a property.

---

# 48. Safe Configuration Writes

Configuration writes must be atomic.

Recommended procedure:

```text
Read original
Parse JSONC
Apply structured modification
Generate candidate
Validate
Write temporary file
Re-read candidate
Validate again
Atomic rename
Record revision
Notify filesystem watcher
```

Never directly truncate and rewrite the authoritative file.

---

# 49. Configuration Revision History

Maintain local history.

Example:

```text
Revision 42
Explorer model
qwen27b → qwen35b

Revision 41
maxSessionsPerAgent
2 → 3
```

Functions:

```text
View diff
Restore
Copy old value
```

This history can live in SQLite and/or a dedicated backup directory.

---

# 50. Semantic Validation

Schema validation alone is insufficient.

The control plane should implement semantic checks.

Examples:

```text
Agent uses disconnected provider.

Selected model no longer exists.

Observer enabled but model is not vision capable.

image_routing=auto while Observer is disabled.

MCP allowed by agent but disabled globally.

Skill assigned but disabled globally.

Fallback chain contains duplicate entries.

Custom agent has no valid model.

ACP executable does not exist.

Prompt file masks inline prompt.

Root-level agent override masks preset configuration.

Council member references unavailable model.

Configured context threshold is already exceeded by retained workers.
```

Validation should be categorized:

```text
Error
Warning
Information
```

---

# 51. Configuration Simulation

Before committing complex changes, allow:

```text
Simulate
```

The backend resolves the candidate configuration without writing it.

Example:

```text
SIMULATION

Enabled agents
7

Models
6

Providers
4

ERROR
Designer model requires disconnected Google provider.

WARNING
Explorer fallback duplicates its primary model.

WARNING
Root Oracle configuration masks 3 presets.

No files changed.
```

This should be available particularly for:

```text
preset changes
multi-agent edits
provider remapping
global disable changes
```

---

# 52. System Health / Doctor

Create a first-class diagnostic page.

Checks should include:

```text
OpenCode reachable
OMO plugin active
OpenCode config valid
OMO user config valid
OMO project config valid
models available
enabled agent models resolvable
MCPs connected
prompt sources resolvable
ACP agents launchable
filesystem paths valid
schema version known
```

Results:

```text
✓ OpenCode reachable
✓ OMO loaded
✓ 7/7 agent models available
✓ Config valid

⚠ Explorer model masked by root override
⚠ One Librarian fallback provider disconnected
```

Each diagnostic should link to the relevant configuration surface.

---

# 53. System Workspace

System should contain:

```text
OpenCode Connection
OMO Installation
Config Sources
Updates
Multiplexer
Companion
Interview
UI
Diagnostics
```

---

# 54. OpenCode Connection Management

Display:

```text
server URL
health
version
connection latency
reconnect
SSE state
```

The application should support automatic discovery of the local OpenCode server where practical.

Manual override should remain available.

---

# 55. Multiplexer Configuration

Expose:

```text
auto
tmux
zellij
herdr
kitty
cmux
none
```

Visualize layouts.

Example:

```text
Layout
Main vertical

Main pane
60%

[preview]
```

Dependent options should appear only for the selected multiplexer.

---

# 56. Desktop Companion

Expose:

```text
enabled
binaryPath
position
size
runtime status
```

Automatic binary discovery should be represented explicitly.

---

# 57. Interview Configuration

Expose:

```text
maxQuestions
outputFolder
autoOpenBrowser
port
dashboard
```

Conditional controls should hide irrelevant settings.

---

# 58. OMO Startup and Update Settings

Expose:

```text
autoUpdate
showStartupToast
setDefaultAgent
```

where supported by the installed OMO version/schema.

The application should ideally detect schema/version differences rather than assuming every installation exposes identical fields.

---

# 59. Environment Overrides

Environment-derived controls should be displayed separately from persisted JSON configuration.

Example:

```text
OH_MY_OPENCODE_SLIM_DISABLE

Current environment
Not set
```

This makes it clear that the setting belongs to process startup rather than the regular config file.

---

# 60. Runtime Model Control

`stripOrchestratorModel` should be exposed using user-oriented terminology.

Example:

```text
ORCHESTRATOR MODEL SOURCE

Use preset-assigned model
Follow current OpenCode /model selection
```

The underlying implementation detail can be shown in an advanced tooltip.

---

# 61. OMO Runtime Telemetry Extension

Some desired information will not be fully observable through OpenCode's normal session API.

The project should therefore consider a minimal OMO-Slim extension exposing authoritative runtime metadata.

Potential interface:

```text
/omo/runtime
/omo/jobs
/omo/agents
/omo/pools
/omo/config/effective
```

or an equivalent tool/event mechanism.

Desired information includes:

```text
OMO job ID
agent identity
worker pool identity
new/reused status
discard reason
background board state
fallback position
effective preset
resolved OMO config
orchestrator wake state
retained snapshots
```

This extension should initially be read-only.

The frontend should avoid controlling OMO scheduler internals directly unless the project later establishes a strong need.

---

# 62. Runtime State Model

The backend should maintain a normalized representation.

Example:

```text
RuntimeState

OpenCode
    health
    version

Providers[]
    connectivity
    models

Agents[]
    configured
    effective
    live

Sessions[]
    parent
    children
    status
    model
    activity

OMOJobs[]
    agent
    state
    reuse

MCPs[]
LSPs[]
Permissions[]
```

This state should be fed by:

```text
initial REST queries
SSE events
periodic reconciliation
OMO telemetry
```

---

# 63. File Watching

Configuration and prompt directories should be watched.

External changes should be detected.

Example:

```text
Configuration changed outside OMO Control.

[Reload]
[Diff]
```

Never silently overwrite a newer external edit.

Use optimistic concurrency based on:

```text
mtime
hash
revision
```

---

# 64. Conflict Handling

If a user edits a configuration externally while the GUI has pending unsaved changes:

```text
FILE CHANGED EXTERNALLY

Base version differs from disk.

[Compare]
[Discard Local Changes]
[Overwrite]
```

Prefer a three-way merge where practical.

---

# 65. Project Context

The UI should understand the currently active OpenCode project.

Project-specific OMO configuration should automatically appear when the active project changes.

Example:

```text
Current Project
/home/matt/repos/FsAudit

Project Overrides
Enabled

5 settings differ from user defaults
```

Provide:

```text
View project diff
```

---

# 66. User vs Project Editing

Every editable property should let the user choose its intended scope.

Example:

```text
Explorer model

Edit in:
○ User preset
● Current project
```

This prevents accidental persistence at the wrong layer.

---

# 67. Configuration Drift Detection

The system should continuously identify discrepancies.

Examples:

```text
Desired:
Explorer = Qwen

Effective:
Explorer = GPT-X

Live:
Explorer = GPT-X
```

or:

```text
Desired:
Explorer = Qwen

Effective:
Explorer = Qwen

Live:
existing Explorer #E12 = GPT-X
new Explorer #E18 = Qwen
```

The second case is particularly important after live configuration changes.

The UI should explain that existing sessions may retain previous model assignment.

---

# 68. Save / Apply Workflow

Configuration changes should have an explicit review stage for anything nontrivial.

Example:

```text
PENDING CHANGES

Explorer
model
qwen27b → qwen35b

Orchestration
maxSessionsPerAgent
2 → 3

Validation
✓ Passed

Expected impact
New Explorer tasks use qwen35b.
Existing Explorer sessions may continue using qwen27b.
Worker pool may expand by one session.

[Apply]
```

Minor single-setting changes can eventually support direct apply.

---

# 69. Restart and Reload Awareness

Every property should eventually carry metadata describing expected application behavior.

Categories:

```text
Live
New sessions only
Config reload required
OpenCode restart required
OMO restart required
UI-only
```

Do not fabricate this metadata.

Determine it through implementation testing and source inspection.

---

# 70. Security Model

Because this is a single-user local application, security can remain comparatively simple.

Still, the backend must treat project-local configuration as potentially untrusted.

Important safeguards:

```text
Do not automatically execute ACP commands from newly cloned projects.

Clearly highlight project-level permission increases.

Warn when project config grants:
    bash
    edit
    external directories
    new MCP access

Do not expose backend broadly on 0.0.0.0 by default.

Bind to localhost.

Use a random local auth token if browser/backend separation warrants it.
```

---

# 71. Logging

The control plane should maintain its own structured logs.

Categories:

```text
OpenCode API
SSE
Config
Runtime
Telemetry
ACP
Validation
Filesystem
Errors
```

Provide a basic in-app log viewer.

Do not duplicate entire OpenCode logs unless needed.

---

# 72. Error Handling

Errors should be actionable.

Bad:

```text
Failed to update config.
```

Good:

```text
Could not update Explorer model.

The project OMO configuration changed on disk after it was loaded.

[View Diff]
```

Similarly:

```text
Model probe failed.

Provider: OpenAI
Model: GPT-X
HTTP: 403

The provider is connected, but this model is not available to the current authenticated account.
```

---

# 73. Performance Requirements

The UI should remain responsive with:

```text
hundreds of historical sessions
dozens of models
several simultaneous specialist agents
large configuration files
high-frequency SSE events
```

Runtime event data should be normalized and selectively retained rather than allowing an unbounded in-memory message history.

---

# 74. Suggested Delivery Phases

## Phase 1 — OpenCode Runtime Foundation

Goal:

Establish reliable communication with live OpenCode.

Deliver:

```text
OpenCode connection
health/version
provider discovery
connected providers
model discovery
agent discovery
session list
session details
child session tree
SSE event consumer
```

Exit criteria:

The application can accurately display the running OpenCode environment without modifying configuration.

---

## Phase 2 — OMO Configuration Engine

Goal:

Read and resolve OMO configuration.

Deliver:

```text
user config discovery
project config discovery
JSONC parser
schema validation
preset parsing
agent parsing
global disables
prompt file discovery
effective configuration representation
config source tracing
```

Exit criteria:

For every displayed setting, the backend can identify its effective value and source.

---

## Phase 3 — Read-Only Control Plane UI

Goal:

Create the first complete operational interface.

Deliver:

```text
Overview
Agents
Models
Presets
Capabilities
Sessions
System health
Desired/Effective/Live presentation
```

No editing yet.

Exit criteria:

The UI provides a comprehensive visual representation of the existing system.

This phase is important because it validates the information architecture before mutation logic is introduced.

---

## Phase 4 — Configuration Editing

Goal:

Make the control plane authoritative for routine configuration.

Deliver:

```text
agent model editing
fallback chain editing
variant
temperature
skills
MCPs
permissions
global disables
presets
orchestration settings
Council
Observer
System options
```

Include:

```text
validation
simulation
atomic writes
revision history
external-change detection
```

Exit criteria:

Ordinary configuration should no longer require manually editing OMO JSONC.

---

## Phase 5 — Prompt Management

Deliver:

```text
inline prompts
replacement prompt files
append files
preset prompt directories
project prompt directories
effective prompt resolution
routing prompt editor
Monaco integration
```

Exit criteria:

Prompt precedence and active prompt state are fully understandable from the GUI.

---

## Phase 6 — Advanced Runtime Monitoring

Deliver:

```text
live session topology
worker activity
permission center
message inspection
tool activity
diffs
runtime badges
reusable pool visualization
```

Exit criteria:

Current multi-agent execution can be understood without watching multiple terminal panes.

---

## Phase 7 — OMO Runtime Telemetry Integration

Goal:

Eliminate inference where OpenCode alone cannot describe OMO state.

Deliver minimal OMO telemetry extension.

Expose:

```text
background jobs
worker pool identity
reuse state
discard reason
board state
effective preset
fallback chain position
orchestrator wake state
```

Exit criteria:

The frontend can accurately represent OMO-specific runtime state.

---

## Phase 8 — Telemetry and Analytics

Deliver:

```text
SQLite persistence
agent utilization
reuse statistics
fallback history
duration statistics
failure statistics
model probe history
historical session overview
```

Exit criteria:

Configuration tuning can be based on observed behavior rather than intuition.

---

## Phase 9 — ACP Management

Deliver:

```text
ACP configuration editor
command validation
test launch
runtime state
ACP session visibility
routing prompt management
```

---

## Phase 10 — Refinement

Deliver:

```text
configuration simulation
deep semantic validation
topology visualization
preset comparison
config diff UX
system doctor
UI polishing
performance tuning
```

---

# 75. Recommended MVP Boundary

Although the eventual project should be comprehensive, the first genuinely useful milestone should include:

```text
OpenCode live connection
provider/model discovery
agent configuration inventory
preset inventory
effective configuration resolution
session tree
child agent inspection
model assignment editing
fallback editing
skills/MCP/permissions matrix
safe config writes
configuration history
```

This is enough to make the tool valuable immediately without first implementing Council analytics, ACP launchers, or advanced historical metrics.

---

# 76. Data Model

A possible internal model:

```text
ConfigSource
    id
    type
    path
    scope
    hash
    modified

ResolvedProperty
    path
    value
    source
    overriddenSources[]

AgentDefinition
    id
    type
    desired
    effective
    runtime

Provider
    id
    connected
    authState
    models[]

Model
    provider
    id
    capabilities
    probeState

Session
    id
    parent
    agent
    model
    state
    timestamps

OMOJob
    id
    session
    agent
    reuseState
    pool

TelemetryEvent
    timestamp
    category
    data
```

---

# 77. API Boundary

The internal backend API should remain explicit.

Potential endpoints:

```text
GET /api/status

GET /api/providers
GET /api/models
POST /api/models/:provider/:model/probe

GET /api/agents
GET /api/agents/:id
PATCH /api/agents/:id

GET /api/presets
POST /api/presets/:id/activate

GET /api/config/sources
GET /api/config/effective
GET /api/config/diff
POST /api/config/simulate
POST /api/config/apply

GET /api/sessions
GET /api/sessions/:id
GET /api/sessions/:id/children
POST /api/sessions/:id/abort

GET /api/runtime/jobs
GET /api/runtime/pools

GET /api/health

GET /api/events
```

This should be treated as an internal API, not necessarily a public compatibility contract.

---

# 78. UI Design Direction

The interface should resemble an engineering console rather than a consumer AI application.

Characteristics:

```text
dense
information-rich
hierarchical
high signal
minimal decorative UI
fast navigation
keyboard friendly
large tables where appropriate
good search/filter
explicit status indicators
```

Avoid excessive:

```text
wizard flows
oversized cards
empty whitespace
animations
marketing-style dashboards
```

The product is for technical operation.

---

# 79. Search and Command Palette

A global command palette would be useful.

Examples:

```text
Go to Explorer
Switch preset to Local
Show active sessions
Find model GPT-X
Open project config
Show permission requests
Probe Qwen35B
```

Search should index:

```text
agents
models
providers
presets
config properties
sessions
skills
MCPs
```

---

# 80. Future Opportunities

Once the core control plane exists, several additional capabilities become plausible.

### Delegation analytics

Show which roles the Orchestrator uses most frequently.

### Model comparison

Compare:

```text
duration
failure rate
fallback rate
task completion
```

across models used for the same role.

### Configuration recommendations

Potentially detect:

```text
Explorer consistently saturates its pool.
Oracle is invoked excessively.
Fallback model is effectively the primary because the first model fails frequently.
```

Recommendations should remain evidence-based and optional.

### Session replay

Visualize how an orchestration tree developed over time.

### Cost and token analytics

Where providers expose adequate usage metadata.

### Project profiles

Automatically select preferred presets based on repository type.

These should remain later extensions rather than core requirements.

---

# 81. Architectural Constraint: Do Not Reimplement OMO

This project must maintain a strong boundary:

```text
OMO-Slim
owns orchestration semantics.

OpenCode
owns coding-agent runtime and provider integration.

OMO Control
owns configuration, visibility, diagnostics, and operational controls.
```

If the frontend begins deciding which specialist should run next, it has crossed the wrong boundary.

The frontend may expose and modify routing configuration.

It should not become the scheduler.

---

# 82. Architectural Constraint: Avoid Static Model Catalogs

The model database should be derived from the running OpenCode environment wherever possible.

A bundled metadata map can supplement live discovery for:

```text
friendly names
capability hints
known context sizes
icons
```

but must never override runtime truth.

---

# 83. Architectural Constraint: Preserve Raw Escape Hatches

Every structured editor must permit a transition to raw configuration.

If OMO adds a new property tomorrow, the application should still allow that property to survive and be edited manually even before a dedicated control exists.

Unknown JSON keys must never be silently stripped during writes.

---

# 84. Architectural Constraint: Version Awareness

OMO-Slim and OpenCode evolve.

The backend should detect:

```text
OpenCode version
OMO-Slim version
loaded schema version
```

and adjust supported features accordingly.

If an option is unknown to the installed version:

```text
This setting is not supported by OMO-Slim 2.x.x.
```

Do not blindly write it.

---

# 85. Definition of Project Success

The project should be considered successful when the following workflow becomes practical:

1. Start the control plane.
2. It attaches to the current OpenCode environment.
3. It identifies connected providers and actual available models.
4. It reads user and project OMO configuration.
5. It resolves and explains the effective agent topology.
6. It shows all active sessions and child specialists.
7. It permits changes to agent models, fallbacks, permissions, skills, MCPs, presets, prompts, and orchestration behavior.
8. It validates and safely commits those changes.
9. It immediately shows how runtime behavior differs before and after the change.
10. It exposes enough telemetry to understand whether the configuration is performing as intended.

At that point, manually inspecting multiple JSON files and terminal panes should become the exception rather than the normal administration workflow.

---

# 86. Final Product Vision

The finished product should feel less like:

```text
A GUI for oh-my-opencode-slim.jsonc
```

and more like:

```text
┌─────────────────────────────────────────────────────┐
│                 OMO CONTROL PLANE                   │
│                                                     │
│ Configuration                                      │
│ Runtime                                             │
│ Model Inventory                                     │
│ Agent Topology                                      │
│ Session Management                                  │
│ Capability Management                               │
│ Diagnostics                                         │
│ Telemetry                                           │
└─────────────────────────────────────────────────────┘
```

It should allow a complex multi-model agent environment to be treated like an engineered system rather than a pile of configuration files.

The guiding model remains:

```text
                 DESIRED
                    │
                    ▼
             CONFIG RESOLUTION
                    │
                    ▼
                EFFECTIVE
                    │
                    ▼
               OMO / OpenCode
                    │
                    ▼
                   LIVE
                    │
                    ▼
               TELEMETRY
                    │
                    └──────────────► informs configuration
```

That feedback loop is the real product.

The user defines the intended agent architecture.

The control plane determines what configuration actually resolves.

OpenCode and OMO execute it.

The control plane observes the resulting behavior.

That behavior then provides evidence for tuning the architecture.

The end state is therefore not merely easier configuration management.

It is a **complete local engineering console for designing, operating, inspecting, debugging, and tuning an OMO-Slim multi-agent system.**
