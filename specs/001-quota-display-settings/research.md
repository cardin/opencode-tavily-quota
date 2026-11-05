# Research: Configurable Quota Display

**Feature**: `001-quota-display-settings`
**Date**: 2026-11-05

## Summary

No open `NEEDS CLARIFICATION` items remain. Research focused on four areas: how to color part of a sidebar line in OpenCode's TUI, which theme tokens represent green/yellow/red, how to define the even-use mark consistently with the referenced `opencode-quota` implementation, and how to keep the one-line layout aligned with the measured sidebar content width.

## Decision 1: Structured line segments instead of a colored string

**Decision**: Represent the quota line as an ordered list of text segments, each with a semantic role (`fill`, `empty`, `percent`, `reset`, `mark`, `muted`). The TUI renders each segment as an OpenTUI `<span>` with its own foreground color.

**Rationale**:
- A single string can only be drawn in one color. The bar fill, percentage, reset countdown, and marker need different colors.
- OpenTUI's `<text>` accepts nested spans with `style={{ fg }}`; this is the same approach used by the referenced `opencode-quota` sidebar.
- A segment model is pure data and can be unit tested without a renderer.
- It keeps color decisions in the TUI layer and layout/formatting decisions in a pure module.

**Alternatives considered**:
- ANSI escape sequences embedded in strings: fragile, mixes presentation with text, and may not survive the OpenTUI renderer.
- One `<text>` element per colored part with manual horizontal layout: risks wrapping and misalignment in a measured-width quota section.
- Separate lines for each part: violates the one-line requirement.

## Decision 2: Use theme feedback tokens for green, yellow, and red

**Decision**:
- Good → `theme.text.feedback.success.base`
- Warning → `theme.text.feedback.warning.base`
- Low → `theme.text.feedback.error.base`
- Muted → `theme.text.muted` (legacy `text.subdued`)
- Marker → `theme.text.base` (legacy `text.default`) when colors are on; muted when colors are off

**Rationale**:
- These tokens are already part of `ResolvedTheme` in `@opencode/theme` and carry the theme's semantic success/warning/error colors, which are green/yellow/red in the default themes.
- They follow light/dark theme changes automatically, unlike hard-coded RGB values.
- The referenced `opencode-quota` implementation uses the same tokens for its level colors.
- The existing plugin already reads legacy `text.default` / `text.subdued` names, so the fallback pattern is established.

**Alternatives considered**:
- Hard-coded `#00ff00` / `#ffff00` / `#ff0000`: ignores the user's theme and can be unreadable.
- `theme.hue` semantic hues: only exposes accent/interactive/neutral, not green/yellow/red roles.
- Creating a custom color picker: outside the requested scope and requires a settings UI or new config format.

## Decision 3: Even-use mark follows the referenced implementation

**Decision**: A `┃` marker inside the bar at the cell representing the share of the monthly window still remaining. Expected even-use remaining is:

```text
(windowEnd − now) / (windowEnd − windowStart) × 100
```

The window is `00:00 UTC` on the first of the current month through `00:00 UTC` on the first of the next month. It is half-open: the exact end instant belongs to the next window.

**Rationale**:
- The referenced `slkiser/opencode-quota` plugin defines the mark as "where even use until the reset would be" and uses `┃`.
- Its `evenUseCell` is `round(evenLeft / 100 × width)`, clamped to the bar; this feature uses the same position rule.
- The monthly UTC window matches the plugin's existing `nextMonthlyResetAt` and countdown, so the mark and countdown describe the same reset.
- The mark is opt-in here because the request asks for a setting that enables it.

**Alternatives considered**:
- Rolling 30-day window: would not match the monthly reset shown by the plugin.
- Provider-reported window start: Tavily's `/usage` response does not include one.
- Marker at the used share instead of remaining share: would invert the meaning of the bar, which shows remaining quota.
- Always-on mark (the reference default): changes the existing display without the requested toggle.

## Decision 4: One-line layout matching the measured content width

**Decision (updated after live user feedback)**: Measure the content width like opencode-quota. At its current 37 columns, use a 25-cell bar, single-space separators, a 4-character right-aligned percentage, and a 6-column right-aligned compact countdown:

```text
25 + 1 + 4 + 1 + 6 = 37
```

The line fills the measured sidebar width. The bar endpoint, percentage, and countdown right edge align with opencode-quota. The earlier fixed 36-column layout ended one column before the reference's countdown. Compact countdown text remains at most five characters inside its six-column field.

