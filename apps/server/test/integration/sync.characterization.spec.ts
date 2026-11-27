import { randomUUID } from 'node:crypto';
import type { Change, Mutation, PullResponse, PushResponse } from '@fieldsync/sync-core';
import { GcService } from '../../src/gc.service';
import type { TestUser } from '../support/fixtures';
import { describeWithDb, useIntegration } from '../support/integration';

/**
 * Characterization of the HTTP sync API on a real database. These tests pin behaviour that later
 * changes must keep (or change on purpose); they deliberately avoid asserting the known defects
 * (for example, incremental pulls are only checked for containment, not for exact content).
 */
describeWithDb('sync API (characterization)', () => {
  const ctx = useIntegration();

  const push = (user: TestUser, clientId: string, mutations: Mutation[]) =>
    ctx.api.post<PushResponse>('/sync/push', { clientId, mutations }, user.token);

  const pull = (user: TestUser, cursor: number, opts: { clientId?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams({ cursor: String(cursor) });
    if (opts.clientId) qs.set('clientId', opts.clientId);
    if (opts.limit) qs.set('limit', String(opts.limit));
    return ctx.api.get<PullResponse>(`/sync/pull?${qs.toString()}`, user.token);
  };

  const create = (id: number, siteId: string, title: string): Mutation => ({
    id,
    name: 'ticket.create',
    args: { id: randomUUID(), siteId, title, description: '' },
  });

  /** All changes visible to `user` from the start of the log, in one page. */
  async function initialPull(user: TestUser): Promise<Change[]> {
    const res = await pull(user, 0, { limit: 500 });
    expect(res.status).toBe(200);
    expect(res.body.hasMore).toBe(false);
    return res.body.changes;
  }

  async function createTicket(user: TestUser, clientId: string, mutationId: number, siteId: string, title: string) {
    const res = await push(user, clientId, [create(mutationId, siteId, title)]);
    expect(res.status).toBe(201);
    const change = (await initialPull(user)).find((c) => c.entity === 'ticket' && c.data?.title === title);
    if (!change) throw new Error(`ticket "${title}" was not returned by pull`);
    return change.id;
  }

  async function logSize(): Promise<number> {
    const { rows } = await ctx.db.query<{ n: string }>('SELECT count(*) AS n FROM change_log');
    return Number(rows[0].n);
  }

  describe('authentication', () => {
    it('rejects requests without a valid bearer token', async () => {
      expect((await ctx.api.get('/me')).status).toBe(401);
      expect((await ctx.api.get('/me', 'not-a-token')).status).toBe(401);
      expect((await ctx.api.post('/sync/push', { clientId: 'c', mutations: [] })).status).toBe(401);
      expect((await ctx.api.get('/sync/pull?cursor=0')).status).toBe(401);
    });

    it('serves health without authentication', async () => {
      const res = await ctx.api.get<{ status: string; streams: number }>('/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok', streams: 0 });
    });
  });

  describe('GET /me', () => {
    it('returns a technician with only the sites assigned to them, ordered by name', async () => {
      const [a, b] = [await ctx.fixtures.site('Beta'), await ctx.fixtures.site('Alpha')];
      await ctx.fixtures.site('Gamma');
      const tech = await ctx.fixtures.technician(a, b);
      const res = await ctx.api.get<{ id: string; role: string; sites: Array<{ id: string; name: string }> }>(
        '/me',
        tech.token,
      );
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(tech.id);
      expect(res.body.role).toBe('technician');
      expect(res.body.sites.map((s) => s.id)).toEqual([b, a]);
      expect(res.body.sites[0].name).toMatch(/^Alpha /);
    });

    it('returns every site to an admin', async () => {
      await ctx.fixtures.site();
      const admin = await ctx.fixtures.admin();
      const res = await ctx.api.get<{ role: string; sites: Array<{ id: string }> }>('/me', admin.token);
      const { rows } = await ctx.db.query<{ id: string }>('SELECT id FROM sites');
      expect(res.body.role).toBe('admin');
      expect(res.body.sites.map((s) => s.id).sort()).toEqual(rows.map((r) => r.id).sort());
    });
  });

  describe('push and pull', () => {
    it('applies a created ticket and returns it on the next pull', async () => {
      const site = await ctx.fixtures.site();
      const tech = await ctx.fixtures.technician(site);
      const clientId = randomUUID();

      const pushed = await push(tech, clientId, [create(1, site, 'Broken pump')]);
      expect(pushed.status).toBe(201);
      // The version of the mutation's last change was added to the result with the commit-ordered log.
      expect(pushed.body).toEqual({
        results: [{ id: 1, status: 'applied', version: expect.any(Number) }],
        lastMutationId: 1,
      });

      const pulled = await pull(tech, 0, { clientId });
      expect(pulled.status).toBe(200);
      expect(pulled.body.changes).toHaveLength(1);
      const [change] = pulled.body.changes;
      expect(typeof change.version).toBe('number');
      expect(change).toMatchObject({
        entity: 'ticket',
        siteId: site,
        op: 'put',
        data: { id: change.id, siteId: site, title: 'Broken pump', description: '', status: 'open', assigneeId: null },
      });
      expect(pulled.body.nextCursor).toBe(change.version);
      expect(pulled.body.hasMore).toBe(false);
      expect(pulled.body.lastMutationId).toBe(1);
    });

    it('answers a repeated mutation as a duplicate without applying it again', async () => {
      const site = await ctx.fixtures.site();
      const tech = await ctx.fixtures.technician(site);
      const clientId = randomUUID();
      await push(tech, clientId, [create(1, site, 'Once')]);
      const before = await logSize();

      const again = await push(tech, clientId, [create(1, site, 'Once')]);
      expect(again.status).toBe(201);
      expect(again.body).toEqual({
        results: [{ id: 1, status: 'duplicate', version: expect.any(Number) }],
        lastMutationId: 1,
      });
      expect(await logSize()).toBe(before);
    });

    // Changed with the protocol work: a gap is a conflict with the server's state (409, with the id
    // it expects), not a malformed request (it was 400).
    it('rejects a mutation id that skips ahead with 409 and the expected id', async () => {
      const site = await ctx.fixtures.site();
      const tech = await ctx.fixtures.technician(site);
      const clientId = randomUUID();
      await push(tech, clientId, [create(1, site, 'First')]);
      const before = await logSize();

      const res = await push(tech, clientId, [create(3, site, 'Third')]);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'MUTATION_OUT_OF_ORDER', details: { expected: 2 } });
      expect(await logSize()).toBe(before);
    });

    it('rejects malformed push bodies with 400', async () => {
      const tech = await ctx.fixtures.technician(await ctx.fixtures.site());
      const bodies: unknown[] = [
        null,
        {},
        { clientId: '', mutations: [] },
        { clientId: 'c', mutations: {} },
        { clientId: 'c', mutations: [{ id: 0, name: 'ticket.create', args: {} }] },
        { clientId: 'c', mutations: [{ id: 1.5, name: 'ticket.create', args: {} }] },
        { clientId: 'c', mutations: [{ id: 1, name: 'ticket.create', args: null }] },
        { clientId: 'x'.repeat(65), mutations: [] },
      ];
      for (const body of bodies) {
        const res = await ctx.api.post('/sync/push', body, tech.token);
        expect({ body, status: res.status }).toEqual({ body, status: 400 });
      }
    });

    it('applies status changes, parts and quantity adjustments in order', async () => {
      const site = await ctx.fixtures.site();
      const tech = await ctx.fixtures.technician(site);
      const clientId = randomUUID();
      const ticket = await createTicket(tech, clientId, 1, site, 'Pump service');
      const part = randomUUID();

      const res = await push(tech, clientId, [
        { id: 2, name: 'ticket.setStatus', args: { id: ticket, siteId: site, from: 'open', to: 'in_progress' } },
        { id: 3, name: 'part.add', args: { id: part, ticketId: ticket, siteId: site, name: 'Seal', quantity: 2 } },
        { id: 4, name: 'part.adjust', args: { id: part, siteId: site, delta: 3 } },
      ]);
      expect(res.status).toBe(201);
      expect(res.body.results.map((r) => r.status)).toEqual(['applied', 'applied', 'applied']);
      expect(res.body.lastMutationId).toBe(4);

      const changes = await initialPull(tech);
      const latest = (entity: string, id: string) => changes.filter((c) => c.entity === entity && c.id === id).at(-1);
      expect(latest('ticket', ticket)?.data).toMatchObject({ status: 'in_progress' });
      expect(latest('part', part)?.data).toEqual({
        id: part,
        ticketId: ticket,
        siteId: site,
        name: 'Seal',
        quantity: 5,
      });
      const versions = changes.map((c) => c.version);
      expect(versions).toEqual([...versions].sort((x, y) => x - y));

      const { rows } = await ctx.db.query<{ data: { quantity: number }; site_id: string; version: string }>(
        `SELECT data, site_id, version FROM entities WHERE entity = 'part' AND id = $1`,
        [part],
      );
      expect(rows[0].data.quantity).toBe(5);
      expect(rows[0].site_id).toBe(site);
      expect(Number(rows[0].version)).toBe(latest('part', part)?.version);
    });

    it('deletes a ticket as a tombstone and publishes a del change', async () => {
      const site = await ctx.fixtures.site();
      const tech = await ctx.fixtures.technician(site);
      const clientId = randomUUID();
      const ticket = await createTicket(tech, clientId, 1, site, 'To delete');

      const res = await push(tech, clientId, [{ id: 2, name: 'ticket.delete', args: { id: ticket, siteId: site } }]);
      expect(res.body.results).toEqual([{ id: 2, status: 'applied', version: expect.any(Number) }]);

      const del = (await initialPull(tech)).filter((c) => c.id === ticket).at(-1);
      expect(del).toMatchObject({ op: 'del', data: null, siteId: site, entity: 'ticket' });
      const { rows } = await ctx.db.query(`SELECT deleted, data FROM entities WHERE entity = 'ticket' AND id = $1`, [
        ticket,
      ]);
      expect(rows).toEqual([{ deleted: true, data: null }]);
    });

    // Changed with F-23: the rejection used to fail the push with 500 and leave the client's last
    // mutation id at 1, so the client retried it forever; now it is answered and recorded as handled.
    it('leaves no trace of a mutation that the mutator rejects, and records it as handled', async () => {
      const site = await ctx.fixtures.site();
      const tech = await ctx.fixtures.technician(site);
      const clientId = randomUUID();
      await push(tech, clientId, [create(1, site, 'Kept')]);
      const before = await logSize();
      const part = randomUUID();

      const res = await push(tech, clientId, [
        {
          id: 2,
          name: 'part.add',
          args: { id: part, ticketId: randomUUID(), siteId: site, name: 'Seal', quantity: 1 },
        },
      ]);

      expect({ status: res.status, body: res.body }).toEqual({
        status: 201,
        body: {
          results: [{ id: 2, status: 'rejected', code: 'NOT_FOUND', message: 'Ticket no longer exists' }],
          lastMutationId: 2,
        },
      });
      expect(await logSize()).toBe(before);
      const parts = await ctx.db.query(`SELECT 1 FROM entities WHERE entity = 'part' AND id = $1`, [part]);
      expect(parts.rowCount).toBe(0);
      const client = await ctx.db.query<{ last_mutation_id: string }>(
        `SELECT last_mutation_id FROM clients WHERE client_id = $1`,
        [clientId],
      );
      expect(Number(client.rows[0].last_mutation_id)).toBe(2);
    });

    it('pages through the log by limit', async () => {
      const site = await ctx.fixtures.site();
      const tech = await ctx.fixtures.technician(site);
      const clientId = randomUUID();
      const res = await push(tech, clientId, [create(1, site, 'P1'), create(2, site, 'P2'), create(3, site, 'P3')]);
      expect(res.body.lastMutationId).toBe(3);

      const first = await pull(tech, 0, { limit: 2 });
      expect(first.body.changes.map((c) => c.data?.title)).toEqual(['P1', 'P2']);
      expect(first.body.hasMore).toBe(true);
      expect(first.body.nextCursor).toBe(first.body.changes[1].version);

      const second = await pull(tech, first.body.nextCursor, { limit: 500 });
      expect(second.body.changes.map((c) => c.data?.title)).toContain('P3');
      expect(second.body.changes.every((c) => c.version > first.body.nextCursor)).toBe(true);
    });

    it('reports lastMutationId 0 when the pull names no client', async () => {
      const site = await ctx.fixtures.site();
      const tech = await ctx.fixtures.technician(site);
      await push(tech, randomUUID(), [create(1, site, 'Anon')]);
      const res = await pull(tech, 0);
      expect(res.body.lastMutationId).toBe(0);
    });
  });

  describe('change-log GC', () => {
    it('deletes the oldest entries up to the first one within the retention, and reports how many', async () => {
      const site = await ctx.fixtures.site();
      const insert = (age: string) =>
        ctx.db.query<{ version: string }>(
          // Versions come from the log head, as the server takes them.
          `WITH head AS (UPDATE log_head SET version = version + 1 WHERE id = 1 RETURNING version)
           INSERT INTO change_log (version, site_id, entity, entity_id, op, data, created_at)
           SELECT head.version, $1, 'ticket', $2, 'put', '{}', now() - $3::interval FROM head RETURNING version`,
          [site, randomUUID(), age],
        );
      // Earlier tests of this file wrote recent entries: the log starts fresh for this test.
      await ctx.db.query(`DELETE FROM change_log`);
      const [first, second] = [await insert('8 days'), await insert('30 days')].map((r) => Number(r.rows[0].version));
      const recent = Number((await insert('1 day')).rows[0].version);
      // Old again, but after a recent one: it stays until the recent one is old as well.
      const late = Number((await insert('9 days')).rows[0].version);

      const run = await ctx.server.app.get(GcService).collect();

      expect(run).toMatchObject({ log: 2, floor: second, skipped: false });
      const { rows } = await ctx.db.query<{ version: string }>(
        `SELECT version FROM change_log WHERE version = ANY($1::bigint[]) ORDER BY version`,
        [[first, second, recent, late]],
      );
      expect(rows.map((r) => Number(r.version))).toEqual([recent, late]);
    });
  });
});
