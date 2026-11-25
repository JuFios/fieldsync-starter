import { randomUUID } from 'node:crypto';
import type { PushResponse } from '@fieldsync/sync-core';
import { knownDefect } from '@fieldsync/test-kit';
import { describeWithDb, useIntegration } from '../support/integration';

describeWithDb('mutator lookup', () => {
  const ctx = useIntegration();

  knownDefect(
    { id: 'F-12', owner: 'PR3', reason: 'mutators are looked up through the object prototype' },
    'rejects names inherited from Object.prototype as unknown mutators',
    async () => {
      const site = await ctx.fixtures.site();
      const tech = await ctx.fixtures.technician(site);
      const names = ['toString', 'constructor', '__proto__', 'hasOwnProperty'];
      // Pairs rather than an object: assigning a "__proto__" key would set the prototype instead.
      const outcomes: Array<[string, unknown]> = [];
      for (const name of names) {
        const res = await ctx.api.post<PushResponse>(
          '/sync/push',
          { clientId: randomUUID(), mutations: [{ id: 1, name, args: { siteId: site } }] },
          tech.token,
        );
        outcomes.push([name, res.status === 201 ? res.body.results : res.status]);
      }
      const rejectedAsUnknown = [{ id: 1, status: 'rejected', error: expect.stringContaining('UNKNOWN_MUTATOR') }];
      expect(outcomes).toEqual(names.map((name) => [name, rejectedAsUnknown]));
    },
  );
});
