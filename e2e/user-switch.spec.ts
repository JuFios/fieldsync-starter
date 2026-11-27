import { randomUUID } from 'node:crypto';
import { expect, signIn, test } from './support/world';

/**
 * Data of one user must not reach another user of the same browser (F-40): after the first user's
 * token is gone and a second user signs in, nothing of the first user's state is shown.
 */
test("a user who signs in after another in the same browser sees none of the other's tickets", async ({
  browser,
  world,
}) => {
  const aliceSite = await world.site('Alice');
  const bobSite = await world.site('Bob');
  const alice = await world.technician(aliceSite);
  const bob = await world.technician(bobSite);
  const secret = `Alice only ${randomUUID().slice(0, 8)}`;

  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await signIn(page, alice.token);
    await page.getByPlaceholder('New ticket title').fill(secret);
    await page.locator('form input').nth(1).fill(aliceSite);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('link', { name: secret })).toBeVisible();
    await expect(page.getByText('0 pending')).toBeVisible();

    // Alice's session ends: her token is gone, as after signing out.
    await page.evaluate(() => localStorage.removeItem('fs_token'));
    await page.reload();
    await signIn(page, bob.token);

    await expect(page.getByRole('heading', { name: 'Tickets' })).toBeVisible();
    await expect(page.getByText('No tickets yet.')).toBeVisible();
    await expect(page.getByRole('link', { name: secret })).toHaveCount(0);
  } finally {
    await context.close();
  }
});
