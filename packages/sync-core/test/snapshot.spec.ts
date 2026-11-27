import {
  asVersion,
  HttpTransport,
  isSnapshotPage,
  MemoryStorage,
  RESET_REQUIRED,
  SyncClient,
  TransportError,
  type Change,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  type Row,
  type SnapshotPage,
  type SnapshotRequest,
  type SyncStatus,
  type Transport,
} from '../src';

const SITE = '33333333-3333-4333-8333-333333333333';
const TICKET = '00000000-0000-4000-8000-000000000001';
const PART = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-000000000003';

const ticket = (title: string): Row => ({ id: TICKET, siteId: SITE, title, description: '', status: 'open' });
const part = (quantity: number): Row => ({ id: PART, ticketId: TICKET, siteId: SITE, name: 'Valve', quantity });
const put = (version: number, entity: 'ticket' | 'part', id: string, data: Row): Change => ({
  version: asVersion(version),
  entity,
  id,
  siteId: SITE,
  op: 'put',
  data,
});
const reset = () => new TransportError(410, RESET_REQUIRED, 'pull failed: reset', { floor: 10 });

/** Every request is answered by the next scripted handler for its kind; a missing one fails like a network error. */
class ScriptedTransport implements Transport {
  readonly snapshots: Array<(req: SnapshotRequest) => Promise<SnapshotPage>> = [];
  readonly pulls: Array<(cursor: number) => Promise<PullResponse>> = [];
  readonly pushes: Array<(req: PushRequest) => Promise<PushResponse>> = [];
  readonly snapshotRequests: SnapshotRequest[] = [];
  readonly pullCursors: number[] = [];

  push(req: PushRequest): Promise<PushResponse> {
    const next = this.pushes.shift();
    return next ? next(req) : Promise.reject(new Error('offline'));
  }

  pull(cursor: number): Promise<PullResponse> {
    this.pullCursors.push(cursor);
    const next = this.pulls.shift();
    return next ? next(cursor) : Promise.reject(new Error('offline'));
  }

  snapshot(req: SnapshotRequest): Promise<SnapshotPage> {
    this.snapshotRequests.push(req);
    const next = this.snapshots.shift();
    return next ? next(req) : Promise.reject(new Error('offline'));
  }
}

const page =
  (watermark: number, rows: SnapshotPage['rows'], next: SnapshotPage['next'] = null) =>
  () =>
    Promise.resolve({ watermark: asVersion(watermark), rows, next });
const pulled =
  (changes: Change[], nextCursor: number, lastMutationId = 0, hasMore = false) =>
  () =>
    Promise.resolve({ changes, nextCursor: asVersion(nextCursor), hasMore, lastMutationId });

const clients: SyncClient[] = [];
function client(transport: Transport, stored?: { cursor: number; lastMutationId: number; base: Record<string, Row> }) {
  const storage = new MemoryStorage();
  if (stored) storage.save(stored);
  const c = new SyncClient({ clientId: 'c1', transport, storage });
  clients.push(c);
  return { client: c, storage };
}
afterEach(() => {
  for (const c of clients.splice(0)) c.dispose();
});

