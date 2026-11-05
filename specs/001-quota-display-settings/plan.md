# Implementation Plan: Configurable Quota Display

**Branch**: `001-quota-display-settings (logical; no git branch created)` | **Date**: 2026-11-05 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-quota-display-settings/spec.md`

## Summary

Add a configurable, single-line Tavily quota display. The line shows the progress bar, the rounded percentage remaining without the word "left", and the reset countdown. The bar fill and percentage use green, yellow, or red from the OpenCode theme at configurable thresholds; coloring can be switched off for a monochrome line. An opt-in `┃` even-use marker shows the remaining share if quota were consumed evenly across the current UTC calendar month.

The implementation adds a pure `display.ts` module for settings parsing, level classification, even-use math, and line composition. `tui.tsx` renders the resulting segments as colored `<span>` elements. The server, quota cache, refresh policy, rate-limit handling, and toast wording stay unchanged.

## Technical Context

**Language/Version**: TypeScript 5.6 (ES2022), Node.js ≥22

**Primary Dependencies**: OpenCode 2.x plugin/TUI APIs (`@opencode/plugin`, `@opencode/theme`), OpenTUI (`@opentui/core`, `@opentui/solid`), SolidJS. No new dependencies.

**Storage**: N/A. Display settings are plugin options; the existing Tavily quota cache is untouched.

**Testing**: Node `node:test` via `tsx --test`; `npm test`, `npm run typecheck`, `npm run build`.

**Target Platform**: OpenCode 2.x TUI in a terminal (Linux, macOS, Windows); development environment is WSL.

**Project Type**: library/plugin (single package, flat source layout)

**Performance Goals**: Render-time composition only; zero additional quota requests from formatting; line assembly is O(bar width), bounded by the measured host width.

**Constraints**: Fill OpenCode's measured sidebar content width (37 columns currently); no wrapping or truncation; colors come from theme feedback tokens; existing quota, cache, refresh, and rate-limit behavior must not change.

**Scale/Scope**: One new source module, `tui.tsx` and `usage.ts` updates, build/config wiring, three test files, and README configuration docs.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The repository constitution at `.specify/memory/constitution.md` is still the unratified template (`[PROJECT_NAME]`, `[PRINCIPLE_1_NAME]`, and other placeholders). There are therefore no ratified project-specific gates. The repository's existing conventions are used as the gate instead:

- **Testability**: Pure formatting and display logic stays separate from OpenTUI and network code, with node:test coverage.
- **Simplicity**: One new pure module; no new runtime dependencies; no new storage or network paths.
- **Compatibility**: Existing server, cache, refresh, rate-limit, warning, error, and toast behavior remains unchanged. Existing `apiKey` and `refreshMs` options keep working; new options are optional with defaults.
- **Quality gates**: `npm test`, `npm run typecheck`, and `npm run build` must pass.

**Result**: PASS. No violations; Complexity Tracking is empty.

**Post-design re-check**: PASS. The design adds only pure display code and theme-colored spans; it does not touch quota acquisition or persistence.

## Project Structure

### Documentation (this feature)

```text
specs/001-quota-display-settings/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   ├── plugin-options.md
│   └── quota-line.md
├── checklists/
│   └── requirements.md
└── spec.md
```

`tasks.md` is generated later by `/speckit.tasks`, not by this command.

### Source Code (repository root)

```text
.
├── display.ts           # NEW: pure settings, level, even-use, and segment logic
├── usage.ts             # Existing quota client and formatting helpers
├── tui.tsx              # Sidebar rendering; colored segments replace plain strings
├── index.ts             # Server entrypoint; unchanged
├── quota-cache.ts       # Quota cache; unchanged
├── refresh.ts           # Refresh policy; unchanged
├── rpc.ts               # RPC contract; unchanged
├── tests/
│   ├── usage.test.ts    # Update formatting expectations
│   ├── display.test.ts  # NEW: settings, levels, even-use, line composition
│   └── tui.test.ts      # Update buildLines expectations
├── README.md            # Document display options and one-line layout
├── package.json         # Add tests/display.test.ts to the test script
├── tsconfig.json        # Include display.ts and tests/**/*.test.ts
├── tsconfig.build.json  # Include display.ts in declaration output
└── scripts/
    └── build.mjs        # Emit dist/display.js
