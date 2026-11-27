import { MAX_PUSH_BODY_BYTES } from '@fieldsync/sync-core';
import { ConfigService } from '@nestjs/config';
import { Expose, plainToInstance, Transform, type TransformFnParams } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsOptional,
  IsString,
  Matches,
  validateSync,
  type ValidationArguments,
} from 'class-validator';
import { IntegerIn as IntegerBetween, trimmed } from './validation';

/** Largest delay setInterval accepts; larger values silently become 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/** Shortest retention of the change log and of mutation results, in seconds (see CHANGELOG_RETENTION_SECONDS). */
export const MIN_RETENTION_SECONDS = 3_600;

/** The default retention of mutation results is twice the log's, and never less than this (14 days). */
const DEFAULT_MIN_RESULT_RETENTION_SECONDS = 1_209_600;

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

  /**
   * Longest wait for a row lock, per lock (PostgreSQL lock_timeout), on the server's connections. A
   * transaction that hangs while holding the change log's head must not stop every writer: they get
   * a 503 and retry instead of waiting.
   */
  @Expose()
  @IntegerIn(1, 600_000)
  DB_LOCK_TIMEOUT_MS = 2_000;

  /** Longest run of one statement on the server's connections (PostgreSQL statement_timeout). */
  @Expose()
  @IntegerIn(1, 3_600_000)
  DB_STATEMENT_TIMEOUT_MS = 15_000;

  /**
   * A session of the server that idles inside a transaction this long is ended by Postgres, which
   * rolls the transaction back and frees its locks (idle_in_transaction_session_timeout).
   */
  @Expose()
  @IntegerIn(1, 3_600_000)
  DB_IDLE_IN_TRANSACTION_TIMEOUT_MS = 10_000;

  /**
   * Change-log entries older than this are removed by the GC; a client whose cursor falls behind
   * them is reset (410 RESET_REQUIRED) and reloads its state from a snapshot. At least an hour: a
   * snapshot started at the head of the log stays valid until the changes after it are this old, so
   * a snapshot (with the tail of the log after it) must finish within the retention.
   */
  @Expose()
  @IntegerIn(MIN_RETENTION_SECONDS, 2_147_483_647)
  CHANGELOG_RETENTION_SECONDS = 604_800;

  /**
   * Results of rejected mutations, and of applied ones that changed nothing, are kept this long to
   * answer retried copies of them; results of applied mutations go with the log entries of their
   * changes. Never shorter than the change-log retention, so a client that is reset still learns why
   * its mutations were rejected. Unset, it is twice the change-log retention, at least 14 days.
   */
  @Expose()
  @IsOptional()
  @IntegerIn(MIN_RETENTION_SECONDS, 2_147_483_647)
  MUTATION_RESULT_RETENTION_SECONDS!: number;

  /** Most change-log entries one GC transaction removes, so that no transaction holds locks for long. */
  @Expose()
  @IntegerIn(100, 100_000)
  GC_BATCH_SIZE = 5_000;

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
  const problems = errors.flatMap((e) => Object.values(e.constraints ?? {}));
  if (problems.length === 0 && (config.MUTATION_RESULT_RETENTION_SECONDS as number | undefined) === undefined) {
    config.MUTATION_RESULT_RETENTION_SECONDS = Math.max(
      DEFAULT_MIN_RESULT_RETENTION_SECONDS,
      Math.min(2 * config.CHANGELOG_RETENTION_SECONDS, 2_147_483_647),
    );
  }
  if (problems.length === 0 && config.MUTATION_RESULT_RETENTION_SECONDS < config.CHANGELOG_RETENTION_SECONDS) {
    problems.push(
      `MUTATION_RESULT_RETENTION_SECONDS must not be shorter than CHANGELOG_RETENTION_SECONDS ` +
        `(got ${config.MUTATION_RESULT_RETENTION_SECONDS} and ${config.CHANGELOG_RETENTION_SECONDS})`,
    );
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return Object.freeze(config);
}
