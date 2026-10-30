/** Shared quota reads for both the server RPC and CLI-local credentials. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import {
  DEFAULT_TIMEOUT_MS,
  fetchQuota,
  resolveApiKey,
  type FetchQuotaOptions,
  type QuotaResult,
} from "./usage";

export const CACHE_TTL_MS = 5 * 60_000;
// Slightly more than 60 seconds keeps even forced reads below 10 / 10 minutes.
export const MIN_REQUEST_INTERVAL_MS = 65_000;

export interface CachedQuotaOptions extends FetchQuotaOptions {
  /** Bypass a fresh snapshot, never the minimum interval or a 429 cooldown. */
  force?: boolean;
}

export type QuotaClient = (options?: CachedQuotaOptions) => Promise<QuotaResult>;

interface CacheEntry {
  version: 1;
  result: QuotaResult;
  freshUntil: number;
  nextRequestAt: number;
}

function cacheDirectory(): string {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "opencode-tavily-quota");
}

async function readCache(path: string): Promise<CacheEntry | undefined> {
  let entry: CacheEntry;
  try {
    entry = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (
    !entry || entry.version !== 1 || !Number.isFinite(entry.freshUntil) ||
    !Number.isFinite(entry.nextRequestAt) || !entry.result
  ) return;
  const result = entry.result;
  if (
    result.ok === false && typeof result.message === "string" &&
    (result.retryAt === undefined || Number.isFinite(result.retryAt))
  ) return entry;
  if (
    result.ok === true && result.snapshot && typeof result.snapshot.planName === "string" &&
    [result.snapshot.used, result.snapshot.limit, result.snapshot.remaining,
      result.snapshot.percentRemaining, result.snapshot.updatedAt].every(Number.isFinite)
  ) return entry;
}

async function writeCache(path: string, entry: CacheEntry): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(entry), { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

/**
 * In-flight promises coalesce calls in one client; an inter-process lock and
 * atomic cache writes coordinate all other instances, locations and terminals.
 * Only a SHA-256 key fingerprint and quota results are written, never the key.
 */
export function createQuotaClient(options: {
  directory?: string;
  now?: () => number;
} = {}): QuotaClient {
  const inFlight = new Map<string, Promise<QuotaResult>>();
  const now = options.now ?? Date.now;

  return async (request = {}) => {
    let key: string;
    try {
      key = resolveApiKey(request.env, request.apiKey, request);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    // Preserve credential errors without creating cache files or taking a lock.
    if (!key) return fetchQuota({ ...request, apiKey: "", env: {} });

    const directory = resolve(options.directory ?? cacheDirectory());
    const fingerprint = createHash("sha256").update(key).digest("hex");
    const path = join(directory, `${fingerprint}.json`);
    const pending = inFlight.get(path);
    if (pending) return pending;

    const run = async (): Promise<QuotaResult> => {
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        let compromised: Error | undefined;
        const release = await lockfile.lock(path, {
          realpath: false,
          stale: 60_000,
          update: 10_000,
          retries: {
            retries: Math.ceil(((request.timeoutMs ?? DEFAULT_TIMEOUT_MS) + 5_000) / 100),
            factor: 1,
            minTimeout: 100,
            maxTimeout: 100,
          },
          // A failed cache lock must never crash the OpenCode host.
          onCompromised: (error) => { compromised = error; },
        });
        try {
          const cached = await readCache(path);
          if (cached && (now() < cached.nextRequestAt || (!request.force && now() < cached.freshUntil))) {
            return cached.result;
          }
          if (compromised) throw compromised;

          // Reserve the interval before sending: a process exit after the HTTP
          // request must not let a new process immediately spend another read.
          const reservedUntil = now() + MIN_REQUEST_INTERVAL_MS;
          await writeCache(path, {
            version: 1,
            result: { ok: false, message: "quota refresh interrupted; retry shortly" },
            freshUntil: reservedUntil,
            nextRequestAt: reservedUntil,
          });
          if (compromised) throw compromised;
          const fetched = await fetchQuota({ ...request, apiKey: key, env: {}, now: request.now ?? now });
          // Fetch implementations can include header values in error messages;
          // do not persist or return our credential if that happens.
          const result = fetched.ok
            ? fetched
            : { ...fetched, message: fetched.message.replaceAll(key, "[redacted]") };
          if (compromised) throw compromised;
          const completedAt = now();
          const nextRequestAt = Math.max(
            completedAt + MIN_REQUEST_INTERVAL_MS,
            result.ok ? 0 : result.retryAt ?? 0,
          );
          await writeCache(path, {
            version: 1,
            result,
            freshUntil: result.ok ? completedAt + CACHE_TTL_MS : nextRequestAt,
            nextRequestAt,
          });
          return result;
        } finally {
          await release().catch(() => undefined);
        }
      } catch (error) {
        // Fail closed: bypassing an unavailable cache/lock would cause the very
        // request stampede this client is meant to prevent.
        return {
          ok: false,
          message: `quota cache unavailable: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    };

    const promise = run();
    inFlight.set(path, promise);
    try {
      return await promise;
    } finally {
      inFlight.delete(path);
    }
  };
}

export const fetchCachedQuota = createQuotaClient();

/** Prefer CLI credentials; ask the server only when the CLI has no key. */
export async function fetchQuotaWithFallback(
  options: CachedQuotaOptions & { remote: () => Promise<QuotaResult>; client?: QuotaClient },
): Promise<QuotaResult> {
  const { remote, client = fetchCachedQuota, ...request } = options;
  try {
    const key = resolveApiKey(request.env, request.apiKey, request);
    if (key) return client({ ...request, apiKey: key, env: {} });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  try {
    return await remote();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `OpenCode Tavily credential unavailable: ${reason}` };
  }
}
