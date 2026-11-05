# Quickstart: Configurable Quota Display

**Feature**: `001-quota-display-settings`
**Date**: 2026-11-05

## Prerequisites

- Node.js 22 or newer
- npm
- OpenCode 2.x for the manual sidebar check
- An active Tavily credential for live quota data

## Automated Validation

From the repository root:

```sh
npm install
npm test
npm run typecheck
npm run build
```

Expected:

- `npm test` passes the existing suites plus the new `display.test.ts`.
- `npm run typecheck` completes with no errors.
- `npm run build` emits `dist/display.js` along with the existing artifacts.

The new tests are deterministic and cover the display rules without network access. They are the primary validation for settings parsing, level boundaries, line width, and even-use placement.

## Manual Validation

Load both plugin halves through `opencode.json(c)` using your normal local development setup, then configure the display options on a matching terminal plugin entry in `~/.config/opencode/cli.json`. OpenCode 2.2.5 does not forward server options to the TUI:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    {
      "package": "opencode-tavily-quota",
      "options": {
        "colors": {
          "enabled": true,
          "warningBelow": 50,
          "lowBelow": 20
        },
        "evenUse": true
      }
    }
  ]
}
```

Run OpenCode's **Reload Configurations** command after saving the options. A full OpenCode restart is not required. A full configuration reload can also refresh quota through the existing host lifecycle; normal cache and rate-limit protections remain in effect. See [runtime-validation.md](./runtime-validation.md) for the observed OpenCode 2.2.5 limitation.

### Scenario 1: One-line layout

1. Open a session with the Tavily sidebar visible.
2. Confirm the quota occupies one line containing the bar, the percentage, and the reset countdown.
3. Confirm the word "left" is absent from that line.
    Confirm the bar, percentage, and countdown right edge align with opencode-quota's rows. The current 37-column content area has a 25-cell bar; other widths are measured automatically.
4. The minute clock recomputes the countdown without a quota request. Compact labels change only when their displayed precision boundary is crossed (for example, a tenth of a day for day labels).

Expected example at 84% remaining with 6 days 12 hours left:

```text
█████████████████████░░░░  84%   6.5d
```

See [contracts/quota-line.md](./contracts/quota-line.md) for the full layout contract.

### Scenario 2: Color thresholds

1. With the default thresholds, confirm a high remaining percentage is green, a value around 35% is yellow, and a value below 20% is red.
2. Confirm the bar fill and the percentage use the same level color.
3. Confirm the empty bar cells and reset countdown stay muted.
4. Set `colors.warningBelow` to `70` and `colors.lowBelow` to `30`, run **Reload Configurations**, and confirm the bands move.
5. Set invalid values such as `"warningBelow": 120` or `"lowBelow": 80` with `"warningBelow": 50`, run **Reload Configurations**, and confirm the line still renders with the default 50/20 bands.

Expected: no invalid setting prevents the quota line from rendering.

### Scenario 3: Monochrome toggle

1. Set `"colors": { "enabled": false }` and run **Reload Configurations**.
2. Confirm the bar fill, empty cells, percentage, countdown, and `┃` marker all use the terminal's normal muted monochrome text color.
3. Confirm no green, yellow, or red appears anywhere in the line.
4. With `evenUse` on, confirm the `┃` marker is still visible through its distinct glyph even though it shares the muted color.

Expected example:

```text
█████████████████████░░░░  84%   6.5d
```

### Scenario 4: Even-use mark

1. Enable `"evenUse": true` and run **Reload Configurations**.
2. Compare the `┃` position with the elapsed part of the current UTC month.
3. Around the middle of the month, the mark should sit near the middle of the 25-cell bar (cell 13, zero-based).
4. Confirm the marker does not change the percentage or move the fill boundary.
5. Disable `evenUse` and confirm the marker disappears.
6. At the exact 00:00 UTC first-of-month boundary, confirm the new window starts with the marker in the last cell; one millisecond before the boundary it should be in the first cell.

Examples from the contract:

```text
████████░░░░░┃░░░░░░░░░░░  30%  15.0d
█████████████┃██████░░░░░  80%  15.0d
```

See [contracts/quota-line.md](./contracts/quota-line.md) for the even-use calculation and marker rules.

### Scenario 5: Existing states

1. Trigger a refresh failure with a previous snapshot present; confirm the quota line stays on one line and the `⚠` warning appears on its own line.
2. Confirm loading and error messages are unchanged.
3. Confirm the refresh toast still shows the existing credit count, percentage, and reset countdown.

## Contracts and Data Model

- [contracts/plugin-options.md](./contracts/plugin-options.md) — option names, defaults, and fallback rules.
- [contracts/quota-line.md](./contracts/quota-line.md) — line layout, segment colors, and marker placement.
- [data-model.md](./data-model.md) — entities and calculation flow.

## Out of Scope

- No custom hex colors or color-picker UI.
- OpenCode owns sidebar sizing. The plugin fills its measured content width, with 37 columns as the initial fallback.
- No full OpenCode restart is required; display changes apply after **Reload Configurations**.
- No changes to quota fetching, caching, refresh timing, or rate-limit handling.
- No change to the refresh toast wording.
