/**
 * Lint rules for the whole repository (the web app adds Next.js rules in apps/web/.eslintrc.json).
 * TypeScript files are linted with type information, which the promise rules need: a missed
 * `await` in sync, stream or storage code is a real class of bugs here.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, jest: true, browser: true },
  ignorePatterns: ['dist', 'dist-sim', '.next', 'node_modules', 'test-results', 'playwright-report'],
  rules: {
    eqeqeq: 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  },
  overrides: [
    {
      files: ['**/*.ts', '**/*.tsx', 'e2e/**/*.mjs'],
      parserOptions: {
        project: [
          './packages/*/tsconfig.json',
          './apps/server/tsconfig.json',
          './apps/web/tsconfig.json',
          './e2e/tsconfig.json',
        ],
        tsconfigRootDir: __dirname,
      },
      extends: ['plugin:@typescript-eslint/recommended-type-checked'],
      rules: {
        // Type-only imports are erased; Nest's dependency injection metadata is taken into account.
        '@typescript-eslint/consistent-type-imports': 'error',
        // Every protocol code and status must be handled explicitly.
        '@typescript-eslint/switch-exhaustiveness-check': 'error',
      },
    },
    {
      // Application code logs through its logger; entry points opt out line by line.
      files: ['packages/*/src/**/*.ts', 'apps/server/src/**/*.ts', 'apps/web/app/**/*.{ts,tsx}'],
      rules: { 'no-console': 'error' },
    },
    {
      // Mutators run on the client and on the server and must compute the same rows from the same
      // arguments and state: ids come from the arguments and time from MutatorTx.now(), never from
      // ambient randomness or clocks. The test suite also runs every mutator with these stubbed out.
      files: ['packages/sync-core/src/mutators.ts'],
      rules: {
        'no-restricted-globals': [
          'error',
          ...['Date', 'crypto', 'performance', 'globalThis', 'global', 'window', 'self'].map((name) => ({
            name,
            message: 'Mutators must be deterministic: take ids from the arguments and time from tx.now().',
          })),
          ...['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'fetch'].map((name) => ({
            name,
            message: 'Mutators must be synchronous and side-effect free.',
          })),
        ],
        'no-restricted-properties': [
          'error',
          { object: 'Math', property: 'random', message: 'Mutators must be deterministic: no Math.random().' },
        ],
        'no-restricted-imports': [
          'error',
          {
            paths: ['crypto', 'node:crypto', 'perf_hooks', 'node:perf_hooks', 'timers', 'node:timers'].map((name) => ({
              name,
              message: 'Mutators must not depend on randomness, clocks or timers.',
            })),
          },
        ],
      },
    },
    {
      files: ['**/test/**/*.ts', 'e2e/**/*.ts'],
      rules: {
        // Jest's asymmetric matchers (expect.any, expect.stringContaining, ...) are typed as `any`.
        '@typescript-eslint/no-unsafe-assignment': 'off',
      },
    },
  ],
};
