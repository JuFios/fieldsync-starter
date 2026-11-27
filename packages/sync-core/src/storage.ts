import type { Mutation, MutatorName, Rejection, Row, Version } from './types';

/**
 * The format version of a queued mutation (`StoredMutation.v`): what its name and arguments mean.
 * A queue written by a newer app may hold formats this code does not know; those are kept, not sent
 * (see `SyncClient`), until the app is updated.
 */
export const MUTATION_FORMAT_VERSION = 1;

/** A mutation in the client's queue, as stored. */
export interface StoredMutation {
  /** Position in the queue (storage key); grows with every queued mutation, never reused. */
  seq: number;
  /** Format version of `mutation`, see {@link MUTATION_FORMAT_VERSION}. */
  v: number;
  mutation: Mutation;
  /** When it was queued: its optimistic timestamp. */
  queuedAt: string;
  /**
   * Set once the server applied the mutation: the change-log version of its last change. It stays in
   * the queue, and in the optimistic view, until the cursor reaches this version (F-30); it is not
   * sent again.
   */
  appliedAt?: Version;
  /**
   * Set when the server answered a copy as a duplicate without a version (its result was collected),
   * or the mutation was handled under a client id the client gave up: its change's version is
   * unknown, so it stays in the view until a pull completes, and is not sent again.
   */
  awaitingPull?: true;
}

/** A mutation the server refused, with its reason, kept until the user dismisses it. */
export interface StoredRejection extends Rejection {
  seq: number;
  mutation: Mutation;
}

/** Why the server refused this client's protocol version, and what it accepts. */
export interface UpdateRequired {
  /** The protocol version that was refused. */
  version: number;
  min: number;
  max: number;
}

/** The client's own state next to the server's rows. */
export interface SyncMeta {
  /** Null until the client picked one (on its first start). */
  clientId: string | null;
  /** Null while the client has no state read from the server: it then starts with a snapshot. */
  cursor: Version | null;
  /** The last mutation id the server handled for `clientId`. */
  lastMutationId: number;
  /** The id the next queued mutation gets. */
  nextMutationId: number;
  /** Set when the server refused the protocol version this client speaks. */
  updateRequired: UpdateRequired | null;
  /** A client id being given up after a 409 (see `SyncClient`); cleared once it is retired. */
  retiring: string | null;
}

/** Everything a client keeps. */
export interface StoredState {
  meta: SyncMeta;
  /** The server's rows by `entity/id`. */
  base: Map<string, Row>;
  /** The queue, oldest first. */
  pending: StoredMutation[];
  rejections: StoredRejection[];
}

/** A mutation to queue; the storage gives it its id and queue position. */
export interface NewMutation {
  name: MutatorName;
  args: Record<string, unknown>;
  queuedAt: string;
}

/**
 * Changes of the stored state that are written together, in one transaction: all or nothing.
 * `nextMutationId` only grows: `nextMutationIdAtLeast` raises it, never lowers it.
 */
export interface StateChange {
  meta?: Partial<Omit<SyncMeta, 'clientId' | 'nextMutationId'>> & { nextMutationIdAtLeast?: number };
  base?: {
    /** Remove every row first (a snapshot replaces the state). */
    replace?: boolean;
    put?: ReadonlyArray<readonly [string, Row]>;
    delete?: readonly string[];
  };
  /** Queue entries by `seq`: `put` replaces stored entries (it never adds one), `delete` removes them. */
  pending?: { put?: readonly StoredMutation[]; delete?: readonly number[] };
  rejections?: { add?: ReadonlyArray<Omit<StoredRejection, 'seq'>>; clear?: boolean };
  /**
   * `strict` (the default) waits until the write is on disk where the storage can tell (IndexedDB
   * durability); `relaxed` is enough for what the server can send again (pull pages, snapshots).
   */
  durability?: 'strict' | 'relaxed';
}

/**
 * Where a client keeps its state between page loads. Every write is one atomic operation, so a page
 * that closes at any point leaves the state either before or after it; a write the storage refuses
 * rejects (a full quota), it is never ignored.
 */
