import {
  asVersion,
  MemoryStorage,
  MUTATION_FORMAT_VERSION,
  PROTOCOL_VERSION,
  SyncClient,
  TransportError,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  type Transport,
  asClientId,
  asMutationId,
  type ClientId,
  type LastMutationId,
} from '../src';
import { ManualClock } from './support/manual-clock';

const SITE = '33333333-3333-4333-8333-333333333333';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OLD_ID = asClientId('0000000a-0000-4000-8000-000000000001');
const NEW_ID = asClientId('0000000a-0000-4000-8000-000000000002');
const UNEXPECTED_ID = asClientId('0000000a-0000-4000-8000-000000000003');
const tooOld = () =>
  new TransportError(400, 'CLIENT_UPDATE_REQUIRED', 'update', { min: PROTOCOL_VERSION + 1, max: PROTOCOL_VERSION + 1 });

const clients: SyncClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.dispose();
});
function client(transport: Transport, storage: MemoryStorage, clock = new ManualClock(), newIds?: ClientId[]) {
  const ids = newIds ?? [];
  const c = new SyncClient({
    clientId: OLD_ID,
    transport,
    storage,
    clock,
    live: false,
    random: () => 0.5,
    newClientId: () => ids.shift() ?? UNEXPECTED_ID,
  });
  clients.push(c);
  return c;
}

describe('a client the server no longer supports', () => {
  it('stops syncing, keeps its queue, and still knows it after a reload', async () => {
    const storage = new MemoryStorage();
    const clock = new ManualClock();
    let requests = 0;
    const server: Transport = {
      push: () => ((requests += 1), Promise.reject(tooOld())),
      pull: () => ((requests += 1), Promise.reject(tooOld())),
      snapshot: () => ((requests += 1), Promise.reject(tooOld())),
    };
    const c = client(server, storage, clock);
    await c.mutate('ticket.create', { id: id(1), siteId: SITE, title: 'offline work', description: '' });
    await c.sync();
    expect({ status: c.status, indicator: c.indicator, required: c.updateRequiredBy }).toEqual({
      status: 'update-required',
      indicator: 'update-required',
      required: { version: PROTOCOL_VERSION, min: PROTOCOL_VERSION + 1, max: PROTOCOL_VERSION + 1 },
    });
    const seen = requests;
    await clock.advance(10 * 60_000);
    await c.sync();
    expect(requests).toBe(seen);
    expect(c.pendingCount).toBe(1);
    c.dispose();

    const reloaded = client(server, storage, clock);
    await reloaded.ready;
    await reloaded.sync();
    expect({ status: reloaded.status, pending: reloaded.pendingCount, requests }).toEqual({
      status: 'update-required',
      pending: 1,
      requests: seen,
    });
  });

  it('forgets the refusal once the app speaks a newer protocol', async () => {
    const storage = new MemoryStorage();
    await storage.commit({
      meta: { updateRequired: { version: PROTOCOL_VERSION - 1, min: PROTOCOL_VERSION, max: PROTOCOL_VERSION } },
    });
    const c = client(
      {
        push: () => Promise.reject(new Error('x')),
        pull: () => Promise.reject(new Error('x')),
        snapshot: () => Promise.reject(new Error('x')),
      },
      storage,
    );
    await c.ready;
    expect(c.updateRequiredBy).toBeNull();
    expect((await storage.load()).meta.updateRequired).toBeNull();
  });

  it('does not send a queue written by a newer app, and says it needs the update', async () => {
    const storage = new MemoryStorage();
    const q = await storage.enqueue({ name: 'ticket.create', args: {}, queuedAt: 't' });
    await storage.commit({ pending: { put: [{ ...q, v: MUTATION_FORMAT_VERSION + 1 }] } });
    let pushed = 0;
    const c = client(
      {
        push: () => ((pushed += 1), Promise.reject(new Error('x'))),
        pull: () => Promise.reject(new Error('x')),
        snapshot: () => Promise.reject(new Error('x')),
      },
      storage,
    );
    await c.ready;
    await c.sync();
    expect({ status: c.status, pushed, pending: c.pendingCount }).toEqual({
      status: 'update-required',
      pushed: 0,
      pending: 1,
    });
  });
});

describe('the indicator', () => {
  it('distinguishes synced, pending, offline and rejected', async () => {
    let online = true;
    let reject = false;
    const server: Transport = {
      push: (req) =>
        online
          ? Promise.resolve({
              results: req.mutations.map((m) =>
                reject
                  ? { id: m.id, status: 'rejected' as const, code: 'NOT_FOUND' as const, message: 'gone' }
                  : { id: m.id, status: 'applied' as const },
              ),
              lastMutationId: req.mutations.at(-1)?.id ?? 0,
            })
          : Promise.reject(new Error('offline')),
      pull: (cursor) =>
        online
          ? Promise.resolve({
              changes: [],
              nextCursor: asVersion(cursor),
              hasMore: false,
              lastMutationId: 0,
              head: asVersion(cursor),
            })
          : Promise.reject(new Error('offline')),
      snapshot: () => Promise.resolve({ watermark: asVersion(0), head: asVersion(0), rows: [], next: null }),
    };
    const c = client(server, new MemoryStorage());
    await c.sync();
    expect(c.indicator).toBe('synced');
    online = false;
    await c.mutate('ticket.create', { id: id(1), siteId: SITE, title: 'a', description: '' });
    await c.sync();
    expect(c.indicator).toBe('offline');
    online = true;
    reject = true;
    await c.sync();
    expect(c.indicator).toBe('rejected');
    await c.dismissRejections();
    expect(c.indicator).toBe('synced');
  });
});

