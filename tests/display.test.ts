import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BAR_SEPARATOR,
  DEFAULT_BAR_WIDTH,
  DEFAULT_DISPLAY_SETTINGS,
  EVEN_USE_MARK,
  PERCENT_COLUMN_WIDTH,
  RESET_COLUMN_WIDTH,
  RESET_SEPARATOR,
  SIDEBAR_WIDTH,
  barSegments,
  colorRoleFor,
  evenUseCell,
  evenUsePercent,
  formatCompactResetCountdown,
  formatQuotaLineSegments,
  levelOf,
  lineText,
  monthlyWindow,
  resolveDisplaySettings,
  textLine,
  type DisplaySettings,
  type LineSegment,
} from "../display.ts";
import { formatResetCountdown, type QuotaSnapshot } from "../usage.ts";

const SNAPSHOT: QuotaSnapshot = {
  planName: "Researcher",
  used: 161,
  limit: 1000,
  remaining: 839,
  percentRemaining: 83.9,
  updatedAt: 0,
};

function snapshot(percentRemaining: number): QuotaSnapshot {
  return {
    planName: "Researcher",
    used: 100 - percentRemaining,
    limit: 100,
    remaining: percentRemaining,
    percentRemaining,
    updatedAt: 0,
  };
}

const NOW_84 = Date.UTC(2026, 8, 24, 12, 0); // Sep 24 2026, 12:00 UTC
const NOW_MAX = Date.UTC(2026, 7, 1, 0, 1); // Aug 1 2026, 00:01 UTC
const NOW_SHORT = Date.UTC(2026, 8, 30, 23, 59, 30); // Sep 30 2026, 23:59:30 UTC
const HALF_MONTH = Date.UTC(2026, 8, 16, 0, 0); // Sep 16 2026, 00:00 UTC

test("display constants match the measured 37-column quota section", () => {
  assert.equal(SIDEBAR_WIDTH, 37);
  assert.equal(PERCENT_COLUMN_WIDTH, 4);
  assert.equal(RESET_COLUMN_WIDTH, 6);
  assert.equal(DEFAULT_BAR_WIDTH, 25);
  assert.equal(
    DEFAULT_BAR_WIDTH + BAR_SEPARATOR.length + PERCENT_COLUMN_WIDTH + RESET_SEPARATOR.length + RESET_COLUMN_WIDTH,
    SIDEBAR_WIDTH,
  );
});

test("resolveDisplaySettings uses defaults and partial valid values", () => {
  assert.deepEqual(resolveDisplaySettings(undefined), DEFAULT_DISPLAY_SETTINGS);
  assert.deepEqual(resolveDisplaySettings({}), DEFAULT_DISPLAY_SETTINGS);
  assert.deepEqual(resolveDisplaySettings({ colors: { warningBelow: 70 } }), {
    colors: { enabled: true, warningBelow: 70, lowBelow: 20 },
    evenUse: true,
  });
  assert.deepEqual(resolveDisplaySettings({ colors: { lowBelow: 30 }, evenUse: false }), {
    colors: { enabled: true, warningBelow: 50, lowBelow: 30 },
    evenUse: false,
  });
  assert.equal(resolveDisplaySettings({ colors: { enabled: false } }).colors.enabled, false);
});

test("resolveDisplaySettings falls back to 50/20 for invalid thresholds", () => {
  const defaults = {
    colors: { enabled: true, warningBelow: 50, lowBelow: 20 },
    evenUse: true,
  };
  assert.deepEqual(resolveDisplaySettings({ colors: { warningBelow: 120 } }), defaults);
  assert.deepEqual(resolveDisplaySettings({ colors: { warningBelow: -1 } }), defaults);
  assert.deepEqual(resolveDisplaySettings({ colors: { warningBelow: "70" } }), defaults);
  assert.deepEqual(resolveDisplaySettings({ colors: { warningBelow: 50, lowBelow: 80 } }), defaults);
  assert.deepEqual(resolveDisplaySettings({ colors: [] }), defaults);
  assert.equal(resolveDisplaySettings({ colors: { enabled: "no" } }).colors.enabled, true);
  assert.equal(resolveDisplaySettings({ evenUse: "yes" }).evenUse, true);
});

