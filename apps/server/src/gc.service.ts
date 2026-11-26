import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Clock } from './clock';
import type { EnvironmentVariables } from './config';
import { Db } from './db';

/** Name of the change-log GC interval in the SchedulerRegistry. */
export const GC_INTERVAL_NAME = 'changelog-gc';

@Injectable()
export class GcService implements OnModuleInit {
  private readonly logger = new Logger(GcService.name);

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
      () => void this.collect().catch((e: Error) => this.logger.error(e.message)),
      this.config.get('GC_INTERVAL_MS', { infer: true }),
    );
    this.scheduler.addInterval(GC_INTERVAL_NAME, timer);
  }

  /** Deletes change-log entries and mutation results older than the retention; returns the log entries deleted. */
  async collect(): Promise<number> {
    // The cutoff comes from the same clock that stamps created_at, see Clock.
    const retentionMs = this.config.get('CHANGELOG_RETENTION_SECONDS', { infer: true }) * 1000;
    const cutoff = new Date(this.clock.now().getTime() - retentionMs);
    const res = await this.db.query(`DELETE FROM change_log WHERE created_at < $1`, [cutoff]);
    // Results answer retried copies of a mutation; a client whose copies are older than the log
    // retention has to reload its state anyway, so they are kept exactly as long as the log.
    await this.db.query(`DELETE FROM mutation_results WHERE created_at < $1`, [cutoff]);
    return res.rowCount;
  }
}
