import {
  asVersion,
  LocalStorageSyncStorage,
  MemoryStorage,
  SyncClient,
  type Persisted,
  type SnapshotPage,
  type Transport,
} from '../src';

const SITE = '33333333-3333-4333-8333-333333333333';
const TICKET = '00000000-0000-4000-8000-000000000001';
const EMPTY: SnapshotPage = { watermark: asVersion(0), head: asVersion(0), rows: [], next: null };

/** A server that applies everything. */
const transport: Transport = {
  push: (req) =>
    Promise.resolve({
      results: req.mutations.map((m) => ({ id: m.id, status: 'applied' as const })),
      lastMutationId: 1,
    }),
  pull: () =>
    Promise.resolve({ changes: [], nextCursor: asVersion(0), hasMore: false, lastMutationId: 1, head: asVersion(0) }),
  snapshot: () => Promise.resolve(EMPTY),
};

/** Storage that is full: every write fails as browsers report it. */
class FullStorage extends MemoryStorage {
  override save(_state: Persisted): Promise<void> {
    return Promise.reject(new DOMException('The quota has been exceeded.', 'QuotaExceededError'));
  }
}

const clients: SyncClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.dispose();
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

/** A write to the client's storage that fails is reported, never taken for a stored state (F-38). */
describe('a failed write to storage', () => {
  it('is reported as a storage error instead of a synced state', async () => {
    const client = new SyncClient({ clientId: 'c1', transport, storage: new FullStorage() });
    clients.push(client);
    await client.mutate('ticket.create', { id: TICKET, siteId: SITE, title: 'A', description: '' });
    await client.sync();

    expect(client.syncError).toMatchObject({ code: 'STORAGE' });
    expect(client.status).not.toBe('idle');
  });

  it('is not swallowed by the browser storage', async () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      },
    };
    const client = new SyncClient({ clientId: 'c1', transport, storage: new LocalStorageSyncStorage('fs_state') });
    clients.push(client);
    await client.mutate('ticket.create', { id: TICKET, siteId: SITE, title: 'A', description: '' });
    await client.sync();

    expect(client.syncError).toMatchObject({ code: 'STORAGE' });
  });
});
