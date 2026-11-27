import fc from 'fast-check';
import {
  asVersion,
  isTabMessage,
  MemoryStorage,
  SyncClient,
  TabGroup,
  TransportError,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  type Transport,
} from '../src';

const SITE = '33333333-3333-4333-8333-333333333333';
let ticketCount = 0;
const newTicket = () => `00000000-0000-4000-8000-${String((ticketCount += 1)).padStart(12, '0')}`;
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};

/**
 * The server's push contract, strictly: per client id, the next id is applied, a lower one is a
 * duplicate, a higher one is a gap (409). Records every application.
 */
class StrictServer {
  readonly applied: Array<{ clientId: string; id: number; title: unknown }> = [];
  readonly requests: string[] = [];
  /** Pushes refused for a gap in the ids: two tabs sending one client's queue at once. */
  gaps = 0;
  /** Requests from a tab that did not lead when it sent them. */
  fromFollowers = 0;
  private readonly last = new Map<string, number>();

  transport(tab: string, leads: () => boolean = () => true): Transport {
    const sent = (kind: string) => {
      this.requests.push(`${tab}:${kind}`);
      if (!leads()) this.fromFollowers += 1;
    };
    return {
      push: (req: PushRequest): Promise<PushResponse> => {
        sent('push');
        const results: PushResponse['results'] = [];
        for (const m of req.mutations) {
          const last = this.last.get(req.clientId) ?? 0;
          if (m.id <= last) {
            results.push({ id: m.id, status: 'duplicate' });
            continue;
          }
          if (m.id !== last + 1) {
            this.gaps += 1;
            return Promise.reject(new TransportError(409, 'MUTATION_OUT_OF_ORDER', 'gap', { expected: last + 1 }));
          }
          this.last.set(req.clientId, m.id);
          this.applied.push({ clientId: req.clientId, id: m.id, title: m.args.title });
          results.push({ id: m.id, status: 'applied' });
        }
        return Promise.resolve({ results, lastMutationId: this.last.get(req.clientId) ?? 0 });
      },
      pull: (cursor, clientId): Promise<PullResponse> => {
        sent('pull');
        return Promise.resolve({
          changes: [],
          nextCursor: asVersion(cursor),
          hasMore: false,
          lastMutationId: this.last.get(clientId) ?? 0,
          head: asVersion(cursor),
        });
      },
      snapshot: () => Promise.resolve({ watermark: asVersion(0), head: asVersion(0), rows: [], next: null }),
    };
  }
}

const clients: SyncClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.dispose();
});
function tab(name: string, server: StrictServer, storage: MemoryStorage, group: TabGroup): SyncClient {
  // The server checks that a request comes from the tab that leads at that moment.
  const self: { client?: SyncClient } = {};
  const transport = server.transport(name, () => self.client?.isLeader ?? false);
  const c = new SyncClient({ clientId: 'c1', transport, storage, tabs: group.tab(), live: false });
  self.client = c;
  clients.push(c);
  return c;
}

