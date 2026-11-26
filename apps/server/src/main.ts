import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createApp } from './app.factory';
import type { ServerConfig } from './config';
import { describeStartupError } from './startup-error';

async function bootstrap() {
  // Nest would otherwise abort the process (SIGABRT, core dump) on a bootstrap error and skip the
  // handler below, which prints it without the error's properties.
  const app = await createApp({ abortOnError: false });
  const port = app.get<ServerConfig>(ConfigService).get('PORT', { infer: true });
  await app.listen(port);
  new Logger('Bootstrap').log(`fieldsync server listening on ${port}`);
}

bootstrap().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(describeStartupError(err));
  process.exit(1);
});
