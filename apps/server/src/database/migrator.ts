import { Logger } from '@nestjs/common';
import type { DataSource, QueryRunner } from 'typeorm';

/**
 * Session-level advisory lock that serialises migration runs across processes (TypeORM takes no
 * lock of its own). Arbitrary constant, unique to this application.
 */
export const MIGRATION_LOCK_KEY = 7_302_118_440;

/**
 * How long a run waits for another run to finish before giving up. Generous, because a migration
 * may build an index concurrently; finite, so a stuck run cannot hang every later deploy silently.
 */
export const MIGRATION_LOCK_TIMEOUT_MS = 10 * 60_000;

/** SQLSTATE lock_not_available: lock_timeout expired. */
const LOCK_NOT_AVAILABLE = '55P03';

const logger = new Logger('Migrations');

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
export async function runMigrations(ds: DataSource, opts: { lockTimeoutMs?: number } = {}): Promise<string[]> {
  const lock = ds.createQueryRunner();
  try {
    await lock.connect();
    await acquireLock(lock, opts.lockTimeoutMs ?? MIGRATION_LOCK_TIMEOUT_MS);
    try {
      const applied = await ds.runMigrations({ transaction: 'each' });
      return applied.map((m) => m.name);
    } finally {
      await releaseLock(lock);
    }
  } finally {
    await lock.release();
  }
}

async function acquireLock(lock: QueryRunner, timeoutMs: number): Promise<void> {
  await lock.query(`SELECT set_config('lock_timeout', $1, false)`, [`${timeoutMs}ms`]);
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
  } catch (err) {
    if (sqlState(err) === LOCK_NOT_AVAILABLE) {
      throw new Error(
        `Another migration run has held the migration lock for more than ${timeoutMs} ms; ` +
          `check for a stuck "migrate" process (pg_locks, advisory lock ${MIGRATION_LOCK_KEY}).`,
      );
    }
    throw err;
  } finally {
    // The connection goes back to the pool: do not leave the timeout on it.
    await lock.query(`SELECT set_config('lock_timeout', '0', false)`).catch(() => undefined);
  }
}

/**
 * Releases the lock without letting a failure replace the outcome of the migrations: if the
 * connection is gone, Postgres has already released the lock with it.
 */
async function releaseLock(lock: QueryRunner): Promise<void> {
  try {
    await lock.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
  } catch (err) {
    logger.warn(
      `Could not release the migration lock (${err instanceof Error ? err.message : String(err)}); ` +
        `Postgres releases it when the connection closes.`,
    );
  }
}

function sqlState(err: unknown): string | undefined {
  const driverError = (err as { driverError?: { code?: unknown } } | null)?.driverError;
  return typeof driverError?.code === 'string' ? driverError.code : undefined;
}
