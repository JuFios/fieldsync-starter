import { Logger } from '@nestjs/common';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { SafeTypeOrmLogger } from './logger';
import { MIGRATIONS } from './migrations';

export const MIGRATIONS_TABLE = 'schema_migrations';

export interface DataSourceSettings {
  url: string;
  poolSize: number;
  /** Shown in pg_stat_activity, e.g. "fieldsync-server". */
  applicationName: string;
  /** Overrides the migration list (tests). */
  migrations?: Array<new () => unknown>;
  /** Timeouts of every connection of the pool, in ms (node-postgres connection parameters). */
  sessionSettings?: {
    lock_timeout: number;
    statement_timeout: number;
    idle_in_transaction_session_timeout: number;
  };
}

/**
 * The one place that configures TypeORM, for the server's `TypeOrmModule`, the migration command
 * and the tests. No entities: queries are SQL (see the README decision record); TypeORM provides
 * the pool, transactions and migrations.
 */
export function dataSourceOptions(settings: DataSourceSettings): DataSourceOptions {
  const logger = new Logger('Database');
  return {
    type: 'postgres',
    url: settings.url,
    applicationName: settings.applicationName,
    poolSize: settings.poolSize,
    // Idle pooled connections can be closed by Postgres at any time; log it instead of crashing.
    poolErrorHandler: (err: Error) => logger.warn(`Idle database connection failed: ${err.message}`),
    entities: [],
    synchronize: false,
    migrationsRun: false,
    migrations: settings.migrations ?? MIGRATIONS,
    migrationsTableName: MIGRATIONS_TABLE,
    // Each migration in its own transaction, so a migration can opt out (`transaction = false`),
    // which CREATE INDEX CONCURRENTLY requires.
    migrationsTransactionMode: 'each',
    logger: new SafeTypeOrmLogger(logger),
    ...(settings.sessionSettings ? { extra: { ...settings.sessionSettings } } : {}),
    logging: ['error', 'warn', 'migration'],
  };
}

/** A DataSource outside Nest (test setup, tests of the data layer itself). */
export function createDataSource(settings: DataSourceSettings): DataSource {
  return new DataSource(dataSourceOptions(settings));
}
