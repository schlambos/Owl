# Slice 16 — Controlled Live Verification: Read-Only Report

**Date:** 2026-08-13  
**Status:** `passed — bridge unavailable as expected`

## Procedure

1. Started the updated control plane on isolated loopback port `8791` in attach mode. OpenCode was not restarted and the telemetry bridge was not registered.
2. Captured `GET /api/system/multiplexer` and `GET /api/config/edit-state`.
3. Captured SHA-256 for the active OMO config and `opencode.json`.
4. Ran only the endpoint's source-verified static `command -v` availability checks.

## Expected read-only behavior

- No restart, pane, attach, kill, spawn, close-pane, or send-keys controls are exposed.
- The bridge remains optional; absence produces a neutral "Unavailable" state, not a health error.

## Result

- Configured fields: omitted; all four values came from built-in provenance.
- Effective: `type=none`, `layout=main-vertical`, `main_pane_size=60`, `zellij_pane_mode=agent-tab`.
- Detection: no verified environment signal; resolved type `none`/null.
- Availability: `tmux` and `opencode` resolved; `zellij`, `herdr`, `kitten`, `kitty`, and `cmux` did not resolve.
- Bridge: not registered/configured; `bridgeConnected=false`; runtime mapping unavailable without a warning.
- Runtime correlation: live mapping unavailable as expected. Bridge fixtures cover authoritative manager/cmux and job correlation.
- Baseline OMO config SHA-256: `8efa6922114ea12f49dcb3309493d6cab9d385de75393945863e67f6e8a0ada0`.
- Baseline `opencode.json` SHA-256: `501af6d738844340d9e322f534bdd14bb960d3b9ef03842fcd9d91f59a746a2c`.
- No multiplexer session command, process inspection, pane query, or terminal capture occurred.