describe('SyncClient snapshots', () => {
  it('starts a new client from every page of a snapshot, then the log from its watermark', async () => {
    const t = new ScriptedTransport();
    const key = { siteId: SITE, entity: 'ticket' as const, id: TICKET };
    t.snapshots.push(
      page(7, [{ entity: 'ticket', id: TICKET, siteId: SITE, data: ticket('from page 1') }], key),
      page(7, [{ entity: 'part', id: PART, siteId: SITE, data: part(2) }]),
    );
    t.pulls.push(pulled([put(8, 'ticket', TICKET, ticket('edited after the watermark'))], 8));
    const { client: c, storage } = client(t);
    const statuses: SyncStatus[] = [];
    c.subscribe(() => statuses.push(c.status));

    await c.sync();

    expect(t.snapshotRequests).toEqual([{ limit: 500 }, { watermark: asVersion(7), after: key, limit: 500 }]);
    expect(t.pullCursors).toEqual([7]);
    expect(c.rows('ticket')).toEqual([ticket('edited after the watermark')]);
    expect(c.rows('part')).toEqual([part(2)]);
    expect(statuses).toContain('loading');
    expect(c.status).toBe('idle');
    expect(storage.load()).toMatchObject({ cursor: 8 });
  });

  it('reloads a client whose pull is answered RESET_REQUIRED, dropping rows the server no longer has', async () => {
    const t = new ScriptedTransport();
    t.pulls.push(() => Promise.reject(reset()), pulled([], 30));
    t.snapshots.push(page(30, [{ entity: 'part', id: PART, siteId: SITE, data: part(5) }]));
    const { client: c } = client(t, { cursor: 3, lastMutationId: 0, base: { [`ticket/${TICKET}`]: ticket('gone') } });

    await c.sync();

    expect(t.pullCursors).toEqual([3, 30]);
    expect(c.rows('ticket')).toEqual([]);
    expect(c.rows('part')).toEqual([part(5)]);
    expect(c.syncError).toBeUndefined();
  });

  it('shows the previous state, never a partial one, until the snapshot and its log are read', async () => {
    const t = new ScriptedTransport();
    let releasePage2: () => void = () => undefined;
    t.pulls.push(() => Promise.reject(reset()));
    t.snapshots.push(
      page(30, [{ entity: 'part', id: PART, siteId: SITE, data: part(9) }], { siteId: SITE, entity: 'part', id: PART }),
      () =>
        new Promise((resolve) => {
          releasePage2 = () => resolve({ watermark: asVersion(30), rows: [], next: null });
        }),
    );
    t.pulls.push(pulled([], 30));
    const { client: c } = client(t, { cursor: 3, lastMutationId: 0, base: { [`ticket/${TICKET}`]: ticket('old') } });

    const sync = c.sync();
    await new Promise((r) => setImmediate(r));
    expect(c.status).toBe('loading');
    expect(c.rows('ticket')).toEqual([ticket('old')]);
    expect(c.rows('part')).toEqual([]);
    releasePage2();
    await sync;
    expect(c.rows('ticket')).toEqual([]);
    expect(c.rows('part')).toEqual([part(9)]);
  });

  it('keeps the previous state and its cursor when the snapshot is interrupted, and starts over next time', async () => {
    const t = new ScriptedTransport();
    t.pulls.push(() => Promise.reject(reset()));
    t.snapshots.push(page(30, [], { siteId: SITE, entity: 'part', id: PART }));
    // The second page fails like a dropped connection.
    const { client: c, storage } = client(t, {
      cursor: 3,
      lastMutationId: 0,
      base: { [`ticket/${TICKET}`]: ticket('old') },
    });

    await c.sync();

    expect(c.status).toBe('offline');
    expect(c.rows('ticket')).toEqual([ticket('old')]);
    expect(storage.load()).toMatchObject({ cursor: 3 });
    t.pulls.push(() => Promise.reject(reset()), pulled([], 31));
    t.snapshots.push(page(31, []));
    await c.sync();
    expect(t.snapshotRequests.at(-1)).toEqual({ limit: 500 });
    expect(c.rows('ticket')).toEqual([]);
  });

  it('starts a new snapshot when one is answered RESET_REQUIRED, and gives up after three', async () => {
    const t = new ScriptedTransport();
    t.pulls.push(() => Promise.reject(reset()));
    const tooOld = { siteId: SITE, entity: 'part' as const, id: PART };
    for (let i = 0; i < 3; i += 1) t.snapshots.push(page(30, [], tooOld), () => Promise.reject(reset()));
    const { client: c } = client(t, { cursor: 3, lastMutationId: 0, base: {} });

    await c.sync();

    expect(t.snapshotRequests.filter((r) => r.watermark === undefined)).toHaveLength(3);
    expect(c.status).toBe('offline');
    expect(c.syncError).toMatchObject({ status: 410, code: RESET_REQUIRED });
  });

  describe('rebasing the queue onto the snapshot', () => {
    it('drops mutations whose effect the snapshot has, and replays the rest on top of it', async () => {
      const t = new ScriptedTransport();
      const stored = {
        cursor: 3,
        lastMutationId: 0,
        base: { [`ticket/${TICKET}`]: ticket('old'), [`part/${PART}`]: part(4) },
      };
      // Mutation 1 (+1) is applied at version 20, and the snapshot already counts it (5).
      t.pushes.push((req) =>
        Promise.resolve({
          results: req.mutations
            .filter((m) => m.id === 1)
            .map((m) => ({ id: m.id, status: 'applied' as const, version: asVersion(20) })),
          lastMutationId: 1,
        }),
      );
      t.pulls.push(() => Promise.reject(reset()));
      t.snapshots.push(
        page(25, [
          { entity: 'ticket', id: TICKET, siteId: SITE, data: ticket('renamed by someone else') },
          { entity: 'part', id: PART, siteId: SITE, data: part(5) },
        ]),
      );
      t.pulls.push(pulled([], 25, 1));
      const { client: c } = client(t, stored);
      c.mutate('part.adjust', { id: PART, siteId: SITE, delta: 1 });
      // Mutation 2 is not answered in this sync (the push carries only the first one's result).
      c.mutate('part.adjust', { id: PART, siteId: SITE, delta: 10 });

      await c.sync();

      // +1 is in the snapshot and gone from the queue; +10 is still pending and shown on top.
      expect(c.pendingCount).toBe(1);
      expect(c.rows('part')).toEqual([part(15)]);
      expect(c.rows('ticket')).toEqual([ticket('renamed by someone else')]);
    });

    it('drops a mutation whose answer was lost once the last log page says the server handled it', async () => {
      const t = new ScriptedTransport();
      t.pushes.push(() => Promise.reject(new Error('answer lost')));
      const { client: c } = client(t, { cursor: 3, lastMutationId: 0, base: { [`part/${PART}`]: part(4) } });
      c.mutate('part.adjust', { id: PART, siteId: SITE, delta: 1 });
      await c.sync();
      // Next time the copy is answered as a duplicate whose result has expired, and the pull is reset.
      t.pushes.push(() => Promise.resolve({ results: [{ id: 1, status: 'duplicate' as const }], lastMutationId: 1 }));
      t.pulls.push(() => Promise.reject(reset()), pulled([], 40, 1));
      t.snapshots.push(page(40, [{ entity: 'part', id: PART, siteId: SITE, data: part(5) }]));

      await c.sync();

      expect(c.pendingCount).toBe(0);
      expect(c.rows('part')).toEqual([part(5)]);
    });

    it('keeps an applied mutation in the view until the cursor reaches its change', async () => {
      const t = new ScriptedTransport();
      t.pushes.push((req) =>
        Promise.resolve({
          results: req.mutations.map((m) => ({ id: m.id, status: 'applied' as const, version: asVersion(50) })),
          lastMutationId: 1,
        }),
      );
      // The snapshot was read before the mutation's change (watermark 40), and the log after it is interrupted.
      t.pulls.push(() => Promise.reject(reset()));
      t.snapshots.push(page(40, [{ entity: 'part', id: PART, siteId: SITE, data: part(4) }]));
      t.pulls.push(pulled([], 45, 1, true), () => Promise.reject(new Error('offline')));
      const { client: c } = client(t, { cursor: 3, lastMutationId: 0, base: { [`part/${PART}`]: part(4) } });
      c.mutate('part.adjust', { id: PART, siteId: SITE, delta: 1 });

      await c.sync();

      // The snapshot never replaced the base, and the mutation still shows.
      expect(c.rows('part')).toEqual([part(5)]);
      expect(c.pendingCount).toBe(1);
    });

    it('keeps rejected mutations as rejections across a reset', async () => {
      const t = new ScriptedTransport();
      t.pushes.push((req) =>
        Promise.resolve({
          results: req.mutations.map((m) => ({
            id: m.id,
            status: 'rejected' as const,
            code: 'NOT_FOUND' as const,
            message: 'gone',
          })),
          lastMutationId: 1,
        }),
      );
      t.pulls.push(() => Promise.reject(reset()), pulled([], 9, 1));
      t.snapshots.push(page(9, []));
      const { client: c } = client(t, { cursor: 3, lastMutationId: 0, base: {} });
      c.mutate('ticket.update', { id: OTHER, siteId: SITE, title: 'x' });

      await c.sync();

      expect(c.rejections).toEqual([expect.objectContaining({ code: 'NOT_FOUND' })]);
      expect(c.pendingCount).toBe(0);
    });
  });
});