/**
 * A server that lost mutations of client OLD_ID after 2 (it expects 3, the client sends 4): it
 * answers 409 until the id is retired, then serves the new id.
 */
class GapServer implements Transport {
  readonly pushes: PushRequest[] = [];
  readonly retired: ClientId[] = [];
  private readonly last = new Map<ClientId, LastMutationId>([[OLD_ID, asMutationId(2)]]);

  push(req: PushRequest): Promise<PushResponse> {
    this.pushes.push(structuredClone(req));
    if (this.retired.includes(req.clientId)) {
      return Promise.reject(new TransportError(410, 'CLIENT_RETIRED', 'retired', { lastMutationId: 2 }));
    }
    const last = this.last.get(req.clientId) ?? 0;
    const results: PushResponse['results'] = [];
    for (const m of req.mutations) {
      if (m.id <= last) continue;
      if (m.id !== (this.last.get(req.clientId) ?? 0) + 1) {
        return Promise.reject(new TransportError(409, 'MUTATION_OUT_OF_ORDER', 'gap', { expected: last + 1 }));
      }
      this.last.set(req.clientId, m.id);
      results.push({ id: m.id, status: 'applied' });
    }
    return Promise.resolve({ results, lastMutationId: this.last.get(req.clientId) ?? 0 });
  }

  pull(cursor: number): Promise<PullResponse> {
    return Promise.resolve({
      changes: [],
      nextCursor: asVersion(cursor),
      hasMore: false,
      lastMutationId: 0,
      head: asVersion(cursor),
    });
  }

  snapshot() {
    return Promise.resolve({ watermark: asVersion(0), head: asVersion(0), rows: [], next: null });
  }

  retire(clientId: ClientId) {
    this.retired.push(clientId);
    return Promise.resolve({ lastMutationId: this.last.get(clientId) ?? 0 });
  }
}

describe('recovery from a 409', () => {
  async function queueUnder(storage: MemoryStorage, ids: number[]) {
    await storage.ensureClientId(OLD_ID);
    await storage.commit({ meta: { cursor: asVersion(0) } });
    for (const n of ids) {
      // Each mutation gets exactly the id n: what is missing in between was lost with the old queue.
      await storage.commit({ meta: { nextMutationIdAtLeast: asMutationId(n) } });
      await storage.enqueue({
        name: 'ticket.create',
        args: { id: id(n), siteId: SITE, title: `m${n}`, description: '' },
        queuedAt: 't',
      });
    }
  }

  it('retires the old id, then sends what is left under a new id from 1', async () => {
    const storage = new MemoryStorage();
    await queueUnder(storage, [4, 5]);
    const server = new GapServer();
    const c = client(server, storage, new ManualClock(), [NEW_ID]);
    await c.sync();

    expect(server.retired).toEqual([OLD_ID]);
    expect(server.pushes.map((p) => [p.clientId, p.mutations.map((m) => m.id)])).toEqual([
      [OLD_ID, [4, 5]],
      [NEW_ID, [1, 2]],
    ]);
    expect({ id: c.clientId, status: c.status, pending: c.pendingCount }).toEqual({
      id: NEW_ID,
      status: 'idle',
      pending: 0,
    });
    expect((await storage.load()).meta).toMatchObject({ clientId: NEW_ID, retiring: null, nextMutationId: 3 });
  });

  it('does not send again a mutation the server handled under the old id', async () => {
    const storage = new MemoryStorage();
    // Ids 2 to 4 are queued; the server handled 2 already (its answer was lost), and misses 3.
    await queueUnder(storage, [2, 4]);
    const server = new GapServer();
    const c = client(server, storage, new ManualClock(), [NEW_ID]);
    await c.sync();
    expect(server.pushes.at(-1)?.mutations.map((m) => m.args.title)).toEqual(['m4']);
  });

  it('finishes a recovery a reload interrupted before the old id was retired', async () => {
    const storage = new MemoryStorage();
    await queueUnder(storage, [4]);
    await storage.commit({ meta: { retiring: OLD_ID } });
    const server = new GapServer();
    const c = client(server, storage, new ManualClock(), [NEW_ID]);
    await c.sync();
    expect(server.retired).toEqual([OLD_ID]);
    // Nothing is sent under the old id any more.
    expect(server.pushes.map((p) => p.clientId)).toEqual([NEW_ID]);
  });
});
