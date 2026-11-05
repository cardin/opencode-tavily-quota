import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CLOCK_INTERVAL_MS,
  DEFAULT_REFRESH_INTERVAL_MS,
  MAX_TIMER_MS,
  MIN_REFRESH_INTERVAL_MS,
  createQuotaRefresher,
  resolveRefreshMs,
  type TimerHandle,
  type ViewState,
} from "../refresh.ts";
import type { QuotaSnapshot } from "../usage.ts";

function snapshot(remaining = 80): QuotaSnapshot {
  return {
    planName: "Researcher",
    used: 100 - remaining,
    limit: 100,
    remaining,
    percentRemaining: remaining,
    updatedAt: 1,
  };
}

function fakeTimers(): {
  setTimer: (callback: () => void, ms: number) => TimerHandle;
  clearTimer: (handle: TimerHandle) => void;
  fire: (ms: number) => void;
  active: () => number[];
} {
  let next = 0;
  const timers = new Map<number, { callback: () => void; ms: number }>();
  return {
    setTimer: (callback, ms) => {
      const id = ++next;
      timers.set(id, { callback, ms });
      return id as unknown as TimerHandle;
    },
    clearTimer: (handle) => {
      timers.delete(handle as unknown as number);
    },
    fire: (ms) => {
      for (const timer of [...timers.values()]) {
        if (timer.ms === ms) timer.callback();
      }
    },
    active: () => [...timers.values()].map((timer) => timer.ms),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve: (value) => resolve?.(value) };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a forced refresh during an in-flight request runs once more after it", async () => {
  const calls: boolean[] = [];
  const first = deferred<{ ok: boolean; snapshot?: QuotaSnapshot }>();
  const second = deferred<{ ok: boolean; snapshot?: QuotaSnapshot }>();
  let refresher!: ReturnType<typeof createQuotaRefresher>;
  refresher = createQuotaRefresher({
    refreshMs: DEFAULT_REFRESH_INTERVAL_MS,
    remote: ({ force }) => {
      calls.push(force);
      return calls.length === 1 ? first.promise : second.promise;
    },
  });

  const initial = refresher.refresh(false);
  await tick();
  assert.deepEqual(calls, [false]);

  const forced = refresher.refresh(true);
  await tick();
  // The forced request is queued, not dropped and not started in parallel.
  assert.deepEqual(calls, [false]);

  first.resolve({ ok: true, snapshot: snapshot(80) });
  await initial;
  await tick();
  assert.deepEqual(calls, [false, true]);

  second.resolve({ ok: true, snapshot: snapshot(10) });
  const state = await forced;
  assert.equal(state.status, "ready");
  if (state.status === "ready") assert.equal(state.snapshot.remaining, 10);
});

test("a non-forced refresh during an in-flight request does not queue work", async () => {
  const pending = deferred<{ ok: boolean; snapshot?: QuotaSnapshot }>();
  let calls = 0;
  const refresher = createQuotaRefresher({
    remote: () => {
      calls++;
      return pending.promise;
    },
  });

  const first = refresher.refresh(false);
  await tick();
  const second = await refresher.refresh(false);
  assert.equal(second, refresher.state());
  assert.equal(calls, 1);

  pending.resolve({ ok: true, snapshot: snapshot() });
  await first;
});

test("keeps the last snapshot as a warning on a transient failure", async () => {
  let result: { ok: boolean; message?: string; snapshot?: QuotaSnapshot } = {
    ok: true,
    snapshot: snapshot(80),
  };
  const refresher = createQuotaRefresher({ remote: async () => result });

  await refresher.refresh();
  assert.equal(refresher.state().status, "ready");

  result = { ok: false, message: "request failed: offline" };
  const failed = await refresher.refresh(true);
  assert.equal(failed.status, "ready");
  if (failed.status === "ready") {
    assert.equal(failed.snapshot.remaining, 80);
    assert.equal(failed.warning, "request failed: offline");
  }

  result = { ok: true, snapshot: snapshot(70) };
  const recovered = await refresher.refresh(true);
  assert.equal(recovered.status, "ready");
  if (recovered.status === "ready") {
    assert.equal(recovered.snapshot.remaining, 70);
    assert.equal(recovered.warning, undefined);
  }
});

test("uses a full error state only before any snapshot exists", async () => {
  const refresher = createQuotaRefresher({
    remote: async () => ({ ok: false, message: "no active Tavily connection" }),
  });
  const state = await refresher.refresh();
  assert.deepEqual(state, { status: "error", message: "no active Tavily connection" });
});

