import { Injectable, type MessageEvent } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { asyncScheduler, defer, from, interval, Observable, Subject, switchMap, throttleTime } from 'rxjs';
import type { EnvironmentVariables } from './config';

/**
 * Pokes for one stream within this window are merged: the first goes out at once, every later one
 * in the window becomes a single poke at its end. A poke only tells the client to pull, so one poke
 * stands for any number of changes, and a push of a hundred mutations does not queue a hundred events.
 */
export const POKE_WINDOW_MS = 250;

/** The client side of one stream, as the controller sees it. */
export interface StreamClient {
  /** The sites whose changes the client is told about. */
  sites(): Promise<readonly string[]>;
  /**
   * Whether writes to the client are backing up (the socket has data it could not send). Nest waits
   * for a backed-up stream to drain before it writes the next event, so a client that stops reading
   * would otherwise keep every later event in memory.
   */
  backedUp(): boolean;
  /** Closes the connection of a client that stopped reading. */
  drop(): void;
}

interface Subscriber {
  sites: ReadonlySet<string>;
  pokes: Subject<void>;
}

/**
 * The notification streams of this instance (`GET /sync/stream`). Each stream is an Observable that
 * Nest writes as server-sent events and unsubscribes from when the connection closes; its teardown
 * removes the subscriber, so no closed connection is kept (F-35). Events:
 *
 * - `ready`, first, with `{ heartbeatMs }`, so the client knows how long silence may last;
 * - `poke` when a site of the stream changed (merged, see {@link POKE_WINDOW_MS});
 * - `heartbeat` every `STREAM_HEARTBEAT_MS` (Nest 10 cannot write SSE comments, so it is a named
 *   event, which clients that do not listen for it ignore).
 *
 * A stream whose client reads nothing for a whole heartbeat interval while writes back up is
 * dropped.
 */
@Injectable()
export class StreamService {
  private readonly subscribers = new Set<Subscriber>();
  private readonly heartbeatMs: number;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    this.heartbeatMs = config.get('STREAM_HEARTBEAT_MS', { infer: true });
  }

  /** Open streams. */
  get count(): number {
    return this.subscribers.size;
  }

  /**
   * The events of one client's stream. Nothing happens until Nest subscribes; the subscriber is
   * registered once the client's sites are known and removed on unsubscribe, completion or error.
   */
  events(client: StreamClient): Observable<MessageEvent> {
    return defer(() => from(client.sites())).pipe(switchMap((sites) => this.subscribe(sites, client)));
  }

  /** Pokes every open stream of one of these sites. */
  notify(siteIds: readonly string[]): void {
    for (const sub of this.subscribers) {
      if (siteIds.some((site) => sub.sites.has(site))) sub.pokes.next();
    }
  }

  private subscribe(sites: readonly string[], client: StreamClient): Observable<MessageEvent> {
    return new Observable<MessageEvent>((out) => {
      const sub: Subscriber = { sites: new Set(sites), pokes: new Subject<void>() };
      this.subscribers.add(sub);
      out.next({ type: 'ready', data: { heartbeatMs: this.heartbeatMs } });
      const pokes = sub.pokes
        .pipe(throttleTime(POKE_WINDOW_MS, asyncScheduler, { leading: true, trailing: true }))
        .subscribe(() => out.next({ type: 'poke', data: {} }));
      // Heartbeat ticks in a row with writes backed up; at two the client has read nothing for a
      // whole interval and is dropped, which closes the connection and so ends the subscription.
      let backedUpTicks = 0;
      const heartbeats = interval(this.heartbeatMs).subscribe(() => {
        backedUpTicks = client.backedUp() ? backedUpTicks + 1 : 0;
        if (backedUpTicks >= 2) client.drop();
        else if (backedUpTicks === 0) out.next({ type: 'heartbeat', data: {} });
      });
      return () => {
        heartbeats.unsubscribe();
        pokes.unsubscribe();
        sub.pokes.complete();
        this.subscribers.delete(sub);
      };
    });
  }
}
