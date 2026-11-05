/**
 * Pure display model for the Tavily quota sidebar.
 *
 * Keeps settings parsing, level classification, even-use math, and line
 * composition free of OpenTUI/OpenCode imports so they can be unit tested.
 */

import {
  formatPercent,
  nextMonthlyResetAt,
  type QuotaSnapshot,
} from "./usage";

/** Fallback content width; the live sidebar passes its measured width. */
export const SIDEBAR_WIDTH = 37;
/** Width reserved for `100%`, the longest percentage label. */
export const PERCENT_COLUMN_WIDTH = "100%".length;
/** Match opencode-quota's six-column right-aligned reset field. */
export const RESET_COLUMN_WIDTH = "4h 32m".length;
/** Gap between the bar and the percentage column. */
export const BAR_SEPARATOR = " ";
/** Gap between the percentage column and the countdown. */
export const RESET_SEPARATOR = " ";
/** A 25-cell bar ends with opencode-quota's five-column prefix + 20-cell bar. */
export const DEFAULT_BAR_WIDTH =
  SIDEBAR_WIDTH -
  BAR_SEPARATOR.length -
  PERCENT_COLUMN_WIDTH -
  RESET_SEPARATOR.length -
  RESET_COLUMN_WIDTH;

export const EVEN_USE_MARK = "┃";

export type QuotaLevel = "good" | "warning" | "low";
export type ColorRole = QuotaLevel | "muted" | "text";
export type SegmentRole = "fill" | "empty" | "percent" | "reset" | "mark" | "muted";

export interface LineSegment {
  text: string;
  role: SegmentRole;
}

export interface DisplayLine {
  segments: LineSegment[];
  wrapMode: "none" | "word";
  /** Level for the bar/percentage; undefined for non-quota lines. */
  level?: QuotaLevel;
}

export interface DisplaySettings {
  colors: {
    enabled: boolean;
    warningBelow: number;
    lowBelow: number;
  };
  evenUse: boolean;
}

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  colors: {
    enabled: true,
    warningBelow: 50,
    lowBelow: 20,
  },
  evenUse: false,
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function validThreshold(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

/**
 * Resolve the display options. Missing thresholds use their defaults; a
 * present but invalid threshold (or a low above warning) falls back to the
 * default pair. Non-boolean toggles use their defaults.
 */
export function resolveDisplaySettings(options: unknown): DisplaySettings {
  const root = asRecord(options);
  const colors = asRecord(root.colors);
  const enabled = typeof colors.enabled === "boolean" ? colors.enabled : true;
  const warningProvided = colors.warningBelow !== undefined;
  const lowProvided = colors.lowBelow !== undefined;

  let warningBelow = 50;
  let lowBelow = 20;
  if (
    (warningProvided || lowProvided) &&
    (!warningProvided || validThreshold(colors.warningBelow)) &&
    (!lowProvided || validThreshold(colors.lowBelow))
  ) {
    const warning = warningProvided ? (colors.warningBelow as number) : 50;
    const low = lowProvided ? (colors.lowBelow as number) : 20;
    if (low <= warning) {
      warningBelow = warning;
      lowBelow = low;
    }
  }

  return {
    colors: { enabled, warningBelow, lowBelow },
    evenUse: typeof root.evenUse === "boolean" ? root.evenUse : false,
  };
}

/** Whether `percentRemaining` is good, getting low, or nearly out. */
export function levelOf(
  percentRemaining: number,
  settings: DisplaySettings = DEFAULT_DISPLAY_SETTINGS,
): QuotaLevel {
  const label = formatPercent(percentRemaining);
  const displayed = Number(label.slice(0, -1));
  const value = Number.isFinite(displayed) ? Math.max(0, Math.min(100, displayed)) : 100;
  if (value < settings.colors.lowBelow) return "low";
  if (value < settings.colors.warningBelow) return "warning";
  return "good";
}

/** Map a segment to the theme role that colors it. */
export function colorRoleFor(
  segment: Pick<LineSegment, "role">,
  settings: DisplaySettings = DEFAULT_DISPLAY_SETTINGS,
  level: QuotaLevel = "good",
): ColorRole {
  if (segment.role === "mark") return settings.colors.enabled ? "text" : "muted";
  if (segment.role === "fill" || segment.role === "percent") {
    return settings.colors.enabled ? level : "muted";
  }
  return "muted";
}

type BarRole = "fill" | "empty" | "mark";

function groupBarCells(cells: Array<{ char: string; role: BarRole }>): LineSegment[] {
  const segments: LineSegment[] = [];
  for (const cell of cells) {
    const last = segments.at(-1);
    if (last && last.role === cell.role) last.text += cell.char;
    else segments.push({ text: cell.char, role: cell.role });
  }
  return segments;
}

/** Compose the bar as fill/empty segments, with an optional even-use mark. */
export function barSegments(
  percentRemaining: number,
  width: number,
  markerCell?: number,
): LineSegment[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const clamped = Math.max(0, Math.min(100, percentRemaining));
  const filled = Math.round((clamped / 100) * safeWidth);
  const marker =
    safeWidth >= 3 && markerCell !== undefined && Number.isFinite(markerCell)
      ? Math.max(0, Math.min(safeWidth - 1, Math.round(markerCell)))
      : undefined;

  const cells: Array<{ char: string; role: BarRole }> = [];
  for (let index = 0; index < safeWidth; index += 1) {
    if (index === marker) cells.push({ char: EVEN_USE_MARK, role: "mark" });
    else if (index < filled) cells.push({ char: "█", role: "fill" });
    else cells.push({ char: "░", role: "empty" });
  }
  return groupBarCells(cells);
}

export interface MonthlyWindow {
  start: number;
  end: number;
}

/** The half-open UTC calendar-month window containing `now`. */
export function monthlyWindow(now: number = Date.now()): MonthlyWindow | undefined {
  if (!Number.isFinite(now)) return undefined;
  const date = new Date(now);
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  return end > start ? { start, end } : undefined;
}

/** Even-use remaining percentage, or undefined for an invalid time. */
export function evenUsePercent(now: number = Date.now()): number | undefined {
  const window = monthlyWindow(now);
  if (!window) return undefined;
  const length = window.end - window.start;
  if (!(length > 0) || now < window.start || now >= window.end) return undefined;
  return ((window.end - now) / length) * 100;
}

/** The zero-based bar cell where even use would be, or undefined. */
export function evenUseCell(evenPercent: number | undefined, width: number): number | undefined {
  if (evenPercent === undefined || !Number.isFinite(evenPercent)) return undefined;
  const safeWidth = Math.max(1, Math.floor(width));
  if (safeWidth < 3) return undefined;
  const clamped = Math.max(0, Math.min(100, evenPercent));
  return Math.max(0, Math.min(safeWidth - 1, Math.round((clamped / 100) * safeWidth)));
}

/** Join a line's segments back into plain text. */
export function lineText(line: DisplayLine): string {
  return line.segments.map((segment) => segment.text).join("");
}

/** A muted, single-segment line for loading, errors, and warnings. */
export function textLine(text: string, wrapMode: "none" | "word" = "word"): DisplayLine {
  return {
    segments: [{ text, role: "muted" }],
    wrapMode,
  };
}

/**
 * Monthly reset countdown in at most five columns: `25.3d`, `23h`, `4h32m`,
 * or `59m`. Floor larger units rather than overstating the time left; keep a
 * sub-minute remainder visible as `1m`. The toast's verbose formatter is unchanged.
 */
export function formatCompactResetCountdown(resetAt: number, now: number = Date.now()): string {
  const diff = resetAt - now;
  if (!Number.isFinite(diff) || diff <= 0) return "0m";
  const minutes = Math.floor(diff / 60_000);
  if (minutes >= 24 * 60) return `${(Math.floor(minutes / 144) / 10).toFixed(1)}d`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 10) return `${hours}h`;
  const remainingMinutes = minutes % 60;
  if (hours > 0) return `${hours}h${remainingMinutes ? `${remainingMinutes}m` : ""}`;
  return `${Math.max(1, minutes)}m`;
}

