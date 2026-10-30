import assert from "node:assert/strict";
import { test } from "node:test";

import { SIDEBAR_WIDTH, type QuotaSnapshot } from "./usage.ts";
import { buildLines, PLUGIN_ID, TavilyQuotaTuiPlugin } from "./tui.tsx";
import type { ViewState } from "./refresh.ts";

const snapshot: QuotaSnapshot = {
  planName: "Researcher",
  used: 161,
  limit: 1000,
  remaining: 839,
  percentRemaining: 83.9,
  updatedAt: 0,
};

test("the TUI module imports without a renderer and exposes its plugin", () => {
  assert.equal(PLUGIN_ID, "opencode-tavily-quota");
  assert.equal(TavilyQuotaTuiPlugin.id, PLUGIN_ID);
});

test("buildLines renders loading, errors, and the quota section", () => {
  const now = Date.UTC(2026, 8, 24, 12, 0);
  assert.deepEqual(buildLines({ status: "loading" }, now), ["loading…"]);
  assert.deepEqual(buildLines({ status: "error", message: "boom" }, now), ["⚠ boom"]);

  const ready = buildLines({ status: "ready", snapshot }, now);
  assert.equal(ready.length, 2);
  assert.equal(ready[0], "resets in 6d 12h");
  assert.equal(ready[1].length, SIDEBAR_WIDTH);
});

test("buildLines keeps the snapshot and adds a warning line on a transient failure", () => {
  const state: ViewState = {
    status: "ready",
    snapshot,
    warning: "request failed: offline",
  };
  const lines = buildLines(state, Date.UTC(2026, 8, 24, 12, 0));
  assert.equal(lines.length, 3);
  assert.equal(lines[2], "⚠ request failed: offline");
  assert.equal(lines[1].length, SIDEBAR_WIDTH);
});
