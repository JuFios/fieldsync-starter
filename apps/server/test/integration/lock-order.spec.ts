import { randomUUID } from 'node:crypto';
import type { Mutation, PushResponse } from '@fieldsync/sync-core';
import { precondition } from '@fieldsync/test-kit';
import { describeWithDb, useIntegration } from '../support/integration';

/**
 * Locks are taken in one order everywhere: the client's row, entity rows by key (a ticket before
 * its parts when a delete takes them), the change log's head last. A deadlock (40P01) would surface
 * as a 503; under heavy contention on a few rows none may occur.
 */
describeWithDb('lock order under contention', () => {
  const ctx = useIntegration();

  it('applies or rejects every mutation of 16 clients working on the same few tickets, without a 503', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const CLIENTS = 16;
    const ROUNDS = 25;
    const tickets = Array.from({ length: 3 }, () => randomUUID());
    const parts = tickets.map(() => [randomUUID(), randomUUID()]);
    const setup: Mutation[] = tickets.flatMap((t, i) => [
      { id: i * 3 + 1, name: 'ticket.create', args: { id: t, siteId: site, title: `T${i}`, description: '' } },
      ...parts[i].map((p, j) => ({
        id: i * 3 + 2 + j,
        name: 'part.add' as const,
        args: { id: p, ticketId: t, siteId: site, name: 'Seal', quantity: 50 },
      })),
    ]);
    const res = await ctx.api.post<PushResponse>(
      '/sync/push',
      { clientId: randomUUID(), mutations: setup },
      tech.token,
    );
    precondition(res.status === 201, `setup answered ${res.status}`);

    const statuses = new Map<number, number>();
    await Promise.all(
      Array.from({ length: CLIENTS }, async (_, c) => {
        const clientId = randomUUID();
        for (let id = 1; id <= ROUNDS; id += 1) {
          const i = (c + id) % tickets.length;
          const kinds: Mutation[] = [
            { id, name: 'part.adjust', args: { id: parts[i][id % 2], siteId: site, delta: c % 2 ? 1 : -1 } },
            { id, name: 'ticket.update', args: { id: tickets[i], siteId: site, title: `c${c} r${id}` } },
            { id, name: 'ticket.delete', args: { id: tickets[i], siteId: site } },
            {
              id,
              name: 'part.add',
              args: { id: randomUUID(), ticketId: tickets[i], siteId: site, name: 'X', quantity: 1 },
            },
          ];
          const answer = await ctx.api.post<PushResponse>(
            '/sync/push',
            { clientId, mutations: [kinds[(c * 7 + id) % kinds.length]] },
            tech.token,
          );
          statuses.set(answer.status, (statuses.get(answer.status) ?? 0) + 1);
        }
      }),
    );
    expect(Object.fromEntries(statuses)).toEqual({ 201: CLIENTS * ROUNDS });
  }, 120_000);
});
