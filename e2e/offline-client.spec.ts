import { randomUUID } from 'node:crypto';
import type { BrowserContext } from '@playwright/test';
import { expect, test } from './support/world';
import { TicketsPage } from './support/tickets-page';

const API = new URL(process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').origin;
const unique = (label: string) => `${label} ${randomUUID().slice(0, 8)}`;

/** Makes the API unreachable for the context (the web app itself still loads). */
const cutOffApi = (context: BrowserContext) =>
  context.route(`${API}/**`, (route) => route.abort('internetdisconnected'));
const reconnectApi = (context: BrowserContext) => context.unroute(`${API}/**`);

/** How many tickets with this title the server stored. */
test.describe('the offline-first client', () => {
  test('keeps changes made without the server across a reload and sends each exactly once', async ({
    browser,
    world,
    db,
  }) => {
    const site = await world.site('Reload');
    const tech = await world.technician(site);
    const context = await browser.newContext();
    try {
      const app = new TicketsPage(await context.newPage());
      await app.signIn(tech.token);
      await app.expectSynced();
      await cutOffApi(context);
      const titles = [unique('Queued one'), unique('Queued two')];
      for (const title of titles) await app.create(title, site);
      await expect(app.status).toContainText('2 pending');

      await app.page.reload();
      await expect(app.page.getByRole('heading', { name: 'Tickets' })).toBeVisible();
      for (const title of titles) await expect(app.ticket(title)).toBeVisible();
      await expect(app.status).toContainText('2 pending');

      await reconnectApi(context);
      await app.page.evaluate(() => window.dispatchEvent(new Event('online')));
      await app.expectSynced();
      for (const title of titles) {
        const { rows } = await db.query(`SELECT 1 FROM entities WHERE entity = 'ticket' AND data->>'title' = $1`, [
          title,
        ]);
        expect(rows).toHaveLength(1);
      }
    } finally {
      await context.close();
    }
  });

  test('lets two tabs of one user work at once without losing or repeating a change', async ({
    browser,
    world,
    db,
  }) => {
    const site = await world.site('Tabs');
    const tech = await world.technician(site);
    const context = await browser.newContext();
    try {
      const first = new TicketsPage(await context.newPage());
      await first.signIn(tech.token);
      await first.expectSynced();
      const second = new TicketsPage(await context.newPage());
      await second.open();
      const [a, b] = [unique('From the first tab'), unique('From the second tab')];
      await Promise.all([first.create(a, site), second.create(b, site)]);
      await first.expectSynced();
      await second.expectSynced();
      for (const page of [first, second]) {
        await expect(page.ticket(a)).toBeVisible();
        await expect(page.ticket(b)).toBeVisible();
      }
      const { rows } = await db.query<{ title: string }>(
        `SELECT data->>'title' AS title FROM entities WHERE entity = 'ticket' AND site_id = $1 ORDER BY 1`,
        [site],
      );
      expect(rows.map((r) => r.title)).toEqual([a, b].sort());
    } finally {
      await context.close();
    }
  });

  test('goes on in another tab when the leading tab crashes', async ({ browser, world, db }) => {
    const site = await world.site('Crash');
    const tech = await world.technician(site);
    const context = await browser.newContext();
    try {
      const leader = new TicketsPage(await context.newPage());
      await leader.signIn(tech.token);
      await leader.expectSynced();
      const follower = new TicketsPage(await context.newPage());
      await follower.open();
      await follower.expectSynced();

      // The renderer of the leading tab dies; the browser releases its lock.
      const cdp = await context.newCDPSession(leader.page);
      const crashed = leader.page.waitForEvent('crash');
      // The command never answers: the page it was sent to is gone.
      void cdp.send('Page.crash').catch(() => undefined);
      await crashed;

      const title = unique('After the crash');
      await follower.create(title, site);
      await follower.expectSynced();
      const { rows } = await db.query(`SELECT 1 FROM entities WHERE entity = 'ticket' AND data->>'title' = $1`, [
        title,
      ]);
      expect(rows).toHaveLength(1);
    } finally {
      await context.close();
    }
  });

  test('shows offline while the device is offline, and syncs as soon as it is back', async ({ browser, world, db }) => {
    const site = await world.site('Offline');
    const tech = await world.technician(site);
    const context = await browser.newContext();
    try {
      const app = new TicketsPage(await context.newPage());
      await app.signIn(tech.token);
      await app.expectSynced();
      await context.setOffline(true);
      const title = unique('Written offline');
      await app.create(title, site);
      await expect(app.status).toHaveText('offline · 1 pending');
      await context.setOffline(false);
      await app.expectSynced();
      const { rows } = await db.query(`SELECT 1 FROM entities WHERE entity = 'ticket' AND data->>'title' = $1`, [
        title,
      ]);
      expect(rows).toHaveLength(1);
    } finally {
      await context.close();
    }
  });

  test("moves the original client's id from localStorage into the database", async ({ browser, world, db }) => {
    const site = await world.site('Legacy');
    const tech = await world.technician(site);
    const legacyId = randomUUID();
    const context = await browser.newContext();
    try {
      // What the original app left in the browser: its token, its client id, its state.
      await context.addInitScript(
        ([token, id]) => {
          if (localStorage.getItem('migrated-test') !== null) return;
          localStorage.setItem('migrated-test', '1');
          localStorage.setItem('fs_token', token);
          localStorage.setItem('fs_client_id', id);
          localStorage.setItem('fs_state', JSON.stringify({ cursor: 0, lastMutationId: 0, base: {} }));
        },
        [tech.token, legacyId] as const,
      );
      const app = new TicketsPage(await context.newPage());
      await app.open();
      const title = unique('Under the old id');
      await app.create(title, site);
      await app.expectSynced();
      const { rows } = await db.query(`SELECT last_mutation_id FROM clients WHERE client_id = $1`, [legacyId]);
      expect(rows).toEqual([{ last_mutation_id: '1' }]);
      const left = await app.page.evaluate(() => [
        localStorage.getItem('fs_state'),
        localStorage.getItem('fs_client_id'),
      ]);
      expect(left).toEqual([null, null]);
    } finally {
      await context.close();
    }
  });
});
