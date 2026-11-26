/**
 * Shrinks a failing scenario: the shortest failing prefix (binary search), then delta debugging
 * (ddmin, Zeller) to drop the steps that do not matter. `fails` replays a candidate and says whether
 * it still fails the same way; every call costs a full replay, so the number of calls is capped and
 * the best result so far is returned when the budget runs out.
 */

export interface MinimizeResult<T> {
  steps: T[];
  /** Replays used. */
  replays: number;
  /** False when the budget ran out before the result was 1-minimal. */
  complete: boolean;
}

export async function minimize<T>(
  steps: readonly T[],
  fails: (candidate: T[]) => Promise<boolean>,
  maxReplays: number,
): Promise<MinimizeResult<T>> {
  let replays = 0;
  const budgetLeft = () => replays < maxReplays;
  const test = async (candidate: T[]) => {
    replays += 1;
    return fails(candidate);
  };

  // 1. Shortest failing prefix. Failures are usually caused by an early step, so this cuts most of it.
  let current = [...steps];
  let low = 0;
  let high = current.length;
  while (low < high && budgetLeft()) {
    const mid = Math.floor((low + high) / 2);
    if (await test(current.slice(0, mid))) high = mid;
    else low = mid + 1;
  }
  // `high` only ever moves to a prefix that was replayed and failed.
  if (high < current.length) current = current.slice(0, high);

  // 2. ddmin: try removing chunks of decreasing size, keeping any removal that still fails.
  let chunks = 2;
  while (current.length >= 2 && budgetLeft()) {
    const size = Math.ceil(current.length / chunks);
    let reduced = false;
    for (let start = 0; start < current.length && budgetLeft(); start += size) {
      const complement = [...current.slice(0, start), ...current.slice(start + size)];
      if (complement.length < current.length && (await test(complement))) {
        current = complement;
        chunks = Math.max(chunks - 1, 2);
        reduced = true;
        break;
      }
    }
    if (reduced) continue;
    if (size === 1) return { steps: current, replays, complete: true };
    chunks = Math.min(chunks * 2, current.length);
  }
  return { steps: current, replays, complete: current.length < 2 };
}
