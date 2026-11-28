import 'fake-indexeddb/auto';
import {
  asVersion,
  IdbSyncStorage,
  MemoryStorage,
  SyncClient,
  type NewMutation,
  type SnapshotPage,
  type StateChange,
  type StoredMutation,
  type Transport,
  asMutationId,
} from '../src';
import { CLIENT_ID } from './support/ids';

const SITE = '33333333-3333-4333-8333-333333333333';
const TICKET = '00000000-0000-4000-8000-000000000001';
const EMPTY: SnapshotPage = { watermark: asVersion(0), head: asVersion(0), rows: [], next: null };

/** A server that applies everything. */
const transport: Transport = {
  push: (req) =>
    Promise.resolve({
      results: req.mutations.map((m) => ({ id: m.id, status: 'applied' as const })),
      lastMutationId: asMutationId(1),
    }),
  pull: () =>
    Promise.resolve({
      changes: [],
      nextCursor: asVersion(0),
      hasMore: false,
      lastMutationId: asMutationId(1),
      head: asVersion(0),
    }),
  snapshot: () => Promise.resolve(EMPTY),
};

const quota = () => new DOMException('The quota has been exceeded.', 'QuotaExceededError');

/** Storage that is full: every write fails as browsers report it. */
class FullStorage extends MemoryStorage {
  override commit(_change: StateChange): Promise<void> {
    return Promise.reject(quota());
  }
}

/** Storage that becomes full after the queue was written: the answers of the server cannot be kept. */
class FullAfterQueueStorage extends MemoryStorage {
  override enqueue(entry: NewMutation): Promise<StoredMutation> {
    return super.enqueue(entry);
  }

  override commit(_change: StateChange): Promise<void> {
    return Promise.reject(quota());
  }
}

const clients: SyncClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.dispose();
});

/** A write to the client's storage that fails is reported, never taken for a stored state (F-38). */
describe('a failed write to storage', () => {
  it('is reported as a storage error instead of a synced state', async () => {
    const client = new SyncClient({ clientId: CLIENT_ID, transport, storage: new FullAfterQueueStorage() });
    clients.push(client);
    await client.mutate('ticket.create', { id: TICKET, siteId: SITE, title: 'A', description: '' });
    await client.sync();

    expect(client.syncError).toMatchObject({ code: 'STORAGE' });
    expect(client.status).toBe('error');
  });

  it('refuses a mutation it cannot store, and says why', async () => {
    const storage = new FullStorage();
    storage.enqueue = () => Promise.reject(quota());
    const client = new SyncClient({ clientId: CLIENT_ID, transport, storage });
    clients.push(client);

    await expect(
      client.mutate('ticket.create', { id: TICKET, siteId: SITE, title: 'A', description: '' }),
    ).rejects.toMatchObject({ name: 'StorageFailure' });

    expect(client.pendingCount).toBe(0);
    expect(client.rows('ticket')).toEqual([]);
    expect({ status: client.status, error: client.syncError }).toEqual({
      status: 'error',
      error: { status: 0, code: 'STORAGE' },
    });
  });

  it('is not swallowed by the browser storage', async () => {
    const storage = await IdbSyncStorage.open(`storage-errors-${Math.random()}`);
    try {
      // A row IndexedDB cannot clone fails the transaction, as a full quota does.
      await expect(storage.commit({ base: { put: [['ticket/x', { f: () => 1 }]] } })).rejects.toThrow();
      await expect(storage.load()).resolves.toMatchObject({ base: new Map() });
    } finally {
      storage.close();
    }
  });
});
