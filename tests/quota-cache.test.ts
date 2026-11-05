import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CACHE_STORAGE_KEY,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_MIN_INTERVAL_MS,
  createQuotaService,
  keyIdentity,
} from "../quota-cache.ts";
import type { QuotaResult, QuotaSnapshot } from "../usage.ts";

function memoryStorage(): {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  raw(): Map<string, unknown>;
} {
  const values = new Map<string, unknown>();
  return {
    get: async (key) => values.get(key),
    set: async (key, value) => {
      values.set(key, structuredClone(value));
    },
    remove: async (key) => {
      values.delete(key);
    },
    raw: () => values,
  };
}

function snapshot(remaining = 80): QuotaSnapshot {
  return {
    planName: "Researcher",
    used: 20,
    limit: 100,
    remaining,
    percentRemaining: remaining,
    updatedAt: 1,
  };
}

function success(value: QuotaSnapshot = snapshot()): QuotaResult {
  return { ok: true, snapshot: value };
}

test("quota cache serves a snapshot within the TTL and survives a service restart", async () => {
  const storage = memoryStorage();
  let now = 1_000;
  let calls = 0;
  const resolve = async () => ({
    ok: true as const,
    identity: keyIdentity("key-a"),
    fetch: async () => {
      calls++;
      return success();
    },
  });

  const first = createQuotaService({ resolve, storage, now: () => now });
  assert.deepEqual(await first.usage(), { ok: true, snapshot: snapshot() });
  assert.deepEqual(await first.usage(), { ok: true, snapshot: snapshot() });
  assert.equal(calls, 1);

  // A new service (TUI/server restart) reads the persisted entry.
  const restarted = createQuotaService({ resolve, storage, now: () => now });
  assert.deepEqual(await restarted.usage(), { ok: true, snapshot: snapshot() });
  assert.equal(calls, 1);

  // Past the TTL, the automatic read fetches again.
  now += DEFAULT_CACHE_TTL_MS;
  await restarted.usage();
  assert.equal(calls, 2);
});

test("force bypasses the cache but not the minimum request interval", async () => {
  const storage = memoryStorage();
  let now = 1_000;
  let calls = 0;
  const resolve = async () => ({
    ok: true as const,
    identity: keyIdentity("key-a"),
    fetch: async () => {
      calls++;
      return success(snapshot(80 - calls));
    },
  });
  const service = createQuotaService({ resolve, storage, now: () => now });

  await service.usage();
  // A second click within the interval reuses the snapshot instead of spending
  // another request; the endpoint allows only 10 per 10 minutes.
  const tooSoon = await service.usage(true);
  assert.equal(calls, 1);
  assert.equal(tooSoon.ok, true);

  now += DEFAULT_MIN_INTERVAL_MS;
  const forced = await service.usage(true);
  assert.equal(calls, 2);
  assert.equal(forced.ok, true);
  if (forced.ok) assert.equal(forced.snapshot?.remaining, 78);
  // The refreshed value is now the cached one.
  assert.deepEqual(await service.usage(), forced);
  assert.equal(calls, 2);
});

test("a 429 cooldown is persisted and survives a service restart, including manual refresh", async () => {
  const storage = memoryStorage();
  let now = 10_000;
  let calls = 0;
  const resolve = async () => ({
    ok: true as const,
    identity: keyIdentity("key-a"),
    fetch: async (): Promise<QuotaResult> => {
      calls++;
      return {
        ok: false,
        message: "rate limited on /usage (10 req / 10 min)",
        rateLimited: true,
        retryAfterMs: 120_000,
      };
    },
  });

  const first = createQuotaService({ resolve, storage, now: () => now });
  const limited = await first.usage();
  assert.equal(limited.ok, false);
  assert.equal(limited.retryAt, 130_000);
  assert.equal(calls, 1);

  now += 60_000;
  const restarted = createQuotaService({ resolve, storage, now: () => now });
  const waited = await restarted.usage();
  assert.equal(waited.ok, false);
  assert.match(waited.message ?? "", /rate limited .*retry in 1m/);
  assert.equal(calls, 1);

  // Manual refresh also waits out the cooldown; clicking during a 429 must not
  // spend another request or extend the penalty.
  const forced = await restarted.usage(true);
  assert.equal(forced.ok, false);
  assert.equal(calls, 1);

  // Once the cooldown expires, a manual refresh is allowed again.
  now = 130_000;
  await restarted.usage(true);
  assert.equal(calls, 2);
});

