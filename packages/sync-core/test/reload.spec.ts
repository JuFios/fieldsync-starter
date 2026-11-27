import {
  MemoryStorage,
  SyncClient,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  type SnapshotPage,
} from '../src';

const SITE = '33333333-3333-4333-8333-333333333333';
const TICKETS = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];

/** A server that applies every mutation it has not seen and answers copies as duplicates; pulls fail. */
class OfflinePullServer {
  readonly pushed: number[][] = [];
  private last = 0;

  push(req: PushRequest): Promise<PushResponse> {
    this.pushed.push(req.mutations.map((m) => m.id));
    const results = req.mutations.map((m) => {
      if (m.id <= this.last) return { id: m.id, status: 'duplicate' as const, version: m.id };
      this.last = m.id;
      return { id: m.id, status: 'applied' as const, version: m.id };
    });
    return Promise.resolve({ results, lastMutationId: this.last });
  }

  pull(): Promise<PullResponse> {
    return Promise.reject(new Error('offline'));
  }

  snapshot(): Promise<SnapshotPage> {
    return Promise.reject(new Error('offline'));
  }
}

/**
 * The page reloads after a push was applied but before any pull completed. A new mutation must get
 * an id the server has not handled yet; otherwise the server answers it as a duplicate of the old
 * one and the client drops it without it ever being applied.
 */
describe('mutation ids across a reload', () => {
  it('gives the first mutation after a reload an id the server has not handled', async () => {
    const server = new OfflinePullServer();
    const storage = new MemoryStorage();
    const before = new SyncClient({ clientId: 'c1', transport: server, storage });
    try {
      before.mutate('ticket.create', { id: TICKETS[0], siteId: SITE, title: 'First', description: '' });
      await before.sync();
    } finally {
      before.dispose();
    }

    const after = new SyncClient({ clientId: 'c1', transport: server, storage });
    try {
      after.mutate('ticket.create', { id: TICKETS[1], siteId: SITE, title: 'Second', description: '' });
      await after.sync();
      expect(server.pushed).toEqual([[1], [2]]);
    } finally {
      after.dispose();
    }
  });
});
