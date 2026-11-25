import { Pool } from 'pg';
import { startApp, type RunningApp } from './app';
import { createTestDatabase, hasDatabase, type TestDatabase } from './database';
import { Fixtures } from './fixtures';
import { Api } from './http';

/** Application name of the tests' own connections, so tests can tell them apart from the server's. */
export const TEST_APPLICATION_NAME = 'fieldsync-test';

/** `describe` that skips the suite when no database is configured (see global-setup.ts). */
export const describeWithDb: jest.Describe = hasDatabase ? describe : describe.skip;

export interface IntegrationContext {
  database: TestDatabase;
  server: RunningApp;
  /** Direct connection for fixtures and assertions; independent of the server's data layer. */
  db: Pool;
  fixtures: Fixtures;
  api: Api;
}

/**
 * Registers beforeAll/afterAll hooks that give the calling test file its own database and a
 * running server. Use inside a `describeWithDb` block.
 */
export function useIntegration(env: Record<string, string> = {}): IntegrationContext {
  const ctx = {} as IntegrationContext;
  beforeAll(async () => {
    ctx.database = await createTestDatabase();
    ctx.server = await startApp(ctx.database.url, env);
    ctx.db = new Pool({ connectionString: ctx.database.url, max: 4, application_name: TEST_APPLICATION_NAME });
    ctx.db.on('error', () => undefined);
    ctx.fixtures = new Fixtures(ctx.db);
    ctx.api = new Api(ctx.server.url);
  });
  afterAll(async () => {
    await ctx.db?.end();
    await ctx.server?.close();
    await ctx.database?.drop();
  });
  return ctx;
}

/**
 * Terminates the server's connections to the test database (never the tests' own), optionally only
 * those in a given pg_stat_activity state, and waits until they are gone. Returns how many there were.
 */
export async function terminateServerConnections(ctx: IntegrationContext, state?: string): Promise<number> {
  const { rows } = await ctx.db.query<{ pid: number }>(
    `SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND application_name <> $1 AND ($2::text IS NULL OR state = $2)`,
    [TEST_APPLICATION_NAME, state ?? null],
  );
  const pids = rows.map((r) => r.pid);
  if (pids.length === 0) return 0;
  await ctx.db.query('SELECT pg_terminate_backend(pid) FROM unnest($1::int[]) AS pid', [pids]);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const left = await ctx.db.query('SELECT 1 FROM pg_stat_activity WHERE pid = ANY($1::int[])', [pids]);
    if (left.rowCount === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // Give the server's sockets a moment to observe the closed connections.
  await new Promise((resolve) => setTimeout(resolve, 100));
  return pids.length;
}
