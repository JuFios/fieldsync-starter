/**
 * Three projects: `unit` (no external services), `integration` (real Postgres from DATABASE_URL,
 * one database per test file; see test/support/database.ts) and `simulation` (the seeded network
 * simulation against the real server and database, see test/simulation).
 */
const base = {
  rootDir: __dirname,
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: { '^.+\\.ts$': 'ts-jest' },
  // Test against the sources of workspace packages, never against a possibly stale build.
  moduleNameMapper: { '^@fieldsync/(sync-core|test-kit|sim)$': '<rootDir>/../../packages/$1/src' },
};

/** @type {import('jest').Config} */
module.exports = {
  reporters: ['default', ['@fieldsync/test-kit/dist/reporter', { label: 'server' }]],
  projects: [
    { ...base, displayName: 'unit', testRegex: 'test/(services/)?[^/]+\\.spec\\.ts$' },
    {
      ...base,
      displayName: 'simulation',
      testRegex: 'test/simulation/.+\\.spec\\.ts$',
      globalSetup: '<rootDir>/test/support/global-setup.ts',
      globalTeardown: '<rootDir>/test/support/global-teardown.ts',
      setupFilesAfterEnv: ['<rootDir>/test/support/integration-setup.ts'],
    },
    {
      ...base,
      displayName: 'integration',
      testRegex: 'test/integration/.+\\.spec\\.ts$',
      globalSetup: '<rootDir>/test/support/global-setup.ts',
      globalTeardown: '<rootDir>/test/support/global-teardown.ts',
      setupFilesAfterEnv: ['<rootDir>/test/support/integration-setup.ts'],
    },
  ],
};
