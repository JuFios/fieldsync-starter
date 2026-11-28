import { randomUUID } from 'node:crypto';
import { asMutationId } from '@fieldsync/sync-core';
import type { Mutation, PushResponse } from '@fieldsync/sync-core';
import { precondition } from '@fieldsync/test-kit';
import type { TestUser } from '../support/fixtures';
import { describeWithDb, useIntegration } from '../support/integration';

/**
 * Two technicians edit the same ticket offline and sync later. An edit names only the fields the
 * user changed and the value each had on the user's screen (its base).
 */
describeWithDb('merging concurrent edits of a ticket', () => {
  const ctx = useIntegration();

  const push = (user: TestUser, mutations: Mutation[]) =>
    ctx.api.post<PushResponse>('/sync/push', { clientId: randomUUID(), mutations }, user.token);

  async function ticket(): Promise<{ id: string; site: string; tech: TestUser }> {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const id = randomUUID();
    const res = await push(tech, [
      { id: asMutationId(1), name: 'ticket.create', args: { id, siteId: site, title: 'Pump', description: 'Leaks' } },
    ]);
    precondition(res.body.results?.[0]?.status === 'applied', `create answered ${JSON.stringify(res.body)}`);
    return { id, site, tech };
  }

  async function stored(id: string): Promise<{ title: string; description: string }> {
    const { rows } = await ctx.db.query<{ data: { title: string; description: string } }>(
      `SELECT data FROM entities WHERE entity = 'ticket' AND id = $1`,
      [id],
    );
    return { title: rows[0].data.title, description: rows[0].data.description };
  }

  const update = (args: Record<string, unknown>): Mutation => ({ id: asMutationId(1), name: 'ticket.update', args });

  it('keeps the edits of different fields made by two clients', async () => {
    const { id, site, tech } = await ticket();
    const a = await push(tech, [update({ id, siteId: site, title: 'Pump 2', base: { title: 'Pump' } })]);
    const b = await push(tech, [
      update({ id, siteId: site, description: 'Leaks at the seal', base: { description: 'Leaks' } }),
    ]);
    expect([a.body.results?.[0]?.status, b.body.results?.[0]?.status]).toEqual(['applied', 'applied']);
    expect(await stored(id)).toEqual({ title: 'Pump 2', description: 'Leaks at the seal' });
  });

  it('rejects an edit of a field another client changed since, with both values', async () => {
    const { id, site, tech } = await ticket();
    await push(tech, [update({ id, siteId: site, title: 'Pump 2', base: { title: 'Pump' } })]);
    const late = await push(tech, [update({ id, siteId: site, title: 'Main pump', base: { title: 'Pump' } })]);
    expect(late.body.results).toEqual([
      {
        id: 1,
        status: 'rejected',
        code: 'FIELD_CONFLICT',
        message: 'title was changed by someone else',
        details: { fields: [{ field: 'title', current: 'Pump 2', yours: 'Main pump' }] },
      },
    ]);
    expect(await stored(id)).toEqual({ title: 'Pump 2', description: 'Leaks' });
  });
});
