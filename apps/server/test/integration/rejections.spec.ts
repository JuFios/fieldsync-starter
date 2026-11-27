import { randomUUID } from 'node:crypto';
import type { PushResponse } from '@fieldsync/sync-core';
import { describeWithDb, useIntegration } from '../support/integration';

describeWithDb('mutations the server rejects', () => {
  const ctx = useIntegration();

  it('answers a rejected mutation with its reason instead of failing the push', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    // The part does not exist, so the mutator rejects the adjustment with NOT_FOUND.
    const mutations = [{ id: 1, name: 'part.adjust', args: { id: randomUUID(), siteId: site, delta: 1 } }];
    const res = await ctx.api.post<PushResponse>('/sync/push', { clientId: randomUUID(), mutations }, tech.token);
    expect({ status: res.status, results: res.body.results }).toEqual({
      status: 201,
      results: [{ id: 1, status: 'rejected', code: 'NOT_FOUND', message: 'Part no longer exists' }],
    });
  });

  it('rejects a mutation whose message holds client text that reads like a connection error', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const ticket = randomUUID();
    const to = 'Connection terminated unexpectedly';
    const mutations = [
      { id: 1, name: 'ticket.create', args: { id: ticket, siteId: site, title: 'Pump', description: '' } },
      { id: 2, name: 'ticket.setStatus', args: { id: ticket, siteId: site, from: 'open', to } },
      { id: 3, name: 'ticket.setStatus', args: { id: ticket, siteId: site, from: 'open', to: 'in_progress' } },
    ];
    const res = await ctx.api.post<PushResponse>('/sync/push', { clientId: randomUUID(), mutations }, tech.token);
    expect(res.status).toBe(201);
    expect(res.body.results.map((r) => [r.id, r.status, r.status === 'rejected' ? r.code : undefined])).toEqual([
      [1, 'applied', undefined],
      [2, 'rejected', 'INVALID_TRANSITION'],
      [3, 'applied', undefined],
    ]);
  });
});
