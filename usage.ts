/**
 * Tavily quota client for the sidebar plugin.
 *
 * Pure formatting/derivation helpers are split from the single network call so
 * they can be unit tested without touching the network, real credentials, or
 * the OpenCode runtime. Node builtins only; no OpenCode or OpenTUI imports.
 *
 * The `apiKey` plugin option may be a literal key or an `{env:NAME}` /
 * `{file:PATH}` reference. OpenCode expands those references in
 * `opencode.json(c)` but not in `cli.json`, so this module expands them itself.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const USAGE_URL = "https://api.tavily.com/usage";
export const DEFAULT_TIMEOUT_MS = 15_000;

/** Shape of `GET https://api.tavily.com/usage` (all fields optional). */
export interface TavilyUsagePayload {
  key?: {
    usage?: number | null;
    limit?: number | null;
  } | null;
  account?: {
    current_plan?: string | null;
    plan_usage?: number | null;
    plan_limit?: number | null;
    paygo_usage?: number | null;
    paygo_limit?: number | null;
  } | null;
}

export interface QuotaSnapshot {
  /** Plan name reported by Tavily, e.g. `Researcher`. */
  planName: string;
  /** Credits consumed this billing cycle. */
  used: number;
  /** Credits included this billing cycle. */
  limit: number;
  /** Credits still available (`limit - used`, never negative). */
  remaining: number;
  /** `remaining / limit` as a percentage in `[0, 100]`. */
  percentRemaining: number;
  /** Milliseconds since epoch when the snapshot was produced. */
  updatedAt: number;
}

export type QuotaResult =
  | { ok: true; snapshot: QuotaSnapshot }
  | { ok: false; message: string; rateLimited?: boolean; retryAfterMs?: number };

export interface FetchQuotaOptions {
  /** Environment to read `TAVILY_API_KEY` from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Key supplied as a plugin option (e.g. from `cli.json`). */
  apiKey?: string;
  /** File reader for `{file:...}` references in `apiKey`. Injected by tests. */
  readFile?: (path: string) => string;
  /** Home directory for `~/` in `{file:...}`. Injected by tests. */
  home?: string;
  /** Base directory for relative `{file:...}` paths. Injected by tests. */
  cwd?: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** Injectable fetch, used by tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable clock, used by tests. Defaults to `Date.now`. */
  now?: number | (() => number);
}

/** Prefer CLI credentials; ask the server only when the CLI has no key. */
export async function fetchQuotaWithFallback(
  options: FetchQuotaOptions & { remote: () => Promise<QuotaResult> },
): Promise<QuotaResult> {
  let key: string;
  try {
    key = resolveApiKey(options.env, options.apiKey, options);
  } catch (error) {
    // A `{file:...}` option can point at a missing or unreadable file; surface
    // that inline instead of reading the same reference a second time.
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  if (key) return fetchQuota({ ...options, apiKey: key, env: {} });
  try {
    return await options.remote();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `OpenCode Tavily credential unavailable: ${reason}` };
  }
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A finite, strictly positive limit, or `0` when the field is absent/unusable. */
function positive(value: unknown): number {
  const parsed = finite(value);
  return parsed !== null && parsed > 0 ? parsed : 0;
}

/** Read a JSON object field without trusting the payload shape. */
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Parse a `Retry-After` header (delta-seconds or an HTTP date) into
 * milliseconds. Returns `undefined` when the header is absent or malformed.
 */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  const raw = (value ?? "").trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isSafeInteger(seconds) ? seconds * 1000 : undefined;
  }
  // Date.parse accepts strings like "-1" as dates, but these are invalid
  // Retry-After values rather than permission to retry immediately.
  if (/^[+-]?[\d.]+$/.test(raw)) return undefined;
  const date = Date.parse(raw);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - now);
}

/**
 * `{env:NAME}` and `{file:PATH}` references accepted in the `apiKey` option.
 * This mirrors the references OpenCode expands in `opencode.json(c)`, but the
 * expansion lives here because `cli.json` passes plugin options through
 * verbatim.
 */
