import { randomUUID } from 'node:crypto';
import type { PullResponse, PushResponse } from '@fieldsync/sync-core';
import { describeWithDb, useIntegration } from '../support/integration';

/**
 * The shape of push bodies and pull query strings is checked before any handler code runs: a value
 * the server cannot use is a 400, never a silent default and never a 500 from the database.
 */
describeWithDb('request validation', () => {
  const ctx = useIntegration();

  async function tech() {
    return ctx.fixtures.technician(await ctx.fixtures.site());
  }

  describe('pull', () => {
    it.each([
      ['cursor=abc', 'not a number (read as 0, a full resync, before)'],
      ['cursor=-5', 'negative'],
      ['cursor=1e3', 'exponent notation'],
      ['cursor=1.5', 'a fraction (a database error before)'],
      ['cursor=9007199254740992', 'beyond the integers JSON numbers carry exactly'],
      ['cursor=99999999999999999999', 'beyond bigint (a database error before)'],
      ['cursor=', 'empty'],
      ['cursor=1&cursor=2', 'repeated'],
      ['limit=abc', 'not a number'],
      ['limit=1.5', 'a fraction (a database error before)'],
      ['limit=0', 'zero'],
      ['limit=501', 'above the page maximum'],
      ['clientId=not-a-uuid', 'a client id that is not a UUID'],
      [`clientId=${encodeURIComponent('bad\u0000id')}`, 'a client id Postgres cannot store (a database error before)'],
    ])('answers %s (%s) with 400', async (query) => {
      const res = await ctx.api.get(`/sync/pull?${query}`, (await tech()).token);
      expect({ query, status: res.status }).toEqual({ query, status: 400 });
    });

    it.each([
      ['cursor=0'],
      ['cursor=9007199254740991'],
      ['limit=1'],
      ['limit=500'],
      [''],
      [`clientId=${randomUUID()}`],
    ])('accepts %j', async (query) => {
      const res = await ctx.api.get<PullResponse>(`/sync/pull?${query}`, (await tech()).token);
      expect({ query, status: res.status }).toEqual({ query, status: 200 });
    });
  });

  describe('push', () => {
    const mutation = { id: 1, name: 'ticket.delete', args: {} };

    it.each([
      ['a client id that is not a UUID', { clientId: 'c', mutations: [] }],
      ['a client id Postgres cannot store', { clientId: 'bad\u0000id', mutations: [] }],
      [
        'a mutation id beyond the exact JSON integers',
        { clientId: randomUUID(), mutations: [{ ...mutation, id: 2 ** 53 }] },
      ],
      ['a mutation id given as a string', { clientId: randomUUID(), mutations: [{ ...mutation, id: '1' }] }],
      ['arguments given as an array', { clientId: randomUUID(), mutations: [{ ...mutation, args: [] }] }],
      ['a mutation that is not an object', { clientId: randomUUID(), mutations: [1] }],
      ['more than 100 mutations', { clientId: randomUUID(), mutations: Array.from({ length: 101 }, () => mutation) }],
    ])('answers %s with 400', async (_case, body) => {
      const res = await ctx.api.post('/sync/push', body, (await tech()).token);
      expect(res.status).toBe(400);
    });

    it('keeps every argument of a mutation for the mutator, nested values included', async () => {
      const site = await ctx.fixtures.site();
      const user = await ctx.fixtures.technician(site);
      const id = randomUUID();
      const res = await ctx.api.post<PushResponse>(
        '/sync/push',
        {
          clientId: randomUUID(),
          mutations: [{ id: 1, name: 'ticket.create', args: { id, siteId: site, title: 'Pump', description: 'Leak' } }],
        },
        user.token,
      );
      expect(res.body.results).toEqual([{ id: 1, status: 'applied' }]);
      const { rows } = await ctx.db.query<{ data: { title: string; description: string } }>(
        `SELECT data FROM entities WHERE entity = 'ticket' AND id = $1`,
        [id],
      );
      expect(rows[0].data).toMatchObject({ title: 'Pump', description: 'Leak' });
    });
  });
});