test("levelOf classifies the displayed rounded percentage", () => {
  const defaults = DEFAULT_DISPLAY_SETTINGS;
  assert.equal(levelOf(100, defaults), "good");
  assert.equal(levelOf(50, defaults), "good");
  assert.equal(levelOf(49.96, defaults), "good"); // label 50%
  assert.equal(levelOf(49.4, defaults), "warning"); // label 49%
  assert.equal(levelOf(20, defaults), "warning");
  assert.equal(levelOf(19.96, defaults), "warning"); // label 20%
  assert.equal(levelOf(19.94, defaults), "warning"); // label 20%
  assert.equal(levelOf(19.4, defaults), "low");
  assert.equal(levelOf(0, defaults), "low");

  const custom = resolveDisplaySettings({ colors: { warningBelow: 70, lowBelow: 30 } });
  assert.equal(levelOf(70, custom), "good");
  assert.equal(levelOf(60, custom), "warning");
  assert.equal(levelOf(30, custom), "warning");
  assert.equal(levelOf(25, custom), "low");

  const equal = resolveDisplaySettings({ colors: { warningBelow: 50, lowBelow: 50 } });
  assert.equal(levelOf(50, equal), "good");
  assert.equal(levelOf(49.4, equal), "low");
});

test("colorRoleFor maps levels and monochrome roles", () => {
  const on = DEFAULT_DISPLAY_SETTINGS;
  const off = resolveDisplaySettings({ colors: { enabled: false } });
  const role = (name: LineSegment["role"]): Pick<LineSegment, "role"> => ({ role: name });

  assert.equal(colorRoleFor(role("fill"), on, "warning"), "warning");
  assert.equal(colorRoleFor(role("percent"), on, "low"), "low");
  assert.equal(colorRoleFor(role("empty"), on, "low"), "muted");
  assert.equal(colorRoleFor(role("reset"), on, "low"), "muted");
  assert.equal(colorRoleFor(role("muted"), on, "low"), "muted");
  assert.equal(colorRoleFor(role("mark"), on, "low"), "text");
  assert.equal(colorRoleFor(role("fill"), off, "low"), "muted");
  assert.equal(colorRoleFor(role("percent"), off, "low"), "muted");
  assert.equal(colorRoleFor(role("mark"), off, "low"), "muted");
});

test("barSegments composes fixed-width fill/empty cells and clamps input", () => {
  assert.deepEqual(barSegments(50, 10), [
    { text: "█████", role: "fill" },
    { text: "░░░░░", role: "empty" },
  ]);
  assert.equal(lineText({ segments: barSegments(0, 10), wrapMode: "none" }), "░░░░░░░░░░");
  assert.equal(lineText({ segments: barSegments(100, 10), wrapMode: "none" }), "██████████");
  assert.equal(lineText({ segments: barSegments(200, 4), wrapMode: "none" }), "████");
  assert.equal(lineText({ segments: barSegments(-50, 4), wrapMode: "none" }), "░░░░");
});

test("barSegments places the even-use mark and omits it on short bars", () => {
  const marked = barSegments(30, 20, 10);
  assert.equal(lineText({ segments: marked, wrapMode: "none" }), "██████░░░░┃░░░░░░░░░");
  assert.equal(marked.find((segment) => segment.role === "mark")?.text, EVEN_USE_MARK);
  assert.equal(barSegments(50, 2, 1).some((segment) => segment.role === "mark"), false);
});

test("monthlyWindow reports the half-open UTC calendar month", () => {
  assert.deepEqual(monthlyWindow(Date.UTC(2026, 8, 15, 12)), {
    start: Date.UTC(2026, 8, 1),
    end: Date.UTC(2026, 9, 1),
  });
  assert.deepEqual(monthlyWindow(Date.UTC(2026, 11, 15)), {
    start: Date.UTC(2026, 11, 1),
    end: Date.UTC(2027, 0, 1),
  });
  assert.equal(monthlyWindow(Number.NaN), undefined);
});

