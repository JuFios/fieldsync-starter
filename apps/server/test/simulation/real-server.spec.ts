import { randomUUID } from 'node:crypto';
import type { Fixtures, SimRequest } from '@fieldsync/sim';
import { Pool } from 'pg';
import { createTestDatabase, hasDatabase, type TestDatabase } from '../support/database';
import { RealServer } from './real-server';

const describeWithDb = hasDatabase ? describe : describe.skip;

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
    db = new Pool({ connectionString: database.url, max: 1 });
  });
  afterAll(async () => {
    await db?.end();
    await server?.close();
    await database?.drop();
  });

  const push = (mutations: unknown[], clientId = randomUUID()): SimRequest => ({
    method: 'POST',
    path: '/sync/push',
    headers: { authorization: `Bearer ${user.token}`, 'content-type': 'application/json' },
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
    const missingPart = { id: 1, name: 'part.adjust', args: { id: randomUUID(), siteId: site, delta: 1 } };
    const failed = await server.send(push([missingPart]));
    expect(failed.status).toBe(500);
    expect(failed.serverErrors).toEqual([{ name: 'MutationRejected', code: 'NOT_FOUND' }]);

    const unauthorised = await server.send({ method: 'GET', path: '/me', headers: {} });
    expect(unauthorised).toMatchObject({ status: 401, serverErrors: [] });
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

  it('reports only rows that are not deleted, straight from the table', async () => {
    await server.reset(fixtures, () => time);
    const id = randomUUID();
    const clientId = randomUUID();
    await server.send(push([create(id), { id: 2, name: 'ticket.delete', args: { id, siteId: site } }], clientId));
    expect(await server.liveRows()).toEqual([]);
  });
});
