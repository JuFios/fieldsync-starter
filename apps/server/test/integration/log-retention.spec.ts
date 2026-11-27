import { randomUUID } from 'node:crypto';
import type { Mutation, PushResponse } from '@fieldsync/sync-core';
import { precondition } from '@fieldsync/test-kit';
import { Clock } from '../../src/clock';
import { GcService } from '../../src/gc.service';
import type { TestUser } from '../support/fixtures';
import { describeWithDb, useIntegration } from '../support/integration';
import { rowsById, SyncClients } from '../support/sync-clients';

const DAY_MS = 86_400_000;
const LOG_RETENTION_DAYS = 7;
const RESULT_RETENTION_DAYS = 14;
/**
 * Far enough ahead that every log entry of this file is older than the retention, whatever the order
 * of the tests (one of them writes a week ahead by the server's clock).
 */
const PAST_EVERYTHING_DAYS = LOG_RETENTION_DAYS + 13;

/**
 * What the GC removes besides the log: tombstones of deletions it collected, results of applied
 * mutations with their changes, and results without a version (rejections) only after their own,
 * longer retention.
 */
describeWithDb('retention of tombstones and mutation results', () => {
  const ctx = useIntegration({
    CHANGELOG_RETENTION_SECONDS: String(LOG_RETENTION_DAYS * 86_400),
    MUTATION_RESULT_RETENTION_SECONDS: String(RESULT_RETENTION_DAYS * 86_400),
  });
  const clients = new SyncClients(ctx);

  afterEach(() => clients.disposeAll());

  const push = (user: TestUser, clientId: string, mutations: Mutation[]) =>
    ctx.api.post<PushResponse>('/sync/push', { clientId, mutations }, user.token);
  const create = (id: number, siteId: string, ticket: string, title: string): Mutation => ({
    id,
    name: 'ticket.create',
    args: { id: ticket, siteId, title, description: '' },
  });

  async function collectAfterDays(days: number) {
    const now = jest.spyOn(ctx.server.app.get(Clock), 'now').mockReturnValue(new Date(Date.now() + days * DAY_MS));
    try {
      return await ctx.server.app.get(GcService).collect();
    } finally {
      now.mockRestore();
    }
  }

  const tombstone = async (id: string) =>
    (await ctx.db.query(`SELECT 1 FROM entities WHERE id = $1 AND deleted`, [id])).rowCount ?? 0;

  it('keeps a tombstone, and so the id taken, while its deletion is in the log', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const client = randomUUID();
    const [old, recent] = [randomUUID(), randomUUID()];
    await push(tech, client, [create(1, site, old, 'deleted long ago')]);
    await push(tech, client, [{ id: 2, name: 'ticket.delete', args: { id: old, siteId: site } }]);
    // The second ticket is created and deleted a week later, by the server's clock.
    const later = jest.spyOn(ctx.server.app.get(Clock), 'now').mockReturnValue(new Date(Date.now() + 8 * DAY_MS));
    try {
      await push(tech, client, [create(3, site, recent, 'deleted recently')]);
      await push(tech, client, [{ id: 4, name: 'ticket.delete', args: { id: recent, siteId: site } }]);
    } finally {
      later.mockRestore();
    }

    // A day after that: the first deletion is older than the retention, the second is not.
    const run = await collectAfterDays(9);

    precondition(run.log > 0 && (await tombstone(old)) === 0, 'the old deletion was not collected');
    expect(await tombstone(recent)).toBe(1);
    const again = await push(tech, randomUUID(), [create(1, site, recent, 'same id')]);
    expect(again.body.results[0]).toMatchObject({ status: 'rejected', code: 'ID_CONFLICT' });
  });

  it('removes a tombstone with its deletion; a client that still holds the row is reset and drops it', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const ticket = randomUUID();
    const holder = await clients.create(tech);
    holder.mutate('ticket.create', { id: ticket, siteId: site, title: 'held', description: '' });
    await holder.sync();
    precondition(rowsById(holder, 'ticket').has(ticket), 'the holder does not have the ticket');
    await push(tech, randomUUID(), [{ id: 1, name: 'ticket.delete', args: { id: ticket, siteId: site } }]);

    const run = await collectAfterDays(PAST_EVERYTHING_DAYS);

    expect(run.tombstones).toBeGreaterThanOrEqual(1);
    expect(await tombstone(ticket)).toBe(0);
    await holder.sync();
    expect(rowsById(holder, 'ticket').has(ticket)).toBe(false);
    // The id is free again: a create under it is a new ticket (README, decision record 3.3.6).
    const reused = await push(tech, randomUUID(), [create(1, site, ticket, 'new ticket, old id')]);
    expect(reused.body.results[0]).toMatchObject({ status: 'applied' });
  });

  it('answers a copy of a rejected mutation with its reason after the log retention, until its own ends', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const client = randomUUID();
    const bad: Mutation = { id: 1, name: 'ticket.update', args: { id: randomUUID(), siteId: site, title: 'x' } };
    precondition((await push(tech, client, [bad])).body.results[0].status === 'rejected', 'not rejected');

    await collectAfterDays(LOG_RETENTION_DAYS + 1);
    const within = await push(tech, client, [bad]);
    expect(within.body.results[0]).toMatchObject({ status: 'rejected', code: 'NOT_FOUND' });

    const run = await collectAfterDays(RESULT_RETENTION_DAYS + 1);
    expect(run.results).toBeGreaterThanOrEqual(1);
    const after = await push(tech, client, [bad]);
    expect(after.body.results[0]).toEqual({ id: 1, status: 'duplicate' });
  });

  it('removes the result of an applied mutation with the change it made', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const client = randomUUID();
    const m = create(1, site, randomUUID(), 'applied');
    const first = await push(tech, client, [m]);
    precondition(first.body.results[0].status === 'applied', 'not applied');
    const version = first.body.results[0].status === 'applied' ? first.body.results[0].version : undefined;

    const kept = await push(tech, client, [m]);
    expect(kept.body.results[0]).toEqual({ id: 1, status: 'duplicate', version });

    await collectAfterDays(PAST_EVERYTHING_DAYS);
    const { rowCount } = await ctx.db.query(`SELECT 1 FROM mutation_results WHERE client_id = $1`, [client]);
    expect(rowCount).toBe(0);
    // Still never applied twice: the client's last mutation id is kept for good.
    const copy = await push(tech, client, [m]);
    expect(copy.body.results[0]).toEqual({ id: 1, status: 'duplicate' });
  });
});
