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
  let lastMutationId: number | undefined;

  beforeEach(async () => {
    db = mockDb();
    log = [];
    lastMutationId = undefined;
    db.query.mockImplementation((sql, params) => {
      if (sql.includes('FROM user_sites')) return Promise.resolve(result([{ site_id: NORTH }]));
      if (sql.includes('FROM change_log')) {
        const [after, , take] = params as [number, unknown, number];
        return Promise.resolve(result(log.filter((r) => Number(r.version) > after).slice(0, take)));
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

  const logQuery = () => db.query.mock.calls.find(([sql]) => sql.includes('FROM change_log'));

  it('maps change-log rows to changes with numeric versions', async () => {
    log = [logRow(1)];
    const res = await pull.pull(TECH, 0, 500);
    expect(res.changes).toEqual([
      { version: 1, entity: 'ticket', id: 't1', siteId: NORTH, op: 'put', data: { title: 'T1' } },
    ]);
  });

  it('reads after the cursor and moves it to the last change returned', async () => {
    log = [logRow(1), logRow(2), logRow(3)];
    const res = await pull.pull(TECH, 1, 500);
    expect(res.changes.map((c) => c.version)).toEqual([2, 3]);
    expect(res.nextCursor).toBe(3);
    expect(res.hasMore).toBe(false);
  });

  it('keeps the cursor when there is nothing new', async () => {
    log = [logRow(1)];
    await expect(pull.pull(TECH, 1, 500)).resolves.toMatchObject({ changes: [], nextCursor: 1, hasMore: false });
  });

  it('reports more when a full page was returned', async () => {
    log = [logRow(1), logRow(2), logRow(3)];
    const res = await pull.pull(TECH, 0, 2);
    expect(res).toMatchObject({ nextCursor: 2, hasMore: true });
  });

  it.each([
    [0, 1],
    [-5, 1],
    [10_000, 500],
    [42, 42],
  ])('clamps the page size %d to %d', async (limit, take) => {
    await pull.pull(TECH, 0, limit);
    expect(logQuery()?.[1]?.[2]).toBe(take);
  });

  it('returns the client last mutation id, 0 for an unknown client and when none is asked for', async () => {
    lastMutationId = 9;
    await expect(pull.pull(TECH, 0, 500, 'client-1')).resolves.toMatchObject({ lastMutationId: 9 });
    expect(db.query).toHaveBeenCalledWith('SELECT last_mutation_id FROM clients WHERE client_id = $1', ['client-1']);
    lastMutationId = undefined;
    await expect(pull.pull(TECH, 0, 500, 'client-2')).resolves.toMatchObject({ lastMutationId: 0 });
    db.query.mockClear();
    await expect(pull.pull(TECH, 0, 500)).resolves.toMatchObject({ lastMutationId: 0 });
    expect(db.query.mock.calls.some(([sql]) => sql.includes('FROM clients'))).toBe(false);
  });

  it('passes a database error to the caller', async () => {
    db.query.mockRejectedValue(new Error('connection reset'));
    await expect(pull.pull(TECH, 0, 500)).rejects.toThrow('connection reset');
  });
});