export interface ExpandOptions {
  /** Environment used by `{env:NAME}`. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Reads a file as UTF-8. Defaults to `readFileSync`. Injected by tests. */
  readFile?: (path: string) => string;
  /** Home directory for `~/`. Defaults to `os.homedir()`. */
  home?: string;
  /** Base directory for relative paths. Defaults to `process.cwd()`. */
  cwd?: string;
}

const OPTION_REFERENCE = /\{(env|file):([^}]+)\}/g;

/**
 * Expand every `{env:NAME}` and `{file:PATH}` reference in a plugin option.
 *
 * `{env:NAME}` reads an environment variable (empty string when unset).
 * `{file:PATH}` reads a file's trimmed contents; `~/` expands to the home
 * directory and relative paths resolve against `cwd`. Unreadable files throw
 * with the offending reference and resolved path.
 */
export function expandOptionValue(value: string, options: ExpandOptions = {}): string {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const home = options.home ?? homedir();
  const cwd = options.cwd ?? process.cwd();

  return value.replace(OPTION_REFERENCE, (match, kind: string, body: string) => {
    if (kind === "env") return env[body] ?? "";

    const raw = body.trim();
    const path =
      raw === "~"
        ? home
        : raw.startsWith("~/")
          ? join(home, raw.slice(2))
          : isAbsolute(raw)
            ? raw
            : resolve(cwd, raw);
    try {
      return readFile(path).trim();
    } catch (cause) {
      throw new Error(`bad file reference: "${match}" (${path}) could not be read`, { cause });
    }
  });
}

/**
 * Resolve the Tavily API key: `TAVILY_API_KEY` first, then the `apiKey` plugin
 * option configured in `cli.json`. Reference values such as
 * `{file:~/.secrets/tavily-api-key}` are expanded here (see
 * `expandOptionValue`), since `cli.json` does not expand them itself. Never
 * logs or returns the key beyond the caller.
 */
export function resolveApiKey(
  env: Record<string, string | undefined> = process.env,
  apiKey?: string,
  options: Omit<ExpandOptions, "env"> = {},
): string {
  const fromEnv = (env.TAVILY_API_KEY ?? "").trim();
  if (fromEnv) return fromEnv;
  const raw = (apiKey ?? "").trim();
  if (!raw) return "";
  return expandOptionValue(raw, { ...options, env }).trim();
}

/**
 * Derive the headline credit quota from a `/usage` payload.
 *
 * Prefers the account allowance (`plan_limit` plus any `paygo_limit`) because a
 * per-key limit is often `null` while the account still has credits. Within the
 * account allowance, plan and pay-as-you-go credits are summed separately so an
 * exhausted plan still reports the PAYG credits that remain. Falls back to the
 * key limit when the account reports no allowance at all.
 *
 * Usage must be reported for every limit that is used; a missing value is an
 * error rather than a fabricated zero.
 */
export function deriveSnapshot(
  payload: TavilyUsagePayload,
  now: number = Date.now(),
): QuotaResult {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, message: "invalid /usage response" };
  }

  const account = record(payload.account);
  const key = record(payload.key);

  const planLimit = positive(account.plan_limit);
  const planUsage = finite(account.plan_usage);
  const paygoLimit = positive(account.paygo_limit);
  const paygoUsage = finite(account.paygo_usage);
  const keyLimit = positive(key.limit);
  const keyUsage = finite(key.usage);

  let limit: number;
  let used: number;
  if (planLimit > 0 || paygoLimit > 0) {
    if (planLimit > 0 && planUsage === null) {
      return { ok: false, message: "Tavily returned no plan usage for this account" };
    }
    if (paygoLimit > 0 && paygoUsage === null) {
      return { ok: false, message: "Tavily returned no pay-as-you-go usage for this account" };
    }
    limit = planLimit + paygoLimit;
    used = (planLimit > 0 ? planUsage ?? 0 : 0) + (paygoLimit > 0 ? paygoUsage ?? 0 : 0);
  } else {
    if (keyLimit === 0) {
      return { ok: false, message: "Tavily returned no credit limit for this key" };
    }
    if (keyUsage === null) {
      return { ok: false, message: "Tavily returned no credit usage for this key" };
    }
    limit = keyLimit;
    used = keyUsage;
  }

  const remaining = Math.max(0, limit - used);
  const planName =
    typeof account.current_plan === "string" && account.current_plan.trim()
      ? account.current_plan.trim()
      : "Tavily";

  return {
    ok: true,
    snapshot: {
      planName,
      used,
      limit,
      remaining,
      percentRemaining: (remaining / limit) * 100,
      updatedAt: now,
    },
  };
}

