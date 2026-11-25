import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig, loadDotEnv } from '../src/config';

const SECRET_URL = 'postgres://fieldsync:s3cret-password@db.internal:5432/fieldsync';

function problemsOf(env: Record<string, string>): readonly string[] {
  try {
    loadConfig({ DATABASE_URL: SECRET_URL, ...env });
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as ConfigError).problems;
  }
  throw new Error('expected loadConfig to reject the environment');
}

describe('loadConfig', () => {
  it('applies defaults when only DATABASE_URL is set', () => {
    expect(loadConfig({ DATABASE_URL: SECRET_URL })).toEqual({
      port: 3001,
      databaseUrl: SECRET_URL,
      dbPoolMax: 20,
      seedDemo: false,
      changelogRetentionSeconds: 604_800,
      gcIntervalMs: 3_600_000,
    });
  });

  it('reads every setting', () => {
    expect(
      loadConfig({
        PORT: '8080',
        DATABASE_URL: 'postgresql://u:p@localhost/db',
        DB_POOL_MAX: '5',
        SEED_DEMO: 'true',
        CHANGELOG_RETENTION_SECONDS: '60',
        GC_INTERVAL_MS: '1000',
      }),
    ).toEqual({
      port: 8080,
      databaseUrl: 'postgresql://u:p@localhost/db',
      dbPoolMax: 5,
      seedDemo: true,
      changelogRetentionSeconds: 60,
      gcIntervalMs: 1000,
    });
  });

  it('treats empty values as unset', () => {
    expect(loadConfig({ DATABASE_URL: SECRET_URL, PORT: '', SEED_DEMO: '  ' }).port).toBe(3001);
  });

  it('returns a frozen object', () => {
    expect(Object.isFrozen(loadConfig({ DATABASE_URL: SECRET_URL }))).toBe(true);
  });

  it.each([
    ['GC_INTERVAL_MS', '1h'],
    ['GC_INTERVAL_MS', '999'],
    ['GC_INTERVAL_MS', '2147483648'],
    ['GC_INTERVAL_MS', '1e4'],
    ['PORT', '0'],
    ['PORT', '65536'],
    ['PORT', '30O1'],
    ['DB_POOL_MAX', '0'],
    ['DB_POOL_MAX', '2.5'],
    ['CHANGELOG_RETENTION_SECONDS', '0'],
    ['CHANGELOG_RETENTION_SECONDS', '-1'],
  ])('rejects %s=%s with a readable message', (name, value) => {
    const problems = problemsOf({ [name]: value });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(new RegExp(`^${name} must be an integer from \\d+ to \\d+ \\(got "${value}"\\)$`));
  });

  it('rejects anything but "true" or "false" for SEED_DEMO', () => {
    expect(problemsOf({ SEED_DEMO: 'yes' })).toEqual(['SEED_DEMO must be "true" or "false" (got "yes")']);
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow('DATABASE_URL is required');
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
    expect(loadConfig({ DATABASE_URL: url }).databaseUrl).toBe(url);
  });

  it('reports every problem at once and never includes the database URL', () => {
    let error: ConfigError | undefined;
    try {
      loadConfig({ DATABASE_URL: SECRET_URL, PORT: 'x', GC_INTERVAL_MS: 'y' });
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

describe('loadDotEnv', () => {
  it('loads .env from the given directory without overriding the environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-env-'));
    try {
      writeFileSync(join(dir, '.env'), '# comment\nFROM_FILE=file\nFROM_ENV=file\nQUOTED="a b"\n');
      const env: Record<string, string | undefined> = { FROM_ENV: 'env' };
      expect(loadDotEnv(dir, env)).toBe(join(dir, '.env'));
      expect(env).toEqual({ FROM_FILE: 'file', FROM_ENV: 'env', QUOTED: 'a b' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does nothing when there is no .env file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-env-'));
    try {
      const env = {};
      expect(loadDotEnv(dir, env)).toBeUndefined();
      expect(env).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
