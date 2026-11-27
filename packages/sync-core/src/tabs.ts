/**
 * Coordination of the tabs of one user in one browser: they share the client's storage, and one of
 * them, the leader, talks to the server (pushes, pulls, keeps the notification stream open). The
 * others (followers) queue their mutations in the storage and show what the leader stores.
 */

/** What tabs tell each other; never data of the user (it is in the storage), never the token. */
export type TabMessage =
  /** A follower queued a mutation: the leader sends it. */
  | { kind: 'enqueued' }
  /** The leader stored a change of the state: followers read it again. */
  | { kind: 'changed' }
  /** The leader's sync status, for the followers' status line. */
  | { kind: 'status'; status: string; error: { status: number; code: string } | null }
  /** A follower asks for a sync (the user wants one, or the device came online). */
  | { kind: 'sync' };

/** Whether a value received from another tab (maybe of another app version) is a {@link TabMessage}. */
export function isTabMessage(value: unknown): value is TabMessage {
  if (value === null || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  switch (m.kind) {
    case 'enqueued':
    case 'changed':
    case 'sync':
      return true;
    case 'status': {
      const e = m.error as Record<string, unknown> | null;
      const errorOk =
        e === null || (typeof e === 'object' && typeof e.status === 'number' && typeof e.code === 'string');
      return typeof m.status === 'string' && errorOk;
    }
    default:
      return false;
  }
}

export interface TabCoordinator {
  /**
   * Asks to lead. Resolves with true when this tab leads now, or with false when another tab leads:
   * this one then waits in line and `onLeader` is called when it leads (the other tab's client was
   * disposed, or its tab closed or crashed). Leadership lasts until `signal` aborts (this tab's client
   * is disposed) or the tab goes away; aborting also leaves the line.
   */
  claim(signal: AbortSignal, onLeader: () => void): Promise<boolean>;
  /** Tells every other tab of the user (not this one). */
  post(message: TabMessage): void;
  subscribe(listener: (message: TabMessage) => void): () => void;
  close(): void;
}

/** A tab that is alone: it leads at once and has nobody to tell. */
export function soloTab(): TabCoordinator {
  return {
    claim: () => Promise.resolve(true),
    post: () => undefined,
    subscribe: () => () => undefined,
    close: () => undefined,
  };
}

/**
 * The tabs of a browser, through the Web Locks API (the leader holds an exclusive lock named after
 * the user's database for as long as its client lives; the browser releases it when the tab closes
 * or crashes, and grants it to the next tab in line) and a BroadcastChannel of the same name (which
 * delivers to the other tabs of the origin, not to the sender). Both exist in secure contexts only.
 */
export class BrowserTabs implements TabCoordinator {
  private readonly channel: BroadcastChannel;
  private readonly listeners = new Set<(message: TabMessage) => void>();

  constructor(private readonly name: string) {
    this.channel = new BroadcastChannel(name);
    this.channel.onmessage = (event: MessageEvent<unknown>) => {
      if (!isTabMessage(event.data)) return;
      for (const listener of this.listeners) listener(event.data);
    };
  }

  claim(signal: AbortSignal, onLeader: () => void): Promise<boolean> {
    const name = `${this.name}:leader`;
    // The lock is held while the returned promise is pending: until the client is disposed. The
    // browser releases it if the tab goes away (Web Locks API). `request` itself settles only after
    // the release, so the answer comes from the callback.
    const hold = () =>
      new Promise<void>((release) => {
        if (signal.aborted) release();
        else signal.addEventListener('abort', () => release(), { once: true });
      });
    const wait = () => {
      if (signal.aborted) return;
      // Waits in line; an abort (dispose) drops the request.
      navigator.locks
        .request(name, { signal }, () => {
          onLeader();
          return hold();
        })
        .catch(() => undefined);
    };
    return new Promise((resolve) => {
      navigator.locks
        .request(name, { ifAvailable: true }, (lock) => {
          if (lock === null) {
            resolve(false);
            wait();
            return undefined;
          }
          resolve(true);
          return hold();
        })
        .catch(() => resolve(false));
    });
  }

  post(message: TabMessage): void {
    this.channel.postMessage(message);
  }

  subscribe(listener: (message: TabMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.listeners.clear();
    this.channel.close();
  }
}

/**
 * Tabs in memory, for tests and the simulation: `tab()` makes one more tab of the group. Leadership
 * goes to the tabs in the order they asked, as the Web Locks API grants a lock; messages reach the
 * other tabs asynchronously, as a BroadcastChannel delivers them.
 */
export class TabGroup {
  private readonly tabs = new Set<MemoryTab>();
  private readonly queue: Array<{ tab: MemoryTab; signal: AbortSignal; granted: () => void }> = [];
  private leader: { tab: MemoryTab; signal: AbortSignal } | undefined;

  tab(): TabCoordinator {
    const tab = new MemoryTab(this);
    this.tabs.add(tab);
    return tab;
  }

  /** @internal Grants at once (true) or queues the tab (false; `granted` runs when it leads). */
  request(tab: MemoryTab, signal: AbortSignal, granted: () => void): boolean {
    signal.addEventListener('abort', () => this.release(tab), { once: true });
    if (!this.leader) {
      this.leader = { tab, signal };
      return true;
    }
    this.queue.push({ tab, signal, granted });
    return false;
  }

  /** @internal */
  release(tab: MemoryTab): void {
    const i = this.queue.findIndex((q) => q.tab === tab);
    if (i >= 0) this.queue.splice(i, 1);
    if (this.leader?.tab === tab) this.leader = undefined;
    this.grant();
  }

  /** @internal */
  broadcast(from: MemoryTab, message: TabMessage): void {
    for (const tab of this.tabs) {
      if (tab !== from) queueMicrotask(() => tab.deliver(structuredClone(message)));
    }
  }

  /** @internal */
  remove(tab: MemoryTab): void {
    this.tabs.delete(tab);
    this.release(tab);
  }

  private grant(): void {
    if (this.leader) return;
    const next = this.queue.find((q) => !q.signal.aborted);
    if (!next) return;
    this.queue.splice(this.queue.indexOf(next), 1);
    this.leader = { tab: next.tab, signal: next.signal };
    next.granted();
  }
}

class MemoryTab implements TabCoordinator {
  private readonly listeners = new Set<(message: TabMessage) => void>();

  constructor(private readonly group: TabGroup) {}

  claim(signal: AbortSignal, onLeader: () => void): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return Promise.resolve(this.group.request(this, signal, onLeader));
  }

  post(message: TabMessage): void {
    this.group.broadcast(this, message);
  }

  subscribe(listener: (message: TabMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  deliver(message: TabMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  close(): void {
    this.listeners.clear();
    this.group.remove(this);
  }
}
