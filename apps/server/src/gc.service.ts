import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Clock } from './clock';
import type { EnvironmentVariables } from './config';
import { Db, type TxSql } from './db';

/** Name of the change-log GC interval in the SchedulerRegistry. */
export const GC_INTERVAL_NAME = 'changelog-gc';

/** What one GC run removed, and the floor of the log after it. */
export interface GcRun {
  /** Change-log entries removed. */
  log: number;
  /** Tombstones (deleted entities) removed. */
  tombstones: number;
  /** Mutation results removed. */
  results: number;
  /** The floor of the log after the run (as read when no batch ran): pulls with a cursor below it are reset. */
  floor: number;
  /**
   * True when this run did nothing: another GC (in this process or another instance) held the log,
   * or the application is shutting down (then `floor` is 0, not read).
   */
  skipped: boolean;
}

interface Batch {
  log: number;
  tombstones: number;
  results: number;
  floor: number;
  /** More of the log may be collectable: the batch was full and reached no change younger than the cutoff. */
  more: boolean;
}

/**
 * The change-log GC. It removes the log in prefixes, by version: the oldest changes first, and never
 * a change while an older one is kept, so `log_floor` (the highest removed version) is exact and a
 * pull below it is answered 410 RESET_REQUIRED. A change's `created_at` is its mutation's clock
 * reading, taken before the commit, so it does not grow with the version; the prefix stops at the
 * first change younger than the cutoff.
 *
 * Each batch is its own short transaction that locks the `log_floor` row with SKIP LOCKED: a second
 * GC, in this process or on another instance, finds it taken and stops instead of waiting or
 * removing the same rows. In the same transaction the batch removes the tombstones and the results
 * of applied mutations whose versions it removes (a client that could still need them is behind the
 * floor and is reset), then raises the floor. Results that have no version (rejections, mutations
 * that changed nothing) are removed by age, after `MUTATION_RESULT_RETENTION_SECONDS`.
 */
