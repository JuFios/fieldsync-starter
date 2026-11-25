import { randomUUID } from 'node:crypto';
import type { PullResponse } from '@fieldsync/sync-core';
import { describeWithDb, terminateServerConnections, useIntegration } from '../support/integration';

/**
 * Postgres connections can drop at any time (restart, failover, idle-session killers). The server
 * must answer the affected request with an error and keep serving, not crash the process.
 */
describeWithDb('losing database connections', () => {
  const ctx = useIntegration();

  it('keeps serving after its idle pooled connections are terminated', async () => {
    const tech = await ctx.fixtures.technician(await ctx.fixtures.site());
    await Promise.all([1, 2, 3].map(() => ctx.api.get('/me', tech.token)));

    expect(await terminateServerConnections(ctx, 'idle')).toBeGreaterThan(0);

    const me = await ctx.api.get('/me', tech.token);
    expect(me.status).toBe(200);
  });

  it('fails only the affected push when its connection dies inside the transaction', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const clientId = randomUUID();
    const title = `Locked ${randomUUID()}`;
    await ctx.api.post(
      '/sync/push',
      { clientId, mutations: [{ id: 1, name: 'ticket.create', args: { siteId: site, title, description: '' } }] },
      tech.token,
    );
    const pulled = await ctx.api.get<PullResponse>('/sync/pull?cursor=0', tech.token);
    const ticketId = pulled.body.changes.find((c) => c.data?.title === title)?.id;
    expect(ticketId).toBeDefined();

    // Hold the ticket's row lock so the server's transaction blocks on it, then kill that backend.
    const holder = await ctx.db.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM entities WHERE entity = 'ticket' AND id = $1 FOR UPDATE`, [ticketId]);
      const push = ctx.api.post(
        '/sync/push',
        {
          clientId,
          mutations: [{ id: 2, name: 'ticket.setStatus', args: { id: ticketId, siteId: site, from: 'open', to: 'done' } }],
        },
        tech.token,
      );
      await waitForServerLockWait();
      expect(await terminateServerConnections(ctx, 'active')).toBe(1);
      const res = await push;
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }

    const { rows } = await ctx.db.query<{ status: string }>(
      `SELECT data->>'status' AS status FROM entities WHERE entity = 'ticket' AND id = $1`,
      [ticketId],
    );
    expect(rows[0].status).toBe('open');
    expect((await ctx.api.get('/me', tech.token)).status).toBe(200);
  });

  async function waitForServerLockWait(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const { rowCount } = await ctx.db.query(
        `SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND application_name <> 'fieldsync-test'`,
      );
      if (rowCount) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('the server never waited for the row lock');
  }
});
