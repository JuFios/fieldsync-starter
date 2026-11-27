import { randomUUID } from 'node:crypto';
import type { Mutation, PushResponse } from '@fieldsync/sync-core';
import { precondition } from '@fieldsync/test-kit';
import { Clock } from '../../src/clock';
import { GcService } from '../../src/gc.service';
import type { TestUser } from '../support/fixtures';
import { describeWithDb, TEST_APPLICATION_NAME, useIntegration } from '../support/integration';
import { rowsById, SyncClients } from '../support/sync-clients';

const DAY_MS = 86_400_000;
/** The retention the test server runs with (the default, 7 days). */
const RETENTION_MS = 7 * DAY_MS;

/**
 * The change-log GC must never make a client lose changes silently (F-34): a client whose cursor
 * is behind the collected part of the log, and a client that starts after the GC, must end up with
 * every live entity, and the GC may only remove a prefix of the log.
 */
describeWithDb('change-log compaction', () => {
  const ctx = useIntegration();
  const clients = new SyncClients(ctx);

  afterEach(() => clients.disposeAll());

  const push = (user: TestUser, clientId: string, mutations: Mutation[]) =>
    ctx.api.post<PushResponse>('/sync/push', { clientId, mutations }, user.token);
  const create = (id: number, siteId: string, ticket: string, title: string): Mutation => ({
    id,
    name: 'ticket.create',
    args: { id: ticket, siteId, title, description: '' },
  });

  /** Runs the GC as it would run `ms` from now: everything written before now is older than the retention. */
  async function collectAt(ms: number): Promise<number> {
    const clock = ctx.server.app.get(Clock);
    const now = jest.spyOn(clock, 'now').mockReturnValue(new Date(Date.now() + ms));
    try {
      return (await ctx.server.app.get(GcService).collect()).log;
    } finally {
      now.mockRestore();
    }
  }

  it('brings a client that was offline longer than the retention up to date, queue included', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const offline = await clients.create(tech);
    await offline.sync();

    // While it is offline, someone else creates and edits a ticket, and its own user queues a ticket.
    const theirs = randomUUID();
    const writer = randomUUID();
    await push(tech, writer, [create(1, site, theirs, 'written while offline')]);
    await push(tech, writer, [
      { id: 2, name: 'ticket.update', args: { id: theirs, siteId: site, title: 'edited while offline' } },
    ]);
    precondition((await collectAt(RETENTION_MS + DAY_MS)) > 0, 'the GC removed nothing');
    const mine = randomUUID();
    offline.mutate('ticket.create', { id: mine, siteId: site, title: 'queued offline', description: '' });

    await offline.sync();

    const tickets = rowsById(offline, 'ticket');
    expect(tickets.get(theirs)?.title).toBe('edited while offline');
    expect(tickets.get(mine)?.title).toBe('queued offline');
    expect(offline.pendingCount).toBe(0);
    const stored = await ctx.db.query(`SELECT 1 FROM entities WHERE entity = 'ticket' AND id = $1`, [mine]);
    expect(stored.rowCount).toBe(1);
  });

  it('gives a client that starts after the GC every live entity of its sites', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const ticket = randomUUID();
    await push(tech, randomUUID(), [create(1, site, ticket, 'created before the GC')]);
    precondition((await collectAt(RETENTION_MS + DAY_MS)) > 0, 'the GC removed nothing');

    const fresh = await clients.create(tech);
    await fresh.sync();

    expect(rowsById(fresh, 'ticket').get(ticket)?.title).toBe('created before the GC');
  });

  it('removes only a prefix of the log, even when a later version carries an earlier timestamp', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const clock = ctx.server.app.get(Clock);
    const t0 = Date.now();
    // The slow mutation reads the clock first (t0 - 60 s, as a server with a slower clock would),
    // then waits on a row the test holds, while the fast one reads t0 and commits first.
    const now = jest.spyOn(clock, 'now').mockReturnValue(new Date(t0 - 60_000));
    let fastVersion: number | undefined;
    const blocker = await ctx.db.connect();
    try {
      const slowTicket = randomUUID();
      await blocker.query('BEGIN');
      await blocker.query(
        `INSERT INTO entities (entity, id, site_id, data, deleted, version) VALUES ('ticket', $1, $2, '{}', false, 0)`,
        [slowTicket, site],
      );
      const slow = push(tech, randomUUID(), [create(1, site, slowTicket, 'slow')]);
      await untilServerWaitsForALock();
      now.mockReturnValue(new Date(t0));
      const fast = await push(tech, randomUUID(), [create(1, site, randomUUID(), 'fast')]);
      precondition(fast.body.results[0]?.status === 'applied', `fast: ${JSON.stringify(fast.body)}`);
      await blocker.query('ROLLBACK');
      const slowRes = await slow;
      precondition(slowRes.body.results[0]?.status === 'applied', `slow: ${JSON.stringify(slowRes.body)}`);
      fastVersion = fast.body.results[0]?.status === 'applied' ? fast.body.results[0].version : undefined;
      const slowVersion = slowRes.body.results[0]?.status === 'applied' ? slowRes.body.results[0].version : undefined;
      precondition(
        fastVersion !== undefined && slowVersion !== undefined && fastVersion < slowVersion,
        `versions: fast ${String(fastVersion)}, slow ${String(slowVersion)}`,
      );

      // Collect everything older than t0 - 30 s: the slow change is, the earlier fast change is not.
      now.mockReturnValue(new Date(t0 - 30_000 + RETENTION_MS));
      await ctx.server.app.get(GcService).collect();
    } finally {
      now.mockRestore();
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }

    const { rows } = await ctx.db.query<{ version: string }>(`SELECT version FROM change_log ORDER BY version`);
    const kept = rows.map((r) => Number(r.version));
    const head = await ctx.db.query<{ version: string }>(`SELECT version FROM log_head`);
    const first = kept[0] ?? Number(head.rows[0].version) + 1;
    // What is left is every version from the first kept one up to the head, without holes, and the
    // change within the retention is among it.
    expect(kept).toEqual(Array.from({ length: Number(head.rows[0].version) - first + 1 }, (_, i) => first + i));
    expect(kept).toContain(fastVersion);
  });

  /** Waits until a server connection waits for a lock held by another transaction. */
  async function untilServerWaitsForALock(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const { rowCount } = await ctx.db.query(
        `SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND application_name <> $1 AND wait_event_type = 'Lock'`,
        [TEST_APPLICATION_NAME],
      );
      if ((rowCount ?? 0) > 0) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('the server never waited for the lock');
  }
});
