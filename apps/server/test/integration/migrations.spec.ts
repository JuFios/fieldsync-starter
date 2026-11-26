import { Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { DataSource, type MigrationInterface, type QueryRunner } from 'typeorm';
import { createDataSource, MIGRATIONS_TABLE } from '../../src/database/data-source';
import { MIGRATIONS } from '../../src/database/migrations';
import { InitialSchema1795564800000 } from '../../src/database/migrations/1795564800000-initial-schema';
import { MIGRATION_LOCK_KEY, pendingMigrations, runMigrations } from '../../src/database/migrator';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { describeWithDb } from '../support/integration';

const STARTER_SCHEMA = readFileSync(join(__dirname, '../support/starter-schema.sql'), 'utf8');
const INITIAL = 'InitialSchema1795564800000';
/**
 * The first migration alone: the tests of the migration mechanism (locking, transactions) and of
 * adopting the original database run on it; the later migrations have tests of their own below.
 */
const BASELINE = [InitialSchema1795564800000];

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

class LongTable9999999999997 implements MigrationInterface {
  name = 'LongTable9999999999997';
  async up(q: QueryRunner): Promise<void> {
    await q.query('SELECT pg_sleep(0.8)');
    await q.query('CREATE TABLE long_marker (id int)');
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE long_marker');
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

  async function dataSource(
    db: TestDatabase,
    migrations?: Array<new () => unknown>,
    poolSize = 3,
  ): Promise<DataSource> {
    const ds = createDataSource({
      url: db.url,
      poolSize,
      applicationName: 'fieldsync-test',
      migrations: migrations ?? BASELINE,
    });
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
    const ds = await dataSource(db, [...BASELINE, ConcurrentIndex9999999999999]);

    expect(await runMigrations(ds)).toEqual([INITIAL, 'ConcurrentIndex9999999999999']);

    const valid = await ds.query<Array<{ indisvalid: boolean }>>(
      `SELECT indisvalid FROM pg_index WHERE indexrelid = 'change_log_site_test_idx'::regclass`,
    );
    expect(valid).toEqual([{ indisvalid: true }]);
  });

  it('applies each migration once when several runs start at the same time', async () => {
    const db = await emptyDatabase();
    const migrations = [...BASELINE, SlowTable9999999999998];
    const runs = await Promise.all([1, 2, 3].map(async () => runMigrations(await dataSource(db, migrations))));

    expect(runs.flat().sort()).toEqual([INITIAL, 'SlowTable9999999999998'].sort());
    const rows = await sql(
      db,
      async (c) => (await c.query<{ name: string }>(`SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id`)).rows,
    );
    expect(rows).toEqual([{ name: INITIAL }, { name: 'SlowTable9999999999998' }]);
  });

  /** Warnings the migrator logged about its lock while `fn` ran. */
  async function lockWarnings(fn: () => Promise<unknown>): Promise<string[]> {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await fn();
      return warn.mock.calls.map((args) => String(args[0])).filter((m) => m.includes('migration lock'));
    } finally {
      warn.mockRestore();
    }
  }

  it('gives up with a clear message when another run holds the lock for too long', async () => {
    const db = await emptyDatabase();
    await sql(db, (c) => c.query(`ALTER DATABASE ${db.name} SET lock_timeout = '7s'`));
    const ds = await dataSource(db, undefined, 1);
    await sql(db, async (holder) => {
      await holder.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      await expect(runMigrations(ds, { lockTimeoutMs: 300 })).rejects.toThrow(
        'Another migration run has held the migration lock for more than 300 ms',
      );
    });
    expect(await pendingMigrations(ds)).toEqual([INITIAL]);
    // The lock's own timeout never leaks into the application's connections.
    expect(await ds.query(`SHOW lock_timeout`)).toEqual([{ lock_timeout: '7s' }]);
  });

  it('waits for the lock up to its own timeout even when statements have a shorter one', async () => {
    const db = await emptyDatabase();
    await sql(db, (c) => c.query(`ALTER DATABASE ${db.name} SET statement_timeout = '200ms'`));
    const ds = await dataSource(db, undefined, 1);
    await sql(db, async (holder) => {
      await holder.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      await expect(runMigrations(ds, { lockTimeoutMs: 800 })).rejects.toThrow(
        'Another migration run has held the migration lock for more than 800 ms',
      );
    });
  });

  it('keeps the lock through migrations that outlast the idle session timeout', async () => {
    const db = await emptyDatabase();
    await sql(db, (c) => c.query(`ALTER DATABASE ${db.name} SET idle_session_timeout = '300ms'`));
    // The setting must reach only the lock's session: the DataSource's own connections opt out, so
    // a pooled connection that waits a little before the migrations cannot be ended under them.
    const base = createDataSource({
      url: db.url,
      poolSize: 3,
      applicationName: 'fieldsync-test',
      migrations: [...BASELINE, LongTable9999999999997],
    });
    const ds = new DataSource({ ...base.options, extra: { options: '-c idle_session_timeout=0' } });
    sources.push(ds);
    await ds.initialize();
    let applied: string[] = [];

    const warnings = await lockWarnings(async () => {
      applied = await runMigrations(ds);
    });

    expect(applied).toEqual([INITIAL, 'LongTable9999999999997']);
    expect(warnings).toEqual([]);
  });

  it('reports the migrations as applied, and the lost lock, when the lock connection drops while they run', async () => {
    const db = await emptyDatabase();
    const ds = await dataSource(db, [...BASELINE, SlowTable9999999999998]);
    let run: Promise<string[]> = Promise.resolve([]);
    const warnings = await lockWarnings(async () => {
      run = runMigrations(ds);
      await sql(db, async (c) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const { rows } = await c.query<{ pid: number }>(
            `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND database =
             (SELECT oid FROM pg_database WHERE datname = current_database())`,
          );
          if (rows.length) {
            await c.query('SELECT pg_terminate_backend($1)', [rows[0].pid]);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error('the migration lock was never taken');
      });
      await run;
    });

    await expect(run).resolves.toEqual([INITIAL, 'SlowTable9999999999998']);
    expect(warnings).toEqual([expect.stringContaining('The migration lock was lost during the run')]);
  });

  describe('later migrations', () => {
    const ALL = MIGRATIONS.map((m) => m.name);

    it('apply in order on an empty database and leave nothing pending', async () => {
      const db = await emptyDatabase();
      const ds = await dataSource(db, MIGRATIONS);
      expect(await runMigrations(ds)).toEqual(ALL);
      expect(await pendingMigrations(ds)).toEqual([]);
      expect(await snapshot(db)).toEqual(
        expect.arrayContaining([
          'constraint clients clients_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id)',
          'index CREATE INDEX mutation_results_created_idx ON public.mutation_results USING btree (created_at)',
          "index CREATE INDEX entities_part_ticket_idx ON public.entities USING btree (((data ->> 'ticketId'::text))) WHERE ((entity = 'part'::text) AND (NOT deleted))",
        ]),
      );
    });

    it('apply on top of a database the original server created, keeping its data', async () => {
      const db = await starterDatabase();
      await sql(db, (c) =>
        c.query(`
          INSERT INTO users VALUES ('00000000-0000-4000-8000-000000000002', 'Tom', 'technician', 'tech-a-token');
          INSERT INTO clients VALUES ('0b7f3c1e-2a4d-4e5f-8a6b-7c8d9e0f1a2b', '00000000-0000-4000-8000-000000000002', 7);
        `),
      );
      const ds = await dataSource(db, MIGRATIONS);
      expect(await runMigrations(ds)).toEqual(ALL);
      const clients = await sql(
        db,
        async (c) =>
          (
            await c.query<{ client_id: string; last_mutation_id: string }>(
              'SELECT client_id, last_mutation_id FROM clients',
            )
          ).rows,
      );
      expect(clients).toEqual([{ client_id: '0b7f3c1e-2a4d-4e5f-8a6b-7c8d9e0f1a2b', last_mutation_id: '7' }]);
    });

    it('start the log head after the last version the original sequence handed out', async () => {
      const db = await starterDatabase();
      await sql(db, (c) =>
        c.query(`
          INSERT INTO change_log (site_id, entity, entity_id, op) VALUES
            ('00000000-0000-4000-8000-0000000000a1', 'ticket', '11111111-1111-4111-8111-111111111111', 'put'),
            ('00000000-0000-4000-8000-0000000000a1', 'ticket', '11111111-1111-4111-8111-111111111111', 'put'),
            ('00000000-0000-4000-8000-0000000000a1', 'ticket', '11111111-1111-4111-8111-111111111111', 'del');
          -- The newest row is gone (a GC run, or a rolled-back insert), but a client may hold it as its cursor.
          DELETE FROM change_log WHERE version = 3;
        `),
      );
      const ds = await dataSource(db, MIGRATIONS);
      await runMigrations(ds);
      const head = await ds.query<Array<{ version: string }>>('SELECT version FROM log_head');
      // A version must now be given: nothing in the log hands one out by itself any more.
      const withoutVersion = await ds
        .query(`INSERT INTO change_log (site_id, entity, entity_id, op) VALUES ($1, 'ticket', $2, 'put')`, [
          '00000000-0000-4000-8000-0000000000a1',
          '11111111-1111-4111-8111-111111111111',
        ])
        .then(
          () => 'inserted',
          (e: { driverError?: { code?: string } }) => e.driverError?.code,
        );
      expect({ head, withoutVersion }).toEqual({ head: [{ version: '3' }], withoutVersion: '23502' });
    });

    it('start the log head at 0 on an empty log', async () => {
      const db = await emptyDatabase();
      const ds = await dataSource(db, MIGRATIONS);
      await runMigrations(ds);
      expect(await ds.query('SELECT id, version FROM log_head')).toEqual([{ id: 1, version: '0' }]);
    });

    it('delete the parts the original server left behind and publish their deletion', async () => {
      const db = await starterDatabase();
      const site = '00000000-0000-4000-8000-0000000000a1';
      const [kept, orphan, alive] = [
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333',
      ];
      await sql(db, (c) =>
        c.query(`
          INSERT INTO entities VALUES
            ('ticket', '${kept}', '${site}', '{"title":"kept"}', false, 1),
            ('ticket', '44444444-4444-4444-8444-444444444444', '${site}', NULL, true, 2),
            ('part', '${orphan}', '${site}', '{"ticketId":"44444444-4444-4444-8444-444444444444"}', false, 3),
            ('part', '${alive}', '${site}', '{"ticketId":"${kept}"}', false, 4);
          SELECT setval('change_log_version_seq', 4);
        `),
      );
      const ds = await dataSource(db, MIGRATIONS);
      await runMigrations(ds);
      const parts = await ds.query<Array<{ id: string; deleted: boolean; version: string }>>(
        `SELECT id, deleted, version FROM entities WHERE entity = 'part' ORDER BY id`,
      );
      const log = await ds.query<Array<{ version: string; entity_id: string; op: string }>>(
        `SELECT version, entity_id, op FROM change_log ORDER BY version`,
      );
      const head = await ds.query<Array<{ version: string }>>('SELECT version FROM log_head');
      expect({ parts, log, head }).toEqual({
        parts: [
          { id: orphan, deleted: true, version: '5' },
          { id: alive, deleted: false, version: '4' },
        ],
        log: [{ version: '5', entity_id: orphan, op: 'del' }],
        head: [{ version: '5' }],
      });
    });

    it('store client ids as uuid and drop clients whose id is not one', async () => {
      const db = await starterDatabase();
      await sql(db, (c) =>
        c.query(`
          INSERT INTO users VALUES ('00000000-0000-4000-8000-000000000002', 'Tom', 'technician', 'tech-a-token');
          INSERT INTO clients VALUES
            ('0b7f3c1e-2a4d-4e5f-8a6b-7c8d9e0f1a2b', '00000000-0000-4000-8000-000000000002', 7),
            ('client-1', '00000000-0000-4000-8000-000000000002', 3);
        `),
      );
      const ds = await dataSource(db, MIGRATIONS);
      await runMigrations(ds);
      const rows = await ds.query<Array<{ client_id: string; type: string }>>(
        `SELECT client_id, pg_typeof(client_id)::text AS type FROM clients`,
      );
      expect(rows).toEqual([{ client_id: '0b7f3c1e-2a4d-4e5f-8a6b-7c8d9e0f1a2b', type: 'uuid' }]);
    });

    it('revert to the first schema', async () => {
      const db = await emptyDatabase();
      const ds = await dataSource(db, MIGRATIONS);
      await runMigrations(ds);
      // TypeORM 0.3 reverts with the transaction mode it is given and ignores a migration's own
      // `transaction = false`, which DROP INDEX CONCURRENTLY needs: revert without transactions.
      for (let i = 1; i < MIGRATIONS.length; i += 1) await ds.undoLastMigration({ transaction: 'none' });
      const reference = await starterDatabase();
      expect(await snapshot(db)).toEqual(await snapshot(reference));
    });
  });
});
