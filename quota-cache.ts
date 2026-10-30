/**
 * Server-side quota cache and rate-limit backoff.
 *
 * The Tavily `/usage` endpoint allows 10 requests per 10 minutes across the
 * whole account, so the cache lives with the OpenCode server rather than in a
 * TUI process: every TUI instance (and every TUI restart) shares the same
 * snapshot and the same cooldown. Cache entries are scoped by a hash of the
 * resolved API key, so switching credentials cannot show another account's
 * credits.
 *
 * One cache protocol with injected storage, clock, and remote call. Production
 * storage mirrors the entries in ctx.storage and uses a shared, locked file per
 * identity so separate OpenCode servers on the same machine coordinate too.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";

import type { QuotaResult, QuotaSnapshot } from "./usage";

export const CACHE_STORAGE_KEY = "quota-cache";
export const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
export const DEFAULT_RATE_LIMIT_BACKOFF_MS = 10 * 60_000;
/**
 * A forced refresh may skip the five-minute cache, but never the endpoint's
 * 10-requests-per-10-minutes budget. 65 seconds leaves a little headroom even
 * when every request is a manual one.
 */
export const DEFAULT_MIN_INTERVAL_MS = 65_000;

/** Result of resolving the active credential, ready for a quota request. */
export type QuotaResolution =
  | { ok: true; identity: string; fetch: () => Promise<QuotaResult> }
  | { ok: false; message: string };

/** The JSON shape returned over RPC (and consumed by the TUI). */
export interface QuotaResponse {
  ok: boolean;
  message?: string;
  snapshot?: QuotaSnapshot;
  retryAt?: number;
}

/** Durable key/value storage, structurally compatible with `ctx.storage`. */
export interface QuotaStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  /** Serialize the entire read/check/reserve/fetch/write transaction. */
  withLock?<T>(key: string, run: () => Promise<T>): Promise<T>;
}

interface CacheEntry {
  identity: string;
  snapshot?: QuotaSnapshot;
  /** When `snapshot` was fetched. */
  at: number;
  /** No reads before this time, including forced ones; `0` when not limited. */
  retryAt: number;
  /** Minimum interval, including failed or interrupted HTTP requests. */
  nextRequestAt?: number;
  message?: string;
}

export interface QuotaServiceOptions {
  resolve: () => Promise<QuotaResolution>;
  storage: QuotaStorage;
  now?: () => number;
  cacheTtlMs?: number;
  backoffMs?: number;
  minIntervalMs?: number;
}

export interface QuotaService {
  usage(force?: boolean): Promise<QuotaResponse>;
  invalidate(): Promise<void>;
}

/** Stable, non-reversible cache identity for an API key. */
export function keyIdentity(key: string): string {
  return `sha256:${createHash("sha256").update(key).digest("hex")}`;
}

/**
 * The same cache entries, shared across processes and mirrored in ctx.storage.
 * The file is authoritative: a failed lock/write never permits an HTTP read.
 * Only hashed identities and quota data are stored, never credentials.
 */