describe('tabs of one user', () => {
  it('lets only the leader talk to the server; it sends what a follower queues', async () => {
    const server = new StrictServer();
    const storage = new MemoryStorage();
    const group = new TabGroup();
    const a = tab('a', server, storage, group);
    const b = tab('b', server, storage, group);
    await Promise.all([a.ready, b.ready]);
    expect([a.isLeader, b.isLeader]).toEqual([true, false]);

    await b.mutate('ticket.create', { id: newTicket(), siteId: SITE, title: 'from b', description: '' });
    await b.sync();
    await settle();

    expect(server.applied.map((m) => m.title)).toEqual(['from b']);
    expect(server.requests.every((r) => r.startsWith('a:'))).toBe(true);
    // The follower reads what the leader stored: its queue is empty too.
    expect(b.pendingCount).toBe(0);
    expect(b.status).toBe('idle');
  });

  it('hands over to the next tab when the leader goes away, which sends what waits', async () => {
    const server = new StrictServer();
    const storage = new MemoryStorage();
    const group = new TabGroup();
    const a = tab('a', server, storage, group);
    const b = tab('b', server, storage, group);
    await Promise.all([a.ready, b.ready]);
    a.dispose(); // the leading tab closes (or crashes)
    await b.mutate('ticket.create', { id: newTicket(), siteId: SITE, title: 'after the leader left', description: '' });
    await settle();
    expect(b.isLeader).toBe(true);
    await b.sync();
    expect(server.applied.map((m) => m.title)).toEqual(['after the leader left']);
    expect(server.requests.some((r) => r.startsWith('b:'))).toBe(true);
  });

  it('never loses or repeats a mutation, whatever the tabs do in whatever order', async () => {
    type Step =
      { kind: 'mutate'; tab: number } | { kind: 'sync'; tab: number } | { kind: 'close-leader' } | { kind: 'open' };
    const step: fc.Arbitrary<Step> = fc.oneof(
      { weight: 5, arbitrary: fc.record({ kind: fc.constant('mutate' as const), tab: fc.nat(3) }) },
      { weight: 3, arbitrary: fc.record({ kind: fc.constant('sync' as const), tab: fc.nat(3) }) },
      { weight: 1, arbitrary: fc.constant({ kind: 'close-leader' as const }) },
      { weight: 1, arbitrary: fc.constant({ kind: 'open' as const }) },
    );
    await fc.assert(
      fc.asyncProperty(fc.array(step, { maxLength: 40 }), async (steps) => {
        const server = new StrictServer();
        const storage = new MemoryStorage();
        const group = new TabGroup();
        let opened = 0;
        const open = () => tab(`t${(opened += 1)}`, server, storage, group);
        const tabs = [open(), open(), open()];
        const titles: string[] = [];
        const work: Array<Promise<unknown>> = [];
        const closed = new Set<SyncClient>();
        const alive = () => tabs.filter((t) => !closed.has(t));
        for (const s of steps) {
          const live = alive();
          if (s.kind === 'mutate' && live.length > 0) {
            const t = live[s.tab % live.length] as SyncClient;
            const title = `m${work.length}`;
            // Not awaited: tabs act at the same time, as a user with two windows does. Only a mutate
            // that resolved queued its mutation (one in a tab closed meanwhile rejects, queueing nothing).
            work.push(
              t.mutate('ticket.create', { id: newTicket(), siteId: SITE, title, description: '' }).then(
                () => titles.push(title),
                () => undefined,
              ),
            );
          } else if (s.kind === 'sync' && live.length > 0) {
            void (live[s.tab % live.length] as SyncClient).sync();
          } else if (s.kind === 'close-leader') {
            const leader = live.find((t) => t.isLeader);
            if (leader) {
              leader.dispose();
              closed.add(leader);
            }
          } else if (s.kind === 'open') {
            const t = open();
            await t.ready;
            tabs.push(t);
          }
          if (s.kind !== 'mutate' && s.kind !== 'sync') await settle();
        }
        await Promise.all(work);
        await settle();
        // Heal: a tab is open and syncs until the queue is empty.
        const survivor = alive()[0] ?? open();
        if (!tabs.includes(survivor)) tabs.push(survivor);
        await survivor.ready;
        await settle();
        for (let i = 0; i < 5 && (await storage.load()).pending.length > 0; i += 1) {
          for (const t of alive()) await t.sync();
          await survivor.sync();
          await settle();
        }
        expect(server.applied.map((m) => m.title).sort()).toEqual([...titles].sort());
        // One tab talks to the server at a time, so it never sees a gap in the ids either.
        expect({ gaps: server.gaps, fromFollowers: server.fromFollowers }).toEqual({ gaps: 0, fromFollowers: 0 });
        for (const t of tabs) t.dispose();
      }),
      { numRuns: 60 },
    );
  });
});

describe('isTabMessage', () => {
  it.each([
    [{ kind: 'enqueued' }, true],
    [{ kind: 'changed' }, true],
    [{ kind: 'sync' }, true],
    [{ kind: 'status', status: 'idle', error: null }, true],
    [{ kind: 'status', status: 'offline', error: { status: 0, code: 'NETWORK' } }, true],
    [{ kind: 'status', status: 1, error: null }, false],
    [{ kind: 'status', status: 'idle', error: { code: 1 } }, false],
    [{ kind: 'token', token: 'x' }, false],
    [null, false],
    ['changed', false],
  ])('%j is %s', (value, expected) => {
    expect(isTabMessage(value)).toBe(expected);
  });
});
