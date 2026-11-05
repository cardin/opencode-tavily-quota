# Contract: Sidebar Quota Line

**Feature**: `001-quota-display-settings`
**Consumer**: OpenCode's session sidebar
**Renderer**: `tui.tsx` maps `DisplayLine` segments to `<span>` foreground colors inside a `<text>`.

## Layout

The quota line fills the measured sidebar content width and never wraps or truncates. The current host provides 37 columns:

```text
<bar: 25 cells><1 space><percent: 4 right-aligned><1 space><countdown: 6 right-aligned>
  25          +   1     +        4            +   1     +          6             = 37
```

- Bar width: `measuredWidth − 12`, currently `37 − 12 = 25`. Its endpoint matches opencode-quota's current five-column row prefix followed by a 20-cell bar; the percentage and countdown right edges also align. `SIDEBAR_WIDTH = 37` is only a fallback until the containing box is measured.
- Percentage: `formatPercent(snapshot.percentRemaining)`, right-aligned in 4 columns (`100%`, ` 84%`, `0.0%`).
- Countdown: `formatCompactResetCountdown(nextMonthlyResetAt(now), now)`, right-aligned in 6 columns, with padding before the label and none after it. Compact text itself uses at most 5 columns. A day or more uses floored tenths of a day (`6.5d`, `30.9d`, `31.0d`); 10–23 hours uses whole hours (`23h`); shorter periods use `4h32m`, `1h`, or `59m`. A positive sub-minute remainder is `1m`. The verbose toast formatter is unchanged.
- Separators are single spaces; there is no middle dot.
- The word "left" does not appear in this line.
- Loading, error, and warning messages keep their existing text and may wrap.

## Segment Roles

| Role | Content | Color when enabled | Color when disabled |
| --- | --- | --- | --- |
| `fill` | `█` cells inside the bar | `good` / `warning` / `low` | muted |
| `empty` | `░` cells inside the bar | muted | muted |
| `percent` | The percentage label, excluding padding | `good` / `warning` / `low` | muted |
| `reset` | The countdown | muted | muted |
| `mark` | The `┃` even-use marker | text base | muted |
| `muted` | Separators, padding, warnings, errors | muted | muted |

The level colors come from the OpenCode theme:

- `good` → `text.feedback.success.base`
- `warning` → `text.feedback.warning.base`
- `low` → `text.feedback.error.base`
- muted → `text.muted` (legacy `text.subdued`)
- text base → `text.base` (legacy `text.default`)

## Level Contract

With the default thresholds:

| Displayed percentage | Level | Bar fill and percentage |
| --- | --- | --- |
| `>= 50%` | `good` | green |
| `>= 20%` and `< 50%` | `warning` | yellow |
| `< 20%` | `low` | red |

The displayed label's numeric value decides the level. A raw `19.96%` displays `20%` and is yellow.

When `colors.enabled` is `false`, the bar fill, percentage, countdown, empty cells, separators, and `┃` marker all use muted monochrome text. The marker stays visible through its distinct glyph. No green, yellow, or red is used.

## Even-Use Marker Contract

The mark is drawn only when all of these are true:

- `evenUse` is `true`.
- The bar has at least 3 cells.
- The monthly window and current time are valid.

Position:

```text
windowStart = 00:00 UTC on the first day of the current month (inclusive)
windowEnd   = 00:00 UTC on the first day of the next month (exclusive)
expected    = (windowEnd − now) / (windowEnd − windowStart) × 100, clamped 0..100
cell        = round(expected / 100 × barWidth), clamped 0..barWidth−1
```

- The window is half-open: `[windowStart, windowEnd)`. An instant exactly at `windowEnd` belongs to the next window.
- `┃` replaces the fill or empty glyph in that cell.
- The marker does not move the fill boundary and does not change the percentage.
- At the exact start of a window the mark sits in the last cell; one millisecond before the boundary it sits in the first cell.
- With a bar shorter than 3 cells, no mark is drawn.

## Examples

### 84% remaining, reset in 6d 12h, colors on

```text
█████████████████████░░░░  84%   6.5d
```

- Bar: 21 filled, 4 empty.
- `84%` and the filled cells are green (with defaults).
- Empty cells, separators, and `6.5d` are muted.
- Length: 37 columns at the current measured width, with padding before the right-aligned labels.

### 100% remaining, reset in 30d 23h, colors on

```text
█████████████████████████ 100%  30.9d
```

- Full bar, green label and fill.
- No truncation at the longest countdown.

### 35% remaining, reset in 12d 4h, colors on

```text
█████████░░░░░░░░░░░░░░░░  35%  12.1d
```

- Yellow bar fill and percentage.

### 10% remaining, reset in 5d 2h, colors on

```text
███░░░░░░░░░░░░░░░░░░░░░░  10%   5.0d
```

- Red bar fill and percentage.

### Half the month elapsed, 30% remaining, even-use mark on

```text
████████░░░░░┃░░░░░░░░░░░  30%  15.0d
```

- Fill: 8 cells.
- Even-use expected: 50%; marker cell: 13 (`0`-based).
- The mark sits in empty space, showing that usage is faster than an even pace.
- The percentage stays `30%`; the fill boundary does not move.

### Half the month elapsed, 80% remaining, even-use mark on

```text
█████████████┃██████░░░░░  80%  15.0d
```

- Fill: 20 cells.
- Even-use expected: 50%; marker cell: 13.
- The mark sits inside the filled area, showing that usage is slower than an even pace.

### Colors off

```text
█████████████████████░░░░  84%   6.5d
```

Same characters and layout, but all text uses the theme's muted monochrome color, including the `┃` marker when enabled. The marker stays visible through its distinct glyph. No green, yellow, or red appears.

## Error and Warning States

- `loading…` — unchanged.
- `⚠ <message>` — unchanged.
- Ready snapshot plus `⚠ <warning>` — the quota line stays a single measured-width line; the warning occupies its own line and may wrap.