/**
 * Compose the single quota line: bar, bare percentage, and reset countdown.
 * Fixed, right-aligned label columns leave a 25-cell bar at the default width,
 * lining its endpoint and percentage up with the adjacent quota section.
 */
export function formatQuotaLineSegments(
  snapshot: QuotaSnapshot,
  now: number = Date.now(),
  settings: DisplaySettings = DEFAULT_DISPLAY_SETTINGS,
  width: number = SIDEBAR_WIDTH,
): DisplayLine {
  const label = formatPercent(snapshot.percentRemaining);
  const level = levelOf(snapshot.percentRemaining, settings);
  const resetAt = nextMonthlyResetAt(now);
  const countdown = formatCompactResetCountdown(resetAt, now);
  const barWidth = Math.max(
    3,
    width -
      BAR_SEPARATOR.length -
      PERCENT_COLUMN_WIDTH -
      RESET_SEPARATOR.length -
      RESET_COLUMN_WIDTH,
  );
  const expected = settings.evenUse ? evenUsePercent(now) : undefined;
  const marker = expected === undefined ? undefined : evenUseCell(expected, barWidth);
  const percentPadding = " ".repeat(Math.max(0, PERCENT_COLUMN_WIDTH - label.length));
  const resetPadding = " ".repeat(Math.max(0, RESET_COLUMN_WIDTH - countdown.length));

  const segments: LineSegment[] = [
    ...barSegments(snapshot.percentRemaining, barWidth, marker),
    { text: BAR_SEPARATOR, role: "muted" },
    ...(percentPadding ? [{ text: percentPadding, role: "muted" as const }] : []),
    { text: label, role: "percent" },
    { text: RESET_SEPARATOR, role: "muted" },
    ...(resetPadding ? [{ text: resetPadding, role: "muted" as const }] : []),
    { text: countdown, role: "reset" },
  ];

  return { segments, wrapMode: "none", level };
}
