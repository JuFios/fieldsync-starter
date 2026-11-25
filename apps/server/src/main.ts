import 'reflect-metadata';
import { createApp } from './app.factory';
import { ConfigError, loadConfig, loadDotEnv } from './config';

async function bootstrap() {
  loadDotEnv();
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.port);
  // eslint-disable-next-line no-console
  console.log(`fieldsync server listening on ${config.port}`);
}

bootstrap().catch((err: unknown) => {
  // A configuration problem is the operator's to fix: print the report, not a stack trace.
  // eslint-disable-next-line no-console
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
});
