import { randomUUID } from 'node:crypto';
import { asMutationId } from '@fieldsync/sync-core';
import type { Mutation, PullResponse, PushResponse, Row, SnapshotPage } from '@fieldsync/sync-core';
import { precondition } from '@fieldsync/test-kit';
import type { TestUser } from '../support/fixtures';
import { describeWithDb, useIntegration } from '../support/integration';

/** Ids that sort first and last among UUIDs, to place rows before or after a page cursor. */
const LOW = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const HIGH = (n: number) => `ffffffff-ffff-4fff-bfff-${String(n).padStart(12, '0')}`;

describeWithDb('GET /sync/snapshot', () => {
  const ctx = useIntegration();

  const push = (user: TestUser, clientId: string, mutations: Mutation[]) =>
    ctx.api.post<PushResponse>('/sync/push', { clientId, mutations }, user.token);
  const page = (user: TestUser, query: Record<string, string | number> = {}) =>
    ctx.api.get<SnapshotPage>(
      `/sync/snapshot?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString()}`,
      user.token,
    );
  const create = (id: number, siteId: string, ticket: string, title: string): Mutation => ({
    id: asMutationId(id),
    name: 'ticket.create',
    args: { id: ticket, siteId, title, description: '' },
  });

  /** Live rows of the given sites as stored, by `entity/id`. */
  async function stored(...sites: string[]): Promise<Map<string, Row>> {
    const { rows } = await ctx.db.query<{ entity: string; id: string; data: Row }>(
      `SELECT entity, id, data FROM entities WHERE NOT deleted AND site_id = ANY($1::uuid[])`,
      [sites],
    );
    return new Map(rows.map((r) => [`${r.entity}/${r.id}`, r.data]));
  }

  /**
   * What a client does: every page of a snapshot, then the log from its watermark, into one map.
   * `between` runs after each page except the last, while the snapshot is in progress.
   */
  async function load(user: TestUser, limit: number, between: (n: number) => Promise<void> = () => Promise.resolve()) {
    const state = new Map<string, Row>();
    let res = await page(user, { limit });
    precondition(res.status === 200, `first page: ${res.status} ${JSON.stringify(res.body)}`);
    const { watermark } = res.body;
    for (let n = 1; ; n += 1) {
      for (const row of res.body.rows) state.set(`${row.entity}/${row.id}`, row.data);
      const next = res.body.next;
      if (next === null) break;
      await between(n);
      res = await page(user, { watermark, afterSite: next.siteId, afterEntity: next.entity, afterId: next.id, limit });
      precondition(res.status === 200, `page ${n + 1}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    let cursor = watermark;
    for (;;) {
      const tail = await ctx.api.get<PullResponse>(`/sync/pull?cursor=${cursor}`, user.token);
      precondition(tail.status === 200, `tail: ${tail.status} ${JSON.stringify(tail.body)}`);
      for (const c of tail.body.changes) {
        if (c.op === 'put' && c.data) state.set(`${c.entity}/${c.id}`, c.data);
        else state.delete(`${c.entity}/${c.id}`);
      }
      cursor = tail.body.nextCursor;
      if (!tail.body.hasMore) break;
    }
    return { state, watermark };
  }

  it("returns the live rows of the user's sites in key order, page by page, with the head as watermark", async () => {
    const [mine, other] = [await ctx.fixtures.site(), await ctx.fixtures.site()];
    const tech = await ctx.fixtures.technician(mine);
    const admin = await ctx.fixtures.user('admin');
    const client = randomUUID();
    const tickets = [HIGH(1), LOW(1), LOW(2)];
    for (const [i, id] of tickets.entries()) await push(tech, client, [create(i + 1, mine, id, `T${i}`)]);
    await push(admin, randomUUID(), [create(1, other, randomUUID(), 'other site')]);
    await push(tech, client, [{ id: asMutationId(4), name: 'ticket.delete', args: { id: LOW(2), siteId: mine } }]);
    const head = await ctx.db.query<{ version: string }>('SELECT version FROM log_head');

    const first = await page(tech, { limit: 1 });
    expect(first.status).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.body).toEqual({
      watermark: Number(head.rows[0].version),
      head: Number(head.rows[0].version),
      rows: [{ entity: 'ticket', id: LOW(1), siteId: mine, data: expect.objectContaining({ title: 'T1' }) as Row }],
      next: { siteId: mine, entity: 'ticket', id: LOW(1) },
    });
    const second = await page(tech, {
      watermark: first.body.watermark,
      afterSite: mine,
      afterEntity: 'ticket',
      afterId: LOW(1),
      limit: 1,
    });
    // The deleted ticket and the other site's ticket are never part of it.
    expect(second.body).toEqual({
      watermark: first.body.watermark,
      head: first.body.watermark,
      rows: [{ entity: 'ticket', id: HIGH(1), siteId: mine, data: expect.objectContaining({ title: 'T0' }) as Row }],
      next: null,
    });
  });

  it('gives an empty first page to a user without sites', async () => {
    const lonely = await ctx.fixtures.technician();
    const res = await page(lonely);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rows: [], next: null });
  });

  it('converges with the log when rows change between its pages', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const writer = randomUUID();
    let id = 0;
    const next = () => (id += 1);
    for (const [ticket, title] of [
      [LOW(10), 'before, edited'],
      [LOW(11), 'before, deleted'],
      [HIGH(10), 'after, edited'],
      [HIGH(11), 'after, deleted'],
    ]) {
      await push(tech, writer, [create(next(), site, ticket, title)]);
    }
    const { state } = await load(tech, 2, async (n) => {
      if (n !== 1) return;
      // The first page read LOW(10) and LOW(11); the rest is still to come.
      const edit = (ticket: string, title: string): Mutation => ({
        id: asMutationId(next()),
        name: 'ticket.update',
        args: { id: ticket, siteId: site, title },
      });
      const del = (ticket: string): Mutation => ({
        id: asMutationId(next()),
        name: 'ticket.delete',
        args: { id: ticket, siteId: site },
      });
      await push(tech, writer, [edit(LOW(10), 'edited after its page')]);
      await push(tech, writer, [del(LOW(11))]);
      await push(tech, writer, [edit(HIGH(10), 'edited before its page')]);
      await push(tech, writer, [del(HIGH(11))]);
      await push(tech, writer, [create(next(), site, LOW(9), 'created behind the cursor')]);
    });
    expect(state).toEqual(await stored(site));
    expect(state.get(`ticket/${LOW(9)}`)?.title).toBe('created behind the cursor');
  });

  it('converges with the log while several clients write throughout, for every reader', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    // Seed rows so that snapshots have pages to read.
    const seeds = Array.from({ length: 30 }, () => randomUUID());
    const seeder = randomUUID();
    for (const [i, t] of seeds.entries()) await push(tech, seeder, [create(i + 1, site, t, `seed ${i}`)]);

    let writing = true;
    const writers = Array.from({ length: 4 }, async (_, w) => {
      const clientId = randomUUID();
      let mid = 0;
      const live = new Set<string>();
      while (writing) {
        const roll = (mid + w) % 3;
        if (roll === 0 || live.size === 0) {
          const t = randomUUID();
          live.add(t);
          await push(tech, clientId, [create((mid += 1), site, t, `w${w} ${mid}`)]);
        } else {
          const t = [...live][mid % live.size];
          if (roll === 1) {
            await push(tech, clientId, [
              {
                id: asMutationId((mid += 1)),
                name: 'ticket.update',
                args: { id: t, siteId: site, title: `w${w} edit ${mid}` },
              },
            ]);
          } else {
            live.delete(t);
            await push(tech, clientId, [
              { id: asMutationId((mid += 1)), name: 'ticket.delete', args: { id: t, siteId: site } },
            ]);
          }
        }
      }
    });
    try {
      const snapshots = await Promise.all(Array.from({ length: 4 }, () => load(tech, 3)));
      writing = false;
      await Promise.all(writers);
      const expected = await stored(site);
      for (const s of snapshots) {
        // Each reader then catches up with the writes after its own load: it has the stored state.
        let cursor = s.watermark;
        const state = new Map(s.state);
        for (;;) {
          const res = await ctx.api.get<PullResponse>(`/sync/pull?cursor=${cursor}`, tech.token);
          for (const c of res.body.changes) {
            if (c.op === 'put' && c.data) state.set(`${c.entity}/${c.id}`, c.data);
            else state.delete(`${c.entity}/${c.id}`);
          }
          cursor = res.body.nextCursor;
          if (!res.body.hasMore) break;
        }
        expect(state).toEqual(expected);
      }
    } finally {
      writing = false;
      await Promise.allSettled(writers);
    }
  }, 60_000);

  describe('below the floor of the log', () => {
    /** Raises the floor as the GC would after collecting everything; restores it afterwards. */
    async function withFloorAtHead(body: (floor: number) => Promise<void>): Promise<void> {
      const before = await ctx.db.query<{ version: string }>('SELECT version FROM log_floor');
      const head = await ctx.db.query<{ version: string }>('SELECT version FROM log_head');
      await ctx.db.query('UPDATE log_floor SET version = $1', [head.rows[0].version]);
      try {
        await body(Number(head.rows[0].version));
      } finally {
        await ctx.db.query('UPDATE log_floor SET version = $1', [before.rows[0].version]);
      }
    }

    it('answers a page whose watermark fell below the floor with 410 RESET_REQUIRED', async () => {
      const site = await ctx.fixtures.site();
      const tech = await ctx.fixtures.technician(site);
      await push(tech, randomUUID(), [create(1, site, randomUUID(), 'x')]);
      const first = await page(tech, { limit: 1 });
      await push(tech, randomUUID(), [create(1, site, randomUUID(), 'y')]);
      await withFloorAtHead(async (floor) => {
        precondition(first.body.watermark < floor, 'the floor did not pass the watermark');
        const res = await page(tech, { watermark: first.body.watermark });
        expect(res.status).toBe(410);
        expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body).toMatchObject({ status: 410, code: 'RESET_REQUIRED', details: { floor } });
        // A new snapshot starts at the head, at or above the floor.
        expect((await page(tech)).status).toBe(200);
      });
    });

    it('answers a pull below the floor with 410 and one at the floor with its changes', async () => {
      const site = await ctx.fixtures.site();
      const tech = await ctx.fixtures.technician(site);
      await push(tech, randomUUID(), [create(1, site, randomUUID(), 'x')]);
      await withFloorAtHead(async (floor) => {
        const below = await ctx.api.get(`/sync/pull?cursor=${floor - 1}`, tech.token);
        expect(below.status).toBe(410);
        expect(below.body).toMatchObject({ code: 'RESET_REQUIRED', details: { floor } });
        const at = await ctx.api.get<PullResponse>(`/sync/pull?cursor=${floor}`, tech.token);
        expect(at.status).toBe(200);
        expect(at.body).toMatchObject({ changes: [], nextCursor: floor, hasMore: false });
      });
    });
  });

  describe('validation', () => {
    it.each([
      ['a page key without its watermark', { afterSite: LOW(1), afterEntity: 'ticket', afterId: LOW(2) }],
      ['an incomplete page key', { watermark: 0, afterSite: LOW(1), afterEntity: 'ticket' }],
      ['an unknown entity', { watermark: 0, afterSite: LOW(1), afterEntity: 'site', afterId: LOW(2) }],
      ['a key that is not a UUID', { watermark: 0, afterSite: 'x', afterEntity: 'ticket', afterId: LOW(2) }],
      ['a fractional watermark', { watermark: '1.5' }],
      ['a negative watermark', { watermark: -1 }],
      ['a limit of 0', { limit: 0 }],
      ['a limit above 500', { limit: 501 }],
      ['a watermark beyond what JSON carries exactly', { watermark: '9007199254740992' }],
    ])('answers 400 for %s', async (_case, query) => {
      const tech = await ctx.fixtures.technician(await ctx.fixtures.site());
      const res = await page(tech, query);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('answers 400 for a watermark ahead of the log', async () => {
      const tech = await ctx.fixtures.technician(await ctx.fixtures.site());
      const head = await ctx.db.query<{ version: string }>('SELECT version FROM log_head');
      const res = await page(tech, { watermark: Number(head.rows[0].version) + 1 });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'BAD_REQUEST', details: { head: Number(head.rows[0].version) } });
    });

    it('needs a token', async () => {
      expect((await ctx.api.get('/sync/snapshot')).status).toBe(401);
    });
  });
});
