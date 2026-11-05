# Tasks: Configurable Quota Display

**Input**: Design documents from `/specs/001-quota-display-settings/`

**Prerequisites**: `plan.md` (required), `spec.md` (required), `research.md`, `data-model.md`, `contracts/`, `quickstart.md`

**Tests**: Included because the plan requires a new `display.test.ts` and updates to the existing `usage.test.ts` and `tui.test.ts` suites. The repository's quality gates are `npm test`, `npm run typecheck`, and `npm run build`.

**Organization**: Tasks are grouped by user story so each story can be implemented, tested, and validated independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: Which user story this task belongs to (`[US1]`, `[US2]`, `[US3]`)
- All paths are repository-relative, matching the layout in `plan.md`; test suites live under `tests/`

## Path Conventions

- Source: `display.ts`, `usage.ts`, `tui.tsx`, `index.ts`, `quota-cache.ts`, `refresh.ts`, `rpc.ts`
- Tests: `tests/display.test.ts`, `tests/usage.test.ts`, `tests/tui.test.ts`, `tests/quota-cache.test.ts`, `tests/quota-process.test.ts`, `tests/refresh.test.ts`, `tests/index.test.ts`
- Feature docs: `specs/001-quota-display-settings/`
- Build/config: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `scripts/build.mjs`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Wire the new display module into the existing build and test harness.

- [X] T001 Create `display.ts` with shared types and layout constants: fallback `SIDEBAR_WIDTH = 37`, `PERCENT_COLUMN_WIDTH = 4`, `RESET_COLUMN_WIDTH = 6`, single-space separators, and fallback `DEFAULT_BAR_WIDTH = 25`; export shared display types. The live sidebar passes its measured width.
- [X] T002 Create `display.test.ts` with the `node:test` imports and shared fixtures for a quota snapshot and a fixed UTC clock, using the test style in `usage.test.ts`.
- [X] T003 Add `display.ts` and `display.test.ts` to the `tsconfig.json` include list; add `display.ts` to `tsconfig.build.json`; add `display.test.ts` to the `test` script in `package.json`; add `display.ts` to the build list in `scripts/build.mjs`.

**Checkpoint**: The new module is included in typecheck, tests, and the build output.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Settings resolution and shared bar/line primitives that every user story uses.

**⚠️ CRITICAL**: Complete this phase before starting any user story.

- [X] T004 [P] Add tests for `resolveDisplaySettings` in `display.test.ts`: defaults from `undefined`, valid partial values, custom thresholds, non-boolean toggles, out-of-range/non-numeric thresholds, and the `lowBelow > warningBelow` fallback pair from `contracts/plugin-options.md`.
- [X] T005 Implement `resolveDisplaySettings(options: unknown)` in `display.ts` with the defaults, nested `colors` parsing, threshold validation, pair fallback, and `evenUse` toggle rules in `contracts/plugin-options.md`.
- [X] T006 Implement `lineText(line)` and `textLine(text, wrapMode)` helpers in `display.ts`; `lineText` joins segment text and `textLine` creates a muted single-segment line for loading/error/warning messages.
- [X] T007 [P] Extend `readThemeColors` in `tui.tsx` to expose `good`, `warning`, `low`, `muted`, and `text` colors from `theme.text.feedback.success/warning/error`, `theme.text.muted`, and `theme.text.base`, keeping the existing legacy `text.default`/`text.subdued` fallbacks.
- [X] T008 Implement `barSegments(percentRemaining, width)` in `display.ts` returning `fill`/`empty` segments with fixed-width clamping, and add its tests to `display.test.ts`.

**Checkpoint**: Settings, theme colors, and bar cell composition are ready and tested.

---

## Phase 3: User Story 1 - Color-coded remaining quota (Priority: P1) 🎯 MVP

**Goal**: The bar fill and percentage use the good/warning/low color level, and turning color off returns the line to monochrome.

**Independent Test**: With default settings, an 80% snapshot yields a `good` level, 35% yields `warning`, and 10% yields `low`; with `colors.enabled: false`, all segments including the marker resolve to `muted`. The same assertions hold through `buildLines` and the TUI palette mapping.

### Tests for User Story 1

- [X] T009 [US1] Add tests in `display.test.ts` for `levelOf` boundaries (100%, 50%, 49.96%, 20%, 19.96%, 19.94%, 0%), custom thresholds, equal thresholds, and for `colorRoleFor` mapping `fill`/`percent` to the level color, `empty`/`reset` to muted, `mark` to text base when colors are on, and `fill`/`percent`/`empty`/`reset`/`muted`/`mark` to muted when colors are disabled.

### Implementation for User Story 1