test("evenUsePercent is 100 at a window start and 50 at mid-month", () => {
  assert.equal(evenUsePercent(Date.UTC(2026, 8, 1)), 100);
  const middle = evenUsePercent(HALF_MONTH);
  assert.ok(middle !== undefined && Math.abs(middle - 50) < 1e-9);
  const beforeEnd = evenUsePercent(Date.UTC(2026, 8, 30, 23, 59, 59, 999));
  assert.ok(beforeEnd !== undefined && beforeEnd > 0 && beforeEnd < 0.001);
  assert.equal(evenUsePercent(Date.UTC(2026, 9, 1)), 100);
  assert.equal(evenUsePercent(Number.NaN), undefined);
});

test("evenUseCell clamps the mark to the bar", () => {
  assert.equal(evenUseCell(50, 20), 10);
  assert.equal(evenUseCell(100, 20), 19);
  assert.equal(evenUseCell(0, 20), 0);
  assert.equal(evenUseCell(30, 20), 6);
  assert.equal(evenUseCell(50, 2), undefined);
  assert.equal(evenUseCell(undefined, 20), undefined);
  assert.equal(evenUseCell(150, 20), 19);
  assert.equal(evenUseCell(-10, 20), 0);
});

test("formatCompactResetCountdown fits five columns without changing toast formatting", () => {
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const cases: Array<[number, string]> = [
    [Number.NaN, "0m"],
    [-minute, "0m"],
    [0, "0m"],
    [30_000, "1m"],
    [59 * minute + 59_000, "59m"],
    [hour, "1h"],
    [4 * hour + 32 * minute, "4h32m"],
    [9 * hour + 59 * minute, "9h59m"],
    [10 * hour + minute, "10h"],
    [23 * hour + 59 * minute, "23h"],
    [day, "1.0d"],
    [6 * day + 12 * hour, "6.5d"],
    [30 * day + 23 * hour, "30.9d"],
    [31 * day, "31.0d"],
  ];
  for (const [duration, expected] of cases) {
    const text = formatCompactResetCountdown(duration, 0);
    assert.equal(text, expected);
    assert.ok(text.length <= 5);
  }
  assert.equal(formatCompactResetCountdown(123_000 + 6 * day + 12 * hour, 123_000), "6.5d");
  assert.equal(formatResetCountdown(6 * day + 12 * hour, 0), "6d 12h");
});

test("formatQuotaLineSegments renders the full 37-column line", () => {
  const line = formatQuotaLineSegments(SNAPSHOT, NOW_84);
  assert.equal(lineText(line), "█".repeat(5) + "┃" + "█".repeat(15) + "░".repeat(4) + "  84%   6.5d");
  assert.equal(lineText(line).length, SIDEBAR_WIDTH);
  assert.equal(line.level, "good");
  assert.equal(line.wrapMode, "none");
  assert.equal(line.segments.find((segment) => segment.role === "percent")?.text, "84%");
  assert.equal(lineText(line).includes("left"), false);
  assert.equal(lineText(line).includes("·"), false);
});

test("bar, percentage, and reset right edge align with opencode-quota's rows", () => {
  // The installed quota sidebar has a five-column row prefix and a 20-cell bar.
  const reference = " 5h  " + "█".repeat(20) + "  84% 4h 32m";
  const text = lineText(formatQuotaLineSegments(SNAPSHOT, NOW_84));
  const endOfBar = (value: string) => value.search(/[█░┃](?![█░┃])/);
  assert.equal(endOfBar(text), endOfBar(reference));
  assert.equal(text.indexOf("84%"), reference.indexOf("84%"));
  assert.equal(text.length, reference.length);
  assert.ok(text.endsWith("6.5d"));
});

test("formatQuotaLineSegments fits the longest countdown", () => {
  const line = formatQuotaLineSegments(snapshot(100), NOW_MAX);
  assert.equal(lineText(line), "█".repeat(24) + "┃ 100%  30.9d");
  assert.equal(lineText(line).length, SIDEBAR_WIDTH);
  assert.equal(line.level, "good");
});

