import { randomUUID } from 'node:crypto';
import type { PullResponse, PushResponse } from '@fieldsync/sync-core';
import { precondition } from '@fieldsync/test-kit';
import { describeWithDb, TEST_APPLICATION_NAME, useIntegration } from '../support/integration';

/**
 * A reader that pages through the change log by cursor must never skip a change, whatever order
 * concurrent writers commit in. Reproduced without any hook in the server: the test's own
 * connection holds an uncommitted row with the id a ticket create is about to insert, so that
 * create waits inside its transaction (on the unique index) while a second create commits.
 */
describeWithDb('change-log order under concurrent commits', () => {
  const ctx = useIntegration();

  /** Waits until a server connection waits for a lock held by another transaction. */
  async function untilServerWaitsForALock(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const { rowCount } = await ctx.db.query(
        `SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND application_name <> $1 AND wait_event_type = 'Lock'`,
        [TEST_APPLICATION_NAME],
      );
      if ((rowCount ?? 0) > 0) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('the server never waited for the lock');
  }

  it('delivers a change that commits after a change with a later position in the log', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const create = (id: string, title: string) => ({
      id: 1,
      name: 'ticket.create',
      args: { id, siteId: site, title, description: '' },
    });
    const start = await ctx.api.get<PullResponse>('/sync/pull?cursor=0', tech.token);

    const slowTicket = randomUUID();
    const blocker = await ctx.db.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        `INSERT INTO entities (entity, id, site_id, data, deleted, version) VALUES ('ticket', $1, $2, '{}', false, 0)`,
        [slowTicket, site],
      );
      // The slow create starts and stops at the uncommitted row; the fast one commits meanwhile.
      const slow = ctx.api.post<PushResponse>(
        '/sync/push',
        { clientId: randomUUID(), mutations: [create(slowTicket, 'slow')] },
        tech.token,
      );
      await untilServerWaitsForALock();
      const fast = ctx.api.post<PushResponse>(
        '/sync/push',
        { clientId: randomUUID(), mutations: [create(randomUUID(), 'fast')] },
        tech.token,
      );
      // The fast create either commits at once or waits for its turn behind the slow one.
      await Promise.race([fast, new Promise((r) => setTimeout(r, 300))]);

      const during = await ctx.api.get<PullResponse>(`/sync/pull?cursor=${start.body.nextCursor}`, tech.token);
      await blocker.query('ROLLBACK');
      const [slowRes, fastRes] = await Promise.all([slow, fast]);
      precondition(slowRes.body.results?.[0]?.status === 'applied', `slow push: ${JSON.stringify(slowRes.body)}`);
      precondition(fastRes.body.results?.[0]?.status === 'applied', `fast push: ${JSON.stringify(fastRes.body)}`);

      const after = await ctx.api.get<PullResponse>(`/sync/pull?cursor=${during.body.nextCursor}`, tech.token);
      const delivered = [...during.body.changes, ...after.body.changes].map((c) => c.data?.title);
      expect(delivered.sort()).toEqual(['fast', 'slow']);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
  });
});
