import 'reflect-metadata';
import { ConfigError, loadConfig, loadDotEnv } from '../config';
import { createDataSource } from './data-source';
import { runMigrations } from './migrator';

/** `npm run migrate`: applies pending migrations and exits. Run before starting the server. */
async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  // One connection holds the migration lock, another runs the migrations.
  const ds = createDataSource({ url: config.databaseUrl, poolSize: 2, applicationName: 'fieldsync-migrate' });
  await ds.initialize();
  try {
    const applied = await runMigrations(ds);
    // eslint-disable-next-line no-console
    console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database schema is up to date');
  } finally {
    await ds.destroy();
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
