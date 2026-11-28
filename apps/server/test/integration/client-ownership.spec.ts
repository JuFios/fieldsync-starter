import { randomUUID } from 'node:crypto';
import { asMutationId } from '@fieldsync/sync-core';
import type { Mutation, PushResponse } from '@fieldsync/sync-core';
import { knownDefect, precondition } from '@fieldsync/test-kit';
import { describeWithDb, useIntegration } from '../support/integration';

/** A client id belongs to the user who pushed with it first; other users must not use it. */
describeWithDb('a client id of another user', () => {
  const ctx = useIntegration();

  async function twoTechnicians() {
    const site = await ctx.fixtures.site();
    return { site, owner: await ctx.fixtures.technician(site), other: await ctx.fixtures.technician(site) };
  }

  it("never tells another user the outcome of the owner's mutations", async () => {
    const { site, owner, other } = await twoTechnicians();
    const clientId = randomUUID();
    const ticket = randomUUID();
    const mutations: Mutation[] = [
      {
        id: asMutationId(1),
        name: 'ticket.create',
        args: { id: ticket, siteId: site, title: 'Pump', description: 'Leaks' },
      },
      // Rejected with the stored values in its details.
      {
        id: asMutationId(2),
        name: 'ticket.update',
        args: { id: ticket, siteId: site, title: 'X', base: { title: 'Old' } },
      },
    ];
    const first = await ctx.api.post<PushResponse>('/sync/push', { clientId, mutations }, owner.token);
    precondition(first.body.results?.[1]?.status === 'rejected', `setup answered ${JSON.stringify(first.body)}`);

    const copy = await ctx.api.post<PushResponse>('/sync/push', { clientId, mutations }, other.token);
    expect(copy.body.results).toEqual([
      { id: 1, status: 'duplicate' },
      { id: 2, status: 'duplicate' },
    ]);
    // The owner still gets the original outcome.
    const again = await ctx.api.post<PushResponse>('/sync/push', { clientId, mutations }, owner.token);
    expect(again.body.results?.[1]).toMatchObject({ status: 'rejected', code: 'FIELD_CONFLICT' });
  });

  knownDefect(
    { id: 'F-33', owner: 'access-control', reason: 'a client id is not bound to the user who owns it' },
    "does not let another user's push take the next mutation id of the owner's client",
    async () => {
      const { site, owner, other } = await twoTechnicians();
      const clientId = randomUUID();
      const create = (id: number): Mutation => ({
        id: asMutationId(id),
        name: 'ticket.create',
        args: { id: randomUUID(), siteId: site, title: `T${id}`, description: '' },
      });
      precondition(
        (await ctx.api.post('/sync/push', { clientId, mutations: [create(1)] }, owner.token)).status === 201,
        'setup',
      );
      await ctx.api.post('/sync/push', { clientId, mutations: [create(2)] }, other.token);
      const res = await ctx.api.post<PushResponse>('/sync/push', { clientId, mutations: [create(2)] }, owner.token);
      expect(res.body.results?.[0]?.status).toBe('applied');
    },
  );
});