@Injectable()
export class GcService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GcService.name);
  /** The run in progress, if any: intervals do not wait for a run to finish (NestJS task scheduling). */
  private running: Promise<GcRun> | undefined;
  private stopping = false;

  constructor(
    private readonly db: Db,
    private readonly config: ConfigService<EnvironmentVariables, true>,
    private readonly clock: Clock,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  /**
   * Registers the GC as a dynamic interval (its period comes from the configuration, which the
   * static `@Interval()` decorator cannot read). The schedule module clears it on shutdown.
   */
  onModuleInit(): void {
    const timer = setInterval(
      () => {
        // A run that takes longer than the interval is not started twice, and none starts on shutdown.
        if (this.running || this.stopping) return;
        void this.collect().catch((e: Error) => this.logger.error(e.message));
      },
      this.config.get('GC_INTERVAL_MS', { infer: true }),
    );
    this.scheduler.addInterval(GC_INTERVAL_NAME, timer);
  }

  /**
   * Stops the GC between two batches and waits for the batch in progress, before the database pool
   * closes (it closes in `onApplicationShutdown`, after this hook; NestJS lifecycle events).
   */
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.running?.catch(() => undefined);
  }

  /**
   * Removes what is older than the retentions, batch by batch, until nothing collectable is left or
   * the application shuts down. A call while a run is in progress joins that run.
   */
  collect(): Promise<GcRun> {
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  private async run(): Promise<GcRun> {
    // No query once the application shuts down: the pool closes after onModuleDestroy.
    if (this.stopping) return { log: 0, tombstones: 0, results: 0, floor: 0, skipped: true };
    // The cutoffs come from the same clock that stamps created_at, see Clock.
    const now = this.clock.now().getTime();
    const logCutoff = new Date(now - this.config.get('CHANGELOG_RETENTION_SECONDS', { infer: true }) * 1000);
    const resultCutoff = new Date(now - this.config.get('MUTATION_RESULT_RETENTION_SECONDS', { infer: true }) * 1000);
    const size = this.config.get('GC_BATCH_SIZE', { infer: true });

    const total: GcRun = { log: 0, tombstones: 0, results: 0, floor: await this.floor(), skipped: false };
    for (;;) {
      if (this.stopping) return total;
      const batch = await this.db.tx((c) => this.batch(c, logCutoff, size));
      if (batch === undefined) return { ...total, skipped: true };
      total.log += batch.log;
      total.tombstones += batch.tombstones;
      total.results += batch.results;
      total.floor = batch.floor;
      if (!batch.more) break;
    }
    // What lies below the floor from before this GC ran (a database the original GC pruned).
    for (;;) {
      if (this.stopping) return total;
      const removed = await this.belowFloor('tombstones', total.floor, size);
      total.tombstones += removed;
      if (removed < size) break;
    }
    for (;;) {
      if (this.stopping) return total;
      const removed = await this.belowFloor('results', total.floor, size);
      total.results += removed;
      if (removed < size) break;
    }
    for (;;) {
      if (this.stopping) return total;
      const removed = await this.expiredResults(resultCutoff, size);
      total.results += removed;
      if (removed < size) break;
    }
    if (total.log + total.tombstones + total.results > 0) {
      this.logger.log(
        `Removed ${total.log} change-log entries, ${total.tombstones} tombstones and ${total.results} mutation results; the log now starts after version ${total.floor}`,
      );
    }
    return total;
  }

  /**
   * One prefix of at most `size` versions after the floor, cut before the first change younger than
   * the cutoff. Returns undefined when another GC holds the floor.
   */
  private async batch(c: TxSql, cutoff: Date, size: number): Promise<Batch | undefined> {
    const locked = await c.query<{ version: string }>(
      `SELECT version FROM log_floor WHERE id = 1 FOR UPDATE SKIP LOCKED`,
    );
    if (locked.rows.length === 0) return undefined;
    const floor = Number(locked.rows[0].version);

    // The next `size` versions; the batch ends before the first one at or after the cutoff.
    const { rows } = await c.query<{ stop: string | null; full: boolean; young: boolean }>(
      `WITH next AS (
         SELECT version, created_at FROM change_log WHERE version > $1 ORDER BY version LIMIT $3
       )
       SELECT coalesce((SELECT min(version) - 1 FROM next WHERE created_at >= $2), (SELECT max(version) FROM next)) AS stop,
              (SELECT count(*) FROM next) = $3 AS full,
              EXISTS (SELECT 1 FROM next WHERE created_at >= $2) AS young`,
      [floor, cutoff, size],
    );
    const stop = rows[0].stop === null ? floor : Number(rows[0].stop);
    if (stop <= floor) return { log: 0, tombstones: 0, results: 0, floor, more: false };

    // One statement: its data-modifying CTEs all run to completion on one snapshot (PostgreSQL 16, 7.8.4).
    const removed = await c.query<{ log: string; tombstones: string; results: string }>(
      `WITH log AS (
         DELETE FROM change_log WHERE version > $1 AND version <= $2 RETURNING 1
       ),
       tombstones AS (
         DELETE FROM entities WHERE deleted AND version > $1 AND version <= $2 RETURNING 1
       ),
       results AS (
         DELETE FROM mutation_results WHERE status = 'applied' AND version > $1 AND version <= $2 RETURNING 1
       ),
       floor AS (
         UPDATE log_floor SET version = $2 WHERE id = 1
       )
       SELECT (SELECT count(*) FROM log) AS log, (SELECT count(*) FROM tombstones) AS tombstones,
              (SELECT count(*) FROM results) AS results`,
      [floor, stop],
    );
    const r = removed.rows[0];
    return {
      log: Number(r.log),
      tombstones: Number(r.tombstones),
      results: Number(r.results),
      floor: stop,
      more: rows[0].full && !rows[0].young,
    };
  }

  private async floor(): Promise<number> {
    const { rows } = await this.db.query<{ version: string }>(`SELECT version FROM log_floor WHERE id = 1`);
    return Number(rows[0].version);
  }

  /**
   * Up to `size` tombstones, or results of applied mutations, at or below `floor`: rows a batch never
   * covered because their changes were gone before the floor existed. Picked by `ctid` like
   * {@link expiredResults}; through the partial indexes on `version` the check is cheap once none
   * are left.
   */
  private async belowFloor(what: 'tombstones' | 'results', floor: number, size: number): Promise<number> {
    const sql =
      what === 'tombstones'
        ? `DELETE FROM entities WHERE ctid = ANY (ARRAY(
             SELECT ctid FROM entities WHERE deleted AND version <= $1 LIMIT $2
           ))`
        : `DELETE FROM mutation_results WHERE ctid = ANY (ARRAY(
             SELECT ctid FROM mutation_results WHERE status = 'applied' AND version <= $1 LIMIT $2
           ))`;
    const { rowCount } = await this.db.query(sql, [floor, size]);
    return rowCount;
  }

  /**
   * Up to `size` results without a version (rejections, mutations that changed nothing) older than
   * the cutoff. DELETE has no LIMIT (PostgreSQL 16, DELETE); the rows are picked by `ctid` in the same
   * statement, which the planner reads with a TID scan, where a join on the primary key read the whole
   * table (README, Indexes). A row updated meanwhile gets another ctid and is left for the next run.
   */
  private async expiredResults(cutoff: Date, size: number): Promise<number> {
    const { rowCount } = await this.db.query(
      `DELETE FROM mutation_results
        WHERE ctid = ANY (ARRAY(
          SELECT ctid FROM mutation_results WHERE version IS NULL AND created_at < $1 LIMIT $2
        ))`,
      [cutoff, size],
    );
    return rowCount;
  }
}
