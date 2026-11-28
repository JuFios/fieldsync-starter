import {
  asVersion,
  HttpTransport,
  MemoryStorage,
  SyncClient,
  TransportError,
  type PushResponse,
  type Transport,
} from '../src';
import { CLIENT_ID } from './support/ids';

function answer(status: number, body: string, headers: Record<string, string> = {}): typeof fetch {
  return () => Promise.resolve(new Response(body, { status, headers }));
}

const problem = { 'content-type': 'application/problem+json; charset=utf-8' };
const push = (fetchImpl: typeof fetch) =>
  new HttpTransport('http://api', 'token', fetchImpl).push({ clientId: CLIENT_ID, mutations: [] });

describe('HttpTransport', () => {
  it('turns a problem answer into a TransportError with its code and details', async () => {
    const body = JSON.stringify({
      status: 409,
      code: 'MUTATION_OUT_OF_ORDER',
      detail: 'expected 2',
      details: { expected: 2 },
    });
    const err = await push(answer(409, body, problem)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect(err).toMatchObject({
      status: 409,
      code: 'MUTATION_OUT_OF_ORDER',
      details: { expected: 2 },
      message: 'push failed: expected 2',
    });
  });

  it('keeps the Retry-After of a transient failure', async () => {
    const body = JSON.stringify({ status: 503, code: 'TRANSIENT', detail: 'busy' });
    await expect(push(answer(503, body, { ...problem, 'retry-after': '1' }))).rejects.toMatchObject({
      code: 'TRANSIENT',
      retryAfterSeconds: 1,
    });
  });

  it.each([
    ['an answer that is not a problem', answer(502, '<html>Bad gateway</html>', { 'content-type': 'text/html' })],
    ['a problem body that is not JSON', answer(500, '{"code":', problem)],
  ])('reports %s by its status', async (_case, fetchImpl) => {
    const err = await push(fetchImpl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect(err).toMatchObject({ code: 'HTTP_ERROR', retryAfterSeconds: undefined });
  });
});

describe('ids in answers', () => {
  const json = { 'content-type': 'application/json' };

  it.each([['-1'], ['1.5'], ['"3"'], ['null']])(
    'refuses a retirement answered with %s as the last id',
    async (last) => {
      const transport = new HttpTransport('http://api', 'token', answer(200, `{"lastMutationId":${last}}`, json));
      await expect(transport.retire(CLIENT_ID)).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
    },
  );

  it('takes 0 from a retirement of an id nothing was handled under', async () => {
    const transport = new HttpTransport('http://api', 'token', answer(200, '{"lastMutationId":0}', json));
    await expect(transport.retire(CLIENT_ID)).resolves.toEqual({ lastMutationId: 0 });
  });

  it('stores nothing from a push answered with a last id that is none, and keeps the mutation', async () => {
    const storage = new MemoryStorage();
    const transport: Transport = {
      // As a broken server would send it: the body of an answer is not checked field by field.
      push: () => Promise.resolve(JSON.parse('{"results":[{"id":1,"status":"applied"}]}') as PushResponse),
      pull: () => Promise.reject(new Error('offline')),
      snapshot: () => Promise.reject(new Error('offline')),
    };
    const client = new SyncClient({ clientId: CLIENT_ID, transport, storage, live: false });
    try {
      await client.mutate('ticket.delete', { id: CLIENT_ID, siteId: CLIENT_ID });
      await client.sync();
      expect(client.status).toBe('offline');
      expect(client.pendingCount).toBe(1);
      expect((await storage.load()).meta).toMatchObject({ lastMutationId: 0, nextMutationId: 2 });
    } finally {
      // A client left alive keeps retrying on the system clock, and Jest waiting for it.
      client.dispose();
    }
  });
});

describe('SyncClient.syncError', () => {
  it('names the problem of the last failed sync and clears it after a successful one', async () => {
    let fail = true;
    const transport: Transport = {
      push: () =>
        fail
          ? Promise.reject(new TransportError(409, 'MUTATION_OUT_OF_ORDER', 'push failed', { expected: 2 }))
          : Promise.resolve({ results: [], lastMutationId: 0 }),
      pull: () =>
        Promise.resolve({
          changes: [],
          nextCursor: asVersion(0),
          hasMore: false,
          lastMutationId: 0,
          head: asVersion(0),
        }),
      snapshot: () => Promise.resolve({ watermark: asVersion(0), head: asVersion(0), rows: [], next: null }),
    };
    const client = new SyncClient({ clientId: CLIENT_ID, transport, storage: new MemoryStorage() });
    try {
      await client.mutate('ticket.delete', {
        id: '00000000-0000-4000-8000-000000000001',
        siteId: '33333333-3333-4333-8333-333333333333',
      });
      await client.sync();
      expect(client.syncError).toEqual({ status: 409, code: 'MUTATION_OUT_OF_ORDER', details: { expected: 2 } });
      fail = false;
      await client.sync();
      expect(client.syncError).toBeUndefined();
    } finally {
      client.dispose();
    }
  });

  it('reports a request that got no answer as NETWORK', async () => {
    const transport: Transport = {
      push: () => Promise.reject(new TypeError('fetch failed')),
      pull: () => Promise.reject(new TypeError('fetch failed')),
      snapshot: () => Promise.reject(new TypeError('fetch failed')),
    };
    const client = new SyncClient({ clientId: CLIENT_ID, transport, storage: new MemoryStorage() });
    try {
      await client.sync();
      expect(client.syncError).toEqual({ status: 0, code: 'NETWORK' });
    } finally {
      client.dispose();
    }
  });
});
