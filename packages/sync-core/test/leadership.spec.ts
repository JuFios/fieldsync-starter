import {
  asVersion,
  MemoryStorage,
  MUTATION_FORMAT_VERSION,
  PROTOCOL_VERSION,
  SyncClient,
  TabGroup,
  TransportError,
  type PushRequest,
  type SyncStorage,
  type TabCoordinator,
  type Transport,
} from '../src';
import { CLIENT_ID } from './support/ids';

const SITE = '33333333-3333-4333-8333-333333333333';
const ticket = (n: number, title: string) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  siteId: SITE,
  title,
  description: '',
});

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
};

const tooOld = () =>
  new TransportError(400, 'CLIENT_UPDATE_REQUIRED', 'update', { min: PROTOCOL_VERSION + 1, max: PROTOCOL_VERSION + 1 });

/** A server that applies what it is sent; every answer takes a turn of the event loop, as a network does. */
class Server {
  requests = 0;
  readonly titles: unknown[] = [];

  private answer<T>(value: () => T): Promise<T> {
    this.requests += 1;
    return new Promise((resolve) => setImmediate(() => resolve(value())));
  }

  transport(): Transport {
    return {
      push: (req: PushRequest) =>
        this.answer(() => {
          this.titles.push(...req.mutations.map((m) => m.args.title));
          return {
            results: req.mutations.map((m) => ({ id: m.id, status: 'applied' as const })),
            lastMutationId: req.mutations.at(-1)?.id ?? 0,
          };
        }),
      pull: (cursor) =>
        this.answer(() => ({
          changes: [],
          nextCursor: asVersion(cursor),
          hasMore: false,
          lastMutationId: 0,
          head: asVersion(cursor),
        })),
      snapshot: () => this.answer(() => ({ watermark: asVersion(0), head: asVersion(0), rows: [], next: null })),
    };
  }
}

/** A transport of an app the server no longer speaks to; counts what it asks. */
function refused(count: { requests: number }): Transport {
  const refuse = () => ((count.requests += 1), Promise.reject(tooOld()));
  return { push: refuse, pull: refuse, snapshot: refuse };
}

/**
 * The same storage as a newer app reads it: a refusal that was stored by the app under test is, for
 * it, a refusal of an older protocol than its own.
 */
function seenByNewerApp(storage: MemoryStorage): SyncStorage {
  return {
    load: async () => {
      const state = await storage.load();
      const old = state.meta.updateRequired;
      return old ? { ...state, meta: { ...state.meta, updateRequired: { ...old, version: PROTOCOL_VERSION - 1 } } } : state;
    },
    loadQueue: () => storage.loadQueue(),
    ensureClientId: (candidate) => storage.ensureClientId(candidate),
    enqueue: (entry) => storage.enqueue(entry),
    commit: (change) => storage.commit(change),
    restartClient: (clientId, lastHandled) => storage.restartClient(clientId, lastHandled),
    close: () => storage.close(),
  };
}

const clients: SyncClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.dispose();
});

async function tab(transport: Transport, storage: SyncStorage, tabs: TabCoordinator, live = false) {
  const c = new SyncClient({ clientId: CLIENT_ID, transport, storage, tabs, live });
  clients.push(c);
  await c.ready;
  return c;
}

describe('a leading tab that cannot sync any more', () => {
  it("gives up leadership once the server refuses its protocol, so a newer app's tab sends the queue", async () => {
    const storage = new MemoryStorage();
    const group = new TabGroup();
    const server = new Server();
    const old = await tab(refused({ requests: 0 }), storage, group.tab());
    const newer = await tab(server.transport(), seenByNewerApp(storage), group.tab());

    await old.mutate('ticket.create', ticket(1, 'queued in the old tab'));
    await settle();

    expect({ oldLeads: old.isLeader, newerLeads: newer.isLeader }).toEqual({ oldLeads: false, newerLeads: true });
    expect(server.titles).toEqual(['queued in the old tab']);
    expect({ status: newer.status, pending: newer.pendingCount }).toEqual({ status: 'idle', pending: 0 });
    // The refused tab keeps saying what it was told, whatever the new leader reports.
    expect(old.status).toBe('update-required');
  });

  it('stops the other tabs of the same version too: none of them asks the server again', async () => {
    const storage = new MemoryStorage();
    const group = new TabGroup();
    const second = { requests: 0 };
    const first = await tab(refused({ requests: 0 }), storage, group.tab());
    const follower = await tab(refused(second), storage, group.tab());

    await first.mutate('ticket.create', ticket(1, 'a'));
    await settle();
    await follower.sync();
    await settle();

    expect(second.requests).toBe(0);
    expect({ leads: follower.isLeader, status: follower.status, required: follower.updateRequiredBy }).toEqual({
      leads: false,
      status: 'update-required',
      required: { version: PROTOCOL_VERSION, min: PROTOCOL_VERSION + 1, max: PROTOCOL_VERSION + 1 },
    });
  });

  it('never asks to lead, and opens no stream, when the refusal is already stored', async () => {
    const storage = new MemoryStorage();
    await storage.commit({
      meta: { updateRequired: { version: PROTOCOL_VERSION, min: PROTOCOL_VERSION + 1, max: PROTOCOL_VERSION + 1 } },
    });
    const count = { requests: 0, streams: 0 };
    const stream = () => ((count.streams += 1), new Promise<void>(() => undefined));
    const c = await tab({ ...refused(count), stream }, storage, new TabGroup().tab(), true);
    await c.sync();
    await settle();
    expect({ leads: c.isLeader, ...count }).toEqual({ leads: false, requests: 0, streams: 0 });
    expect(c.status).toBe('update-required');
  });

  it('stops and hands over when another tab queues a mutation in a newer format', async () => {
    const storage = new MemoryStorage();
    const group = new TabGroup();
    const server = new Server();
    const old = await tab(server.transport(), storage, group.tab());
    await old.sync();
    // A newer app's tab, next in line: it writes a mutation this app cannot send and says so.
    const newer = group.tab();
    let tookOver = false;
    await newer.claim(new AbortController().signal, () => (tookOver = true));
    const queued = await storage.enqueue({ name: 'ticket.create', args: ticket(1, 'new format'), queuedAt: 't' });
    await storage.commit({ pending: { put: [{ ...queued, v: MUTATION_FORMAT_VERSION + 1 }] } });
    const before = server.requests;

    newer.post({ kind: 'enqueued' });
    await settle();
    await settle();

    // Without the stop, the leader skips the mutation and syncs again at once, for good.
    expect(server.requests - before).toBeLessThanOrEqual(1);
    expect({ leads: old.isLeader, tookOver, status: old.status }).toEqual({
      leads: false,
      tookOver: true,
      status: 'update-required',
    });
    expect(server.titles).toEqual([]);
  });

  it('says that an update is required when it is the stream that the server refuses', async () => {
    const storage = new MemoryStorage();
    const server = new Server();
    let refuseStream: (err: Error) => void = () => undefined;
    const stream = () => new Promise<void>((_resolve, reject) => (refuseStream = reject));
    const c = await tab({ ...server.transport(), stream }, storage, new TabGroup().tab(), true);
    await c.sync();
    expect(c.status).toBe('idle');
    const before = server.requests;

    refuseStream(tooOld());
    await settle();

    expect({ status: c.status, leads: c.isLeader }).toEqual({ status: 'update-required', leads: false });
    expect((await storage.load()).meta.updateRequired?.min).toBe(PROTOCOL_VERSION + 1);
    expect(server.requests).toBe(before);
  });
});
