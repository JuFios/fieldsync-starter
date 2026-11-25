import { randomBytes } from 'node:crypto';
import { Client } from 'pg';

/**
 * Integration tests run against a real Postgres given by DATABASE_URL. The URL names a maintenance
 * database; each test file gets its own throw-away database cloned from a template that global
 * setup prepares once per run. Without DATABASE_URL the integration suites are skipped, unless
 * REQUIRE_DB=1 (set in CI), in which case global setup fails instead of skipping silently.
 */

/** Every database created by the tests is named `fs_test_<run started, unix seconds>_<run id>_<kind>_<random>`. */
export const TEST_DB_PREFIX = 'fs_test_';
const TEMPLATE_ENV = 'FIELDSYNC_TEST_TEMPLATE_DB';
const RUN_ENV = 'FIELDSYNC_TEST_RUN';

export const hasDatabase = Boolean(process.env.DATABASE_URL);

export function maintenanceUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return url;
}

/** The same server and credentials as DATABASE_URL, pointed at another database. */
export function urlFor(database: string): string {
  const url = new URL(maintenanceUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

export function quoteIdent(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Unexpected database name "${name}"`);
  return `"${name}"`;
}

/** Starts a test run; databases of the run share its id so global teardown can find leftovers. */
export function startRun(): string {
  const run = `${Math.floor(Date.now() / 1000)}_${randomBytes(3).toString('hex')}`;
  process.env[RUN_ENV] = run;
  return run;
}

export function runPrefix(): string {
  const run = process.env[RUN_ENV];
  if (!run) throw new Error(`${RUN_ENV} is not set: the integration global setup did not run`);
  return `${TEST_DB_PREFIX}${run}_`;
}

export function newDatabaseName(kind: string): string {
  return `${runPrefix()}${kind}_${randomBytes(4).toString('hex')}`;
}

/** Unix seconds at which the run that created `name` started, or undefined for foreign names. */
export function runStartedAt(name: string): number | undefined {
  const match = /^fs_test_(\d+)_/.exec(name);
  return match ? Number(match[1]) : undefined;
}

export function templateDatabase(): string {
  const name = process.env[TEMPLATE_ENV];
  if (!name) throw new Error(`${TEMPLATE_ENV} is not set: the integration global setup did not run`);
  return name;
}

export function setTemplateDatabase(name: string): void {
  process.env[TEMPLATE_ENV] = name;
}

export async function withMaintenanceClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: maintenanceUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function dropDatabase(client: Client, name: string): Promise<void> {
  await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
}

export interface TestDatabase {
  name: string;
  url: string;
  drop(): Promise<void>;
}

/**
 * Creates a database for one test file, cloned from the run's migrated template, or an empty one
 * (`{ empty: true }`) for tests of the migrations themselves.
 */
export async function createTestDatabase(opts: { empty?: boolean } = {}): Promise<TestDatabase> {
  const name = newDatabaseName(opts.empty ? 'empty' : 'file');
  const template = opts.empty ? '' : ` TEMPLATE ${quoteIdent(templateDatabase())}`;
  await withMaintenanceClient((c) => c.query(`CREATE DATABASE ${quoteIdent(name)}${template}`));
  return {
    name,
    url: urlFor(name),
    drop: () => withMaintenanceClient((c) => dropDatabase(c, name)),
  };
}
