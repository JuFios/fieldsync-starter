import { randomUUID } from 'node:crypto';
import type { PullResponse } from '@fieldsync/sync-core';
import { knownDefect, precondition } from '@fieldsync/test-kit';
import type { TestUser } from '../support/fixtures';
import { describeWithDb, useIntegration } from '../support/integration';

/** Replaces the starter unit test that mocked every query and so could not observe any filtering. */
describeWithDb('pull returns only accessible sites', () => {
  const ctx = useIntegration();

  async function createTicket(user: TestUser, siteId: string, title: string): Promise<void> {
    const res = await ctx.api.post(
      '/sync/push',
      {
        clientId: randomUUID(),
        mutations: [{ id: 1, name: 'ticket.create', args: { id: randomUUID(), siteId, title, description: '' } }],
      },
      user.token,
    );
    precondition(res.status === 201, `creating "${title}" answered ${res.status}`);
  }

  const pull = (user: TestUser, cursor: number) =>
    ctx.api.get<PullResponse>(`/sync/pull?cursor=${cursor}&limit=500`, user.token);

  async function twoSites() {
    const north = await ctx.fixtures.site('North');
    const south = await ctx.fixtures.site('South');
    return {
      north,
      south,
      techNorth: await ctx.fixtures.technician(north),
      techSouth: await ctx.fixtures.technician(south),
    };
  }

  it('initial pull returns only changes for sites the user can access', async () => {
    const { north, south, techNorth, techSouth } = await twoSites();
    await createTicket(techNorth, north, 'North ticket');
    await createTicket(techSouth, south, 'South ticket');

    const res = await pull(techNorth, 0);
    expect(res.status).toBe(200);
    expect(res.body.changes.length).toBeGreaterThan(0);
    expect(new Set(res.body.changes.map((c) => c.siteId))).toEqual(new Set([north]));
  });

  knownDefect(
    { id: 'F-07', owner: 'access-control', reason: 'the site filter is applied only when cursor is 0' },
    'incremental pull returns only changes for sites the user can access',
    async () => {
      const { north, south, techNorth, techSouth } = await twoSites();
      await createTicket(techNorth, north, 'North first');
      const initial = await pull(techNorth, 0);
      precondition(initial.status === 200, `initial pull answered ${initial.status}`);
      await createTicket(techSouth, south, 'South later');

      const next = await pull(techNorth, initial.body.nextCursor);
      precondition(next.status === 200, `incremental pull answered ${next.status}`);
      expect(next.body.changes.filter((c) => c.siteId !== north)).toEqual([]);
    },
  );
});
