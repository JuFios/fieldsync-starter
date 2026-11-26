import type { PullResponse, PushResponse } from '@fieldsync/sync-core';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { describeWithDb, useIntegration } from '../support/integration';

/**
 * The global guard and validation pipe (APP_GUARD, APP_PIPE). The pipe checks the DTO-typed
 * parameters of the sync endpoints (see request-validation.spec.ts for the shapes it refuses) and
 * must hand the handlers every argument a mutator may read.
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

  it('refuses a non-numeric cursor instead of reading it as 0', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const res = await ctx.api.get<PullResponse>('/sync/pull?cursor=abc&limit=xyz', tech.token);
    expect(res.status).toBe(400);
  });

  it('hands the mutator arguments over untouched, keys class-transformer cannot copy included', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const id = randomUUID();
    // Raw JSON: an object literal with a "__proto__" key would set the prototype instead.
    const body = `{"clientId":"${randomUUID()}","mutations":[{"id":1,"name":"ticket.create","args":{"id":"${id}","siteId":"${site}","title":"Pump","description":"Leak","constructor":{"prototype":{"x":1}},"__proto__":{"title":"Other"},"nested":[{"constructor":"x"}]}}]}`;
    const res = await request(ctx.server.app.getHttpServer() as Server)
      .post('/sync/push')
      .set('authorization', `Bearer ${tech.token}`)
      .set('content-type', 'application/json')
      .send(body);
    expect({ status: res.status, results: (res.body as PushResponse).results }).toEqual({
      status: 201,
      results: [{ id: 1, status: 'applied' }],
    });
    const { rows } = await ctx.db.query<{ data: { title: string } }>(
      `SELECT data FROM entities WHERE entity = 'ticket' AND id = $1`,
      [id],
    );
    expect(rows[0].data.title).toBe('Pump');
  });
});
