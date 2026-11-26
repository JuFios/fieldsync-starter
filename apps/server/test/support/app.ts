import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { configureApp } from '../../src/app.factory';
import { AppModule } from '../../src/app.module';

export interface RunningApp {
  app: INestApplication;
  close(): Promise<void>;
}

/** Settings every test app gets unless a test overrides them. */
const TEST_ENV: Record<string, string> = {
  SEED_DEMO: 'false',
  GC_INTERVAL_MS: '3600000',
  CHANGELOG_RETENTION_SECONDS: '604800',
};

/**
 * Builds the real application against `databaseUrl` in-process, as the NestJS testing docs
 * describe (`Test.createTestingModule` + `app.init()`); requests go through supertest (see Api).
 * Settings go through the production validation, built from TEST_ENV plus the test's overrides
 * instead of the process environment.
 */
export async function startApp(databaseUrl: string, env: Record<string, string> = {}): Promise<RunningApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [await AppModule.forRoot({ ...TEST_ENV, ...env, DATABASE_URL: databaseUrl })],
  }).compile();
  // abortOnError: false makes Nest reject instead of aborting the Jest worker on a bootstrap error.
  const app = configureApp(moduleRef.createNestApplication({ logger: false, abortOnError: false }));
  try {
    await app.init();
  } catch (err) {
    await app.close();
    throw err;
  }
  return { app, close: () => app.close() };
}