- [X] T010 [US1] Implement `levelOf(percent, settings)` and `colorRoleFor(segment, settings, level)` in `display.ts` using the boundary rules in `contracts/plugin-options.md`: `percent < lowBelow` is low, `lowBelow <= percent < warningBelow` is warning, and `percent >= warningBelow` is good.
- [X] T011 [US1] Implement `formatQuotaLineSegments(snapshot, settings, width)` in `display.ts` for the two-line increment: a fixed-width bar using `barSegments` plus a bare right-aligned percentage segment, with the level applied to `fill` and `percent`.
- [X] T012 [US1] Update `buildLines` in `tui.tsx` to accept `DisplaySettings` (defaulting to `DEFAULT_DISPLAY_SETTINGS` for tests), and update the sidebar setup to resolve settings from `context.options` on each render and pass them into `buildLines`; return `DisplayLine[]` containing the existing reset countdown as a muted line and the segmented bar/percentage line. Update `TavilyQuotaSidebar` to render `LineSegment`s as `<span style={{ fg }}>` elements using the palette from T007. Keep loading, error, and warning text behavior unchanged.
- [X] T013 [US1] Update `tui.test.ts` for the segmented two-line ready state: reset line first, quota line second, warning on its own line, loading/error strings unchanged, and quota segments carrying the expected roles.

**Checkpoint**: User Story 1 is independently functional: colors and monochrome work on the two-line display.

---

## Phase 4: User Story 2 - Compact single-line quota status (Priority: P2)

**Goal**: Combine the bar, bare percentage, and reset countdown on one measured-width line and remove the word "left".

**Independent Test**: At the current measured width, a ready state returns one 37-column line with a 25-cell bar, `84%`, and `6.5d`; the longest countdown does not truncate or wrap. The bar, percentage, and countdown right edge align with the reference. Test other measured widths too.

### Tests for User Story 2

- [X] T014 [P] [US2] Test exact 37-column strings for 84%/`6.5d`, 100%/`30.9d`, and 0.0%/`1m`; assert no `"left"` or middle dot, a 25-cell bar, percentage right-aligned in 4 columns, and countdown right-aligned in 6 columns. Cover all three reference alignments, different measured widths, and stable columns throughout the month.
- [X] T015 [P] [US2] Update `tui.test.ts` for the one-line ready state: `buildLines` returns the quota line plus an optional warning, loading/error strings are unchanged, and the quota line text matches the contract examples.

### Implementation for User Story 2

- [X] T016 [US2] Compose compact reset segments with six-column right alignment and pass the containing box's measured width through `buildLines` to `formatQuotaLineSegments`. Use `SIDEBAR_WIDTH` only as the initial fallback. Keep the toast's verbose formatter unchanged.
- [X] T017 [US2] Update `buildLines` in `tui.tsx` to remove the separate reset line and return only the full quota line, plus the existing warning line when present; pass `now` into the line composer.
- [X] T018 [US2] Update `usage.ts` and `usage.test.ts` to remove `formatQuotaLine`, `barPercent`, `progressBar`, `barFill`, the 9-character `"100% left"` percent column, and the old layout constants; keep the display-formatting helpers `formatPercent`, `formatResetCountdown`, `nextMonthlyResetAt`, `formatResetLine`, and `formatRemaining` with their existing tests, and leave the quota client and credential helpers unchanged. `display.ts` is the only bar composer.

**Checkpoint**: User Stories 1 and 2 both work independently: colors plus the compact one-line layout.

---

## Phase 5: User Story 3 - Optional even-use mark (Priority: P3)

**Goal**: An opt-in `┃` marker shows where remaining quota would sit with even use across the UTC month; it never changes the fill boundary or percentage.

**Independent Test**: At half the month elapsed, the marker cell is 10 of 20; with 30% remaining the fill is 6 cells and the label stays `30%`; with the setting off there is no `mark` segment; with a bar shorter than 3 cells there is no marker.

### Tests for User Story 3

- [X] T019 [P] [US3] Add tests in `display.test.ts` for `monthlyWindow` and `evenUsePercent` at the start, midpoint, and end of a UTC month, including the half-open boundary (`end - 1ms` in the old window vs exactly `end` in the next window), across a year boundary, for invalid/non-finite times, for `evenUseCell` (50% of width 20 → cell 10, 100% → cell 19, 0% → cell 0, width under 3 → undefined, clamping), and for `formatQuotaLineSegments` with `evenUse` on/off including the marker remaining present when colors are disabled.
- [X] T020 [P] [US3] Update `tui.test.ts` to assert a `mark` segment appears in `buildLines` when `evenUse` is true, is absent when false, and does not change the quota line's percentage or fill segments. Assert the mark text is `┃` and differs from the `█`/`░` fill and empty glyphs in both color modes.

### Implementation for User Story 3

