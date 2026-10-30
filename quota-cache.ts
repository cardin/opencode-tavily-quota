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
 * Pure policy with injected storage, clock, and remote call; no OpenCode or
 * TUI imports so the behaviour is unit-testable.
 */

import { createHash } from "node:crypto";

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
}

interface CacheEntry {
  identity: string;
  snapshot?: QuotaSnapshot;
  /** When `snapshot` was fetched. */
  at: number;
  /** No automatic reads before this time; `0` when not rate limited. */
  retryAt: number;
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

/** Validate a stored entry before trusting it. */
function readEntry(value: unknown): CacheEntry | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.identity !== "string") return null;
  if (typeof entry.at !== "number" || !Number.isFinite(entry.at)) return null;
  if (typeof entry.retryAt !== "number" || !Number.isFinite(entry.retryAt)) return null;
  const snapshot = entry.snapshot;
  if (snapshot === undefined || snapshot === null) {
    return { identity: entry.identity, at: entry.at, retryAt: entry.retryAt };
  }
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const value2 = snapshot as Record<string, unknown>;
  if (
    typeof value2.planName !== "string" ||
    typeof value2.used !== "number" ||
    typeof value2.limit !== "number" ||
    typeof value2.remaining !== "number" ||
    typeof value2.percentRemaining !== "number" ||
    typeof value2.updatedAt !== "number"
  ) {
    return null;
  }
  return {
    identity: entry.identity,
    at: entry.at,
    retryAt: entry.retryAt,
    snapshot: {
      planName: value2.planName,
      used: value2.used,
      limit: value2.limit,
      remaining: value2.remaining,
      percentRemaining: value2.percentRemaining,
      updatedAt: value2.updatedAt,
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

  let inFlight: { identity: string; promise: Promise<QuotaResponse> } | null = null;

  const read = async (): Promise<CacheEntry | null> => {
    try {
      return readEntry(await storage.get(CACHE_STORAGE_KEY));
    } catch {
      // A broken cache must not break quota reads.
      return null;
    }
  };

  const write = async (entry: CacheEntry): Promise<void> => {
    const value = entry.snapshot
      ? { identity: entry.identity, snapshot: entry.snapshot, at: entry.at, retryAt: entry.retryAt }
      : { identity: entry.identity, at: entry.at, retryAt: entry.retryAt };
    try {
      await storage.set(CACHE_STORAGE_KEY, value);
    } catch {
      // Best effort: the next request simply fetches again.
    }
  };

  const usage = async (force = false): Promise<QuotaResponse> => {
    const resolution = await options.resolve();
    if (!resolution.ok) return { ok: false, message: resolution.message };

    if (inFlight?.identity === resolution.identity) {
      if (!force) return inFlight.promise;
      // A forced refresh waits for the request already in flight, then reads
      // again instead of silently returning the stale result.
      await inFlight.promise.catch(() => undefined);
    }

    const at = now();
    const cached = await read();
    const entry = cached?.identity === resolution.identity ? cached : null;
    if (entry) {
      // Even a manual refresh must not spend another request while Tavily has
      // told us to wait; otherwise a click during a 429 extends the cooldown.
      if (entry.retryAt > at) {
        return {
          ok: false,
          message: cooldownMessage(entry.retryAt - at),
          snapshot: entry.snapshot,
          retryAt: entry.retryAt,
        };
      }
      if (entry.snapshot) {
        const age = at - entry.at;
        if (age < cacheTtlMs && !force) return { ok: true, snapshot: entry.snapshot };
        if (age < minIntervalMs) return { ok: true, snapshot: entry.snapshot };
      }
    }

    // The cache read above is asynchronous, so another request may have
    // started while this one was reading. Join it now to keep one network call.
    if (inFlight?.identity === resolution.identity) {
      if (!force) return inFlight.promise;
      await inFlight.promise.catch(() => undefined);
    }

    const request = (async (): Promise<QuotaResponse> => {
      const result = await resolution.fetch();
      if (result.ok) {
        const snapshot = result.snapshot;
        await write({ identity: resolution.identity, snapshot, at: now(), retryAt: 0 });
        return { ok: true, snapshot };
      }
      if (result.rateLimited) {
        const retryAt = now() + Math.max(result.retryAfterMs ?? backoffMs, 0);
        const snapshot = entry?.snapshot;
        await write({ identity: resolution.identity, snapshot, at: entry?.at ?? 0, retryAt });
        return {
          ok: false,
          message: cooldownMessage(retryAt - now()),
          snapshot,
          retryAt,
        };
      }
      return { ok: false, message: result.message, snapshot: entry?.snapshot };
    })();

    inFlight = { identity: resolution.identity, promise: request };
    try {
      return await request;
    } finally {
      if (inFlight?.promise === request) inFlight = null;
    }
  };

  return {
    usage,
    async invalidate() {
      try {
        await storage.remove(CACHE_STORAGE_KEY);
      } catch {
        // Best effort; a new fetch overwrites the entry anyway.
      }
    },
  };
}
