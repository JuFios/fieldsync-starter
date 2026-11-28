import { randomUUID } from 'node:crypto';
import { asMutationId } from '@fieldsync/sync-core';
import type { Mutation, PullResponse } from '@fieldsync/sync-core';
import { knownDefect } from '@fieldsync/test-kit';
import type { TestUser } from '../support/fixtures';
import { describeWithDb, useIntegration } from '../support/integration';

describeWithDb('write access is checked against the stored data', () => {
  const ctx = useIntegration();

  const push = (user: TestUser, mutations: Mutation[]) =>
    ctx.api.post('/sync/push', { clientId: randomUUID(), mutations }, user.token);

  /** A South ticket created by an admin, and a technician who can access North only. */
  async function southTicketAndNorthTech() {
    const north = await ctx.fixtures.site('North');
    const south = await ctx.fixtures.site('South');
    const admin = await ctx.fixtures.admin();
    const title = `South ${randomUUID()}`;
    await push(admin, [
      { id: asMutationId(1), name: 'ticket.create', args: { id: randomUUID(), siteId: south, title, description: '' } },
    ]);
    const pulled = await ctx.api.get<PullResponse>('/sync/pull?cursor=0&limit=500', admin.token);
    const ticket = pulled.body.changes.find((c) => c.data?.title === title);
    if (!ticket) throw new Error('fixture ticket was not created');
    return { north, south, ticketId: ticket.id, techNorth: await ctx.fixtures.technician(north) };
  }

  async function storedTicket(id: string) {
    const { rows } = await ctx.db.query<{ data: { status: string }; site_id: string }>(
      `SELECT data, site_id FROM entities WHERE entity = 'ticket' AND id = $1`,
      [id],
    );
    return rows[0];
  }

  it('does not write a ticket for a site the user names but cannot access', async () => {
    const north = await ctx.fixtures.site('North');
    const south = await ctx.fixtures.site('South');
    const techNorth = await ctx.fixtures.technician(north);
    const title = `Forbidden ${randomUUID()}`;
    await push(techNorth, [
      { id: asMutationId(1), name: 'ticket.create', args: { id: randomUUID(), siteId: south, title, description: '' } },
    ]);
    const { rowCount } = await ctx.db.query(`SELECT 1 FROM entities WHERE data->>'title' = $1`, [title]);
    expect(rowCount).toBe(0);
  });

  knownDefect(
    { id: 'F-08', owner: 'access-control', reason: 'write access is checked against the siteId the client sends' },
    "does not change the status of another site's ticket by claiming an accessible siteId",
    async () => {
      const { north, ticketId, techNorth } = await southTicketAndNorthTech();
      await push(techNorth, [
        {
          id: asMutationId(1),
          name: 'ticket.setStatus',
          args: { id: ticketId, siteId: north, from: 'open', to: 'cancelled' },
        },
      ]);
      expect((await storedTicket(ticketId)).data.status).toBe('open');
    },
  );

  knownDefect(
    { id: 'F-08', owner: 'access-control', reason: 'write access is checked against the siteId the client sends' },
    "does not add a part to another site's ticket by claiming an accessible siteId",
    async () => {
      const { north, ticketId, techNorth } = await southTicketAndNorthTech();
      const part = randomUUID();
      await push(techNorth, [
        {
          id: asMutationId(1),
          name: 'part.add',
          args: { id: part, ticketId, siteId: north, name: 'Seal', quantity: 1 },
        },
      ]);
      const { rowCount } = await ctx.db.query(`SELECT 1 FROM entities WHERE entity = 'part' AND id = $1`, [part]);
      expect(rowCount).toBe(0);
    },
  );
});