export function createSharedQuotaStorage(
  backing: QuotaStorage,
  directory = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "opencode-tavily-quota"),
): QuotaStorage {
  const root = resolve(directory);
  const leases = new Map<string, { error?: Error }>();
  const pathFor = (key: string) => join(root, `${createHash("sha256").update(key).digest("hex")}.json`);
  const assertOwned = (key: string) => {
    const error = leases.get(key)?.error;
    if (error) throw error;
  };
  const persist = async (key: string, value: unknown) => {
    assertOwned(key);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const path = pathFor(key);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
      assertOwned(key);
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  };
  return {
    async get(key) {
      assertOwned(key);
      if (key === CACHE_STORAGE_KEY) return backing.get(key).catch(() => undefined);
      try {
        const value: unknown = JSON.parse(await readFile(pathFor(key), "utf8"));
        if (readEntry(value)) return value;
      } catch (error) {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      // Migrate an existing server entry only while its transaction is locked.
      const value = await backing.get(key).catch(() => undefined);
      if (value !== undefined) await persist(key, value);
      return value;
    },
    async set(key, value) {
      await persist(key, value);
      await backing.set(key, JSON.parse(JSON.stringify(value))).catch(() => undefined);
    },
    async remove(key) {
      assertOwned(key);
      await unlink(pathFor(key)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      await backing.remove(key).catch(() => undefined);
    },
    async withLock(key, run) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const lease: { error?: Error } = {};
      const release = await lockfile.lock(pathFor(key), {
        realpath: false,
        stale: 60_000,
        update: 10_000,
        retries: { retries: 200, factor: 1, minTimeout: 100, maxTimeout: 100 },
        onCompromised: (error) => { lease.error = error; },
      });
      leases.set(key, lease);
      try {
        assertOwned(key);
        const result = await run();
        assertOwned(key);
        return result;
      } finally {
        if (leases.get(key) === lease) leases.delete(key);
        await release().catch(() => undefined);
      }
    },
  };
}

// In-memory test/custom stores also serialize independent service instances.
const storageLocks = new WeakMap<QuotaStorage, Map<string, Promise<unknown>>>();
async function withStorageLock<T>(storage: QuotaStorage, key: string, run: () => Promise<T>): Promise<T> {
  if (storage.withLock) return storage.withLock(key, run);
  let locks = storageLocks.get(storage);
  if (!locks) storageLocks.set(storage, locks = new Map());
  const previous = locks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(run);
  locks.set(key, current);
  try {
    return await current;
  } finally {
    if (locks.get(key) === current) locks.delete(key);
  }
}

/** Validate a stored entry before trusting it. */
function readEntry(value: unknown): CacheEntry | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.identity !== "string") return null;
  if (typeof entry.at !== "number" || !Number.isFinite(entry.at)) return null;
  if (typeof entry.retryAt !== "number" || !Number.isFinite(entry.retryAt)) return null;
  if (entry.nextRequestAt !== undefined &&
      (typeof entry.nextRequestAt !== "number" || !Number.isFinite(entry.nextRequestAt))) return null;
  if (entry.message !== undefined && typeof entry.message !== "string") return null;
  const base = {
    identity: entry.identity,
    at: entry.at,
    retryAt: entry.retryAt,
    nextRequestAt: entry.nextRequestAt as number | undefined,
    message: entry.message as string | undefined,
  };
  const snapshot = entry.snapshot;
  if (snapshot === undefined || snapshot === null) {
    return base;
  }
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const value2 = snapshot as Record<string, unknown>;
  if (
    typeof value2.planName !== "string" ||
    ![value2.used, value2.limit, value2.remaining, value2.percentRemaining, value2.updatedAt].every(Number.isFinite)
  ) {
    return null;
  }
  return {
    ...base,
    snapshot: {
      planName: value2.planName,
      used: value2.used as number,
      limit: value2.limit as number,
      remaining: value2.remaining as number,
      percentRemaining: value2.percentRemaining as number,
      updatedAt: value2.updatedAt as number,
    },
  };
}

function cooldownMessage(remainingMs: number): string {
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  return `rate limited on /usage (retry in ${minutes}m)`;
}

/**
 * Create the per-server quota service.
 *
 * `force` bypasses the fresh-cache TTL (manual refresh) but never an active
 * 429 cooldown or the minimum request interval; automatic reads honour all
 * three. A 429 persists `retryAt` so a restarted TUI or another TUI instance
 * waits too. Concurrent requests for the same identity share one network call.
 */
