# Data Model: Configurable Quota Display

**Feature**: `001-quota-display-settings`
**Date**: 2026-11-05

## Overview

The feature is display-only. It adds settings, derived display state, and line-composition entities; it does not add persistence or network data. The existing `QuotaSnapshot` remains the source of quota values.

## Entities

### DisplaySettings

Resolved from the plugin options on each render.

| Field | Type | Default | Validation |
| --- | --- | --- | --- |
| `colors.enabled` | boolean | `true` | Only an explicit `false` disables color; non-boolean values use the default. |
| `colors.warningBelow` | number | `50` | Finite number in `[0, 100]`; paired with `lowBelow`. |
| `colors.lowBelow` | number | `20` | Finite number in `[0, 100]`; must be `<= warningBelow`. |
| `evenUse` | boolean | `false` | Only an explicit `true` enables the mark; non-boolean values use the default. |

**Pair fallback**: If either threshold is invalid, or `lowBelow > warningBelow`, both thresholds resolve to `50` and `20`. If only one threshold is supplied and valid, the other keeps its default and the resulting pair is validated.

**Source**: `context.options` (plugin options). The server half ignores these fields. Changes apply after OpenCode's **Reload Configurations** command; no full restart or quota fetch is required.

### QuotaSnapshot

Existing entity in `usage.ts`; unchanged.

| Field | Type | Meaning |
| --- | --- | --- |
| `planName` | string | Tavily plan name. |
| `used` | number | Credits consumed this cycle. |
| `limit` | number | Credits included this cycle. |
| `remaining` | number | Credits still available, never negative. |
| `percentRemaining` | number | `remaining / limit × 100`, in `[0, 100]`. |
| `updatedAt` | number | Epoch milliseconds when the snapshot was produced. |

### QuotaLevel

Derived from the displayed percentage and the threshold settings.

| Value | Condition with defaults | Color role |
| --- | --- | --- |
| `good` | `percent >= 50` | `good` |
| `warning` | `20 <= percent < 50` | `warning` |
| `low` | `percent < 20` | `low` |

**Rule**: The numeric value of the displayed label drives the level, not the bar's rounded cell count. This keeps `20%` yellow even when the raw value is `19.96%`.

**Threshold generalization**:
- `percent < lowBelow` → `low`
- `lowBelow <= percent < warningBelow` → `warning`
- `percent >= warningBelow` → `good`

Equal thresholds are valid: with `warningBelow == lowBelow`, the yellow band is empty and values below the shared threshold are red.

### MonthlyWindow

The UTC calendar month used by both the countdown and the even-use mark.

| Field | Type | Meaning |
| --- | --- | --- |
| `start` | number | `00:00 UTC` on the first day of the current month. |
| `end` | number | `00:00 UTC` on the first day of the next month. |

**Invariant**: `start < end`. The window is half-open: `[start, end)`. An instant exactly at `end` belongs to the next window. The existing `nextMonthlyResetAt(now)` returns `end`.

### EvenUseExpectation

| Field | Type | Meaning |
| --- | --- | --- |
| `percent` | number or undefined | Share of the window still remaining, `(end − now) / (end − start) × 100`, clamped to `[0, 100]`. |
| `cell` | integer or undefined | Bar cell for the `┃` mark: `round(percent / 100 × barWidth)`, clamped to `0..barWidth−1`. |

**Rules**:
- `percent` is undefined when the window is unavailable, invalid, or `now` is outside it.
- `cell` is undefined when `percent` is undefined or the bar has fewer than three cells.
- The mark is independent of the color toggle.

### LineSegment

| Field | Type | Meaning |
| --- | --- | --- |
| `text` | string | The exact text drawn for this segment. |
| `role` | `fill` \| `empty` \| `percent` \| `reset` \| `mark` \| `muted` | Semantic color role. |

### DisplayLine

| Field | Type | Meaning |
| --- | --- | --- |
| `segments` | `LineSegment[]` | Ordered segments; concatenating `text` yields the full line. |
| `wrapMode` | `none` \| `word` | `none` for the quota line; `word` for warnings and error messages. |
| `level` | `QuotaLevel` or undefined | Level for the bar fill and percentage segments; undefined for non-quota lines. |

## Relationships

```text
plugin options
    │
    ▼
DisplaySettings ──────────────┐
                              │
QuotaSnapshot ──► displayed % ─┴──► QuotaLevel
     │                                      │
     │                                      ▼
     └──► bar fill / percentage ───► LineSegment roles ───► DisplayLine
                                              ▲
MonthlyWindow ──► EvenUseExpectation ─────────┘
```

- `DisplaySettings` and `QuotaSnapshot` are independent inputs.
- `QuotaLevel` is derived once per quota line and shared by the fill and percentage segments.
- `MonthlyWindow`/`EvenUseExpectation` only affect the `mark` segment.
- `DisplayLine` is consumed by `tui.tsx`, which maps semantic roles to theme colors.

## Validation and Fallback Flow

1. Read `context.options`; if absent or not an object, use defaults.
2. Read `colors`; if absent or not an object, use defaults.
3. Resolve `enabled` (default `true`).
4. Resolve `warningBelow` (default `50`) and `lowBelow` (default `20`).
5. If either threshold is not a finite number in `[0, 100]`, or `lowBelow > warningBelow`, reset both to `50`/`20`.
6. Resolve `evenUse` (default `false`).
7. Return an immutable `DisplaySettings` value.

## Calculation Flow for the Quota Line

1. Compute the label with `formatPercent(snapshot.percentRemaining)`.
2. Parse the label's numeric value; classify it with `levelOf(value, settings)`.
3. Compute the bar width as the measured sidebar width minus 12 (`25` at the current 37-column content width, with a 6-column right-aligned reset field and single-space separators).
4. Fill `round(percentRemaining / 100 × barWidth)` cells; the rest are empty.
5. If `settings.evenUse` is true, compute the monthly window, even-use percentage, and marker cell; replace that cell with `┃`.
6. Group consecutive bar cells by role (`fill`, `empty`, `mark`).
7. Append the separator, right-aligned percentage, separator, and right-aligned compact countdown.
8. Fill the measured content width and return a `DisplayLine` with `wrapMode: "none"`. The final countdown glyph sits on the last column.

## State Transitions

The feature has no persisted state machine. The display state follows the existing `ViewState`:

| Current state | Event | Next state | Display |
| --- | --- | --- | --- |
| `loading` | quota response succeeds | `ready` | Colored quota line plus optional warning. |
| `loading` | quota request fails | `error` | Existing error message; no quota line. |
| `ready` | clock ticks each minute | `ready` | Countdown and even-use mark recompute; no quota fetch. |
| `ready` | refresh fails | `ready` with warning | Existing snapshot line plus warning line. |
| `ready` | quota response succeeds | `ready` | New snapshot line. |
