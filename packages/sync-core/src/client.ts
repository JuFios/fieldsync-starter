import { systemClock, type SyncClock, type TimerHandle } from './clock';
import { MUTATORS, MutationRejected, partsInState, type MutatorTx } from './mutators';
import type { SyncStorage } from './storage';
import { RESET_REQUIRED, TransportError, type RequestOptions, type Transport } from './transport';
import {
  asVersion,
  MAX_PUSH_BODY_BYTES,
  MAX_PUSH_MUTATIONS,
  type EntityName,
  type Mutation,
  type MutatorName,
  type PullResponse,
  type Rejection,
  type Row,
  type Version,
} from './types';

/**
 * `loading`: the client is reading a snapshot of the server's state (it has none yet, or its cursor
 * fell behind the collected part of the change log); its view still shows the previous state.
 */
export type SyncStatus = 'idle' | 'syncing' | 'loading' | 'offline';

/** Changes and snapshot rows per request. */
const PAGE_SIZE = 500;

/**
 * Snapshots started in one sync before giving up until the next retry. A snapshot is answered
 * RESET_REQUIRED again only if it took longer than the server's change-log retention.
 */
const MAX_SNAPSHOT_ATTEMPTS = 3;

/** A request that got no answer within the client's request timeout. */
export class RequestTimeout extends Error {
  constructor(readonly ms: number) {
    super(`No answer within ${ms} ms`);
    this.name = 'RequestTimeout';
  }
}

/** How long a request may take before the client gives up on it and retries later. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** What a step of a disposed client rejects with: it stops without storing or reporting anything. */
export class ClientDisposed extends Error {
  constructor() {
    super('The sync client was disposed');
    this.name = 'ClientDisposed';
  }
}

function isResetRequired(err: unknown): boolean {
  return err instanceof TransportError && err.code === RESET_REQUIRED;
}

function applyChanges(state: Map<string, Row>, changes: PullResponse['changes']): void {
  for (const change of changes) {
    const key = `${change.entity}/${change.id}`;
    if (change.op === 'put' && change.data) state.set(key, change.data);
    else state.delete(key);
  }
}

/**
 * Why the last sync failed: the server's problem code, NETWORK when the request failed without an
 * answer, TIMEOUT when no answer came within the request timeout.
 */
