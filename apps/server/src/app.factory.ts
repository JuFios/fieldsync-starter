import type { NestApplicationOptions } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import type { ServerConfig } from './config';
import type { EnvOverride } from './config.module';

/** Where the OpenAPI description and Swagger UI are served when API_DOCS_ENABLED is true. */
export const API_DOCS_PATH = 'docs';

/** Application settings shared by the entry point, the tests and the simulation's server binding. */
export function configureApp(app: NestExpressApplication): NestExpressApplication {
  const config = app.get<ServerConfig>(ConfigService);
  // Replaces Express's 100 KB default (NestJS FAQ "Raw body", body parser size limit); registered
  // before init, so Nest does not add its default JSON parser.
  app.useBodyParser('json', { limit: config.get('JSON_BODY_LIMIT_BYTES', { infer: true }) });
  // `Retry-After` is not a CORS-safelisted response header: without this the web app, on another
  // origin, cannot read it.
  app.enableCors({ exposedHeaders: ['Retry-After'] });
  app.enableShutdownHooks();
  if (config.get('API_DOCS_ENABLED', { infer: true })) {
    const document = new DocumentBuilder()
      .setTitle('FieldSync API')
      .setDescription('Sync protocol of the offline-first field service platform')
      .addBearerAuth({ type: 'http', scheme: 'bearer', description: 'Access token of the user' })
      .build();
    SwaggerModule.setup(API_DOCS_PATH, app, () => SwaggerModule.createDocument(app, document));
  }
  return app;
}

/** Creates the HTTP application with the settings shared by the server entry point and the tests. */
export async function createApp(
  options: NestApplicationOptions = {},
  env?: EnvOverride,
): Promise<NestExpressApplication> {
  return configureApp(await NestFactory.create<NestExpressApplication>(await AppModule.forRoot(env), options));
}
