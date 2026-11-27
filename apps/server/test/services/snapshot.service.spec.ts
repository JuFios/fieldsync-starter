import { Test } from '@nestjs/testing';
import { Db } from '../../src/db';
import { ProblemException } from '../../src/problem';
import { SnapshotService } from '../../src/snapshot.service';
import { mockDb, result, type MockDb } from './support';

const TECH = { id: 'user-1', role: 'technician' as const };
const NORTH = '00000000-0000-4000-8000-0000000000a1';
const row = (id: string) => ({ entity: 'ticket' as const, id, site_id: NORTH, data: { id, title: id } });

describe('SnapshotService', () => {
  let service: SnapshotService;
  let db: MockDb;
  let head: number;
  let floor: number;
  let rows: ReturnType<typeof row>[];

  beforeEach(async () => {
    db = mockDb();
    head = 10;
    floor = 0;
    rows = [];
    db.inTx.query.mockImplementation((sql, params) => {
      if (sql.includes('FROM log_head')) return Promise.resolve(result([{ head: String(head), floor: String(floor) }]));
      if (sql.includes('FROM user_sites')) return Promise.resolve(result([{ site_id: NORTH }]));
      if (sql.includes('FROM entities')) {
        const limit = (params as unknown[]).at(-1) as number;
        return Promise.resolve(result(rows.slice(0, limit)));
      }
      return Promise.reject(new Error(`unexpected query: ${sql}`));
    });
    const moduleRef = await Test.createTestingModule({
      providers: [SnapshotService, { provide: Db, useValue: db }],
    }).compile();
    service = moduleRef.get(SnapshotService);
  });

  const entityQuery = () => db.inTx.query.mock.calls.find(([sql]) => sql.includes('FROM entities'));

  it('reads a page in one read-only REPEATABLE READ transaction', async () => {
    await service.page(TECH, { limit: 500 });
    expect(db.tx).toHaveBeenCalledTimes(1);
    expect(db.tx.mock.calls[0][1]).toEqual({ isolation: 'REPEATABLE READ', readOnly: true });
  });

  it('fixes the watermark at the head on the first page and asks for one row more than the page', async () => {
    rows = [row('a'), row('b'), row('c')];
    const page = await service.page(TECH, { limit: 2 });
    expect(page).toEqual({
      watermark: 10,
      rows: [
        { entity: 'ticket', id: 'a', siteId: NORTH, data: { id: 'a', title: 'a' } },
        { entity: 'ticket', id: 'b', siteId: NORTH, data: { id: 'b', title: 'b' } },
      ],
      next: { siteId: NORTH, entity: 'ticket', id: 'b' },
    });
    expect(entityQuery()?.[1]).toEqual([[NORTH], 3]);
  });

  it('ends the snapshot when no row follows the page', async () => {
    rows = [row('a')];
    await expect(service.page(TECH, { limit: 2 })).resolves.toMatchObject({ next: null });
  });

  it('continues after the key of the previous page, under the watermark of its first page', async () => {
    const after = { siteId: NORTH, entity: 'ticket' as const, id: 'b' };
    await expect(service.page(TECH, { watermark: 7, after, limit: 2 })).resolves.toMatchObject({ watermark: 7 });
    expect(entityQuery()?.[1]).toEqual([[NORTH], NORTH, 'ticket', 'b', 3]);
  });

  it('answers 410 RESET_REQUIRED for a watermark below the floor, 400 for one above the head', async () => {
    floor = 8;
    const below = await service.page(TECH, { watermark: 7, limit: 2 }).catch((e: unknown) => e);
    expect(below).toBeInstanceOf(ProblemException);
    expect((below as ProblemException).getStatus()).toBe(410);
    expect(below).toMatchObject({ code: 'RESET_REQUIRED', details: { floor: 8 } });
    const above = await service.page(TECH, { watermark: 11, limit: 2 }).catch((e: unknown) => e);
    expect((above as ProblemException).getStatus()).toBe(400);
    expect(above).toMatchObject({ code: 'BAD_REQUEST', details: { head: 10 } });
    expect(entityQuery()).toBeUndefined();
  });

  it('answers a transient database failure with 503', async () => {
    db.inTx.query.mockRejectedValue(Object.assign(new Error('serialization'), { code: '40001' }));
    const err = await service.page(TECH, { limit: 2 }).catch((e: unknown) => e);
    expect((err as ProblemException).getStatus()).toBe(503);
  });

  it('passes any other database error to the caller', async () => {
    db.inTx.query.mockRejectedValue(new Error('syntax'));
    await expect(service.page(TECH, { limit: 2 })).rejects.toThrow('syntax');
  });
});
