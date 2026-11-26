import { ConfigModule } from '@nestjs/config';
import type { DynamicModule } from '@nestjs/common';
import { validate } from './config';

/** Environment for an application built in-process (tests), instead of process.env and `.env`. */
export type EnvOverride = Record<string, string | undefined>;

/**
 * The global `ConfigModule`, validated with {@link validate}. Without `env` it reads process.env
 * and `.env` in the working directory, where process.env wins (the module's documented behaviour).
 * With `env` it reads only that object, so tests can build several applications with different
 * settings in one process. `forRoot` validates while it builds the module; awaiting it here makes a
 * configuration error reject the caller before Nest starts.
 */
export function configModule(env?: EnvOverride): Promise<DynamicModule> {
  const isolated = env !== undefined;
  return ConfigModule.forRoot({
    isGlobal: true,
    cache: true,
    ignoreEnvFile: isolated,
    validatePredefined: !isolated,
    skipProcessEnv: isolated,
    validate: (loaded) => validate(isolated ? env : loaded),
  });
}
