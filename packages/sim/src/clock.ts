import { createClock, type Clock, type TimerId } from '@sinonjs/fake-timers';
import type { SyncClock, TimerHandle } from '@fieldsync/sync-core';

/**
 * Virtual time shared by the simulated clients and the server: a standalone `@sinonjs/fake-timers`
 * clock (`createClock`), which replaces no global, so the host's timers, the database driver and
 * the test runner keep running on real time. Time moves only when the scheduler advances it; due
 * timers then fire one at a time, ordered by due time and, for equal times, by creation, and
 * between two timers the event loop turns once (`tickAsync`), so the code a timer started settles
 * before the next timer fires, as it would in real time.
 */
export class SimClock {
  private readonly clock: Clock;
  private fired = 0;

  constructor(start: number) {
    this.clock = createClock(start);
  }

  now(): number {
    return this.clock.now;
  }

  /** Number of timers that are set and have not fired. */
  get pendingTimers(): number {
    return this.clock.countTimers();
  }

  /** Number of timer callbacks that have run since the clock was created. */
  get firedTimers(): number {
    return this.fired;
  }

  /**
   * A client's view of this clock. `skewMs` shifts what `now()` reports (a client whose clock is
   * wrong); timers are relative, so they fire on the shared timeline regardless of skew.
   */
  view(skewMs = 0): SyncClock {
    return {
      now: () => this.clock.now + skewMs,
      setTimeout: (callback, ms) => {
        const id = this.clock.setTimeout(() => {
          this.fired += 1;
          callback();
        }, ms);
        return id as unknown as TimerHandle;
      },
      clearTimeout: (handle) => this.clock.clearTimeout(handle as unknown as TimerId),
    };
  }

  /**
   * Moves time forward by `ms`, firing every timer that falls due on the way, including timers set
   * by those timers, then lets the code they started settle. Returns the number of timers fired.
   */
  async advance(ms: number, settle: () => Promise<void>): Promise<number> {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`cannot advance by ${ms} ms`);
    const before = this.fired;
    await this.clock.tickAsync(ms);
    await settle();
    return this.fired - before;
  }

  /**
   * Moves time to the next timer and fires it, then lets the code it started settle. Returns how far time moved, or `undefined` when no timer is set.
   */
  async advanceToNext(settle: () => Promise<void>): Promise<number | undefined> {
    if (this.clock.countTimers() === 0) return undefined;
    const before = this.clock.now;
    await this.clock.nextAsync();
    await settle();
    return this.clock.now - before;
  }
}
