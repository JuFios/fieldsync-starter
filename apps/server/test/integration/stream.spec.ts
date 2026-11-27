import { StreamService } from '../../src/stream.service';
import { startApp } from '../support/app';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { Fixtures, type TestUser } from '../support/fixtures';
import { describeWithDb } from '../support/integration';
import { eventually, listenOnLoopback, openStream } from '../support/stream';
import { Pool } from 'pg';

/**
 * The notification stream over real HTTP connections: subscribers go away with their connection
 * (F-35), an idle stream carries heartbeats (F-35), and shutdown is not held up by open streams (F-36).
 */
describeWithDb('GET /sync/stream', () => {
  let database: TestDatabase;
  let pool: Pool;
  let user: TestUser;

  beforeAll(async () => {
    database = await createTestDatabase();
    pool = new Pool({ connectionString: database.url, max: 2 });
    const fixtures = new Fixtures(pool);
    user = await fixtures.user('technician', [await fixtures.site()]);
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
  });
});