export function createQuotaService(options: QuotaServiceOptions): QuotaService {
  const now = options.now ?? (() => Date.now());
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const backoffMs = options.backoffMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS;
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const storage = options.storage;

  const inFlight = new Map<string, Promise<QuotaResponse>>();
  const memory = new Map<string, CacheEntry>();
  const storageKey = (identity: string) => `${CACHE_STORAGE_KEY}/${identity}`;

  const write = async (entry: CacheEntry): Promise<void> => {
    memory.set(entry.identity, entry);
    try {
      await storage.set(storageKey(entry.identity), entry);
    } catch (error) {
      // Shared-file storage must fail closed; a custom non-durable store can
      // still enforce the interval using this service's in-memory entry.
      if (storage.withLock) throw error;
    }
  };
  const read = async (identity: string): Promise<CacheEntry | null> => {
    try {
      const value = readEntry(await storage.get(storageKey(identity)));
      if (value?.identity === identity) return value;
      // Preserve the existing ctx.storage snapshot/cooldown when upgrading.
      const legacy = readEntry(await storage.get(CACHE_STORAGE_KEY));
      if (legacy?.identity === identity) {
        await write(legacy);
        return legacy;
      }
    } catch (error) {
      if (storage.withLock) throw error;
    }
    return memory.get(identity) ?? null;
  };

  const perform = async (resolution: Extract<QuotaResolution, { ok: true }>, force: boolean): Promise<QuotaResponse> => {
    const entry = await read(resolution.identity);
    const at = now();
    if (entry) {
      if (entry.retryAt > at) {
        return { ok: false, message: cooldownMessage(entry.retryAt - at), snapshot: entry.snapshot, retryAt: entry.retryAt };
      }
      if ((entry.nextRequestAt ?? entry.at + minIntervalMs) > at) {
        return entry.message || !entry.snapshot
          ? { ok: false, message: entry.message ?? "quota refresh interrupted; retry shortly", snapshot: entry.snapshot }
          : { ok: true, snapshot: entry.snapshot };
      }
      if (entry.snapshot && !force && at - entry.at < cacheTtlMs) return { ok: true, snapshot: entry.snapshot };
    }

    // Persist the reservation before HTTP, including when a process exits while
    // receiving the response. Restarts and credential events cannot bypass it.
    await write({
      identity: resolution.identity,
      snapshot: entry?.snapshot,
      at: entry?.at ?? 0,
      retryAt: 0,
      nextRequestAt: at + minIntervalMs,
      message: "quota refresh interrupted; retry shortly",
    });
    let result: QuotaResult;
    try {
      result = await resolution.fetch();
    } catch (error) {
      result = { ok: false, message: `request failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    const completedAt = now();
    const nextRequestAt = completedAt + minIntervalMs;
    if (result.ok) {
      await write({ identity: resolution.identity, snapshot: result.snapshot, at: completedAt, retryAt: 0, nextRequestAt });
      return { ok: true, snapshot: result.snapshot };
    }
    const retryAfterMs = typeof result.retryAfterMs === "number" && Number.isFinite(result.retryAfterMs)
      ? result.retryAfterMs
      : backoffMs;
    const retryAt = result.rateLimited
      ? completedAt + Math.max(minIntervalMs, retryAfterMs)
      : 0;
    const message = result.rateLimited ? cooldownMessage(retryAt - completedAt) : result.message;
    await write({ identity: resolution.identity, snapshot: entry?.snapshot, at: entry?.at ?? 0, retryAt, nextRequestAt, message });
    return result.rateLimited
      ? { ok: false, message, snapshot: entry?.snapshot, retryAt }
      : { ok: false, message, snapshot: entry?.snapshot };
  };

  return {
    async usage(force = false) {
      const resolution = await options.resolve();
      if (!resolution.ok) return { ok: false, message: resolution.message };
      const pending = inFlight.get(resolution.identity);
      if (pending) {
        if (!force) return pending;
        await pending;
      }
      const request = withStorageLock(storage, storageKey(resolution.identity), () => perform(resolution, force))
        .catch((error): QuotaResponse => ({
          ok: false,
          message: `quota cache unavailable: ${error instanceof Error ? error.message : String(error)}`,
        }));
      inFlight.set(resolution.identity, request);
      try {
        return await request;
      } finally {
        if (inFlight.get(resolution.identity) === request) inFlight.delete(resolution.identity);
      }
    },
    async invalidate() {
      const resolution = await options.resolve();
      if (!resolution.ok) return;
      await withStorageLock(storage, storageKey(resolution.identity), async () => {
        const entry = await read(resolution.identity);
        if (!entry) return;
        // Invalidate freshness, never the per-key budget or a 429 cooldown.
        await write({
          ...entry,
          at: Math.min(entry.at, now() - cacheTtlMs),
          nextRequestAt: entry.nextRequestAt ?? entry.at + minIntervalMs,
        });
      });
    },
  };
}
