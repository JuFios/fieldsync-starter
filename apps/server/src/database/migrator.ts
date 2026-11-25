import type { DataSource } from 'typeorm';

/**
 * Session-level advisory lock that serialises migration runs across processes (TypeORM takes no
 * lock of its own). Arbitrary constant, unique to this application.
 */
export const MIGRATION_LOCK_KEY = 7_302_118_440;

/** Names of the migrations not yet applied to the database, oldest first. */
export async function pendingMigrations(ds: DataSource): Promise<string[]> {
  const table = ds.options.migrationsTableName ?? 'migrations';
  const [{ present }] = await ds.query<Array<{ present: boolean }>>(`SELECT to_regclass($1) IS NOT NULL AS present`, [
    table,
  ]);
  const applied = present
    ? new Set((await ds.query<Array<{ name: string }>>(`SELECT name FROM "${table}"`)).map((r) => r.name))
    : new Set<string>();
  return ds.migrations.map((m) => m.name ?? m.constructor.name).filter((name) => !applied.has(name));
}

/**
 * Applies pending migrations while holding {@link MIGRATION_LOCK_KEY}, so concurrent runs (several
 * replicas starting, a deploy racing a manual run) apply each migration exactly once. The lock is
 * held on its own connection and is released when that connection closes, even on a crash.
 * Returns the names of the migrations this run applied.
 */
export async function runMigrations(ds: DataSource): Promise<string[]> {
  const lock = ds.createQueryRunner();
  await lock.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      const applied = await ds.runMigrations({ transaction: 'each' });
      return applied.map((m) => m.name);
    } finally {
      await lock.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    await lock.release();
  }
}
