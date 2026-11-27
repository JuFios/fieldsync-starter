import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import {
  asVersion,
  IdbSyncStorage,
  LOCAL_SCHEMA_VERSION,
  localStorageLegacy,
  SyncClient,
  type PullResponse,
  type PushResponse,
  type SnapshotPage,
  type StorageClosedReason,
  type Transport,
} from '../src';

const SITE = '33333333-3333-4333-8333-333333333333';
const LEGACY_ID = '6f1b1e5c-8a4e-4c1e-9d6f-0a2b3c4d5e6f';
let dbCount = 0;
/** A database name of its own for each test. */
const fresh = () => `fieldsync-test-${(dbCount += 1)}`;
const ticket = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A server that is never reachable. */
const offline: Transport = {
  push: () => Promise.reject(new Error('offline')),
  pull: () => Promise.reject(new Error('offline')),
  snapshot: () => Promise.reject(new Error('offline')),
};

/** `localStorage` as the original client left it. */
function legacyStore(entries: Record<string, string>) {
  const data = new Map(Object.entries(entries));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    removeItem: (k: string) => void data.delete(k),
  };
}

const opened: Array<{ close(): void }> = [];
async function open(name: string, options: Parameters<typeof IdbSyncStorage.open>[1] = {}) {
  const storage = await IdbSyncStorage.open(name, options);
  opened.push(storage);
  return storage;
}
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

