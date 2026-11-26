import { randomUUID } from 'node:crypto';
import type { Mutation, PushResponse } from '@fieldsync/sync-core';
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
    expect(res.body.results).toEqual([{ id: 1, status: 'applied' }]);
    expect(await storedTicket(id)).toEqual([{ site_id: site, deleted: false, data: expect.objectContaining({ id }) }]);
  });
});
