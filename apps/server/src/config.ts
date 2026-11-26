import { MAX_PUSH_BODY_BYTES } from '@fieldsync/sync-core';
import { ConfigService } from '@nestjs/config';
import { Expose, plainToInstance, Transform, type TransformFnParams } from 'class-transformer';
import { IsBoolean, IsDefined, IsString, Matches, validateSync, type ValidationArguments } from 'class-validator';
import { IntegerIn as IntegerBetween, trimmed } from './validation';

/** Largest delay setInterval accepts; larger values silently become 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/** A blank value counts as unset, so the setting gets its default. */
function isBlank(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === '';
}

/** The message of a failed check, with the offending value (never used for secrets). */
function withValue(text: string): (args: ValidationArguments) => string {
  return (args) => `${args.property} ${text} (got "${String(args.value)}")`;
}

/** Accepts exactly "true" or "false". */
const ToBoolean = () =>
  Transform(({ value }: TransformFnParams) => {
    const v = trimmed(value);
    return v === 'true' ? true : v === 'false' ? false : v;
  });

/** An integer setting; the message names the variable and its value (settings are never secrets here). */
function IntegerIn(min: number, max: number): PropertyDecorator {
  return IntegerBetween(min, max, { message: withValue(`must be an integer from ${min} to ${max}`) });
}

/**
 * The server's environment, validated as a whole when `ConfigModule` loads (see {@link validate}).
 * Property names are the variable names, as in the `@nestjs/config` documentation, so
 * `ConfigService.get('PORT', { infer: true })` is typed.
 */
export class EnvironmentVariables {
  /** HTTP port of the API. */
  @Expose()
  @IntegerIn(1, 65_535)
  PORT = 3001;

  /**
   * Postgres connection string. Secret: never logged or echoed in errors. Only the scheme is
   * checked: the rest follows libpq rules that pg implements (Unix sockets as `?host=/dir`,
   * defaults from PG* variables of the real environment; `.env` supplies only the settings declared
   * here), and an unreachable database is reported when the server connects.
   */
  @Expose()
  @Transform(({ value }: TransformFnParams) => trimmed(value))
  @IsDefined({ message: '$property is required (a postgres:// connection string)' })
  @IsString({ message: '$property must be a postgres:// or postgresql:// connection string (value not shown)' })
  @Matches(/^postgres(?:ql)?:\/\//i, {
    message: '$property must be a postgres:// or postgresql:// connection string (value not shown)',
  })
  DATABASE_URL!: string;

  /** Maximum connections in the server's database pool. */
  @Expose()
  @IntegerIn(1, 1_000)
  DB_POOL_MAX = 20;

  /** Insert the demo sites, users and well-known tokens on startup. Development only. */
  @Expose()
  @ToBoolean()
  @IsBoolean({ message: withValue('must be "true" or "false"') })
  SEED_DEMO = false;

  /** Change-log entries older than this are removed by the GC. */
  @Expose()
  @IntegerIn(1, 2_147_483_647)
  CHANGELOG_RETENTION_SECONDS = 604_800;

  /** How often the change-log GC runs. At least a second: a GC that runs more often only loads the database. */
  @Expose()
  @IntegerIn(1_000, MAX_TIMER_MS)
  GC_INTERVAL_MS = 3_600_000;

  /**
   * Largest JSON request body, in bytes. At least what the client puts in one push, so a batch the
   * client sends is never refused for its size; at most 64 MiB.
   */
  @Expose()
  @IntegerIn(MAX_PUSH_BODY_BYTES, 67_108_864)
  JSON_BODY_LIMIT_BYTES = 2_097_152;

  /** Serve the OpenAPI description and Swagger UI at /docs. */
  @Expose()
  @ToBoolean()
  @IsBoolean({ message: withValue('must be "true" or "false"') })
  API_DOCS_ENABLED = false;
}

/** Typed access to the validated settings: `config.get('PORT', { infer: true })` is a number. */
export type ServerConfig = ConfigService<EnvironmentVariables, true>;

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * The `validate` function of `ConfigModule.forRoot`: converts and checks every setting and throws
 * {@link ConfigError} listing all problems at once. Variables that are not settings are dropped.
 * Problems name the variable and never contain the database URL; the validation errors themselves,
 * which carry the values, are not kept.
 */
export function validate(env: Record<string, unknown>): EnvironmentVariables {
  const set = Object.fromEntries(Object.entries(env).filter(([, value]) => !isBlank(value)));
  const config = plainToInstance(EnvironmentVariables, set, {
    excludeExtraneousValues: true,
    exposeDefaultValues: true,
  });
  const errors = validateSync(config, {
    stopAtFirstError: true,
    validationError: { target: false, value: false },
  });
  if (errors.length > 0) {
    throw new ConfigError(errors.flatMap((e) => Object.values(e.constraints ?? {})));
  }
  return Object.freeze(config);
}
