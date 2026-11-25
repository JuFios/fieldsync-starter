import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import type { DataSource } from 'typeorm';

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

const MIGRATIONS_HINT = 'the migrations table for duplicate entries and the schema for partial changes';

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
 * replicas starting, a deploy racing a manual run) apply each migration exactly once. Returns the
 * names of the migrations this run applied.
 *
 * The lock lives on a dedicated connection outside the pool: its session settings never reach the
 * application's connections, idle-session timeouts are switched off for it (it sits idle while the
 * migrations run on other connections), and closing it at the end always releases the lock, even
 * if unlocking failed.
 */
export async function runMigrations(ds: DataSource, opts: { lockTimeoutMs?: number } = {}): Promise<string[]> {
  const url = (ds.options as { url?: string }).url;
  if (!url) throw new Error('runMigrations needs a DataSource configured with a url');
  const lock = new Client({ connectionString: url, application_name: 'fieldsync-migration-lock' });
  let lost: Error | undefined;
  // Without a listener, a dropped connection would crash the process.
  lock.on('error', (err) => {
    lost = err;
  });
  await lock.connect();
  try {
    await acquireLock(lock, opts.lockTimeoutMs ?? MIGRATION_LOCK_TIMEOUT_MS);
    try {
      const applied = await ds.runMigrations({ transaction: 'each' });
      return applied.map((m) => m.name);
    } finally {
      await releaseLock(lock, () => lost);
    }
  } finally {
    await lock.end().catch(() => undefined);
  }
}

async function acquireLock(lock: Client, timeoutMs: number): Promise<void> {
  await lock.query(`SELECT set_config('lock_timeout', $1, false)`, [`${timeoutMs}ms`]);
  // Postgres 14+ ends idle sessions after idle_session_timeout; this one is idle by design.
  await lock.query(
    `SELECT set_config('idle_session_timeout', '0', false) WHERE current_setting('server_version_num')::int >= 140000`,
  );
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
  } catch (err) {
    if ((err as { code?: unknown }).code === LOCK_NOT_AVAILABLE) {
      throw new Error(
        `Another migration run has held the migration lock for more than ${timeoutMs} ms; ` +
          `check for a stuck "migrate" process (pg_locks, advisory lock ${MIGRATION_LOCK_KEY}).`,
      );
    }
    throw err;
  }
}

/**
 * Releases the lock without letting a failure replace the outcome of the migrations. A failure
 * here means the lock connection was lost while the migrations ran, so another run may have taken
 * the lock and run at the same time: that is reported loudly. Closing the connection afterwards
 * releases the lock in any case.
 */
async function releaseLock(lock: Client, lostError: () => Error | undefined): Promise<void> {
  try {
    const { rows } = await lock.query<{ released: boolean }>('SELECT pg_advisory_unlock($1) AS released', [
      MIGRATION_LOCK_KEY,
    ]);
    if (rows[0]?.released) return;
    logger.warn(
      'The migration lock was lost during the run (it was no longer held at the end); another migrate ' +
        `run may have applied migrations at the same time. Check ${MIGRATIONS_HINT}.`,
    );
  } catch (err) {
    const cause = lostError() ?? err;
    logger.warn(
      `The migration lock was lost during the run (${cause instanceof Error ? cause.message : String(cause)}); ` +
        `another migrate run may have applied migrations at the same time. Check ${MIGRATIONS_HINT}.`,
    );
  }
}
