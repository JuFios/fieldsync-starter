import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { Clock } from '../../src/clock';
import { Db } from '../../src/db';
import { GC_INTERVAL_NAME, GcService } from '../../src/gc.service';
import { mockConfig, mockDb, result, type MockDb } from './support';

const NOW = new Date('2026-11-26T12:00:00.000Z');
const SETTINGS = {
  GC_INTERVAL_MS: 60_000,
  CHANGELOG_RETENTION_SECONDS: 3600,
  MUTATION_RESULT_RETENTION_SECONDS: 7200,
  GC_BATCH_SIZE: 100,
};

/**
 * The database's side of the GC, scripted: the floor row (taken or free) and, per batch, what the
 * next versions after the floor look like and how much the batch removes.
 */
interface Script {
  floorTaken?: boolean;
  floor: number;
  batches: Array<{ stop: number | null; full: boolean; young: boolean; removed?: [number, number, number] }>;
  expired?: number[];
  /** Tombstones and applied results below the floor, removed after the batches. */
  belowFloor?: { tombstones?: number[]; results?: number[] };
}

describe('GcService', () => {
  let gc: GcService;
  let db: MockDb;
  let scheduler: SchedulerRegistry;

  beforeEach(async () => {
    jest.useFakeTimers();
    db = mockDb();
    const moduleRef = await Test.createTestingModule({
      providers: [
        GcService,
        SchedulerRegistry,
        { provide: Db, useValue: db },
        { provide: Clock, useValue: { now: () => NOW } },
        { provide: ConfigService, useValue: mockConfig(SETTINGS) },
      ],
    }).compile();
    gc = moduleRef.get(GcService);
    scheduler = moduleRef.get(SchedulerRegistry);
  });

  afterEach(() => {
    for (const name of scheduler.getIntervals()) scheduler.deleteInterval(name);
    jest.useRealTimers();
  });

  function script(s: Script): void {
    let floor = s.floor;
    const batches = [...s.batches];
    db.inTx.query.mockImplementation((sql) => {
      if (sql.includes('FROM log_floor')) {
        return Promise.resolve(result(s.floorTaken ? [] : [{ version: String(floor) }]));
      }
      if (sql.includes('WITH next AS')) {
        const b = batches[0];
        if (!b) return Promise.reject(new Error('no batch scripted'));
        return Promise.resolve(
          result([{ stop: b.stop === null ? null : String(b.stop), full: b.full, young: b.young }]),
        );
      }
      if (sql.includes('DELETE FROM change_log')) {
        const b = batches.shift();
        if (!b) return Promise.reject(new Error('no batch scripted'));
        const [log, tombstones, results] = b.removed ?? [0, 0, 0];
        floor = b.stop ?? floor;
        return Promise.resolve(
          result([{ log: String(log), tombstones: String(tombstones), results: String(results) }]),
        );
      }
      return Promise.reject(new Error(`unexpected query: ${sql}`));
    });
    const expired = [...(s.expired ?? [0])];
    const tombstones = [...(s.belowFloor?.tombstones ?? [0])];
    const results = [...(s.belowFloor?.results ?? [0])];
    db.query.mockImplementation((sql) => {
      if (sql.includes('FROM log_floor')) return Promise.resolve(result([{ version: String(floor) }]));
      if (sql.includes('DELETE FROM entities')) return Promise.resolve(result([], tombstones.shift() ?? 0));
      if (sql.includes("status = 'applied'")) return Promise.resolve(result([], results.shift() ?? 0));
      if (sql.includes('version IS NULL')) return Promise.resolve(result([], expired.shift() ?? 0));
      return Promise.reject(new Error(`unexpected query: ${sql}`));
    });
  }

  describe('collect', () => {
    it('removes prefixes of the log batch by batch until a batch reaches a change within the retention', async () => {
      script({
        floor: 10,
        batches: [
          { stop: 110, full: true, young: false, removed: [100, 3, 90] },
          { stop: 150, full: true, young: true, removed: [40, 1, 30] },
        ],
      });
      await expect(gc.collect()).resolves.toEqual({
        log: 140,
        tombstones: 4,
        results: 120,
        floor: 150,
        skipped: false,
      });
      // Each batch is its own transaction, read with the floor locked first.
      expect(db.tx).toHaveBeenCalledTimes(2);
      const next = db.inTx.query.mock.calls.filter(([sql]) => sql.includes('WITH next AS'));
      expect(next.map(([, params]) => params)).toEqual([
        [10, new Date('2026-11-26T11:00:00.000Z'), 100],
        [110, new Date('2026-11-26T11:00:00.000Z'), 100],
      ]);
      const removals = db.inTx.query.mock.calls.filter(([sql]) => sql.includes('DELETE FROM change_log'));
      expect(removals.map(([, params]) => params)).toEqual([
        [10, 110],
        [110, 150],
      ]);
    });

    it('stops after a batch that is not full: the log after it is empty', async () => {
      script({ floor: 0, batches: [{ stop: 40, full: false, young: false, removed: [40, 0, 0] }] });
      await expect(gc.collect()).resolves.toMatchObject({ log: 40, floor: 40 });
      expect(db.tx).toHaveBeenCalledTimes(1);
    });

    it('removes nothing and keeps the floor when the oldest change is within the retention', async () => {
      script({ floor: 7, batches: [{ stop: 7, full: true, young: true }] });
      await expect(gc.collect()).resolves.toEqual({ log: 0, tombstones: 0, results: 0, floor: 7, skipped: false });
      expect(db.inTx.query.mock.calls.some(([sql]) => sql.includes('DELETE FROM change_log'))).toBe(false);
    });

    it('removes nothing on an empty log', async () => {
      script({ floor: 3, batches: [{ stop: null, full: false, young: false }] });
      await expect(gc.collect()).resolves.toMatchObject({ log: 0, floor: 3 });
    });

    it('does nothing when another GC holds the floor', async () => {
      script({ floorTaken: true, floor: 42, batches: [] });
      await expect(gc.collect()).resolves.toEqual({ log: 0, tombstones: 0, results: 0, floor: 42, skipped: true });
      expect(db.inTx.query).toHaveBeenCalledTimes(1);
      expect(db.query.mock.calls.some(([sql]) => sql.includes('DELETE'))).toBe(false);
    });

    it('removes results without a version older than their own retention, in batches', async () => {
      script({ floor: 0, batches: [{ stop: null, full: false, young: false }], expired: [100, 100, 7] });
      await expect(gc.collect()).resolves.toMatchObject({ results: 207 });
      const expired = db.query.mock.calls.filter(([sql]) => sql.includes('version IS NULL'));
      expect(expired).toHaveLength(3);
      expect(expired[0][1]).toEqual([new Date('2026-11-26T10:00:00.000Z'), 100]);
    });

    it('removes tombstones and applied results left below the floor, in batches', async () => {
      script({
        floor: 500,
        batches: [{ stop: null, full: false, young: false }],
        belowFloor: { tombstones: [100, 3], results: [100, 100, 0] },
      });
      await expect(gc.collect()).resolves.toMatchObject({ tombstones: 103, results: 200, floor: 500 });
      const below = db.query.mock.calls.filter(([sql]) => sql.includes('version <= $1'));
      expect(below.map(([, params]) => params)).toEqual([
        [500, 100],
        [500, 100],
        [500, 100],
        [500, 100],
        [500, 100],
      ]);
    });

    it('joins a run already in progress instead of starting a second one', async () => {
      script({ floor: 0, batches: [{ stop: 5, full: false, young: false, removed: [5, 0, 0] }] });
      const [a, b] = [gc.collect(), gc.collect()];
      expect(a).toBe(b);
      await expect(a).resolves.toMatchObject({ log: 5 });
      expect(db.tx).toHaveBeenCalledTimes(1);
    });

    it('passes a database error to the caller', async () => {
      db.query.mockRejectedValue(new Error('connection reset'));
      await expect(gc.collect()).rejects.toThrow('connection reset');
      db.query.mockResolvedValue(result([{ version: '0' }]));
      db.inTx.query.mockRejectedValue(new Error('connection reset'));
      await expect(gc.collect()).rejects.toThrow('connection reset');
    });
  });

  describe('onModuleDestroy', () => {
    it('waits for the batch in progress and starts no other', async () => {
      script({
        floor: 0,
        batches: [
          { stop: 100, full: true, young: false, removed: [100, 0, 0] },
          { stop: 200, full: true, young: false, removed: [100, 0, 0] },
        ],
      });
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => (release = r));
      const original = db.tx.getMockImplementation();
      db.tx.mockImplementationOnce(async (fn, options) => {
        await gate;
        return original!(fn, options);
      });
      const run = gc.collect();
      // The first batch has started and waits.
      await jest.advanceTimersByTimeAsync(0);
      expect(db.tx).toHaveBeenCalledTimes(1);
      const destroyed = gc.onModuleDestroy();
      let done = false;
      void destroyed.then(() => (done = true));
      await jest.advanceTimersByTimeAsync(0);
      expect(done).toBe(false);
      release();
      await destroyed;
      await expect(run).resolves.toMatchObject({ log: 100, floor: 100 });
      expect(db.tx).toHaveBeenCalledTimes(1);
    });
  });

  describe('onModuleInit', () => {
    it('registers the GC as a named interval with the configured period', async () => {
      script({
        floor: 0,
        batches: [
          { stop: null, full: false, young: false },
          { stop: null, full: false, young: false },
        ],
      });
      gc.onModuleInit();
      expect(scheduler.getIntervals()).toEqual([GC_INTERVAL_NAME]);
      await jest.advanceTimersByTimeAsync(59_999);
      expect(db.tx).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(db.tx).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(db.tx).toHaveBeenCalledTimes(2);
    });

    it('skips a tick while the previous run is still going', async () => {
      script({ floor: 0, batches: [{ stop: null, full: false, young: false }] });
      db.tx.mockImplementation(() => new Promise(() => undefined));
      gc.onModuleInit();
      await jest.advanceTimersByTimeAsync(180_000);
      expect(db.tx).toHaveBeenCalledTimes(1);
    });

    it('logs a failed run and keeps running', async () => {
      script({ floor: 0, batches: [{ stop: null, full: false, young: false }] });
      db.tx.mockRejectedValueOnce(new Error('connection reset'));
      const error = jest.spyOn(Reflect.get(gc, 'logger') as { error: (m: string) => void }, 'error');
      error.mockImplementation(() => undefined);
      gc.onModuleInit();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(error).toHaveBeenCalledWith('connection reset');
      await jest.advanceTimersByTimeAsync(60_000);
      expect(db.tx).toHaveBeenCalledTimes(2);
    });
  });
});
