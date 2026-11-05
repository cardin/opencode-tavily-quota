# Feature Specification: Configurable Quota Display

**Feature Branch**: `001-quota-display-settings (logical; no git branch created)`

**Created**: 2026-11-05

**Status**: Draft

**Input**: User description: "Introduce color settings to make the bar and the percentage colored green, yellow or red, depending on the % left. Also add a seeting to enable an even-use mark (see opencode-quota repo for what is an even-use mark). Also remove the word 'left' and stuff the date remaining into the same line as the bar/percentage."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Color-coded remaining quota (Priority: P1)

As an OpenCode user, I want the Tavily progress bar and percentage to change color as my remaining credits fall, so I can tell at a glance whether I am comfortably funded, getting low, or nearly exhausted.

**Why this priority**: Color gives the fastest signal about quota health. The percentage still provides the exact value, so color improves scanability without removing information.

**Independent Test**: Render the sidebar at high, medium, and low remaining percentages with the default and with custom thresholds. The story is complete when the bar fill and percentage use the same green/yellow/red level in every case, including 0% and 100%.

**Acceptance Scenarios**:

1. **Given** 80% of credits remaining and the default thresholds, **When** the sidebar renders, **Then** the bar fill and the percentage are green.
2. **Given** 35% remaining and the default thresholds, **When** the sidebar renders, **Then** the bar fill and the percentage are yellow.
3. **Given** 10% remaining and the default thresholds, **When** the sidebar renders, **Then** the bar fill and the percentage are red.
4. **Given** custom thresholds of 70% for warning and 30% for low, **When** 60% remains, **Then** the line is yellow; **When** 25% remains, **Then** the line is red.
5. **Given** coloring is switched off, **When** the sidebar renders, **Then** the entire quota line renders in the terminal's normal monochrome text color, with no green, yellow, or red anywhere in the bar, percentage, countdown, or even-use mark.
6. **Given** 0% or 100% remaining, **When** the sidebar renders, **Then** the percentage label is `0%` or `100%`, the whole bar is empty or filled, and the level color is correct.

---

### User Story 2 - Compact single-line quota status (Priority: P2)

As an OpenCode user, I want the bar, percentage, and time until reset on one line without the word "left", so the sidebar takes less vertical space and the reset time is visible next to the value it affects.

**Why this priority**: The current two-line layout spends a full line on the reset countdown. Combining the information makes the sidebar denser without losing the countdown.

**Independent Test**: Render a ready state and verify one measured-width line containing the bar, bare percentage, and countdown with no "left" suffix. Its bar endpoint, percentage, and countdown right edge must match opencode-quota's rows. Loading, error, and warning behavior remains unchanged.

**Acceptance Scenarios**:

1. **Given** 84% remaining and a reset in 6 days 12 hours, **When** the sidebar renders, **Then** a single line shows the 25-cell bar, `84%`, and the compact `6.5d` countdown.
2. **Given** one minute passes, **When** the sidebar re-renders, **Then** the countdown reflects the new time without fetching quota again.
3. **Given** the longest valid monthly countdown and a three-digit percentage, **When** the sidebar renders, **Then** the compact countdown fits its six-column right-aligned field, the bar remains 25 cells, and neither label is truncated or wrapped.
4. **Given** a stale-data warning is present, **When** the sidebar renders, **Then** the warning remains on its own additional line and the quota line stays on one line.
5. **Given** the plugin is loading or has an error, **When** the sidebar renders, **Then** its existing loading and error messages are unchanged.

---

### User Story 3 - Optional even-use mark (Priority: P3)

As an OpenCode user, I can switch on a marker in the bar that shows where my remaining quota would be if I used it evenly until the next reset, so I can see whether I am ahead of or behind a sustainable pace.

**Why this priority**: The raw percentage does not show whether usage is on pace for the month. The mark adds that context while remaining optional for users who prefer a simpler bar.

**Independent Test**: Toggle the setting, render the sidebar at a known point in the monthly window, and verify the marker position against the expected even-use percentage without changing the bar fill or the displayed percentage.

**Acceptance Scenarios**:

1. **Given** half of the monthly window has elapsed and 30% of credits remain, **When** the even-use mark is enabled, **Then** the marker sits at the 50% position while the bar fill stays at 30%.
2. **Given** half of the monthly window has elapsed and 80% of credits remain, **When** the even-use mark is enabled, **Then** the marker sits at the 50% position and the bar fill extends past it.
3. **Given** the even-use mark is disabled, **When** the sidebar renders, **Then** no marker appears and the bar is unchanged.
4. **Given** the bar is too short to place the marker unambiguously (fewer than three cells), **When** the sidebar renders, **Then** no marker appears and the bar still renders normally.
5. **Given** the current reset or window information is unavailable, **When** the sidebar renders, **Then** no marker appears while the rest of the line still renders.
6. **Given** the even-use mark is enabled, **When** the sidebar renders, **Then** the displayed percentage and the filled portion of the bar are identical to the values shown when the mark is disabled.

---

### Edge Cases

- Remaining quota is exactly 0% or exactly 100%.
- Remaining quota is exactly at a threshold: 50% with defaults is green, 20% with defaults is yellow, and below 20% is red.
- Thresholds are equal, reversed, outside 0–100, non-numeric, or missing.
- Countdown is `1m` just before the reset or close to the maximum monthly duration. `formatResetCountdown` still reports `0m` for a past or exact reset when called directly.
- The reset crosses a month or year boundary, including the 00:00 UTC first-of-month boundary; the exact boundary belongs to the next window.
- At the current measured 37-column width, a 25-cell Tavily bar occupies the reference's five-column prefix plus 20-cell bar. Compact labels preserve the bar endpoint; the countdown uses six columns to end at the reference's right edge. Other widths are measured automatically.
- The terminal theme has limited color support or the user has colors disabled.
- Coloring is toggled off and the configuration is applied; the line becomes monochrome. Display changes do not fetch quota themselves, though a full host configuration reload may refresh through OpenCode's existing lifecycle.
- Settings are changed while OpenCode is running.
- A stale-data warning is shown together with the quota line.
- Quota fetching is rate-limited or in an error state.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The sidebar quota line MUST show the progress bar, the percentage of credits remaining, and the time until the next reset on one line.
- **FR-002**: The sidebar percentage MUST be a bare percentage (for example `84%`) and MUST NOT include the word "left".
- **FR-003**: The countdown MUST use the existing time-until-reset value and MUST update at least once per minute while the sidebar is visible.
- **FR-004**: The combined line MUST fill the measured sidebar content width: bar cells, one space, a four-column right-aligned percentage, one space, and a six-column right-aligned compact countdown. The current 37-column content area leaves 25 bar cells. The bar endpoint, percentage, and countdown right edge MUST align with opencode-quota's reference rows. The labels MUST NOT be truncated or wrapped. OpenCode manages the host sidebar width; the plugin measures its available space.
- **FR-005**: Users MUST be able to configure the warning and low thresholds. The defaults MUST be 50% and 20% remaining. With the defaults, 50% or more is green, at least 20% but below 50% is yellow, and below 20% is red.
- **FR-006**: Invalid threshold settings, including values outside 0–100, non-numeric values, or a low threshold above the warning threshold, MUST fall back to the default pair without breaking the sidebar.
- **FR-007**: The filled portion of the bar and the percentage text MUST use the same level color.
- **FR-008**: The empty portion of the bar MUST remain neutral or muted and MUST NOT use the level color.
- **FR-009**: Users MUST be able to toggle coloring on and off. Coloring MUST be on by default. When off, the entire quota line MUST render in the terminal's normal monochrome text color with no green, yellow, or red, including the bar fill, percentage, countdown, and even-use mark. The marker stays visible through its distinct `┃` glyph even when it shares the muted color.
- **FR-010**: Color MUST NOT be the only indicator of quota health; the numeric percentage MUST remain visible whenever the bar is visible.
- **FR-011**: Users MUST be able to enable or disable the even-use mark. The mark MUST be off by default so the existing display is unchanged for users who do not opt in.
- **FR-012**: When enabled, the even-use mark MUST appear inside the bar at the position representing how much quota would remain if the current month's quota were consumed evenly from the start of the window to the reset.
- **FR-013**: The expected even-use percentage MUST be calculated from the share of the monthly window still remaining, clamped to 0–100%. The window MUST be half-open: it starts at 00:00 UTC on the first day of the month and ends at 00:00 UTC on the first day of the next month; the exact end instant belongs to the next window.
- **FR-014**: The even-use mark MUST NOT change the bar's filled length or the displayed percentage.
- **FR-015**: The even-use mark MUST remain visually distinct from both the filled and empty bar cells whether coloring is on or off.
- **FR-016**: The even-use mark MUST be omitted when the bar has fewer than three cells or when the current reset or window information is unavailable or invalid.
- **FR-017**: Settings changes MUST take effect after the user runs OpenCode's **Reload Configurations** command. A full OpenCode restart MUST NOT be required. Applying display settings and re-rendering the line MUST NOT itself trigger a quota fetch; a full host configuration reload may refresh through OpenCode's existing lifecycle, subject to the existing cache and rate-limit protections.
- **FR-018**: The feature MUST NOT change quota fetching, caching, refresh timing, rate-limit handling, or the number of quota requests.
- **FR-019**: The new settings and their defaults MUST be documented in the README configuration section.
- **FR-020**: Existing loading, error, stale-warning, refresh-command, and toast behavior MUST remain unchanged except for the display changes explicitly required above.

