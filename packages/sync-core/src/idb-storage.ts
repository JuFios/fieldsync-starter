import { deleteDB, openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from 'idb';
import {
  changedMeta,
  MUTATION_FORMAT_VERSION,
  restartedQueue,
  type NewMutation,
  type StateChange,
  type StoredMutation,
  type StoredRejection,
  type StoredState,
  type SyncMeta,
  type SyncStorage,
} from './storage';
import { asVersion, type Row, type Version } from './types';

/** The version of the client's local schema (IndexedDB version); each step below upgrades by one. */
export const LOCAL_SCHEMA_VERSION = 1;

const META_KEY = 'state';

/** The local schema, version 1. */
interface SyncDb extends DBSchema {
  /** One record (`META_KEY`): the client's own state. */
  meta: { key: string; value: SyncMeta & { legacyImported?: boolean } };
  /** The server's rows by `entity/id`. */
  base: { key: string; value: Row };
  /** The queue, by queue position (`seq`, generated). */
  pending: { key: number; value: StoredMutation };
  /** Rejected mutations kept for the user, by position (`seq`, generated). */
  rejections: { key: number; value: StoredRejection };
}

type Stores = StoreNames<SyncDb>;
type UpgradeTx = IDBPTransaction<SyncDb, Stores[], 'versionchange'>;
type WriteTx = IDBPTransaction<SyncDb, ['meta', 'base', 'pending', 'rejections'], 'readwrite'>;

/**
 * What the original client kept in `localStorage`: its state (`fs_state`) and its id
 * (`fs_client_id`); it never kept its queue.
 */
export interface LegacyState {
  clientId: string | null;
  lastMutationId: number;
}

/** Where the state of a client before IndexedDB is found, and how it is removed once imported. */
export interface LegacySource {
  read(): LegacyState | null;
  remove(): void;
}

const LEGACY_STATE_KEY = 'fs_state';
const LEGACY_CLIENT_ID_KEY = 'fs_client_id';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The original client's `localStorage` entries, read defensively (they come from an older app and
 * may be damaged). Only the client id and its last handled mutation id are taken: ids then continue
 * where they stopped, so the server sees neither a gap (409) nor an old id again. The rows are not:
 * the key was shared by every user of the browser, so they cannot be told to belong to the user
 * signing in, and the client reloads them from a snapshot anyway (it starts without a cursor).
 */
export function localStorageLegacy(storage: Pick<Storage, 'getItem' | 'removeItem'>): LegacySource {
  return {
    read() {
      const rawId = storage.getItem(LEGACY_CLIENT_ID_KEY);
      const rawState = storage.getItem(LEGACY_STATE_KEY);
      if (rawId === null && rawState === null) return null;
      let lastMutationId = 0;
      try {
        const parsed: unknown = rawState === null ? null : JSON.parse(rawState);
        const last =
          parsed !== null && typeof parsed === 'object' ? (parsed as { lastMutationId?: unknown }).lastMutationId : 0;
        if (typeof last === 'number' && Number.isSafeInteger(last) && last >= 0) lastMutationId = last;
      } catch {
        // A damaged state keeps nothing but the id; the server's answers raise the last id again.
      }
      return { clientId: rawId !== null && UUID.test(rawId) ? rawId.toLowerCase() : null, lastMutationId };
    },
    remove() {
      storage.removeItem(LEGACY_STATE_KEY);
      storage.removeItem(LEGACY_CLIENT_ID_KEY);
    },
  };
}

/** One step of the local schema: from version `i` to `i + 1` (index `i`), inside the upgrade transaction. */
type UpgradeStep = (db: IDBPDatabase<SyncDb>, tx: UpgradeTx, legacy: LegacyState | null) => void;

const STEPS = [
  // 0 → 1: the stores; the original client's id and last mutation id, if there was one.
  (db, tx, legacy) => {
    db.createObjectStore('meta');
    db.createObjectStore('base');
    db.createObjectStore('pending', { keyPath: 'seq', autoIncrement: true });
    db.createObjectStore('rejections', { keyPath: 'seq', autoIncrement: true });
    const meta: SyncMeta & { legacyImported?: boolean } = {
      clientId: legacy?.clientId ?? null,
      cursor: null,
      lastMutationId: legacy?.lastMutationId ?? 0,
      nextMutationId: (legacy?.lastMutationId ?? 0) + 1,
      updateRequired: null,
      retiring: null,
      ...(legacy ? { legacyImported: true } : {}),
    };
    void tx.objectStore('meta').put(meta, META_KEY);
  },
] as const satisfies readonly UpgradeStep[];

