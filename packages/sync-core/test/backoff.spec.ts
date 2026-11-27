import fc from 'fast-check';
import { backoffDelay, DEFAULT_BACKOFF } from '../src';

const policy = { baseMs: 100, capMs: 1_000 };

describe('backoffDelay', () => {
  it('stays below a ceiling that doubles with each failure in a row and stops at the cap', () => {
    const almostOne = () => 0.999_999;
    expect([0, 1, 2, 3, 4, 5, 10].map((a) => backoffDelay(a, policy, almostOne))).toEqual([
      99, 199, 399, 799, 999, 999, 999,
    ]);
  });

  it('is zero for the lowest random value (full jitter: from 0 up to the ceiling)', () => {
    expect(backoffDelay(5, policy, () => 0)).toBe(0);
  });

  it('is within [0, ceiling) for any attempt and random value', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000 }),
        fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
        (a, r) => {
          const delay = backoffDelay(a, policy, () => r);
          const ceiling = Math.min(policy.capMs, policy.baseMs * 2 ** Math.min(a, 30));
          return Number.isInteger(delay) && delay >= 0 && delay < ceiling;
        },
      ),
    );
  });

  it('spreads clients that failed together over the whole range', () => {
    // A uniform sample: every tenth of the range gets some of 1000 delays.
    let seed = 1;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const delays = Array.from({ length: 1_000 }, () => backoffDelay(10, policy, random));
    const buckets = new Set(delays.map((d) => Math.floor(d / 100)));
    expect([...buckets].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('waits at least as long as the server asked (Retry-After), above the cap too', () => {
    expect(backoffDelay(0, policy, () => 0.5, 5_000)).toBe(5_000);
    expect(backoffDelay(3, policy, () => 0.9, 10)).toBe(720);
  });

  it('treats a random value outside [0, 1) as 0 and a negative attempt as the first', () => {
    expect(backoffDelay(2, policy, () => 1)).toBe(0);
    expect(backoffDelay(2, policy, () => Number.NaN)).toBe(0);
    expect(backoffDelay(-3, policy, () => 0.5)).toBe(50);
  });

  it('defaults to one second doubling up to a minute', () => {
    expect(DEFAULT_BACKOFF).toEqual({ baseMs: 1_000, capMs: 60_000 });
  });
});
