import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SIDEBAR_WIDTH,
  lineText,
  resolveDisplaySettings,
} from "../display.ts";
import type { QuotaSnapshot } from "../usage.ts";
import { buildLines, PLUGIN_ID, TavilyQuotaTuiPlugin } from "../tui.tsx";
import type { ViewState } from "../refresh.ts";

const snapshot: QuotaSnapshot = {
  planName: "Researcher",
  used: 161,
  limit: 1000,
  remaining: 839,
  percentRemaining: 83.9,
  updatedAt: 0,
};

const now = Date.UTC(2026, 8, 24, 12, 0);

test("the TUI module imports without a renderer and exposes its plugin", () => {
  assert.equal(PLUGIN_ID, "opencode-tavily-quota");
  assert.equal(TavilyQuotaTuiPlugin.id, PLUGIN_ID);
});

test("buildLines renders loading, errors, and the one-line quota section", () => {
  assert.equal(lineText(buildLines({ status: "loading" }, now)[0]), "loading…");
  assert.equal(lineText(buildLines({ status: "error", message: "boom" }, now)[0]), "⚠ boom");

  const ready = buildLines({ status: "ready", snapshot }, now);
  assert.equal(ready.length, 1);
  const text = lineText(ready[0]);
  assert.equal(text.length, SIDEBAR_WIDTH);
  assert.match(text, /84%/);
  assert.match(text, /6\.5d/);
  assert.equal(text.includes("left"), false);
  assert.equal(ready[0].level, "good");
  assert.ok(ready[0].segments.some((segment) => segment.role === "fill"));
  assert.ok(ready[0].segments.some((segment) => segment.role === "percent"));
});

test("buildLines keeps the snapshot and adds a warning line on a transient failure", () => {
  const state: ViewState = {
    status: "ready",
    snapshot,
    warning: "request failed: offline",
  };
  const lines = buildLines(state, now);
  assert.equal(lines.length, 2);
  assert.equal(lineText(lines[0]).length, SIDEBAR_WIDTH);
  assert.equal(lineText(lines[1]), "⚠ request failed: offline");
});

test("buildLines uses the available sidebar width and right-aligns the reset", () => {
  for (const width of [36, 37, 40]) {
    const [line] = buildLines({ status: "ready", snapshot }, now, undefined, width);
    const text = lineText(line);
    assert.equal(text.length, width);
    assert.ok(text.endsWith("6.5d"));
    assert.equal(text.trimEnd().length, width);
  }
});

test("buildLines shows the mark by default and hides it when evenUse is false", () => {
  const on = resolveDisplaySettings({});
  const off = resolveDisplaySettings({ evenUse: false });
  const withMark = buildLines({ status: "ready", snapshot }, now, on);
  const withoutMark = buildLines({ status: "ready", snapshot }, now, off);

  assert.equal(withMark[0].segments.find((segment) => segment.role === "mark")?.text, "┃");
  assert.equal(withoutMark[0].segments.some((segment) => segment.role === "mark"), false);
  assert.equal(
    withMark[0].segments.find((segment) => segment.role === "percent")?.text,
    withoutMark[0].segments.find((segment) => segment.role === "percent")?.text,
  );
});

test("buildLines keeps the mark when colors are disabled", () => {
  const settings = resolveDisplaySettings({
    evenUse: true,
    colors: { enabled: false },
  });
  const lines = buildLines({ status: "ready", snapshot }, now, settings);
  assert.equal(lines[0].segments.find((segment) => segment.role === "mark")?.text, "┃");
});

test("changing display settings does not mutate the quota snapshot", () => {
  const state: ViewState = { status: "ready", snapshot: { ...snapshot } };
  const before = structuredClone(state.snapshot);
  const colored = buildLines(state, now, resolveDisplaySettings({ evenUse: true }));
  const monochrome = buildLines(
    state,
    now,
    resolveDisplaySettings({ evenUse: false, colors: { enabled: false } }),
  );

  assert.deepEqual(state.snapshot, before);
  assert.equal(state.snapshot.updatedAt, before.updatedAt);
  assert.equal(
    colored[0].segments.find((segment) => segment.role === "percent")?.text,
    monochrome[0].segments.find((segment) => segment.role === "percent")?.text,
  );
});
