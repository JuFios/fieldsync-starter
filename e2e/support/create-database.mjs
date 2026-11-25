// @ts-check
/**
 * Recreates the e2e database named by DATABASE_URL, connecting through E2E_MAINTENANCE_URL.
 * Runs as the first step of the e2e server command, before migrations and the server start.
 */
import pg from 'pg';

const maintenanceUrl = process.env.E2E_MAINTENANCE_URL;
const targetUrl = process.env.DATABASE_URL;
if (!maintenanceUrl || !targetUrl) {
  console.error('create-database: E2E_MAINTENANCE_URL and DATABASE_URL must be set');
  process.exit(1);
}
const name = decodeURIComponent(new URL(targetUrl).pathname.slice(1));
if (!/^[a-z0-9_]+_e2e$/.test(name)) {
  // The database is dropped and recreated: never do that to one that is not meant for e2e.
  console.error(`create-database: refusing to recreate "${name}"; the e2e database name must end with _e2e`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: maintenanceUrl });
try {
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await client.query(`CREATE DATABASE "${name}"`);
  console.log(`create-database: created ${name}`);
} catch (err) {
  console.error(`create-database: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
