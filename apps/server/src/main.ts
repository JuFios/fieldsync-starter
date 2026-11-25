import 'reflect-metadata';
import { createApp } from './app.factory';
import { loadConfig, loadDotEnv } from './config';
import { describeStartupError } from './startup-error';

async function bootstrap() {
  loadDotEnv();
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.port);
  // eslint-disable-next-line no-console
  console.log(`fieldsync server listening on ${config.port}`);
}

bootstrap().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(describeStartupError(err));
  process.exit(1);
});
