import { expect, type Locator, type Page } from '@playwright/test';

/** The ticket list of the web app, as a user sees it. */
export class TicketsPage {
  readonly status: Locator;

  constructor(readonly page: Page) {
    this.status = page.getByRole('status');
  }

  async signIn(token: string): Promise<void> {
    await this.page.goto('/');
    await this.page.getByPlaceholder('token').fill(token);
    await this.page.getByRole('button', { name: 'Sign in' }).click();
    await expect(this.page.getByRole('heading', { name: 'Tickets' })).toBeVisible();
  }

  /** Opens the app of a user who is signed in already (the token is in the browser). */
  async open(): Promise<void> {
    await this.page.goto('/');
    await expect(this.page.getByRole('heading', { name: 'Tickets' })).toBeVisible();
  }

  async create(title: string, siteId: string): Promise<void> {
    await this.page.getByPlaceholder('New ticket title').fill(title);
    // The site field has no label in this version of the UI (the frontend work adds one).
    await this.page.locator('form input').nth(1).fill(siteId);
    await this.page.getByRole('button', { name: 'Create' }).click();
    await expect(this.ticket(title)).toBeVisible();
  }

  ticket(title: string): Locator {
    return this.page.getByRole('link', { name: title });
  }

  async expectSynced(): Promise<void> {
    await expect(this.status).toHaveText('synced · 0 pending', { timeout: 20_000 });
  }
}
