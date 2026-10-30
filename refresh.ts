/**
 * TUI refresh policy: one shared view state, request coalescing, and timers.
 *
 * The server owns the quota cache and the Tavily rate-limit cooldown; this
 * module only decides when the TUI asks for a snapshot and how a failure is
 * shown. It has injected timers, clock, and remote call so the behaviour can be
 * tested without a TUI renderer.
 */

import type { QuotaResponse } from "./quota-cache";
import type { QuotaSnapshot } from "./usage";

/** Tavily's `/usage` allows 10 requests per 10 minutes. */
export const DEFAULT_REFRESH_INTERVAL_MS = 600_000;
/** Keep the reset countdown current without re-rendering every second. */
export const CLOCK_INTERVAL_MS = 60_000;
/** Smallest accepted refresh interval; below this a user could exhaust the window. */
export const MIN_REFRESH_INTERVAL_MS = 60_000;
/** Largest delay `setTimeout`/`setInterval` accepts without Node clamping it to 1ms. */
export const MAX_TIMER_MS = 2_147_483_647;

export type ViewState =
  | { status: "loading" }
  | { status: "ready"; snapshot: QuotaSnapshot; warning?: string }
  | { status: "error"; message: string };

export type TimerHandle = ReturnType<typeof setInterval>;

export interface QuotaRefresherOptions {
  remote: (input: { force: boolean }) => Promise<QuotaResponse>;
  /** Invalidate freshness before a forced refresh, preserving server cooldowns. */
  invalidateRemote?: () => Promise<unknown>;
  now?: () => number;
  refreshMs?: unknown;
  onState?: (state: ViewState) => void;
  onClock?: (now: number) => void;
  setTimer?: (callback: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

export interface QuotaRefresher {
  state(): ViewState;
  start(): void;
  refresh(force?: boolean): Promise<ViewState>;
  invalidate(): Promise<ViewState>;
  dispose(): void;
}

/** Accept only a finite interval in the host timer's safe range. */
export function resolveRefreshMs(value: unknown): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_REFRESH_INTERVAL_MS &&
    value <= MAX_TIMER_MS
    ? value
    : DEFAULT_REFRESH_INTERVAL_MS;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createQuotaRefresher(options: QuotaRefresherOptions): QuotaRefresher {
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setInterval(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle: TimerHandle) => clearInterval(handle));
  const refreshMs = resolveRefreshMs(options.refreshMs);

  let state: ViewState = { status: "loading" };
  let inFlight: Promise<ViewState> | null = null;
  let trailing: Promise<ViewState> | null = null;
  let invalidating: Promise<ViewState> | null = null;
  let refreshTimer: TimerHandle | null = null;
  let clockTimer: TimerHandle | null = null;
  let started = false;
  let disposed = false;
  let generation = 0;

  const setState = (next: ViewState): void => {
    state = next;
    options.onState?.(next);
  };

  const applyFailure = (message: string, fallback?: QuotaSnapshot): ViewState => {
    // Keep the last good snapshot and show the failure as a warning; a full
    // error state is used only when no snapshot exists (not even one returned
    // by the server from its persisted cache).
    const snapshot = state.status === "ready" ? state.snapshot : fallback;
    const next: ViewState = snapshot
      ? { status: "ready", snapshot, warning: message }
      : { status: "error", message };
    setState(next);
    return next;
  };

  const perform = async (force: boolean): Promise<ViewState> => {
    const requestGeneration = generation;
    let result: QuotaResponse;
    try {
      result = await options.remote({ force });
    } catch (error) {
      if (disposed || generation !== requestGeneration) return state;
      return applyFailure(errorMessage(error));
    }
    if (disposed || generation !== requestGeneration) return state;

    if (result?.ok && result.snapshot) {
      setState({ status: "ready", snapshot: result.snapshot });
      return state;
    }
    return applyFailure(
      typeof result?.message === "string" && result.message
        ? result.message
        : "quota request failed",
      result?.snapshot,
    );
  };

  const refresh = (force = false): Promise<ViewState> => {
    if (disposed) return Promise.resolve(state);
    if (inFlight) {
      if (!force) return Promise.resolve(state);
      // A forced refresh while a request is in flight runs once more after it
      // settles instead of being dropped.
      if (!trailing) {
        trailing = inFlight
          .catch(() => undefined)
          .then(() => {
            trailing = null;
            return refresh(true);
          });
      }
      return trailing;
    }

    const run = perform(force);
    inFlight = run;
    const clear = () => {
      if (inFlight === run) inFlight = null;
    };
    void run.then(clear, clear);
    return run;
  };

  const start = (): void => {
    if (started || disposed) return;
    started = true;
    void refresh(false);
    refreshTimer = setTimer(() => void refresh(false), refreshMs);
    if (options.onClock) {
      clockTimer = setTimer(() => options.onClock?.(now()), CLOCK_INTERVAL_MS);
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (refreshTimer !== null) clearTimer(refreshTimer);
    if (clockTimer !== null) clearTimer(clockTimer);
    refreshTimer = null;
    clockTimer = null;
  };

  const invalidate = async (): Promise<ViewState> => {
    if (disposed) return state;
    // Credential events often arrive in a burst; one invalidate+refetch is
    // enough, and keeps the burst from spending the request budget.
    if (invalidating) return invalidating;
    const run = (async () => {
      generation++;
      setState({ status: "loading" });
      try {
        await options.invalidateRemote?.();
      } catch {
        // The refresh below still reports any real failure to the user.
      }
      return refresh(true);
    })();
    invalidating = run;
    const clear = () => {
      if (invalidating === run) invalidating = null;
    };
    void run.then(clear, clear);
    return run;
  };

  return {
    state: () => state,
    start,
    refresh,
    invalidate,
    dispose,
  };
}
