import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import type { DataSource, MigrationInterface, QueryRunner } from 'typeorm';
import { createDataSource, MIGRATIONS_TABLE } from '../../src/database/data-source';
import { MIGRATIONS } from '../../src/database/migrations';
import { pendingMigrations, runMigrations } from '../../src/database/migrator';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { describeWithDb } from '../support/integration';

const STARTER_SCHEMA = readFileSync(join(__dirname, '../support/starter-schema.sql'), 'utf8');
const INITIAL = 'InitialSchema1795564800000';

class SlowTable9999999999998 implements MigrationInterface {
  name = 'SlowTable9999999999998';
  async up(q: QueryRunner): Promise<void> {
    await q.query('SELECT pg_sleep(0.3)');
    await q.query('CREATE TABLE slow_marker (id int)');
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE slow_marker');
  }
}

class ConcurrentIndex9999999999999 implements MigrationInterface {
  name = 'ConcurrentIndex9999999999999';
  transaction = false as const;
  async up(q: QueryRunner): Promise<void> {
    await q.query('CREATE INDEX CONCURRENTLY change_log_site_test_idx ON change_log (site_id)');
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP INDEX CONCURRENTLY change_log_site_test_idx');
  }
}

/** Tables, columns, constraints, indexes and sequences of the public schema, minus the migrations table. */
const SNAPSHOT = `
  SELECT 'column ' || table_name || '.' || column_name || ' ' || data_type || ' null=' || is_nullable
         || ' default=' || coalesce(column_default, '') AS item
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> '${MIGRATIONS_TABLE}'
  UNION ALL
  SELECT 'constraint ' || conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid)
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conrelid::regclass::text <> '${MIGRATIONS_TABLE}'
  UNION ALL
  SELECT 'index ' || indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename <> '${MIGRATIONS_TABLE}'
  UNION ALL
  SELECT 'sequence ' || sequence_name || ' ' || data_type
    FROM information_schema.sequences
   WHERE sequence_schema = 'public' AND sequence_name NOT LIKE '${MIGRATIONS_TABLE}%'
  ORDER BY 1`;

describeWithDb('database migrations', () => {
  const databases: TestDatabase[] = [];
  const sources: DataSource[] = [];

  afterAll(async () => {
    await Promise.all(sources.filter((s) => s.isInitialized).map((s) => s.destroy()));
    await Promise.all(databases.map((d) => d.drop()));
  });

  async function emptyDatabase(): Promise<TestDatabase> {
    const db = await createTestDatabase({ empty: true });
    databases.push(db);
    return db;
  }

  async function dataSource(db: TestDatabase, migrations?: Array<new () => unknown>): Promise<DataSource> {
    const ds = createDataSource({ url: db.url, poolSize: 3, applicationName: 'fieldsync-test', migrations });
    sources.push(ds);
    await ds.initialize();
    return ds;
  }

  async function sql<T>(db: TestDatabase, fn: (c: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: db.url });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const snapshot = (db: TestDatabase) =>
    sql(db, async (c) => (await c.query<{ item: string }>(SNAPSHOT)).rows.map((r) => r.item));

  async function starterDatabase(): Promise<TestDatabase> {
    const db = await emptyDatabase();
    await sql(db, (c) => c.query(STARTER_SCHEMA));
    return db;
  }

  it('creates exactly the schema of the original code on an empty database', async () => {
    const db = await emptyDatabase();
    const ds = await dataSource(db);
    expect(await pendingMigrations(ds)).toEqual([INITIAL]);

    expect(await runMigrations(ds)).toEqual([INITIAL]);

    expect(await pendingMigrations(ds)).toEqual([]);
    const reference = await starterDatabase();
    expect(await snapshot(db)).toEqual(await snapshot(reference));
    expect((await snapshot(db)).length).toBeGreaterThan(20);
  });

  it('does nothing when applied again', async () => {
    const db = await emptyDatabase();
    const ds = await dataSource(db);
    await runMigrations(ds);
    const before = await snapshot(db);

    expect(await runMigrations(ds)).toEqual([]);

    expect(await snapshot(db)).toEqual(before);
    expect(await ds.query(`SELECT name FROM ${MIGRATIONS_TABLE}`)).toEqual([{ name: INITIAL }]);
  });

  it('adopts a database created by the original server without changing its schema or data', async () => {
    const db = await starterDatabase();
    const dump = () =>
      sql(db, async (c) => {
        const tables = ['sites', 'users', 'user_sites', 'entities', 'change_log', 'clients'];
        const out: Record<string, unknown> = {};
        for (const t of tables) out[t] = (await c.query(`SELECT * FROM ${t} ORDER BY 1, 2`)).rows;
        return out;
      });
    await sql(db, (c) =>
      c.query(`
        INSERT INTO sites VALUES ('00000000-0000-4000-8000-0000000000a1', 'North Plant');
        INSERT INTO users VALUES ('00000000-0000-4000-8000-000000000002', 'Tom', 'technician', 'tech-a-token');
        INSERT INTO user_sites VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000a1');
        INSERT INTO change_log (site_id, entity, entity_id, op, data) VALUES
          ('00000000-0000-4000-8000-0000000000a1', 'ticket', '11111111-1111-4111-8111-111111111111', 'put', '{"title":"a"}'),
          ('00000000-0000-4000-8000-0000000000a1', 'ticket', '11111111-1111-4111-8111-111111111111', 'put', '{"title":"b"}');
        INSERT INTO entities VALUES ('ticket', '11111111-1111-4111-8111-111111111111',
          '00000000-0000-4000-8000-0000000000a1', '{"title":"b"}', false, 2);
        INSERT INTO clients VALUES ('client-1', '00000000-0000-4000-8000-000000000002', 7);
      `),
    );
    const schemaBefore = await snapshot(db);
    const dataBefore = await dump();
    const ds = await dataSource(db);

    expect(await runMigrations(ds)).toEqual([INITIAL]);

    expect(await snapshot(db)).toEqual(schemaBefore);
    expect(await dump()).toEqual(dataBefore);
    const next = await ds.query<Array<{ version: string }>>(
      `INSERT INTO change_log (site_id, entity, entity_id, op) VALUES
         ('00000000-0000-4000-8000-0000000000a1', 'ticket', '11111111-1111-4111-8111-111111111111', 'del')
       RETURNING version`,
    );
    expect(Number(next[0].version)).toBe(3);
  });

  it('runs a migration that must not run inside a transaction', async () => {
    const db = await emptyDatabase();
    const ds = await dataSource(db, [...MIGRATIONS, ConcurrentIndex9999999999999]);

    expect(await runMigrations(ds)).toEqual([INITIAL, 'ConcurrentIndex9999999999999']);

    const valid = await ds.query<Array<{ indisvalid: boolean }>>(
      `SELECT indisvalid FROM pg_index WHERE indexrelid = 'change_log_site_test_idx'::regclass`,
    );
    expect(valid).toEqual([{ indisvalid: true }]);
  });

  it('applies each migration once when several runs start at the same time', async () => {
    const db = await emptyDatabase();
    const migrations = [...MIGRATIONS, SlowTable9999999999998];
    const runs = await Promise.all([1, 2, 3].map(async () => runMigrations(await dataSource(db, migrations))));

    expect(runs.flat().sort()).toEqual([INITIAL, 'SlowTable9999999999998'].sort());
    const rows = await sql(
      db,
      async (c) => (await c.query<{ name: string }>(`SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id`)).rows,
    );
    expect(rows).toEqual([{ name: INITIAL }, { name: 'SlowTable9999999999998' }]);
  });
});
