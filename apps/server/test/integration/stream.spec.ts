import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { PROTOCOL_HEADER, PROTOCOL_VERSION, type PushResponse } from '@fieldsync/sync-core';
import { StreamService } from '../../src/stream.service';
import { startApp } from '../support/app';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { Fixtures, type TestUser } from '../support/fixtures';
import { describeWithDb } from '../support/integration';
import { eventually, listenOnLoopback, openStream } from '../support/stream';
import { Pool } from 'pg';

/**
 * The notification stream over real HTTP connections: subscribers go away with their connection
 * (F-35), an idle stream carries heartbeats (F-35), and shutdown is not held up by open streams (F-36)
 * nor cuts off a push in progress.
 */
describeWithDb('GET /sync/stream', () => {
  let database: TestDatabase;
  let pool: Pool;
  let user: TestUser;
  let site: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    pool = new Pool({ connectionString: database.url, max: 2 });
    const fixtures = new Fixtures(pool);
    site = await fixtures.site();
    user = await fixtures.user('technician', [site]);
  });
  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  const auth = () => ({ authorization: `Bearer ${user.token}` });

  describe('subscribers', () => {
    it('removes the subscriber of a stream whose client goes away', async () => {
      const server = await startApp(database.url);
      try {
        const port = await listenOnLoopback(server.app);
        const streams = server.app.get(StreamService);
        const stream = await openStream(port, auth());
        expect(stream.status).toBe(200);
        expect(await eventually(() => streams.count === 1, 2_000)).toBe(true);

        stream.close();

        expect(await eventually(() => streams.count === 0, 2_000)).toBe(true);
      } finally {
        await server.close();
      }
    });

    it('keeps no subscriber after many clients connect and go away', async () => {
      const server = await startApp(database.url);
      try {
        const port = await listenOnLoopback(server.app);
        const streams = server.app.get(StreamService);
        for (let round = 0; round < 10; round += 1) {
          const opened = await Promise.all(Array.from({ length: 10 }, () => openStream(port, auth())));
          for (const stream of opened) stream.close();
        }
        expect(await eventually(() => streams.count === 0, 5_000)).toBe(true);
      } finally {
        await server.close();
      }
    });
  });

  describe('heartbeat', () => {
    it('sends a heartbeat on an idle stream at the configured interval', async () => {
      const server = await startApp(database.url, { STREAM_HEARTBEAT_MS: '1000' });
      try {
        const port = await listenOnLoopback(server.app);
        const stream = await openStream(port, auth());
        try {
          expect(await eventually(() => stream.text().includes('event: heartbeat'), 3_000)).toBe(true);
        } finally {
          stream.close();
        }
      } finally {
        await server.close();
      }
    });
  });

  describe('shutdown', () => {
    it('lets the application close while a stream is open, and ends the stream', async () => {
      const server = await startApp(database.url);
      const port = await listenOnLoopback(server.app);
      const stream = await openStream(port, auth());
      let closed = false;
      const closing = server.close().then(() => (closed = true));
      try {
        expect(await eventually(() => closed, 5_000)).toBe(true);
        await stream.ended;
      } finally {
        stream.close();
        await closing;
      }
    }, 15_000);

    // Experiment: steady state = a push of the client was applied; inject = the next push waits for
    // its client row, which the test holds, and the application is closed meanwhile; expected = the
    // push is answered as if nothing happened, applied once, and only then is the pool closed.
    it.each([
      ['a push in flight', false],
      ['a push in flight and an open stream', true],
    ])(
      'answers %s before the application is closed',
      async (_case, withStream) => {
        // Longer than the test holds the row, so it is not the lock timeout that ends the push.
        const server = await startApp(database.url, { DB_LOCK_TIMEOUT_MS: '15000' });
        const port = await listenOnLoopback(server.app);
        const clientId = randomUUID();
        const ticket = randomUUID();
        const push = (id: number, name: string, args: Record<string, unknown>) =>
          fetch(`http://127.0.0.1:${port}/sync/push`, {
            method: 'POST',
            headers: { ...auth(), [PROTOCOL_HEADER]: String(PROTOCOL_VERSION), 'content-type': 'application/json' },
            body: JSON.stringify({ clientId, mutations: [{ id, name, args }] }),
          }).then(async (res) => ({ status: res.status, body: (await res.json()) as PushResponse }));
        const lock = await pool.connect();
        const stream = withStream ? await openStream(port, auth()) : undefined;
        let closing: Promise<void> | undefined;
        let closed = false;
        try {
          const created = await push(1, 'ticket.create', { id: ticket, siteId: site, title: 'T', description: '' });
          expect(created.status).toBe(201);
          await lock.query('BEGIN');
          await lock.query('SELECT 1 FROM clients WHERE client_id = $1 FOR UPDATE', [clientId]);
          let answered = false;
          const inFlight = push(2, 'ticket.setStatus', { id: ticket, siteId: site, from: 'open', to: 'in_progress' })
            // A cut connection is an outcome to report, not a rejection to leave unhandled.
            .catch((err: unknown) => ({ status: 0, body: String(err) }))
            .finally(() => (answered = true));
          const waitingForTheRow = async () =>
            (
              await pool.query(
                `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
              )
            ).rowCount === 1;
          expect(await eventually(waitingForTheRow, 5_000)).toBe(true);

          closing = server.close().then(() => {
            closed = true;
          });
          // The shutdown has reached the HTTP server: it takes no new connection and waits for this one.
          const httpServer = server.app.getHttpServer() as Server;
          expect(await eventually(() => !httpServer.listening, 5_000)).toBe(true);
          // The stream ends at once, while the push is still waiting.
          if (stream) await stream.ended;
          expect({ answered, closed }).toEqual({ answered: false, closed: false });

          await lock.query('ROLLBACK');

          await expect(inFlight).resolves.toEqual({
            status: 201,
            body: { results: [{ id: 2, status: 'applied', version: expect.any(Number) as number }], lastMutationId: 2 },
          });
          expect(await eventually(() => closed, 10_000)).toBe(true);
          const { rows } = await pool.query<{ changes: string; last: string; status: string }>(
            `SELECT (SELECT count(*) FROM change_log WHERE entity_id = $1) AS changes,
                    (SELECT last_mutation_id FROM clients WHERE client_id = $2) AS last,
                    (SELECT data->>'status' FROM entities WHERE entity = 'ticket' AND id = $1) AS status`,
            [ticket, clientId],
          );
          // The create and the status change, each once.
          expect(rows).toEqual([{ changes: '2', last: '2', status: 'in_progress' }]);
        } finally {
          await lock.query('ROLLBACK');
          lock.release();
          stream?.close();
          await (closing ?? server.close());
        }
      },
      30_000,
    );
  });
});
