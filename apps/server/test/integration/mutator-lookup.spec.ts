import { randomUUID } from 'node:crypto';
import type { PushResponse } from '@fieldsync/sync-core';
import { describeWithDb, useIntegration } from '../support/integration';

describeWithDb('mutator lookup', () => {
  const ctx = useIntegration();

  it('rejects names inherited from Object.prototype as unknown mutators', async () => {
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
    const rejectedAsUnknown = [{ id: 1, status: 'rejected', code: 'UNKNOWN_MUTATOR', message: 'Unknown mutator' }];
    expect(outcomes).toEqual(names.map((name) => [name, rejectedAsUnknown]));
  });
});
