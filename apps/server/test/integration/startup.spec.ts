import { startApp, type RunningApp } from '../support/app';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { Api } from '../support/http';
import { describeWithDb } from '../support/integration';

describeWithDb('server startup', () => {
  const databases: TestDatabase[] = [];
  afterAll(() => Promise.all(databases.map((d) => d.drop())));

  async function database(opts: { empty?: boolean } = {}): Promise<TestDatabase> {
    const db = await createTestDatabase(opts);
    databases.push(db);
    return db;
  }

  it('refuses to start until the migrations have been applied', async () => {
    const db = await database({ empty: true });
    let server: RunningApp | undefined;
    let error: unknown;
    try {
      server = await startApp(db.url);
    } catch (err) {
      error = err;
    } finally {
      await server?.close();
    }
    expect(String(error)).toContain('pending migrations: InitialSchema1795564800000');
    expect(String(error)).toContain('npm run migrate');
  });

  it('seeds the demo data when SEED_DEMO is true, idempotently', async () => {
    const db = await database();
    for (let start = 0; start < 2; start += 1) {
      const server = await startApp(db.url, { SEED_DEMO: 'true' });
      try {
        const me = await new Api(server.url).get<{ role: string; sites: Array<{ name: string }> }>(
          '/me',
          'tech-a-token',
        );
        expect(me.status).toBe(200);
        expect(me.body).toMatchObject({ role: 'technician', sites: [{ name: 'North Plant' }] });
        const admin = await new Api(server.url).get<{ sites: unknown[] }>('/me', 'admin-token');
        expect(admin.body.sites).toHaveLength(2);
      } finally {
        await server.close();
      }
    }
  });

  it('does not seed anything when SEED_DEMO is false', async () => {
    const db = await database();
    const server = await startApp(db.url, { SEED_DEMO: 'false' });
    try {
      expect((await new Api(server.url).get('/me', 'tech-a-token')).status).toBe(401);
    } finally {
      await server.close();
    }
  });
});
