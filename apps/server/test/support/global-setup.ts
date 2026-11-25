import {
  dropDatabase,
  hasDatabase,
  newDatabaseName,
  quoteIdent,
  runStartedAt,
  setTemplateDatabase,
  startRun,
  withMaintenanceClient,
} from './database';

/** Databases left behind by runs that crashed more than this long ago are removed. */
const STALE_AFTER_SECONDS = 6 * 3600;

export default async function globalSetup(): Promise<void> {
  if (!hasDatabase) {
    if (process.env.REQUIRE_DB === '1') {
      throw new Error('REQUIRE_DB=1 but DATABASE_URL is not set: refusing to skip the integration tests');
    }
    process.stderr.write('\nDATABASE_URL is not set: integration tests are skipped.\n');
    return;
  }
  startRun();
  await withMaintenanceClient(async (client) => {
    const { rows } = await client.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE 'fs\\_test\\_%'`,
    );
    const now = Math.floor(Date.now() / 1000);
    for (const { datname } of rows) {
      const started = runStartedAt(datname);
      if (started !== undefined && now - started > STALE_AFTER_SECONDS) await dropDatabase(client, datname);
    }
    const template = newDatabaseName('template');
    await client.query(`CREATE DATABASE ${quoteIdent(template)}`);
    setTemplateDatabase(template);
  });
}