describe('HttpTransport.snapshot', () => {
  const ok =
    (body: unknown): typeof fetch =>
    () =>
      Promise.resolve(
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
      );

  it('asks for the page after a key of a snapshot', async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = (input) => {
      urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return ok({ watermark: asVersion(4), rows: [], next: null })(input);
    };
    await new HttpTransport('http://api', 't', fetchImpl).snapshot({
      watermark: asVersion(4),
      after: { siteId: SITE, entity: 'part', id: PART },
      limit: 2,
    });
    expect(urls).toEqual([
      `http://api/sync/snapshot?watermark=4&afterSite=${SITE}&afterEntity=part&afterId=${PART}&limit=2`,
    ]);
  });

  it('reports 410 as RESET_REQUIRED with the floor', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ status: 410, code: 'RESET_REQUIRED', detail: 'reset', details: { floor: 9 } }), {
          status: 410,
          headers: { 'content-type': 'application/problem+json' },
        }),
      );
    await expect(new HttpTransport('http://api', 't', fetchImpl).snapshot({})).rejects.toMatchObject({
      status: 410,
      code: RESET_REQUIRED,
      details: { floor: 9 },
    });
  });

  it('refuses a body that is not a snapshot page instead of taking it for an empty state', async () => {
    await expect(new HttpTransport('http://api', 't', ok({ rows: [] })).snapshot({})).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    });
  });
});

