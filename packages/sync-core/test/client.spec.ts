import { knownDefect, precondition } from '@fieldsync/test-kit';
import { MemoryStorage, SyncClient, type SyncClientOptions, type TimerHandle, type Transport } from '../src';
import type { SyncClock } from '../src';
import type { PullResponse, PushRequest, PushResponse } from '../src';

const SITE = '33333333-3333-4333-8333-333333333333';

let nextTicket = 0;
/** A fresh ticket id for each create, as the caller of `mutate` generates it. */
function ticketId(): string {
  nextTicket += 1;
  return `00000000-0000-4000-8000-${String(nextTicket).padStart(12, '0')}`;
}

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
      results: req.mutations.map((m) => ({
        id: m.id,
        status: 'rejected' as const,
        code: 'NOT_FOUND' as const,
        message: 'Ticket no longer exists',
      })),
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

/** A clock that moves only when the test advances it. */
class ManualClock implements SyncClock {
  private time = Date.parse('2030-01-01T00:00:00.000Z');
  private readonly timers = new Map<TimerHandle, { at: number; callback: () => void }>();

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number): TimerHandle {
    const handle = {} as TimerHandle;
    this.timers.set(handle, { at: this.time + ms, callback });
    return handle;
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle);
  }

  get pendingTimers(): number {
    return this.timers.size;
  }

  /** Moves time forward and runs the timers that fall due, in order. */
  async advance(ms: number): Promise<void> {
    this.time += ms;
    for (const [handle, timer] of [...this.timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > this.time) break;
      this.timers.delete(handle);
      timer.callback();
      await new Promise((r) => setImmediate(r));
    }
  }
}

/**
 * Every client a test creates, disposed after each test: a client that is not disposed keeps a
 * retry timer alive, so a failing assertion would otherwise leave Jest hanging instead of failing.
 */
const clients: SyncClient[] = [];

function newClient(opts: SyncClientOptions): SyncClient {
  const client = new SyncClient(opts);
  clients.push(client);
  return client;
}

function makeClient(transport: Transport = new OfflineTransport()): SyncClient {
  return newClient({ clientId: 'c1', transport, storage: new MemoryStorage() });
}

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  jest.useRealTimers();
});

