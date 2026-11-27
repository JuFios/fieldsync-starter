import { randomUUID } from 'node:crypto';
import type { PushResponse } from '@fieldsync/sync-core';
import { describeWithDb, useIntegration } from '../support/integration';

/**
 * Write throughput of the push path on a real Postgres: CLIENTS clients push one mutation at a time,
 * all at once, until MUTATIONS mutations are applied. Every mutation is a ticket create, so writers
 * share nothing but what every commit takes (the change log's ordering). Prints one JSON line with
 * the results; checks only that every write arrived, in CI as well as locally. The README records
 * the numbers and the threshold (`npm run test:bench`, see "Change-log ordering" there).
 */
const CLIENTS = Number(process.env.BENCH_CLIENTS ?? 16);
const MUTATIONS = Number(process.env.BENCH_MUTATIONS ?? 2000);
const WARMUP = 200;

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

describeWithDb('push throughput', () => {
  const ctx = useIntegration();

  async function run(total: number, siteId: string, token: string): Promise<{ ms: number; latencies: number[] }> {
    const latencies: number[] = [];
    let issued = 0;
    const started = performance.now();
    await Promise.all(
      Array.from({ length: CLIENTS }, async () => {
        const clientId = randomUUID();
        for (let id = 1; issued < total; id += 1) {
          issued += 1;
          const mutation = {
            id,
            name: 'ticket.create',
            args: { id: randomUUID(), siteId, title: 'T', description: '' },
          };
          const t0 = performance.now();
          const res = await ctx.api.post<PushResponse>('/sync/push', { clientId, mutations: [mutation] }, token);
          latencies.push(performance.now() - t0);
          if (res.status !== 201 || res.body.results[0]?.status !== 'applied') {
            throw new Error(`push answered ${res.status}: ${JSON.stringify(res.body)}`);
          }
        }
      }),
    );
    return { ms: performance.now() - started, latencies };
  }

  it(`applies ${MUTATIONS} mutations from ${CLIENTS} concurrent clients and reports the throughput`, async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    await run(WARMUP, site, tech.token);
    const { ms, latencies } = await run(MUTATIONS, site, tech.token);
    const sorted = [...latencies].sort((a, b) => a - b);
    const report = {
      clients: CLIENTS,
      mutations: latencies.length,
      perSecond: Math.round((latencies.length / ms) * 1000),
      p50Ms: Number(percentile(sorted, 50).toFixed(1)),
      p95Ms: Number(percentile(sorted, 95).toFixed(1)),
      p99Ms: Number(percentile(sorted, 99).toFixed(1)),
    };
    // The log head is one row updated by every mutation: its updates should stay HOT (in-page,
    // no index update). Statistics reach pg_stat_user_tables within a second of the writers idling.
    await new Promise((r) => setTimeout(r, 1_500));
    const stats = await ctx.db.query<{ upd: string; hot: string }>(
      `SELECT n_tup_upd AS upd, n_tup_hot_upd AS hot FROM pg_stat_user_tables WHERE relname = 'log_head'`,
    );
    const head = stats.rows[0];
    const logHeadHotUpdates = head && Number(head.upd) > 0 ? Number(head.hot) / Number(head.upd) : null;
    process.stdout.write(`BENCH ${JSON.stringify({ ...report, logHeadHotUpdates })}\n`);

    const { rows } = await ctx.db.query<{ n: string; distinct: string }>(
      `SELECT count(*) AS n, count(DISTINCT version) AS distinct FROM change_log`,
    );
    expect(rows[0]).toEqual({ n: String(WARMUP + latencies.length), distinct: String(WARMUP + latencies.length) });
  }, 600_000);
});
