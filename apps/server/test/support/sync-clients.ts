import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { HttpTransport, MemoryStorage, SyncClient, type Row } from '@fieldsync/sync-core';
import type { IntegrationContext } from './integration';
import type { TestUser } from './fixtures';

/**
 * Production sync clients (`SyncClient` with `HttpTransport` over real HTTP) against the server of an
 * integration test. The server listens on a loopback port once; every client made here is disposed
 * by {@link SyncClients.disposeAll}.
 */
export class SyncClients {
  private baseUrl: string | undefined;
  private readonly clients: SyncClient[] = [];

  constructor(private readonly ctx: IntegrationContext) {}

  /** A new client of `user` with its own id and empty in-memory storage. */
  async create(user: TestUser): Promise<SyncClient> {
    const client = new SyncClient({
      clientId: randomUUID(),
      transport: new HttpTransport(await this.url(), user.token),
      storage: new MemoryStorage(),
      // Tests decide when a client syncs; a notification stream would sync it at other times.
      live: false,
    });
    this.clients.push(client);
    return client;
  }

  disposeAll(): void {
    for (const client of this.clients.splice(0)) client.dispose();
  }

  private async url(): Promise<string> {
    if (this.baseUrl === undefined) {
      const server = this.ctx.server.app.getHttpServer() as Server;
      if (!server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', () => resolve());
        });
      }
      this.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }
    return this.baseUrl;
  }
}

/** The client's rows of one entity, by id. */
export function rowsById(client: SyncClient, entity: 'ticket' | 'part'): Map<string, Row> {
  return new Map(client.rows(entity).map((row) => [row.id as string, row]));
}
