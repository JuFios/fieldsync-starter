import { randomUUID } from 'node:crypto';
import { MUTATORS, type MutatorDef, type PushResponse } from '@fieldsync/sync-core';
import { Db } from '../../src/db';
import type { TestUser } from '../support/fixtures';
import { describeWithDb, useIntegration } from '../support/integration';

/**
 * Failure modes around the change log's head, which every writer takes last. Experiment
 * (chaos-engineering style): steady state = pushes succeed; inject a transaction that holds the head
 * and stops; expected = writers get 503 within the lock timeout instead of hanging, and recover once
 * Postgres ends the idle transaction.
 */
describeWithDb('stuck transactions', () => {
  const LOCK_TIMEOUT_MS = 300;
  const IDLE_TIMEOUT_MS = 1_500;
  const ctx = useIntegration({
    DB_LOCK_TIMEOUT_MS: String(LOCK_TIMEOUT_MS),
    DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: String(IDLE_TIMEOUT_MS),
    DB_STATEMENT_TIMEOUT_MS: '5000',
  });

  const create = (user: TestUser, site: string, clientId = randomUUID()) =>
    ctx.api.post<PushResponse>(
      '/sync/push',
      {
        clientId,
        mutations: [
          { id: 1, name: 'ticket.create', args: { id: randomUUID(), siteId: site, title: 'T', description: '' } },
        ],
      },
      user.token,
    );

  it('gives every server connection the configured timeouts', async () => {
    const { rows } = await ctx.server.app.get(Db).query<{ lock: string; statement: string; idle: string }>(
      `SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement,
                current_setting('idle_in_transaction_session_timeout') AS idle`,
    );
    expect(rows).toEqual([{ lock: '300ms', statement: '5s', idle: '1500ms' }]);
  });

  it('answers writers 503 while a transaction holds the log head, and recovers when Postgres ends it', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    expect((await create(tech, site)).status).toBe(201);

    // A server connection (with the server's settings) takes the head and then stops talking.
    const stuck = ctx.server.app.get(Db).dataSource.createQueryRunner();
    await stuck.connect();
    try {
      await stuck.startTransaction();
      await stuck.query('UPDATE log_head SET version = version WHERE id = 1');

      const started = Date.now();
      const blocked = await create(tech, site);
      const waited = Date.now() - started;
      expect({ status: blocked.status, retryAfter: blocked.headers['retry-after'] }).toEqual({
        status: 503,
        retryAfter: '1',
      });
      expect(blocked.body).toMatchObject({ code: 'TRANSIENT' });
      expect(waited).toBeLessThan(LOCK_TIMEOUT_MS + 1_000);

      // Postgres ends the idle session and rolls it back; writers get through again.
      const deadline = Date.now() + IDLE_TIMEOUT_MS + 5_000;
      let status = 0;
      while (Date.now() < deadline && status !== 201) {
        await new Promise((r) => setTimeout(r, 200));
        status = (await create(tech, site)).status;
      }
      expect(status).toBe(201);
    } finally {
      await stuck.release().catch(() => undefined);
    }
  }, 30_000);

  describe('a mutation that fails with a defect of the code', () => {
    const original: MutatorDef = MUTATORS['ticket.update'];
    afterEach(() => {
      MUTATORS['ticket.update'] = original;
    });

    it('is rejected as INTERNAL, and the mutations after it are applied', async () => {
      const site = await ctx.fixtures.site();
      const tech = await ctx.fixtures.technician(site);
      MUTATORS['ticket.update'] = {
        reads: (args) => original.reads(args),
        apply: () => {
          throw new TypeError('a defect');
        },
      };
      const ticket = randomUUID();
      const res = await ctx.api.post<PushResponse>(
        '/sync/push',
        {
          clientId: randomUUID(),
          mutations: [
            { id: 1, name: 'ticket.create', args: { id: ticket, siteId: site, title: 'T', description: '' } },
            { id: 2, name: 'ticket.update', args: { id: ticket, siteId: site, title: 'U' } },
            { id: 3, name: 'ticket.setStatus', args: { id: ticket, siteId: site, from: 'open', to: 'in_progress' } },
          ],
        },
        tech.token,
      );
      expect(res.body.results.map((r) => [r.id, r.status, r.status === 'rejected' ? r.code : undefined])).toEqual([
        [1, 'applied', undefined],
        [2, 'rejected', 'INTERNAL'],
        [3, 'applied', undefined],
      ]);
    });
  });
});
