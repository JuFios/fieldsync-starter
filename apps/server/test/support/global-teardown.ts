import { dropDatabase, hasDatabase, runPrefix, withMaintenanceClient } from './database';

/** Drops the template and any database of this run that a crashed test file left behind. */
export default async function globalTeardown(): Promise<void> {
  if (!hasDatabase) return;
  const prefix = runPrefix();
  await withMaintenanceClient(async (client) => {
    const { rows } = await client.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE starts_with(datname, $1)`,
      [prefix],
    );
    for (const { datname } of rows) await dropDatabase(client, datname);
  });
}
