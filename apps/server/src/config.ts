import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

/**
 * Server configuration, read once from the environment at startup and validated as a whole, so a
 * bad value stops the process with one readable report instead of misbehaving later.
 *
 * The class is also the Nest injection token; instances come from {@link loadConfig}.
 */
export abstract class AppConfig {
  /** HTTP port of the API. */
  abstract readonly port: number;
  /** Postgres connection string. Secret: never logged or echoed in errors. */
  abstract readonly databaseUrl: string;
  /** Maximum connections in the server's database pool. */
  abstract readonly dbPoolMax: number;
  /** Insert the demo sites, users and well-known tokens on startup. Development only. */
  abstract readonly seedDemo: boolean;
  /** Change-log entries older than this are removed by the GC. */
  abstract readonly changelogRetentionSeconds: number;
  /** How often the change-log GC runs. */
  abstract readonly gcIntervalMs: number;
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

/** Largest delay setInterval accepts; larger values silently become 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

class Reader {
  readonly problems: string[] = [];

  constructor(private readonly env: Env) {}

  private raw(name: string): string | undefined {
    const value = this.env[name]?.trim();
    return value === '' ? undefined : value;
  }

  integer(name: string, fallback: number, min: number, max: number): number {
    const raw = this.raw(name);
    if (raw === undefined) return fallback;
    const value = /^-?\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      this.problems.push(`${name} must be an integer from ${min} to ${max} (got "${raw}")`);
      return fallback;
    }
    return value;
  }

  boolean(name: string, fallback: boolean): boolean {
    const raw = this.raw(name);
    if (raw === undefined) return fallback;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    this.problems.push(`${name} must be "true" or "false" (got "${raw}")`);
    return fallback;
  }

  /**
   * A required Postgres connection string. Only the scheme is checked: the rest follows libpq
   * rules that pg implements (Unix sockets as `?host=/dir`, defaults from PG* variables), and an
   * unreachable database is reported when the server connects. The value is a secret, so problems
   * never include it.
   */
  postgresUrl(name: string): string {
    const raw = this.raw(name);
    if (raw === undefined) {
      this.problems.push(`${name} is required (a postgres:// connection string)`);
      return '';
    }
    if (!/^postgres(?:ql)?:\/\//i.test(raw)) {
      this.problems.push(`${name} must be a postgres:// or postgresql:// connection string (value not shown)`);
      return '';
    }
    return raw;
  }
}

/** Reads and validates the configuration; throws {@link ConfigError} listing every problem. */
export function loadConfig(env: Env = process.env): AppConfig {
  const r = new Reader(env);
  const config: AppConfig = {
    port: r.integer('PORT', 3001, 1, 65_535),
    databaseUrl: r.postgresUrl('DATABASE_URL'),
    dbPoolMax: r.integer('DB_POOL_MAX', 20, 1, 1_000),
    seedDemo: r.boolean('SEED_DEMO', false),
    changelogRetentionSeconds: r.integer('CHANGELOG_RETENTION_SECONDS', 604_800, 1, 2_147_483_647),
    // At least a second: a GC that runs more often only loads the database (ms vs s mix-ups).
    gcIntervalMs: r.integer('GC_INTERVAL_MS', 3_600_000, 1_000, MAX_TIMER_MS),
  };
  if (r.problems.length > 0) throw new ConfigError(r.problems);
  return Object.freeze(config);
}

/**
 * Loads `.env` from `cwd` into `env` when the file exists (Node's own dotenv parser). Variables
 * that are already set win over the file, as with `node --env-file`. Returns the file used.
 */
export function loadDotEnv(cwd: string = process.cwd(), env: Env = process.env): string | undefined {
  const file = resolve(cwd, '.env');
  if (!existsSync(file)) return undefined;
  for (const [name, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
    if (env[name] === undefined && value !== undefined) env[name] = value;
  }
  return file;
}
