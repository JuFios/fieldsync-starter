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
      }),
      toRetry: () => false,
    }),
  };
}