describe('SyncClient', () => {
  it('shows a locally created ticket before the server confirms it', () => {
    const client = makeClient();
    client.mutate('ticket.create', { id: ticketId(), siteId: SITE, title: 'Leaking valve', description: '' });
    const tickets = client.rows('ticket');
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ siteId: SITE, title: 'Leaking valve', status: 'open' });
    expect(client.pendingCount).toBe(1);
  });

  it('keeps an optimistic ticket under the id the caller chose', () => {
    const client = makeClient();
    const id = '44444444-4444-4444-8444-444444444444';
    client.mutate('ticket.create', { id, siteId: SITE, title: 'Leaking valve', description: '' });
    expect(client.rows('ticket').map((t) => t.id)).toEqual([id]);
    expect(client.rows('ticket').map((t) => t.id)).toEqual([id]);
  });

  it('keeps the timestamps of an optimistic ticket stable while it waits for the server', () => {
    jest.useFakeTimers({ now: new Date('2030-01-01T00:00:00.000Z') });
    const client = makeClient();
    client.mutate('ticket.create', { id: ticketId(), siteId: SITE, title: 'Leaking valve', description: '' });
    const before = client.rows('ticket')[0];
    jest.setSystemTime(new Date('2030-01-01T00:10:00.000Z'));
    const after = client.rows('ticket')[0];
    expect(after).toEqual(before);
    expect(before.createdAt).toBe('2030-01-01T00:00:00.000Z');
  });

  it('queues the arguments as they were when mutate was called', () => {
    const client = makeClient();
    const args = { id: ticketId(), siteId: SITE, title: 'Typed by the user', description: '' };
    client.mutate('ticket.create', args);
    args.title = 'Changed by the caller afterwards';
    expect(client.rows('ticket').map((t) => t.title)).toEqual(['Typed by the user']);
  });

  it('refuses arguments that cannot be sent instead of blocking the queue behind them', async () => {
    const server = new FakeServer();
    const client = makeClient(server.transport());
    const unsendable = { id: ticketId(), siteId: SITE, title: 'Big', description: '', estimate: 10n };
    expect(() => client.mutate('ticket.create', unsendable)).toThrow(TypeError);
    expect(client.pendingCount).toBe(0);

    client.mutate('ticket.create', { id: ticketId(), siteId: SITE, title: 'Next', description: '' });
    await client.sync();
    expect(client.status).toBe('idle');
    expect(server.applied.map((m) => m.title)).toEqual(['Next']);
  });

  it('retries and stamps optimistic rows on the clock it is given', async () => {
    const clock = new ManualClock();
    const transport = new OfflineTransport();
    const client = newClient({ clientId: 'c1', transport, storage: new MemoryStorage(), clock });
    client.mutate('ticket.create', { id: ticketId(), siteId: SITE, title: 'A', description: '' });
    await client.sync();
    expect(client.rows('ticket')[0].createdAt).toBe('2030-01-01T00:00:00.000Z');
    expect(transport.pushedIds).toHaveLength(1);
    expect(clock.pendingTimers).toBe(1);

    await clock.advance(4_999);
    expect(transport.pushedIds).toHaveLength(1);
    await clock.advance(1);
    expect(transport.pushedIds).toHaveLength(2);

    client.dispose();
    expect(clock.pendingTimers).toBe(0);
  });

  it('numbers local mutations sequentially', async () => {
    const transport = new OfflineTransport();
    const client = makeClient(transport);
    client.mutate('ticket.create', { id: ticketId(), siteId: SITE, title: 'A', description: '' });
    client.mutate('ticket.create', { id: ticketId(), siteId: SITE, title: 'B', description: '' });
    client.mutate('ticket.create', { id: ticketId(), siteId: SITE, title: 'C', description: '' });
    await client.sync(); // the attempt started by the first mutation
    await client.sync(); // a fresh attempt sends the whole queue
    expect(transport.pushedIds.at(-1)).toEqual([1, 2, 3]);
    expect(
      client
        .rows('ticket')
        .map((t) => t.title)
        .sort(),
    ).toEqual(['A', 'B', 'C']);
  });

  it('keeps the code, message and details of a rejection and drops the mutation from the queue', async () => {
    const details = { current: 'done' as const, allowed: ['open' as const] };
    const transport: Transport = {
      push: (req) =>
        Promise.resolve({
          results: req.mutations.map((m) => ({
            id: m.id,
            status: 'rejected' as const,
            code: 'STATUS_CONFLICT' as const,
            message: 'Status is now "done"',
            details,
          })),
          lastMutationId: 1,
        }),
      pull: () => Promise.resolve({ changes: [], nextCursor: 0, hasMore: false, lastMutationId: 1 }),
    };
    const client = makeClient(transport);
    client.mutate('ticket.setStatus', { id: SITE, siteId: SITE, from: 'open', to: 'in_progress' });
    await client.sync();
    expect(client.rejections).toEqual([
      {
        mutation: expect.objectContaining({ id: 1, name: 'ticket.setStatus' }),
        code: 'STATUS_CONFLICT',
        message: 'Status is now "done"',
        details,
      },
    ]);
    expect(client.pendingCount).toBe(0);
  });

  it('never reuses a mutation id after the server rejects a mutation', async () => {
    const transport = new RejectingTransport();
    const client = makeClient(transport);
    client.mutate('ticket.update', { id: SITE, siteId: SITE, title: 'gone', description: '' });
    await client.sync();
    client.mutate('ticket.create', { id: ticketId(), siteId: SITE, title: 'next', description: '' });
    await client.sync();
    const [first, second] = transport.pushedIds;
    precondition(first?.length === 1 && first[0] === 1, `first push sent ids ${JSON.stringify(first)}`);
    expect(second).toEqual([2]);
  });

  knownDefect(
    {
      id: 'F-13',
      owner: 'offline-client',
      reason: 'requests have no timeout, so a hung request blocks syncing forever',
    },
    'gives up on a request that never answers and retries',
    async () => {
      jest.useFakeTimers();
      const transport = new HangingTransport();
      const client = makeClient(transport);
      client.mutate('ticket.create', { id: ticketId(), siteId: SITE, title: 'Stuck', description: '' });
      precondition(client.status === 'syncing', `status is ${client.status} right after mutate`);
      await jest.advanceTimersByTimeAsync(5 * 60_000);
      expect(client.status).not.toBe('syncing');
      expect(transport.pushCalls).toBeGreaterThan(1);
    },
  );

  knownDefect(
    { id: 'F-10', owner: 'offline-client', reason: 'the pending queue is never persisted' },
    'keeps unsynced mutations across a reload',
    async () => {
      const storage = new MemoryStorage();
      const before = newClient({ clientId: 'c1', transport: new OfflineTransport(), storage });
      before.mutate('ticket.create', { id: ticketId(), siteId: SITE, title: 'Written offline', description: '' });
      await before.sync();
      before.dispose(); // the page goes away

      const after = newClient({ clientId: 'c1', transport: new OfflineTransport(), storage });
      expect(after.pendingCount).toBe(1);
      expect(after.rows('ticket').map((t) => t.title)).toEqual(['Written offline']);
    },
  );

  knownDefect(
    { id: 'F-11', owner: 'offline-client', reason: 'tabs sharing one clientId allocate the same mutation ids' },
    'does not lose mutations when two tabs share one clientId',
    async () => {
      const server = new FakeServer();
      const storage = new MemoryStorage();
      const tabA = newClient({ clientId: 'c1', transport: server.transport(), storage });
      const tabB = newClient({ clientId: 'c1', transport: server.transport(), storage });
      tabA.mutate('ticket.create', { id: ticketId(), siteId: SITE, title: 'From tab A', description: '' });
      await tabA.sync();
      tabB.mutate('ticket.create', { id: ticketId(), siteId: SITE, title: 'From tab B', description: '' });
      await tabB.sync();
      expect(server.applied.map((m) => m.title).sort()).toEqual(['From tab A', 'From tab B']);
    },
  );
});
