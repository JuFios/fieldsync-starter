import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from '@fieldsync/sync-core';

/** An open notification stream as a real HTTP client sees it. */
export interface OpenStream {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** Everything received so far. */
  text(): string;
  /** Resolves when the server ends the response (or the connection closes). */
  ended: Promise<void>;
  /** Closes the connection from the client's side, as a closed tab does. */
  close(): void;
}

/**
 * Starts listening on an ephemeral loopback port (once) and returns it. Streams need a real HTTP
 * connection: supertest buffers a response until it ends, which an event stream never does.
 */
export async function listenOnLoopback(app: INestApplication): Promise<number> {
  const server = app.getHttpServer() as http.Server;
  if (!server.listening) await app.listen(0, '127.0.0.1');
  return (server.address() as AddressInfo).port;
}

/**
 * Opens `GET /sync/stream` with the given headers (and the current protocol version unless they name
 * one) and waits for the response head.
 */
export function openStream(port: number, headers: Record<string, string>): Promise<OpenStream> {
  return new Promise((resolve, reject) => {
    const all = { [PROTOCOL_HEADER]: String(PROTOCOL_VERSION), ...headers };
    const req = http.get({ host: '127.0.0.1', port, path: '/sync/stream', headers: all }, (res) => {
      let received = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (received += chunk));
      const ended = new Promise<void>((done) => {
        res.on('end', done);
        res.on('close', done);
        res.on('error', () => done());
      });
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        text: () => received,
        ended,
        close: () => req.destroy(),
      });
    });
    req.on('error', reject);
  });
}

/** Polls `check` every 20 ms until it returns true or `ms` pass; returns its last result. */
export async function eventually(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
