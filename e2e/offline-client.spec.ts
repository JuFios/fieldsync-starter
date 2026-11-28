import { createHash, randomUUID } from 'node:crypto';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './support/world';
import { TicketsPage } from './support/tickets-page';

const API = new URL(process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').origin;
const unique = (label: string) => `${label} ${randomUUID().slice(0, 8)}`;

/** Makes the API unreachable for the context (the web app itself still loads). */
const cutOffApi = (context: BrowserContext) =>
  context.route(`${API}/**`, (route) => route.abort('internetdisconnected'));
const reconnectApi = (context: BrowserContext) => context.unroute(`${API}/**`);

/** In a tab of this init script, the app asks for the local schema after the one it knows. */
const raiseLocalSchemaVersion = () => {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called with its factory below
  const open = IDBFactory.prototype.open;
  IDBFactory.prototype.open = function (this: IDBFactory, name: string, version?: number) {
    const raised = version !== undefined && name.startsWith('fieldsync-') ? version + 1 : version;
    return open.call(this, name, raised);
  };
};

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

  test('asks to close the tab that keeps an older local schema open, and goes on once it is closed', async ({
    browser,
    world,
    db,
  }) => {
    const site = await world.site('Blocked');
    const tech = await world.technician(site);
    // The user's database (`databaseNameFor`): named after the SHA-256 of the token.
    const database = `fieldsync-${createHash('sha256').update(tech.token).digest('hex')}`;
    const context = await browser.newContext();
    const versionOf = (page: Page) =>
      page.evaluate(
        async (name) => (await indexedDB.databases()).find((found) => found.name === name)?.version,
        database,
      );
    try {
      // Today's app creates the database, and a change made without the server waits in its queue.
      const today = new TicketsPage(await context.newPage());
      await today.signIn(tech.token);
      await today.expectSynced();
      await cutOffApi(context);
      const title = unique('Queued before the update');
      await today.create(title, site);
      await expect(today.status).toContainText('1 pending');
      await today.page.close();
      await reconnectApi(context);

      // A tab of an older app that does not close: a connection without a `versionchange` handler, on
      // an empty page of the same origin.
      const holder = await context.newPage();
      await holder.route('**/older-app', (route) => route.fulfill({ contentType: 'text/html', body: '<p></p>' }));
      await holder.goto('/older-app');
      await holder.evaluate(
        (name) =>
          new Promise<void>((resolve, reject) => {
            const request = indexedDB.open(name);
            request.onsuccess = () => {
              Object.assign(window, { held: request.result });
              resolve();
            };
            request.onerror = () => reject(new Error(String(request.error)));
          }),
        database,
      );

      // The next release. The browser sends `blocked` only to an open that raises the version, and no
      // release has raised the local schema yet, so in this tab the test raises the version the app
      // asks for by one. Everything else is the app and the browser as they are.
      const next = new TicketsPage(await context.newPage());
      await next.page.addInitScript(raiseLocalSchemaVersion);
      await next.page.goto('/');
      // Next.js has an alert of its own (its route announcer), so the notice is found by its text.
      const notice = next.page.getByRole('alert').filter({ hasText: 'FieldSync' });
      await expect(notice).toHaveText('FieldSync is open in another tab with an older version. Close it to continue.');
      await expect(next.page.getByRole('heading', { name: 'Tickets' })).toBeHidden();
      // The open waits: the database is still the old one.
      expect(await versionOf(holder)).toBe(1);

      await holder.close();

      await expect(next.page.getByRole('heading', { name: 'Tickets' })).toBeVisible();
      await expect(notice).toHaveCount(0);
      expect(await versionOf(next.page)).toBe(2);
      // The queue came through the upgrade and reaches the server once.
      await expect(next.ticket(title)).toBeVisible();
      await next.expectSynced();
      const { rows } = await db.query(`SELECT 1 FROM entities WHERE entity = 'ticket' AND data->>'title' = $1`, [
        title,
      ]);
      expect(rows).toHaveLength(1);
    } finally {
      await context.close();
    }
  });

  test('lets the tab of a newer local schema sync while the replaced tab is still open', async ({
    browser,
    world,
  }) => {
    const site = await world.site('Superseded');
    const tech = await world.technician(site);
    const context = await browser.newContext();
    try {
      const today = new TicketsPage(await context.newPage());
      await today.signIn(tech.token);
      await today.expectSynced();

      // The next release: in this tab the app asks for the next local schema (see the test above).
      const next = new TicketsPage(await context.newPage());
      await next.page.addInitScript(raiseLocalSchemaVersion);
      await next.open();
      await expect(today.page.getByRole('alert').filter({ hasText: 'FieldSync' })).toHaveText(
        'A newer version of FieldSync is open in another tab. Reload this page to continue.',
      );

      // The replaced tab stays open: it must not keep the lead, or nothing is ever sent.
      await next.create(unique('Sent by the newer app'), site);
      await next.expectSynced();
    } finally {
      await context.close();
    }
  });

  test('keeps what the user typed when the browser refuses to store it, so it can be saved again', async ({
    browser,
    world,
    db,
  }) => {
    const site = await world.site('Quota');
    const tech = await world.technician(site);
    const context = await browser.newContext();
    try {
      // A full quota: while the flag is set, the browser refuses to add to the queue.
      await context.addInitScript(() => {
        // eslint-disable-next-line @typescript-eslint/unbound-method -- called with its store below
        const add = IDBObjectStore.prototype.add;
        IDBObjectStore.prototype.add = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
          if (this.name === 'pending' && sessionStorage.getItem('storage-full') !== null) {
            throw new DOMException('full', 'QuotaExceededError');
          }
          return add.call(this, value, key);
        };
      });
      const app = new TicketsPage(await context.newPage());
      await app.signIn(tech.token);
      await app.expectSynced();
      const full = (on: boolean) =>
        app.page.evaluate((set) => {
          if (set) sessionStorage.setItem('storage-full', '1');
          else sessionStorage.removeItem('storage-full');
        }, on);

      const title = unique('Typed while full');
      const newTitle = app.page.getByPlaceholder('New ticket title');
      await full(true);
      await newTitle.fill(title);
      await app.page.locator('form input').nth(1).fill(site);
      await app.page.getByRole('button', { name: 'Create' }).click();
      await expect(app.status).toContainText('cannot save on this device');
      await expect(newTitle).toHaveValue(title);
      await full(false);
      await app.page.getByRole('button', { name: 'Create' }).click();
      await expect(app.ticket(title)).toBeVisible();
      await expect(newTitle).toHaveValue('');
      await app.expectSynced();

      await app.ticket(title).click();
      const edited = unique('Edited while full');
      // The title field has no label in this version of the UI: it is the page's first field.
      const titleField = app.page.locator('input').first();
      await expect(titleField).toHaveValue(title);
      await full(true);
      await titleField.fill(edited);
      await app.page.getByRole('button', { name: 'Save' }).click();
      await expect(app.status).toContainText('cannot save on this device');
      await full(false);
      await app.page.getByRole('button', { name: 'Save' }).click();
      await expect(app.page.getByRole('heading', { name: edited })).toBeVisible();
      await app.expectSynced();
      const { rows } = await db.query(`SELECT 1 FROM entities WHERE entity = 'ticket' AND data->>'title' = $1`, [
        edited,
      ]);
      expect(rows).toHaveLength(1);
    } finally {
      await context.close();
    }
  });

  test('offers to sign out only once it knows what is not synced yet', async ({ browser, world }) => {
    const site = await world.site('Opening');
    const tech = await world.technician(site);
    const context = await browser.newContext();
    try {
      // Holds the app while it opens: the stored state is loaded only once its leader lock is answered.
      await context.addInitScript((token) => {
        localStorage.setItem('fs_token', token);
        // eslint-disable-next-line @typescript-eslint/unbound-method -- applied to its manager below
        const request = LockManager.prototype.request;
        const held = new Promise<void>((release) => Object.assign(window, { releaseLocks: release }));
        LockManager.prototype.request = function (this: LockManager, ...args: unknown[]) {
          return held.then(() => Reflect.apply(request, this, args) as Promise<unknown>);
        } as typeof request;
      }, tech.token);
      const page = await context.newPage();
      await page.goto('/');
      const signOut = page.getByRole('button', { name: 'Sign out' });
      await expect(signOut).toBeDisabled();
      await page.evaluate(() => (window as unknown as { releaseLocks(): void }).releaseLocks());
      await expect(signOut).toBeEnabled();
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
