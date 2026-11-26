import { randomUUID } from 'node:crypto';
import type { PushResponse } from '@fieldsync/sync-core';
import { knownDefect } from '@fieldsync/test-kit';
import { describeWithDb, useIntegration } from '../support/integration';

describeWithDb('mutations the server rejects', () => {
  const ctx = useIntegration();

  knownDefect(
    { id: 'F-23', owner: 'sync-protocol', reason: 'a rejected mutation fails the whole push with HTTP 500' },
    'answers a rejected mutation with its reason instead of failing the push',
    async () => {
      const site = await ctx.fixtures.site();
      const tech = await ctx.fixtures.technician(site);
      // The part does not exist, so the mutator rejects the adjustment with NOT_FOUND.
      const mutations = [{ id: 1, name: 'part.adjust', args: { id: randomUUID(), siteId: site, delta: 1 } }];
      const res = await ctx.api.post<PushResponse>('/sync/push', { clientId: randomUUID(), mutations }, tech.token);
      expect({ status: res.status, results: res.body.results }).toEqual({
        status: 201,
        results: [{ id: 1, status: 'rejected', error: expect.stringContaining('NOT_FOUND') }],
      });
    },
  );
});
