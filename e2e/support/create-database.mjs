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
if (!/^[a-z0-9_]+$/.test(name)) {
  console.error(`create-database: unexpected database name "${name}"`);
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
