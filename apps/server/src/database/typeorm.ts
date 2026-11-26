import type { TypeOrmModuleAsyncOptions } from '@nestjs/typeorm';
import type { ServerConfig } from '../config';
import { ConfigService } from '@nestjs/config';
import { dataSourceOptions } from './data-source';

/**
 * `TypeOrmModule.forRootAsync` options from the validated configuration. The module's own
 * connection retries are switched off: by default it retries any error, a wrong password
 * included, 9 times 3 s apart. A process that cannot reach its database fails at once with the
 * driver's error, and the process manager (compose `restart`, an orchestrator) restarts it.
 */
export function typeOrmOptions(applicationName: string, poolSize?: number): TypeOrmModuleAsyncOptions {
  return {
    inject: [ConfigService],
    useFactory: (config: ServerConfig) => ({
      ...dataSourceOptions({
        url: config.get('DATABASE_URL', { infer: true }),
        poolSize: poolSize ?? config.get('DB_POOL_MAX', { infer: true }),
        applicationName,
        // Session settings of every server connection, sent when it connects (node-postgres
        // connection parameters). PostgreSQL advises against setting them in postgresql.conf for
        // all sessions; the migration command uses its own connections without them.
        sessionSettings: {
          lock_timeout: config.get('DB_LOCK_TIMEOUT_MS', { infer: true }),
          statement_timeout: config.get('DB_STATEMENT_TIMEOUT_MS', { infer: true }),
          idle_in_transaction_session_timeout: config.get('DB_IDLE_IN_TRANSACTION_TIMEOUT_MS', { infer: true }),
        },
      }),
      toRetry: () => false,
    }),
  };
}
