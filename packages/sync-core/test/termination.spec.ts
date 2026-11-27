import {
  asVersion,
  MemoryStorage,
  SyncClient,
  type Change,
  type PullResponse,
  type PushResponse,
  type SnapshotPage,
  type Transport,
} from '../src';

const SITE = '33333333-3333-4333-8333-333333333333';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const change = (version: number): Change => ({
  version: asVersion(version),
  entity: 'ticket',
  id: id(version),
  siteId: SITE,
  op: 'put',
  data: { id: id(version), title: `t${version}` },
});

/**
 * A server under constant writes: every request finds 600 new changes, so a page of 500 always has
 * more after it, and the head runs ahead of every cursor.
 */
class BusyServer implements Transport {
  head = 1_000;
  pulls = 0;
  snapshots = 0;

  push(): Promise<PushResponse> {
    return Promise.reject(new Error('nothing to push'));
  }

  snapshot(): Promise<SnapshotPage> {
    this.snapshots += 1;
    this.head += 600;
    return Promise.resolve({ watermark: asVersion(1_000), head: asVersion(this.head), rows: [], next: null });
  }

  pull(cursor: number, _clientId: string, limit = 500): Promise<PullResponse> {
    this.pulls += 1;
    if (this.pulls > 1_000) return Promise.reject(new Error('the client never stops pulling'));
    this.head += 600;
    const changes = Array.from({ length: Math.min(limit, this.head - cursor) }, (_, i) => change(cursor + i + 1));
    return Promise.resolve({
      changes,
      nextCursor: asVersion(cursor + changes.length),
      hasMore: cursor + changes.length < this.head,
      lastMutationId: 0,
      head: asVersion(this.head),
    });
  }
}

const clients: SyncClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.dispose();
});
function client(transport: Transport, storage = new MemoryStorage()) {
  const c = new SyncClient({ clientId: 'c1', transport, storage, live: false });
  clients.push(c);
  return c;
}

describe('a sync under constant writes', () => {
  it('installs a snapshot once its tail reaches the point of consistency, so loading ends (№2)', async () => {
    const server = new BusyServer();
    const c = client(server);
    await c.sync();
    expect(c.status).toBe('idle');
    // The snapshot page was read at head 1600; the tail stops at the first cursor at or past it.
    expect(server.pulls).toBe(2);
    expect(c.rows('ticket')).toHaveLength(1_000);
  });

  it('ends a pull at the head of its first page instead of chasing the log (N-1)', async () => {
    const server = new BusyServer();
    const c = client(server);
    await c.sync();
    const before = server.pulls;
    await c.sync();
    expect(c.status).toBe('idle');
    // The first page saw head h; 500 changes a page reach it after a bounded number of pages.
    expect(server.pulls - before).toBeLessThanOrEqual(4);
    await c.sync();
    expect(c.status).toBe('idle');
  });
});

describe('a client restarted before its first state arrived (№5)', () => {
  it('starts with a snapshot after the restart, not with the log from 0', async () => {
    const storage = new MemoryStorage();
    const pulls: number[] = [];
    let snapshots = 0;
    const server: Transport = {
      push: (req) =>
        Promise.resolve({
          results: req.mutations.map((m) => ({ id: m.id, status: 'applied' as const })),
          lastMutationId: 1,
        }),
      // The pull after the push never answers: the page closes before the client has a state.
      pull: () => new Promise<PullResponse>(() => undefined),
      snapshot: () => {
        snapshots += 1;
        return new Promise<SnapshotPage>(() => undefined);
      },
    };
    const first = client(server, storage);
    await first.mutate('ticket.create', { id: id(1), siteId: SITE, title: 'x', description: '' });
    await new Promise((r) => setTimeout(r, 10));
    first.dispose();
    expect((await storage.load()).meta).toMatchObject({ cursor: null, lastMutationId: 1 });

    const second = client(
      { ...server, pull: (cursor) => (pulls.push(cursor), new Promise<PullResponse>(() => undefined)) },
      storage,
    );
    void second.sync();
    await new Promise((r) => setTimeout(r, 10));
    expect(pulls).toEqual([]);
    expect(snapshots).toBe(2);
  });
});