describe('isSnapshotPage', () => {
  const row = { entity: 'ticket', id: TICKET, siteId: SITE, data: {} };
  it.each([
    ['a page', { watermark: asVersion(1), rows: [row], next: null }, true],
    [
      'a page with a key',
      { watermark: asVersion(1), rows: [], next: { siteId: SITE, entity: 'part', id: PART } },
      true,
    ],
    ['no watermark', { rows: [], next: null }, false],
    ['a fractional watermark', { watermark: 1.5, rows: [], next: null }, false],
    ['a negative watermark', { watermark: -1, rows: [], next: null }, false],
    ['an unknown entity', { watermark: asVersion(1), rows: [{ ...row, entity: 'site' }], next: null }, false],
    ['a row without data', { watermark: asVersion(1), rows: [{ ...row, data: null }], next: null }, false],
    ['a key without an id', { watermark: asVersion(1), rows: [], next: { siteId: SITE, entity: 'part' } }, false],
    ['no next', { watermark: asVersion(1), rows: [] }, false],
    ['an array', [], false],
  ])('%s', (_case, body, expected) => {
    expect(isSnapshotPage(body)).toBe(expected);
  });
});

describe('asVersion', () => {
  it.each([0, 1, Number.MAX_SAFE_INTEGER])('accepts %p', (n) => {
    expect(asVersion(n)).toBe(n);
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY])('refuses %p', (n) => {
    expect(() => asVersion(n)).toThrow(RangeError);
  });
});

describe('a stored state with a cursor that is not a version', () => {
  it('loads a snapshot instead, and keeps numbering mutations after the stored id', async () => {
    const t = new ScriptedTransport();
    t.snapshots.push(page(4, []));
    t.pulls.push(pulled([], 4, 7));
    const { client: c } = client(t, { cursor: -3, lastMutationId: 7, base: { [`ticket/${TICKET}`]: ticket('stale') } });
    const pushed: number[] = [];
    t.pushes.push((req) => {
      pushed.push(...req.mutations.map((m) => m.id));
      return Promise.resolve({
        results: req.mutations.map((m) => ({ id: m.id, status: 'applied' as const })),
        lastMutationId: 8,
      });
    });
    c.mutate('ticket.create', { id: OTHER, siteId: SITE, title: 'new', description: '' });

    await c.sync();

    expect(pushed).toEqual([8]);
    expect(t.snapshotRequests).toEqual([{ limit: 500 }]);
    expect(c.rows('ticket').map((r) => r.id)).not.toContain(TICKET);
  });
});
