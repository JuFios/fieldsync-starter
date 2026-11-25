import type { INestApplication, NestApplicationOptions } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import type { AppConfig } from './config';

/** Creates the HTTP application with the settings shared by the server entry point and the tests. */
export async function createApp(config: AppConfig, options: NestApplicationOptions = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(config), options);
  app.enableCors();
  app.enableShutdownHooks();
  return app;
}
