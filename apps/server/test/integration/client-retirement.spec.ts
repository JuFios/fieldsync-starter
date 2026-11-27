import { randomUUID } from 'node:crypto';
import type { Mutation, PushResponse } from '@fieldsync/sync-core';
import { precondition } from '@fieldsync/test-kit';
import type { TestUser } from '../support/fixtures';
import { describeWithDb, useIntegration } from '../support/integration';

/**
 * Retiring a client id (`DELETE /sync/clients/:clientId`), the server's half of the recovery from a
 * 409 MUTATION_OUT_OF_ORDER: the client continues under a new id, and the old one applies nothing new.
 */
describeWithDb('client retirement', () => {
  const ctx = useIntegration();

  const create = (id: number, siteId: string, title: string): Mutation => ({
    id,
    name: 'ticket.create',
    args: { id: randomUUID(), siteId, title, description: '' },
  });
  const push = (user: TestUser, clientId: string, mutations: Mutation[]) =>
    ctx.api.post<PushResponse>('/sync/push', { clientId, mutations }, user.token);
  const retire = (user: TestUser, clientId: string) =>
    ctx.api.request<{ lastMutationId: number }>('DELETE', `/sync/clients/${clientId}`, { token: user.token });

  async function setUp() {
    const site = await ctx.fixtures.site();
    return { site, tech: await ctx.fixtures.technician(site) };
  }

  it('applies nothing new under a retired id, and says so with the last id it handled', async () => {
    const { site, tech } = await setUp();
    const client = randomUUID();
    const first = create(1, site, 'before');
    await push(tech, client, [first, create(2, site, 'also before')]);

    const retired = await retire(tech, client);
    expect({ status: retired.status, body: retired.body }).toEqual({ status: 200, body: { lastMutationId: 2 } });

    const late = await push(tech, client, [create(3, site, 'late copy')]);
    expect({ status: late.status, body: late.body }).toEqual({
      status: 410,
      body: expect.objectContaining({ code: 'CLIENT_RETIRED', details: { lastMutationId: 2 } }) as unknown,
    });
    const tickets = await ctx.db.query(`SELECT 1 FROM entities WHERE site_id = $1 AND entity = 'ticket'`, [site]);
    expect(tickets.rowCount).toBe(2);
  });

  it('still answers copies of mutations it handled with their results', async () => {
    const { site, tech } = await setUp();
    const client = randomUUID();
    const first = create(1, site, 'applied');
    const applied = await push(tech, client, [first]);
    precondition(applied.body.results[0]?.status === 'applied', 'not applied');
    await retire(tech, client);

    const copy = await push(tech, client, [first]);

    expect(copy.status).toBe(201);
    expect(copy.body.results).toEqual([{ id: 1, status: 'duplicate', version: expect.any(Number) as number }]);
  });

  it('is idempotent and keeps the first retirement', async () => {
    const { site, tech } = await setUp();
    const client = randomUUID();
    await push(tech, client, [create(1, site, 'x')]);
    const a = await retire(tech, client);
    const b = await retire(tech, client);
    expect([a.status, b.status, b.body]).toEqual([200, 200, { lastMutationId: 1 }]);
    const { rows } = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM clients WHERE client_id = $1 AND retired_at IS NOT NULL`,
      [client],
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('retires an id nobody used yet, so it can never be used', async () => {
    const { site, tech } = await setUp();
    const client = randomUUID();
    const retired = await retire(tech, client);
    expect(retired.body).toEqual({ lastMutationId: 0 });
    const push1 = await push(tech, client, [create(1, site, 'never')]);
    expect(push1.status).toBe(410);
  });

  it("answers another user's id as unknown and leaves it working", async () => {
    const { site, tech } = await setUp();
    const other = await ctx.fixtures.technician(site);
    const client = randomUUID();
    await push(tech, client, [create(1, site, 'mine')]);

    const res = await retire(other, client);

    expect({ status: res.status, code: (res.body as unknown as { code: string }).code }).toEqual({
      status: 404,
      code: 'NOT_FOUND',
    });
    const next = await push(tech, client, [create(2, site, 'still mine')]);
    expect(next.body.results[0]?.status).toBe('applied');
  });

  it('waits for a push in progress: the id it returns is final', async () => {
    const { site, tech } = await setUp();
    const client = randomUUID();
    const batch = Array.from({ length: 20 }, (_, i) => create(i + 1, site, `t${i}`));
    const [pushed, retired] = await Promise.all([push(tech, client, batch), retire(tech, client)]);
    const { rows } = await ctx.db.query<{ last: string }>(
      `SELECT last_mutation_id AS last FROM clients WHERE client_id = $1`,
      [client],
    );
    // Whatever the order, nothing was applied after the retirement reported its last id.
    expect(Number(rows[0]?.last)).toBe(retired.body.lastMutationId);
    if (pushed.status === 410) expect(retired.body.lastMutationId).toBeLessThan(20);
    else expect(pushed.status).toBe(201);
  });

  it('rejects an id that is not a UUID', async () => {
    const { tech } = await setUp();
    const res = await retire(tech, 'not-a-uuid');
    expect(res.status).toBe(400);
  });
});