/** Why an open storage stopped working. */
export type StorageClosedReason =
  /** Another tab opened a newer local schema (a newer app); this one closed so that tab can go on. */
  | 'superseded'
  /** The database is being deleted (the user signed out in another tab). */
  | 'deleted'
  /** The browser closed the database (storage cleared, a disk error). */
  | 'terminated';

export interface IdbOpenOptions {
  /** State of the original client to import on the first open; read before, removed after, the upgrade. */
  legacy?: LegacySource;
  /** Another tab keeps an older version open, so the upgrade waits until that tab closes it. */
  onBlocked?: () => void;
  /** The storage stopped working; the client using it must stop. */
  onClosed?: (reason: StorageClosedReason) => void;
  /** Local schema version to open (defaults to {@link LOCAL_SCHEMA_VERSION}); for upgrade tests. */
  version?: number;
}

/**
 * Runs the requests of one write transaction and waits for it to complete. A request can fail
 * synchronously (a value IndexedDB cannot clone throws from `put` before any request exists); the
 * transaction would then still commit the requests made before it, so any failure aborts it
 * explicitly: the write is all or nothing.
 */
async function writeAll<T>(tx: { done: Promise<void>; abort(): void }, work: () => Promise<T>): Promise<T> {
  try {
    const [result] = await Promise.all([work(), tx.done]);
    return result;
  } catch (err) {
    try {
      tx.abort();
    } catch {
      // Already finished or aborted: nothing of it was committed after the failure.
    }
    throw err;
  }
}

function isMeta(value: unknown): value is SyncMeta {
  if (value === null || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  return (m.clientId === null || typeof m.clientId === 'string') && count(m.lastMutationId) && count(m.nextMutationId);
}

/** A stored cursor that is not a version (edited or damaged storage) cannot be pulled from: no state. */
function cursorOf(value: unknown): Version | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? asVersion(value) : null;
}

/**
 * The client's state in IndexedDB (through `idb`): one database per user (its name is the user's
 * namespace), with the stores of {@link SyncDb}. Every operation is one transaction that awaits
 * nothing but its own requests (a transaction commits as soon as it has no pending request, so an
 * outside `await` would end it: MDN "Using IndexedDB", `idb` "Transaction lifetime"), and resolves
 * only once it completed (`tx.done`); a failed request aborts it, and the operation rejects (a full
 * quota is a `QuotaExceededError`).
 *
 * Another tab that opens a newer local schema makes this connection `blocking`: it closes at once,
 * so the newer app is not kept waiting, and reports `superseded`. The same happens when another tab
 * deletes the database (signing out).
 */
export class IdbSyncStorage implements SyncStorage {
  private constructor(private readonly db: IDBPDatabase<SyncDb>) {}

  static async open(name: string, options: IdbOpenOptions = {}): Promise<IdbSyncStorage> {
    const target = options.version ?? LOCAL_SCHEMA_VERSION;
    if (target > STEPS.length) throw new RangeError(`no upgrade step to local schema ${target}`);
    // Read before opening: the upgrade transaction must not await anything but its own requests.
    const legacy = options.legacy?.read() ?? null;
    let closedBy: StorageClosedReason | undefined;
    const db = await openDB<SyncDb>(name, target, {
      upgrade(database, oldVersion, newVersion, tx) {
        for (let v = oldVersion; v < (newVersion ?? target); v += 1) {
          const step: UpgradeStep | undefined = STEPS[v];
          step?.(database, tx, v === 0 ? legacy : null);
        }
      },
      blocked: () => options.onBlocked?.(),
      blocking: (_current, blockedVersion) => {
        closedBy = blockedVersion === null ? 'deleted' : 'superseded';
        db.close();
        options.onClosed?.(closedBy);
      },
      terminated: () => {
        if (closedBy === undefined) options.onClosed?.('terminated');
      },
    });
    const storage = new IdbSyncStorage(db);
    await storage.finishLegacyImport(options.legacy);
    return storage;
  }

  /** Deletes a client's database (signing out); waits for other tabs to close it. */
  static delete(name: string, options: { onBlocked?: () => void } = {}): Promise<void> {
    return deleteDB(name, { blocked: () => options.onBlocked?.() });
  }

  /** Removes the original client's entries once their import is stored; idempotent across reloads. */
  private async finishLegacyImport(legacy: LegacySource | undefined): Promise<void> {
    const meta = await this.db.get('meta', META_KEY);
    if (!meta?.legacyImported) return;
    legacy?.remove();
    const tx = this.db.transaction('meta', 'readwrite');
    const current = await tx.store.get(META_KEY);
    if (current) {
      const { legacyImported: _done, ...rest } = current;
      await tx.store.put(rest, META_KEY);
    }
    await tx.done;
  }