- [X] T021 [US3] Implement `monthlyWindow(now)`, `evenUsePercent(now)`, and `evenUseCell(evenPercent, width)` in `display.ts` using the UTC first-of-month boundary (`Date.UTC(year, month, 1)` through the next month) from `contracts/quota-line.md`.
- [X] T022 [US3] Extend `barSegments` and `formatQuotaLineSegments` in `display.ts` to accept the optional marker cell, replace the fill/empty glyph at that cell with `┃`, emit a `mark` segment, and omit the marker when `settings.evenUse` is false, the window is invalid, or the bar has fewer than 3 cells.
- [X] T023 [US3] Update the sidebar setup in `tui.tsx` to pass the existing `now` clock through `buildLines` into `formatQuotaLineSegments` so the marker follows the minute clock. Verify settings take effect after OpenCode's **Reload Configurations** command, without a full restart.
  - Completed under the reconciled FR-017/SC-005: display application and the minute clock do not fetch quota; a full host reload may refresh through OpenCode's lifecycle. See [runtime-validation.md](./runtime-validation.md).

**Checkpoint**: All three user stories work independently and together.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, stale-reference cleanup, and full validation.

- [X] T024 [P] Update `README.md`: document `colors.enabled`, `colors.warningBelow`, `colors.lowBelow`, and `evenUse` with defaults and invalid-value fallback; state that changes apply after OpenCode's **Reload Configurations** command; update the sidebar description to the one-line color-coded layout and even-use mark.
- [X] T025 [P] Review and update `specs/001-quota-display-settings/quickstart.md` if implementation names or commands differ; confirm its automated and manual scenarios match the final behavior.
- [X] T026 Search `usage.ts`, `tui.tsx`, `usage.test.ts`, `tui.test.ts`, and `README.md` for stale `formatQuotaLine`, `"100% left"`, and two-line reset references; remove or update them after T024.
- [X] T027 Run `npm test`, `npm run typecheck`, and `npm run build` from the repository root; fix failures in `display.ts`, `tui.tsx`, `usage.ts`, or their tests.
- [X] T028 [P] Refresh `docs/sidebar.png` to show the new single-line layout before release.
- [X] T029 Validate the automated and manual scenarios in `specs/001-quota-display-settings/quickstart.md`: color thresholds, monochrome toggle, even-use on/off, one-line width, countdown tick, and no extra quota requests.
  - Completed: colors, monochrome, marker, and width pass; `refresh.test.ts` proves the minute clock does not fetch quota. The full-host-reload refresh is covered by the reconciled FR-017/SC-005. See [runtime-validation.md](./runtime-validation.md).
- [X] T030 [P] Review `specs/001-quota-display-settings/contracts/plugin-options.md` and `specs/001-quota-display-settings/contracts/quota-line.md` against the implementation; update any option names, defaults, or examples that drifted.

---

## Dependencies & Execution Order

### Phase Dependencies

```text
Setup → Foundational → US1 → US2 → US3 → Polish
```

- **Setup (Phase 1)**: No dependencies; can start immediately.
- **Foundational (Phase 2)**: Depends on Setup; blocks every user story.
- **User Story 1 (Phase 3)**: Starts after Foundational.
- **User Story 2 (Phase 4)**: Starts after User Story 1 because both edit `display.ts` and `tui.tsx`; US1 must land its segment renderer first.
- **User Story 3 (Phase 5)**: Starts after User Story 2 because it extends the same bar/line composer and `buildLines`.
- **Polish (Phase 6)**: Depends on all desired user stories.

### User Story Dependencies

- **US1**: No dependency on other stories after Foundational.
- **US2**: Depends on US1's `DisplayLine`/segment renderer and `formatQuotaLineSegments`; it changes the line from two lines to one.
- **US3**: Depends on US2's final bar/line composer; it adds the marker to the same bar cells.

### Within Each User Story

- Test tasks come first and should fail before the matching implementation.
- `display.ts` changes are sequential within a story because they share the same module.
- `tui.tsx` changes follow the `display.ts` API they consume.
- TUI tests follow the `buildLines` shape they assert.
- Story checkpoint validation happens before the next story.

### Parallel Opportunities

- Phase 2: T004 (settings tests in `display.test.ts`) and T007 (theme palette in `tui.tsx`) touch different files and can run in parallel.
- US2: T014 (`display.test.ts`) and T015 (`tui.test.ts`) touch different test files and can run in parallel; T016/T017 are sequential implementation.
- US3: T019 (`display.test.ts`) and T020 (`tui.test.ts`) touch different test files and can run in parallel; T021/T022/T023 are sequential.
- Polish: T024 (`README.md`), T025 (`quickstart.md`), T028 (`docs/sidebar.png`), and T030 (contracts) touch different files and can run in parallel; T026 follows T024 because it also touches `README.md`.

