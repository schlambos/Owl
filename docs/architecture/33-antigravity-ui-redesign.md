# Antigravity-inspired UI redesign

## Status

Complete as a frontend side slice. Slice 18 remains paused and was not resumed.

The redesign changes presentation and frontend component structure only. It does not change OpenCode lifecycle ownership, API contracts, OMO configuration semantics, schema-safe writes, probes, SSE behavior, or Desired → Effective → Live interpretation.

## References studied

The implementation was based on the published Antigravity Manager GUI overview and direct inspection of:

- Dashboard, light theme (`docs/images/dashboard-light.png`)
- Account List, light and dark themes (`docs/images/accounts-light.png`, `accounts-dark.png`)
- Settings, dark theme (`docs/images/settings-dark.png`)
- API Proxy (`docs/images/v3/proxy-settings.png`)

Reusable characteristics extracted from those screens:

- balanced top chrome with centered segmented navigation;
- cool near-white canvas and white elevated sheets;
- slate, rather than pure-black, dark mode;
- 12–16px surface radii, hairline borders, and restrained shadows;
- compact Account List-style tables with minimal separators;
- Settings-style secondary navigation and inset setting rows;
- blue primary actions with restrained semantic status color;
- dense technical information contained inside calm surfaces.

No Antigravity names, logos, product copy, screenshots, or proprietary assets are included in OMO Control.

## Design skills and research

Material guidance came from the installed skills:

- `frontend-design` — restrained product identity and OMO-specific visual signature;
- `ui-styling` — accessible component and state conventions;
- `ui-ux-pro-max` — density 7, motion 2, responsive navigation, tables, and form guidance;
- `design-system` — primitive → semantic → component token architecture;
- `web-design-guidelines` — semantic navigation, focus, labels, deep links, and reduced motion;
- `vercel-react-best-practices` — direct icon imports and preservation of existing React data paths;
- `agent-browser` and `webapp-testing` — live browser, viewport, keyboard, console, and screenshot checks;
- `verification-planning` — behavior-to-evidence mapping;
- `context7-mcp` — current library/API research discipline.

`lucide-react` is the single UI icon family. Icons are affordances only and are not used as branding.

## Navigation redesign

Before: a permanent 180px sidebar with twelve equal destinations and a dominant connection telemetry strip.

After: a compact top application shell with five primary groups:

| Primary group | Default route | Context destinations |
|---|---|---|
| Overview | `/` | — |
| Team | `/agents` | Agents, Models, Council, ACP |
| Runtime | `/sessions` | Sessions, Doctor |
| Policy | `/presets` | Presets, Capabilities, Prompts, Config |
| System | `/system` | Grouped System sections |

All original routes and query parameters remain valid. At narrower desktop widths the primary navigation becomes an accessible disclosure instead of wrapping into multiple noisy rows.

System retains every original `?section=` deep link. Its fourteen sections are grouped under OpenCode, Orchestration, Workstation, and Advanced, with an accessible all-section chooser inside the settings surface.

## Tokens and themes

The CSS uses semantic light/dark tokens for:

- canvas, surface, inset surface, and elevation;
- primary, muted, faint, and inverse text;
- subtle/default/strong borders;
- primary, hover, active, disabled, and focus states;
- success, warning, danger, and information states;
- spacing, radii, typography, z-index, shadow, and motion.

Representative theme values:

| Role | Light | Dark |
|---|---|---|
| Canvas | `#FAFBFC` | `#15191E` |
| Surface | `#FFFFFF` | `#1D232A` |
| Inset surface | `#F4F7FB` | `#171C22` |
| Primary text | `#172033` | `#E8EDF5` |
| Border | `#E5EAF0` | `#303A46` |
| Primary action | `#3B82F6` | `#3B82F6` |

Light is the default. The explicit user choice is persisted in `omo-control.theme.v1`; a pre-React initializer prevents theme flash and synchronizes `color-scheme` and `theme-color`.

Ordinary UI uses a system sans stack. Monospace is reserved for paths, identifiers, model IDs, timestamps, hashes, and editor content.

## Component system

Shared or standardized primitives include:

- application shell, primary navigation, context navigation, and narrow navigation disclosure;
- workspace header;
- surface/card;
- button and icon button;
- segmented control;
- status badge and status dot;
- theme control;
- compact connection status popover;
- focus-trapped modal and drawer;
- table, toolbar, search/filter, setting row, and toggle patterns.

