import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, validate, type EnvironmentVariables } from '../src/config';
import { configModule } from '../src/config.module';

const SECRET_URL = 'postgres://fieldsync:s3cret-password@db.internal:5432/fieldsync';

function problemsOf(env: Record<string, string>): readonly string[] {
  try {
    validate({ DATABASE_URL: SECRET_URL, ...env });
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as ConfigError).problems;
  }
  throw new Error('expected loadConfig to reject the environment');
}

describe('validate', () => {
  it('applies defaults when only DATABASE_URL is set', () => {
    expect({ ...validate({ DATABASE_URL: SECRET_URL }) }).toEqual({
      PORT: 3001,
      DATABASE_URL: SECRET_URL,
      DB_POOL_MAX: 20,
      DB_LOCK_TIMEOUT_MS: 2_000,
      DB_STATEMENT_TIMEOUT_MS: 15_000,
      DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: 10_000,
      SEED_DEMO: false,
      CHANGELOG_RETENTION_SECONDS: 604_800,
      MUTATION_RESULT_RETENTION_SECONDS: 1_209_600,
      GC_BATCH_SIZE: 5_000,
      GC_INTERVAL_MS: 3_600_000,
      JSON_BODY_LIMIT_BYTES: 2_097_152,
      STREAM_HEARTBEAT_MS: 15_000,
      API_DOCS_ENABLED: false,
    });
  });

  it('reads every setting', () => {
    expect(
      validate({
        PORT: '8080',
        DATABASE_URL: 'postgresql://u:p@localhost/db',
        DB_POOL_MAX: '5',
        SEED_DEMO: 'true',
        CHANGELOG_RETENTION_SECONDS: '3600',
        MUTATION_RESULT_RETENTION_SECONDS: '7200',
        GC_BATCH_SIZE: '100',
        GC_INTERVAL_MS: '1000',
        JSON_BODY_LIMIT_BYTES: '1048576',
        STREAM_HEARTBEAT_MS: '1000',
        API_DOCS_ENABLED: 'true',
      }),
    ).toMatchObject({
      PORT: 8080,
      DATABASE_URL: 'postgresql://u:p@localhost/db',
      DB_POOL_MAX: 5,
      SEED_DEMO: true,
      CHANGELOG_RETENTION_SECONDS: 3600,
      MUTATION_RESULT_RETENTION_SECONDS: 7200,
      GC_BATCH_SIZE: 100,
      GC_INTERVAL_MS: 1000,
      JSON_BODY_LIMIT_BYTES: 1_048_576,
      STREAM_HEARTBEAT_MS: 1000,
      API_DOCS_ENABLED: true,
    });
  });

  it('treats empty values as unset', () => {
    expect(validate({ DATABASE_URL: SECRET_URL, PORT: '', SEED_DEMO: '  ' })).toMatchObject({
      PORT: 3001,
      SEED_DEMO: false,
    });
  });

  it('returns a frozen object', () => {
    expect(Object.isFrozen(validate({ DATABASE_URL: SECRET_URL }))).toBe(true);
  });

  it.each([
    ['GC_INTERVAL_MS', '1h'],
    ['GC_INTERVAL_MS', '999'],
    ['GC_INTERVAL_MS', '2147483648'],
    ['GC_INTERVAL_MS', '1e4'],
    // Below what the client sends in one push, so its batches would be refused for their size.
    ['JSON_BODY_LIMIT_BYTES', '1048575'],
    ['JSON_BODY_LIMIT_BYTES', '67108865'],
    ['JSON_BODY_LIMIT_BYTES', '2mb'],
    // A heartbeat under a second floods the streams; over a minute, proxies drop idle connections.
    ['STREAM_HEARTBEAT_MS', '999'],
    ['STREAM_HEARTBEAT_MS', '60001'],
    ['STREAM_HEARTBEAT_MS', '15s'],
    ['DB_LOCK_TIMEOUT_MS', '0'],
    ['DB_STATEMENT_TIMEOUT_MS', '2s'],
    ['DB_IDLE_IN_TRANSACTION_TIMEOUT_MS', '-1'],
    ['PORT', '0'],
    ['PORT', '65536'],
    ['PORT', '30O1'],
    ['DB_POOL_MAX', '0'],
    ['DB_POOL_MAX', '2.5'],
    ['CHANGELOG_RETENTION_SECONDS', '0'],
    ['CHANGELOG_RETENTION_SECONDS', '-1'],
    // Shorter than a snapshot may take, see CHANGELOG_RETENTION_SECONDS.
    ['CHANGELOG_RETENTION_SECONDS', '3599'],
    ['MUTATION_RESULT_RETENTION_SECONDS', '3599'],
    ['GC_BATCH_SIZE', '99'],
    ['GC_BATCH_SIZE', '100001'],
  ])('rejects %s=%s with a readable message', (name, value) => {
    const problems = problemsOf({ [name]: value });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(new RegExp(`^${name} must be an integer from \\d+ to \\d+ \\(got "${value}"\\)$`));
  });

  it('makes the result retention twice the change-log retention by default, at least 14 days', () => {
    expect(validate({ DATABASE_URL: SECRET_URL, CHANGELOG_RETENTION_SECONDS: '2592000' })).toMatchObject({
      MUTATION_RESULT_RETENTION_SECONDS: 5_184_000,
    });
    expect(validate({ DATABASE_URL: SECRET_URL, CHANGELOG_RETENTION_SECONDS: '3600' })).toMatchObject({
      MUTATION_RESULT_RETENTION_SECONDS: 1_209_600,
    });
  });

  it('rejects a result retention shorter than the change-log retention', () => {
    expect(problemsOf({ CHANGELOG_RETENTION_SECONDS: '7200', MUTATION_RESULT_RETENTION_SECONDS: '3600' })).toEqual([
      'MUTATION_RESULT_RETENTION_SECONDS must not be shorter than CHANGELOG_RETENTION_SECONDS (got 3600 and 7200)',
    ]);
  });

  it.each(['SEED_DEMO', 'API_DOCS_ENABLED'])('rejects anything but "true" or "false" for %s', (name) => {
    expect(problemsOf({ [name]: 'yes' })).toEqual([`${name} must be "true" or "false" (got "yes")`]);
  });

  it('accepts surrounding spaces, as the previous loader did', () => {
    expect(validate({ DATABASE_URL: SECRET_URL, PORT: ' 8080 ', SEED_DEMO: ' true ' })).toMatchObject({
      PORT: 8080,
      SEED_DEMO: true,
    });
  });

  it('keeps only the settings, not the rest of the environment', () => {
    expect(Object.keys(validate({ DATABASE_URL: SECRET_URL, HOME: '/root', PATH: '/bin' }))).not.toContain('HOME');
  });

  it('requires DATABASE_URL', () => {
    expect(() => validate({})).toThrow('DATABASE_URL is required');
    expect(() => validate({ DATABASE_URL: '   ' })).toThrow('DATABASE_URL is required');
  });

  it.each(['mysql://u:p@h/db', 'not a url', 'http://db:5432/fieldsync', 'socket:/var/run/postgresql'])(
    'rejects DATABASE_URL=%s without echoing it',
    (url) => {
      const problems = problemsOf({ DATABASE_URL: url });
      expect(problems).toEqual([
        'DATABASE_URL must be a postgres:// or postgresql:// connection string (value not shown)',
      ]);
    },
  );

  it.each([
    'postgresql://app:secret@/fieldsync?host=/var/run/postgresql',
    'postgres:///fieldsync?host=/tmp',
    'POSTGRES://app@db.internal/fieldsync?sslmode=require',
  ])('accepts DATABASE_URL=%s, including Unix-socket forms that pg understands', (url) => {
    expect(validate({ DATABASE_URL: url }).DATABASE_URL).toBe(url);
  });

  it('reports every problem at once and never includes the database URL', () => {
    let error: ConfigError | undefined;
    try {
      validate({ DATABASE_URL: SECRET_URL, PORT: 'x', GC_INTERVAL_MS: 'y' });
    } catch (err) {
      error = err as ConfigError;
    }
    expect(error?.problems).toHaveLength(2);
    expect(error?.message).toBe(
      'Invalid configuration:\n' +
        '  - PORT must be an integer from 1 to 65535 (got "x")\n' +
        '  - GC_INTERVAL_MS must be an integer from 1000 to 2147483647 (got "y")',
    );
    expect(error?.message).not.toContain('s3cret');
  });
});