---

## Parallel Example: User Story 1

```bash
# Limited parallelism: prepare the test file while drafting the pure module,
# then run the tests before wiring the TUI.
Task: "Add level and color-role tests in display.test.ts"
Task: "Implement levelOf and colorRoleFor in display.ts"

# TUI work follows the stable display API:
Task: "Update buildLines and the sidebar renderer in tui.tsx"
Task: "Update tui.test.ts for the segmented two-line state"
```

## Parallel Example: User Story 2

```bash
# Draft both test updates in parallel:
Task: "Add full one-line layout tests in display.test.ts"
Task: "Update tui.test.ts for the one-line ready state"

# Then implement sequentially because both touch display.ts/tui.tsx:
Task: "Extend formatQuotaLineSegments in display.ts"
Task: "Update buildLines in tui.tsx"
```

## Parallel Example: User Story 3

```bash
# Draft the display and TUI test updates in parallel:
Task: "Add monthly window, even-use, and marker tests in display.test.ts"
Task: "Add the mark-segment assertion in tui.test.ts"

# Then implement sequentially in display.ts, followed by tui.tsx:
Task: "Implement monthlyWindow, evenUsePercent, and evenUseCell"
Task: "Extend barSegments and formatQuotaLineSegments with the marker"
Task: "Pass now and settings through buildLines in tui.tsx"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational.
3. Complete Phase 3: User Story 1.
4. **STOP and VALIDATE**: run the display and TUI tests, confirm green/yellow/red and monochrome on the two-line display.
5. This is the smallest independently valuable increment.

### Incremental Delivery

1. Setup + Foundational → build/test wiring and shared primitives ready.
2. US1 → colored bar and percentage with monochrome toggle (MVP).
3. US2 → compact one-line layout with reset countdown and no "left".
4. US3 → opt-in even-use marker.
5. Polish → README, contracts, screenshot, full test/typecheck/build validation.

### Parallel Team Strategy

- One developer should own `display.ts` through US1–US3 to avoid conflicts.
- A second developer can take independent test/docs files (`tui.test.ts`, `README.md`, `quickstart.md`, contracts) once the corresponding interfaces are stable.
- Do not run US2 and US3 implementation in parallel: both edit `display.ts` and `tui.tsx`.

---

## Notes

- Follow `contracts/plugin-options.md` for option names/defaults and `contracts/quota-line.md` for layout, colors, and marker placement.
- Do not change `index.ts`, `quota-cache.ts`, `refresh.ts`, `rpc.ts`, or the toast wording; the feature is display-only.
- Keep the old `apiKey` and `refreshMs` options working unchanged.
- The percentage label comes from `formatPercent(snapshot.percentRemaining)`; do not derive it from the bar's rounded cell count.
- Level classification uses the numeric value of the displayed label so `20%` is yellow even when the raw value is `19.96%`.
- The even-use window is half-open: `[start, end)`, with an instant exactly at `end` belonging to the next window.
- When `colors.enabled` is false, every segment including `mark` resolves to muted; the marker remains visible through its distinct `┃` glyph.
- Settings changes apply after OpenCode's **Reload Configurations** command; no full restart or quota fetch is required.
- Run `npm test`, `npm run typecheck`, and `npm run build` before declaring the feature complete.
- Commit after each task or logical group; do not push without explicit approval.

---

## Phase 7: Convergence

- [X] T031 [HIGH] Make display-only configuration reloads avoid an upstream quota request, or formally reconcile FR-017/SC-005 with the host's reload lifecycle, while preserving credential/integration refresh and existing cache/rate-limit guarantees; complete T023/T029's reload validation and add a regression assertion that changing colors or `evenUse` does not advance `snapshot.updatedAt` per SC-005 (contradicts)
  - Reconciled FR-017/SC-005: display application and re-render do not fetch quota; a full host reload may refresh through the existing lifecycle. Added the snapshot-immutability regression in `tui.test.ts`.
- [X] T032 [MEDIUM] Reconcile US2/AC1 and US2/AC3 with the implemented compact six-column measured-width countdown (`6.5d`, six-column field) and add or cite acceptance coverage for the current 37-column line per FR-004 (partial)
  - Updated US2/AC1 and US2/AC3 to `6.5d` and the six-column right-aligned field; the existing layout tests cover the 37-column reference alignment.
- [X] T033 [LOW] Regenerate `docs/sidebar.png` from the current 37-column right-aligned formatter (three spaces before the reset), and remove stale 36-column, 20-cell, five-column, and "same entry as apiKey" statements from `research.md`, `runtime-validation.md`, and `contracts/plugin-options.md` per the documentation tasks (partial)
  - Regenerated the 37-column screenshot and reconciled the stale layout and configuration-entry wording.
