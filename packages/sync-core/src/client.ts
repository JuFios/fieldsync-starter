import { backoffDelay, DEFAULT_BACKOFF, type BackoffPolicy } from './backoff';
import { systemClock, type SyncClock, type TimerHandle } from './clock';
import { MUTATORS, MutationRejected, partsInState, type MutatorTx } from './mutators';
import {
  MUTATION_FORMAT_VERSION,
  type StateChange,
  type StoredMutation,
  type StoredRejection,
  type SyncStorage,
  type UpdateRequired,
} from './storage';
import { RESET_REQUIRED, TransportError, type RequestOptions, type Transport } from './transport';
import {
  asVersion,
  MAX_PUSH_BODY_BYTES,
  MAX_PUSH_MUTATIONS,
  PROTOCOL_VERSION,
  type EntityName,
  type Mutation,
  type MutatorName,
  type PullResponse,
  type Rejection,
  type Row,
  type Version,
} from './types';

/**
 * `error`: the client's storage refused a write, so what it shows may not survive a reload; it keeps
 * retrying. `loading`: the client is reading a snapshot of the server's state (it has none yet, or its cursor
 * fell behind the collected part of the change log); its view still shows the previous state.
 */
export type SyncStatus = 'idle' | 'syncing' | 'loading' | 'offline' | 'error' | 'update-required';

/**
 * What the status line shows (task 3.3.3): `synced` (nothing waits for the server), `pending` (local
 * changes are not applied yet), `offline` (the server cannot be reached), `rejected` (the server
 * refused changes; they are listed until dismissed), plus `loading` (reading a snapshot), `error` (the
 * local storage refuses writes) and `update-required` (the server no longer speaks this app's
 * protocol: the app has to be updated; the queue is kept for the updated app).
 */
export type SyncIndicator = 'synced' | 'pending' | 'offline' | 'rejected' | 'loading' | 'error' | 'update-required';

/** Changes and snapshot rows per request. */
const PAGE_SIZE = 500;

/**
 * Snapshots started in one sync before giving up until the next retry. A snapshot is answered
 * RESET_REQUIRED again only if it took longer than the server's change-log retention.
 */
const MAX_SNAPSHOT_ATTEMPTS = 3;

