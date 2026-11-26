import 'reflect-metadata';
import { Logger, Module, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConfigError } from '../config';
import { configModule } from '../config.module';
import { runMigrations } from './migrator';
import { typeOrmOptions } from './typeorm';

/**
 * The migration command's own module: the server's configuration (same variables, same validation)
 * and a DataSource of one connection. Migrations run one after another on it; the lock has a
 * connection of its own (see runMigrations).
 */
@Module({})
class MigrationModule {
  static async forRoot(): Promise<DynamicModule> {
    return {
      module: MigrationModule,
      imports: [await configModule(), TypeOrmModule.forRootAsync(typeOrmOptions('fieldsync-migrate', 1))],
    };
  }
}

/**
 * `npm run migrate`: applies pending migrations and exits. Run before starting the server. A Nest
 * standalone application, so configuration and the DataSource come from the same modules as in the
 * server.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(await MigrationModule.forRoot(), {
    logger: ['error', 'warn', 'log'],
    abortOnError: false,
  });
  try {
    const applied = await runMigrations(app.get(DataSource));
    new Logger('Migrations').log(
      applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database schema is up to date',
    );
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  // Print the message only: errors from the driver can carry query parameters.
  // eslint-disable-next-line no-console
  console.error(
    err instanceof ConfigError ? err.message : `Migration failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
