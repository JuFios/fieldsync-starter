import type { PullResponse, PushResponse } from '@fieldsync/sync-core';
import { randomUUID } from 'node:crypto';
import { describeWithDb, useIntegration } from '../support/integration';

/**
 * The global guard and validation pipe (APP_GUARD, APP_PIPE). The pipe validates DTO-typed
 * parameters only; until the sync endpoints declare DTOs it must leave their bodies and query
 * strings exactly as the handlers received them before.
 */
describeWithDb('request pipeline', () => {
  const ctx = useIntegration();

  it.each([
    ['GET', '/me'],
    ['GET', '/sync/pull?cursor=0'],
    ['GET', '/sync/stream'],
    ['POST', '/sync/push'],
  ] as const)('requires a token for %s %s', async (method, path) => {
    const res = await ctx.api.request(
      method,
      path,
      method === 'POST' ? { body: { clientId: 'c', mutations: [] } } : {},
    );
    expect(res.status).toBe(401);
  });

  it('serves /health without a token', async () => {
    expect((await ctx.api.get('/health')).status).toBe(200);
  });

  it('passes the push body through unchanged, properties the handler does not know included', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const id = randomUUID();
    const res = await ctx.api.post<PushResponse>(
      '/sync/push',
      {
        clientId: randomUUID(),
        extra: true,
        mutations: [{ id: 1, name: 'ticket.create', args: { id, siteId: site, title: 'Pump', description: 'Leak' } }],
      },
      tech.token,
    );
    expect(res.body.results).toEqual([{ id: 1, status: 'applied' }]);
    const { rows } = await ctx.db.query<{ data: { title: string; description: string } }>(
      `SELECT data FROM entities WHERE entity = 'ticket' AND id = $1`,
      [id],
    );
    expect(rows[0].data).toMatchObject({ title: 'Pump', description: 'Leak' });
  });

  it('leaves the query strings to the handler, which reads a non-numeric cursor as 0 as before', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const fromZero = await ctx.api.get<PullResponse>('/sync/pull?cursor=0&limit=500', tech.token);
    const fromText = await ctx.api.get<PullResponse>('/sync/pull?cursor=abc&limit=xyz', tech.token);
    expect(fromText.status).toBe(200);
    expect(fromText.body).toEqual(fromZero.body);
  });
});
