# Architecture notes

See `PLAN.md` (product gospel) and `docs/recon/*` for verified environment facts.

## Running

```bash
# clone anywhere — the checkout directory is the Owl install root
git clone <repo-url> omo-slim
cd omo-slim
bun install
bun run dev          # server http://127.0.0.1:8787 + web http://127.0.0.1:5173, backend 4096 auto-managed
# default target project is this checkout (launchers start the server with cwd = install root)
# explicit distinct target:
OMO_CP_PROJECT_DIR=/path/to/your/project bun run dev
# or separately:
bun run dev:server   # http://127.0.0.1:8787 (with --watch)
bun run dev:web      # http://127.0.0.1:5173
```

No separate `opencode serve` is required. In Managed mode (default, `OPENCODE_BASE_URL` unset) the control plane owns the OpenCode backend lifecycle via the installed SDK. In Attach mode (`OPENCODE_BASE_URL=http://host:port`) it attaches to an external server and never owns/stops it. See `30-managed-opencode-runtime.md` for the full lifecycle.

Owl install root is discovered portably from the root `package.json` (`omo-control-plane`) and is distinct from the selected target project. `OMO_CP_PROJECT_DIR` (absolute existing directory; default is the server's startup cwd, which under `bun run dev`/`dev:server`/`start` is the Owl checkout because launchers start the server there) selects the target project. `OPENCODE_CONFIG_DIR` (absolute existing directory; default `$HOME/.config/opencode`) selects the active OpenCode config. Authorized filesystem roots are exactly the realpaths of Owl install root, target project root, and OpenCode config root. In Managed mode the server changes cwd to the selected target immediately after config load so the SDK inherits it; Attach mode does not chdir and never owns/stops an external backend. API/UI/preferred backend ports remain `8787`/`5173`/`4096`. `bun run dev` remains the one-command workflow; separate `dev:server`/`dev:web`/`start` commands are unchanged. Telemetry bridge package identity (`packages/omo-telemetry-bridge`) resolves under the Owl install root, not the target project.

Environment:

| Variable | Default | Notes |
|----------|---------|-------|
| `OPENCODE_BASE_URL` | unset | Unset → Managed (control plane owns backend). Set → Attach (external backend, never owned/stopped). |
| `OPENCODE_SERVER_PASSWORD` | unset | OpenCode Basic auth password; unset = unsecured server. |
| `OPENCODE_SERVER_USERNAME` | `opencode` | OpenCode Basic auth username. |
| `OPENCODE_CONFIG_DIR` | `$HOME/.config/opencode` | Absolute existing directory; default `$HOME/.config/opencode`. |
| `OMO_CP_PROJECT_DIR` | server cwd (Owl checkout under `bun run dev`/`dev:server`/`start`) | Absolute existing directory; selects target project. Default is the server's startup cwd, which under the official launchers is the Owl install root checkout. |
| `OH_MY_OPENCODE_SLIM_DISABLE` | unset | OMO kill switch; any non-empty/false value relaxes OMO registration requirement. |
| `OMO_CP_HOST` | `127.0.0.1` | Control plane bind host. |
| `OMO_CP_PORT` | `8787` | Control plane bind port. |
| `OMO_BRIDGE_BASE_URL` | unset | Explicit OMO telemetry bridge plugin URL (`http://127.0.0.1:<port>` only); unset = managed bridge lane may be used if registered, otherwise disabled. |
| `OMO_BRIDGE_PORT` | unset | Bridge bind port; managed range is `8788..8803`. |
| `OMO_BRIDGE_ACTIVATION_NONCE` | unset | Activation nonce; raw value exists only inside the launch boundary scope. |

## Layer ownership

- **Desired** — config files under authorized OpenCode config / project `.opencode`
- **Effective** — control-plane reimplementation of OMO loader merge rules
- **Live** — OpenCode HTTP API

No configuration writes in slice 1.

## Slice notes

| Doc | Slice |
|-----|-------|
| `11-sse-runtime-slice.md` … `23-omo-runtime-telemetry-slice.md` | 2–14 |
| `24-agent-editor-remediation.md` | **14.5** — Agents model editor product workflow (remediation) |
| `25-model-probing-provider-diagnostics.md` | **15** — model availability, explicit entitlement probing, provider diagnostics, agent-assignment validation |
| `26-schema-safe-config-writes-remediation.md` | **26** — installed-schema fail-closed validation of all OMO JSON writes (incident remediation) |
| `27-multiplexer-slice.md` | **16** — Multiplexer configuration (schema, auto detection, layout semantics, bridge v2 stores, OMO job→pane correlation, safe JSONC writes, System/Inspector/Jobs/Doctor UI). Evidence: `evidence/multiplexer-slice/` |
| `28-agents-ui-redesign.md` | **Side slice** — Agents assignment UI / information architecture, critic-approved redesign: five-column assignment surface, FocusTrapDialog drawer/editor, URL-synced state (Slice 16 remains paused). Evidence: `evidence/agents-ui-redesign/` |
| `30-managed-opencode-runtime.md` | **Managed OpenCode runtime** — backend lifecycle remediation: dev supervisor, Managed/Attach modes, SDK ownership, restart policy, dynamic canonical URL, verification procedure |
| `evidence/telemetry-bridge-activation/manifest.md` | **Slice 17** — managed bridge registration/removal/restart pipeline, System → Telemetry Bridge UI, `/api/opencode/bridge/*` API + `telemetry-bridge.updated` SSE, validation evidence, limitations, rollback guidance |
| `32-configuration-completion.md` | **Slice 18** — Interview typed writes, raw OMO workspace, single transaction boundary, installed-schema coverage audit (`bun run audit:omo-schema`). Companion remains read-only / intentionally not developed further. Live reversible proofs are parent/verifier-owned. |
| `33-antigravity-ui-redesign.md` | **Side slice** — application-wide Antigravity-inspired shell, themes, navigation, surfaces, tables, forms, page migrations, browser evidence, critique, and regression results. Slice 18 remains paused. |
| `34-team-topology-views-follow-up.md` | **Side slice (follow-up)** — Team topology views (Agents / Models / Providers) as route-backed Effective topology over existing `AgentsDto`/`ModelInventoryDto`/`ProvidersDto`; frontend-only IA refinement of 28/33 with no server/API/schema/probe-engine changes. |