  async load(): Promise<StoredState> {
    const tx = this.db.transaction(['meta', 'base', 'pending', 'rejections'], 'readonly');
    const [meta, keys, rows, pending, rejections] = await Promise.all([
      tx.objectStore('meta').get(META_KEY),
      tx.objectStore('base').getAllKeys(),
      tx.objectStore('base').getAll(),
      tx.objectStore('pending').getAll(),
      tx.objectStore('rejections').getAll(),
      tx.done,
    ]);
    if (!isMeta(meta)) throw new Error('The stored client state is damaged');
    const { legacyImported: _imported, ...clean } = meta;
    return {
      // Without a cursor the client reloads a snapshot, which replaces the rows as well.
      meta: { ...clean, cursor: cursorOf(clean.cursor) },
      base: new Map(keys.map((key, i) => [key, rows[i] as Row])),
      pending,
      rejections,
    };
  }

  async ensureClientId(candidate: string): Promise<string> {
    const tx = this.db.transaction('meta', 'readwrite', { durability: 'strict' });
    return writeAll(tx, async () => {
      const meta = await tx.store.get(META_KEY);
      if (!meta) throw new Error('The stored client state is missing');
      const clientId = meta.clientId ?? candidate;
      if (meta.clientId === null) await tx.store.put({ ...meta, clientId }, META_KEY);
      return clientId;
    });
  }

  async enqueue(entry: NewMutation): Promise<StoredMutation> {
    const tx = this.db.transaction(['meta', 'pending'], 'readwrite', { durability: 'strict' });
    return writeAll(tx, async () => {
      const meta = await tx.objectStore('meta').get(META_KEY);
      if (!meta) throw new Error('The stored client state is missing');
      const draft = {
        v: MUTATION_FORMAT_VERSION,
        mutation: { id: meta.nextMutationId, name: entry.name, args: entry.args },
        queuedAt: entry.queuedAt,
      };
      // The key path `seq` is generated: the record is stored without it.
      const seq = await tx.objectStore('pending').add(draft as StoredMutation);
      await tx.objectStore('meta').put({ ...meta, nextMutationId: meta.nextMutationId + 1 }, META_KEY);
      return { ...draft, seq };
    });
  }

  async commit(change: StateChange): Promise<void> {
    const tx = this.db.transaction(['meta', 'base', 'pending', 'rejections'], 'readwrite', {
      durability: change.durability ?? 'strict',
    });
    await writeAll(tx, async () => {
      const work: Array<Promise<unknown>> = [];
      try {
        this.queueChange(tx, change, work);
      } catch (err) {
        // The requests already made end with the abort that follows; their rejections are expected.
        for (const request of work) request.catch(() => undefined);
        throw err;
      }
      await Promise.all(work);
    });
  }

  /** Makes the requests of one state change in `tx`, adding each to `work`. */
  private queueChange(tx: WriteTx, change: StateChange, work: Array<Promise<unknown>>): void {
    if (change.meta) {
      const metaStore = tx.objectStore('meta');
      work.push(
        metaStore.get(META_KEY).then((meta) => {
          if (!meta) throw new Error('The stored client state is missing');
          return metaStore.put(changedMeta(meta, change.meta), META_KEY);
        }),
      );
    }
    const base = tx.objectStore('base');
    if (change.base?.replace) work.push(base.clear());
    for (const key of change.base?.delete ?? []) work.push(base.delete(key));
    for (const [key, row] of change.base?.put ?? []) work.push(base.put(row, key));
    const pending = tx.objectStore('pending');
    for (const seq of change.pending?.delete ?? []) work.push(pending.delete(seq));
    for (const q of change.pending?.put ?? []) work.push(pending.put(q));
    const rejections = tx.objectStore('rejections');
    if (change.rejections?.clear) work.push(rejections.clear());
    for (const r of change.rejections?.add ?? []) work.push(rejections.add(r as StoredRejection));
  }

  async restartClient(clientId: string, lastHandled: number): Promise<void> {
    const tx = this.db.transaction(['meta', 'pending'], 'readwrite', { durability: 'strict' });
    await writeAll(tx, async () => {
      const [meta, queue] = await Promise.all([
        tx.objectStore('meta').get(META_KEY),
        tx.objectStore('pending').getAll(),
      ]);
      if (!meta) throw new Error('The stored client state is missing');
      const restarted = restartedQueue(queue, lastHandled);
      const renumbered = restarted.filter((q) => q.appliedAt === undefined && !q.awaitingPull).length;
      await Promise.all([
        ...restarted.map((q) => tx.objectStore('pending').put(q)),
        tx
          .objectStore('meta')
          .put({ ...meta, clientId, lastMutationId: 0, nextMutationId: renumbered + 1, retiring: null }, META_KEY),
      ]);
    });
  }

  close(): void {
    this.db.close();
  }
}
