import { ConfigModule } from '@nestjs/config';
import type { DynamicModule } from '@nestjs/common';
import { EnvironmentVariables, validate } from './config';

/** Environment for an application built in-process (tests), instead of process.env and `.env`. */
export type EnvOverride = Record<string, string | undefined>;

/**
 * The global `ConfigModule`, validated with {@link validate}. Without `env` it reads process.env
 * and `.env` in the working directory, where process.env wins (the module's documented behaviour).
 * With `env` it reads only that object, so tests can build several applications with different
 * settings in one process. `forRoot` validates while it builds the module; awaiting it here makes a
 * configuration error reject the caller before Nest starts.
 *
 * `forRoot` also copies the validated settings into process.env where a variable is unset. With
 * `env` those copies are removed again: the given settings belong to one application, not to the
 * process (they would otherwise leak into later configurations and child processes).
 */
export async function configModule(env?: EnvOverride): Promise<DynamicModule> {
  const isolated = env !== undefined;
  // The settings ConfigModule may copy into process.env, and which of them are unset now.
  const copied = Object.keys(new EnvironmentVariables()).filter((name) => !(name in process.env));
  const module = ConfigModule.forRoot({
    isGlobal: true,
    cache: true,
    ignoreEnvFile: isolated,
    validatePredefined: !isolated,
    skipProcessEnv: isolated,
    validate: (loaded) => validate(isolated ? env : loaded),
  });
  try {
    return await module;
  } finally {
    if (isolated) {
      for (const name of copied) delete process.env[name];
    }
  }
}
