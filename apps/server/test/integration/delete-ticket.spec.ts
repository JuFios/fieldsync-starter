import { randomUUID } from 'node:crypto';
import type { Mutation, PullResponse, PushResponse } from '@fieldsync/sync-core';
import { precondition } from '@fieldsync/test-kit';
import { describeWithDb, useIntegration } from '../support/integration';

/** A deleted ticket takes its parts with it, also against a concurrent edit of a part. */
describeWithDb('deleting a ticket', () => {
  const ctx = useIntegration();

  it('deletes its parts in the same mutation and publishes their deletion', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const ticket = randomUUID();
    const parts = [randomUUID(), randomUUID()];
    const clientId = randomUUID();
    const mutations: Mutation[] = [
      { id: 1, name: 'ticket.create', args: { id: ticket, siteId: site, title: 'Pump', description: '' } },
      ...parts.map((id, i) => ({
        id: i + 2,
        name: 'part.add' as const,
        args: { id, ticketId: ticket, siteId: site, name: 'Seal', quantity: 1 },
      })),
    ];
    precondition((await ctx.api.post('/sync/push', { clientId, mutations }, tech.token)).status === 201, 'setup');
    const before = await ctx.api.get<PullResponse>('/sync/pull?cursor=0', tech.token);

    const res = await ctx.api.post<PushResponse>(
      '/sync/push',
      { clientId, mutations: [{ id: 4, name: 'ticket.delete', args: { id: ticket, siteId: site } }] },
      tech.token,
    );
    expect(res.body.results?.[0]?.status).toBe('applied');

    const { rows } = await ctx.db.query<{ id: string; deleted: boolean }>(
      `SELECT id, deleted FROM entities WHERE entity = 'part' AND id = ANY($1) ORDER BY id`,
      [parts],
    );
    expect(rows.map((r) => r.deleted)).toEqual([true, true]);
    const after = await ctx.api.get<PullResponse>(`/sync/pull?cursor=${before.body.nextCursor}`, tech.token);
    expect(
      after.body.changes
        .filter((c) => c.entity === 'part')
        .map((c) => [c.id, c.op])
        .sort(),
    ).toEqual(parts.map((id) => [id, 'del']).sort());
  });

  it('rejects an adjustment of a part whose ticket was deleted', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const ticket = randomUUID();
    const part = randomUUID();
    const deleter = randomUUID();
    await ctx.api.post(
      '/sync/push',
      {
        clientId: deleter,
        mutations: [
          { id: 1, name: 'ticket.create', args: { id: ticket, siteId: site, title: 'Pump', description: '' } },
          { id: 2, name: 'part.add', args: { id: part, ticketId: ticket, siteId: site, name: 'Seal', quantity: 1 } },
          { id: 3, name: 'ticket.delete', args: { id: ticket, siteId: site } },
        ],
      },
      tech.token,
    );
    // Another technician adjusted the part offline, before seeing the deletion.
    const late = await ctx.api.post<PushResponse>(
      '/sync/push',
      {
        clientId: randomUUID(),
        mutations: [{ id: 1, name: 'part.adjust', args: { id: part, siteId: site, delta: 2 } }],
      },
      tech.token,
    );
    expect(late.body.results).toEqual([
      { id: 1, status: 'rejected', code: 'NOT_FOUND', message: 'Part no longer exists' },
    ]);
  });

  it('finds the parts of a ticket through their index', async () => {
    const client = await ctx.db.connect();
    try {
      // The test tables are tiny, so a sequential scan would win; forbid it to see the index can serve.
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT id, data, site_id FROM entities
          WHERE entity = 'part' AND NOT deleted AND data->>'ticketId' = $1 ORDER BY id FOR UPDATE`,
        [randomUUID()],
      );
      expect(rows.map((r) => r['QUERY PLAN']).join('\n')).toContain('entities_part_ticket_idx');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