describe('configModule', () => {
  async function configFrom(env?: Record<string, string>): Promise<ConfigService<EnvironmentVariables, true>> {
    const moduleRef = await Test.createTestingModule({ imports: [await configModule(env)] }).compile();
    return moduleRef.get(ConfigService);
  }

  it('serves the validated, typed settings through ConfigService', async () => {
    const config = await configFrom({ DATABASE_URL: SECRET_URL, GC_INTERVAL_MS: '5000' });
    expect(config.get('GC_INTERVAL_MS', { infer: true })).toBe(5000);
    expect(config.get('SEED_DEMO', { infer: true })).toBe(false);
  });

  it('rejects an invalid environment before any module is built', async () => {
    await expect(configModule({ DATABASE_URL: SECRET_URL, GC_INTERVAL_MS: '1h' })).rejects.toThrow(ConfigError);
  });

  it('reads .env from the working directory, and the process environment wins over it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-env-'));
    const cwd = process.cwd();
    const saved = { ...process.env };
    try {
      writeFileSync(join(dir, '.env'), `# comment\nDATABASE_URL=${SECRET_URL}\nGC_INTERVAL_MS=2000\nDB_POOL_MAX=7\n`);
      process.chdir(dir);
      process.env.GC_INTERVAL_MS = '3000';
      delete process.env.DB_POOL_MAX;
      delete process.env.DATABASE_URL;
      const config = await configFrom();
      expect(config.get('GC_INTERVAL_MS', { infer: true })).toBe(3000);
      expect(config.get('DB_POOL_MAX', { infer: true })).toBe(7);
      expect(config.get('DATABASE_URL', { infer: true })).toBe(SECRET_URL);
    } finally {
      process.chdir(cwd);
      process.env = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores the process environment when the settings are given', async () => {
    const saved = process.env.GC_INTERVAL_MS;
    process.env.GC_INTERVAL_MS = '1h';
    try {
      const config = await configFrom({ DATABASE_URL: SECRET_URL });
      expect(config.get('GC_INTERVAL_MS', { infer: true })).toBe(3_600_000);
    } finally {
      if (saved === undefined) delete process.env.GC_INTERVAL_MS;
      else process.env.GC_INTERVAL_MS = saved;
    }
  });

  it('leaves the process environment untouched when the settings are given', async () => {
    const saved = { ...process.env };
    try {
      for (const name of Object.keys(validate({ DATABASE_URL: SECRET_URL }))) delete process.env[name];
      const before = { ...process.env };
      await configFrom({ DATABASE_URL: SECRET_URL, GC_INTERVAL_MS: '5000', SEED_DEMO: 'true' });
      expect(process.env).toEqual(before);
    } finally {
      process.env = saved;
    }
  });

  it('reads only the settings from .env: other entries, PG* included, do not reach the process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-env-'));
    const cwd = process.cwd();
    const saved = { ...process.env };
    try {
      writeFileSync(join(dir, '.env'), `DATABASE_URL=${SECRET_URL}\nPGSSLMODE=require\n`);
      process.chdir(dir);
      delete process.env.DATABASE_URL;
      delete process.env.PGSSLMODE;
      await configFrom();
      expect(process.env.PGSSLMODE).toBeUndefined();
    } finally {
      process.chdir(cwd);
      process.env = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
