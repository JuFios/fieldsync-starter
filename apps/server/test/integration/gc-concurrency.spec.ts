import { randomUUID } from 'node:crypto';
import { asMutationId } from '@fieldsync/sync-core';
import type { Mutation, PullResponse, PushResponse, Row, SnapshotPage } from '@fieldsync/sync-core';
import { precondition } from '@fieldsync/test-kit';
import { Clock } from '../../src/clock';
import { GcService, type GcRun } from '../../src/gc.service';
import { startApp, type RunningApp } from '../support/app';
import type { TestUser } from '../support/fixtures';
import type { Api } from '../support/http';
import { describeWithDb, TEST_APPLICATION_NAME, useIntegration } from '../support/integration';

const DAY_MS = 86_400_000;

/**
 * Experiments on the GC next to live traffic, each with one injected condition: a second server
 * instance collecting while the first serves writers and readers, two collectors at once, the
 * collector's session killed in the middle of a batch, the application shutting down in the middle
 * of a run, and a snapshot that is slow but younger than the retention. Steady state everywhere:
 * no change is skipped, every reader that is reset converges again, and the log that is kept is a
 * contiguous range ending at the head.
 */
describeWithDb('change-log GC under concurrency and failures', () => {
  const ctx = useIntegration({ GC_BATCH_SIZE: '100' });
  const extra: RunningApp[] = [];

  afterEach(async () => {
    await Promise.all(extra.splice(0).map((a) => a.close()));
  });

  /** Another server instance on the same database, whose clock runs `aheadMs` in the future. */
  async function instance(aheadMs: number): Promise<RunningApp> {
    const app = await startApp(ctx.database.url, { GC_BATCH_SIZE: '100' });
    extra.push(app);
    jest.spyOn(app.app.get(Clock), 'now').mockImplementation(() => new Date(Date.now() + aheadMs));
    return app;
  }

  const push = (api: Api, user: TestUser, clientId: string, mutations: Mutation[]) =>
    api.post<PushResponse>('/sync/push', { clientId, mutations }, user.token);
  const create = (id: number, siteId: string, title: string): Mutation => ({
    id: asMutationId(id),
    name: 'ticket.create',
    args: { id: randomUUID(), siteId, title, description: '' },
  });

  /**
   * Collects the whole log, as a GC far in the future would, so that what a test appends next is the
   * oldest part of the log whatever earlier tests left behind.
   */
  async function drainLog(): Promise<void> {
    const app = await instance(365 * DAY_MS);
    await app.app.get(GcService).collect();
    precondition(
      (await ctx.db.query('SELECT 1 FROM change_log LIMIT 1')).rowCount === 0,
      'the log is not empty after collecting it',
    );
  }

  /** Appends `n` log entries written `ageDays` ago, with versions from the head, as writers do. */
  async function oldEntries(site: string, n: number, ageDays: number): Promise<void> {
    await ctx.db.query(
      `WITH head AS (UPDATE log_head SET version = version + $2 WHERE id = 1 RETURNING version)
       INSERT INTO change_log (version, site_id, entity, entity_id, op, data, created_at)
       SELECT head.version - $2 + g, $1, 'ticket', gen_random_uuid(), 'put', '{}', now() - $3::interval
         FROM head, generate_series(1, $2) g`,
      [site, n, `${ageDays} days`],
    );
  }

  /** The kept log is every version after the floor up to the head, without holes. */
  async function expectContiguousLog(): Promise<void> {
    const { rows } = await ctx.db.query<{ floor: string; head: string; n: string; min: string | null }>(
      `SELECT f.version AS floor, h.version AS head, count(c.version) AS n, min(c.version) AS min
         FROM log_floor f, log_head h LEFT JOIN change_log c ON true GROUP BY f.version, h.version`,
    );
    const { floor, head, n, min } = rows[0];
    expect({ kept: Number(n), first: min === null ? null : Number(min) }).toEqual({
      kept: Number(head) - Number(floor),
      first: Number(head) > Number(floor) ? Number(floor) + 1 : null,
    });
  }

  /** A client's state from scratch: a snapshot, then the log from its watermark. */
  async function reload(api: Api, user: TestUser): Promise<{ state: Map<string, Row>; cursor: number }> {
    const state = new Map<string, Row>();
    let page = await api.get<SnapshotPage>('/sync/snapshot', user.token);
    const { watermark } = page.body;
    for (;;) {
      for (const r of page.body.rows) state.set(`${r.entity}/${r.id}`, r.data);
      const next = page.body.next;
      if (next === null) break;
      page = await api.get<SnapshotPage>(
        `/sync/snapshot?watermark=${watermark}&afterSite=${next.siteId}&afterEntity=${next.entity}&afterId=${next.id}`,
        user.token,
      );
    }
    return { state, cursor: watermark };
  }

  it('loses no change for readers while another instance collects the log as fast as it can', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    // Its clock is a retention ahead, so for it every change is old: the floor chases the head.
    const collector = await instance(8 * DAY_MS);
    let running = true;
    const gc = (async () => {
      const runs: GcRun[] = [];
      while (running) runs.push(await collector.app.get(GcService).collect());
      return runs;
    })();
    const writers = Array.from({ length: 4 }, async (_, w) => {
      const clientId = randomUUID();
      const statuses: number[] = [];
      for (let id = 1; id <= 40; id += 1) {
        statuses.push((await push(ctx.api, tech, clientId, [create(id, site, `w${w} ${id}`)])).status);
      }
      return statuses;
    });
    const readers = Array.from({ length: 3 }, async () => {
      let { state, cursor } = await reload(ctx.api, tech);
      let resets = 0;
      let done = false;
      const step = async () => {
        const res = await ctx.api.get<PullResponse>(`/sync/pull?cursor=${cursor}`, tech.token);
        if (res.status === 410) {
          resets += 1;
          ({ state, cursor } = await reload(ctx.api, tech));
          return;
        }
        precondition(res.status === 200, `pull answered ${res.status}`);
        for (const c of res.body.changes) {
          if (c.op === 'put' && c.data) state.set(`${c.entity}/${c.id}`, c.data);
          else state.delete(`${c.entity}/${c.id}`);
        }
        cursor = res.body.nextCursor;
      };
      while (!done) {
        await step();
        done = !running;
      }
      return { finish: step, get: () => ({ state, resets }) };
    });
    const statuses = (await Promise.all(writers)).flat();
    running = false;
    const runs = await gc;
    const finished = await Promise.all(readers);

    expect(new Set(statuses)).toEqual(new Set([201]));
    const { rows } = await ctx.db.query<{ entity: string; id: string; data: Row }>(
      `SELECT entity, id, data FROM entities WHERE NOT deleted AND site_id = $1`,
      [site],
    );
    const expected = new Map(rows.map((r) => [`${r.entity}/${r.id}`, r.data]));
    for (const reader of finished) {
      // Catch up with the last writes (or reload once more if they were collected meanwhile).
      for (let i = 0; i < 3; i += 1) await reader.finish();
      expect(reader.get().state).toEqual(expected);
    }
    expect(runs.reduce((sum, r) => sum + r.log, 0)).toBeGreaterThan(0);
    await expectContiguousLog();
  }, 60_000);

  it('lets two collectors run at once: one removes, the other skips or follows, and nothing is lost', async () => {
    const site = await ctx.fixtures.site();
    await drainLog();
    await oldEntries(site, 2_000, 30);
    const before = await ctx.db.query<{ n: string }>('SELECT count(*) AS n FROM change_log');
    const [a, b] = [await instance(0), await instance(0)];

    const runs = await Promise.all([a.app.get(GcService).collect(), b.app.get(GcService).collect()]);

    const removed = runs.reduce((sum, r) => sum + r.log, 0);
    const after = await ctx.db.query<{ n: string }>('SELECT count(*) AS n FROM change_log');
    expect(removed).toBe(Number(before.rows[0].n) - Number(after.rows[0].n));
    expect(removed).toBeGreaterThanOrEqual(2_000);
    await expectContiguousLog();
  });

  it('keeps the log and its floor as they were when the collector is killed in the middle of a batch', async () => {
    const site = await ctx.fixtures.site();
    await drainLog();
    await oldEntries(site, 50, 30);
    const floorBefore = await ctx.db.query<{ version: string }>('SELECT version FROM log_floor');
    const target = Number(floorBefore.rows[0].version) + 1;
    const blocker = await ctx.db.connect();
    try {
      await blocker.query('BEGIN');
      // A reader holds the first row of the next batch, so the batch waits inside its DELETE.
      await blocker.query('SELECT version FROM change_log WHERE version = $1 FOR UPDATE', [target]);
      const run = ctx.server.app.get(GcService).collect();
      let pid: number | undefined;
      for (let i = 0; i < 200 && pid === undefined; i += 1) {
        const { rows } = await ctx.db.query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity
            WHERE datname = current_database() AND application_name <> $1
              AND wait_event_type = 'Lock' AND query LIKE '%DELETE FROM change_log%'`,
          [TEST_APPLICATION_NAME],
        );
        pid = rows[0]?.pid;
        if (pid === undefined) await new Promise((r) => setTimeout(r, 10));
      }
      precondition(pid !== undefined, 'the GC never waited inside its batch');
      await ctx.db.query('SELECT pg_terminate_backend($1)', [pid]);
      await expect(run).rejects.toThrow();
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    const floorAfter = await ctx.db.query<{ version: string }>('SELECT version FROM log_floor');
    expect(floorAfter.rows[0].version).toBe(floorBefore.rows[0].version);
    const kept = await ctx.db.query('SELECT 1 FROM change_log WHERE version = $1', [target]);
    expect(kept.rowCount).toBe(1);
    await expectContiguousLog();

    // The next run completes the work.
    const again = await ctx.server.app.get(GcService).collect();
    expect(again.log).toBeGreaterThanOrEqual(50);
    await expectContiguousLog();
  });

  it('shuts down after the batch in progress, leaving a consistent floor', async () => {
    const site = await ctx.fixtures.site();
    await drainLog();
    await oldEntries(site, 3_000, 30);
    const before = await ctx.db.query<{ version: string }>('SELECT version FROM log_floor');
    const app = await instance(0);
    const run = app.app.get(GcService).collect();
    extra.splice(extra.indexOf(app), 1);
    // The pool closes only after the GC stopped: the run ends without a "pool is closed" error.
    await app.close();
    const result = await run;
    // It stopped between batches (or finished): the floor is the end of its last batch.
    const { rows } = await ctx.db.query<{ version: string }>('SELECT version FROM log_floor');
    expect(rows[0].version).toBe(result.log > 0 ? String(result.floor) : before.rows[0].version);
    await expectContiguousLog();
  });

  it('never resets a snapshot younger than the retention, however long it takes', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const client = randomUUID();
    await drainLog();
    await oldEntries(site, 200, 30);
    for (let id = 1; id <= 5; id += 1) await push(ctx.api, tech, client, [create(id, site, `t${id}`)]);
    const first = await ctx.api.get<SnapshotPage>('/sync/snapshot?limit=1', tech.token);
    precondition(first.body.next !== null, 'the snapshot has one page only');
    // While the client reads slowly, the GC runs: it removes the old changes, never the recent ones.
    for (let id = 6; id <= 8; id += 1) await push(ctx.api, tech, client, [create(id, site, `t${id}`)]);
    const run = await ctx.server.app.get(GcService).collect();
    expect(run.log).toBeGreaterThanOrEqual(200);
    let page = first;
    while (page.body.next !== null) {
      const n = page.body.next;
      page = await ctx.api.get<SnapshotPage>(
        `/sync/snapshot?watermark=${first.body.watermark}&afterSite=${n.siteId}&afterEntity=${n.entity}&afterId=${n.id}&limit=1`,
        tech.token,
      );
      expect(page.status).toBe(200);
    }
    const tail = await ctx.api.get<PullResponse>(`/sync/pull?cursor=${first.body.watermark}`, tech.token);
    expect(tail.status).toBe(200);
    expect(tail.body.changes.map((c) => c.data?.title)).toEqual(['t6', 't7', 't8']);
  });
});