```

**Structure Decision**: The repository is a flat single-package OpenCode plugin. The new pure module `display.ts` sits beside `usage.ts` and is consumed only by `tui.tsx` and tests. Test suites live together in `tests/` so the source root stays focused.

## Implementation Notes

### Display settings

New optional plugin options, documented in `contracts/plugin-options.md`:

```json
{
  "colors": {
    "enabled": true,
    "warningBelow": 50,
    "lowBelow": 20
  },
  "evenUse": false
}
```

- `colors.enabled` defaults to `true`.
- `colors.warningBelow` defaults to `50`; `colors.lowBelow` defaults to `20`.
- A threshold is valid only when it is a finite number in `[0, 100]`. If either threshold is invalid, or the low threshold exceeds the warning threshold, both fall back to `50`/`20`.
- `evenUse` defaults to `false`; only an explicit boolean `true` enables it.
- Settings are resolved from `context.options` on each sidebar render. They take effect after OpenCode's **Reload Configurations** command, without a full restart. Display application never triggers a quota fetch; a full host reload may refresh through the existing lifecycle.

### Line layout

Measured-width layout, currently 37 columns (also the initial fallback):

```text
bar (25) + " " (1) + percentage (4, right-aligned) + " " (1) + countdown (6, right-aligned) = 37
```

- Bar width is `measuredWidth − 12`, currently `37 − 1 − 4 − 1 − 6 = 25`, matching opencode-quota's bar, percentage, and countdown right edge. The containing box reports its width through `onSizeChange`, just like the reference plugin.
- The percentage is the rounded `percentRemaining` label (for example `84%` or `100%`), never derived from the bar's rounded cell count. This keeps the displayed value accurate at a shorter bar width.
- The color level uses the numeric value of the displayed label, so a label that reads `20%` is yellow even when the raw value is `19.96%`.
- The sidebar countdown uses `formatCompactResetCountdown`, for example `6.5d`, `23h`, `4h32m`, or `45m`. The existing verbose toast formatter is unchanged.
- The line fills the measured content width; no wrapping or truncation. Countdown padding is before the label, never after it.

### Segments and colors

`display.ts` returns `DisplayLine` objects containing `LineSegment`s. Segment roles are `fill`, `empty`, `percent`, `reset`, `mark`, and `muted`.

Color mapping in `tui.tsx`:

| Segment role | Color when enabled | Color when disabled |
| --- | --- | --- |
| `fill` | level color (`good`/`warning`/`low`) | muted |
| `percent` | level color | muted |
| `empty` | muted | muted |
| `reset` | muted | muted |
| `mark` | text base | muted |
| `muted` | muted | muted |

Level colors use the theme's existing feedback tokens:

- `good` → `theme.text.feedback.success.base`
- `warning` → `theme.text.feedback.warning.base`
- `low` → `theme.text.feedback.error.base`
- `muted` → `theme.text.muted` (or legacy `text.subdued`)
- `text` → `theme.text.base` (or legacy `text.default`)

When `colors.enabled` is false, the marker uses the same muted monochrome color as the rest of the line and remains visible through its distinct `┃` glyph.

### Even-use mark

- The current window is the half-open UTC calendar month `[start, end)`: the current month's first-of-month `00:00 UTC` (inclusive) through the next month's first-of-month `00:00 UTC` (exclusive), matching `nextMonthlyResetAt`. An instant exactly at `end` belongs to the next window.
- Expected even-use remaining is `(windowEnd − now) / (windowEnd − windowStart) × 100`, clamped to `[0, 100]`.
- The marker cell is `round(expected / 100 × barWidth)`, clamped to `0..barWidth−1`.
- The marker character is `┃`; it replaces the fill or empty glyph in that cell.
- The marker is omitted when the bar has fewer than three cells or when the window is unavailable or invalid.
- Enabling the marker never changes the bar's fill boundary or the displayed percentage.

### Percentage and level rules

- `formatPercent` supplies the label; the numeric value of that label drives `levelOf`.
- Boundaries with defaults: `≥50%` good, `≥20%` and `<50%` warning, `<20%` low.
- Equal thresholds are valid: the low band wins only below the low threshold.
- Invalid thresholds fall back to the default pair.

### Rendering

- `buildLines(state, now, settings)` in `tui.tsx` returns `DisplayLine[]`.
- The sidebar renders each line as a `<text>` containing `<span style={{ fg, bold }}>` segments, following the OpenTUI pattern used elsewhere in the OpenCode plugin ecosystem.
- Loading, error, and warning lines remain muted text. The warning stays on its own line.
- The title and toast behavior are unchanged.

### Files and build wiring

- Add `display.ts` to `tsconfig.json`, `tsconfig.build.json`, and `scripts/build.mjs`; add `tests/display.test.ts` to the `test` script in `package.json`.
- Add `tests/display.test.ts` for settings, level, even-use, and line-composition tests.
- Update `tests/usage.test.ts` and `tests/tui.test.ts` for the new line shape and the removal of the old `formatQuotaLine` layout.
- Keep the display-formatting helpers `formatPercent`, `formatResetCountdown`, `nextMonthlyResetAt`, `formatResetLine`, and `formatRemaining` in `usage.ts`; the toast keeps using them. Leave the quota client and credential helpers unchanged. Remove `formatQuotaLine`, `barPercent`, `progressBar`, `barFill`, and the old layout constants so `display.ts` is the only bar composer.
- Refresh `docs/sidebar.png` to show the new single-line layout before release; the current image shows the old two-line layout.

## Complexity Tracking

No constitution violations, justified exceptions, or added projects. The feature adds one pure module and reuses the existing TUI/theme stack.
