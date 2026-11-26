import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { Clock } from '../../src/clock';
import { Db } from '../../src/db';
import { GC_INTERVAL_NAME, GcService } from '../../src/gc.service';
import { mockConfig, mockDb, result, type MockDb } from './support';

const NOW = new Date('2026-11-26T12:00:00.000Z');

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
        { provide: ConfigService, useValue: mockConfig({ GC_INTERVAL_MS: 60_000, CHANGELOG_RETENTION_SECONDS: 3600 }) },
      ],
    }).compile();
    gc = moduleRef.get(GcService);
    scheduler = moduleRef.get(SchedulerRegistry);
  });

  afterEach(() => {
    for (const name of scheduler.getIntervals()) scheduler.deleteInterval(name);
    jest.useRealTimers();
  });

  describe('collect', () => {
    it('deletes change-log entries older than the retention, by the server clock, and returns how many', async () => {
      db.query.mockResolvedValue(result([], 7));
      await expect(gc.collect()).resolves.toBe(7);
      expect(db.query).toHaveBeenCalledWith('DELETE FROM change_log WHERE created_at < $1', [
        new Date('2026-11-26T11:00:00.000Z'),
      ]);
    });

    it('passes a database error to the caller', async () => {
      db.query.mockRejectedValue(new Error('connection reset'));
      await expect(gc.collect()).rejects.toThrow('connection reset');
    });
  });

  describe('onModuleInit', () => {
    it('registers the GC as a named interval with the configured period', async () => {
      db.query.mockResolvedValue(result([], 0));
      gc.onModuleInit();
      expect(scheduler.getIntervals()).toEqual([GC_INTERVAL_NAME]);
      await jest.advanceTimersByTimeAsync(59_999);
      expect(db.query).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(db.query).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(db.query).toHaveBeenCalledTimes(2);
    });

    it('logs a failed run and keeps running', async () => {
      db.query.mockRejectedValueOnce(new Error('connection reset')).mockResolvedValue(result([], 0));
      const error = jest.spyOn(Reflect.get(gc, 'logger') as { error: (m: string) => void }, 'error');
      error.mockImplementation(() => undefined);
      gc.onModuleInit();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(error).toHaveBeenCalledWith('connection reset');
      await jest.advanceTimersByTimeAsync(60_000);
      expect(db.query).toHaveBeenCalledTimes(2);
    });
  });
});
