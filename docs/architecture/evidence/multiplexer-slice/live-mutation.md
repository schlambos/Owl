# Slice 16 — Controlled Live Verification: Mutation Report

**Date:** 2026-08-13  
**Status:** `passed and restored`

## Procedure

1. Simulated one user-scope change: `multiplexer.main_pane_size` from built-in `60` to `61`.
2. Confirmed exact one-field diff, no project masking, and installed-schema validation against OMO-Slim `2.2.10`.
3. Applied with the baseline expected source hash. No type, layout, or Zellij mode field changed.
4. Confirmed effective value/provenance became `61` from the user config and recorded revision `rev_mss6bj04_9e274g`.
5. Restored with the post-apply expected hash through the guarded revision endpoint.
6. Confirmed effective value/provenance returned to built-in `60` and recorded restore revision `rev_mss6bqnm_jrl2c7`.

## Expected safety behavior

- Apply is blocked if the installed-schema gate fails.
- Apply is blocked on hash conflict when the file changed externally.
- No OpenCode session, multiplexer, or backend process is restarted by the control plane.
- The change only takes effect after the OMO plugin is reloaded (requires OpenCode/OMO restart).

## Result

- Simulate schema gate: passed; installed schema hash `947ac72a9035e0b7d7ce80c6e8f16ccdf930677b6b80b61d83b054cedbd30e8b`.
- Apply SHA: `8efa6922114ea12f49dcb3309493d6cab9d385de75393945863e67f6e8a0ada0` → `6d9821e443b6deb372016c98d694d303ae77d4b7d7a51044943f13b848926f04`.
- Restore SHA: `6d9821e443b6deb372016c98d694d303ae77d4b7d7a51044943f13b848926f04` → `8efa6922114ea12f49dcb3309493d6cab9d385de75393945863e67f6e8a0ada0`.
- Final bytes/SHA matched the baseline exactly.
- `opencode.json` remained `501af6d738844340d9e322f534bdd14bb960d3b9ef03842fcd9d91f59a746a2c` throughout.
- No restart or runtime multiplexer action occurred; current plugin adoption was not claimed.