The permanent connection strip was replaced by `OpenCode · <state>` in the header. The popover retains REST, OpenCode SSE, control-plane SSE, mode, ownership, canonical URL, recency, sessions, stale/restart context, and Reconcile.

## Page migration

- **Overview:** four operational metrics followed by larger runtime, health, provider, and technical-detail panels.
- **Agents:** Account List-style assignment table; Assigned, Effective, Live, source, fallback, drift, health, Edit, drawer, and schema-safe workflow preserved.
- **Models:** compact provider strip and dense inventory table; explicit-only probe safeguards and accessible drawer/confirmation preserved.
- **Sessions:** rounded master/detail workspace, semantic selection, quieter tree/jobs list, segmented inspector, and Raw access preserved.
- **Config:** segmented provenance/revisions/raw workspace; Monaco is framed by the design system without changing editor contracts.
- **Capabilities:** dense rounded capability matrix with accessible editing dialog.
- **Prompts:** source list/editor split with source, effective, and diff views.
- **Presets:** searchable list/detail/compare workspace with lifecycle semantics intact.
- **Council and ACP:** consistent list/detail management surfaces with existing probe/runtime distinctions intact.
- **System:** grouped settings navigation, large settings sheet, service headers, inset setting rows, toggles, and existing write gates.
- **Doctor:** compact health summary and one filtered diagnostic list/detail surface; severity remains icon-and-text, not color-only.

## CSS cleanup

The remaining 1,839-line legacy stylesheet was reduced to a 588-line tokenized shared compatibility layer. Dead/conflicting selectors and migrated inline styles were removed, while page-specific layout rules remain isolated in page stylesheets.

The convergence pass reduced production CSS from approximately 162 KB raw / 24.7 KB gzip to 128 KB raw / 15.5 KB gzip before the final small critique refinements.

## Responsive and accessibility decisions

Browser verification covered approximately 1440px, 1000px, and 768px desktop widths in both themes.

Implemented checks include:

- skip link and semantic navigation landmarks;
- visible focus and keyboard-operable disclosures;
- labeled icon-only controls;
- focus trap, Escape, outside dismissal, inert background, and focus return for overlays;
- semantic selected state for session and job rows;
- status represented by text/icon as well as color;
- reduced-motion handling;
- local table scrolling without viewport overflow;
- connected form labels and accessible System section chooser.

## Functional regression and verification

The browser pass exercised, without committing mutations:

- managed OpenCode connection and connection details;
- Overview runtime state;
- Models search, filters, provider disclosure, drawer, and probe-confirmation path;
- Agent drawer and Edit workflow entry;
- Assigned / Effective / Live presentation;
- Sessions selection and inspector tabs;
- Config provenance, revisions, and raw Monaco workspace;
- Capabilities matrix and edit dialog;
- Prompts and Presets list/detail workspaces;
- System sections and telemetry surfaces;
- Council, ACP, and Doctor navigation.

Final automated results:

```text
apps/web tests       218 passed, 0 failed
apps/web typecheck   passed
apps/web build       passed
root typecheck       passed
```

The production build retains the existing Monaco-related large-chunk warning; it is not a regression introduced by this visual slice.

## Critique and corrections

An independent design critique identified four main gaps: weak primary-nav contrast, repeated Models status chrome, flattened System section pills, and duplicated Overview health status.

Corrections completed before closeout include:

- compact provider disclosure and quieter unprobed Models states;
- four-group System hierarchy plus an accessible all-section chooser;
- secondary Refresh hierarchy;
- Overview health expressed as state with issue counts secondary;
- semantic focus return and session selection fixes;
- full CSS/test convergence.

## Intentional differences and remaining limitations

- OMO retains substantially denser technical surfaces than Antigravity because it must expose provenance, runtime state, permissions, sessions, and raw configuration.
- Monaco keeps professional editor conventions rather than adopting card-heavy consumer styling.
- The shell has no copied desktop traffic-light or Antigravity logo treatment.
- Some page-specific styles still adapt shared compatibility classes such as `pill`, `error`, and `probe-badge`; they are tokenized and scoped, but could be renamed in a future maintenance-only cleanup.
- The header retains a subtle blur and the primary segmented styling is slightly softer than the Antigravity reference. These are visual polish limitations, not functional blockers.
- No Slice 18 feature work or live mutation proof was resumed as part of this side slice.
