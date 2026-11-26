import type { INestApplication, NestApplicationOptions } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import type { AppConfig } from './config';

/** Application settings shared by the entry point, the tests and the simulation's server binding. */
export function configureApp(app: INestApplication): INestApplication {
  app.enableCors();
  app.enableShutdownHooks();
  return app;
}

/** Creates the HTTP application with the settings shared by the server entry point and the tests. */
export async function createApp(config: AppConfig, options: NestApplicationOptions = {}): Promise<INestApplication> {
  return configureApp(await NestFactory.create(AppModule.forRoot(config), options));
}
