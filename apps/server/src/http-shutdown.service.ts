import { Injectable, type BeforeApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Server } from 'node:http';
import stoppable from 'stoppable';

/**
 * Stops the HTTP server without cutting a request off and without waiting for idle clients.
 * `server.close()`, which Nest calls, closes only the connections idle at that moment: one that was
 * busy then and is used again (a browser, or a proxy keeping it alive) held the shutdown for as long
 * as it was used, and for the keep-alive timeout after. `stoppable` takes no new connections and
 * closes every open one as soon as none of its requests waits for an answer; a request a client
 * sends into a connection being closed fails on its side, and it sends it again.
 *
 * It sets no grace period of its own, so it never cuts a request in progress: the process manager's
 * (SIGKILL) bounds the shutdown.
 */
@Injectable()
export class HttpShutdownService implements OnModuleInit, BeforeApplicationShutdown {
  private server: (Server & stoppable.WithStop) | undefined;

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  /** Follows the server's connections from before it listens, so that none is missed. */
  onModuleInit(): void {
    this.server = stoppable(this.adapterHost.httpAdapter.getHttpServer() as Server);
  }

  /**
   * Runs after every `onModuleDestroy` (the streams have ended, the GC has stopped) and before Nest
   * closes the server and the database pool (NestJS lifecycle events): resolves once the last
   * connection has closed.
   */
  beforeApplicationShutdown(): Promise<void> {
    const server = this.server;
    return new Promise((resolve) => {
      if (!server) return resolve();
      // The one error, of a server that never listened (tests in process), leaves nothing to wait for.
      server.stop(() => resolve());
    });
  }
}
