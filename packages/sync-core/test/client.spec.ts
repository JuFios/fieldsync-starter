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

  it.todo('keeps unsynced mutations across a reload');
  it.todo('does not lose mutations when two tabs share one clientId');
});