test("cache entries are scoped by credential identity", async () => {
  const storage = memoryStorage();
  let identity = keyIdentity("key-a");
  let calls = 0;
  const resolve = async () => ({
    ok: true as const,
    identity,
    fetch: async () => {
      calls++;
      return success(snapshot(calls === 1 ? 80 : 10));
    },
  });
  const service = createQuotaService({ resolve, storage, now: () => 1_000 });

  const first = await service.usage();
  assert.equal(first.ok, true);
  assert.ok(first.snapshot);
  assert.equal(first.snapshot.remaining, 80);

  identity = keyIdentity("key-b");
  const second = await service.usage();
  assert.equal(calls, 2);
  assert.equal(second.ok, true);
  assert.ok(second.snapshot);
  assert.equal(second.snapshot.remaining, 10);
});

test("a transient failure returns the last snapshot; no snapshot means a plain error", async () => {
  const storage = memoryStorage();
  let fail = false;
  const resolve = async () => ({
    ok: true as const,
    identity: keyIdentity("key-a"),
    fetch: async (): Promise<QuotaResult> =>
      fail
        ? { ok: false, message: "request failed: offline" }
        : success(),
  });
  const service = createQuotaService({ resolve, storage, now: () => 1_000 });

  await service.usage();
  fail = true;
  let now = 1_000 + DEFAULT_CACHE_TTL_MS + 1;
  const cached = createQuotaService({ resolve, storage, now: () => now }).usage();
  const failed = await cached;
  assert.equal(failed.ok, false);
  assert.equal(failed.snapshot?.remaining, 80);
  assert.equal(failed.message, "request failed: offline");

  const empty = createQuotaService({ resolve, storage: memoryStorage(), now: () => now });
  const noSnapshot = await empty.usage();
  assert.equal(noSnapshot.ok, false);
  assert.equal(noSnapshot.snapshot, undefined);
});

test("concurrent automatic reads share one network request", async () => {
  const storage = memoryStorage();
  let calls = 0;
  let release: ((result: QuotaResult) => void) | undefined;
  const resolve = async () => ({
    ok: true as const,
    identity: keyIdentity("key-a"),
    fetch: () =>
      new Promise<QuotaResult>((resolveFetch) => {
        calls++;
        release = resolveFetch;
      }),
  });
  const service = createQuotaService({ resolve, storage, now: () => 1_000 });

  const one = service.usage();
  const two = service.usage();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.ok(release);
  release(success());
  assert.deepEqual(await one, { ok: true, snapshot: snapshot() });
  assert.deepEqual(await two, { ok: true, snapshot: snapshot() });
  assert.equal(calls, 1);
});

test("invalidate expires freshness but preserves the request budget", async () => {
  const storage = memoryStorage();
  let calls = 0;
  const resolve = async () => ({
    ok: true as const,
    identity: keyIdentity("key-a"),
    fetch: async () => {
      calls++;
      return success();
    },
  });
  let now = 1_000;
  const service = createQuotaService({ resolve, storage, now: () => now });
  await service.usage();
  assert.ok(storage.raw().size > 0);
  await service.invalidate();
  await service.usage();
  assert.equal(calls, 1);
  now += DEFAULT_MIN_INTERVAL_MS;
  await service.usage();
  assert.equal(calls, 2);
});

test("storage failures do not break quota reads", async () => {
  let calls = 0;
  const broken = {
    get: async () => {
      throw new Error("disk");
    },
    set: async () => {
      throw new Error("disk");
    },
    remove: async () => {
      throw new Error("disk");
    },
  };
  const service = createQuotaService({
    resolve: async () => ({
      ok: true as const,
      identity: keyIdentity("key-a"),
      fetch: async () => {
        calls++;
        return success();
      },
    }),
    storage: broken,
    now: () => 1_000,
  });
  assert.equal((await service.usage()).ok, true);
  await service.invalidate();
  assert.equal((await service.usage()).ok, true);
  assert.equal(calls, 1, "the in-memory reservation must survive a custom storage failure");
});

