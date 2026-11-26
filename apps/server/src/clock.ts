import { Injectable } from '@nestjs/common';

/**
 * The server's source of time. Every timestamp the server stores (row data written by mutators,
 * `change_log.created_at`) and the cutoff of the change-log GC come from this one clock instead of
 * a mix of the Node clock and Postgres `now()`. It is a Nest class provider (the abstract class is
 * the injection token, `useClass` picks the implementation), so that the simulation can drive the
 * server with virtual time through `overrideProvider(Clock)`.
 */
export abstract class Clock {
  abstract now(): Date;
}

/** The host's wall clock. With several server instances their clocks should be NTP-synchronised. */
@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}
