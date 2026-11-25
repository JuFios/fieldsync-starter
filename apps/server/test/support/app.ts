import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.factory';

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
 * Boots the real application against `databaseUrl` on an ephemeral port. The server reads its
 * settings from the environment, so they are applied for the lifetime of the app and restored
 * on close (test files in one Jest worker run one after another).
 */
export async function startApp(databaseUrl: string, env: Record<string, string> = {}): Promise<RunningApp> {
  const applied = { ...TEST_ENV, ...env, DATABASE_URL: databaseUrl };
  const previous = new Map(Object.keys(applied).map((key) => [key, process.env[key]]));
  Object.assign(process.env, applied);
  const restoreEnv = () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  let app: INestApplication | undefined;
  try {
    app = await createApp({ logger: false });
    await app.listen(0, '127.0.0.1');
  } catch (err) {
    await app?.close();
    restoreEnv();
    throw err;
  }
  const { port } = app.getHttpServer().address() as AddressInfo;
  const running = app;
  return {
    app: running,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      try {
        await running.close();
      } finally {
        restoreEnv();
      }
    },
  };
}
