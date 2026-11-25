import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.factory';
import { loadConfig } from '../../src/config';

export interface RunningApp {
  app: INestApplication;
  /** Base URL, e.g. http://127.0.0.1:54321 */
  url: string;
  close(): Promise<void>;
}

/** Settings every test app gets unless a test overrides them. */
const TEST_ENV: Record<string, string> = {
  SEED_DEMO: 'false',
  GC_INTERVAL_MS: '3600000',
  CHANGELOG_RETENTION_SECONDS: '604800',
};

/**
 * Boots the real application against `databaseUrl` on an ephemeral port. Settings go through the
 * same validated loader as in production, built from TEST_ENV plus the test's overrides.
 */
export async function startApp(databaseUrl: string, env: Record<string, string> = {}): Promise<RunningApp> {
  const config = loadConfig({ ...TEST_ENV, ...env, DATABASE_URL: databaseUrl });
  let app: INestApplication | undefined;
  try {
    // abortOnError: false makes Nest reject instead of aborting the Jest worker on a bootstrap error.
    app = await createApp(config, { logger: false, abortOnError: false });
    await app.listen(0, '127.0.0.1');
  } catch (err) {
    await app?.close();
    throw err;
  }
  const { port } = app.getHttpServer().address() as AddressInfo;
  const running = app;
  return { app: running, url: `http://127.0.0.1:${port}`, close: () => running.close() };
}
