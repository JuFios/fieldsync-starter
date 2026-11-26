import { randomUUID } from 'node:crypto';
import { MutationRejected, type Mutation } from '@fieldsync/sync-core';
import { Db } from '../../src/db';
import { applyMutation } from '../../src/server-tx';
import { describeWithDb, useIntegration } from '../support/integration';

describeWithDb('arguments Postgres cannot store', () => {
  const ctx = useIntegration();

  async function applyCreate(text: { title: string; description: string }) {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const id = randomUUID();
    const m: Mutation = { id: 1, name: 'ticket.create', args: { id, siteId: site, ...text } };
    const result = ctx.server.app.get(Db).tx((c) => applyMutation(c, { id: tech.id, role: tech.role }, m, new Date()));
    return { id, site, result };
  }

  it.each([
    ['a NUL character', 'pump\u0000room'],
    ['an unpaired surrogate', 'pump \ud83d'],
  ])('rejects a title with %s as a mutation, not as a database error', async (_label, title) => {
    const { result } = await applyCreate({ title, description: '' });
    await expect(result).rejects.toEqual(expect.any(MutationRejected));
    await expect(result).rejects.toMatchObject({ code: 'BAD_ARGS' });
  });

  it('stores a long description cut at a character boundary', async () => {
    const { id, site, result } = await applyCreate({ title: 'pump', description: `${'x'.repeat(4999)}\u{1F600}` });
    await expect(result).resolves.toEqual([site]);
    const { rows } = await ctx.db.query<{ description: string }>(
      `SELECT data->>'description' AS description FROM entities WHERE entity = 'ticket' AND id = $1`,
      [id],
    );
    expect(rows).toEqual([{ description: 'x'.repeat(4999) }]);
  });
});
