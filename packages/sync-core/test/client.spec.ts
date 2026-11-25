import { knownDefect } from '@fieldsync/test-kit';
import { MemoryStorage, SyncClient, type Transport } from '../src';
import type { PullResponse, PushRequest, PushResponse } from '../src';

const SITE = '33333333-3333-4333-8333-333333333333';

/** A transport with no network: every request fails. Records the mutation ids of each push attempt. */
class OfflineTransport implements Transport {
  readonly pushedIds: number[][] = [];

  push(req: PushRequest): Promise<PushResponse> {
    this.pushedIds.push(req.mutations.map((m) => m.id));
    return Promise.reject(new Error('offline'));
  }

  pull(): Promise<PullResponse> {
    return Promise.reject(new Error('offline'));
  }
}

/** Rejects every pushed mutation without advancing the client's last applied mutation id. */
class RejectingTransport implements Transport {
  readonly pushedIds: number[][] = [];

  push(req: PushRequest): Promise<PushResponse> {
    this.pushedIds.push(req.mutations.map((m) => m.id));
    return Promise.resolve({
      results: req.mutations.map((m) => ({ id: m.id, status: 'rejected' as const, error: 'NOT_FOUND' })),
      lastMutationId: 0,
    });
  }

  pull(): Promise<PullResponse> {
    return Promise.resolve({ changes: [], nextCursor: 0, hasMore: false, lastMutationId: 0 });
  }
}

/** A transport whose requests never complete unless the caller aborts them. */
class HangingTransport implements Transport {
  pushCalls = 0;

  push(_req: PushRequest, init?: { signal?: AbortSignal }): Promise<PushResponse> {
    this.pushCalls += 1;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }

  pull(_cursor: number, _clientId: string, _limit?: number, init?: { signal?: AbortSignal }): Promise<PullResponse> {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }
}

/**
 * In-memory stand-in for the server's push contract: per client, a mutation with an id at or below
 * the last applied id is a duplicate; the next id is applied.
 */
class FakeServer {
  readonly applied: Array<{ clientId: string; id: number; title: unknown }> = [];
  private readonly last = new Map<string, number>();

  transport(): Transport {
    return {
      push: (req) => {
        const results = req.mutations.map((m) => {
          const last = this.last.get(req.clientId) ?? 0;
          if (m.id <= last) return { id: m.id, status: 'duplicate' as const };
          this.last.set(req.clientId, m.id);
          this.applied.push({ clientId: req.clientId, id: m.id, title: m.args.title });
          return { id: m.id, status: 'applied' as const };
        });
        return Promise.resolve({ results, lastMutationId: this.last.get(req.clientId) ?? 0 });
      },
      pull: (_cursor, clientId) =>
        Promise.resolve({ changes: [], nextCursor: 0, hasMore: false, lastMutationId: this.last.get(clientId) ?? 0 }),
    };
  }
}

function makeClient(transport: Transport = new OfflineTransport()): SyncClient {
  return new SyncClient({ clientId: 'c1', transport, storage: new MemoryStorage() });
}

describe('SyncClient', () => {
  it('shows a locally created ticket before the server confirms it', () => {
    const client = makeClient();
    client.mutate('ticket.create', { siteId: SITE, title: 'Leaking valve', description: '' });
    const tickets = client.rows('ticket');
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ siteId: SITE, title: 'Leaking valve', status: 'open' });
    expect(client.pendingCount).toBe(1);
    client.dispose();
  });

  it('numbers local mutations sequentially', async () => {
    const transport = new OfflineTransport();
    const client = makeClient(transport);
    client.mutate('ticket.create', { siteId: SITE, title: 'A', description: '' });
    client.mutate('ticket.create', { siteId: SITE, title: 'B', description: '' });
    client.mutate('ticket.create', { siteId: SITE, title: 'C', description: '' });
    await client.sync(); // the attempt started by the first mutation
    await client.sync(); // a fresh attempt sends the whole queue
    expect(transport.pushedIds.at(-1)).toEqual([1, 2, 3]);
    expect(client.rows('ticket').map((t) => t.title).sort()).toEqual(['A', 'B', 'C']);
    client.dispose();
  });

  knownDefect(
    { id: 'F-09', owner: 'PR3', reason: 'mutation ids are derived from lastMutationId + queue length' },
    'never reuses a mutation id after the server rejects a mutation',
    async () => {
      const transport = new RejectingTransport();
      const client = makeClient(transport);
      client.mutate('ticket.update', { id: SITE, siteId: SITE, title: 'gone', description: '' });
      await client.sync();
      client.mutate('ticket.create', { siteId: SITE, title: 'next', description: '' });
      await client.sync();
      client.dispose();
      const [first, second] = transport.pushedIds;
      expect(first).toEqual([1]);
      expect(second).toEqual([2]);
    },
  );

  knownDefect(
    { id: 'F-13', owner: 'PR5', reason: 'requests have no timeout, so a hung request blocks syncing forever' },
    'gives up on a request that never answers and retries',
    async () => {
      jest.useFakeTimers();
      const transport = new HangingTransport();
      const client = makeClient(transport);
      try {
        client.mutate('ticket.create', { siteId: SITE, title: 'Stuck', description: '' });
        expect(client.status).toBe('syncing');
        await jest.advanceTimersByTimeAsync(5 * 60_000);
        expect(client.status).not.toBe('syncing');
        expect(transport.pushCalls).toBeGreaterThan(1);
      } finally {
        client.dispose();
        jest.useRealTimers();
      }
    },
  );

  knownDefect(
    { id: 'F-10', owner: 'PR5', reason: 'the pending queue is never persisted' },
    'keeps unsynced mutations across a reload',
    async () => {
      const storage = new MemoryStorage();
      const before = new SyncClient({ clientId: 'c1', transport: new OfflineTransport(), storage });
      before.mutate('ticket.create', { siteId: SITE, title: 'Written offline', description: '' });
      await before.sync();
      before.dispose();

      const after = new SyncClient({ clientId: 'c1', transport: new OfflineTransport(), storage });
      try {
        expect(after.pendingCount).toBe(1);
        expect(after.rows('ticket').map((t) => t.title)).toEqual(['Written offline']);
      } finally {
        after.dispose();
      }
    },
  );

  knownDefect(
    { id: 'F-11', owner: 'PR5', reason: 'tabs sharing one clientId allocate the same mutation ids' },
    'does not lose mutations when two tabs share one clientId',
    async () => {
      const server = new FakeServer();
      const storage = new MemoryStorage();
      const tabA = new SyncClient({ clientId: 'c1', transport: server.transport(), storage });
      const tabB = new SyncClient({ clientId: 'c1', transport: server.transport(), storage });
      tabA.mutate('ticket.create', { siteId: SITE, title: 'From tab A', description: '' });
      await tabA.sync();
      tabB.mutate('ticket.create', { siteId: SITE, title: 'From tab B', description: '' });
      await tabB.sync();
      tabA.dispose();
      tabB.dispose();
      expect(server.applied.map((m) => m.title).sort()).toEqual(['From tab A', 'From tab B']);
    },
  );
});