test("many forced refreshes queued behind a request recheck the completed cache", async () => {
  const storage = memoryStorage();
  let calls = 0;
  let release!: (result: QuotaResult) => void;
  const service = createQuotaService({
    storage,
    now: () => 1_000,
    resolve: async () => ({
      ok: true,
      identity: keyIdentity("queued-key"),
      fetch: () => {
        calls++;
        return new Promise<QuotaResult>((resolve) => { release = resolve; });
      },
    }),
  });
  const first = service.usage();
  await new Promise((resolve) => setImmediate(resolve));
  const forced = Array.from({ length: 12 }, () => service.usage(true));
  release(success());
  const results = await Promise.all([first, ...forced]);
  assert.equal(calls, 1);
  assert.ok(results.every((result) => result.ok));
});

test("switching away from a key and invalidating cannot clear its 429 cooldown", async () => {
  const storage = memoryStorage();
  let key = "limited-key";
  let calls = 0;
  const service = createQuotaService({
    storage,
    now: () => 1_000,
    resolve: async () => ({
      ok: true,
      identity: keyIdentity(key),
      fetch: async () => {
        calls++;
        return key === "limited-key"
          ? { ok: false, message: "limited", rateLimited: true, retryAfterMs: 600_000 }
          : success();
      },
    }),
  });
  const first = await service.usage();
  key = "other-key";
  assert.equal((await service.usage()).ok, true);
  key = "limited-key";
  await service.invalidate();
  const again = await service.usage(true);
  assert.equal(again.ok, false);
  assert.equal(again.retryAt, first.retryAt);
  assert.equal(calls, 2);
});

test("a legacy server cache is migrated without spending another request", async () => {
  const storage = memoryStorage();
  const identity = keyIdentity("legacy-key");
  await storage.set(CACHE_STORAGE_KEY, { identity, snapshot: snapshot(), at: 1_000, retryAt: 600_000 });
  let calls = 0;
  const service = createQuotaService({
    storage, now: () => 2_000,
    resolve: async () => ({ ok: true, identity, fetch: async () => { calls++; return success(); } }),
  });
  const limited = await service.usage(true);
  assert.equal(limited.ok, false);
  assert.equal(limited.retryAt, 600_000);
  assert.equal(limited.snapshot?.remaining, 80);
  assert.equal(calls, 0);
});

test("a short 429 Retry-After still enforces 65 seconds between requests", async () => {
  let calls = 0;
  let now = 1_000;
  const service = createQuotaService({
    storage: memoryStorage(), now: () => now,
    resolve: async () => ({
      ok: true, identity: keyIdentity("short-backoff"),
      fetch: async () => { calls++; return { ok: false, message: "limited", rateLimited: true, retryAfterMs: 0 }; },
    }),
  });
  await service.usage();
  now += DEFAULT_MIN_INTERVAL_MS - 1;
  await service.usage(true);
  assert.equal(calls, 1);
  now++;
  await service.usage(true);
  assert.equal(calls, 2);
});

test("failed HTTP requests also reserve the interval and keep the last snapshot", async () => {
  let calls = 0;
  let now = 1_000;
  const storage = memoryStorage();
  const resolve = async () => ({
    ok: true as const, identity: keyIdentity("offline-key"),
    fetch: async (): Promise<QuotaResult> => {
      calls++;
      if (calls > 1) throw new Error("offline");
      return success();
    },
  });
  await createQuotaService({ storage, resolve, now: () => now }).usage();
  now += DEFAULT_CACHE_TTL_MS;
  const failed = await createQuotaService({ storage, resolve, now: () => now }).usage();
  assert.equal(failed.ok, false);
  assert.equal(failed.snapshot?.remaining, 80);
  const restarted = createQuotaService({ storage, resolve, now: () => now });
  assert.deepEqual(await restarted.usage(true), failed);
  assert.equal(calls, 2);
});

test("forced requests stay below ten reads in every rolling ten-minute window", async () => {
  let now = 1_000;
  let calls = 0;
  const sentAt: number[] = [];
  const service = createQuotaService({
    storage: memoryStorage(), now: () => now,
    resolve: async () => ({
      ok: true, identity: keyIdentity("rolling-window"),
      fetch: async () => { calls++; return success(); },
    }),
  });
  for (let second = 0; second < 1_200; second += 10) {
    const before = calls;
    await service.usage(true);
    if (calls > before) sentAt.push(second);
    assert.ok(sentAt.filter((at) => at > second - 600).length <= 10);
    now += 10_000;
  }
  assert.ok(calls > 10);
});