/**
 * Format a remaining percentage for the sidebar.
 *
 * Values that round to `10.0` at one decimal place switch to zero decimals so
 * the label never exceeds the four-character percent column (`100%`).
 */
export function formatPercent(percentRemaining: number): string {
  const clamped = Math.max(0, Math.min(100, percentRemaining));
  const tenths = Math.round(clamped * 10) / 10;
  return `${clamped.toFixed(tenths >= 10 ? 0 : 1)}%`;
}

/** Format the headline line, e.g. `839 credits left`. */
export function formatRemaining(snapshot: QuotaSnapshot): string {
  return `${snapshot.remaining} credits left`;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * When the credit quota next resets, as epoch milliseconds.
 *
 * Tavily resets credits on the first day of each month (calendar-based, not the
 * billing date) and `/usage` does not report when. Derive it as `00:00 UTC` on
 * the 1st of the following month. Tavily does not document a reset timezone;
 * UTC is assumed (see the README).
 */
export function nextMonthlyResetAt(now: number = Date.now()): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0, 0, 0);
}

/**
 * Countdown to `resetAt`, e.g. `12d 4h`, `5h 12m`, or `45m`.
 *
 * Days and hours are floored so the value never overstates the time left; a
 * sub-minute remainder rounds up to `1m`, and a past reset reads `0m`.
 */
export function formatResetCountdown(resetAt: number, now: number = Date.now()): string {
  const diff = resetAt - now;
  if (!Number.isFinite(diff) || diff <= 0) return "0m";
  const days = Math.floor(diff / MS_PER_DAY);
  const hours = Math.floor((diff % MS_PER_DAY) / MS_PER_HOUR);
  const minutes = Math.floor((diff % MS_PER_HOUR) / MS_PER_MINUTE);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}

/** Sidebar line for the next reset, e.g. `resets in 12d 4h`. */
export function formatResetLine(now: number = Date.now()): string {
  return `resets in ${formatResetCountdown(nextMonthlyResetAt(now), now)}`;
}

/** Shared summary for manual refreshes in the session and terminal. */
export function formatQuotaSummary(snapshot: QuotaSnapshot, warning?: string): string {
  return [
    formatRemaining(snapshot),
    formatPercent(snapshot.percentRemaining),
    formatResetLine(),
    ...(warning ? [warning] : []),
  ].join(" · ");
}

/**
 * Fetch and derive the current Tavily quota.
 *
 * Never throws: every failure is returned as `{ ok: false, message }` so the
 * sidebar can render it inline.
 */
export async function fetchQuota(options: FetchQuotaOptions = {}): Promise<QuotaResult> {
  let key: string;
  try {
    key = resolveApiKey(options.env, options.apiKey, options);
  } catch (error) {
    // A `{file:...}` option can point at a missing or unreadable file; surface
    // that inline instead of rejecting the sidebar render.
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  if (!key) {
    return {
      ok: false,
      message: "no Tavily API key (set TAVILY_API_KEY or the apiKey plugin option)",
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(USAGE_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).replaceAll(key, "[redacted]");
    return { ok: false, message: `request failed: ${reason}` };
  }

  if (response.status === 401) {
    return { ok: false, message: "API key rejected (401)" };
  }
  if (response.status === 429) {
    return {
      ok: false,
      message: "rate limited on /usage (10 req / 10 min)",
      rateLimited: true,
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after"),
        typeof options.now === "function" ? options.now() : options.now ?? Date.now()),
    };
  }
  if (!response.ok) {
    return { ok: false, message: `HTTP ${response.status} from /usage` };
  }

  let payload: TavilyUsagePayload;
  try {
    payload = (await response.json()) as TavilyUsagePayload;
  } catch {
    return { ok: false, message: "invalid JSON from /usage" };
  }

  return deriveSnapshot(payload, typeof options.now === "function" ? options.now() : options.now);
}
