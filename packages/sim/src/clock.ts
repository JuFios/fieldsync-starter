import type { SyncClock, TimerHandle } from '@fieldsync/sync-core';

interface Timer {
  at: number;
  /** Creation order: timers due at the same moment fire in the order they were set. */
  order: number;
  callback: () => void;
}

/**
 * Virtual time shared by the simulated clients and the server. Time moves only when the scheduler
 * calls {@link advance}; due timers then fire one at a time, ordered by due time and creation, so a
 * run never depends on the host's clock or on how fast it is.
 */
export class VirtualClock {
  private time: number;
  private created = 0;
  private readonly timers = new Map<TimerHandle, Timer>();

  constructor(start: number) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  /** Number of timers that are set and have not fired. */
  get pendingTimers(): number {
    return this.timers.size;
  }

  /**
   * A client's view of this clock. `skewMs` shifts what `now()` reports (a client whose clock is
   * wrong); timers are relative, so they fire on the shared timeline regardless of skew.
   */
  view(skewMs = 0): SyncClock {
    return {
      now: () => this.time + skewMs,
      setTimeout: (callback, ms) => this.setTimeout(callback, ms),
      clearTimeout: (handle) => this.clearTimeout(handle),
    };
  }

  setTimeout(callback: () => void, ms: number): TimerHandle {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`timer delay must be a non-negative number, got ${ms}`);
    const handle = Object.freeze({}) as TimerHandle;
    this.timers.set(handle, { at: this.time + ms, order: this.created, callback });
    this.created += 1;
    return handle;
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle);
  }

  /** The due time of the next timer, if any. */
  nextDue(): number | undefined {
    return this.next()?.[1].at;
  }

  /**
   * Moves time forward by `ms`, firing every timer that falls due on the way, in order. `afterEach`
   * runs after each callback, so the caller can let the code the timer started settle before the next
   * timer fires (as it would in real time). Time never moves backwards.
   */
  async advance(ms: number, afterEach: () => Promise<void>): Promise<number> {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`cannot advance by ${ms} ms`);
    const target = this.time + ms;
    let fired = 0;
    for (let due = this.next(); due && due[1].at <= target; due = this.next()) {
      const [handle, timer] = due;
      this.timers.delete(handle);
      this.time = Math.max(this.time, timer.at);
      timer.callback();
      fired += 1;
      await afterEach();
    }
    this.time = target;
    return fired;
  }

  private next(): [TimerHandle, Timer] | undefined {
    let best: [TimerHandle, Timer] | undefined;
    for (const entry of this.timers) {
      const [, timer] = entry;
      if (!best || timer.at < best[1].at || (timer.at === best[1].at && timer.order < best[1].order)) best = entry;
    }
    return best;
  }
}
