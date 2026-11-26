import { createDataSource } from '../../src/database/data-source';
import { runMigrations } from '../../src/database/migrator';
import {
  dropDatabase,
  newDatabaseName,
  quoteIdent,
  startRun,
  urlFor,
  withMaintenanceClient,
} from '../support/database';

/** A migrated throw-away database next to DATABASE_URL, named so the test suites' cleanup removes leftovers. */
export async function createSimulationDatabase(): Promise<{ url: string; drop(): Promise<void> }> {
  startRun();
  const name = newDatabaseName('sim');
  await withMaintenanceClient((c) => c.query(`CREATE DATABASE ${quoteIdent(name)}`));
  const url = urlFor(name);
  const drop = () => withMaintenanceClient((c) => dropDatabase(c, name));
  const ds = createDataSource({ url, poolSize: 1, applicationName: 'fieldsync-sim-setup' });
  try {
    await ds.initialize();
    try {
      await runMigrations(ds);
    } finally {
      await ds.destroy();
    }
  } catch (err) {
    await drop();
    throw err;
  }
  return { url, drop };
}
