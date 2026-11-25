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
