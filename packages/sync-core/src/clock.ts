declare const timerHandle: unique symbol;

/** An opaque timer id; only the clock that returned it can clear it. */
export type TimerHandle = { readonly [timerHandle]: true };

/**
 * The client's source of time and timers. Production uses {@link systemClock}; the simulation
 * passes a virtual clock so that time and retries advance only when its scheduler decides.
 */
export interface SyncClock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export const systemClock: SyncClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms) as unknown as TimerHandle,
  clearTimeout: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
};