export interface SyncStorage {
  load(): Promise<StoredState>;
  /** The queue and the rejections only (what other tabs add to), without reading every row. */
  loadQueue(): Promise<Pick<StoredState, 'pending' | 'rejections'>>;
  /** The client id: the stored one, or else `candidate`, which is then stored. */
  ensureClientId(candidate: string): Promise<string>;
  /**
   * Gives the mutation the next id and queue position and stores it, in one transaction: two tabs on
   * one storage never give two mutations the same id.
   */
  enqueue(entry: NewMutation): Promise<StoredMutation>;
  commit(change: StateChange): Promise<void>;
  /**
   * Continues under a new client id after the old one was given up (a 409): unsent mutations with an
   * id up to `lastHandled` were handled under the old id and wait for a pull; the others are
   * renumbered from 1, in queue order, under the new id. One transaction.
   */
  restartClient(clientId: string, lastHandled: number): Promise<void>;
  close(): void;
}

function emptyMeta(): SyncMeta {
  return { clientId: null, cursor: null, lastMutationId: 0, nextMutationId: 1, updateRequired: null, retiring: null };
}

/** What a state change does to the meta record (shared by the storages). */
export function changedMeta(meta: SyncMeta, change: StateChange['meta']): SyncMeta {
  if (!change) return meta;
  const { nextMutationIdAtLeast, ...rest } = change;
  const next = { ...meta, ...rest };
  if (nextMutationIdAtLeast !== undefined) next.nextMutationId = Math.max(next.nextMutationId, nextMutationIdAtLeast);
  return next;
}

/** The queue after a restart under a new client id (shared by the storages, see `restartClient`). */
export function restartedQueue(pending: readonly StoredMutation[], lastHandled: number): StoredMutation[] {
  let id = 0;
  return pending.map((q) => {
    if (q.appliedAt !== undefined || q.awaitingPull) return q;
    if (q.mutation.id <= lastHandled) return { ...q, awaitingPull: true };
    id += 1;
    return { ...q, mutation: { ...q.mutation, id } };
  });
}

/**
 * Storage in memory: for tests and the simulation, and for a client that must not keep anything.
 * Several clients given the same instance share it as tabs share IndexedDB; a new client on it sees
 * what the previous one stored, as after a reload.
 */
export class MemoryStorage implements SyncStorage {
  private meta = emptyMeta();
  private readonly base = new Map<string, Row>();
  private pending: StoredMutation[] = [];
  private rejections: StoredRejection[] = [];
  private seq = 0;

  load(): Promise<StoredState> {
    return Promise.resolve(
      structuredClone({
        meta: this.meta,
        base: this.base,
        pending: this.pending,
        rejections: this.rejections,
      }),
    );
  }

  loadQueue(): Promise<Pick<StoredState, 'pending' | 'rejections'>> {
    return Promise.resolve(structuredClone({ pending: this.pending, rejections: this.rejections }));
  }

  ensureClientId(candidate: string): Promise<string> {
    this.meta.clientId ??= candidate;
    return Promise.resolve(this.meta.clientId);
  }

  enqueue(entry: NewMutation): Promise<StoredMutation> {
    this.seq += 1;
    const stored: StoredMutation = {
      seq: this.seq,
      v: MUTATION_FORMAT_VERSION,
      mutation: { id: this.meta.nextMutationId, name: entry.name, args: structuredClone(entry.args) },
      queuedAt: entry.queuedAt,
    };
    this.meta.nextMutationId += 1;
    this.pending.push(stored);
    return Promise.resolve(structuredClone(stored));
  }

  commit(change: StateChange): Promise<void> {
    const c = structuredClone({ ...change, durability: undefined });
    this.meta = changedMeta(this.meta, c.meta);
    if (c.base?.replace) this.base.clear();
    for (const [key, row] of c.base?.put ?? []) this.base.set(key, row);
    for (const key of c.base?.delete ?? []) this.base.delete(key);
    const replaced = new Map((c.pending?.put ?? []).map((q) => [q.seq, q]));
    const removed = new Set(c.pending?.delete ?? []);
    this.pending = this.pending.filter((q) => !removed.has(q.seq)).map((q) => replaced.get(q.seq) ?? q);
    if (c.rejections?.clear) this.rejections = [];
    for (const r of c.rejections?.add ?? []) {
      this.seq += 1;
      this.rejections.push({ ...r, seq: this.seq });
    }
    return Promise.resolve();
  }

  restartClient(clientId: string, lastHandled: number): Promise<void> {
    this.pending = restartedQueue(this.pending, lastHandled);
    const renumbered = this.pending.filter((q) => q.appliedAt === undefined && !q.awaitingPull).length;
    this.meta = { ...this.meta, clientId, lastMutationId: 0, nextMutationId: renumbered + 1, retiring: null };
    return Promise.resolve();
  }

  close(): void {}
}
