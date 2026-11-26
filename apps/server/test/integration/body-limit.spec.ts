import { randomUUID } from 'node:crypto';
import type { Mutation, PushResponse } from '@fieldsync/sync-core';
import { describeWithDb, useIntegration } from '../support/integration';

/** The most bytes the client puts in one push body; the server must accept at least this much. */
const MAX_PUSH_BODY_BYTES = 1_048_576;
const MAX_PUSH_MUTATIONS = 100;

describeWithDb('push body size', () => {
  const ctx = useIntegration();

  it('accepts a push body as large as the client sends', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const clientId = randomUUID();
    const mutations: Mutation[] = [];
    const size = () => Buffer.byteLength(JSON.stringify({ clientId, mutations }));
    // Long descriptions of the largest valid size, until the body is just under the client's maximum
    // (100 of them, as many as one push may carry, take about 1 MB).
    while (mutations.length < MAX_PUSH_MUTATIONS && size() < MAX_PUSH_BODY_BYTES - 20_000) {
      mutations.push({
        id: mutations.length + 1,
        name: 'ticket.create',
        args: { id: randomUUID(), siteId: site, title: 'T', description: 'é'.repeat(5000) },
      });
    }
    const res = await ctx.api.post<PushResponse>('/sync/push', { clientId, mutations }, tech.token);
    expect({ status: res.status, applied: res.body.results?.length }).toEqual({
      status: 201,
      applied: mutations.length,
    });
  });
});
