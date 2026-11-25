import { Logger as NestLogger } from '@nestjs/common';
import type { Logger as TypeOrmLogger } from 'typeorm';

/**
 * TypeORM logger that never writes query parameters: they carry user data and access tokens.
 * Only failures, slow queries, warnings and migration progress are logged; successful queries
 * are not.
 */
export class SafeTypeOrmLogger implements TypeOrmLogger {
  constructor(private readonly logger: Pick<NestLogger, 'log' | 'warn' | 'error'> = new NestLogger('Database')) {}

  logQuery(_query: string, _parameters?: unknown[]): void {
    // Successful queries are not logged.
  }

  logQueryError(error: string | Error, query: string, _parameters?: unknown[]): void {
    const message = typeof error === 'string' ? error : error.message;
    this.logger.error(`Query failed: ${message} -- ${oneLine(query)}`);
  }

  logQuerySlow(time: number, query: string, _parameters?: unknown[]): void {
    this.logger.warn(`Slow query (${time} ms): ${oneLine(query)}`);
  }

  logSchemaBuild(_message: string): void {
    // Schema synchronisation is disabled; migrations are logged instead.
  }

  logMigration(message: string): void {
    this.logger.log(message);
  }

  log(level: 'log' | 'info' | 'warn', message: unknown): void {
    if (level === 'warn') this.logger.warn(String(message));
    else this.logger.log(String(message));
  }
}

function oneLine(query: string): string {
  return query.replace(/\s+/g, ' ').trim();
}