describe('IdbSyncStorage', () => {
  it('starts empty, without a client id or a cursor', async () => {
    const storage = await open(fresh());
    await expect(storage.load()).resolves.toEqual({
      meta: {
        clientId: null,
        cursor: null,
        lastMutationId: 0,
        nextMutationId: 1,
        updateRequired: null,
        retiring: null,
      },
      base: new Map(),
      pending: [],
      rejections: [],
    });
  });

  it('keeps the queue, the rejections, the rows and the cursor across a reopen (a reload)', async () => {
    const name = fresh();
    const first = await open(name);
    await first.ensureClientId('client-a');
    const queued = await first.enqueue({ name: 'ticket.create', args: { id: ticket(1) }, queuedAt: 't0' });
    await first.commit({
      meta: { cursor: asVersion(9), lastMutationId: 0 },
      base: { put: [['ticket/x', { id: 'x' }]] },
      rejections: { add: [{ mutation: queued.mutation, code: 'NOT_FOUND', message: 'gone' }] },
    });
    first.close();

    const second = await open(name);
    const state = await second.load();
    expect(state.meta).toMatchObject({ clientId: 'client-a', cursor: 9, nextMutationId: 2 });
    expect(state.base).toEqual(new Map([['ticket/x', { id: 'x' }]]));
    expect(state.pending).toEqual([queued]);
    expect(state.rejections).toEqual([
      { seq: expect.any(Number) as number, mutation: queued.mutation, code: 'NOT_FOUND', message: 'gone' },
    ]);
  });

  it('keeps the first client id it is given', async () => {
    const storage = await open(fresh());
    await expect(storage.ensureClientId('a')).resolves.toBe('a');
    await expect(storage.ensureClientId('b')).resolves.toBe('a');
  });

  it('gives every mutation its own id, also from two connections at once (two tabs)', async () => {
    const name = fresh();
    const [a, b] = [await open(name), await open(name)];
    const queued = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? a : b).enqueue({ name: 'ticket.create', args: { id: ticket(i) }, queuedAt: 't' }),
      ),
    );
    const ids = queued.map((q) => q.mutation.id).sort((x, y) => x - y);
    expect(ids).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect((await a.load()).meta.nextMutationId).toBe(21);
  });

  it('writes a change all or nothing', async () => {
    const storage = await open(fresh());
    await storage.commit({ base: { put: [['ticket/a', { id: 'a' }]] } });
    // The second row cannot be cloned, so the whole transaction aborts, the first row with it.
    await expect(
      storage.commit({
        meta: { cursor: asVersion(5) },
        base: {
          put: [
            ['ticket/b', { id: 'b' }],
            ['ticket/c', { f: () => 1 }],
          ],
        },
      }),
    ).rejects.toThrow();
    const state = await storage.load();
    expect([...state.base.keys()]).toEqual(['ticket/a']);
    expect(state.meta.cursor).toBeNull();
  });

  it('raises the next mutation id, never lowers it', async () => {
    const storage = await open(fresh());
    await storage.commit({ meta: { nextMutationIdAtLeast: 8 } });
    await storage.commit({ meta: { nextMutationIdAtLeast: 3 } });
    expect((await storage.load()).meta.nextMutationId).toBe(8);
  });

  it('replaces the rows of a snapshot and removes queue entries in one write', async () => {
    const storage = await open(fresh());
    const q = await storage.enqueue({ name: 'ticket.create', args: {}, queuedAt: 't' });
    await storage.commit({ base: { put: [['ticket/old', { id: 'old' }]] } });
    await storage.commit({
      base: { replace: true, put: [['ticket/new', { id: 'new' }]] },
      pending: { delete: [q.seq] },
    });
    const state = await storage.load();
    expect([...state.base.keys()]).toEqual(['ticket/new']);
    expect(state.pending).toEqual([]);
  });

  it('restarts under a new client id: handled mutations wait for a pull, the rest is renumbered', async () => {
    const storage = await open(fresh());
    await storage.ensureClientId('old');
    for (let i = 0; i < 4; i += 1) await storage.enqueue({ name: 'ticket.create', args: { n: i }, queuedAt: 't' });
    await storage.restartClient('new', 2);
    const { meta, pending } = await storage.load();
    expect(meta).toMatchObject({ clientId: 'new', lastMutationId: 0, nextMutationId: 3, retiring: null });
    expect(pending.map((q) => [q.mutation.id, q.awaitingPull ?? false])).toEqual([
      [1, true],
      [2, true],
      [1, false],
      [2, false],
    ]);
  });

  it('reads a stored cursor that is not a version as no state, so the client loads a snapshot', async () => {
    const name = fresh();
    (await open(name)).close();
    const raw = await openDB(name, LOCAL_SCHEMA_VERSION);
    const meta = (await raw.get('meta', 'state')) as Record<string, unknown>;
    await raw.put('meta', { ...meta, cursor: -3, lastMutationId: 7, nextMutationId: 8 }, 'state');
    raw.close();

    const { meta: loaded } = await (await open(name)).load();
    expect(loaded).toMatchObject({ cursor: null, lastMutationId: 7, nextMutationId: 8 });
  });

  describe('the original client in localStorage', () => {
    it('takes its client id and continues after its last mutation id, but not its rows', async () => {
      const legacy = legacyStore({
        fs_client_id: LEGACY_ID,
        fs_state: JSON.stringify({ cursor: 12, lastMutationId: 7, base: { 'ticket/x': { id: 'x' } } }),
        fs_token: 'kept',
      });
      const storage = await open(fresh(), { legacy: localStorageLegacy(legacy) });
      const state = await storage.load();
      expect(state.meta).toMatchObject({ clientId: LEGACY_ID, cursor: null, lastMutationId: 7, nextMutationId: 8 });
      expect(state.base).toEqual(new Map());
      // Imported, then removed; the token is not the storage's business.
      expect([...legacy.data.keys()]).toEqual(['fs_token']);
    });

    it('imports once: a second open finds nothing to import', async () => {
      const name = fresh();
      const legacy = legacyStore({ fs_client_id: LEGACY_ID, fs_state: JSON.stringify({ lastMutationId: 3 }) });
      (await open(name, { legacy: localStorageLegacy(legacy) })).close();
      legacy.data.set('fs_client_id', '11111111-1111-4111-8111-111111111111');
      const state = await (await open(name, { legacy: localStorageLegacy(legacy) })).load();
      expect(state.meta.clientId).toBe(LEGACY_ID);
    });

    it.each([
      [
        'a damaged state',
        { fs_client_id: LEGACY_ID, fs_state: '{not json' },
        { clientId: LEGACY_ID, lastMutationId: 0 },
      ],
      [
        'an id that is not a UUID',
        { fs_client_id: 'c1', fs_state: '{"lastMutationId":4}' },
        { clientId: null, lastMutationId: 4 },
      ],
      ['a negative last id', { fs_state: '{"lastMutationId":-1}' }, { clientId: null, lastMutationId: 0 }],
    ])('copes with %s', async (_case, entries, expected) => {
      const storage = await open(fresh(), { legacy: localStorageLegacy(legacyStore(entries)) });
      expect((await storage.load()).meta).toMatchObject(expected);
    });

    it('starts empty when there was no original client', async () => {
      const storage = await open(fresh(), { legacy: localStorageLegacy(legacyStore({})) });
      expect((await storage.load()).meta).toMatchObject({ clientId: null, lastMutationId: 0 });
    });
  });

  describe('other tabs', () => {
    it('closes when another tab deletes the database (signing out), so the deletion is not blocked', async () => {
      const name = fresh();
      const closed: StorageClosedReason[] = [];
      await open(name, { onClosed: (reason) => closed.push(reason) });
      let blocked = false;
      await IdbSyncStorage.delete(name, { onBlocked: () => (blocked = true) });
      expect(closed).toEqual(['deleted']);
      expect(blocked).toBe(false);
      const after = await open(name);
      expect((await after.load()).meta.clientId).toBeNull();
    });

    it('closes for a tab that opens a newer local schema, which then goes on', async () => {
      const name = fresh();
      const closed: StorageClosedReason[] = [];
      await open(name, { onClosed: (reason) => closed.push(reason) });
      // A newer app: its schema is one version up (raw IndexedDB, since this code knows no step 1 → 2).
      const newer = await openDB(name, LOCAL_SCHEMA_VERSION + 1);
      expect(closed).toEqual(['superseded']);
      newer.close();
    });

    it('waits for an older connection that does not close, and reports that it is blocked', async () => {
      const name = fresh();
      // A connection without a versionchange handler, as an app that ignores it would hold.
      const stubborn = await openDB(name, LOCAL_SCHEMA_VERSION, {
        upgrade(db) {
          db.createObjectStore('meta');
        },
      });
      let blocked = false;
      const newer = openDB(name, LOCAL_SCHEMA_VERSION + 1, { blocked: () => (blocked = true) });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(blocked).toBe(true);
      stubborn.close();
      (await newer).close();
    });
  });

  it('serves a client across a reload: the queue is sent after the reload', async () => {
    const name = fresh();
    const before = new SyncClient({ clientId: 'c1', transport: offline, storage: await open(name) });
    await before.mutate('ticket.create', { id: ticket(1), siteId: SITE, title: 'Offline', description: '' });
    before.dispose();

    const pushed: number[] = [];
    const online: Transport = {
      push: (req): Promise<PushResponse> => {
        pushed.push(...req.mutations.map((m) => m.id));
        return Promise.resolve({
          results: req.mutations.map((m) => ({ id: m.id, status: 'applied' as const })),
          lastMutationId: 1,
        });
      },
      pull: (): Promise<PullResponse> =>
        Promise.resolve({
          changes: [],
          nextCursor: asVersion(0),
          hasMore: false,
          lastMutationId: 1,
          head: asVersion(0),
        }),
      snapshot: (): Promise<SnapshotPage> =>
        Promise.resolve({ watermark: asVersion(0), head: asVersion(0), rows: [], next: null }),
    };
    const after = new SyncClient({ clientId: 'c1', transport: online, storage: await open(name) });
    try {
      await after.ready;
      expect(after.rows('ticket').map((t) => t.title)).toEqual(['Offline']);
      await after.sync();
      expect(pushed).toEqual([1]);
      expect(after.pendingCount).toBe(0);
    } finally {
      after.dispose();
    }
  });
});
