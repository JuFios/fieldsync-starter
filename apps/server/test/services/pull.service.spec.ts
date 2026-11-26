import { Test } from '@nestjs/testing';
import { Db } from '../../src/db';
import { PullService } from '../../src/pull.service';
import { mockDb, result, type MockDb } from './support';

const TECH = { id: 'user-1', role: 'technician' as const };
const NORTH = '00000000-0000-4000-8000-0000000000a1';

function logRow(version: number) {
  return {
    version: String(version),
    site_id: NORTH,
    entity: 'ticket' as const,
    entity_id: `t${version}`,
    op: 'put' as const,
    data: { title: `T${version}` },
  };
}

/**
 * Which sites are filtered at which cursor is not checked here: the incremental pull returns other
 * sites' changes (F-07, a known defect of the access-control work, tested on Postgres).
 */
describe('PullService', () => {
  let pull: PullService;
  let db: MockDb;
  let log: ReturnType<typeof logRow>[];
  let head: number;
  let lastMutationId: number | undefined;

  beforeEach(async () => {
    db = mockDb();
    log = [];
    head = 0;
    lastMutationId = undefined;
    db.inTx.query.mockImplementation((sql, params) => {
      if (sql.includes('FROM log_head')) return Promise.resolve(result([{ version: String(head) }]));
      if (sql.includes('FROM user_sites')) return Promise.resolve(result([{ site_id: NORTH }]));
      if (sql.includes('FROM change_log')) {
        const [after, upTo, , take] = params as [number, number, unknown, number];
        const v = (r: ReturnType<typeof logRow>) => Number(r.version);
        return Promise.resolve(result(log.filter((r) => v(r) > after && v(r) <= upTo).slice(0, take)));
      }
      if (sql.includes('FROM clients')) {
        return Promise.resolve(
          result(lastMutationId === undefined ? [] : [{ last_mutation_id: String(lastMutationId) }]),
        );
      }
      return Promise.reject(new Error(`unexpected query: ${sql}`));
    });
    const moduleRef = await Test.createTestingModule({
      providers: [PullService, { provide: Db, useValue: db }],
    }).compile();
    pull = moduleRef.get(PullService);
  });

  /** A log whose head is its last row, as committed writers leave it. */
  function logOf(...versions: number[]) {
    log = versions.map(logRow);
    head = Math.max(0, ...versions);
  }

  const logQuery = () => db.inTx.query.mock.calls.find(([sql]) => sql.includes('FROM change_log'));

  it('reads everything in one read-only REPEATABLE READ transaction', async () => {
    await pull.pull(TECH, 0, 500, 'client-1');
    expect(db.tx).toHaveBeenCalledTimes(1);
    expect(db.tx.mock.calls[0][1]).toEqual({ isolation: 'REPEATABLE READ', readOnly: true });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('maps change-log rows to changes with numeric versions', async () => {
    logOf(1);
    const res = await pull.pull(TECH, 0, 500);
    expect(res.changes).toEqual([
      { version: 1, entity: 'ticket', id: 't1', siteId: NORTH, op: 'put', data: { title: 'T1' } },
    ]);
  });

  it('reads after the cursor up to the head of the snapshot', async () => {
    logOf(1, 2, 3);
    const res = await pull.pull(TECH, 1, 500);
    expect(res).toMatchObject({ nextCursor: 3, hasMore: false });
    expect(res.changes.map((c) => c.version)).toEqual([2, 3]);
    expect(logQuery()?.[1]?.slice(0, 2)).toEqual([1, 3]);
  });

  it('moves the cursor to the head when the changes up to it are not visible to the user', async () => {
    log = [logRow(1)];
    head = 7; // versions 2 to 7 belong to other sites
    await expect(pull.pull(TECH, 1, 500)).resolves.toMatchObject({ changes: [], nextCursor: 7, hasMore: false });
  });

  it('never moves the cursor back', async () => {
    logOf(1);
    await expect(pull.pull(TECH, 5, 500)).resolves.toMatchObject({ changes: [], nextCursor: 5, hasMore: false });
  });

  it('reports more, and stops the cursor at the page, only when changes follow the page', async () => {
    logOf(1, 2, 3);
    await expect(pull.pull(TECH, 0, 2)).resolves.toMatchObject({ nextCursor: 2, hasMore: true });
    await expect(pull.pull(TECH, 0, 3)).resolves.toMatchObject({ nextCursor: 3, hasMore: false });
    expect(logQuery()?.[1]?.[3]).toBe(3);
  });

  it('asks for one row more than the page', async () => {
    await pull.pull(TECH, 0, 42);
    expect(logQuery()?.[1]?.[3]).toBe(43);
  });

  it('returns the client last mutation id, 0 for an unknown client and when none is asked for', async () => {
    lastMutationId = 9;
    await expect(pull.pull(TECH, 0, 500, 'client-1')).resolves.toMatchObject({ lastMutationId: 9 });
    expect(db.inTx.query).toHaveBeenCalledWith('SELECT last_mutation_id FROM clients WHERE client_id = $1', [
      'client-1',
    ]);
    lastMutationId = undefined;
    await expect(pull.pull(TECH, 0, 500, 'client-2')).resolves.toMatchObject({ lastMutationId: 0 });
    db.inTx.query.mockClear();
    await expect(pull.pull(TECH, 0, 500)).resolves.toMatchObject({ lastMutationId: 0 });
    expect(db.inTx.query.mock.calls.some(([sql]) => sql.includes('FROM clients'))).toBe(false);
  });

  it('passes a database error to the caller', async () => {
    db.inTx.query.mockRejectedValue(new Error('connection reset'));
    await expect(pull.pull(TECH, 0, 500)).rejects.toThrow('connection reset');
  });
});
