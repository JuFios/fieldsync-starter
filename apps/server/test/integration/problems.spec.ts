import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { PullService } from '../../src/pull.service';
import { describeWithDb, useIntegration } from '../support/integration';

/** Every error answer is a problem (RFC 9457) with a code, on every route. */
describeWithDb('error answers', () => {
  const ctx = useIntegration({ JSON_BODY_LIMIT_BYTES: '1048576' });
  const http = () => request(ctx.server.app.getHttpServer() as Server);

  it('answers a missing token with a 401 problem', async () => {
    const res = await http().get('/sync/pull');
    expect({ status: res.status, type: res.headers['content-type'], body: res.body as unknown }).toEqual({
      status: 401,
      type: expect.stringMatching(/^application\/problem\+json/),
      body: {
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        detail: expect.any(String),
        code: 'UNAUTHORIZED',
      },
    });
  });

  it('lists every invalid field of a request', async () => {
    const tech = await ctx.fixtures.technician(await ctx.fixtures.site());
    const res = await http().get('/sync/pull?cursor=abc&limit=0').set('authorization', `Bearer ${tech.token}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'BAD_REQUEST',
      errors: ['cursor must be an integer from 0 to 9007199254740991', 'limit must be an integer from 1 to 500'],
    });
  });

  it.each([
    ['a body that is not JSON', '{"clientId":', 400, 'BAD_REQUEST'],
    ['a body above the limit', `{"x":"${'x'.repeat(1_048_576)}"}`, 413, 'PAYLOAD_TOO_LARGE'],
  ])('answers %s as a problem', async (_case, body, status, code) => {
    const tech = await ctx.fixtures.technician(await ctx.fixtures.site());
    const res = await http()
      .post('/sync/push')
      .set('authorization', `Bearer ${tech.token}`)
      .set('content-type', 'application/json')
      .send(body);
    expect({ status: res.status, code: (res.body as { code?: string }).code }).toEqual({ status, code });
  });

  it('answers an unexpected error with 500 and tells the client nothing about it', async () => {
    const tech = await ctx.fixtures.technician(await ctx.fixtures.site());
    const failure = new TypeError(`secret ${randomUUID()}`);
    const pull = jest.spyOn(ctx.server.app.get(PullService), 'pull').mockRejectedValueOnce(failure);
    try {
      const res = await http().get('/sync/pull').set('authorization', `Bearer ${tech.token}`);
      expect({ status: res.status, body: res.body as unknown }).toEqual({
        status: 500,
        body: {
          type: 'about:blank',
          title: 'Internal Server Error',
          status: 500,
          detail: 'The server could not handle the request',
          code: 'INTERNAL',
        },
      });
      expect(res.text).not.toContain('secret');
    } finally {
      pull.mockRestore();
    }
  });
});
