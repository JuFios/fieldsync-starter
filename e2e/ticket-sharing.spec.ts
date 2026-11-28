import { randomUUID } from 'node:crypto';
import { expect, signIn, test } from './support/world';

/** Characterizes the basic scenario of the original app: sign in, create a ticket, another user sees it. */
test('a ticket created by one technician appears for another technician of the same site', async ({
  browser,
  world,
}) => {
  const site = await world.site('E2E');
  const alice = await world.technician(site);
  const bob = await world.technician(site);
  const title = `Leaking valve ${randomUUID().slice(0, 8)}`;

  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  try {
    // Bob is online first, so the ticket has to reach him through the live update stream.
    const bobPage = await bobContext.newPage();
    await signIn(bobPage, bob.token);
    await expect(bobPage.getByRole('heading', { name: 'Tickets' })).toBeVisible();
    // Not "no tickets": until the server filters incremental pulls by the user's sites (known defect
    // F-07), tickets that tests running in parallel create on their own sites can reach this list.
    await expect(bobPage.getByRole('link', { name: title })).toHaveCount(0);

    const alicePage = await aliceContext.newPage();
    await signIn(alicePage, alice.token);
    await alicePage.getByPlaceholder('New ticket title').fill(title);
    await alicePage.locator('form input').nth(1).fill(site);
    await alicePage.getByRole('button', { name: 'Create' }).click();

    await expect(alicePage.getByRole('link', { name: title })).toBeVisible();
    await expect(alicePage.getByText('synced · 0 pending')).toBeVisible();
    await expect(bobPage.getByRole('link', { name: title })).toBeVisible();
    await expect(bobPage.getByRole('link', { name: title })).toHaveCount(1);
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});
