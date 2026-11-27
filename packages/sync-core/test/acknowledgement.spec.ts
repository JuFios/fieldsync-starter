import { MemoryStorage, SyncClient, type Change, type PullResponse, type PushRequest, type PushResponse } from '../src';

const SITE = '33333333-3333-4333-8333-333333333333';
const TICKET = '00000000-0000-4000-8000-000000000001';

const ticketChange = (version: number): Change => ({
  version,
  entity: 'ticket',
  id: TICKET,
  siteId: SITE,
  op: 'put',
  data: { id: TICKET, siteId: SITE, title: 'Mine', description: '', status: 'open' },
});

/** Applies every pushed mutation at the given log version; pulls answer from a script, or fail. */
class ScriptedTransport {
  pulls: Array<() => Promise<PullResponse>> = [];

  push(req: PushRequest): Promise<PushResponse> {
    return Promise.resolve({
      results: req.mutations.map((m) => ({ id: m.id, status: 'applied' as const, version: 3 })),
      lastMutationId: req.mutations.at(-1)?.id ?? 0,
    });
  }

  pull(): Promise<PullResponse> {
    const next = this.pulls.shift();
    return next ? next() : Promise.reject(new Error('offline'));
  }
}

function client(transport: ScriptedTransport): SyncClient {
  return new SyncClient({ clientId: 'c1', transport, storage: new MemoryStorage() });
}

/**
 * A mutation the server applied stays in the optimistic view until the client has its effect, that
 * is until the client's cursor reaches the version of the mutation's last change. Before that the
 * view would lose the user's change whenever the sync is interrupted.
 */
describe('acknowledged mutations', () => {
  it('stay visible when the pull after the push fails', async () => {
    const transport = new ScriptedTransport();
    const c = client(transport);
    try {
      c.mutate('ticket.create', { id: TICKET, siteId: SITE, title: 'Mine', description: '' });
      await c.sync();
      expect(c.rows('ticket').map((t) => t.title)).toEqual(['Mine']);
    } finally {
      c.dispose();
    }
  });

  it('stay visible when a page acknowledges them before the page with their change fails', async () => {
    const transport = new ScriptedTransport();
    // The first page ends before the change; it already reports the mutation as applied.
    transport.pulls = [() => Promise.resolve({ changes: [], nextCursor: 2, hasMore: true, lastMutationId: 1 })];
    const c = client(transport);
    try {
      c.mutate('ticket.create', { id: TICKET, siteId: SITE, title: 'Mine', description: '' });
      await c.sync();
      expect(c.rows('ticket').map((t) => t.title)).toEqual(['Mine']);
    } finally {
      c.dispose();
    }
  });

  it('leave the queue once the pull delivers their change, and are not applied twice', async () => {
    const transport = new ScriptedTransport();
    transport.pulls = [
      () => Promise.resolve({ changes: [ticketChange(3)], nextCursor: 3, hasMore: false, lastMutationId: 1 }),
    ];
    const c = client(transport);
    try {
      c.mutate('ticket.create', { id: TICKET, siteId: SITE, title: 'Mine', description: '' });
      await c.sync();
      expect({ pending: c.pendingCount, titles: c.rows('ticket').map((t) => t.title) }).toEqual({
        pending: 0,
        titles: ['Mine'],
      });
    } finally {
      c.dispose();
    }
  });

  it('stay visible after a duplicate answer without a version, until a pull completes', async () => {
    // A copy answered after the server's results were collected carries no version.
    const transport = new ScriptedTransport();
    transport.push = (req: PushRequest) =>
      Promise.resolve({
        results: req.mutations.map((m) => ({ id: m.id, status: 'duplicate' as const })),
        lastMutationId: req.mutations.at(-1)?.id ?? 0,
      });
    const c = client(transport);
    try {
      c.mutate('ticket.create', { id: TICKET, siteId: SITE, title: 'Mine', description: '' });
      await c.sync();
      expect({ pending: c.pendingCount, titles: c.rows('ticket').map((t) => t.title) }).toEqual({
        pending: 1,
        titles: ['Mine'],
      });
      transport.pulls = [
        () => Promise.resolve({ changes: [ticketChange(3)], nextCursor: 3, hasMore: false, lastMutationId: 1 }),
      ];
      await c.sync();
      expect({ pending: c.pendingCount, titles: c.rows('ticket').map((t) => t.title) }).toEqual({
        pending: 0,
        titles: ['Mine'],
      });
    } finally {
      c.dispose();
    }
  });
});
