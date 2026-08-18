# Slice 28 redesign — critique pass

Date: 2026-08-13. Reviewer pass over the first implementation, against the
original problem list and the 22 exit criteria, using live browser evidence
(before/after PNGs in this directory).

## Original problems → resolution

1. **Assigned was invisible** → Assignment is now the dominant column; Assigned
   is derived client-side (never `row.desiredModel`) and surfaced on override.
2. **Wrong Assigned from `row.desiredModel`** → presentation computes Assigned
   from the base intentional source; modal Current state uses the same prop.
   Page/modal consistency is test-covered.
3. **Aligned rows as loud as drifted ones** → aligned = one human model line +
   quiet `Provider · canonical` secondary; no Healthy / Not tested anywhere.
4. **Cryptic drift pill** → `Assignment overridden` (warn) vs `Runtime drift`
   (accent) are distinct text+color labels with expanded layer lines.
5. **Raw source stage** → human source button with independent path disclosure.
6. **Fallbacks absent** → Signals column `+N fallbacks` with ordered disclosure.
7. **Selection destroyed the scan surface** → right-docked true-modal sheet;
   the list stays full width, visible, and inert behind a transparent backdrop.
8. **Alphabetical order** → default role order retained (BUILTIN first, custom
   A–Z); explicit column sorts on top, restorable on third click.
9. **No filters / weak search** → filter chips + URL state; search covers agent,
   model, provider, source, and fallback ids.
10. **Disabled Observer as em-dashes** → Disabled + Unconfigured + Edit (still
    an ordinary editable row). Council/councillor link to `/council` instead of
    masquerading as broken rows.
11. **Edit competed with Caps / internal destination ranks** → Edit stays the
    primary action; destination copy is human ("Preset · openai", "Root
    override"), winner-derived defaults, project-preset scope bug fixed, exact
    pre-preview advisory when the destination differs from the winner.

## Critique areas (first pass → finding → correction)

- **Assignment priority** — dominant column, human name first. ✓
- **Quiet aligned state** — ✓ (after-wide.png: only fixer's Timeout is loud).
- **Distinct override/drift** — ✓ via tests; real config has neither state
  (mapping in manifest.md).
- **Nested provider/fallback/probe** — Provider column removed; provider folds
  into the quiet Assignment secondary line; fallbacks + model health merge
  into Signals. Found: primary-only probe hid fallback failures → corrected
  with `probeIssues[]` (primary + fallbacks).
- **Edit usability at 1024** — after-narrow.png: no horizontal scroll, Edit
  and Caps fully reachable. Sticky Actions evaluated → not needed.
- **Independent disclosures** — source/fallbacks/issues toggle inline with
  aria-expanded/controls; verified live that the source toggle never opens
  the drawer or changes the URL.
- **Ownership routes** — council live-only/councillor → /council, ACP → /acp,
  native → /config (`Managed by OpenCode configuration`); council with a
  normal effective assignment remains editable.
- **Modal focus/background** — FocusTrapDialog: initial heading focus, Tab
  trap, Escape, direct backdrop close, inert+aria-hidden background restored
  on close, focus return to the invoking row control. Live interactive
  snapshot confirms only dialog controls are reachable while open.
- **Found during live review:** "Effective present, no Assigned" (builtin
  default resolution) rendered as `Assignment overridden` → corrected:
  override now requires an actual Assigned value.
- **Found during test review:** project-scope preset winner defaulted to the
  user preset destination → corrected in `destinationForWinner`.

## Known limitations (accepted)

- Real config has no override/drift/fallback/fallback-issue/ACP/native-visible
  states — synthetic tests cover them (manifest.md mapping).
- CapabilityEditModal remains on the legacy non-trapping modal shell.
- Drawer intentionally repeats all three layers even when aligned.