/** The client's storage refused a write (full, or unavailable); `cause` is the storage's error. */
export class StorageFailure extends Error {
  constructor(cause: unknown) {
    super(`The client's storage refused a write: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.name = 'StorageFailure';
  }
}

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

/** What the client reports for a failed sync. */
function syncErrorOf(err: unknown): SyncError {
  if (err instanceof TransportError) {
    return { status: err.status, code: err.code, ...(err.details ? { details: err.details } : {}) };
  }
  if (err instanceof StorageFailure) return { status: 0, code: 'STORAGE' };
  return { status: 0, code: err instanceof RequestTimeout ? 'TIMEOUT' : 'NETWORK' };
}

/** The server will not apply this client id's next mutation: a gap in its ids, or a retired id. */
function isClientGone(err: unknown): boolean {
  return err instanceof TransportError && (err.code === 'MUTATION_OUT_OF_ORDER' || err.code === 'CLIENT_RETIRED');
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
 * answer, TIMEOUT when no answer came within the request timeout, STORAGE when the client's storage
 * refused to keep what the server said.
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

const utf8 = new TextEncoder();

/** UTF-8 bytes of a value's JSON; the same in Node and browsers. */
function jsonBytes(value: unknown): number {
  return utf8.encode(JSON.stringify(value)).length;
}

/** The longest mutation id, for the size of a mutation before the storage gives it its id. */
const LONGEST_ID = Number.MAX_SAFE_INTEGER;

export interface SyncClientOptions {
  /** The client id to take when the storage holds none yet (its first start); otherwise a new UUID. */
  clientId?: string;
  transport: Transport;
  storage: SyncStorage;
  /** Time and timers; defaults to the system clock. */
  clock?: SyncClock;
  /**
   * Longest wait for one request, in milliseconds; see {@link DEFAULT_REQUEST_TIMEOUT_MS}. `Infinity`
   * waits as long as the transport does.
   */
  requestTimeoutMs?: number;
  /** Delays between retries; see {@link DEFAULT_BACKOFF}. */
  backoff?: BackoffPolicy;
  /** Random numbers in [0, 1) for the jitter of retries; defaults to `Math.random`. */
  random?: () => number;
  /** New client ids (the first one, and one after a 409); defaults to random UUIDs. */
  newClientId?: () => string;
  /**
   * Keep the notification stream open (if the transport has one) and sync on every poke; on by
   * default. Off, the client syncs only when asked to.
   */
  live?: boolean;
}

/** The stream was silent for three heartbeat intervals: the connection is taken for dead. */
class StreamSilent extends Error {
  constructor() {
    super('The notification stream went silent');
    this.name = 'StreamSilent';
  }
}

/** Heartbeat intervals of silence after which the stream is taken for dead and reopened. */
const SILENT_HEARTBEATS = 3;

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

/** A mutation of the queue that the server has not answered yet. */
function isUnsent(q: StoredMutation): boolean {
  return q.appliedAt === undefined && !q.awaitingPull;
}

/**
 * The sync client: a durable queue of mutations applied optimistically on top of the server's rows,
 * a push of the queue and a pull of the change log. Its whole state is in its storage (IndexedDB in
 * the browser) and every change of it is one atomic write, so a page that reloads or closes at any
 * point loses no queued mutation and repeats none (F-10).
 */
export class SyncClient {
  private readonly transport: Transport;
  private readonly storage: SyncStorage;
  private readonly clock: SyncClock;
  private readonly requestTimeoutMs: number;
  private readonly backoff: BackoffPolicy;
  private readonly random: () => number;
  /** Failed syncs in a row: the exponent of the next retry delay. */
  private failures = 0;
  private readonly initialClientId: string | undefined;
  private readonly live: boolean;
  private readonly newClientId: () => string;
  /** The stream's watchdog and reconnect delay, cleared on dispose. */
  private readonly streamTimers = new Set<TimerHandle>();
  private id = '';
  private base = new Map<string, Row>();
  private cursor: Version = asVersion(0);
  private lastMutationId = 0;
  private pending: StoredMutation[] = [];
  /** UTF-8 bytes of each queued mutation's JSON, by queue position, for splitting the queue into pushes. */
  private readonly bytes = new Map<number, number>();
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
  private retryTimer: TimerHandle | undefined;
  private inFlight: Promise<void> | undefined;
  /**
   * A sync was asked for while one was running: run another once it ends. The running one may have
   * read its pull page before the change that prompted the request committed (F-39).
   */
  private again = false;
  private disposed = false;
  /** Aborts every request of the client when it is disposed. */
  private readonly life = new AbortController();
  /**
   * Resolves once the stored state is loaded; every operation waits for it. It does not reject: a
   * storage that cannot be read leaves the client in the status `error` (see `syncError`).
   */
  readonly ready: Promise<void>;

  constructor(opts: SyncClientOptions) {
    this.transport = opts.transport;
    this.storage = opts.storage;
    this.clock = opts.clock ?? systemClock;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.backoff = opts.backoff ?? DEFAULT_BACKOFF;
    this.random = opts.random ?? Math.random;
    this.initialClientId = opts.clientId;
    this.live = opts.live ?? true;
    this.newClientId = opts.newClientId ?? randomClientId;
    this.ready = this.load().then(() => {
      if (this.live && !this.broken && this.transport.stream) void this.runStream();
    });
  }

  /** The client id the server knows this client by ('' until `ready`). */
  get clientId(): string {
    return this.id;
  }

  private async load(): Promise<void> {
    try {
      const state = await this.storage.load();
      this.id = state.meta.clientId ?? (await this.storage.ensureClientId(this.initialClientId ?? this.newClientId()));
      this.lastMutationId = state.meta.lastMutationId;
      this.pending = state.pending;
      this.rejected = state.rejections.map(({ seq: _seq, ...rejection }) => rejection);
      if (state.meta.cursor !== null) {
        this.cursor = state.meta.cursor;
        this.base = state.base;
        this.hasState = true;
      }
      this.retiring = state.meta.retiring;
      // A refusal of an older protocol than this code speaks is history: the app was updated.
      const refused = state.meta.updateRequired;
      if (refused && refused.version < PROTOCOL_VERSION) await this.storage.commit({ meta: { updateRequired: null } });
      else this.updateRequired = refused;
      // A queue written by a newer app holds formats this code cannot send.
      if (this.pending.some((q) => q.v > MUTATION_FORMAT_VERSION)) {
        this.updateRequired ??= { version: PROTOCOL_VERSION, min: PROTOCOL_VERSION + 1, max: PROTOCOL_VERSION + 1 };
      }
      if (this.updateRequired) this.currentStatus = 'update-required';
    } catch (err) {
      this.broken = new StorageFailure(err);
      this.lastError = syncErrorOf(this.broken);
      this.currentStatus = 'error';
    }
    this.emit();
  }

  /** Set when the storage could not be read: the client cannot work. */
  private broken: StorageFailure | undefined;
  /** Set when the server refused this protocol version: no request is made until the app is updated. */
  private updateRequired: UpdateRequired | null = null;
  /** A client id being given up after a 409 (stored, so a restart finishes the recovery). */
  private retiring: string | null = null;

  get status(): SyncStatus {
    return this.currentStatus;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** See {@link SyncIndicator}. */
  get indicator(): SyncIndicator {
    switch (this.currentStatus) {
      case 'update-required':
      case 'error':
      case 'loading':
      case 'offline':
        return this.currentStatus;
      case 'idle':
      case 'syncing':
        if (this.rejected.length > 0) return 'rejected';
        return this.pending.length > 0 ? 'pending' : 'synced';
    }
  }

  /** The protocol range the server accepts, once it refused this app's version; null otherwise. */
  get updateRequiredBy(): UpdateRequired | null {
    return this.updateRequired;
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
   * Queues a mutation and applies it optimistically, once it is stored: what the user sees survives a
   * reload. Rejects with a TypeError, without queueing anything, when `args` cannot be sent as JSON
   * (a BigInt, a cycle; see {@link wireArgs}) or would not fit in one push, and with a
   * {@link StorageFailure} when the storage refuses the write (the client then reports `STORAGE`).
   */
  async mutate(name: MutatorName, args: Record<string, unknown>): Promise<void> {
    await this.ready;
    if (this.broken) throw this.broken;
    if (this.disposed) throw new ClientDisposed();
    const wire = wireArgs(args);
    if (this.envelopeBytes() + jsonBytes({ id: LONGEST_ID, name, args: wire }) > MAX_PUSH_BODY_BYTES) {
      throw new TypeError(`A mutation may take at most ${MAX_PUSH_BODY_BYTES} bytes of JSON in a push`);
    }
    let queued: StoredMutation;
    try {
      queued = await this.storage.enqueue({ name, args: wire, queuedAt: new Date(this.clock.now()).toISOString() });
    } catch (err) {
      const failure = new StorageFailure(err);
      this.lastError = syncErrorOf(failure);
      this.setStatus('error');
      throw failure;
    }
    if (this.disposed) return;
    this.pending.push(queued);
    this.emit();
    void this.start();
  }

  /** Removes every kept rejection (the user has seen them). */
  async dismissRejections(): Promise<void> {
    await this.ready;
    if (this.rejected.length === 0) return;
    await this.commit({ rejections: { clear: true } });
    this.rejected = [];
    this.emit();
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
        // Nor after a sync that cannot run (an update is required): it would only start again at once.
        const failed = ['offline', 'error', 'update-required'].includes(this.currentStatus);
        if ((again || this.unsent().length > 0) && !failed) void this.start();
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
    for (const timer of this.streamTimers) this.clock.clearTimeout(timer);
    this.streamTimers.clear();
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

  /**
   * Keeps the notification stream open while the client lives. Every time it opens (`ready`) the
   * client syncs, which fetches what it missed while it was closed; every poke syncs again. A stream
   * silent for {@link SILENT_HEARTBEATS} heartbeat intervals (a dead connection a proxy keeps) is
   * aborted. Whatever ends it, it is reopened after a backoff delay, which restarts once a stream
   * opens. An answer telling the client to update stops it: retrying cannot help.
   */
  private async runStream(): Promise<void> {
    const stream = this.transport.stream?.bind(this.transport);
    if (!stream) return;
    let failures = 0;
    while (!this.disposed) {
      const controller = new AbortController();
      const onDispose = () => controller.abort();
      this.life.signal.addEventListener('abort', onDispose, { once: true });
      // Until `ready` says how often heartbeats come, the stream gets a request's time to open.
      let silenceMs = this.requestTimeoutMs;
      let watchdog: TimerHandle | undefined;
      let silent = false;
      const arm = () => {
        if (watchdog) this.untrack(watchdog);
        if (!Number.isFinite(silenceMs)) return;
        watchdog = this.track(() => {
          silent = true;
          controller.abort();
        }, silenceMs);
      };
      arm();
      let failure: unknown;
      try {
        await stream(
          (event) => {
            if (event.type === 'ready') {
              silenceMs = SILENT_HEARTBEATS * event.heartbeatMs;
              failures = 0;
              void this.sync();
            } else if (event.type === 'poke') {
              void this.sync();
            }
            arm();
          },
          { signal: controller.signal },
        );
      } catch (err) {
        // An answer of the server says more than the silence that may have aborted the stream meanwhile.
        failure = silent && !(err instanceof TransportError) ? new StreamSilent() : err;
      } finally {
        if (watchdog) this.untrack(watchdog);
        this.life.signal.removeEventListener('abort', onDispose);
      }
      if (this.disposed) return;
      if (failure instanceof TransportError && failure.code === 'CLIENT_UPDATE_REQUIRED') return;
      const retryAfterMs = failure instanceof TransportError ? (failure.retryAfterSeconds ?? 0) * 1000 : 0;
      const delay = backoffDelay(failures, this.backoff, this.random, retryAfterMs);
      failures += 1;
      await new Promise<void>((resolve) => {
        this.track(resolve, delay);
        this.life.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    }
  }

  /** A timer of the stream, cleared on dispose. */
  private track(callback: () => void, ms: number): TimerHandle {
    const handle = this.clock.setTimeout(() => {
      this.streamTimers.delete(handle);
      callback();
    }, ms);
    this.streamTimers.add(handle);
    return handle;
  }

  private untrack(handle: TimerHandle): void {
    this.clock.clearTimeout(handle);
    this.streamTimers.delete(handle);
  }

  /**
   * Writes a change of the state, in one transaction. A disposed client writes nothing (its
   * successor may already own the storage); a write the storage refuses rejects with
   * {@link StorageFailure} (F-38).
   */
  private async commit(change: StateChange): Promise<void> {
    if (this.disposed) throw new ClientDisposed();
    try {
      await this.storage.commit(change);
    } catch (err) {
      throw new StorageFailure(err);
    }
    if (this.disposed) throw new ClientDisposed();
  }

  private async runSync(): Promise<void> {
    await this.ready;
    if (this.disposed || this.broken || this.updateRequired) return;
    this.setStatus('syncing');
    try {
      if (this.retiring !== null) await this.recover();
      await this.push().catch(async (err: unknown) => {
        // The server misses mutations of this client id (a lost queue) or the id was given up: the
        // client continues under a new id and sends what is left.
        if (!isClientGone(err) || !this.transport.retire) throw err;
        await this.giveUpClientId();
        await this.push();
      });
      if (this.hasState) {
        await this.pull().catch(async (err: unknown) => {
          if (!isResetRequired(err)) throw err;
          await this.reload();
        });
      } else {
        await this.reload();
      }
      this.lastError = undefined;
      this.failures = 0;
      this.setStatus('idle');
    } catch (err) {
      // A disposed client has nobody to report to and nothing to retry.
      if (this.disposed) return;
      this.lastError = syncErrorOf(err);
      if (err instanceof TransportError && err.code === 'CLIENT_UPDATE_REQUIRED') {
        await this.requireUpdate(err);
        return;
      }
      // What the server said was not stored: the client is not in sync, whatever the network does.
      this.setStatus(err instanceof StorageFailure ? 'error' : 'offline');
      this.scheduleRetry(err);
    }
  }

  /**
   * The server refused this protocol version: stored, so a reload does not try again, and no request
   * is made until the app is updated (its next version clears it). The queue stays for that app.
   */
  private async requireUpdate(err: TransportError): Promise<void> {
    const range = (n: unknown) => (typeof n === 'number' && Number.isSafeInteger(n) ? n : PROTOCOL_VERSION + 1);
    this.updateRequired = { version: PROTOCOL_VERSION, min: range(err.details?.min), max: range(err.details?.max) };
    this.setStatus('update-required');
    await this.commit({ meta: { updateRequired: this.updateRequired } }).catch(() => undefined);
  }

  /**
   * Starts the recovery from a 409 MUTATION_OUT_OF_ORDER (or a retired id): the server misses
   * mutations of this client id that the client no longer has, and renumbering them under the same id
   * could let a late copy of an old request apply one twice. The id is given up instead: the intent
   * is stored first (a restart finishes the recovery), then {@link recover}.
   */
  private async giveUpClientId(): Promise<void> {
    this.retiring = this.id;
    await this.commit({ meta: { retiring: this.id } });
    await this.recover();
  }

  /**
   * Retires the old id on the server (nothing new is applied under it from then on, so no late copy
   * can apply), then continues under a new id: unsent mutations up to the last id the server handled
   * under the old one were applied and wait for a pull; the others are renumbered from 1.
   */
  private async recover(): Promise<void> {
    const old = this.retiring;
    const retire = this.transport.retire?.bind(this.transport);
    if (old === null || !retire) return;
    const { lastMutationId } = await this.request((init) => retire(old, init));
    const fresh = this.newClientId();
    try {
      await this.storage.restartClient(fresh, lastMutationId);
    } catch (err) {
      throw new StorageFailure(err);
    }
    const state = await this.storage.load();
    this.id = fresh;
    this.retiring = null;
    this.pending = state.pending;
    this.bytes.clear();
    this.lastMutationId = 0;
    this.emit();
  }

  /** Bytes of a push body with no mutations. */
  private envelopeBytes(): number {
    return jsonBytes({ clientId: this.id, mutations: [] });
  }

  private bytesOf(q: StoredMutation): number {
    let bytes = this.bytes.get(q.seq);
    if (bytes === undefined) {
      bytes = jsonBytes(q.mutation);
      this.bytes.set(q.seq, bytes);
    }
    return bytes;
  }

  /**
   * The head of the queue that fits in one push: at most {@link MAX_PUSH_MUTATIONS} mutations and
   * {@link MAX_PUSH_BODY_BYTES} bytes. `mutate` refuses a mutation that does not fit on its own, so
   * the batch is never empty while the queue is not. Mutations in a format this code does not know
   * (queued by a newer app) are not sent.
   */
  private nextBatch(): StoredMutation[] {
    const batch: StoredMutation[] = [];
    let bytes = this.envelopeBytes();
    for (const q of this.unsent()) {
      if (q.v > MUTATION_FORMAT_VERSION) break;
      // A comma separates every mutation after the first.
      const added = this.bytesOf(q) + (batch.length > 0 ? 1 : 0);
      if (batch.length === MAX_PUSH_MUTATIONS || bytes + added > MAX_PUSH_BODY_BYTES) break;
      batch.push(q);
      bytes += added;
    }
    return batch;
  }

  /** Mutations the server has not answered yet. */
  private unsent(): StoredMutation[] {
    return this.pending.filter(isUnsent);
  }

  private async push(): Promise<void> {
    const batch = this.nextBatch();
    if (batch.length === 0) return;
    const resp = await this.request((init) =>
      this.transport.push({ clientId: this.id, mutations: batch.map((q) => q.mutation) }, init),
    );
    const sent = new Map(batch.map((q) => [q.mutation.id, q]));
    const done = new Set<number>();
    const updated: StoredMutation[] = [];
    const rejections: Array<Omit<StoredRejection, 'seq'>> = [];
    for (const r of resp.results) {
      const queued = sent.get(r.id);
      if (!queued) continue;
      if (r.status === 'rejected') {
        rejections.push({
          mutation: queued.mutation,
          code: r.code,
          message: r.message,
          ...(r.details === undefined ? {} : { details: r.details }),
        });
        done.add(queued.seq);
      } else if (r.version === undefined && r.status === 'duplicate') {
        updated.push({ ...queued, awaitingPull: true });
      } else if (r.version === undefined || r.version <= this.cursor) {
        // Nothing to wait for: the mutation changed nothing, or the client has its change already.
        done.add(queued.seq);
      } else {
        updated.push({ ...queued, appliedAt: r.version });
      }
    }
    const lastMutationId = Math.max(this.lastMutationId, resp.lastMutationId);
    // Stored at once, with the last id the server handled: after a reload, ids continue after it, so
    // a new mutation is never answered as a duplicate of an old one (F-32).
    await this.commit({
      pending: { put: updated, delete: [...done] },
      rejections: { add: rejections },
      meta: { lastMutationId, nextMutationIdAtLeast: lastMutationId + 1 },
    });
    const replaced = new Map(updated.map((q) => [q.seq, q]));
    this.pending = this.pending.filter((q) => !done.has(q.seq)).map((q) => replaced.get(q.seq) ?? q);
    this.rejected.push(...rejections);
    this.lastMutationId = lastMutationId;
    this.emit();
  }

  /**
   * Pulls the log page by page up to the head of the first page's snapshot, and no further: under
   * writes faster than a page per request `hasMore` stays true for good, and a sync that waited for
   * it would never end, nor push again (N-1). What came after is the next sync's.
   */
  private async pull(): Promise<void> {
    let target: Version | undefined;
    for (;;) {
      const from = this.cursor;
      const resp = await this.request((init) => this.transport.pull(from, this.id, PAGE_SIZE, init));
      const settled = this.settled(resp, resp.nextCursor);
      const put: Array<[string, Row]> = [];
      const removed: string[] = [];
      for (const change of resp.changes) {
        const key = `${change.entity}/${change.id}`;
        if (change.op === 'put' && change.data) put.push([key, change.data]);
        else removed.push(key);
      }
      await this.commit({
        base: { put, delete: removed },
        pending: { delete: settled.dropped },
        meta: { cursor: resp.nextCursor, ...settled.meta },
        // Lost on a crash, the page is pulled again: the cursor is written with it.
        durability: 'relaxed',
      });
      applyChanges(this.base, resp.changes);
      this.cursor = resp.nextCursor;
      this.apply(settled);
      this.emit();
      target ??= resp.head;
      if (!resp.hasMore || this.cursor >= target) break;
    }
  }

  /**
   * What a pull page settles at `cursor`: the server's last handled id, and the pending mutations
   * whose effect the client then has.
   */
  private settled(resp: PullResponse, cursor: Version) {
    const lastMutationId = Math.max(this.lastMutationId, resp.lastMutationId);
    const dropped = this.pending
      .filter((q) => {
        if (q.appliedAt !== undefined) return q.appliedAt <= cursor;
        if (q.awaitingPull) return !resp.hasMore;
        // A mutation whose answer was lost: the last page comes from the same snapshot as the
        // client's last applied id, so every change of those mutations is in the pages read.
        return !resp.hasMore && q.mutation.id <= resp.lastMutationId;
      })
      .map((q) => q.seq);
    return { dropped, meta: { lastMutationId, nextMutationIdAtLeast: lastMutationId + 1 } };
  }

  private apply(settled: { dropped: number[]; meta: { lastMutationId: number } }): void {
    const dropped = new Set(settled.dropped);
    this.pending = this.pending.filter((q) => !dropped.has(q.seq));
    this.lastMutationId = settled.meta.lastMutationId;
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
   * Reads every page of a snapshot and then the change log from its watermark up to the highest head
   * of the pages into a separate map, and only then makes it the base, with the cursor and the pending
   * mutations settled by the last pull page. Rows of a page may already hold changes after the watermark; the log replays them in
   * commit order, so the staged state ends as the server's, and nothing in between ever reaches the
   * view. The queue is kept: the view is the new base with the remaining pending mutations applied on
   * top (a rebase). An interruption leaves the previous state in place; the next sync starts over.
   */
  private async loadSnapshot(): Promise<void> {
    const staged = new Map<string, Row>();
    let page = await this.request((init) => this.transport.snapshot({ limit: PAGE_SIZE }, init));
    const { watermark } = page;
    // The point of consistency: no row read holds a change after it (SnapshotPage.head).
    let consistentAt = page.head;
    for (;;) {
      if (page.head > consistentAt) consistentAt = page.head;
      for (const row of page.rows) staged.set(`${row.entity}/${row.id}`, row.data);
      if (page.next === null) break;
      const after = page.next;
      page = await this.request((init) => this.transport.snapshot({ watermark, after, limit: PAGE_SIZE }, init));
    }
    let cursor = watermark;
    let last: PullResponse;
    do {
      const from = cursor;
      last = await this.request((init) => this.transport.pull(from, this.id, PAGE_SIZE, init));
      applyChanges(staged, last.changes);
      cursor = last.nextCursor;
      // Once the log is read up to the point of consistency the staged rows are one state of the
      // server: installed now, however fast others write meanwhile (waiting for a page without more
      // changes never ends under constant writes, №2). The rest comes with the next pulls.
    } while (last.hasMore && cursor < consistentAt);
    const settled = this.settled(last, cursor);
    await this.commit({
      base: { replace: true, put: [...staged] },
      pending: { delete: settled.dropped },
      meta: { cursor, ...settled.meta },
      durability: 'relaxed',
    });
    this.base = staged;
    this.cursor = cursor;
    this.hasState = true;
    this.apply(settled);
    this.emit();
  }

  private setStatus(status: SyncStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    this.emit();
  }

  /**
   * Retries after a failed sync, with exponential backoff and full jitter (see {@link backoffDelay}):
   * never sooner than a `Retry-After` the server sent. A successful sync resets the delay.
   */
  private scheduleRetry(err: unknown): void {
    if (this.disposed) return;
    if (this.retryTimer) this.clock.clearTimeout(this.retryTimer);
    const retryAfterMs = err instanceof TransportError ? (err.retryAfterSeconds ?? 0) * 1000 : 0;
    const delay = backoffDelay(this.failures, this.backoff, this.random, retryAfterMs);
    this.failures += 1;
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = undefined;
      void this.sync();
    }, delay);
  }

  private emit(): void {
    this.changeCount += 1;
    for (const listener of this.listeners) listener();
  }
}

/** A new client id: a random UUID (browsers expose it in secure contexts only, see README). */
function randomClientId(): string {
  return globalThis.crypto.randomUUID();
}
