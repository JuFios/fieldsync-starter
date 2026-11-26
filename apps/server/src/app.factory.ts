import type { INestApplication, NestApplicationOptions } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import type { EnvOverride } from './config.module';

/** Application settings shared by the entry point, the tests and the simulation's server binding. */
export function configureApp(app: INestApplication): INestApplication {
  app.enableCors();
  app.enableShutdownHooks();
  return app;
}

/** Creates the HTTP application with the settings shared by the server entry point and the tests. */
export async function createApp(options: NestApplicationOptions = {}, env?: EnvOverride): Promise<INestApplication> {
  return configureApp(await NestFactory.create(await AppModule.forRoot(env), options));
}