export interface SyncError {
  /** 0 when no answer arrived. */
  status: number;
  code: string;
  details?: Readonly<Record<string, unknown>>;
}

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
  appliedAt?: Version;
  /**
   * Set when the server answered a copy of the mutation as a duplicate without a version (its
   * result was collected): the change's version is unknown, so the mutation stays in the view until
   * a pull completes, and is not sent again.
   */
  awaitingPull?: true;
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
  /**
   * Longest wait for one request, in milliseconds; see {@link DEFAULT_REQUEST_TIMEOUT_MS}. `Infinity`
   * waits as long as the transport does.
   */
  requestTimeoutMs?: number;
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
  private readonly requestTimeoutMs: number;
  private base = new Map<string, Row>();
  private cursor: Version = asVersion(0);
  private lastMutationId = 0;
  /**
   * The id the next mutation gets. Ids only grow, whatever the server answers: deriving them from
   * the last applied id and the queue length reused an id once a mutation left the queue (F-09).
   */
  private nextMutationId = 1;
  private pending: Queued[] = [];
  /**
   * Whether `base` and `cursor` hold a state read from the server. A client without one, and one
   * whose cursor the server no longer serves (410 RESET_REQUIRED), loads a snapshot instead of
   * reading the change log from the start.
   */
  private hasState = false;
  private listeners = new Set<() => void>();
  private currentStatus: SyncStatus = 'idle';
  private rejected: RejectedMutation[] = [];
  private lastError: SyncError | undefined;
  private changeCount = 0;
  private retryTimer?: TimerHandle;
  private inFlight: Promise<void> | undefined;
  /**
   * A sync was asked for while one was running: run another once it ends. The running one may have
   * read its pull page before the change that prompted the request committed (F-39).
   */
  private again = false;
  private disposed = false;
  /** Aborts every request of the client when it is disposed. */
  private readonly life = new AbortController();
  /** Resolves once the stored state is loaded; every operation waits for it. */
  readonly ready: Promise<void>;

  constructor(opts: SyncClientOptions) {
    this.clientId = opts.clientId;
    this.transport = opts.transport;
    this.storage = opts.storage;
    this.clock = opts.clock ?? systemClock;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    const saved = await this.storage.load();
    if (saved) {
      this.lastMutationId = saved.lastMutationId;
      this.nextMutationId = saved.lastMutationId + 1;
      // A stored cursor that is not a version (storage edited or damaged) cannot be pulled from: the
      // client then loads a snapshot instead of failing.
      if (Number.isSafeInteger(saved.cursor) && saved.cursor >= 0) {
        this.cursor = asVersion(saved.cursor);
        this.base = new Map(Object.entries(saved.base));
        this.hasState = true;
      }
    }
    this.emit();
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

  /**
   * Why the last sync failed, until one succeeds. A `MUTATION_OUT_OF_ORDER` (409) means the server
   * misses mutations this client no longer has (its queue was lost): retrying cannot help, the
   * client's state has to be reloaded.
   */
  get syncError(): SyncError | undefined {
    return this.lastError;
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
   * Queues a mutation and applies it optimistically. Rejects with a TypeError, without queueing
   * anything, when `args` cannot be sent as JSON (a BigInt, a cycle); see {@link wireArgs}.
   */
  async mutate(name: MutatorName, args: Record<string, unknown>): Promise<void> {
    await this.ready;
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
    void this.start();
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

  /**
   * Pushes the queue and pulls the server's changes. Asked for while a sync is running (a
   * notification, a retry), it runs once more after the running one, unless that one failed (then
   * the retry timer runs the next), and resolves when that one ends.
   */
  sync(): Promise<void> {
    const running = this.inFlight;
    if (!running) return this.start();
    this.again = true;
    // The running sync's end starts the next one before this continuation runs.
    return running.then(() => this.inFlight);
  }

  /** Starts a sync unless one is running; the running one sends whatever is queued by then. */
  private start(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.inFlight) {
      this.inFlight = this.runSync().finally(() => {
        this.inFlight = undefined;
        const again = this.again;
        this.again = false;
        // After a failed sync the retry timer runs the next one, with its delay.
        if ((again || this.unsent().length > 0) && this.currentStatus !== 'offline') void this.start();
      });
    }
    return this.inFlight;
  }

  /**
   * Stops all work of the client (its page closes, or another user signs in): aborts every request
   * in flight, cancels the retry, and from now on writes nothing to its storage, whatever answer still
   * arrives.
   */
  dispose(): void {
    this.disposed = true;
    this.life.abort();
    if (this.retryTimer) this.clock.clearTimeout(this.retryTimer);
    this.listeners.clear();
  }

  /**
   * Runs one request with a signal that aborts when the client is disposed or the request takes
   * longer than `requestTimeoutMs` (on the client's clock, so tests and the simulation control it). A
   * request that hangs (a half-open connection) then fails like a lost one, and the client retries
   * instead of waiting forever (F-13). It resolves only while the client is alive: after `dispose()`
   * it rejects with {@link ClientDisposed}, even if the transport ignored the signal, so no later step
   * stores its answer.
   */
  private async request<T>(send: (init: RequestOptions) => Promise<T>): Promise<T> {
    if (this.life.signal.aborted) throw new ClientDisposed();
    const controller = new AbortController();
    let fail: (err: Error) => void = () => undefined;
    const failed = new Promise<never>((_resolve, reject) => (fail = reject));
    // The reason is settled before the abort, so the request ends with it and not with whatever error
    // the aborted transport rejects with.
    const onDispose = () => {
      fail(new ClientDisposed());
      controller.abort();
    };
    this.life.signal.addEventListener('abort', onDispose, { once: true });
    const timer = Number.isFinite(this.requestTimeoutMs)
      ? this.clock.setTimeout(() => {
          fail(new RequestTimeout(this.requestTimeoutMs));
          controller.abort();
        }, this.requestTimeoutMs)
      : undefined;
    try {
      return await Promise.race([send({ signal: controller.signal }), failed]);
    } finally {
      if (timer !== undefined) this.clock.clearTimeout(timer);
      this.life.signal.removeEventListener('abort', onDispose);
    }
  }

  private async runSync(): Promise<void> {
    await this.ready;
    if (this.disposed) return;
    this.setStatus('syncing');
    try {
      await this.push();
      if (this.hasState) {
        await this.pull().catch(async (err: unknown) => {
          if (!isResetRequired(err)) throw err;
          await this.reload();
        });
      } else {
        await this.reload();
      }
      this.lastError = undefined;
      this.setStatus('idle');
    } catch (err) {
      // A disposed client has nobody to report to and nothing to retry.
      if (this.disposed) return;
      this.lastError =
        err instanceof TransportError
          ? { status: err.status, code: err.code, ...(err.details ? { details: err.details } : {}) }
          : { status: 0, code: err instanceof RequestTimeout ? 'TIMEOUT' : 'NETWORK' };
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
      if (q.appliedAt !== undefined || q.awaitingPull) continue;
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
    return this.pending.filter((q) => q.appliedAt === undefined && !q.awaitingPull);
  }

  private async push(): Promise<void> {
    if (this.unsent().length === 0) return;
    const batch = this.nextBatch();
    const resp = await this.request((init) => this.transport.push({ clientId: this.clientId, mutations: batch }, init));
    const done = new Set<number>();
    for (const r of resp.results) {
      const queued = this.pending.find((q) => q.mutation.id === r.id);
      if (!queued) continue;
      if (r.status === 'rejected') {
        this.rejected.push({
          mutation: queued.mutation,
          code: r.code,
          message: r.message,
          ...(r.details === undefined ? {} : { details: r.details }),
        });
        done.add(r.id);
      } else if (r.version === undefined && r.status === 'duplicate') {
        queued.awaitingPull = true;
      } else if (r.version === undefined || r.version <= this.cursor) {
        // Nothing to wait for: the mutation changed nothing, or the client has its change already.
        done.add(r.id);
      } else {
        queued.appliedAt = r.version;
      }
    }
    this.pending = this.pending.filter((q) => !done.has(q.mutation.id));
    this.acknowledge(resp.lastMutationId);
    // Stored at once, not only after the next pull: after a reload, ids continue after the last one
    // the server handled, so a new mutation is never answered as a duplicate of an old one.
    await this.persist();
    this.emit();
  }

  /** The server applied (or rejected) every mutation up to `lastMutationId`. */
  private acknowledge(lastMutationId: number): void {
    this.lastMutationId = Math.max(this.lastMutationId, lastMutationId);
    this.nextMutationId = Math.max(this.nextMutationId, this.lastMutationId + 1);
  }

  private async pull(): Promise<void> {
    for (;;) {
      const resp = await this.request((init) => this.transport.pull(this.cursor, this.clientId, PAGE_SIZE, init));
      applyChanges(this.base, resp.changes);
      this.cursor = resp.nextCursor;
      this.settle(resp);
      await this.persist();
      this.emit();
      if (!resp.hasMore) break;
    }
  }

  /**
   * After a pull page: takes the server's last handled id and drops the pending mutations whose
   * effect the client now has.
   */
  private settle(resp: PullResponse): void {
    this.acknowledge(resp.lastMutationId);
    this.pending = this.pending.filter((q) => {
      if (q.appliedAt !== undefined) return q.appliedAt > this.cursor;
      if (q.awaitingPull) return resp.hasMore;
      // A mutation whose answer was lost: the last page comes from the same snapshot as the
      // client's last applied id, so every change of those mutations is in the pages read.
      return resp.hasMore || q.mutation.id > resp.lastMutationId;
    });
  }

  /**
   * Replaces the client's state with the server's: a snapshot (see {@link loadSnapshot}), started
   * again if the server answers RESET_REQUIRED while it is read.
   */
  private async reload(): Promise<void> {
    this.setStatus('loading');
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.loadSnapshot();
        return;
      } catch (err) {
        if (!isResetRequired(err) || attempt >= MAX_SNAPSHOT_ATTEMPTS) throw err;
      }
    }
  }

  /**
   * Reads every page of a snapshot and then the change log from its watermark into a separate map,
   * and only then makes it the base, with the cursor and the pending mutations settled by the last
   * pull page. Rows of a page may already hold changes after the watermark; the log replays them in
   * commit order, so the staged state ends as the server's, and nothing in between ever reaches the
   * view. The queue is kept: the view is the new base with the remaining pending mutations applied on
   * top (a rebase). An interruption leaves the previous state in place; the next sync starts over.
   */
  private async loadSnapshot(): Promise<void> {
    const staged = new Map<string, Row>();
    let page = await this.request((init) => this.transport.snapshot({ limit: PAGE_SIZE }, init));
    const { watermark } = page;
    for (;;) {
      for (const row of page.rows) staged.set(`${row.entity}/${row.id}`, row.data);
      if (page.next === null) break;
      const after = page.next;
      page = await this.request((init) => this.transport.snapshot({ watermark, after, limit: PAGE_SIZE }, init));
    }
    let cursor = watermark;
    let last: PullResponse;
    do {
      const from = cursor;
      last = await this.request((init) => this.transport.pull(from, this.clientId, PAGE_SIZE, init));
      applyChanges(staged, last.changes);
      cursor = last.nextCursor;
    } while (last.hasMore);
    this.base = staged;
    this.cursor = cursor;
    this.hasState = true;
    this.settle(last);
    await this.persist();
    this.emit();
  }

  private persist(): Promise<void> {
    // Checked here as well: a disposed client must not overwrite what its successor stores.
    if (this.disposed) return Promise.reject(new ClientDisposed());
    return this.storage.save({
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
