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
  ignorePatterns: ['dist', '.next', 'node_modules', 'test-results', 'playwright-report'],
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
      files: ['**/test/**/*.ts', 'e2e/**/*.ts'],
      rules: {
        // Jest's asymmetric matchers (expect.any, expect.stringContaining, ...) are typed as `any`.
        '@typescript-eslint/no-unsafe-assignment': 'off',
      },
    },
  ],
};
