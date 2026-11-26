import { systemClock, type SyncClock, type TimerHandle } from './clock';
import { MUTATORS, MutationRejected, partsInState, type MutatorTx } from './mutators';
import type { SyncStorage } from './storage';
import type { Transport } from './transport';
import {
  MAX_PUSH_BODY_BYTES,
  MAX_PUSH_MUTATIONS,
  type EntityName,
  type Mutation,
  type MutatorName,
  type Rejection,
  type Row,
} from './types';

export type SyncStatus = 'idle' | 'syncing' | 'offline';

/** A mutation the server refused, with its reason; the client keeps it for the user to see. */
export interface RejectedMutation extends Rejection {
  mutation: Mutation;
}

/** A mutation waiting for the server, with the time it was queued (its optimistic timestamp). */
interface Queued {
  mutation: Mutation;
  queuedAt: string;
  /** UTF-8 bytes of the mutation's JSON, for splitting the queue into push bodies. */
  bytes: number;
  /**
   * Set once the server applied the mutation: the change-log version of its last change. The
   * mutation stays in the queue, and in the optimistic view, until the cursor reaches this version,
   * so an interrupted pull never takes the user's change out of the view (F-30). It is not sent again.
   */
  appliedAt?: number;
}

const utf8 = new TextEncoder();

/** UTF-8 bytes of a value's JSON; the same in Node and browsers. */
function jsonBytes(value: unknown): number {
  return utf8.encode(JSON.stringify(value)).length;
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

  partsOf(ticketId: string): Row[] {
    return partsInState(this.state, ticketId);
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
  /**
   * The id the next mutation gets. Ids only grow, whatever the server answers: deriving them from
   * the last applied id and the queue length reused an id once a mutation left the queue (F-09).
   */
  private nextMutationId = 1;
  private pending: Queued[] = [];
  private listeners = new Set<() => void>();
  private currentStatus: SyncStatus = 'idle';
  private rejected: RejectedMutation[] = [];
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
      this.nextMutationId = saved.lastMutationId + 1;
      this.base = new Map(Object.entries(saved.base));
    }
  }

  get status(): SyncStatus {
    return this.currentStatus;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get rejections(): readonly RejectedMutation[] {
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
      id: this.nextMutationId,
      name,
      args: wireArgs(args),
    };
    const bytes = jsonBytes(mutation);
    if (this.envelopeBytes() + bytes > MAX_PUSH_BODY_BYTES) {
      throw new TypeError(`A mutation may take at most ${MAX_PUSH_BODY_BYTES} bytes of JSON in a push`);
    }
    this.nextMutationId += 1;
    this.pending.push({ mutation, queuedAt: new Date(this.clock.now()).toISOString(), bytes });
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
        if (this.unsent().length > 0 && this.currentStatus !== 'offline') void this.sync();
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

  /** Bytes of a push body with no mutations. */
  private envelopeBytes(): number {
    return jsonBytes({ clientId: this.clientId, mutations: [] });
  }

  /**
   * The head of the queue that fits in one push: at most {@link MAX_PUSH_MUTATIONS} mutations and
   * {@link MAX_PUSH_BODY_BYTES} bytes. `mutate` refuses a mutation that does not fit on its own, so
   * the batch is never empty while the queue is not.
   */
  private nextBatch(): Mutation[] {
    const batch: Mutation[] = [];
    let bytes = this.envelopeBytes();
    for (const q of this.pending) {
      if (q.appliedAt !== undefined) continue;
      // A comma separates every mutation after the first.
      const added = q.bytes + (batch.length > 0 ? 1 : 0);
      if (batch.length === MAX_PUSH_MUTATIONS || bytes + added > MAX_PUSH_BODY_BYTES) break;
      batch.push(q.mutation);
      bytes += added;
    }
    return batch;
  }

  /** Mutations the server has not answered yet. */
  private unsent(): Queued[] {
    return this.pending.filter((q) => q.appliedAt === undefined);
  }

  private async push(): Promise<void> {
    if (this.unsent().length === 0) return;
    const batch = this.nextBatch();
    const resp = await this.transport.push({ clientId: this.clientId, mutations: batch });
    const done = new Set<number>();
    for (const r of resp.results) {
      const queued = this.pending.find((q) => q.mutation.id === r.id);
      if (!queued) continue;
      if (r.status === 'rejected') {
        this.rejected.push({ mutation: queued.mutation, code: r.code, message: r.message, details: r.details });
        done.add(r.id);
      } else if (r.version === undefined || r.version <= this.cursor) {
        // Nothing to wait for: the mutation changed nothing, or the client has its change already.
        done.add(r.id);
      } else {
        queued.appliedAt = r.version;
      }
    }
    this.pending = this.pending.filter((q) => !done.has(q.mutation.id));
    this.acknowledge(resp.lastMutationId);
    this.emit();
  }

  /** The server applied (or rejected) every mutation up to `lastMutationId`. */
  private acknowledge(lastMutationId: number): void {
    this.lastMutationId = Math.max(this.lastMutationId, lastMutationId);
    this.nextMutationId = Math.max(this.nextMutationId, this.lastMutationId + 1);
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
      this.acknowledge(resp.lastMutationId);
      this.pending = this.pending.filter((q) => {
        if (q.appliedAt !== undefined) return q.appliedAt > this.cursor;
        // A mutation whose answer was lost: the last page comes from the same snapshot as the
        // client's last applied id, so every change of those mutations is in the pages read.
        return resp.hasMore || q.mutation.id > resp.lastMutationId;
      });
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