### Key Entities *(include if feature involves data)*

- **Quota snapshot**: The remaining percentage, next reset time, and last-updated time used to render the sidebar.
- **Display settings**: Whether coloring is on, the warning threshold, the low threshold, and whether the even-use mark is on.
- **Quota level**: The good, warning, or low classification derived from the remaining percentage and the thresholds.
- **Even-use expectation**: The window start, window end, and the percentage that would remain if usage were spread evenly across the month.
- **Quota line**: The single sidebar row containing the bar, percentage label, reset countdown, and optional even-use marker.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For every remaining percentage from 0% to 100%, the bar fill and percentage text show the same level color, and the level matches the configured thresholds in 100% of cases.
- **SC-002**: Users can correctly classify a quota as healthy, getting low, or nearly exhausted from the line in under 2 seconds without reading the numeric value.
- **SC-003**: For every valid percentage and monthly countdown, the line fills the measured sidebar width, with zero truncation or wrapping and the final countdown glyph on the rightmost content column.
- **SC-004**: The even-use marker is within one character cell of the ideal even-use position for every bar width of three cells or more.
- **SC-005**: Enabling or disabling coloring or the even-use mark updates the next render without a full restart. The display change and its re-render produce no quota request of their own; a full host configuration reload may refresh through the existing lifecycle, within the normal cache and rate limits.
- **SC-006**: Invalid settings never prevent the sidebar from rendering; 100% of invalid configurations fall back to a readable default display.
- **SC-007**: With coloring off, the entire quota line renders without green, yellow, or red in 100% of quota states while remaining legible in the terminal's normal monochrome text.

## Assumptions

- The phrase "date remaining" means the existing countdown to the monthly reset, not a calendar date.
- Removing "left" applies to the sidebar quota line. The refresh toast and README prose may keep their existing wording unless a separate change is requested.
- The green/yellow/red palette comes from the terminal theme's standard color roles; custom user-picked colors and arbitrary hex values are outside this feature's scope.
- "Black and white" means the terminal theme's normal monochrome foreground colors, not literal black text on every background; the plugin must stay legible in both light and dark themes.
- The color settings are the on/off switch plus the two thresholds; the threshold defaults follow the referenced `opencode-quota` convention of 50% and 20%.
- The even-use mark is opt-in and defaults to off because the request asks for a setting that enables it.
- Coloring is on by default; switching it off returns the whole line to monochrome. The marker remains visible through its `┃` glyph and uses the same muted color as the rest of the line.
- Display settings are read from the plugin options. Changes apply after OpenCode's **Reload Configurations** command, without a full restart. Display application itself does not fetch quota; a full host reload may refresh through OpenCode's existing lifecycle.
- Existing plugin settings, including `apiKey` and `refreshMs`, remain unchanged and continue to live in the same configuration location.
- OpenCode manages the sidebar width; the plugin measures its content area rather than assuming a fixed 36-column row.
