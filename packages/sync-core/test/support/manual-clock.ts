import type { SyncClock, TimerHandle } from '../../src';

/** A clock that moves only when the test advances it; timers fire in order, each after a macrotask. */
export class ManualClock implements SyncClock {
  private time = Date.parse('2030-01-01T00:00:00.000Z');
  private readonly timers = new Map<TimerHandle, { at: number; callback: () => void }>();

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number): TimerHandle {
    const handle = {} as TimerHandle;
    this.timers.set(handle, { at: this.time + ms, callback });
    return handle;
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle);
  }

  get pendingTimers(): number {
    return this.timers.size;
  }

  /** Moves time forward step by step, running every timer that falls due (also ones set meanwhile). */
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [handle, timer] = next;
      this.time = Math.max(this.time, timer.at);
      this.timers.delete(handle);
      timer.callback();
      await new Promise((r) => setImmediate(r));
    }
    this.time = end;
    await new Promise((r) => setImmediate(r));
  }
}
