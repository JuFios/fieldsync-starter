import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

/**
 * End-to-end tests drive the production builds (`npm run build` first) in Chromium against a
 * dedicated database. DATABASE_URL names a maintenance database on the Postgres to use; the e2e
 * database (E2E_DATABASE, default fieldsync_e2e) is recreated and migrated on every run and kept
 * afterwards for inspection.
 */
const root = resolve(__dirname, '..');
const maintenanceUrl = process.env.DATABASE_URL;
if (!maintenanceUrl) {
  throw new Error('The e2e tests need DATABASE_URL, e.g. postgres://fieldsync:fieldsync@localhost:5432/fieldsync');
}
const e2eUrl = new URL(maintenanceUrl);
e2eUrl.pathname = `/${process.env.E2E_DATABASE ?? 'fieldsync_e2e'}`;
// Read by the fixtures in the test workers, which write to the same database as the server.
process.env.E2E_DATABASE_URL = e2eUrl.toString();

// The web bundle has the API URL compiled in (NEXT_PUBLIC_API_URL at build time); serve the API there.
const apiUrl = new URL(process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001');
const webPort = Number(process.env.E2E_WEB_PORT ?? 3000);
const webUrl = `http://localhost:${webPort}`;

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // No retries: a flaky e2e test is a defect to fix, not to hide.
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: webUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command:
        'node e2e/support/create-database.mjs && node apps/server/dist/database/migrate.js && node apps/server/dist/main.js',
      cwd: root,
      url: `${apiUrl.origin}/health`,
      env: {
        DATABASE_URL: e2eUrl.toString(),
        E2E_MAINTENANCE_URL: maintenanceUrl,
        PORT: apiUrl.port || '80',
        SEED_DEMO: 'false',
      },
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
    },
    {
      command: `npx next start -p ${webPort}`,
      cwd: resolve(root, 'apps/web'),
      url: webUrl,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
