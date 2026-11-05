# Runtime validation — 2026-11-05

## Environment

- OpenCode 2.2.5, connected to the existing shared service; no service restart.
- Real OpenCode TUI in an isolated tmux terminal, using the same global
  configuration, server, Tavily credential, and built artifacts as the user.
- Catppuccin Frappe theme; 180-column terminal, enlarged vertically so existing
  sidebar plugins did not hide Tavily below the fold.
- Real quota: 981/1000 credits remaining, displayed as 98%.
- Final preview is a Linux-staged copy of the 14 built artifacts; SHA-256 hashes
  match the repository's tested `dist/` files. Existing installed runtime
  dependencies are reused without modifying the package cache.

## Passed checks

- Server plugin is active and exposes server, TUI, and RPC features.
- The live quota RPC succeeds with the existing saved Tavily connection.
- Exactly one Tavily sidebar section, including with matching server and CLI
  package entries.
- The initial trial used a 36-column line with a 20-cell bar; the final measured layout is 37 columns with a 25-cell bar (see the follow-ups below).
- Filled cells and percentage are green, yellow, or red under the relevant
  thresholds. Higher thresholds exercised yellow/red with real 98% quota;
  production thresholds were restored to 50/20.
- Reset text remains muted. Marker uses normal text when colored, muted text
  in monochrome, and disappears when disabled.
- Invalid threshold settings fall back to the default bands without hiding data.
- Changing `evenUse` in the real `cli.json` updates the same running preview
  process. A subsequent full configuration reload also works without restarting
  the TUI or the service.
- Production options are restored to colors enabled, 50/20 thresholds, and
  `evenUse: true` for the user's trial.
- All unrelated configuration and credentials are preserved; both configuration
  files have backups.
- No new logged errors after staging on Linux. Directly loading the
  Windows-mounted checkout produced host source-watcher timeouts, so that
  installation method was replaced.
- `npm test`: 108 passed at that stage; the final suite has 114 passing tests. Typecheck, build, and `git diff --check` passed.

## Configuration correction

On OpenCode 2.2.5, options on the server entry did not reach the automatically
loaded TUI: the enabled marker was absent. A matching entry with display options
in `cli.json` fixed this without duplicating the section. Server credentials
belong in `opencode.json(c)`; display options and `refreshMs` belong in `cli.json`.

## Known limitation: full host reload

The earlier claim that a full **Reload Configurations** always makes zero
additional upstream quota requests was not confirmed and was disproved in this
run. The snapshot changed from `2026-11-05T15:42:42.997Z` to
`2026-11-05T15:44:30.891Z` across the full-reload check, inside the usual
five-minute fresh-cache period.

The existing TUI subscribes to credential and integration updates and can
invalidate freshness. Its fetch/cache/refresh implementation was not changed
for this feature or this installation. Server request-budget and cooldown tests
continue to pass, but SC-005's zero-request guarantee across a full host reload
remains an unmet runtime criterion, not a completed validation claim.

Failure/loading/warning behavior and calendar-boundary math were covered by
the automated suites, not induced against the user's live credential. No
minute-boundary countdown transition was specifically captured in the live TUI.

## Alignment follow-up — 2026-11-06

The user requested that Tavily's bar end with opencode-quota's bars. The initial
20-cell Tavily bar ended five columns early because the reference has a
five-column row prefix before its 20-cell bars.

- Intermediate layout: 25 bar cells + one space + four-column percentage + one
  space + five-column compact reset; this was superseded by the right-edge
  correction below, which widened the reset field to six columns for a 37-column
  line.
- Countdown examples: `25.3d`, `23h`, `4h32m`, `59m`. Larger units are floored;
  positive sub-minute remainders remain `1m`. Toast formatting is unchanged.
- Live OpenCode TUI: bar endpoints and percentage columns matched all five
  visible reference rows; only one Tavily section rendered, with its green
  fill/percentage and normal-text marker intact.
- Captured intermediate live line: `█████████████████████┃███  98% 25.3d`.
- `npm test`: 111 passed, including a reference-column regression and a full
  month's fixed-column checks. Typecheck, build, and diff checks passed.
- Snapshot used at this intermediate stage:
  `/home/cardi/.local/share/opencode-tavily-quota/display-preview-aligned-20261106`.
  The previous trial and pre-alignment configurations are preserved. The final
  active snapshot is recorded in the right-edge section below.

The full-host-reload caveat above remains unchanged; alignment adds no fetch,
cache, refresh, credential, or rate-limit changes.

## Countdown right-edge correction — 2026-11-06

The user's screenshot exposed a remaining one-column mismatch: the previous
36-column Tavily line ended before the reference's 37-column content edge.
The countdown now uses the same six-column right-aligned field as the reference.
The sidebar measures its available width with `onSizeChange` and passes it
through `buildLines`; the fallback is 37 columns. At the current width, the bar
remains 25 cells and the percentage does not move.

Live capture verified all three alignments against five reference rows, including
the final countdown glyph: `█████████████████████┃███  98%  25.3d`.
All 114 tests, typecheck, and build pass, including regression coverage for
36-, 37-, and 40-column content areas, short/long countdowns, and display-setting
changes leaving the quota snapshot untouched.
Active trial: `/home/cardi/.local/share/opencode-tavily-quota/display-preview-right-edge-20261106`.