**Rationale**:
- The live content width is measured; `display.ts` uses 37 columns as its initial fallback.
- A monthly countdown fits five columns using decimal days (`30.9d`), whole hours from 10 hours (`23h`), compact hours/minutes (`4h32m`), or minutes (`45m`). The toast keeps its verbose formatter.
- A fixed layout keeps the bar's starting point stable and avoids wrapping in a narrow terminal.
- OpenCode owns the host sidebar width. Measure the containing box just like opencode-quota instead of assuming 36 columns.
- A 25-cell bar provides 4% cell granularity and corrects the original layout's five-column-short endpoint.

**Alternatives considered**:
- Keep the old 25-cell bar and put the countdown on a second line: violates the one-line requirement.
- Keep the initial 20-cell bar and verbose countdown: fits, but ends five columns before the adjacent quota bars.
- Use `"resets in 6d 12h"` on the same line: leaves too little room for the bar (about 10 cells).
- Truncate the countdown: violates the no-truncation requirement.
- Let the line wrap: violates the one-line requirement.

## Decision 5: Label uses the rounded actual percentage, not the bar's cell count

**Decision**: The displayed percentage comes from `formatPercent(snapshot.percentRemaining)`. The color level uses the numeric value of that displayed label. The bar fill still uses the raw percentage rounded to the nearest cell.

**Rationale**:
- With a 25-cell bar, deriving the label from the bar can round `54%` to `56%`, which is less accurate than the actual-percentage label.
- The request is about the percentage left, not the bar's cell resolution.
- Using the displayed value for the level keeps the color and the visible number consistent at threshold boundaries: if the label says `20%`, the line is yellow.
- The bar and label may differ by less than one cell; the level color still agrees, which is the requirement.

**Alternatives considered**:
- Keep deriving the label from the bar: less accurate at the shorter width and conflicts with the spec's `84%` example.
- Use the bar's rounded cell percentage for both label and level: same accuracy problem.
- Use raw `percentRemaining` for color but the label for display: can show `20%` in red at `19.96%`, which looks inconsistent.

## Decision 6: Settings live in the existing plugin options

**Decision**: Add optional `colors` and `evenUse` fields to the plugin options object, alongside `apiKey` and `refreshMs`:

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

**Rationale**:
- The plugin already reads `context.options` in both the server and TUI halves.
- No new storage, settings UI, or config file is required.
- Settings apply after OpenCode's **Reload Configurations** command; no full restart or quota fetch is required.
- The nested `colors` object mirrors the referenced plugin's `colors.*` naming and keeps related settings together.
- `evenUse` is a single top-level boolean because it is a single display toggle.

**Alternatives considered**:
- Flat keys (`colorEnabled`, `warningBelow`, `lowBelow`, `evenUse`): workable but more noisy and less aligned with the referenced plugin.
- A separate `display` object: adds a layer without a second consumer.
- A new settings file or TUI settings screen: a much larger feature and not requested.

## Decision 7: Invalid settings fall back as a pair

**Decision**: If either threshold is non-numeric, outside `[0, 100]`, or the low threshold exceeds the warning threshold, both thresholds fall back to `50` and `20`. `colors.enabled` defaults to `true`; `evenUse` defaults to `false`.

**Rationale**:
- A partially valid pair can produce confusing bands (for example a low threshold above the warning threshold).
- Falling back as a pair is simple to explain and test.
- The display must never break because of a configuration typo.

**Alternatives considered**:
- Clamp each value independently: can silently produce odd bands.
- Reject the whole plugin configuration: would hide the quota display over a cosmetic setting.
- Throw a visible error: unnecessary for a display-only option.

## Decision 8: Keep the toast and server behavior unchanged

**Decision**: Only the sidebar quota line changes. The refresh toast keeps `formatRemaining`, `formatPercent`, and `formatResetLine` as they are. The server, quota cache, refresh policy, RPC, and rate-limit handling are not modified.

**Rationale**:
- The request is about the sidebar bar/percentage line.
- The toast already shows the credit count and reset countdown in a compact form.
- Keeping the server path untouched preserves the existing caching and rate-limit guarantees and reduces regression risk.

**Alternatives considered**:
- Apply the same color treatment to the toast: OpenCode's toast API takes a string; coloring it requires fragile span injection. Out of scope.
- Remove "left" from the toast too: the spec scopes the removal to the sidebar line; a separate change can extend it.

## References

- `usage.ts` — percentage formatting, monthly reset calculation, and the verbose toast countdown.
- `tui.tsx` — current sidebar rendering and theme token access.
- `@opencode/theme` `ResolvedTheme` — `text.feedback.success/warning/error`, `text.muted`, `text.base`.
- `slkiser/opencode-quota` — `┃` even-use mark, `evenUseCell`, threshold semantics, theme feedback tokens.
