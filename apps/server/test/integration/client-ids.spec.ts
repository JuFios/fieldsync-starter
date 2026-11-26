import { randomUUID } from 'node:crypto';
import { MutationRejected, type Mutation, type PushResponse } from '@fieldsync/sync-core';
import { precondition } from '@fieldsync/test-kit';
import { Db } from '../../src/db';
import { applyMutation } from '../../src/server-tx';
import type { TestUser } from '../support/fixtures';
import { describeWithDb, useIntegration } from '../support/integration';

/** Ids of created rows come from the client, so the server must never let one id name two rows. */
describeWithDb('client-generated ids', () => {
  const ctx = useIntegration();

  const push = (user: TestUser, mutations: Mutation[], clientId = randomUUID()) =>
    ctx.api.post<PushResponse>('/sync/push', { clientId, mutations }, user.token);

  const create = (id: string, siteId: string, title: string): Mutation => ({
    id: 1,
    name: 'ticket.create',
    args: { id, siteId, title, description: '' },
  });

  async function storedTicket(id: string) {
    const { rows } = await ctx.db.query<{ site_id: string; deleted: boolean; data: { title: string } | null }>(
      `SELECT site_id, deleted, data FROM entities WHERE entity = 'ticket' AND id = $1`,
      [id],
    );
    return rows;
  }

  it('stores a created ticket under the id the client chose', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const id = randomUUID();
    const res = await push(tech, [create(id, site, 'Broken pump')]);
    expect(res.status).toBe(201);
    expect(res.body.results).toEqual([{ id: 1, status: 'applied', version: expect.any(Number) }]);
    expect(await storedTicket(id)).toEqual([{ site_id: site, deleted: false, data: expect.objectContaining({ id }) }]);
  });

  async function logEntries(id: string): Promise<number> {
    const { rows } = await ctx.db.query<{ n: string }>(`SELECT count(*) AS n FROM change_log WHERE entity_id = $1`, [
      id,
    ]);
    return Number(rows[0].n);
  }

  /** A South ticket and a technician who can access North only. */
  async function southTicketAndNorthTech() {
    const north = await ctx.fixtures.site('North');
    const south = await ctx.fixtures.site('South');
    const techSouth = await ctx.fixtures.technician(south);
    const id = randomUUID();
    const res = await push(techSouth, [create(id, south, 'South original')]);
    precondition(res.status === 201, `fixture ticket push answered ${res.status}`);
    return { north, south, id, techNorth: await ctx.fixtures.technician(north) };
  }

  it("never overwrites another site's ticket with a create that reuses its id", async () => {
    const { north, south, id, techNorth } = await southTicketAndNorthTech();
    const res = await push(techNorth, [create(id, north, 'Hijacked')]);
    expect(res.status === 201 && res.body.results[0]?.status === 'applied').toBe(false);
    expect(await storedTicket(id)).toEqual([
      { site_id: south, deleted: false, data: expect.objectContaining({ title: 'South original' }) },
    ]);
    expect(await logEntries(id)).toBe(1);
  });

  it('never revives a deleted ticket with a create that reuses its id', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const clientId = randomUUID();
    const id = randomUUID();
    const setup = await push(
      tech,
      [create(id, site, 'Deleted'), { id: 2, name: 'ticket.delete', args: { id, siteId: site } }],
      clientId,
    );
    precondition(setup.status === 201, `setup push answered ${setup.status}`);

    const res = await push(tech, [create(id, site, 'Revived')]);
    expect(res.status === 201 && res.body.results[0]?.status === 'applied').toBe(false);
    expect(await storedTicket(id)).toEqual([{ site_id: site, deleted: true, data: null }]);
    expect(await logEntries(id)).toBe(2);
  });

  it('applies exactly one of two concurrent creates with the same id', async () => {
    const site = await ctx.fixtures.site();
    const [first, second] = [await ctx.fixtures.technician(site), await ctx.fixtures.technician(site)];
    for (let round = 0; round < 20; round += 1) {
      const id = randomUUID();
      const responses = await Promise.all([
        push(first, [create(id, site, 'From the first client')]),
        push(second, [create(id, site, 'From the second client')]),
      ]);
      const applied = responses.filter((r) => r.status === 201 && r.body.results[0]?.status === 'applied');
      expect({ round, applied: applied.length }).toEqual({ round, applied: 1 });
      expect(await storedTicket(id)).toHaveLength(1);
      expect(await logEntries(id)).toBe(1);
    }
  });

  it('does not report a part as added when its id already names another part', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const ticket = randomUUID();
    const part = randomUUID();
    const setup = await push(tech, [
      create(ticket, site, 'Pump'),
      { id: 2, name: 'part.add', args: { id: part, ticketId: ticket, siteId: site, name: 'Seal', quantity: 1 } },
    ]);
    precondition(setup.status === 201, `setup push answered ${setup.status}`);

    const res = await push(tech, [
      { id: 1, name: 'part.add', args: { id: part, ticketId: ticket, siteId: site, name: 'Valve', quantity: 5 } },
    ]);
    expect(res.status === 201 && res.body.results[0]?.status === 'applied').toBe(false);
    const { rows } = await ctx.db.query(`SELECT data FROM entities WHERE entity = 'part' AND id = $1`, [part]);
    expect(rows).toEqual([{ data: { id: part, ticketId: ticket, siteId: site, name: 'Seal', quantity: 1 } }]);
  });

  it('rejects a create whose id is taken with ID_CONFLICT', async () => {
    const { north, id, techNorth } = await southTicketAndNorthTech();
    const user = { id: techNorth.id, role: techNorth.role };
    const attempt = ctx.server.app.get(Db).tx((c) => applyMutation(c, user, create(id, north, 'Hijacked'), new Date()));
    await expect(attempt).rejects.toEqual(expect.any(MutationRejected));
    await expect(attempt).rejects.toMatchObject({ code: 'ID_CONFLICT' });
  });

  it('tells the client that a create was rejected with ID_CONFLICT', async () => {
    const { north, id, techNorth } = await southTicketAndNorthTech();
    const res = await push(techNorth, [create(id, north, 'Hijacked')]);
    expect({ status: res.status, results: res.body.results }).toEqual({
      status: 201,
      results: [{ id: 1, status: 'rejected', code: 'ID_CONFLICT', message: expect.stringContaining('already exists') }],
    });
  });
});
