/** Exponential backoff with full jitter: the bounds of the delay before a retry. */
export interface BackoffPolicy {
  /** Ceiling of the first delay, in milliseconds; each failure in a row doubles it. */
  baseMs: number;
  /** Largest ceiling, in milliseconds. */
  capMs: number;
}

/** One second, doubling up to a minute. */
export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 1_000, capMs: 60_000 };

/**
 * The delay before retry number `attempt` (0 for the first retry after a success), "full jitter"
 * (AWS Architecture Blog, "Exponential Backoff And Jitter"): uniformly random below
 * `min(capMs, baseMs * 2^attempt)`, so clients that failed together do not retry together. A delay
 * the server asked for (`Retry-After`) is a lower bound.
 *
 * `random` returns a number in [0, 1), like `Math.random`.
 */
export function backoffDelay(attempt: number, policy: BackoffPolicy, random: () => number, retryAfterMs = 0): number {
  // Past 2^30 the ceiling is the cap for any sensible policy; the exponent stays finite.
  const ceiling = Math.min(policy.capMs, policy.baseMs * 2 ** Math.min(Math.max(attempt, 0), 30));
  const r = random();
  const fraction = r >= 0 && r < 1 ? r : 0;
  return Math.max(Math.floor(fraction * ceiling), retryAfterMs);
}
