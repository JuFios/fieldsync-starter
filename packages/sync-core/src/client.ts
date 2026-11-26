import { systemClock, type SyncClock, type TimerHandle } from './clock';
import { MUTATORS, MutationRejected, type MutatorTx } from './mutators';
import type { SyncStorage } from './storage';
import type { Transport } from './transport';
import type { EntityName, Mutation, MutatorName, Row } from './types';

export type SyncStatus = 'idle' | 'syncing' | 'offline';

export interface Rejection {
  mutation: Mutation;
  error: string;
}

/** A mutation waiting for the server, with the time it was queued (its optimistic timestamp). */
interface Queued {
  mutation: Mutation;
  queuedAt: string;
}

export interface SyncClientOptions {
  clientId: string;
  transport: Transport;
  storage: SyncStorage;
  /** Time and timers; defaults to the system clock. */
  clock?: SyncClock;
}

class MapTx implements MutatorTx {
  constructor(
    private readonly state: Map<string, Row>,
    private readonly time: string,
  ) {}

  now(): string {
    return this.time;
  }

  get(entity: EntityName, id: string): Row | undefined {
    return this.state.get(`${entity}/${id}`);
  }

  put(entity: EntityName, id: string, row: Row): void {
    this.state.set(`${entity}/${id}`, row);
  }

  insert(entity: EntityName, id: string, row: Row): void {
    const key = `${entity}/${id}`;
    if (this.state.has(key)) throw new MutationRejected('ID_CONFLICT', `${entity} ${id} already exists`);
    this.state.set(key, row);
  }

  del(entity: EntityName, id: string): void {
    this.state.delete(`${entity}/${id}`);
  }
}

function applyLocally(state: Map<string, Row>, m: Mutation, time: string): void {
  try {
    MUTATORS[m.name].apply(new MapTx(state, time), m.args);
  } catch (err) {
    if (!(err instanceof MutationRejected)) throw err;
  }
}

/**
 * The arguments exactly as the server will receive them: a JSON round trip of `args`. Queueing the
 * snapshot keeps later changes the caller makes to the object out of the queue, makes the client
 * apply the same values as the server (JSON drops `undefined`, turns NaN into null, ...), and makes
 * an unsendable value fail here once instead of in every push of the queue behind it.
 */
function wireArgs(args: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(args) as string | undefined;
  const snapshot: unknown = json === undefined ? undefined : JSON.parse(json);
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new TypeError('Mutation arguments must serialise to a JSON object');
  }
  return snapshot as Record<string, unknown>;
}

export class SyncClient {
  readonly clientId: string;
  private readonly transport: Transport;
  private readonly storage: SyncStorage;
  private readonly clock: SyncClock;
  private base = new Map<string, Row>();
  private cursor = 0;
  private lastMutationId = 0;
  private pending: Queued[] = [];
  private listeners = new Set<() => void>();
  private currentStatus: SyncStatus = 'idle';
  private rejected: Rejection[] = [];
  private changeCount = 0;
  private retryTimer?: TimerHandle;
  private inFlight?: Promise<void>;
  private disposed = false;

  constructor(opts: SyncClientOptions) {
    this.clientId = opts.clientId;
    this.transport = opts.transport;
    this.storage = opts.storage;
    this.clock = opts.clock ?? systemClock;
    const saved = this.storage.load();
    if (saved) {
      this.cursor = saved.cursor;
      this.lastMutationId = saved.lastMutationId;
      this.base = new Map(Object.entries(saved.base));
    }
  }

  get status(): SyncStatus {
    return this.currentStatus;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get rejections(): readonly Rejection[] {
    return this.rejected;
  }

  /** Increases on every state change; usable as a cheap snapshot id for UI bindings. */
  get snapshotVersion(): number {
    return this.changeCount;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Queues a mutation and applies it optimistically. Throws a TypeError, without queueing anything,
   * when `args` cannot be sent as JSON (a BigInt, a cycle); see {@link wireArgs}.
   */
  mutate(name: MutatorName, args: Record<string, unknown>): void {
    const mutation: Mutation = {
      id: this.lastMutationId + this.pending.length + 1,
      name,
      args: wireArgs(args),
    };
    this.pending.push({ mutation, queuedAt: new Date(this.clock.now()).toISOString() });
    this.emit();
    void this.sync();
  }

  /** Server state with all unacknowledged local mutations applied on top. */
  view(): Map<string, Row> {
    const state = new Map(this.base);
    for (const q of this.pending) applyLocally(state, q.mutation, q.queuedAt);
    return state;
  }

  rows(entity: EntityName): Row[] {
    const prefix = `${entity}/`;
    return [...this.view()].filter(([key]) => key.startsWith(prefix)).map(([, row]) => row);
  }

  sync(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.inFlight) {
      this.inFlight = this.runSync().finally(() => {
        this.inFlight = undefined;
        if (this.pending.length > 0 && this.currentStatus !== 'offline') void this.sync();
      });
    }
    return this.inFlight;
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer) this.clock.clearTimeout(this.retryTimer);
    this.listeners.clear();
  }

  private async runSync(): Promise<void> {
    this.setStatus('syncing');
    try {
      await this.push();
      await this.pull();
      this.setStatus('idle');
    } catch {
      this.setStatus('offline');
      this.scheduleRetry();
    }
  }

  private async push(): Promise<void> {
    if (this.pending.length === 0) return;
    const batch = this.pending.slice(0, 100).map((q) => q.mutation);
    const resp = await this.transport.push({ clientId: this.clientId, mutations: batch });
    const handled = new Set(resp.results.map((r) => r.id));
    for (const r of resp.results) {
      if (r.status === 'rejected') {
        const mutation = batch.find((m) => m.id === r.id);
        if (mutation) this.rejected.push({ mutation, error: r.error ?? 'rejected' });
      }
    }
    this.pending = this.pending.filter((q) => !handled.has(q.mutation.id));
    this.lastMutationId = Math.max(this.lastMutationId, resp.lastMutationId);
    this.emit();
  }

  private async pull(): Promise<void> {
    for (;;) {
      const resp = await this.transport.pull(this.cursor, this.clientId, 500);
      for (const change of resp.changes) {
        const key = `${change.entity}/${change.id}`;
        if (change.op === 'put' && change.data) this.base.set(key, change.data);
        else this.base.delete(key);
      }
      this.cursor = resp.nextCursor;
      this.lastMutationId = Math.max(this.lastMutationId, resp.lastMutationId);
      this.pending = this.pending.filter((q) => q.mutation.id > this.lastMutationId);
      this.persist();
      this.emit();
      if (!resp.hasMore) break;
    }
  }

  private persist(): void {
    this.storage.save({
      cursor: this.cursor,
      lastMutationId: this.lastMutationId,
      base: Object.fromEntries(this.base),
    });
  }

  private setStatus(status: SyncStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    this.emit();
  }

  private scheduleRetry(): void {
    if (this.disposed) return;
    if (this.retryTimer) this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = this.clock.setTimeout(() => void this.sync(), 5000);
  }

  private emit(): void {
    this.changeCount += 1;
    for (const listener of this.listeners) listener();
  }
}
