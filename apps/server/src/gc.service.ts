import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AppConfig } from './config';
import { Db } from './db';

@Injectable()
export class GcService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GcService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
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
    const res = await this.db.query(`DELETE FROM change_log WHERE created_at < now() - make_interval(secs => $1)`, [
      this.config.changelogRetentionSeconds,
    ]);
    return res.rowCount;
  }
}
