import { randomUUID } from 'node:crypto';
import { Db } from '../../src/db';
import { describeWithDb, terminateServerConnections, useIntegration } from '../support/integration';

describeWithDb('Db.tx', () => {
  const ctx = useIntegration();
  const db = () => ctx.server.app.get(Db);

  async function siteExists(id: string): Promise<boolean> {
    const { rowCount } = await ctx.db.query('SELECT 1 FROM sites WHERE id = $1', [id]);
    return rowCount === 1;
  }

  it('commits the callback and returns its result', async () => {
    const id = randomUUID();
    const result = await db().tx(async (c) => {
      await c.query(`INSERT INTO sites (id, name) VALUES ($1, 'committed')`, [id]);
      return 'done';
    });
    expect(result).toBe('done');
    expect(await siteExists(id)).toBe(true);
  });

  it('rolls back and rethrows the error of a failing callback', async () => {
    const id = randomUUID();
    const original = new Error('mutation failed');
    await expect(
      db().tx(async (c) => {
        await c.query(`INSERT INTO sites (id, name) VALUES ($1, 'rolled back')`, [id]);
        throw original;
      }),
    ).rejects.toBe(original);
    expect(await siteExists(id)).toBe(false);
  });

  it('reports the original error when the rollback after it fails', async () => {
    const original = new Error('mutation failed');
    const result = db().tx(async (c) => {
      await c.query('SELECT 1');
      expect(await terminateServerConnections(ctx, 'idle in transaction')).toBe(1);
      throw original;
    });
    await expect(result).rejects.toBe(original);

    // The broken connection must not be handed out again.
    const tech = await ctx.fixtures.technician(await ctx.fixtures.site());
    for (let i = 0; i < 5; i += 1) expect((await ctx.api.get('/me', tech.token)).status).toBe(200);
  });

  describe('savepoint', () => {
    it("undoes only the savepoint's statements, releases their row locks, and commits the rest", async () => {
      const kept = randomUUID();
      const undone = randomUUID();
      const locked = await ctx.fixtures.site('Locked');
      await db().tx(async (c) => {
        await c.query(`INSERT INTO sites (id, name) VALUES ($1, 'kept')`, [kept]);
        await c
          .savepoint(async () => {
            await c.query(`INSERT INTO sites (id, name) VALUES ($1, 'undone')`, [undone]);
            await c.query(`SELECT 1 FROM sites WHERE id = $1 FOR UPDATE`, [locked]);
            throw new Error('rejected');
          })
          .catch(() => undefined);
        // The row lock taken inside the savepoint is gone: another connection can take it at once.
        const other = await ctx.db.connect();
        try {
          await other.query('BEGIN');
          await other.query(`SET LOCAL lock_timeout = '1s'`);
          await other.query(`SELECT 1 FROM sites WHERE id = $1 FOR UPDATE`, [locked]);
          await other.query('ROLLBACK');
        } finally {
          other.release();
        }
      });
      expect([await siteExists(kept), await siteExists(undone)]).toEqual([true, false]);
    });

    it('keeps a statement that failed inside the savepoint from aborting the transaction', async () => {
      const kept = randomUUID();
      await db().tx(async (c) => {
        await c.savepoint(() => c.query(`SELECT 1 / 0`)).catch(() => undefined);
        await c.query(`INSERT INTO sites (id, name) VALUES ($1, 'after a failed statement')`, [kept]);
      });
      expect(await siteExists(kept)).toBe(true);
    });
  });
});
