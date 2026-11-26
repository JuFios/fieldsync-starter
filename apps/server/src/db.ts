import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, type QueryRunner } from 'typeorm';
import type { EnvironmentVariables } from './config';
import { pendingMigrations } from './database/migrator';
import { seedDemo } from './seed';

export interface SqlResult<T> {
  rows: T[];
  /** Rows returned, or rows changed by INSERT/UPDATE/DELETE. */
  rowCount: number;
}

/**
 * Runs one SQL statement with positional parameters. Implemented by {@link Db} (a pooled
 * connection per statement) and by the transaction handle {@link Db.tx} passes to its callback.
 * The result has the same shape for every statement type.
 */
export interface Sql {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<SqlResult<T>>;
}

/** How {@link Db.tx} starts its transaction; the default is READ COMMITTED, read-write. */
export interface TxOptions {
  /** REPEATABLE READ: every statement sees the snapshot of the first one (PostgreSQL 13.2.2). */
  isolation?: 'REPEATABLE READ';
  /** The transaction may not write (SET TRANSACTION READ ONLY). */
  readOnly?: boolean;
}

/** The handle {@link Db.tx} passes to its callback: statements in the transaction, and savepoints. */
export interface TxSql extends Sql {
  /**
   * Runs `fn` inside a savepoint of the transaction: releases it when `fn` resolves; when `fn` throws,
   * rolls back to it (undoing `fn`'s statements and releasing the locks they took, PostgreSQL
   * 13.3.2) and rethrows, leaving the transaction usable. If rolling back to the savepoint fails
   * (the connection is gone), a {@link SavepointRollbackError} is thrown instead.
   */
  savepoint<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Rolling back to a savepoint failed. Its `cause` is that failure (typically a lost connection, so
 * the transient-error check sees it); `original` is the error that made the rollback necessary.
 */
export class SavepointRollbackError extends Error {
  constructor(
    readonly original: unknown,
    rollbackError: unknown,
  ) {
    super(`Rollback to savepoint failed after "${messageOf(original)}": ${messageOf(rollbackError)}`, {
      cause: rollbackError,
    });
    this.name = 'SavepointRollbackError';
  }
}

async function run<T>(runner: QueryRunner, sql: string, params?: unknown[]): Promise<SqlResult<T>> {
  // The structured result avoids TypeORM's raw shape, which is [rows, count] for UPDATE/DELETE.
  const result = await runner.query(sql, params, true);
  const rows = (result.records ?? []) as T[];
  return { rows, rowCount: result.affected ?? rows.length };
}

/**
 * A nested transaction of TypeORM's QueryRunner is a savepoint: inside a transaction,
 * `startTransaction` issues `SAVEPOINT typeorm_<depth>`, `commitTransaction` releases it and
 * `rollbackTransaction` rolls back to it (TypeORM 0.3, PostgresQueryRunner).
 */
async function savepoint<T>(runner: QueryRunner, fn: () => Promise<T>): Promise<T> {
  await runner.startTransaction();
  let result: T;
  try {
    result = await fn();
  } catch (err) {
    try {
      await runner.rollbackTransaction();
    } catch (rollbackErr) {
      throw new SavepointRollbackError(err, rollbackErr);
    }
    throw err;
  }
  await runner.commitTransaction();
  return result;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The server's SQL access over the DataSource that `TypeOrmModule` creates, initializes and closes
 * on shutdown. On startup it refuses an out-of-date schema and seeds the demo data if configured.
 */
@Injectable()
export class Db implements Sql, OnModuleInit {
  private readonly logger = new Logger(Db.name);

  constructor(
    readonly dataSource: DataSource,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  async onModuleInit(): Promise<void> {
    const pending = await pendingMigrations(this.dataSource);
    if (pending.length > 0) {
      throw new Error(
        `The database schema is not up to date (pending migrations: ${pending.join(', ')}). ` +
          `Run "npm run migrate" before starting the server.`,
      );
    }
    if (this.config.get('SEED_DEMO', { infer: true })) await seedDemo(this);
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<SqlResult<T>> {
    const runner = this.dataSource.createQueryRunner();
    try {
      return await run<T>(runner, sql, params);
    } finally {
      await runner.release();
    }
  }

  /**
   * Runs `fn` in a transaction on one connection: commits when it resolves, rolls back when it
   * throws and rethrows its error. If the rollback itself fails (typically because the connection
   * is gone), that failure is logged and the original error still reaches the caller. Connections
   * that broke are not returned to the pool (TypeORM and pg-pool discard them).
   */
  async tx<T>(fn: (sql: TxSql) => Promise<T>, options: TxOptions = {}): Promise<T> {
    const runner = this.dataSource.createQueryRunner();
    try {
      await runner.connect();
      await runner.startTransaction(options.isolation);
      if (options.readOnly) await runner.query('SET TRANSACTION READ ONLY');
      try {
        const result = await fn({
          query: (sql, params) => run(runner, sql, params),
          savepoint: (inner) => savepoint(runner, inner),
        });
        await runner.commitTransaction();
        return result;
      } catch (err) {
        await this.rollbackAfter(runner, err);
        throw err;
      }
    } finally {
      await runner.release();
    }
  }

  private async rollbackAfter(runner: QueryRunner, cause: unknown): Promise<void> {
    if (runner.isReleased || !runner.isTransactionActive) return;
    try {
      await runner.rollbackTransaction();
    } catch (err) {
      this.logger.warn(`Rollback failed after "${messageOf(cause)}": ${messageOf(err)}`);
    }
  }
}
