import { randomUUID } from 'node:crypto';
import { asMutationId } from '@fieldsync/sync-core';
import type { Mutation } from '@fieldsync/sync-core';
import { describeWithDb, useIntegration } from '../support/integration';

describeWithDb('server time', () => {
  const ctx = useIntegration();
  const frozen = new Date('2001-02-03T04:05:06.789Z');

  afterEach(() => jest.useRealTimers());

  it("stamps a mutation's row and its log entry with one server clock", async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const id = randomUUID();
    const mutation: Mutation = {
      id: asMutationId(1),
      name: 'ticket.create',
      args: { id, siteId: site, title: 'T', description: '' },
    };

    // Only Date is replaced: sockets, timers and the database keep running in real time.
    jest.useFakeTimers({
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'requestIdleCallback',
        'cancelIdleCallback',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
      now: frozen,
    });
    const res = await ctx.api.post('/sync/push', { clientId: randomUUID(), mutations: [mutation] }, tech.token);
    jest.useRealTimers();
    expect(res.status).toBe(201);

    const { rows } = await ctx.db.query<{ created_at: Date; data: { createdAt: string } }>(
      `SELECT l.created_at, e.data FROM change_log l JOIN entities e ON e.entity = l.entity AND e.id = l.entity_id
        WHERE l.entity_id = $1`,
      [id],
    );
    expect(rows.map((r) => [r.data.createdAt, r.created_at.toISOString()])).toEqual([
      [frozen.toISOString(), frozen.toISOString()],
    ]);
  });
});
