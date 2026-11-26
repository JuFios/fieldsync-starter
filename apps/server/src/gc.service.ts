import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Clock } from './clock';
import { AppConfig } from './config';
import { Db } from './db';

@Injectable()
export class GcService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GcService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(
      () => void this.collect().catch((e: Error) => this.logger.error(e.message)),
      this.config.gcIntervalMs,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async collect(): Promise<number> {
    // The cutoff comes from the same clock that stamps created_at, see Clock.
    const cutoff = new Date(this.clock.now().getTime() - this.config.changelogRetentionSeconds * 1000);
    const res = await this.db.query(`DELETE FROM change_log WHERE created_at < $1`, [cutoff]);
    return res.rowCount;
  }
}
