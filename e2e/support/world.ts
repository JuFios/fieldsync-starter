import { test as base, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { Fixtures } from '../../apps/server/test/support/fixtures';

/**
 * `world` creates fresh sites and users for each test directly in the e2e database, so parallel
 * tests never share data (no demo users).
 */
export const test = base.extend<{ world: Fixtures }, { db: Pool }>({
  db: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring pattern
    async ({}, use) => {
      const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 2 });
      await use(pool);
      await pool.end();
    },
    { scope: 'worker' },
  ],
  world: async ({ db }, use) => {
    await use(new Fixtures(db));
  },
});

export { expect } from '@playwright/test';

export async function signIn(page: Page, token: string): Promise<void> {
  await page.goto('/');
  await page.getByPlaceholder('token').fill(token);
  await page.getByRole('button', { name: 'Sign in' }).click();
}
