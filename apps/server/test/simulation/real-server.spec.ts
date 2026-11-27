import { randomUUID } from 'node:crypto';
import type { Fixtures, SimRequest } from '@fieldsync/sim';
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from '@fieldsync/sync-core';
import { precondition } from '@fieldsync/test-kit';
import type { Socket } from 'node:net';
import { Pool } from 'pg';
import { createTestDatabase, hasDatabase, type TestDatabase } from '../support/database';
import { PullService } from '../../src/pull.service';
import { RealServer } from './real-server';

const describeWithDb = hasDatabase ? describe : describe.skip;

/** The protocol version header every request of the sync client carries. */
const PROTOCOL = { [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) };

describeWithDb('the simulation binding of the real server', () => {
  let database: TestDatabase;
  let server: RealServer;
  let db: Pool;
  const site = randomUUID();
  const user = { id: randomUUID(), name: 'tech', role: 'technician' as const, token: 'sim-token', sites: [site] };
  const fixtures: Fixtures = { sites: [{ id: site, name: 'North' }], users: [user] };
  const time = Date.UTC(2031, 4, 6, 7, 8, 9, 10);

  beforeAll(async () => {
    database = await createTestDatabase();
    server = await RealServer.start(database.url);
    server.httpServer.on('connection', (socket: Socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    db = new Pool({ connectionString: database.url, max: 1 });
  });
  afterAll(async () => {
    await db?.end();
    await server?.close();
    await database?.drop();
  });

  /** The server's open connections (Node keeps no public list, so they are collected as they open). */
  const sockets = new Set<Socket>();
  const openSockets = () => [...sockets].filter((s) => !s.destroyed);

  const push = (mutations: unknown[], clientId = randomUUID()): SimRequest => ({
    method: 'POST',
    path: '/sync/push',
    headers: { ...PROTOCOL, authorization: `Bearer ${user.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ clientId, mutations }),
  });
  const create = (id: string) => ({
    id: 1,
    name: 'ticket.create',
    args: { id, siteId: site, title: 'Pump', description: '' },
  });

  it('serves the production app with time from the simulation', async () => {
    await server.reset(fixtures, () => time);
    const id = randomUUID();
    const res = await server.send(push([create(id)]));
    expect(res).toMatchObject({ status: 201, serverErrors: [] });
    expect(await server.liveRows()).toEqual([
      {
        entity: 'ticket',
        id,
        siteId: site,
        data: expect.objectContaining({ createdAt: new Date(time).toISOString() }),
      },
    ]);
    const { rows } = await db.query<{ created_at: Date }>('SELECT created_at FROM change_log');
    expect(rows.map((r) => r.created_at.getTime())).toEqual([time]);
  });

  it('records the class and code of an exception the server raises, but not of a deliberate HTTP error', async () => {
    await server.reset(fixtures, () => time);
    // A rejection is an answer now, not an exception: a failing service stands in for a server defect.
    const failure = Object.assign(new TypeError('boom'), { code: 'XX000' });
    const pull = jest.spyOn(server.app.get(PullService), 'pull').mockRejectedValueOnce(failure);
    try {
      const failed = await server.send({
        method: 'GET',
        path: '/sync/pull?cursor=0',
        headers: { ...PROTOCOL, authorization: `Bearer ${user.token}` },
      });
      expect(failed.status).toBe(500);
      expect(failed.serverErrors).toEqual([{ name: 'TypeError', code: 'XX000' }]);
    } finally {
      pull.mockRestore();
    }

    const unauthorised = await server.send({ method: 'GET', path: '/me', headers: PROTOCOL });
    expect(unauthorised).toMatchObject({ status: 401, serverErrors: [] });
  });

  it('answers a rejected mutation with its code and records no server error', async () => {
    await server.reset(fixtures, () => time);
    const missingPart = { id: 1, name: 'part.adjust', args: { id: randomUUID(), siteId: site, delta: 1 } };
    const res = await server.send(push([missingPart]));
    expect({ status: res.status, serverErrors: res.serverErrors }).toEqual({ status: 201, serverErrors: [] });
    expect(JSON.parse(res.body)).toMatchObject({ results: [{ id: 1, status: 'rejected', code: 'NOT_FOUND' }] });
  });

  it('starts every run from empty tables and version 1', async () => {
    await server.reset(fixtures, () => time);
    await server.send(push([create(randomUUID())]));
    await server.reset(fixtures, () => time);
    const id = randomUUID();
    await server.send(push([create(id)]));
    const { rows } = await db.query<{ version: string; entity_id: string }>(
      'SELECT version, entity_id FROM change_log',
    );
    expect(rows).toEqual([{ version: '1', entity_id: id }]);
    expect((await db.query('SELECT 1 FROM users')).rowCount).toBe(1);
  });

  it('sends a long series of requests over one listening port and a reused connection', async () => {
    // A port per request (supertest binding a server that is not listening) and a connection per
    // request (superagent's default: no pooling) leave a socket in TIME_WAIT for every request, and a
    // long local search runs out of ephemeral ports (EADDRNOTAVAIL).
    await server.reset(fixtures, () => time);
    let listens = 0;
    let connections = 0;
    const onListening = () => (listens += 1);
    const onConnection = () => (connections += 1);
    server.httpServer.on('listening', onListening);
    server.httpServer.on('connection', onConnection);
    try {
      for (let i = 0; i < 100; i += 1) {
        const res = await server.send({
          method: 'GET',
          path: '/me',
          headers: { ...PROTOCOL, authorization: `Bearer ${user.token}` },
        });
        precondition(res.status === 200, `GET /me answered ${res.status}`);
      }
    } finally {
      server.httpServer.off('listening', onListening);
      server.httpServer.off('connection', onConnection);
    }
    expect(listens).toBe(0);
    // One new connection, or none when an earlier request of this server left one open to reuse.
    expect(connections).toBeLessThanOrEqual(1);
  });

  it('keeps its connection open across a pause longer than the default keep-alive timeout', async () => {
    // Node closes idle keep-alive sockets after keepAliveTimeout (5 s by default); a request sent just
    // as the server closes the socket fails with ECONNRESET and would abort a long search. (Node adds about
    // a second to the timeout before it closes the socket, hence the pause of 6.5 s.)
    const me = { method: 'GET', path: '/me', headers: { ...PROTOCOL, authorization: `Bearer ${user.token}` } };
    await server.reset(fixtures, () => time);
    precondition((await server.send(me)).status === 200, 'the first request failed');
    let closed = 0;
    let connections = 0;
    const onConnection = (socket: Socket) => {
      connections += 1;
      socket.once('close', () => (closed += 1));
    };
    server.httpServer.on('connection', onConnection);
    for (const socket of openSockets()) socket.once('close', () => (closed += 1));
    try {
      await new Promise((resolve) => setTimeout(resolve, 6_500));
      precondition((await server.send(me)).status === 200, 'the request after the pause failed');
    } finally {
      server.httpServer.off('connection', onConnection);
    }
    expect({ closed, connections }).toEqual({ closed: 0, connections: 0 });
  }, 15_000);

  it('reports only rows that are not deleted, straight from the table', async () => {
    await server.reset(fixtures, () => time);
    const id = randomUUID();
    const clientId = randomUUID();
    await server.send(push([create(id), { id: 2, name: 'ticket.delete', args: { id, siteId: site } }], clientId));
    expect(await server.liveRows()).toEqual([]);
  });
});
