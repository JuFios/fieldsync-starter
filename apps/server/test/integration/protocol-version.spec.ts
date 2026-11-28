import { PROTOCOL_HEADER, PROTOCOL_VERSION } from '@fieldsync/sync-core';
import { SERVER_UPDATE_RETRY_SECONDS, SUPPORTED_PROTOCOL } from '../../src/protocol.guard';
import { describeWithDb, useIntegration } from '../support/integration';
import { listenOnLoopback, openStream } from '../support/stream';

/** Every sync route checks the protocol version first; an outdated client is told to update. */
describeWithDb('protocol version', () => {
  const ctx = useIntegration();
  const range = { min: SUPPORTED_PROTOCOL.min, max: SUPPORTED_PROTOCOL.max };

  const routes: Array<[string, 'GET' | 'POST', string, unknown]> = [
    ['push', 'POST', '/sync/push', { clientId: '11111111-1111-4111-8111-111111111111', mutations: [] }],
    ['pull', 'GET', '/sync/pull?cursor=0', undefined],
    ['snapshot', 'GET', '/sync/snapshot', undefined],
    ['me', 'GET', '/me', undefined],
  ];

  it.each(routes)(
    '%s: answers a client that sends no version with CLIENT_UPDATE_REQUIRED',
    async (_name, method, path, body) => {
      const tech = await ctx.fixtures.technician(await ctx.fixtures.site());
      const res = await ctx.api.request(method, path, { token: tech.token, body, protocol: null });
      expect({ status: res.status, body: res.body }).toEqual({
        status: 400,
        body: expect.objectContaining({ code: 'CLIENT_UPDATE_REQUIRED', details: range }) as unknown,
      });
    },
  );

  it.each(routes)('%s: answers the current version as usual', async (_name, method, path, body) => {
    const tech = await ctx.fixtures.technician(await ctx.fixtures.site());
    const res = await ctx.api.request(method, path, { token: tech.token, body });
    expect(res.status).toBeLessThan(300);
  });

  it('answers a version below the range with CLIENT_UPDATE_REQUIRED and the version it got', async () => {
    const tech = await ctx.fixtures.technician(await ctx.fixtures.site());
    const res = await ctx.api.request('GET', '/sync/pull?cursor=0', { token: tech.token, protocol: '0' });
    expect({ status: res.status, body: res.body }).toEqual({
      status: 400,
      body: expect.objectContaining({ code: 'CLIENT_UPDATE_REQUIRED', details: { ...range, version: 0 } }) as unknown,
    });
  });

  it('tells an outdated client to update before it looks at the token', async () => {
    const res = await ctx.api.request('GET', '/sync/pull?cursor=0', { token: 'not-a-token', protocol: null });
    expect(res.body).toMatchObject({ code: 'CLIENT_UPDATE_REQUIRED' });
  });

  it('asks a client newer than the server to retry later', async () => {
    const tech = await ctx.fixtures.technician(await ctx.fixtures.site());
    const version = SUPPORTED_PROTOCOL.max + 1;
    const res = await ctx.api.request('GET', '/sync/pull?cursor=0', { token: tech.token, protocol: String(version) });
    expect({ status: res.status, retryAfter: res.headers['retry-after'], body: res.body }).toEqual({
      status: 503,
      retryAfter: String(SERVER_UPDATE_RETRY_SECONDS),
      body: expect.objectContaining({ code: 'SERVER_UPDATE_REQUIRED', details: { ...range, version } }) as unknown,
    });
  });

  it.each(['abc', '1.0', '1, 1', ' ', '1e1', '99999999999'])(
    'answers a version header %j that is not a version with 400',
    async (value) => {
      const tech = await ctx.fixtures.technician(await ctx.fixtures.site());
      const res = await ctx.api.request('GET', '/sync/pull?cursor=0', { token: tech.token, protocol: value });
      expect({ status: res.status, code: (res.body as { code?: string }).code }).toEqual({
        status: 400,
        code: 'BAD_REQUEST',
      });
    },
  );

  it('does not check the health route', async () => {
    const res = await ctx.api.request('GET', '/health', { protocol: null });
    expect(res.status).toBe(200);
  });

  // The web app is on another origin: a browser lets its code read only the response headers the
  // server exposes (Retry-After is not one of the CORS-safelisted ones), and the client's backoff
  // waits at least as long as it says.
  it('lets a web app on another origin read Retry-After', async () => {
    const port = await listenOnLoopback(ctx.server.app);
    const res = await fetch(`http://127.0.0.1:${port}/sync/pull?cursor=0`, {
      headers: { origin: 'http://localhost:3000', [PROTOCOL_HEADER]: String(SUPPORTED_PROTOCOL.max + 1) },
    });
    expect({ status: res.status, exposed: res.headers.get('access-control-expose-headers') }).toEqual({
      status: 503,
      exposed: 'Retry-After',
    });
  });

  it('checks the stream too, and opens it for the current version', async () => {
    const tech = await ctx.fixtures.technician(await ctx.fixtures.site());
    const port = await listenOnLoopback(ctx.server.app);
    const old = await openStream(port, { authorization: `Bearer ${tech.token}`, [PROTOCOL_HEADER]: '0' });
    await old.ended;
    expect(old.status).toBe(400);
    const current = await openStream(port, {
      authorization: `Bearer ${tech.token}`,
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    });
    try {
      expect(current.status).toBe(200);
    } finally {
      current.close();
    }
  });
});