test("formatQuotaLineSegments fits the shortest actual countdown", () => {
  const line = formatQuotaLineSegments(snapshot(0), NOW_SHORT);
  assert.equal(lineText(line), "┃" + "░".repeat(24) + " 0.0%     1m");
  assert.equal(lineText(line).length, SIDEBAR_WIDTH);
  assert.equal(line.level, "low");
});

test("bar and label columns stay fixed through a whole month", () => {
  const start = Date.UTC(2026, 7, 1);
  const end = Date.UTC(2026, 8, 1);
  for (let now = start; now < end; now += 61 * 60_000) {
    for (const percent of [0, 9.96, 19.96, 35, 83.9, 100]) {
      const line = formatQuotaLineSegments(snapshot(percent), now);
      const text = lineText(line);
      assert.equal(text.length, SIDEBAR_WIDTH);
      assert.match(text.slice(0, DEFAULT_BAR_WIDTH), /^[█░┃]{25}$/u);
      assert.equal(text[DEFAULT_BAR_WIDTH], " ");
      assert.ok(line.segments.find((segment) => segment.role === "reset")!.text.length <= RESET_COLUMN_WIDTH);
    }
  }
});

test("the reset label ends at the measured right edge for different widths", () => {
  for (const width of [36, 37, 40]) {
    for (const now of [NOW_84, NOW_MAX, NOW_SHORT]) {
      const line = formatQuotaLineSegments(SNAPSHOT, now, DEFAULT_DISPLAY_SETTINGS, width);
      const text = lineText(line);
      const reset = line.segments.find((segment) => segment.role === "reset")!.text;
      assert.equal(text.length, width);
      assert.ok(text.endsWith(reset));
      assert.equal(text.trimEnd().length, width);
      assert.match(text.slice(0, width - 12), /^[█░┃]+$/u);
    }
  }
});

test("formatQuotaLineSegments places the mark without changing the percentage", () => {
  const on = resolveDisplaySettings({ evenUse: true });
  const off = resolveDisplaySettings({ evenUse: false });
  const withMark = formatQuotaLineSegments(snapshot(30), HALF_MONTH, on);
  const withoutMark = formatQuotaLineSegments(snapshot(30), HALF_MONTH, off);

  assert.equal(lineText(withMark), "█".repeat(8) + "░".repeat(5) + "┃" + "░".repeat(11) + "  30%  15.0d");
  assert.equal(withMark.level, "warning");
  assert.equal(withMark.segments.find((segment) => segment.role === "mark")?.text, EVEN_USE_MARK);
  assert.equal(withoutMark.segments.some((segment) => segment.role === "mark"), false);
  assert.equal(
    withMark.segments.find((segment) => segment.role === "percent")?.text,
    withoutMark.segments.find((segment) => segment.role === "percent")?.text,
  );

  const insideFill = formatQuotaLineSegments(snapshot(80), HALF_MONTH, on);
  assert.equal(lineText(insideFill), "█".repeat(13) + "┃" + "█".repeat(6) + "░".repeat(5) + "  80%  15.0d");
  assert.equal(insideFill.level, "good");
});

test("formatQuotaLineSegments keeps the mark visible in monochrome", () => {
  const settings: DisplaySettings = resolveDisplaySettings({
    evenUse: true,
    colors: { enabled: false },
  });
  const line = formatQuotaLineSegments(snapshot(30), HALF_MONTH, settings);
  assert.equal(line.segments.find((segment) => segment.role === "mark")?.text, EVEN_USE_MARK);
  assert.equal(colorRoleFor(line.segments.find((segment) => segment.role === "mark")!, settings), "muted");
});

test("lineText and textLine compose plain and muted lines", () => {
  assert.equal(lineText(textLine("loading…")), "loading…");
  assert.equal(textLine("warning").wrapMode, "word");
  assert.equal(textLine("quota", "none").wrapMode, "none");
});