test("uses a server-supplied snapshot on a cold-start failure", async () => {
  const refresher = createQuotaRefresher({
    remote: async () => ({
      ok: false,
      message: "rate limited on /usage (retry in 5m)",
      snapshot: snapshot(40),
    }),
  });
  const state = await refresher.refresh();
  assert.equal(state.status, "ready");
  if (state.status === "ready") {
    assert.equal(state.snapshot.remaining, 40);
    assert.equal(state.warning, "rate limited on /usage (retry in 5m)");
  }
});

test("credential invalidation clears the snapshot, clears the remote cache, and forces a fetch", async () => {
  const seen: string[] = [];
  let invalidations = 0;
  let calls = 0;
  const refresher = createQuotaRefresher({
    remote: async ({ force }) => {
      calls++;
      seen.push(force ? "forced" : "automatic");
      return { ok: true, snapshot: snapshot(calls === 1 ? 80 : 10) };
    },
    invalidateRemote: async () => {
      invalidations++;
    },
  });

  await refresher.refresh();
  const invalidated = await refresher.invalidate();
  assert.equal(invalidations, 1);
  assert.deepEqual(seen, ["automatic", "forced"]);
  assert.equal(invalidated.status, "ready");
  if (invalidated.status === "ready") assert.equal(invalidated.snapshot.remaining, 10);
});

test("an in-flight result from before invalidation is ignored", async () => {
  const pending = deferred<{ ok: boolean; snapshot?: QuotaSnapshot }>();
  let calls = 0;
  const refresher = createQuotaRefresher({
    remote: async () => {
      calls++;
      if (calls === 1) return pending.promise;
      return { ok: true, snapshot: snapshot(10) };
    },
    invalidateRemote: async () => undefined,
  });

  const stale = refresher.refresh();
  await tick();
  const fresh = refresher.invalidate();
  assert.deepEqual(refresher.state(), { status: "loading" });
  pending.resolve({ ok: true, snapshot: snapshot(80) });
  await stale;
  const state = await fresh;
  assert.equal(state.status, "ready");
  if (state.status === "ready") assert.equal(state.snapshot.remaining, 10);
});

test("start schedules refresh and clock timers; dispose clears both", async () => {
  const timers = fakeTimers();
  let calls = 0;
  let clock = 0;
  const states: ViewState[] = [];
  const refresher = createQuotaRefresher({
    remote: async () => {
      calls++;
      return { ok: true, snapshot: snapshot() };
    },
    onState: (state) => states.push(state),
    onClock: (now) => {
      clock = now;
    },
    now: () => 42,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  refresher.start();
  assert.deepEqual(timers.active(), [DEFAULT_REFRESH_INTERVAL_MS, CLOCK_INTERVAL_MS]);
  await tick();
  assert.equal(calls, 1);
  assert.equal(states.at(-1)?.status, "ready");

  timers.fire(CLOCK_INTERVAL_MS);
  assert.equal(clock, 42);
  timers.fire(DEFAULT_REFRESH_INTERVAL_MS);
  await tick();
  assert.equal(calls, 2);

  refresher.dispose();
  assert.deepEqual(timers.active(), []);
  assert.equal(states.at(-1)?.status, "ready");
});

test("disposing while a request is in flight ignores its result", async () => {
  const pending = deferred<{ ok: boolean; snapshot?: QuotaSnapshot }>();
  const refresher = createQuotaRefresher({ remote: () => pending.promise });
  const running = refresher.refresh();
  await tick();
  refresher.dispose();
  pending.resolve({ ok: true, snapshot: snapshot() });
  await running;
  assert.deepEqual(refresher.state(), { status: "loading" });
});

test("refreshMs accepts only finite 60s..2^31-1 values", () => {
  assert.equal(resolveRefreshMs(undefined), DEFAULT_REFRESH_INTERVAL_MS);
  assert.equal(resolveRefreshMs(Number.NaN), DEFAULT_REFRESH_INTERVAL_MS);
  assert.equal(resolveRefreshMs(Number.POSITIVE_INFINITY), DEFAULT_REFRESH_INTERVAL_MS);
  assert.equal(resolveRefreshMs(1_000), DEFAULT_REFRESH_INTERVAL_MS);
  assert.equal(resolveRefreshMs(MAX_TIMER_MS + 1), DEFAULT_REFRESH_INTERVAL_MS);
  assert.equal(resolveRefreshMs(MIN_REFRESH_INTERVAL_MS), MIN_REFRESH_INTERVAL_MS);
  assert.equal(resolveRefreshMs(MAX_TIMER_MS), MAX_TIMER_MS);
});
