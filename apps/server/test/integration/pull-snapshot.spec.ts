import { randomUUID } from 'node:crypto';
import type { PullResponse, PushResponse } from '@fieldsync/sync-core';
import { precondition } from '@fieldsync/test-kit';
import type { TestUser } from '../support/fixtures';
import { describeWithDb, useIntegration } from '../support/integration';

describeWithDb('pull pages and cursors', () => {
  const ctx = useIntegration();

  const create = (user: TestUser, clientId: string, id: number, siteId: string) =>
    ctx.api.post<PushResponse>(
      '/sync/push',
      {
        clientId,
        mutations: [{ id, name: 'ticket.create', args: { id: randomUUID(), siteId, title: 'T', description: '' } }],
      },
      user.token,
    );

  async function head(): Promise<number> {
    const { rows } = await ctx.db.query<{ version: string }>('SELECT version FROM log_head');
    return Number(rows[0].version);
  }

  it('moves the cursor past changes the user cannot see', async () => {
    const mine = await ctx.fixtures.site();
    const other = await ctx.fixtures.site();
    const me = await ctx.fixtures.technician(mine);
    const someone = await ctx.fixtures.technician(other);
    await create(someone, randomUUID(), 1, other);
    const res = await ctx.api.get<PullResponse>('/sync/pull?cursor=0', me.token);
    expect(res.body).toMatchObject({ changes: [], nextCursor: await head(), hasMore: false });
  });

  it('reports no more changes when the page ends at the head', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const start = await head();
    const clientId = randomUUID();
    for (let id = 1; id <= 3; id += 1) await create(tech, clientId, id, site);
    const full = await ctx.api.get<PullResponse>(`/sync/pull?cursor=${start}&limit=3`, tech.token);
    const partial = await ctx.api.get<PullResponse>(`/sync/pull?cursor=${start}&limit=2`, tech.token);
    expect([full.body.hasMore, full.body.nextCursor, partial.body.hasMore, partial.body.nextCursor]).toEqual([
      false,
      start + 3,
      true,
      start + 2,
    ]);
  });

  it('never acknowledges a mutation whose change lies beyond the page it answers with', async () => {
    // The property the client relies on: on the last page of a pull (hasMore false), every mutation up
    // to lastMutationId has its change at or before nextCursor. Pulls run while the client pushes.
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const clientId = randomUUID();
    const versionOf = new Map<number, number>();
    let pushing = true;
    const pushes = (async () => {
      for (let id = 1; id <= 60; id += 1) {
        const res = await create(tech, clientId, id, site);
        const r = res.body.results[0];
        precondition(r?.status === 'applied' && r.version !== undefined, `push ${id}: ${JSON.stringify(res.body)}`);
        versionOf.set(id, r.version);
      }
      pushing = false;
    })();
    const violations: string[] = [];
    let cursor = await head();
    while (pushing) {
      const res = await ctx.api.get<PullResponse>(
        `/sync/pull?cursor=${cursor}&limit=5&clientId=${clientId}`,
        tech.token,
      );
      if (!res.body.hasMore) {
        for (let id = 1; id <= res.body.lastMutationId; id += 1) {
          const version = versionOf.get(id);
          // A push whose answer has not arrived yet is checked by the next pull.
          if (version !== undefined && version > res.body.nextCursor) {
            violations.push(`mutation ${id} at ${version} acknowledged at cursor ${res.body.nextCursor}`);
          }
        }
      }
      cursor = res.body.nextCursor;
    }
    await pushes;
    expect(violations).toEqual([]);
  });
});
